import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Payment } from '../generated/prisma-client/client.js';
import { isConfirmationPayment } from '../domain/orderConfirmation/verifiedPayment.js';

// Only fields inspected by this read-only eligibility predicate.
const paid = { provider: 'STRIPE', status: 'SUCCEEDED', paidAt: new Date(), providerReference: 'pi_verified', providerCaptureReference: null } as Payment;
it('shared invoice eligibility accepts verified Stripe payments', () => {
  assert.equal(isConfirmationPayment(paid), true);
});
it('shared invoice eligibility rejects unpaid and manual records', () => {
  for (const change of [{ status: 'PROCESSING' as const }, { paidAt: null }, { provider: 'MANUAL' as const }]) {
    assert.equal(isConfirmationPayment({ ...paid, ...change }), false);
  }
});
