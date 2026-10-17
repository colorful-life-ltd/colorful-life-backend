import { config } from '../config/index.js';
import { bucket } from '../domain/security/paymentAbuse.js';
import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { prisma } from '../prisma/runtime.js';
import { reviewOrder, updatePolicy, pruneSecurityState } from '../domain/security/paymentSecurityOperations.js';
const router = Router();
router.use(authMiddleware, (req, res, next) => {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' });
  next();
});
const note = z.string().trim().min(10).max(500);
router.post('/maintenance', async (_req, res) => {
  try { res.json(await pruneSecurityState()); } catch { res.status(503).json({ error: 'Maintenance unavailable' }); }
});
router.get('/', async (_req, res) => {
  try {
    const [policies, reviews, counts, providerOutcomes, providerBudgets] = await Promise.all([
      prisma.$queryRaw`SELECT * FROM "PaymentInitiationPolicy" ORDER BY "provider"`,
      prisma.$queryRaw`SELECT * FROM "PaymentFulfilmentReview" WHERE "releasedAt" IS NULL ORDER BY "createdAt" LIMIT 100`,
      prisma.$queryRaw`SELECT "kind", "provider", count(*)::int AS count FROM "PaymentSecurityEvent"
        WHERE "createdAt" > clock_timestamp() - interval '10 minutes' GROUP BY "kind", "provider"`,
      prisma.$queryRaw`SELECT provider, "eventType", count(*)::int AS count FROM "PaymentWebhookEvent"
        WHERE "receivedAt" > clock_timestamp() - interval '10 minutes' AND "processedAt" IS NOT NULL
        AND "processingError" IS NULL GROUP BY provider, "eventType"`,
      prisma.$queryRaw`SELECT "tokens", "updatedAt", "expiresAt", CASE WHEN "key"=${bucket('provider', 'STRIPE').key} THEN 'STRIPE' ELSE 'PAYPAL' END AS provider
        FROM "AbuseBucket" WHERE "key" IN (${bucket('provider', 'STRIPE').key}, ${bucket('provider', 'PAYPAL').key})`,
    ]);
    res.json({ policies, environmentEnabled: { STRIPE: config.PAYMENT_STRIPE_INITIATION_ENABLED, PAYPAL: config.PAYMENT_PAYPAL_INITIATION_ENABLED }, reviews, counts, providerOutcomes, providerBudgets });
  } catch { res.status(503).json({ error: 'Security monitoring unavailable' }); }
});
router.post('/providers/:provider', async (req, res) => {
  const provider = z.enum(['STRIPE', 'PAYPAL']).safeParse(req.params.provider);
  const input = z.object({ enabled: z.boolean(), capacity: z.number().int().min(1).max(1000000).nullable(), note }).strict().safeParse(req.body);
  if (!provider.success || !input.success) return res.status(400).json({ error: 'Invalid policy' });
  try { await updatePolicy(req.user!.id, provider.data, input.data.enabled, input.data.capacity, input.data.note); res.json({ updated: true }); }
  catch { res.status(503).json({ error: 'Policy update unavailable' }); }
});
router.post('/orders/:orderId', async (req, res) => {
  const id = z.coerce.number().int().positive().safeParse(req.params.orderId);
  const input = z.object({ action: z.enum(['HOLD', 'RELEASE']), note }).strict().safeParse(req.body);
  if (!id.success || !input.success) return res.status(400).json({ error: 'Invalid review' });
  try { await reviewOrder(req.user!.id, id.data, input.data.action, input.data.note); res.json({ updated: true }); }
  catch { res.status(503).json({ error: 'Review update unavailable' }); }
});
export default router;
