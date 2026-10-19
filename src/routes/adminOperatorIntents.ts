import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { sendApiError } from '../utils/apiErrorResponse.js';
import { logOperationalError } from '../utils/operationalLog.js';
import { OperatorIntentResolutionError, recordOperatorIntentResolution } from '../domain/operations/operatorIntentResolution.js';

const router = Router();
router.use(authMiddleware, (req, res, next) => {
  if (req.user?.role !== 'ADMIN') return sendApiError(res, 403, 'FORBIDDEN', 'Forbidden: ADMIN only');
  next();
});
const id = z.number().int().positive().max(2147483647);
const ResolutionSchema = z.object({
  operation: z.string().regex(/^[A-Za-z]{1,40}$/), decision: z.enum(['APPLIED', 'NOT_APPLIED']), note: z.string().trim().min(10).max(1000),
  orderId: id.optional(), productId: id.optional(), productListingId: id.optional(), receiptId: id.optional(),
}).strict();
// The Idempotency-Key is the original Admin intent key, so one intent has one decision.
router.post('/resolutions', async (req, res) => {
  const key = req.get('Idempotency-Key') ?? '';
  const input = ResolutionSchema.safeParse(req.body);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/.test(key) || !input.success) return res.status(400).json({ error: 'INVALID_OPERATOR_INTENT_RESOLUTION' });
  try { return res.status(201).json(await recordOperatorIntentResolution(req.user!.id, key, input.data)); }
  catch (error) {
    if (error instanceof OperatorIntentResolutionError) return res.status(error.status).json({ error: error.code });
    logOperationalError('Operator intent resolution failed', error);
    return res.status(503).json({ error: 'OPERATOR_INTENT_RESOLUTION_UNAVAILABLE' });
  }
});
export default router;
