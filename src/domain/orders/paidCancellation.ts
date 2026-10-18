import {providerFinancialHold} from "../payments/providerFinancialGuard.js";
import { prisma } from '../../prisma/runtime.js';
import { lockRefundPayment, assertNoUnresolvedRefund, RefundIntentError, validClientRequestKey } from '../refunds/refundLifecycleService.js';
import { hasBlockingOrderReturns } from './returnInventorySafety.js';
/** Stage two of cancellation: stage one is the existing idempotent refund API.
 * No network I/O; never restores stock until the whole paid amount is finalized. */
export async function cancelFullyRefundedOrder(actorId: number, orderId: number, reason: string, key: string) {
    if (reason.trim().length < 10 || reason.length > 1000 || !validClientRequestKey(key))
        throw new RefundIntentError('INVALID_CANCELLATION', 400);
    return prisma.$transaction(async (tx) => {
        const actor = await tx.user.findUnique({ where: { id: actorId } });
        if (!actor || actor.deletedAt || actor.role !== 'ADMIN')
            throw new RefundIntentError('FORBIDDEN', 403);
        const candidate = await tx.payment.findUnique({ where: { orderId } });
        if (!candidate)
            throw new RefundIntentError('PAYMENT_NOT_FOUND', 404);
        const payment = await lockRefundPayment(tx, orderId, candidate.id);
        const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { orderItems: true } });
        const prior = await tx.$queryRaw<Array<{
            details: {
                reason: string;
                key: string;
            };
        }>> `SELECT details FROM "OperationalAudit" WHERE "orderId"=${orderId} AND kind='PAID_ORDER_CANCELLED'`;
        if (prior.length) {
            if (prior[0].details.key !== key || prior[0].details.reason !== reason)
                throw new RefundIntentError('IDEMPOTENCY_CONFLICT');
            return { cancelled: true, replayed: true };
        }
        if (order.status !== 'CONFIRMED' || order.dispatchedAt || await tx.shipment.count({ where: { orderId } }) || await hasBlockingOrderReturns(tx, orderId))
            throw new RefundIntentError('ORDER_NOT_CANCELLABLE');
        await assertNoUnresolvedRefund(tx, payment.id);
        if (payment.status !== 'SUCCEEDED' || !payment.paidAt || !payment.refundedAmount.eq(payment.amount) || !payment.reservedRefundAmount.isZero())
            throw new RefundIntentError('FULL_REFUND_REQUIRED');
        if(await providerFinancialHold(tx,payment))throw new RefundIntentError('PAYMENT_PROVIDER_EVIDENCE_UNRESOLVED');
    for (const item of order.orderItems.sort((a, b) => a.productListingId - b.productListingId)) {
            await tx.$queryRaw `SELECT id FROM "ProductListing" WHERE id=${item.productListingId} FOR UPDATE`;
            const listing = await tx.productListing.findUniqueOrThrow({ where: { id: item.productListingId } });
            // Existing policy: consumed Used offers require the documented inspection/return workflow.
            if (listing.condition !== 'NEW')
                throw new RefundIntentError('USED_RETURN_INSPECTION_REQUIRED');
            await tx.productListing.update({ where: { id: listing.id }, data: { currentStock: { increment: item.quantity } } });
            await tx.inventoryMovement.create({ data: { listingId: listing.id, quantityChange: item.quantity, type: 'ORDER_CANCELLATION_RETURN', performedByUserId: actorId, note: `Fully refunded order ${orderId}: ${reason}` } });
        }
        await tx.order.update({ where: { id: orderId }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: 'SELLER', cancellationReason: 'OTHER' } });
        await tx.$executeRaw `INSERT INTO "OperationalAudit" (kind,"actorId","orderId",details) VALUES ('PAID_ORDER_CANCELLED',${actorId},${orderId},${JSON.stringify({ reason, key })}::jsonb)`;
        return { cancelled: true, replayed: false };
    });
}
/** Fence dispatch before the operator invokes the existing refund API. */
export async function requestPaidCancellation(actorId: number, orderId: number, reason: string, key: string) {
    if (reason.trim().length < 10 || reason.length > 1000 || !validClientRequestKey(key))
        throw new RefundIntentError('INVALID_CANCELLATION', 400);
    return prisma.$transaction(async (tx) => {
        const actor = await tx.user.findUnique({ where: { id: actorId } });
        if (!actor || actor.deletedAt || actor.role !== 'ADMIN')
            throw new RefundIntentError('FORBIDDEN', 403);
        const candidate = await tx.payment.findUnique({ where: { orderId } });
        if (!candidate)
            throw new RefundIntentError('PAYMENT_NOT_FOUND', 404);
        const payment = await lockRefundPayment(tx, orderId, candidate.id);
        const prior = await tx.$queryRaw<Array<{
            details: {
                reason: string;
                key: string;
            };
        }>> `SELECT details FROM "OperationalAudit" WHERE "orderId"=${orderId} AND kind='PAID_CANCELLATION_REQUESTED'`;
        if (prior.length) {
            if (prior[0].details.reason !== reason || prior[0].details.key !== key)
                throw new RefundIntentError('IDEMPOTENCY_CONFLICT');
            return { requested: true, replayed: true };
        }
        const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
        if (order.status !== 'CONFIRMED' || order.dispatchedAt || await tx.shipment.count({ where: { orderId } }) || await hasBlockingOrderReturns(tx, orderId))
            throw new RefundIntentError('ORDER_NOT_CANCELLABLE');
        if (payment.status !== 'SUCCEEDED' || !payment.paidAt)
            throw new RefundIntentError('VERIFIED_PAYMENT_REQUIRED');
        await tx.$executeRaw `INSERT INTO "OperationalAudit" (kind,"actorId","orderId",details) VALUES ('PAID_CANCELLATION_REQUESTED',${actorId},${orderId},${JSON.stringify({ reason, key })}::jsonb)`;
        return { requested: true, replayed: false };
    });
}
