import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../prisma/runtime.js';
import { resolveRefundReview,replayRefundEvidenceAsAdmin } from '../domain/refunds/refundReviewService.js';
import { RefundIntentError } from '../domain/refunds/refundLifecycleService.js';
const router = Router();
router.use(authMiddleware, (req, res, next) => { if (req.user?.role !== 'ADMIN')
    return res.status(403).json({ error: 'FORBIDDEN' }); next(); });
router.get('/', async (req, res) => {
    const after = z.coerce.number().int().nonnegative().safeParse(req.query.afterId ?? 0);
    if (!after.success)
        return res.status(400).json({ error: 'INVALID_CURSOR' });
    try {
        res.json(await prisma.refund.findMany({ where: { reviewRequired: true, id: { gt: after.data } }, orderBy: { id: 'asc' }, take: 100 }));
    }
    catch {
        res.status(503).json({ error: 'REVIEW_UNAVAILABLE' });
    }
});
router.get('/provider-evidence', async (req, res) => {
    const after=z.coerce.number().int().nonnegative().safeParse(req.query.afterId??0);
    if(!after.success)return res.status(400).json({error:'INVALID_CURSOR'});
    try {
        res.json(await prisma.paymentWebhookEvent.findMany({ where: { id:{gt:after.data}, processingError: { not: null }, OR: [{ evidence: { path: ['kind'], equals: 'refund' } }, { evidence: { path: ['kind'], equals: 'stripe-dispute' } }] }, orderBy: { id: 'asc' }, take: 100 }));
    }
    catch {
        res.status(503).json({ error: 'REVIEW_UNAVAILABLE' });
    }
});
router.post('/provider-evidence/:id/replay', async (req,res)=>{
 const id=z.coerce.number().int().positive().safeParse(req.params.id);
 const input=z.object({reason:z.string().trim().min(10).max(500)}).strict().safeParse(req.body);
 if(!id.success||!input.success)return res.status(400).json({error:'INVALID_REPLAY'});
 try{res.json(await replayRefundEvidenceAsAdmin(req.user!.id,id.data,input.data.reason,req.get('Idempotency-Key')??''));}
 catch(e){if(e instanceof RefundIntentError)return res.status(e.httpStatus).json({error:e.code});res.status(503).json({error:'REVIEW_UNAVAILABLE'});}
});
router.get('/:orderId/:refundId', async (req, res) => {
    const ids = z.object({ orderId: z.coerce.number().int().positive(), refundId: z.coerce.number().int().positive() }).safeParse(req.params);
    if (!ids.success)
        return res.status(400).json({ error: 'INVALID_REFUND_ID' });
    try {
        const refund = await prisma.refund.findFirst({ where: { id: ids.data.refundId, orderId: ids.data.orderId } });
        if (!refund)
            return res.status(404).json({ error: 'REFUND_NOT_FOUND' });
        const history = await prisma.$queryRaw `SELECT id::text,kind,"actorId",revision,details,"createdAt" FROM "OperationalAudit" WHERE "refundId"=${refund.id} ORDER BY id DESC LIMIT 100`;
        res.json({ refund, history });
    }
    catch {
        res.status(503).json({ error: 'REVIEW_UNAVAILABLE' });
    }
});
router.post('/:orderId/:refundId/resolve', async (req, res) => {
    const ids = z.object({ orderId: z.coerce.number().int().positive(), refundId: z.coerce.number().int().positive() }).safeParse(req.params);
    const input = z.object({ expectedRevision: z.number().int().nonnegative(), reason: z.string().trim().min(10).max(1000), evidenceReferences: z.array(z.string().min(1).max(128)).min(1).max(10) }).strict().safeParse(req.body);
    if (!ids.success || !input.success)
        return res.status(400).json({ error: 'INVALID_REVIEW_RESOLUTION' });
    try {
        res.json(await resolveRefundReview(req.user!.id, ids.data.orderId, ids.data.refundId, input.data, req.get('Idempotency-Key') ?? ''));
    }
    catch (e) {
        if (e instanceof RefundIntentError)
            return res.status(e.httpStatus).json({ error: e.code });
        res.status(503).json({ error: 'REVIEW_PERSISTENCE_UNAVAILABLE' });
    }
});
export default router;
