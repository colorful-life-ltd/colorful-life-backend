import type { Payment } from '../../generated/prisma-client/client.js';

/** Called only for persisted financial success, never provider/browser hints.
 * PayPal additionally needs the capture binding established by verified success.
 */
export function isConfirmationPayment(payment: Payment) {
  return payment.status === 'SUCCEEDED' && !!payment.paidAt
    && (payment.provider === 'STRIPE' || payment.provider === 'PAYPAL'
      && !!payment.providerCaptureReference?.trim()
      && !!payment.providerReference && !payment.providerReference.startsWith('pending:'));
}
