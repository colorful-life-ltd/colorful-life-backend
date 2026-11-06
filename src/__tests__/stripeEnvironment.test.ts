import assert from 'node:assert/strict'
import { it } from 'node:test'
import { stripeEnvironment } from '../domain/payments/stripeEnvironment.js'

it('classifies only recognized Stripe test/live secret-key prefixes and never returns credentials', () => {
  assert.equal(stripeEnvironment(undefined), 'UNKNOWN')
  assert.equal(stripeEnvironment(''), 'UNKNOWN')
  assert.equal(stripeEnvironment('sk_test_private_value'), 'TEST')
  assert.equal(stripeEnvironment('rk_test_private_value'), 'TEST')
  assert.equal(stripeEnvironment('sk_live_private_value'), 'LIVE')
  assert.equal(stripeEnvironment('rk_live_private_value'), 'LIVE')
  assert.equal(stripeEnvironment('pk_test_public_value'), 'UNKNOWN')
  assert.equal(stripeEnvironment('unexpected_private_value'), 'UNKNOWN')
})
