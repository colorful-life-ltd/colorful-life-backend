import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { Payment } from '../generated/prisma-client/client.js';
import { isConfirmationPayment } from '../domain/orderConfirmation/verifiedPayment.js';

// Only fields inspected by this read-only eligibility predicate.
const paid = { provider: 'PAYPAL', status: 'SUCCEEDED', paidAt: new Date(), providerReference: 'PP-verified', providerCaptureReference: 'CAP-verified' } as Payment;
it('shared invoice eligibility accepts bound verified PayPal and preserves Stripe eligibility', () => {
  assert.equal(isConfirmationPayment(paid), true);
  assert.equal(isConfirmationPayment({ ...paid, provider: 'STRIPE', providerCaptureReference: null }), true);
});
it('shared invoice eligibility rejects unbound, pending, unpaid and manual records', () => {
  for (const change of [{ providerCaptureReference: null }, { providerCaptureReference: '' }, { providerReference: 'pending:creation' }, { status: 'PROCESSING' as const }, { paidAt: null }, { provider: 'MANUAL' as const }]) {
    assert.equal(isConfirmationPayment({ ...paid, ...change }), false);
  }
});
