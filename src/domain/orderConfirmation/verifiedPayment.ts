import type { Payment } from '../../generated/prisma-client/client.js';

/** Called only for persisted financial success, never provider/browser hints.
 */
export function isConfirmationPayment(payment: Payment) {
  return payment.status === 'SUCCEEDED' && !!payment.paidAt
    && payment.provider === 'STRIPE';
}
