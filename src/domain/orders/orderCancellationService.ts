import { queueCartReconciliation } from "../cart/cartProvenanceService.js";
import { prisma } from "../../prisma/runtime.js";
import {
  OrderStatus,
  CancellationInitiator,
  CancellationReason,
  PaymentStatus,
} from "../../generated/prisma-client/enums.js";
import {
  OrderNotFoundError,
  OrderCancellationPaymentError,
  OrderNotCancellableError,
  InsufficientReservedStockError,
} from "./orderCancellationErrors.js";

/**
 * Cancel an order for an authenticated customer.
 *
 * @param userId Authenticated user id.
 * @param orderId Order id to cancel.
 * @param reason Cancellation reason.
 * @returns Updated order record.
 * @throws OrderNotFoundError          if the order does not exist or does not belong to the user.
 * @throws OrderNotCancellableError    if the order is in a non‑cancellable state.
 */
export async function cancelOrder(
  userId: number,
  orderId: number,
  reason: CancellationReason,
 ) {
  const cancellableStatuses = [OrderStatus.PENDING, OrderStatus.CONFIRMED];

  const updatedOrder = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order || order.userId !== userId) {
      throw new OrderNotFoundError(orderId);
    }

    if ((order.status !== OrderStatus.PENDING && order.status !== OrderStatus.CONFIRMED) || order.cancelledAt) {
      throw new OrderNotCancellableError(orderId, order.status);
    }
    // Payment existence is checked under the same order lock as initiation.
    // Even FAILED/CANCELED attempts may be reused or have delayed provider I/O.
    const payment = await tx.payment.findUnique({ where: { orderId } });
    if (payment) throw new OrderCancellationPaymentError(payment.status === PaymentStatus.SUCCEEDED || payment.paidAt !== null, "customer");

    const updateResult = await tx.order.updateMany({
      where: {
        id: orderId,
        userId,
        status: { in: cancellableStatuses },
        cancelledAt: null,
      },
      data: {
        status: OrderStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledBy: CancellationInitiator.CUSTOMER,
        cancellationReason: reason,
        reservationExpiresAt: order.status === OrderStatus.PENDING ? null : undefined,
      },
    });

    if (updateResult.count === 0) {
      throw new OrderNotCancellableError(orderId, order.status);
    }

    if (order.status === OrderStatus.PENDING) {
      const orderItems = await tx.orderItem.findMany({ where: { orderId }, select: { productListingId: true, quantity: true } });
      for (const item of orderItems.sort((a, b) => a.productListingId - b.productListingId)) {
        const released = await tx.productListing.updateMany({
          where: { id: item.productListingId, reservedStock: { gte: item.quantity } },
          data: { reservedStock: { decrement: item.quantity } },
        });
        if (released.count === 0) throw new InsufficientReservedStockError(item.productListingId, item.quantity);
      }
    } else if (order.status === OrderStatus.CONFIRMED) {
      const orderItems = await tx.orderItem.findMany({
        where: { orderId },
        select: { productListingId: true, quantity: true, productListing: { select: { condition: true } } },
      });

      for (const item of orderItems.sort((a, b) => a.productListingId - b.productListingId)) {
        // A confirmed Used offer is terminal once consumed; a later cancellation
        // must not make that physical item sellable again.
        if (item.productListing.condition === "USED_LIKE_NEW") continue;
        await tx.productListing.update({
          where: { id: item.productListingId },
          data: { currentStock: { increment: item.quantity } },
        });
        await tx.inventoryMovement.create({
          data: {
            listingId: item.productListingId,
            quantityChange: item.quantity,
            type: "ORDER_CANCELLATION_RETURN",
            performedByUserId: userId,
            note: `Order ${orderId} cancellation return`,
          },
        });
      }
    }

    if (order.status === OrderStatus.PENDING) await queueCartReconciliation(tx, orderId, false);
    const updated = await tx.order.findUnique({ where: { id: orderId } });
    if (!updated) {
      throw new OrderNotFoundError(orderId);
    }
    return updated;
  });

  return updatedOrder;
 }
/**
 * Cancel an order by an ADMIN user.
 *
 * @param orderId Order id to cancel.
 * @param reason Cancellation reason.
 * @returns Updated order record.
 * @throws OrderNotFoundError          if the order does not exist.
 * @throws OrderNotCancellableError    if the order is in a non‑cancellable state.
 */
export async function cancelOrderByAdmin(
  orderId: number,
  reason: CancellationReason,
  adminUserId: number,
  ) {
  const cancellableStatuses = [OrderStatus.PENDING, OrderStatus.CONFIRMED];

  const updatedOrder = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const order = await tx.order.findUnique({ where: { id: orderId } });
    if (!order) {
      throw new OrderNotFoundError(orderId);
    }

    if (!cancellableStatuses.includes(order.status as "PENDING" | "CONFIRMED") || order.cancelledAt) {
      throw new OrderNotCancellableError(orderId, order.status);
    }
    // The order lock is shared with payment initiation and authoritative outcomes.
    // FAILED is retryable; placeholders and CANCELED attempts cannot be safely
    // cleared while initiation/retrieval or delayed notifications may be in flight.
    const payment = await tx.payment.findUnique({ where: { orderId } });
    if (payment) throw new OrderCancellationPaymentError(payment.status === PaymentStatus.SUCCEEDED || payment.paidAt !== null);

    const updateResult = await tx.order.updateMany({
      where: {
        id: orderId,
        status: { in: cancellableStatuses },
        cancelledAt: null,
      },
      data: {
        status: OrderStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledBy: CancellationInitiator.SELLER,
        cancellationReason: reason,
        reservationExpiresAt: order.status === OrderStatus.PENDING ? null : undefined,
      },
    });

    if (updateResult.count === 0) {
      throw new OrderNotCancellableError(orderId, order.status);
    }

    if (order.status === OrderStatus.PENDING) {
      const orderItems = await tx.orderItem.findMany({ where: { orderId }, select: { productListingId: true, quantity: true } });
      for (const item of orderItems.sort((a, b) => a.productListingId - b.productListingId)) {
        const released = await tx.productListing.updateMany({
          where: { id: item.productListingId, reservedStock: { gte: item.quantity } },
          data: { reservedStock: { decrement: item.quantity } },
        });
        if (released.count === 0) throw new InsufficientReservedStockError(item.productListingId, item.quantity);
      }
    } else if (order.status === OrderStatus.CONFIRMED) {
      const orderItems = await tx.orderItem.findMany({
        where: { orderId },
        select: { productListingId: true, quantity: true, productListing: { select: { condition: true } } },
      });

      for (const item of orderItems.sort((a, b) => a.productListingId - b.productListingId)) {
        if (item.productListing.condition === "USED_LIKE_NEW") continue;
        await tx.productListing.update({
          where: { id: item.productListingId },
          data: { currentStock: { increment: item.quantity } },
        });
        await tx.inventoryMovement.create({
          data: {
            listingId: item.productListingId,
            quantityChange: item.quantity,
            type: "ORDER_CANCELLATION_RETURN",
            performedByUserId: adminUserId,
            note: `Order ${orderId} cancellation return`,
          },
        });
      }
    }

    if (order.status === OrderStatus.PENDING) await queueCartReconciliation(tx, orderId, false);
    const updated = await tx.order.findUnique({ where: { id: orderId } });
    if (!updated) {
      throw new OrderNotFoundError(orderId);
    }
    return updated;
  });

  return updatedOrder;
}
