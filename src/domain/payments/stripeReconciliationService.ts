import { reconcileRefundWebhook } from "../refunds/refundWebhookService.js";
import { config } from "../../config/index.js";
import { bindManagedProvider, recordManagedFailure, recordManagedSuccess, managedResolution } from "./paymentResolutionService.js";
import type { Prisma } from "../../generated/prisma-client/client.js";
import { confirmOrderInTransaction } from "../orders/orderConfirmationService.js";
import { PaymentProvider, PaymentStatus, OrderStatus } from "../../generated/prisma-client/enums.js";
import { prisma } from "../../prisma/runtime.js";
import { Decimal } from "@prisma/client/runtime/client";

export type StripePaymentIntentEvent = {
  id: string;
  type: "payment_intent.succeeded" | "payment_intent.payment_failed" | "payment_intent.canceled";
  paymentIntentId: string;
  amount: number;
  currency: string;
  metadata?: Record<string, string>;
};

type StripePaymentWithOrder = Prisma.PaymentGetPayload<{ include: { order: true } }>;
export type StripePaymentOutcome = Omit<StripePaymentIntentEvent, "id">;

/** Financial/correlation checks shared by verified webhooks and server retrieval. */
export function validateStripePaymentOutcome(payment: StripePaymentWithOrder, event: StripePaymentOutcome): string | null {
  const expectedAmount = new Decimal(payment.amount).mul(100).toNumber();
  if (payment.providerReference !== event.paymentIntentId && !payment.providerReference.startsWith("pending:")) {
    return "Stripe payment reference mismatch";
  }
  if (event.metadata?.orderId && event.metadata.orderId !== String(payment.orderId)) {
    return "Stripe order correlation mismatch";
  }
  if (event.amount !== expectedAmount || event.currency.toLowerCase() !== "gbp") {
    return "Stripe payment amount or currency mismatch";
  }
  return null;
}

