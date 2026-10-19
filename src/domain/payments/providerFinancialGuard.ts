import type { Payment, Prisma } from '../../generated/prisma-client/client.js';
import { Decimal } from '@prisma/client/runtime/client';

type Evidence = Record<string, Prisma.JsonValue | undefined>;
const object = (value: Prisma.JsonValue | null): Evidence => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
type Attempt = Prisma.PaymentAttemptGetPayload<{ include: { finalityEvidence: { include: { operation: true } }; successEvidence: true; operations: true } }>;

/** A historical flag, decline notification or operator acknowledgement is never finality. */
async function unpaidProof(tx: Prisma.TransactionClient, attempt: Attempt, payment: Payment) {
  const proof = attempt.finalityEvidence;
  const data = object(proof?.normalized ?? null);
  if (!proof || !proof.verifiedAt || proof.kind !== 'TERMINAL_UNPAID' || proof.provider !== payment.provider
    || proof.orderId !== payment.orderId || proof.operation?.attemptId !== attempt.id || attempt.successEvidenceId
    || attempt.paymentId !== payment.id || attempt.orderId !== payment.orderId || attempt.provider !== payment.provider
    || !attempt.amount.eq(payment.amount) || attempt.currency !== payment.currency
    || !attempt.operations.length || attempt.operations.some(op => op.state !== 'RESULT_RECORDED' || op.historical)
    || data.providerReference !== attempt.providerReference || data.amount !== attempt.amount.toFixed(2) || data.currency !== attempt.currency) return null;
  if (payment.provider === 'STRIPE') {
    if (data.providerStatus !== 'canceled' || data.amountReceived !== 0 || data.amountCapturable !== 0) return null;
  } else if (data.outcome !== 'DEFINITIVELY_DECLINED' || !attempt.providerCaptureReference
    || data.providerCaptureReference !== attempt.providerCaptureReference) return null;
  if (await tx.financialEvidence.count({ where: { kind: 'SUCCESS', operation: { attemptId: attempt.id } } })) return null;
  return proof;
}

/** Classification is recomputed from immutable facts; this audit is never a force-clear token. */
async function retainResolution(tx: Prisma.TransactionClient, payment: Payment, receiptId: number, attemptId: number, evidenceId: number) {
  const key = `provider-receipt-safe:${payment.provider}:${receiptId}:${attemptId}:${evidenceId}`;
  await tx.$executeRaw`INSERT INTO "OperationalAudit" (kind,"orderId","requestKey",details)
    VALUES ('PROVIDER_RECEIPT_FINANCIAL_RESOLVED',${payment.orderId},${key},${JSON.stringify({ paymentId: payment.id, receiptId, attemptId, evidenceId, source: 'verified-attempt-evidence' })}::jsonb)
    ON CONFLICT ("requestKey") DO NOTHING`;
}

