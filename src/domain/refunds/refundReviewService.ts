import { Decimal } from "@prisma/client/runtime/client";
import { createHash } from 'node:crypto';
import { prisma } from '../../prisma/runtime.js';
import { lockRefund, RefundIntentError, STRIPE_FAILED_AFTER_SUCCESS_AUDIT, stripeFailedAfterSuccessKey, validClientRequestKey } from './refundLifecycleService.js';
export async function resolveRefundReview(actorId: number, orderId: number, refundId: number, input: {
    expectedRevision: number;
    reason: string;
    evidenceReferences: string[];
}, key: string) {
    if (!validClientRequestKey(key) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
        || input.reason.trim().length < 10 || input.reason.length > 1000 || !input.evidenceReferences.length || input.evidenceReferences.length > 10
        || input.evidenceReferences.some(v => typeof v !== 'string' || v.length < 1 || v.length > 128))
        throw new RefundIntentError('INVALID_REVIEW_RESOLUTION', 400);
    const hash = createHash('sha256').update(JSON.stringify({ actorId, orderId, refundId, ...input })).digest('hex');
    return prisma.$transaction(async (tx) => {
        const actor = await tx.user.findUnique({ where: { id: actorId } });
        if (!actor || actor.deletedAt || actor.role !== 'ADMIN')
            throw new RefundIntentError('FORBIDDEN', 403);
        const { refund, payment } = await lockRefund(tx, refundId);
        if (refund.orderId !== orderId)
            throw new RefundIntentError('REFUND_NOT_FOUND', 404);
        const requestKey = `refund-resolution:${key}`;
        const prior = await tx.$queryRaw<Array<{
            requestHash: string;
            id: bigint;
        }>> `SELECT id,"requestHash" FROM "OperationalAudit" WHERE "requestKey"=${requestKey}`;
        if (prior.length) {
            if (prior[0].requestHash !== hash)
                throw new RefundIntentError('IDEMPOTENCY_CONFLICT');
            return { auditId: String(prior[0].id), replayed: true };
        }
        const [state] = await tx.$queryRaw<Array<{
            reviewRevision: number;
        }>> `SELECT "reviewRevision" FROM "Refund" WHERE id=${refundId}`;
        if (state.reviewRevision !== input.expectedRevision)
            throw new RefundIntentError('REVIEW_VERSION_CONFLICT');
        if (!refund.reviewRequired)
            throw new RefundIntentError('REFUND_REVIEW_NOT_OPEN');
        if (refund.provider === 'STRIPE' && refund.status === 'FAILED'
            && (refund.resolutionCode === 'REFUND_FAILED_AFTER_SUCCESS' || refund.resolutionCode === 'REFUND_FAILED_AFTER_CANCELLATION')) {
            // The audited Stripe failure-after-success adjustment is the corroborated outcome that explains the
            // earlier SUCCEEDED evidence. Accept it only at the adjustment's own review revision; any later
            // evidence reopens review under a new revision. Resolution never changes the order or stock.
            const [adjustment] = await tx.$queryRaw<Array<{ id: bigint; revision: number | null }>> `SELECT id,revision FROM "OperationalAudit"
      WHERE "requestKey"=${stripeFailedAfterSuccessKey(refundId)} AND "refundId"=${refundId} AND kind=${STRIPE_FAILED_AFTER_SUCCESS_AUDIT}`;
            if (!adjustment || adjustment.revision !== state.reviewRevision)
                throw new RefundIntentError('REFUND_FINANCIAL_RECONCILIATION_REQUIRED');
            const [audit] = await tx.$queryRaw<Array<{ id: bigint }>> `INSERT INTO "OperationalAudit" (kind,"actorId","orderId","refundId",revision,"requestKey","requestHash",details)
      VALUES ('REFUND_REVIEW_RESOLVED',${actorId},${orderId},${refundId},${state.reviewRevision},${requestKey},${hash},${JSON.stringify({ ...input, priorReviewEvidence: refund.reviewEvidence, providerOutcome: refund.providerOutcome, adjustmentId: String(adjustment.id) })}::jsonb) RETURNING id`;
            await tx.refund.update({ where: { id: refundId }, data: { reviewRequired: false } });
            return { auditId: String(audit.id), replayed: false };
        }
        // Financial discrepancies cannot be acknowledged away. Only a terminal,
        // corroborated outcome with no opposite valid terminal proof may be explained.
        if (refund.status === 'PROCESSING' || !refund.providerOutcome)
            throw new RefundIntentError('REFUND_FINANCIAL_RECONCILIATION_REQUIRED');
        const evidence = refund.reviewEvidence as Record<string, unknown> | null;
        if (evidence?.status && evidence.status !== refund.status && !['PENDING', 'UNKNOWN'].includes(String(evidence.status)))
            throw new RefundIntentError('REFUND_FINANCIAL_RECONCILIATION_REQUIRED');
        const history = await tx.$queryRaw<Array<{
            details: Record<string, unknown>;
        }>> `SELECT details FROM "OperationalAudit" WHERE "refundId"=${refundId} AND kind='REFUND_EVIDENCE'`;
        const parent = refund.providerPaymentReference ?? (refund.provider === 'STRIPE' ? payment.providerReference : payment.providerCaptureReference);
        for (const { details: e } of history) {
            if (!['SUCCEEDED', 'FAILED'].includes(String(e.status)) || e.status === refund.status || e.parentReference !== parent
                || typeof e.currency !== 'string' || e.currency.toUpperCase() !== refund.currency.toUpperCase()
                || (!refund.providerReference.startsWith('pending:') && e.reference !== refund.providerReference))
                continue;
            let matches = false;
            try {
                matches = new Decimal(String(e.amount)).eq(refund.amount);
            }
            catch { }
            if (matches)
                throw new RefundIntentError('REFUND_FINANCIAL_RECONCILIATION_REQUIRED');
        }
        const corroboration = await tx.$queryRaw<Array<{
            id: bigint;
        }>> `SELECT id FROM "OperationalAudit" WHERE "refundId"=${refundId}
      AND kind='REFUND_PROVIDER_CORROBORATION' AND revision=${state.reviewRevision} LIMIT 1`;
        if (!corroboration.length)
            throw new RefundIntentError('REFUND_FINANCIAL_RECONCILIATION_REQUIRED');
        const [audit] = await tx.$queryRaw<Array<{
            id: bigint;
        }>> `INSERT INTO "OperationalAudit" (kind,"actorId","orderId","refundId",revision,"requestKey","requestHash",details)
      VALUES ('REFUND_REVIEW_RESOLVED',${actorId},${orderId},${refundId},${state.reviewRevision},${requestKey},${hash},${JSON.stringify({ ...input, priorReviewEvidence: refund.reviewEvidence, providerOutcome: refund.providerOutcome, corroborationId: String(corroboration[0].id) })}::jsonb) RETURNING id`;
        await tx.refund.update({ where: { id: refundId }, data: { reviewRequired: false } });
        return { auditId: String(audit.id), replayed: false };
    });
}

