import { processRefundWebhookReceipt } from "../refunds/refundWebhookService.js";
import { recordManagedFailure } from "./paymentResolutionService.js";
import { Decimal } from "@prisma/client/runtime/client";
import { z } from "zod";
import { PaymentProvider, PaymentStatus } from "../../generated/prisma-client/enums.js";
import { prisma } from "../../prisma/runtime.js";
import { recordPayPalSuccess } from "./paypalPaymentOutcome.js";

export type PayPalWebhookEvent = {
  id: string;
  eventType: string;
  captureId?: string;
  paypalOrderId?: string;
  amount?: string;
  currency?: string;
  orderId?: string;
};

const evidenceSchema = z.object({
  version: z.literal(1),
  id: z.string().min(1).max(256),
  eventType: z.string().min(1).max(100),
  captureId: z.string().max(256).optional(),
  paypalOrderId: z.string().max(256).optional(),
  amount: z.string().max(32).optional(),
  currency: z.string().max(3).optional(),
}).strict();
const captureEvents = ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED"];
const unknownError = "Unknown PayPal payment or capture";
const mismatchError = "PayPal capture amount, currency, or identity mismatch";

export class PayPalWebhookEvidenceConflictError extends Error {
  constructor() { super("Conflicting PayPal webhook evidence"); }
}

/** Only call after provider signature verification. Never retain headers or raw customer data. */
export async function persistVerifiedPayPalWebhookEvent(event: PayPalWebhookEvent) {
  const evidence = evidenceSchema.parse({ version: 1, id: event.id, eventType: event.eventType,
    captureId: event.captureId, paypalOrderId: event.paypalOrderId, amount: event.amount, currency: event.currency });
  return prisma.$transaction(async (tx) => {
    const inserted = await tx.$queryRaw<Array<{ id: number }>>`
      INSERT INTO "PaymentWebhookEvent" ("provider", "providerEventId", "eventType", "evidence")
      VALUES ('PAYPAL'::"PaymentProvider", ${event.id}, ${event.eventType}, ${JSON.stringify(evidence)}::jsonb)
      ON CONFLICT ("provider", "providerEventId") DO NOTHING RETURNING "id"
    `;
    // This transaction owns only the receipt lock. It never waits for an Order
    // or Payment; financial processing starts in a separate transaction.
    await tx.$queryRaw`SELECT "id" FROM "PaymentWebhookEvent"
      WHERE "provider" = 'PAYPAL'::"PaymentProvider" AND "providerEventId" = ${event.id} FOR UPDATE`;
    const receipt = await tx.paymentWebhookEvent.findUniqueOrThrow({ where: {
      provider_providerEventId: { provider: PaymentProvider.PAYPAL, providerEventId: event.id },
    } });
    if (receipt.eventType !== evidence.eventType) throw new PayPalWebhookEvidenceConflictError();
    if (receipt.evidence !== null) {
      const stored = evidenceSchema.safeParse(receipt.evidence);
      if (!stored.success || JSON.stringify(stored.data) !== JSON.stringify(evidence)) throw new PayPalWebhookEvidenceConflictError();
    } else {
      // Legacy receipts cannot be replayed without evidence. A verified delivery
      // can supply it once; old uncorrelated/mismatched receipts are reopened.
      const reopen = receipt.processingError === unknownError || receipt.processingError === mismatchError;
      await tx.paymentWebhookEvent.update({ where: { id: receipt.id }, data: {
        evidence, ...(reopen ? { processedAt: null } : {}),
      } });
    }
    return { receiptId: receipt.id, duplicate: inserted.length === 0 };
  });
}

export type PayPalReceiptOutcome = { handled: boolean; processed: boolean };

