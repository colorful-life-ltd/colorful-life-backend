import assert from 'node:assert/strict'
import { after, afterEach, before, it } from 'node:test'
import jwt from 'jsonwebtoken'
import app from '../app.js'
import { config } from '../config/index.js'

let server: ReturnType<typeof app.listen>, base: string
const oldSecret = config.STRIPE_SECRET_KEY
const oldReconciliation = config.REFUND_RECONCILIATION_ENABLED
before(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(() => { config.STRIPE_SECRET_KEY = oldSecret; config.REFUND_RECONCILIATION_ENABLED = oldReconciliation })
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })
const token = (role: 'ADMIN' | 'CUSTOMER') => jwt.sign({ id: role === 'ADMIN' ? 7 : 8, role }, config.JWT_SECRET)

it('reports only authoritative Stripe mode and reconciliation availability to Admins', async () => {
  config.STRIPE_SECRET_KEY = 'sk_test_never_return_this_value'
  config.REFUND_RECONCILIATION_ENABLED = false
  const response = await fetch(`${base}/admin/payment-environment`, { headers: { Authorization: `Bearer ${token('ADMIN')}` } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  const body = await response.json()
  assert.deepEqual(body, { stripeEnvironment: 'TEST', refundReconciliationEnabled: false })
  assert.equal(JSON.stringify(body).includes('never_return_this_value'), false)
})

it('reports UNKNOWN when Stripe credentials are missing and rejects non-admin access', async () => {
  config.STRIPE_SECRET_KEY = undefined
  const response = await fetch(`${base}/admin/payment-environment`, { headers: { Authorization: `Bearer ${token('ADMIN')}` } })
  assert.deepEqual(await response.json(), { stripeEnvironment: 'UNKNOWN', refundReconciliationEnabled: oldReconciliation })
  assert.equal((await fetch(`${base}/admin/payment-environment`, { headers: { Authorization: `Bearer ${token('CUSTOMER')}` } })).status, 403)
  assert.equal((await fetch(`${base}/admin/payment-environment`)).status, 401)
})
