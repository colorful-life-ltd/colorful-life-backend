import { activePaidCancellation } from './paidCancellationState.js';
import {providerFinancialHold} from "../payments/providerFinancialGuard.js";
import { prisma } from '../../prisma/runtime.js';
import { lockRefundPayment, assertNoUnresolvedRefund, RefundIntentError, validClientRequestKey } from '../refunds/refundLifecycleService.js';
import { hasBlockingOrderReturns } from './returnInventorySafety.js';
/** Final stage after the audited cancellation fence and existing idempotent refund API.
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
        const prior = await tx.$queryRaw<Array<{ id: bigint; actorId: number; details: { reason: string; key: string } }>>`
            SELECT id,"actorId",details FROM "OperationalAudit" WHERE "orderId"=${orderId}
              AND kind='PAID_CANCELLATION_REQUESTED' AND details->>'key'=${key}`;
        if (prior.length) {
            if (prior[0].actorId !== actorId || prior[0].details.reason !== reason)
                throw new RefundIntentError('IDEMPOTENCY_CONFLICT');
            const active = await activePaidCancellation(tx, orderId);
            return { requested: true, replayed: true, requestId: String(prior[0].id), active: active?.id === prior[0].id };
        }
        if (await activePaidCancellation(tx, orderId)) throw new RefundIntentError('CANCELLATION_ALREADY_REQUESTED');
        const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
        if (order.status !== 'CONFIRMED' || order.dispatchedAt || await tx.shipment.count({ where: { orderId } }) || await hasBlockingOrderReturns(tx, orderId))
            throw new RefundIntentError('ORDER_NOT_CANCELLABLE');
        if (payment.status !== 'SUCCEEDED' || !payment.paidAt)
            throw new RefundIntentError('VERIFIED_PAYMENT_REQUIRED');
        const [request] = await tx.$queryRaw<Array<{ id: bigint }>>`INSERT INTO "OperationalAudit" (kind,"actorId","orderId",details)
            VALUES ('PAID_CANCELLATION_REQUESTED',${actorId},${orderId},${JSON.stringify({ reason, key })}::jsonb) RETURNING id`;
        return { requested: true, replayed: false, requestId: String(request.id), active: true };
    });
}

/** Withdraw only an exact active intent BEFORE any refund initiation. Order → Payment serializes
 * this decision with refund intents, fulfilment and competing cancellation generations. */
export async function withdrawPaidCancellation(actorId: number, orderId: number, requestId: string, reason: string, key: string) {
    if (!/^[1-9][0-9]{0,18}$/.test(requestId) || BigInt(requestId) > 9223372036854775807n
        || reason.trim().length < 10 || reason.length > 1000 || !validClientRequestKey(key))
        throw new RefundIntentError('INVALID_CANCELLATION', 400);
    return prisma.$transaction(async tx => {
        const actor = await tx.user.findUnique({ where: { id: actorId } });
        if (!actor || actor.deletedAt || actor.role !== 'ADMIN') throw new RefundIntentError('FORBIDDEN', 403);
        const candidate = await tx.payment.findUnique({ where: { orderId } });
        if (!candidate) throw new RefundIntentError('PAYMENT_NOT_FOUND', 404);
        const payment = await lockRefundPayment(tx, orderId, candidate.id);
        const prior = await tx.$queryRaw<Array<{ actorId: number; details: { key: string; reason: string; requestId: string } }>>`
            SELECT "actorId",details FROM "OperationalAudit" WHERE "orderId"=${orderId}
              AND kind='PAID_CANCELLATION_WITHDRAWN' AND details->>'key'=${key}`;
        if (prior.length) {
            if (prior[0].actorId !== actorId || prior[0].details.reason !== reason || prior[0].details.requestId !== requestId)
                throw new RefundIntentError('IDEMPOTENCY_CONFLICT');
            return { withdrawn: true, replayed: true, requestId };
        }
        const active = await activePaidCancellation(tx, orderId);
        if (!active || String(active.id) !== requestId) throw new RefundIntentError('CANCELLATION_VERSION_CONFLICT');
        const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
        if (order.status !== 'CONFIRMED' || order.dispatchedAt || await tx.shipment.count({ where: { orderId } }) || await hasBlockingOrderReturns(tx, orderId))
            throw new RefundIntentError('ORDER_NOT_CANCELLABLE');
        if (payment.status !== 'SUCCEEDED' || !payment.paidAt || !payment.amount.eq(order.totalAmount) || payment.currency !== 'GBP')
            throw new RefundIntentError('VERIFIED_PAYMENT_REQUIRED');
        // Even a failed refund proves initiation occurred; withdrawal is intentionally narrower than refund review.
        if (!payment.refundedAmount.isZero() || !payment.reservedRefundAmount.isZero() || await tx.refund.count({ where: { paymentId: payment.id } }))
            throw new RefundIntentError('REFUND_ALREADY_INITIATED');
        if (await providerFinancialHold(tx, payment)) throw new RefundIntentError('PAYMENT_PROVIDER_EVIDENCE_UNRESOLVED');
        await tx.$executeRaw`INSERT INTO "OperationalAudit" (kind,"actorId","orderId",details)
            VALUES ('PAID_CANCELLATION_WITHDRAWN',${actorId},${orderId},${JSON.stringify({ requestId, reason, key })}::jsonb)`;
        return { withdrawn: true, replayed: false, requestId };
    });
}
