import type { Payment, Prisma } from '../../generated/prisma-client/client.js';
import { databaseNow, PaymentResolutionUnavailableError } from './paymentResolutionService.js';

export type PayPalFinalityOutcome = 'NOT_DISPATCHED' | 'DEFINITIVELY_DECLINED' | 'PENDING' | 'UNKNOWN' | 'COMPLETED';
export function classifyPayPalCapture(status: string): PayPalFinalityOutcome {
  return status === 'COMPLETED' ? 'COMPLETED' : status === 'DECLINED' ? 'DEFINITIVELY_DECLINED'
    : status === 'PENDING' ? 'PENDING' : 'UNKNOWN';
}

/** Order lock required. Only the resolver may certify this after closing admission
 * (no CAPTURE ever journalled), or an exact provider GET proving a final decline.
 * Every operation remains covered; immutable primary failure evidence is retained.
 */
export async function recordPayPalUnpaidFinality(tx: Prisma.TransactionClient, payment: Payment,
  outcome: 'NOT_DISPATCHED' | 'DEFINITIVELY_DECLINED', captureId?: string, retrievalId?: number) {
  const attempt = await tx.paymentAttempt.findFirst({ where: { paymentId: payment.id, provider: 'PAYPAL', providerReference: payment.providerReference.startsWith('pending:') ? null : payment.providerReference, historical: false }, include: { operations: true } });
  if (!attempt || attempt.historical || attempt.paymentId !== payment.id || attempt.successEvidenceId || payment.paidAt || payment.status === 'SUCCEEDED') throw new PaymentResolutionUnavailableError();
  if (attempt.finalityEvidenceId) return;
  const resolution = await tx.paymentResolution.findUniqueOrThrow({ where: { orderId: payment.orderId } });
  if (outcome === 'NOT_DISPATCHED' && (payment.providerReference.startsWith('pending:') || payment.providerCaptureReference || attempt.providerCaptureReference || !resolution.paymentAdmissionClosedAt || payment.captureIdempotencyKey || attempt.operations.some(o => o.type !== 'CREATE' && o.type !== 'RETRIEVE'))) throw new PaymentResolutionUnavailableError();
  const now = await databaseNow(tx);
  let finalityId: number | undefined;
  for (const operation of attempt.operations) {
    if (operation.historical || operation.type === 'CONFIRM' || operation.type === 'TERMINATE') throw new PaymentResolutionUnavailableError();
    const evidence = await tx.financialEvidence.create({ data: { orderId: payment.orderId, provider: 'PAYPAL', operationId: operation.id,
      evidenceKey: `paypal-final:${attempt.id}:${operation.id}`, kind: 'TERMINAL_UNPAID', verifiedAt: now,
      normalized: { providerReference: attempt.providerReference, amount: payment.amount.toFixed(2), currency: payment.currency,
        outcome, ...(!captureId && outcome === 'DEFINITIVELY_DECLINED' ? { declineCode: 'INSTRUMENT_DECLINED' } : {}), ...(captureId ? { providerCaptureReference: captureId } : {}), ...(retrievalId ? { retrievalId } : {}) } } });
    finalityId = evidence.id;
    if (operation.state !== 'RESULT_RECORDED') await tx.paymentOperation.update({ where: { id: operation.id }, data: { state: 'RESULT_RECORDED', evidenceId: evidence.id, claimOwner: null, leaseExpiresAt: null } });
  }
  if (!finalityId) throw new PaymentResolutionUnavailableError();
  await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { finalityEvidenceId: finalityId, ...(captureId ? { providerCaptureReference: captureId } : {}) } });
  await tx.payment.update({ where: { id: payment.id }, data: { status: 'CANCELED' } });
}