/** Durable evidence only: safe to call from any process, without a new provider request. */
export async function processPayPalWebhookReceipt(receiptId: number): Promise<PayPalReceiptOutcome> {
  const snapshot = await prisma.paymentWebhookEvent.findUnique({ where: { id: receiptId } });
  if (!snapshot || snapshot.provider !== PaymentProvider.PAYPAL) return { handled: false, processed: false };
  if(snapshot.evidence && typeof snapshot.evidence==="object" && !Array.isArray(snapshot.evidence) && snapshot.evidence.kind==="refund")return processRefundWebhookReceipt(receiptId);
  const decoded = evidenceSchema.safeParse(snapshot.evidence);
  const event = decoded.success && decoded.data.id === snapshot.providerEventId && decoded.data.eventType === snapshot.eventType
    ? decoded.data : null;
  return prisma.$transaction(async (tx) => {
    // Initial correlation is not a financial decision. Order precedes receipt
    // and Payment locks; all mutable state is reread after acquiring these locks.
    const candidate = event && captureEvents.includes(event.eventType)
      ? (event.captureId ? await tx.payment.findFirst({ where: { provider: PaymentProvider.PAYPAL, providerCaptureReference: event.captureId } }) : null)
        ?? (event.paypalOrderId ? await tx.payment.findFirst({ where: { provider: PaymentProvider.PAYPAL, providerReference: event.paypalOrderId } }) : null)
      : null;
    if (candidate) await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${candidate.orderId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "PaymentWebhookEvent" WHERE "id" = ${receiptId} FOR UPDATE`;
    const receipt = await tx.paymentWebhookEvent.findUniqueOrThrow({ where: { id: receiptId } });
    const current = evidenceSchema.safeParse(receipt.evidence);
    const unchanged = decoded.success
      ? current.success && JSON.stringify(current.data) === JSON.stringify(decoded.data)
      : !current.success && JSON.stringify(receipt.evidence) === JSON.stringify(snapshot.evidence);
    if (receipt.provider !== PaymentProvider.PAYPAL || receipt.eventType !== snapshot.eventType
      || !unchanged) {
      // Evidence is immutable for new receipts. Legacy backfill may change it
      // while waiting: retry from a fresh snapshot rather than trust stale data.
      throw new PayPalWebhookEvidenceConflictError();
    }
    if (receipt.processedAt) return { processed: true, handled: captureEvents.includes(receipt.eventType)
      && (!receipt.processingError || receipt.processingError.startsWith("Captured payment ")) };
    const finish = async (handled: boolean, processed: boolean, processingError: string | null = null) => {
      await tx.paymentWebhookEvent.update({ where: { id: receipt.id }, data: {
        processedAt: processed ? new Date() : null, processingError,
      } });
      return { handled, processed };
    };
    if (!event) return finish(false, false, "Missing or invalid verified PayPal evidence; redelivery or manual reconciliation required");
    if (!captureEvents.includes(event.eventType)) return finish(false, true);
    const payment = candidate ? await tx.payment.findUnique({ where: { id: candidate.id }, include: { order: true } }) : null;
    if (!payment || payment.provider !== PaymentProvider.PAYPAL || payment.orderId !== candidate!.orderId) return finish(false, false, unknownError);
    if ((event.paypalOrderId && event.paypalOrderId !== payment.providerReference)
      || (payment.providerCaptureReference && event.captureId !== payment.providerCaptureReference)) {
      return finish(false, false, mismatchError);
    }
    if (event.eventType === "PAYMENT.CAPTURE.REFUNDED") return finish(true, true);
    if (event.eventType === "PAYMENT.CAPTURE.COMPLETED") {
      const expected = new Decimal(payment.amount).toFixed(2);
      if (!event.captureId || !event.paypalOrderId || event.paypalOrderId !== payment.providerReference
        || !payment.amount.equals(payment.order.totalAmount) || payment.currency !== "GBP" || event.currency?.toUpperCase() !== payment.currency || event.amount !== expected) {
        return finish(false, false, mismatchError);
      }
      const now = new Date();
      const { processingError } = await recordPayPalSuccess(tx, payment, event.captureId, now);
      return finish(true, true, processingError);
    }
    if (event.eventType === "PAYMENT.CAPTURE.DENIED" && event.captureId && event.paypalOrderId === payment.providerReference
      && event.currency?.toUpperCase() === payment.currency && event.amount === new Decimal(payment.amount).toFixed(2)) {
      await recordManagedFailure(tx, payment, payment.providerReference, `paypal-failure:${receipt.id}`, receipt.id);
    }
    if (payment.status !== PaymentStatus.SUCCEEDED && !payment.paidAt) {
      await tx.payment.update({ where: { id: payment.id }, data: {
        status: event.eventType === "PAYMENT.CAPTURE.DENIED" ? PaymentStatus.FAILED : PaymentStatus.PROCESSING,
      } });
    }
    return finish(true, true);
  });
}

export async function reconcilePayPalWebhookEvent(event: PayPalWebhookEvent): Promise<{ duplicate: boolean; handled: boolean }> {
  const saved = await persistVerifiedPayPalWebhookEvent(event);
  // Persistence commits first. A processing crash/failure leaves a discoverable
  // inbox row; HTTP 500 does not discard it or become the only recovery path.
  const outcome = await processPayPalWebhookReceipt(saved.receiptId);
  return { duplicate: saved.duplicate, handled: outcome.handled };
}