/** Caller must hold the order-row lock and validate authoritative evidence first. */
export async function applyStripePaymentOutcome(tx: Prisma.TransactionClient, payment: StripePaymentWithOrder, event: StripePaymentOutcome): Promise<string | null> {
  if (event.type === "payment_intent.succeeded" && payment.status !== PaymentStatus.SUCCEEDED) {
    await tx.payment.update({ where: { id: payment.id }, data: { providerReference: event.paymentIntentId, status: PaymentStatus.SUCCEEDED, paidAt: payment.paidAt ?? new Date() } });
  } else if (event.type === "payment_intent.payment_failed" && payment.status !== PaymentStatus.SUCCEEDED && payment.status !== PaymentStatus.CANCELED && !payment.paidAt) {
    await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.FAILED } });
  } else if (event.type === "payment_intent.canceled" && payment.status !== PaymentStatus.SUCCEEDED && !payment.paidAt) {
    await tx.payment.update({ where: { id: payment.id }, data: { status: PaymentStatus.CANCELED } });
  }
  if (event.type === "payment_intent.payment_failed") await recordManagedFailure(tx, payment, event.paymentIntentId, `stripe-failure:${payment.id}:${event.paymentIntentId}`);
  if (event.type === "payment_intent.succeeded") await recordManagedSuccess(tx, payment, event.paymentIntentId);
  // Evidence, payment success and inventory conversion commit together. Failure
  // rolls everything back, permitting a webhook redelivery or recovery retry.
  if (event.type === "payment_intent.succeeded" && payment.order.status === OrderStatus.PENDING) {
    const resolution = await tx.paymentResolution.findUnique({ where: { orderId: payment.orderId } });
    if ((resolution && (resolution.historical || resolution.quarantineReason || !resolution.reservationDisposition))
      || (config.PAYMENT_RESOLUTION_ENABLED && !resolution)) {
      return "Captured payment with historical or incomplete reservation coverage requires manual reconciliation";
    }
    if (await managedResolution(tx, payment.orderId)) {
      await tx.$executeRaw`SAVEPOINT verified_payment_fulfillment`;
      try {
        await confirmOrderInTransaction(tx, payment.order.userId, payment.orderId);
        await tx.$executeRaw`RELEASE SAVEPOINT verified_payment_fulfillment`;
      } catch {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT verified_payment_fulfillment`;
        await tx.$executeRaw`RELEASE SAVEPOINT verified_payment_fulfillment`;
        return "Captured payment requires manual inventory reconciliation; financial success retained";
      }
    } else await confirmOrderInTransaction(tx, payment.order.userId, payment.orderId);
  }
  return event.type === "payment_intent.succeeded" &&
    (payment.order.status === OrderStatus.EXPIRED || payment.order.status === OrderStatus.CANCELLED || payment.order.status === OrderStatus.RETURNED)
    ? `Captured payment for ${payment.order.status.toLowerCase()} order requires refund/reconciliation` : null;
}

export async function reconcileStripePaymentEvent(event: StripePaymentIntentEvent): Promise<{ duplicate: boolean; handled: boolean }> {
  try {
    return await prisma.$transaction(async (tx) => {
      const metadataId = Number(event.metadata?.orderId);
      const firstCandidate = await tx.payment.findFirst({ where: { provider: PaymentProvider.STRIPE, OR: [
        { providerReference: event.paymentIntentId }, ...(Number.isSafeInteger(metadataId) && metadataId > 0 ? [{ orderId: metadataId }] : [])] } });
      if (firstCandidate) await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${firstCandidate.orderId} FOR UPDATE`;
      const receipt = await tx.paymentWebhookEvent.create({ data: { provider: PaymentProvider.STRIPE, providerEventId: event.id, eventType: event.type,
        evidence: { version: 1, paymentIntentId: event.paymentIntentId, amount: event.amount, currency: event.currency,
          ...(event.metadata?.orderId ? { orderId: event.metadata.orderId } : {}), ...(event.metadata?.attemptId ? { attemptId: event.metadata.attemptId } : {}) } } });
      // Correlate a verified event arriving before initiation persists the provider
      // reference using the server-authored orderId metadata and pending attempt.
      const metadataOrderId = Number(event.metadata?.orderId);
      const candidate = await tx.payment.findFirst({ where: {
        provider: PaymentProvider.STRIPE,
        OR: [
          { providerReference: event.paymentIntentId },
          ...(Number.isSafeInteger(metadataOrderId) && metadataOrderId > 0 ? [{ orderId: metadataOrderId, providerReference: { startsWith: "pending:" } }] : []),
        ],
      } });
      if (candidate) await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${candidate.orderId} FOR UPDATE`;
      const payment = candidate ? await tx.payment.findUnique({ where: { id: candidate.id }, include: { order: true } }) : null;
      if (!payment) {
        await tx.paymentWebhookEvent.update({ where: { id: receipt.id }, data: { processedAt: new Date(), processingError: "Unknown Stripe payment" } });
        return { duplicate: false, handled: false };
      }
      const pendingAttempt = payment.providerReference.startsWith("pending:") ? await tx.paymentAttempt.findFirst({ where: { paymentId: payment.id, historical: false }, orderBy: { id: "desc" } }) : null;
      const validationError = pendingAttempt && event.metadata?.attemptId !== String(pendingAttempt.id)
        ? "Stripe attempt correlation mismatch" : validateStripePaymentOutcome(payment, event);
      if (validationError) {
        await tx.paymentWebhookEvent.update({ where: { id: receipt.id }, data: { processedAt: new Date(), processingError: validationError } });
        return { duplicate: false, handled: false };
      }
      if (pendingAttempt) {
        await bindManagedProvider(tx, payment.id, event.paymentIntentId);
        await tx.payment.update({ where: { id: payment.id }, data: { providerReference: event.paymentIntentId } });
        payment.providerReference = event.paymentIntentId;
      }
      const reconciliation = await applyStripePaymentOutcome(tx, payment, event);
      await tx.paymentWebhookEvent.update({ where: { id: receipt.id }, data: { processedAt: new Date(), processingError: reconciliation } });
      return { duplicate: false, handled: true };
    });
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002") {
      const receipt = await prisma.paymentWebhookEvent.findFirst({ where: { provider: PaymentProvider.STRIPE, providerEventId: event.id } });
      if (receipt) return { duplicate: true, handled: true };
    }
    throw error;
  }
}

export type StripeRefundEvent = { id: string; type: "refund.created" | "refund.updated" | "refund.failed"; refundId: string; paymentIntentId?: string | null; amount: number; currency: string; status: string; metadata?: Record<string, string> };

function paymentIntentId(value: string | { id: string } | null | undefined) { return typeof value === "string" ? value : value?.id; }

export async function reconcileStripeRefundEvent(event: StripeRefundEvent): Promise<{ duplicate: boolean; handled: boolean }> {
  return reconcileRefundWebhook({version:2,kind:"refund",provider:"STRIPE",id:event.id,eventType:event.type,
    reference:event.refundId,parentReference:paymentIntentId(event.paymentIntentId)??undefined,
    amount:Number.isSafeInteger(event.amount)&&event.amount>0?new Decimal(event.amount).div(100).toFixed(2):undefined,
    currency:event.currency,localRefundId:event.metadata?.local_refund_id,localOrderId:event.metadata?.order_id,
    status:event.type==="refund.failed"&&!["failed","canceled"].includes(event.status)?"UNKNOWN":event.status==="succeeded"?"SUCCEEDED":event.status==="failed"||event.status==="canceled"?"FAILED"
      :event.status==="pending"||event.status==="requires_action"?"PENDING":"UNKNOWN"});
}

/** Replay only the allowlisted evidence persisted by verified Stripe processing, under Order first. */
export async function replayManagedStripeReceipts(tx: Prisma.TransactionClient, orderId: number, reference: string) {
  const receipts = await tx.paymentWebhookEvent.findMany({ where: { provider: PaymentProvider.STRIPE,
    OR: [{ evidence: { path: ["orderId"], equals: String(orderId) } }, { evidence: { path: ["paymentIntentId"], equals: reference } }],
    AND: [{ OR: [{ processedAt: null }, { processingError: { not: null } }] }] }, orderBy: { id: "asc" }, take: 100 });
  for (const row of receipts) {
    await tx.$queryRaw`SELECT id FROM "PaymentWebhookEvent" WHERE id=${row.id} FOR UPDATE`;
    const receipt = await tx.paymentWebhookEvent.findUniqueOrThrow({ where: { id: row.id } });
    const raw = receipt.evidence;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const data = raw as Record<string, unknown>;
    if (data.version !== 1 || data.paymentIntentId !== reference || !Number.isSafeInteger(data.amount) || (data.amount as number) < 0
      || typeof data.currency !== "string" || !["payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.canceled"].includes(receipt.eventType)) continue;
    const payment = await tx.payment.findUniqueOrThrow({ where: { orderId }, include: { order: true } });
    const attempt = await tx.paymentAttempt.findFirst({ where: { paymentId: payment.id, providerReference: reference, historical: false } });
    if (data.attemptId !== undefined && (!attempt || data.attemptId !== String(attempt.id))) continue;
    const event: StripePaymentOutcome = { type: receipt.eventType as StripePaymentOutcome["type"], paymentIntentId: reference,
      amount: data.amount as number, currency: data.currency, metadata: typeof data.orderId === "string" ? { orderId: data.orderId } : undefined };
    if (validateStripePaymentOutcome(payment, event)) continue;
    const error = await applyStripePaymentOutcome(tx, payment, event);
    await tx.paymentWebhookEvent.update({ where: { id: receipt.id }, data: { processedAt: new Date(), processingError: error } });
  }
}
