import { randomUUID } from 'node:crypto';
import { prisma } from '../../prisma/runtime.js';
import { dispatchSchema } from './dispatch.js';
import { classifySesError } from './delivery.js';
import { sendDispatchNotification } from '../../services/emailService.js';

/** Post-commit, one best-effort attempt. Immutable routing prevents dual delivery
 * across activation/rollback. The durable worker NEVER claims LEGACY jobs. */
export async function notifyLegacyDispatch(orderId: number) {
  try {
    const claim = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR NO KEY UPDATE`;
      const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { user: { select: { deletedAt: true } } } });
      const job = await tx.orderConfirmationJob.findFirst({ where: { orderId, type: 'DISPATCH_CONFIRMATION', deliveryRoute: 'LEGACY', state: 'PENDING' } });
      if (!job) return null;
      const parsed = dispatchSchema.safeParse(job.source);
      const reason = order.user.deletedAt ? 'ACCOUNT_DELETED' : order.status !== 'DISPATCHED' || order.cancelledAt ? 'DISPATCH_SUPERSEDED_BY_ORDER_STATE' : !parsed.success ? 'DISPATCH_DATA_INVALID' : null;
      if (reason) { await tx.orderConfirmationJob.update({ where: { id: job.id }, data: { state: 'SUPPRESSED', lastErrorCode: reason } }); return null; }
      const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      return tx.orderConfirmationJob.update({ where: { id: job.id }, data: { state: 'PROCESSING', attempts: { increment: 1 }, claimOwner: randomUUID(), claimGeneration: { increment: 1 }, sendStartedAt: row.now, leaseExpiresAt: new Date(row.now.getTime() + 120_000) } });
    });
    if (!claim) return;
    let state = 'SENT', diagnostic: string | null = null;
    try {
      const p = dispatchSchema.parse(claim.source);
      await sendDispatchNotification({ customerEmail: p.recipientEmail, orderId: p.orderId, shippingCarrier: p.carrierName, trackingNumber: p.trackingNumber, dispatchedAt: new Date(p.dispatchedAt) });
    } catch (error) {
      const rejection = classifySesError(error); state = rejection ? 'FAILED' : 'UNKNOWN'; diagnostic = rejection?.diagnostic ?? 'ACCEPTANCE_UNKNOWN';
      console.warn('Legacy dispatch notification unavailable; committed dispatch retained for operational review');
    }
    await prisma.orderConfirmationJob.updateMany({ where: { id: claim.id, state: 'PROCESSING', claimOwner: claim.claimOwner, claimGeneration: claim.claimGeneration },
      data: { state, lastErrorCode: diagnostic, ...(state === 'SENT' ? { sentAt: new Date() } : {}), claimOwner: null, leaseExpiresAt: null } });
  } catch { console.warn('Legacy dispatch notification unavailable; committed dispatch retained for operational review'); }
}
