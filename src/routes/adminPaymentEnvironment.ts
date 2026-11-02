import { Router } from 'express'
import { authMiddleware } from '../middleware/auth.js'
import { config } from '../config/index.js'
import { stripeEnvironment } from '../domain/payments/stripeEnvironment.js'

const router = Router()
router.use(authMiddleware, (req, res, next) => {
  if (req.user?.role !== 'ADMIN') return res.status(403).json({ error: 'Forbidden' })
  next()
})

router.get('/', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    stripeEnvironment: stripeEnvironment(config.STRIPE_SECRET_KEY),
    refundReconciliationEnabled: config.REFUND_RECONCILIATION_ENABLED,
  })
})

export default router