export type ProviderFinancialHold = 'REFUND' | 'DISPUTE' | 'REVERSAL' | 'PAYMENT';
/** Caller holds Order then Payment. Only locally bound IDs establish ownership. No provider calls. */
export async function providerFinancialHold(tx: Prisma.TransactionClient, payment: Payment): Promise<ProviderFinancialHold | null> {
  if (payment.provider === 'MANUAL') return null;
  const [refund] = await tx.$queryRaw<Array<{ id: number }>>`SELECT e.id FROM "PaymentWebhookEvent" e
    WHERE e.provider=${payment.provider}::"PaymentProvider" AND e.evidence->>'kind'='refund'
    AND (e.evidence->>'parentReference'=${payment.provider === 'STRIPE' ? payment.providerReference : payment.providerCaptureReference}
      OR EXISTS(SELECT 1 FROM "PaymentAttempt" a WHERE a."paymentId"=${payment.id} AND a.provider=e.provider
        AND e.evidence->>'parentReference'=CASE WHEN e.provider='STRIPE' THEN a."providerReference" ELSE a."providerCaptureReference" END))
    AND (e."processedAt" IS NULL OR e."processingError" IN ('REFUND_UNCORRELATED','REFUND_CORRELATION_MISMATCH','REFUND_EVIDENCE_INCOMPLETE')) LIMIT 1`;
  if (refund) return 'REFUND';
  const attempts = await tx.paymentAttempt.findMany({ where: { paymentId: payment.id, provider: payment.provider },
    include: { finalityEvidence: { include: { operation: true } }, successEvidence: true, operations: true } });
  if (payment.provider === 'STRIPE') {
    const receipts = await tx.$queryRaw<Array<{ id: number; eventType: string; evidence: Prisma.JsonValue; receivedAt: Date }>>`SELECT e.id,e."eventType",e.evidence,e."receivedAt" FROM "PaymentWebhookEvent" e
      WHERE e.provider='STRIPE' AND (e.evidence->>'kind'='stripe-dispute' OR e."eventType" IN ('payment_intent.succeeded','payment_intent.payment_failed','payment_intent.canceled'))
      AND (e.evidence->>'paymentIntentId'=${payment.providerReference} OR EXISTS(SELECT 1 FROM "PaymentAttempt" a WHERE a."paymentId"=${payment.id} AND a.provider='STRIPE' AND a."providerReference"=e.evidence->>'paymentIntentId')) ORDER BY e.id`;
    for (const receipt of receipts) {
      const data = object(receipt.evidence);
      if (data.kind === 'stripe-dispute') return 'DISPUTE';
      const attempt = attempts.find(a => a.providerReference === data.paymentIntentId);
      if (attempt && (attempt.orderId !== payment.orderId || !attempt.amount.eq(payment.amount) || attempt.currency !== payment.currency)) return 'PAYMENT';
      const amount = attempt?.amount ?? payment.amount;
      if (data.version !== 1 || data.amount !== amount.mul(100).toNumber() || typeof data.currency !== 'string' || data.currency.toUpperCase() !== payment.currency
        || data.orderId !== undefined && data.orderId !== String(payment.orderId)
        || data.attemptId !== undefined && data.attemptId !== String(attempt?.id)
        || data.paymentKey !== undefined && data.paymentKey !== (attempt?.creationKey ?? payment.idempotencyKey)) return 'PAYMENT';
      if (data.paymentIntentId === payment.providerReference && payment.status === 'SUCCEEDED' && payment.paidAt) {
        if (receipt.eventType === 'payment_intent.succeeded' && !attempt?.finalityEvidenceId) continue;
        // Verified success is monotonic on this same intent; a delayed nonterminal decline cannot undo it.
        const success = attempt?.successEvidence;
        const facts = object(success?.normalized ?? null);
        if (receipt.eventType === 'payment_intent.payment_failed' && success?.kind === 'SUCCESS' && success.verifiedAt
          && success.orderId === payment.orderId && success.provider === payment.provider
          && facts.providerReference === payment.providerReference && facts.amount === payment.amount.toFixed(2) && facts.currency === payment.currency
          && !attempt!.finalityEvidenceId) {
          await retainResolution(tx, payment, receipt.id, attempt!.id, success.id); continue;
        }
        return 'PAYMENT';
      }
      const proof = attempt && await unpaidProof(tx, attempt, payment);
      if (proof && ['payment_intent.payment_failed', 'payment_intent.canceled'].includes(receipt.eventType)) {
        await retainResolution(tx, payment, receipt.id, attempt!.id, proof.id); continue;
      }
      return 'PAYMENT'; // Historical success or unproven/contradictory identity stays held.
    }
  } else {
    const receipts = await tx.$queryRaw<Array<{ id: number; eventType: string; evidence: Prisma.JsonValue }>>`SELECT e.id,e."eventType",e.evidence FROM "PaymentWebhookEvent" e
      WHERE e.provider='PAYPAL' AND (e."reviewDetails"->'correlations' @> ${JSON.stringify([{ orderId: payment.orderId, paymentId: payment.id }])}::jsonb
        OR ((e."eventType" IN ('PAYMENT.CAPTURE.DECLINED','PAYMENT.CAPTURE.REVERSED','CHECKOUT.PAYMENT-APPROVAL.REVERSED','CUSTOMER.DISPUTE.CREATED','CUSTOMER.DISPUTE.UPDATED','CUSTOMER.DISPUTE.RESOLVED')
          OR (e."eventType" IN ('PAYMENT.CAPTURE.COMPLETED','PAYMENT.CAPTURE.PENDING','PAYMENT.CAPTURE.DENIED') AND (e."processedAt" IS NULL OR e."processingError" IS NOT NULL)))
          AND (e.evidence->>'paypalOrderId'=${payment.providerReference} OR e.evidence->>'captureId'=${payment.providerCaptureReference}
            OR EXISTS(SELECT 1 FROM "PaymentAttempt" a WHERE a."paymentId"=${payment.id} AND a.provider='PAYPAL'
              AND (a."providerReference"=e.evidence->>'paypalOrderId' OR a."providerCaptureReference"=e.evidence->>'captureId'
                OR e.evidence->'sellerTransactionIds' @> to_jsonb(ARRAY[a."providerCaptureReference"])))))) ORDER BY e.id`;
    for (const receipt of receipts) {
      if (receipt.eventType.startsWith('CUSTOMER.DISPUTE.')) return 'DISPUTE';
      if (['PAYMENT.CAPTURE.REVERSED', 'CHECKOUT.PAYMENT-APPROVAL.REVERSED'].includes(receipt.eventType)) return 'REVERSAL';
      const data = object(receipt.evidence);
      const attempt = attempts.find(a => a.providerReference === data.paypalOrderId && a.providerCaptureReference === data.captureId);
      const proof = attempt && await unpaidProof(tx, attempt, payment);
      let matches = false;
      try { matches = typeof data.amount === 'string' && new Decimal(data.amount).eq(attempt?.amount ?? -1); } catch { /* held below */ }
      if ((receipt.eventType === 'PAYMENT.CAPTURE.DECLINED' && data.resourceStatus === 'DECLINED' || receipt.eventType === 'PAYMENT.CAPTURE.DENIED')
        && data.version === 1 && data.eventType === receipt.eventType
        && (data.invalidFields === undefined || Array.isArray(data.invalidFields) && data.invalidFields.length === 0)
        && data.currency === payment.currency && matches && proof && attempt!.providerReference !== payment.providerReference) {
        await retainResolution(tx, payment, receipt.id, attempt!.id, proof.id); continue;
      }
      return 'PAYMENT'; // Including unknown declines: reviewedAt is intentionally irrelevant.
    }
  }
  return null;
}
