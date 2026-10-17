import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { acknowledgePayPalWebhookReview, listPayPalWebhookReviews } from '../domain/payments/paypalWebhookReviewService.js';

const router = Router();
router.use(authMiddleware, (req, res, next) => {
  if (req.user?.role !== 'ADMIN') { res.status(403).json({ error: 'Forbidden: ADMIN only' }); return; }
  next();
});
const idSchema = z.coerce.number().int().positive().safe();
router.get('/', async (req, res) => {
  const parsed = z.object({ afterId: z.coerce.number().int().nonnegative().safe().default(0), includeAcknowledged: z.enum(['true', 'false']).default('false') }).strict().safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: 'Invalid review query' }); return; }
  try { res.json({ reviews: await listPayPalWebhookReviews(parsed.data.afterId, parsed.data.includeAcknowledged === 'true') }); }
  catch { res.status(503).json({ error: 'PayPal review unavailable' }); }
});
router.post('/:receiptId/acknowledge', async (req, res) => {
  const id = idSchema.safeParse(req.params.receiptId);
  if (!id.success || !z.object({}).strict().safeParse(req.body ?? {}).success) { res.status(400).json({ error: 'Invalid review acknowledgement' }); return; }
  try {
    const review = await acknowledgePayPalWebhookReview(id.data, req.user!.id);
    if (!review) { res.status(404).json({ error: 'Review not found' }); return; }
    res.json({ id: review.id, reviewedAt: review.reviewedAt, reviewDetails: review.reviewDetails });
  } catch { res.status(503).json({ error: 'PayPal review unavailable' }); }
});
export default router;
