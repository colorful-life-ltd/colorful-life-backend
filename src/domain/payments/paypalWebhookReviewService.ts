import { Prisma as PrismaValues } from '../../generated/prisma-client/client.js';
import { prisma } from '../../prisma/runtime.js';
import type { Prisma } from '../../generated/prisma-client/client.js';
import type { PayPalWebhookEvent } from './paypalReconciliationService.js';
import { recordManagedFailure } from './paymentResolutionService.js';

/** Review is receipt-scoped, append-only as to provider observations. Distinct
 * notifications never replace a newer dispute state or close another review. */
export async function processPayPalRiskReceipt(receiptId: number, event: PayPalWebhookEvent) {
  return prisma.$transaction(async tx => {
    const captures = [...new Set([...(event.sellerTransactionIds ?? []), ...(event.captureId ? [event.captureId] : [])])];
    // Only provider-issued, locally bound IDs. Never custom_id / local metadata.
    const matches: Prisma.PaymentWhereInput[] = [];
    if (captures.length) matches.push({ providerCaptureReference: { in: captures } }, { attempts: { some: { provider: 'PAYPAL', providerCaptureReference: { in: captures } } } });
    if (event.paypalOrderId) matches.push({ providerReference: event.paypalOrderId }, { attempts: { some: { provider: 'PAYPAL', providerReference: event.paypalOrderId } } });
    const candidates = matches.length ? await tx.payment.findMany({ where: { provider: 'PAYPAL', OR: matches }, orderBy: { orderId: 'asc' }, include: { attempts: true, order: { select: { userId: true, status: true, totalAmount: true } } } }) : [];
    for (const payment of candidates) await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${payment.orderId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "PaymentWebhookEvent" WHERE id=${receiptId} FOR UPDATE`;
    const receipt = await tx.paymentWebhookEvent.findUniqueOrThrow({ where: { id: receiptId } });
    if (receipt.processedAt) return { handled: true, processed: true };
    const payments = candidates.length ? await tx.payment.findMany({ where: { id: { in: candidates.map(p => p.id) }, provider: 'PAYPAL' }, include: { attempts: true, order: { select: { userId: true, status: true, totalAmount: true } } } }) : [];
    const ownsCapture = (p: typeof payments[number], id: string) => p.providerCaptureReference === id || p.attempts.some(a => a.providerCaptureReference === id);
    const ownsOrder = (p: typeof payments[number], id: string) => p.providerReference === id || p.attempts.some(a => a.providerReference === id);
    const correlations = payments.filter(p => (!event.paypalOrderId || ownsOrder(p, event.paypalOrderId))
      && (!event.captureId || ownsCapture(p, event.captureId) || (!p.providerCaptureReference && p.providerReference === event.paypalOrderId))
      && (!event.sellerTransactionIds?.length || event.sellerTransactionIds.some(id => ownsCapture(p, id))));
    const unmatched = captures.filter(id => !correlations.some(p => ownsCapture(p, id) || (!p.providerCaptureReference && p.providerReference === event.paypalOrderId && id === event.captureId)));
    const reason = event.invalidFields?.length ? 'MALFORMED_RESOURCE' : !correlations.length || unmatched.length ? 'UNCORRELATED_PROVIDER_IDENTIFIERS' : 'PROVIDER_EVENT_REQUIRES_REVIEW';
    const details = { reason, correlations: correlations.map(p => ({ orderId: p.orderId, paymentId: p.id, customerId: p.order.userId })), unmatchedCaptureIds: unmatched };
    const declined = event.eventType === 'PAYMENT.CAPTURE.DECLINED';
    // A v2 decline is only a failure signal. No TERMINAL_UNPAID evidence,
    // capture binding, order mutation, or inventory effect is authorized here.
    if (declined && reason === 'PROVIDER_EVENT_REQUIRES_REVIEW' && correlations.length === 1 && event.resourceStatus === 'DECLINED') {
      const payment = correlations[0];
      const attempt = payment.attempts.find(a => a.providerReference === event.paypalOrderId && !a.historical);
      if (payment.providerReference === event.paypalOrderId && (!attempt || !attempt.finalityEvidenceId)
        && payment.order.status === 'PENDING' && payment.amount.equals(payment.order.totalAmount) && payment.currency === 'GBP'
        && !payment.paidAt && payment.status !== 'SUCCEEDED' && payment.amount.toFixed(2) === event.amount && payment.currency === event.currency) {
        await recordManagedFailure(tx, payment, payment.providerReference, `paypal-failure:${receipt.id}`, receipt.id);
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });
        await tx.paymentResolution.updateMany({ where: { orderId: payment.orderId, historical: false, quarantineReason: null, reservationDisposition: 'HELD', state: { not: 'PAID' } }, data: { resolutionNextCheckAt: new Date() } });
      }
    }
    await tx.paymentWebhookEvent.update({ where: { id: receiptId }, data: { reviewDetails: details, processedAt: new Date(),
      processingError: reason !== 'PROVIDER_EVENT_REQUIRES_REVIEW' ? `PayPal review required: ${reason}` : null } });
    return { handled: true, processed: true };
  });
}

export async function listPayPalWebhookReviews(afterId = 0, includeAcknowledged = false) {
  return prisma.paymentWebhookEvent.findMany({ where: { provider: 'PAYPAL', id: { gt: afterId }, reviewDetails: { not: PrismaValues.DbNull },
    ...(!includeAcknowledged ? { reviewedAt: null } : {}) }, orderBy: { id: 'asc' }, take: 100,
    select: { id: true, providerEventId: true, eventType: true, receivedAt: true, processedAt: true, processingError: true, evidence: true, reviewDetails: true, reviewedAt: true } });
}

/** Acknowledgement records who inspected evidence; it is NOT financial finality,
 * provider dispute resolution, permission to release stock, or a refund. */
export async function acknowledgePayPalWebhookReview(id: number, userId: number) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "PaymentWebhookEvent" WHERE id=${id} FOR UPDATE`;
    const receipt = await tx.paymentWebhookEvent.findUnique({ where: { id } });
    if (!receipt || receipt.provider !== 'PAYPAL' || !receipt.reviewDetails) return null;
    if (receipt.reviewedAt) return receipt;
    return tx.paymentWebhookEvent.update({ where: { id }, data: { reviewedAt: new Date(),
      reviewDetails: { ...receipt.reviewDetails as Prisma.JsonObject, acknowledgedByUserId: userId } } });
  });
}
