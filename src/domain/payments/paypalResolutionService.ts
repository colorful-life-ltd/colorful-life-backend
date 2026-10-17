import { classifyPayPalCapture, recordPayPalUnpaidFinality } from './paypalFinality.js';
import { prisma } from "../../prisma/runtime.js";
import { config } from "../../config/index.js";
import { attemptManagedRelease, databaseNow, journalResolutionOperation, managedResolution } from "./paymentResolutionService.js";
import { reconcilePayPalWebhookEvent } from "./paypalReconciliationService.js";
import { randomUUID } from "node:crypto";

export type PayPalResolutionOrder = { id: string; status: string; intent?: string; purchase_units?: Array<{ amount?: { value: string; currency_code: string }; payments?: { captures?: Array<{
  id: string; status: string; amount: { value: string; currency_code: string };
}> } }> };
export type PayPalResolutionClient = { retrieveOrder(id: string): Promise<PayPalResolutionOrder> };
let testClient: PayPalResolutionClient | undefined;
export function setPayPalResolutionClientForTests(client: PayPalResolutionClient) {
  const previous=testClient;testClient=client;return()=>{testClient=previous;};
}
function providerClient(): PayPalResolutionClient {
  if (process.env.NODE_ENV === "test") throw Error("A local PayPal resolution fake is required");
  return {async retrieveOrder(id) {
    if (!config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) throw Error("PayPal unavailable");
    const authorization=Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString("base64");
    const auth=await fetch(`${config.PAYPAL_BASE_URL}/v1/oauth2/token`,{method:"POST",headers:{Authorization:`Basic ${authorization}`,"Content-Type":"application/x-www-form-urlencoded"},body:"grant_type=client_credentials",signal:AbortSignal.timeout(10_000)});
    if (!auth.ok) throw Error("PayPal unavailable");
    const token=await auth.json() as {access_token:string};
    const response=await fetch(`${config.PAYPAL_BASE_URL}/v2/checkout/orders/${encodeURIComponent(id)}`,{headers:{Authorization:`Bearer ${token.access_token}`},signal:AbortSignal.timeout(10_000)});
    if (!response.ok) throw Error("PayPal outcome unknown");
    return await response.json() as PayPalResolutionOrder;
  }};
}
/** Read-only resolution; absence after a dispatched capture is never unpaid proof. */
export async function resolvePayPalPaymentOutcome(orderId: number, client?: PayPalResolutionClient) {
  const claim = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`;
    const r = await managedResolution(tx, orderId);
    const payment = await tx.payment.findUnique({ where: { orderId }, include: { order: true } });
    if (!r || r.reservationDisposition !== 'HELD' || r.state === 'PAID' || !payment || payment.provider !== 'PAYPAL' || payment.paidAt || payment.status === 'SUCCEEDED') return null;
    const now = await databaseNow(tx);
    if (payment.order.status !== 'PENDING') return null;
    const due = !!r.paymentAdmissionClosedAt || now >= (r.retryDeadline ?? r.initialPaymentDeadline);
    if (due && !r.paymentAdmissionClosedAt) await tx.paymentResolution.update({ where: { orderId }, data: {
      state: 'CLOSED_RESOLVING', paymentAdmissionClosedAt: now, closureReason: 'WINDOW_EXPIRED' } });
    const attempt = await tx.paymentAttempt.findFirst({ where: { paymentId: payment.id, providerReference: payment.providerReference.startsWith('pending:') ? null : payment.providerReference, historical: false }, include: { operations: true } });
    if (!attempt || !payment.amount.equals(payment.order.totalAmount) || payment.currency !== 'GBP') {
      await tx.paymentResolution.update({ where: { orderId }, data: { state: 'SAFETY_HOLD', resolutionNextCheckAt: new Date(now.getTime()+300_000), escalatedAt: r.escalatedAt ?? now } });
      return null;
    }
    if (attempt.finalityEvidenceId) {
      if (due) await attemptManagedRelease(tx, orderId, r.closureReason === 'CUSTOMER_ABANDONED');
      return null;
    }
    const captures = attempt.operations.filter(o => o.type === 'CAPTURE');
    if (due && !captures.length && !payment.captureIdempotencyKey && !payment.providerCaptureReference && !attempt.providerCaptureReference && !payment.providerReference.startsWith('pending:')) {
      const contrary = await tx.paymentWebhookEvent.findFirst({ where: { provider: 'PAYPAL',
        evidence: { path: ['paypalOrderId'], equals: payment.providerReference }, eventType: { startsWith: 'PAYMENT.CAPTURE.' } } });
      if (contrary) {
        await tx.paymentResolution.update({ where: { orderId }, data: { state: 'SAFETY_HOLD', resolutionNextCheckAt: new Date(now.getTime()+300_000), escalatedAt: r.escalatedAt ?? now } });
        return null;
      }
      await recordPayPalUnpaidFinality(tx, payment, 'NOT_DISPATCHED');
      await attemptManagedRelease(tx, orderId, r.closureReason === 'CUSTOMER_ABANDONED');
      return null;
    }
    if (!due && payment.status !== 'FAILED') {
      await tx.paymentResolution.update({ where: { orderId }, data: { resolutionNextCheckAt: r.retryDeadline ?? r.initialPaymentDeadline } });
      return null;
    }
    if (payment.providerReference.startsWith('pending:') || captures.length !== 1) {
      await tx.paymentResolution.update({ where: { orderId }, data: { state: 'SAFETY_HOLD', resolutionNextCheckAt: new Date(now.getTime()+300_000), escalatedAt: r.escalatedAt ?? now } });
      return null;
    }
    if (await tx.paymentOperation.findFirst({ where: { attemptId: attempt.id, type: 'RETRIEVE', leaseExpiresAt: { gt: now } } })) return null;
    const reusable = await tx.paymentOperation.findFirst({ where: { attemptId: attempt.id, type: 'RETRIEVE', state: { in: ['POTENTIALLY_DISPATCHED', 'UNKNOWN'] } }, orderBy: { id: 'asc' } });
    const operation = reusable ?? await journalResolutionOperation(tx, attempt.id, 'RETRIEVE');
    const owner = randomUUID();
    await tx.paymentOperation.update({ where: { id: operation.id }, data: { claimOwner: owner, claimGeneration: { increment: 1 }, executionCount: reusable ? { increment: 1 } : undefined, leaseExpiresAt: new Date(now.getTime()+60_000) } });
    await tx.paymentResolution.update({ where: { orderId }, data: { resolutionNextCheckAt: new Date(now.getTime()+60_000) } });
    return { payment, attempt, operation, owner };
  });
  if (!claim) return;
  try {
    const remote = await (client ?? testClient ?? providerClient()).retrieveOrder(claim.payment.providerReference);
    const captures = remote.purchase_units?.flatMap(unit => unit.payments?.captures ?? []) ?? [];
    if (remote.id !== claim.payment.providerReference || captures.length > 1) throw Error('PayPal evidence mismatch');
    const capture = captures[0];
    const fundingDecline = !capture && remote.intent === 'CAPTURE' && remote.status === 'APPROVED' && remote.purchase_units?.length === 1
      && remote.purchase_units[0].amount?.value === claim.payment.amount.toFixed(2) && remote.purchase_units[0].amount.currency_code === 'GBP'
      && !!await prisma.financialEvidence.findFirst({ where: { orderId, provider: 'PAYPAL', kind: 'FAILURE', operation: { attemptId: claim.attempt.id, type: 'CAPTURE' }, normalized: { path: ['declineCode'], equals: 'INSTRUMENT_DECLINED' } } });
    if (!fundingDecline && (!capture || !capture.id || capture.amount?.value !== claim.payment.amount.toFixed(2) || capture.amount.currency_code !== 'GBP')) throw Error('PayPal finality unproven');
    const outcome = fundingDecline ? 'DEFINITIVELY_DECLINED' : classifyPayPalCapture(capture!.status);
    // Success and failure observations use the existing durable inbox/PP-1 lifecycle.
    // Unknown statuses are deliberately not mapped to a decline.
    if (capture && outcome !== 'UNKNOWN') await reconcilePayPalWebhookEvent({ id: `resolution:${remote.id}:${capture.id}:${capture.status}`,
      eventType: outcome === 'COMPLETED' ? 'PAYMENT.CAPTURE.COMPLETED' : outcome === 'PENDING' ? 'PAYMENT.CAPTURE.PENDING' : 'PAYMENT.CAPTURE.DENIED',
      paypalOrderId: remote.id, captureId: capture.id, amount: capture.amount.value, currency: capture.amount.currency_code });
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`;
      const op = await tx.paymentOperation.findUniqueOrThrow({ where: { id: claim.operation.id } });
      const now = await databaseNow(tx);
      if (op.claimOwner !== claim.owner || !op.leaseExpiresAt || op.leaseExpiresAt <= now) return;
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: claim.payment.id }, include: { order: true } });
      if (payment.providerReference !== remote.id || !payment.amount.equals(payment.order.totalAmount)) return;
      if (outcome === 'DEFINITIVELY_DECLINED' && !payment.paidAt && payment.status !== 'SUCCEEDED') {
        await recordPayPalUnpaidFinality(tx, payment, outcome, capture?.id, op.id);
        const r = await managedResolution(tx, orderId);
        if (r) await attemptManagedRelease(tx, orderId, r.closureReason === 'CUSTOMER_ABANDONED');
      } else if (outcome === 'COMPLETED' && payment.status === 'SUCCEEDED') {
        const evidence = await tx.financialEvidence.create({ data: { orderId, provider: 'PAYPAL', operationId: op.id,
          evidenceKey: `paypal-read-success:${op.id}`, kind: 'SUCCESS', verifiedAt: now,
          normalized: { providerReference: remote.id, providerCaptureReference: capture!.id, amount: payment.amount.toFixed(2), currency: 'GBP' } } });
        await tx.paymentOperation.update({ where: { id: op.id }, data: { state: 'RESULT_RECORDED', evidenceId: evidence.id, claimOwner: null, leaseExpiresAt: null } });
      }
      const current = await tx.paymentOperation.findUniqueOrThrow({ where: { id: op.id } });
      if (current.state !== 'RESULT_RECORDED') await tx.paymentOperation.update({ where: { id: op.id }, data: { state: 'UNKNOWN', claimOwner: null, leaseExpiresAt: null, lastErrorCode: outcome === 'PENDING' ? 'PAYPAL_CAPTURE_PENDING' : 'PAYPAL_OUTCOME_UNKNOWN' } });
      const r = await managedResolution(tx, orderId);
      if (r && r.reservationDisposition === 'HELD' && r.state !== 'PAID') await tx.paymentResolution.update({ where: { orderId }, data: {
        state: r.paymentAdmissionClosedAt ? 'SAFETY_HOLD' : r.state, resolutionNextCheckAt: new Date(now.getTime()+300_000), escalatedAt: r.escalatedAt ?? now } });
    });
  } catch {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`;
      const op = await tx.paymentOperation.findUniqueOrThrow({ where: { id: claim.operation.id } });
      if (op.claimOwner !== claim.owner || op.state === 'RESULT_RECORDED') return;
      await tx.paymentOperation.update({ where: { id: op.id }, data: { state: 'UNKNOWN', claimOwner: null, leaseExpiresAt: null, lastErrorCode: 'PAYPAL_OUTCOME_UNKNOWN' } });
      const r = await managedResolution(tx, orderId); const now = await databaseNow(tx);
      if (r && r.reservationDisposition === 'HELD' && r.state !== 'PAID') await tx.paymentResolution.update({ where: { orderId }, data: {
        state: r.paymentAdmissionClosedAt ? 'SAFETY_HOLD' : r.state, escalatedAt: r.escalatedAt ?? now, resolutionNextCheckAt: new Date(now.getTime()+300_000) } });
    });
  }
}