/** Explicit audited replay of already verified evidence; never accepts provider facts. */
export async function replayRefundEvidenceAsAdmin(actorId:number,receiptId:number,reason:string,key:string){
 if(!validClientRequestKey(key)||reason.trim().length<10||reason.length>500)throw new RefundIntentError('INVALID_REPLAY',400);
 const requestKey=`refund-replay:${key}`;const hash=createHash('sha256').update(JSON.stringify({actorId,receiptId,reason})).digest('hex');
 await prisma.$transaction(async tx=>{
  const actor=await tx.user.findUnique({where:{id:actorId}});if(!actor||actor.deletedAt||actor.role!=='ADMIN')throw new RefundIntentError('FORBIDDEN',403);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${requestKey},0))`;
  const existing=await tx.operationalAudit.findUnique({where:{requestKey}});
  if(existing){if(existing.requestHash!==hash)throw new RefundIntentError('IDEMPOTENCY_CONFLICT');return;}
  const receipt=await tx.paymentWebhookEvent.findUnique({where:{id:receiptId}});if(!receipt)throw new RefundIntentError('RECEIPT_NOT_FOUND',404);
  await tx.operationalAudit.create({data:{kind:'REFUND_RECEIPT_REPLAY_REQUESTED',actorId,requestKey,requestHash:hash,details:{receiptId,reason}}});
 });
 const {processRefundWebhookReceipt}=await import('./refundWebhookService.js');
 return processRefundWebhookReceipt(receiptId);
}
