import { hasBlockingOrderReturns, warnBlockedReturnReservation } from "../orders/returnInventorySafety.js";
import type Stripe from "stripe";
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../prisma/runtime.js";
import { config } from "../../config/index.js";
import type { Order, Payment, Prisma } from "../../generated/prisma-client/client.js";
import { queueCartReconciliation } from "../cart/cartProvenanceService.js";

export class PaymentAdmissionClosedError extends Error {}
export class PaymentResolutionOwnershipError extends Error {}
export class PaymentResolutionUnavailableError extends Error {}
export const RETRY_WINDOW_MS = 30 * 60 * 1000;
export async function databaseNow(tx: Prisma.TransactionClient) {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  return row.now;
}
/** Only the creating checkout transaction enrolls a new order. Never enroll legacy data. */
export async function initializePaymentResolution(tx: Prisma.TransactionClient, order: Order) {
  if (!config.PAYMENT_RESOLUTION_ENABLED) return;
  // Legacy Order.createdAt is timestamp-without-time-zone. Match the foundation's UTC interpretation,
  // rather than the adapter's host-local Date decoding (which differs during British Summer Time).
  const [stamp] = await tx.$queryRaw<Array<{ createdAt: Date }>>`SELECT "createdAt" AT TIME ZONE 'UTC' AS "createdAt" FROM "Order" WHERE id=${order.id}`;
  await tx.paymentResolution.create({ data: { orderId: order.id, orderCreatedAt: stamp.createdAt,
    initialPaymentDeadline: new Date(stamp.createdAt.getTime() + RETRY_WINDOW_MS),
    reservationDisposition: "HELD", dispositionAt: await databaseNow(tx) } });
}
export async function managedResolution(tx: Prisma.TransactionClient, orderId: number) {
  const resolution = await tx.paymentResolution.findUnique({ where: { orderId } });
  return resolution && !resolution.historical && !resolution.quarantineReason ? resolution : null;
}
/** Caller owns Order first. A local timeout only closes new admission temporarily. */
export async function checkPaymentAdmission(tx: Prisma.TransactionClient, orderId: number) {
  const r = await managedResolution(tx, orderId);
  if (!r) {
    if (config.PAYMENT_RESOLUTION_ENABLED) throw new PaymentResolutionUnavailableError();
    return null;
  }
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  const now = await databaseNow(tx);
  const [inbox] = await tx.$queryRaw<Array<{ unresolved: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM "PaymentWebhookEvent" w WHERE (w."processedAt" IS NULL OR w."processingError" IS NOT NULL)
      AND ((w.provider <> 'STRIPE' AND w.evidence->>'orderId'=${String(orderId)}) OR EXISTS (SELECT 1 FROM "PaymentAttempt" a WHERE a."orderId"=${orderId} AND a.provider=w.provider
        AND (w.evidence->>'paymentIntentId'=a."providerReference" OR w.evidence->>'paypalOrderId'=a."providerReference" OR w.evidence->>'captureId'=a."providerCaptureReference")))) AS unresolved`;
  if (inbox.unresolved) throw new PaymentResolutionUnavailableError();
  const terminating = await tx.paymentOperation.findFirst({ where: { type: "TERMINATE", state: { not: "RESULT_RECORDED" }, attempt: { orderId } } });
  if (terminating) throw new PaymentResolutionUnavailableError();
  if (order.status !== "PENDING" || r.paymentAdmissionClosedAt || r.reservationDisposition !== "HELD"
    || r.state === "PAID" || now >= (r.retryDeadline ?? r.initialPaymentDeadline)) throw new PaymentAdmissionClosedError();
  return r;
}
async function journal(tx: Prisma.TransactionClient, attemptId: number, type: "CREATE" | "CONFIRM" | "CAPTURE" | "TERMINATE" | "RETRIEVE", deadline?: Date) {
  const now = await databaseNow(tx);
  const attempt = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } });
  const key = type === "CREATE" ? attempt.creationKey! : `resolution-${randomUUID()}`;
  const op = await tx.paymentOperation.create({ data: { attemptId, type, operationKey: key,
    requestHash: createHash("sha256").update(JSON.stringify({ attemptId, type, key, provider: attempt.provider, orderId: attempt.orderId, amount: attempt.amount.toFixed(2), currency: attempt.currency, providerReference: attempt.providerReference })).digest("hex"),
    admittedAt: now, admissionDeadline: deadline } });
  return tx.paymentOperation.update({ where: { id: op.id }, data: { state: "POTENTIALLY_DISPATCHED", executionCount: 1 } });
}
/** A newly created compatibility Payment precedes external I/O in the same transaction. */
export async function journalNewPayment(tx: Prisma.TransactionClient, payment: Payment, type: "CREATE" | "CONFIRM") {
  const r = await checkPaymentAdmission(tx, payment.orderId);
  if (!r) return null;
  const attempt = await tx.paymentAttempt.create({ data: { orderId: payment.orderId, paymentId: payment.id,
    provider: payment.provider, amount: payment.amount, currency: payment.currency, creationKey: payment.idempotencyKey ?? `manual-${randomUUID()}`,
    providerReference: payment.providerReference.startsWith("pending:") ? null : payment.providerReference,
    admittedAt: await databaseNow(tx) } });
  const operation = await journal(tx, attempt.id, type, r.retryDeadline ?? r.initialPaymentDeadline);
  if (payment.provider === "STRIPE") {
    // Durable admission of client-side confirmation permission. Not evidence of a charge.
    await journal(tx, attempt.id, "CONFIRM", r.retryDeadline ?? r.initialPaymentDeadline);
  }
  return { attempt, operation };
}
export async function bindManagedProvider(tx: Prisma.TransactionClient, paymentId: number, reference: string) {
  const attempt = await tx.paymentAttempt.findFirst({ where: { paymentId, historical: false }, orderBy: { id: "desc" } });
  if (attempt) await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { providerReference: reference } });
}
export async function guardPendingCreation(tx: Prisma.TransactionClient, payment: Payment) {
  if (!payment.providerReference.startsWith("pending:")) return;
  if (await tx.paymentAttempt.findFirst({ where: { paymentId: payment.id, historical: false } })) {
    // A lost create response cannot be safely redispatched after provider idempotency retention.
    throw new PaymentResolutionUnavailableError();
  }
}
export async function journalPayPalCapture(tx: Prisma.TransactionClient, payment: Payment) {
  const r = await checkPaymentAdmission(tx, payment.orderId);
  if (!r) return null;
  const attempt = await tx.paymentAttempt.findFirst({ where: { paymentId: payment.id, historical: false }, orderBy: { id: "desc" } });
  if (!attempt) throw new PaymentResolutionUnavailableError();
  if (payment.captureIdempotencyKey) throw new PaymentResolutionUnavailableError();
  // Never resend an uncertain capture, even from another backend instance or after key expiry.
  if (await tx.paymentOperation.findFirst({ where: { attemptId: attempt.id, type: "CAPTURE" } })) throw new PaymentResolutionUnavailableError();
  return journal(tx, attempt.id, "CAPTURE", r.retryDeadline ?? r.initialPaymentDeadline);
}
/** Financial success is monotonic; inventory confirmation is handled by the caller. */
export async function recordManagedSuccess(tx: Prisma.TransactionClient, payment: Payment, reference: string, captureId?: string, receiptId?: number) {
  const r = await managedResolution(tx, payment.orderId);
  const attempt = await tx.paymentAttempt.findFirst({ where: { paymentId: payment.id, historical: false }, orderBy: { id: "desc" } });
  if (!r || !attempt) return;
  await bindManagedProvider(tx, payment.id, reference);
  if (!attempt.successEvidenceId) {
    const operation = await tx.paymentOperation.findFirst({ where: { attemptId: attempt.id, type: payment.provider === "PAYPAL" ? "CAPTURE" : "CONFIRM" }, orderBy: { id: "asc" } });
    if (!operation) throw new PaymentResolutionUnavailableError();
    const evidence = await tx.financialEvidence.create({ data: { orderId: payment.orderId, provider: payment.provider,
      evidenceKey: `success:${attempt.id}:${captureId ?? reference}`, kind: "SUCCESS", operationId: operation.id,
      webhookEventId: receiptId, verifiedAt: await databaseNow(tx), normalized: { providerReference: reference,
        ...(captureId ? { providerCaptureReference: captureId } : {}), amount: payment.amount.toFixed(2), currency: payment.currency } } });
    await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { successEvidenceId: evidence.id, ...(captureId ? { providerCaptureReference: captureId } : {}) } });
  }
  if (r.reservationDisposition === "RELEASED") return; // Preserve late evidence; never reacquire released stock.
  await tx.paymentResolution.update({ where: { orderId: payment.orderId }, data: { state: "PAID" } });
}
/** Accepted verification time is DB time after Order lock, never provider/browser time. */
export async function recordManagedFailure(tx: Prisma.TransactionClient, payment: Payment, reference: string, key: string, receiptId?: number) {
  const r = await managedResolution(tx, payment.orderId);
  if (!r || r.firstFailureVerifiedAt || r.paymentAdmissionClosedAt || r.reservationDisposition !== "HELD" || payment.status === "SUCCEEDED" || payment.paidAt) return;
  const order = await tx.order.findUniqueOrThrow({ where: { id: payment.orderId } });
  if (order.status !== "PENDING" || await tx.financialEvidence.findFirst({ where: { orderId: payment.orderId, kind: "SUCCESS" } })) return;
  const attempt = await tx.paymentAttempt.findFirst({ where: { paymentId: payment.id, historical: false }, orderBy: { id: "desc" } });
  if (!attempt || (attempt.providerReference && attempt.providerReference !== reference)) return;
  const operation = await tx.paymentOperation.findFirst({ where: { attemptId: attempt.id, type: payment.provider === "PAYPAL" ? "CAPTURE" : "CONFIRM",
    state: { in: ["POTENTIALLY_DISPATCHED", "UNKNOWN", "RESULT_RECORDED"] }, admissionDeadline: r.initialPaymentDeadline }, orderBy: { id: "asc" } });
  if (!operation) return;
  if (operation.state === "RESULT_RECORDED") {
    const primary = operation.evidenceId ? await tx.financialEvidence.findUnique({ where: { id: operation.evidenceId } }) : null;
    if (!attempt.finalityEvidenceId || primary?.kind !== "TERMINAL_UNPAID") return;
  }
  const now = await databaseNow(tx);
  const evidence = await tx.financialEvidence.create({ data: { orderId: payment.orderId, provider: payment.provider,
    evidenceKey: key, kind: "FAILURE", operationId: operation.id, webhookEventId: receiptId,
    verifiedAt: now, normalized: { providerReference: reference, amount: payment.amount.toFixed(2), currency: payment.currency } } });
  if (operation.state !== "RESULT_RECORDED") await tx.paymentOperation.update({ where: { id: operation.id }, data: { state: "RESULT_RECORDED", evidenceId: evidence.id, claimOwner: null, leaseExpiresAt: null } });
  await tx.paymentResolution.update({ where: { orderId: payment.orderId }, data: { state: "RETRY_OPEN",
    firstFailureVerifiedAt: now, retryDeadline: new Date(now.getTime() + RETRY_WINDOW_MS),
    firstFailureEvidenceId: evidence.id, firstFailureOperationId: operation.id } });
}
export async function markManagedConsumed(tx: Prisma.TransactionClient, orderId: number) {
  const r = await managedResolution(tx, orderId);
  if (r && r.reservationDisposition === "HELD") await tx.paymentResolution.update({ where: { orderId },
    data: { state: "PAID", reservationDisposition: "CONSUMED", dispositionAt: await databaseNow(tx) } });
}
/** Caller owns Order; this transaction also owns proof, state and inventory release. */
export async function releaseManagedReservation(tx: Prisma.TransactionClient, orderId: number, abandonment = false, initiator: "CUSTOMER" | "SELLER" = "CUSTOMER") {
  const r = await managedResolution(tx, orderId);
  if (!r || r.reservationDisposition !== "HELD") return false;
  if (await hasBlockingOrderReturns(tx, orderId)) {
    await warnBlockedReturnReservation(tx, orderId, "MANAGED_RELEASE");
    return false;
  }
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  const now = await databaseNow(tx);
  if (order.status !== "PENDING" || (!abandonment && now < (r.retryDeadline ?? r.initialPaymentDeadline))) return false;
  const payments = await tx.payment.findMany({ where: { orderId } });
  if (!payments.length && (await tx.financialEvidence.count({ where: { orderId } })) > 0) return false;
  if (payments.some(p => p.status === "SUCCEEDED" || p.paidAt)) return false;
  const attempts = await tx.paymentAttempt.findMany({ where: { orderId }, orderBy: { id: "asc" }, include: { operations: { orderBy: { id: "asc" } } } });
  if (payments.some(p => !attempts.some(a => a.paymentId === p.id)) || attempts.some(a => a.historical || !a.finalityEvidenceId || a.successEvidenceId || a.operations.some(o => o.state !== "RESULT_RECORDED"))) return false;
  await tx.paymentResolution.update({ where: { orderId }, data: { state: "CLOSED_RESOLVING", paymentAdmissionClosedAt: r.paymentAdmissionClosedAt ?? now,
    closureReason: r.closureReason ?? (abandonment ? (initiator === "SELLER" ? "SELLER_CANCELLED" : "CUSTOMER_ABANDONED") : "WINDOW_EXPIRED") } });
  const proof = await tx.reservationReleaseProof.create({ data: { orderId, type: attempts.length ? "PROVIDER_FINALITY" : "NO_PAYMENT",
    evidenceId: attempts[0]?.finalityEvidenceId, decisionVersion: 1,
    coverage: { attempts: attempts.map(a => a.id), operations: attempts.flatMap(a => a.operations.map(o => o.id)).sort((a,b)=>a-b) } } });
  await tx.paymentResolution.update({ where: { orderId }, data: { state: "RELEASED", reservationDisposition: "RELEASED", dispositionAt: now, releaseProofId: proof.id } });
  const items = await tx.orderItem.findMany({ where: { orderId }, orderBy: { productListingId: "asc" } });
  for (const item of items) {
    await tx.$queryRaw`SELECT id FROM "ProductListing" WHERE id = ${item.productListingId} FOR UPDATE`;
    const changed = await tx.$executeRaw`
      UPDATE "ProductListing" SET "reservedStock" = "reservedStock" - ${item.quantity}
      WHERE id = ${item.productListingId} AND "reservedStock" >= ${item.quantity} + (
        SELECT COALESCE(SUM(oi.quantity), 0) FROM "OrderItem" oi
        JOIN "PaymentResolution" r ON r."orderId" = oi."orderId"
        WHERE oi."productListingId" = ${item.productListingId} AND r."reservationDisposition" = 'HELD'
      )`;
    if (changed !== 1) throw new PaymentResolutionUnavailableError();
  }
  await tx.order.update({ where: { id: orderId }, data: { status: abandonment ? "CANCELLED" : "EXPIRED", reservationExpiresAt: null,
    ...(abandonment ? { cancelledAt: now, cancelledBy: initiator, cancellationReason: "CHANGED_MIND" } : {}) } });
  await queueCartReconciliation(tx, orderId, false);
  return true;
}
export { journal as journalResolutionOperation };

/** Read-only I/O can share a durable journal row without replaying a financial idempotency key. */
export async function journalManagedRetrieval(tx: Prisma.TransactionClient, payment: Payment) {
  if (!await managedResolution(tx, payment.orderId)) return null;
  const attempt = await tx.paymentAttempt.findFirst({ where: { paymentId: payment.id, providerReference: payment.providerReference, historical: false } });
  if (!attempt) throw new PaymentResolutionUnavailableError();
  const previous = await tx.paymentOperation.findFirst({ where: { attemptId: attempt.id, type: "RETRIEVE",
    state: { in: ["POTENTIALLY_DISPATCHED", "UNKNOWN"] }, claimOwner: null }, orderBy: { id: "asc" } });
  if (previous) return tx.paymentOperation.update({ where: { id: previous.id }, data: { executionCount: { increment: 1 } } });
  return journal(tx, attempt.id, "RETRIEVE");
}

/** Complete only this unclaimed read journal from an exact authenticated observation. Order is locked. */
export async function finalizeManagedStripeRetrieval(tx: Prisma.TransactionClient, payment: Payment, operationId: number | undefined, intent: Stripe.PaymentIntent, claimOwner?: string) {
  if (operationId === undefined) return;
  const op = await tx.paymentOperation.findUniqueOrThrow({ where: { id: operationId } });
  if (op.state === "RESULT_RECORDED" || (op.claimOwner && op.claimOwner !== claimOwner)) return;
  const attempt = await tx.paymentAttempt.findUniqueOrThrow({ where: { id: op.attemptId } });
  if (op.type !== "RETRIEVE" || attempt.paymentId !== payment.id || attempt.providerReference !== intent.id
    || payment.providerReference !== intent.id || intent.metadata.orderId !== String(payment.orderId)
    || intent.amount !== payment.amount.mul(100).toNumber() || intent.currency.toUpperCase() !== payment.currency) throw new PaymentResolutionUnavailableError();
  const terminal = intent.status === "canceled" && intent.amount_received === 0 && intent.amount_capturable === 0 && !payment.paidAt && payment.status !== "SUCCEEDED";
  const kind = terminal ? "TERMINAL_UNPAID" : intent.status === "succeeded" && intent.amount_received === intent.amount ? "SUCCESS"
    : intent.status === "requires_payment_method" && intent.last_payment_error && !payment.paidAt ? "FAILURE" : null;
  const now = await databaseNow(tx);
  if (!kind) {
    await tx.paymentOperation.update({ where: { id: op.id }, data: { state: "UNKNOWN" } });
    return;
  }
  const evidence = await tx.financialEvidence.create({ data: { orderId: payment.orderId, provider: "STRIPE", operationId: op.id,
    evidenceKey: `read-result:${op.id}`, kind, verifiedAt: now,
    normalized: { providerReference: intent.id, amount: payment.amount.toFixed(2), currency: payment.currency,
      providerStatus: intent.status, amountReceived: intent.amount_received, amountCapturable: intent.amount_capturable } } });
  await tx.paymentOperation.update({ where: { id: op.id }, data: { state: "RESULT_RECORDED", evidenceId: evidence.id, claimOwner: null, leaseExpiresAt: null } });
  if (terminal) {
    const unfinished = await tx.paymentOperation.findMany({ where: { attemptId: attempt.id, state: { not: "RESULT_RECORDED" }, claimOwner: null } });
    for (const other of unfinished) {
      const proof = await tx.financialEvidence.create({ data: { orderId: payment.orderId, provider: "STRIPE", operationId: other.id,
        evidenceKey: `read-finality:${op.id}:${other.id}`, kind: "TERMINAL_UNPAID", verifiedAt: now, normalized: evidence.normalized! } });
      await tx.paymentOperation.update({ where: { id: other.id }, data: { state: "RESULT_RECORDED", evidenceId: proof.id } });
    }
    if (!attempt.finalityEvidenceId) await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { finalityEvidenceId: evidence.id } });
    await tx.payment.update({ where: { id: payment.id }, data: { status: "CANCELED" } });
  }
}

/** Failed release validation rolls back proof/admission/stock together, retaining already verified provider facts. */
export async function attemptManagedRelease(tx: Prisma.TransactionClient, orderId: number, abandonment=false, initiator:"CUSTOMER"|"SELLER"="CUSTOMER") {
  await tx.$executeRaw`SAVEPOINT payment_inventory_release`;
  try {
    const released=await releaseManagedReservation(tx,orderId,abandonment,initiator);
    await tx.$executeRaw`RELEASE SAVEPOINT payment_inventory_release`;
    if (!released) {
      const r = await managedResolution(tx, orderId);
      if (r?.reservationDisposition === "HELD") await tx.paymentResolution.update({ where: { orderId }, data: {
        resolutionNextCheckAt: new Date((await databaseNow(tx)).getTime()+300_000) } });
    }
    return released;
  } catch {
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT payment_inventory_release`;
    await tx.$executeRaw`RELEASE SAVEPOINT payment_inventory_release`;
    const r=await managedResolution(tx,orderId);const now=await databaseNow(tx);
    if (r && r.reservationDisposition==="HELD") await tx.paymentResolution.update({where:{orderId},data:{
      state:r.retryDeadline && now<r.retryDeadline && !r.paymentAdmissionClosedAt?"RETRY_OPEN":"SAFETY_HOLD",
      escalatedAt:r.escalatedAt??now,resolutionNextCheckAt:new Date(now.getTime()+300_000)}});
    return false;
  }
}
