import type { Prisma } from '../../generated/prisma-client/client.js';
import { purchaseSchema } from './contract.js';

/** Only called inside the existing verified Stripe success transaction/Order lock. */
export async function enqueueOrderConfirmation(tx: Prisma.TransactionClient, orderId: number) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: {
    user: { select: { email: true, firstName: true, emailVerified: true, deletedAt: true } }, orderItems: true,
    payments: true, paymentResolution: true,
  } });
  const payment = order.payments.find(p => p.provider === 'STRIPE' && p.status === 'SUCCEEDED' && p.paidAt);
  if (!payment || order.cancelledAt || !['CONFIRMED', 'DISPATCHED', 'COMPLETED'].includes(order.status)
    || order.paymentResolution && order.paymentResolution.reservationDisposition !== 'CONSUMED') return;
  const address = (kind: 'billing' | 'delivery') => ({ recipientName: order[`${kind}RecipientName`], line1: order[`${kind}Line1`], line2: order[`${kind}Line2`], city: order[`${kind}City`], county: order[`${kind}County`], postcode: order[`${kind}Postcode`], countryCode: order[`${kind}CountryCode`] });
  const source = {
    version: 1, orderId, paymentId: payment.id, paidAt: payment.paidAt!.toISOString(), currency: payment.currency,
    recipientEmail: order.user.emailVerified && !order.user.deletedAt ? order.user.email : null,
    firstName: order.user.firstName, billing: address('billing'), shippingAddress: address('delivery'),
    items: order.orderItems.map(i => ({ description: i.invoiceDescriptionSnapshot, setNumber: i.invoiceSetNumberSnapshot, quantity: i.quantity, unitPence: i.unitPrice.mul(100).toNumber(), linePence: i.lineTotal.mul(100).toNumber() })),
    subtotalPence: order.orderItems.reduce((s, i) => s + i.lineTotal.mul(100).toNumber(), 0), totalPence: payment.amount.mul(100).toNumber(),
    delivery: order.confirmationDeliverySnapshot,
  };
  const valid = purchaseSchema.safeParse(source).success && payment.amount.equals(order.totalAmount);
  const reason = !source.delivery ? 'SHIPPING_NOT_PERSISTED' : source.items.some(i => !i.description) ? 'PRODUCT_SNAPSHOT_MISSING' : !source.recipientEmail ? 'RECIPIENT_UNAVAILABLE' : 'PURCHASE_DATA_INVALID';
  // Incomplete business data must never undo payment/inventory confirmation.
  await tx.orderConfirmationJob.upsert({ where: { eventKey: `order:${orderId}` }, create: {
    orderId, eventKey: `order:${orderId}`, type: 'ORDER_CONFIRMATION', source: JSON.parse(JSON.stringify(source)) as Prisma.InputJsonValue,
    state: order.user.deletedAt ? 'SUPPRESSED' : valid ? 'PENDING' : 'BLOCKED', lastErrorCode: order.user.deletedAt ? 'ACCOUNT_DELETED' : valid ? null : reason,
  }, update: {} });
}

/** Internal operator handoff; never invoked by reads/recovery/webhook re-observation.
 * Callers must explicitly approve historical capture. Does not bypass paid/order/data gates.
 */
export async function recoverOrderConfirmation(orderId: number, approveHistoricalCapture: boolean) {
  if (!approveHistoricalCapture) throw new Error('Explicit historical confirmation review required');
  const { prisma } = await import('../../prisma/runtime.js');
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR NO KEY UPDATE`;
    await enqueueOrderConfirmation(tx, orderId);
    const job = await tx.orderConfirmationJob.findUnique({ where: { eventKey: `order:${orderId}` } });
    if (!job) throw new Error('Order is not eligible for confirmation recovery');
    return { jobId: job.id, state: job.state };
  });
}
