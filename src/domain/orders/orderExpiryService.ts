import { hasBlockingOrderReturns, warnBlockedReturnReservation } from "./returnInventorySafety.js";
import { config } from "../../config/index.js";
import { attemptManagedRelease } from "../payments/paymentResolutionService.js";
import { queueCartReconciliation } from "../cart/cartProvenanceService.js";
import { prisma } from "../../prisma/runtime.js";
import { OrderStatus } from "../../generated/prisma-client/enums.js";
import { InsufficientReservedStockError } from "./orderCancellationErrors.js";

/**
 * Expire one PENDING order with no payment attempt and release its reservation. This operation
 * is intentionally trigger-agnostic; scheduling is handled separately.
 */
export async function expireOrderReservation(orderId: number, asOf = new Date()) {
  return prisma.$transaction(async (tx) => {
    // Use the same order-row lock as payment creation so the payment/expiry
    // decision is serialized across processes.
    await tx.$queryRaw<Array<{ id: number }>>`
      SELECT id
      FROM "Order"
      WHERE id = ${orderId}
      FOR UPDATE
    `;

    if (await hasBlockingOrderReturns(tx, orderId)) {
      await warnBlockedReturnReservation(tx, orderId, "EXPIRY");
      return null;
    }

    const resolution = await tx.paymentResolution.findUnique({ where: { orderId } });
    if (resolution) {
      if (resolution.historical || resolution.quarantineReason) return null;
      const released = await attemptManagedRelease(tx, orderId);
      return released ? tx.order.findUnique({ where: { id: orderId } }) : null;
    }
    if (config.PAYMENT_RESOLUTION_ENABLED) return null; // Missing ledger coverage is not reconstructed automatically.
    const claim = await tx.order.updateMany({
      where: {
        id: orderId,
        status: OrderStatus.PENDING,
        reservationExpiresAt: { not: null, lte: asOf },
        // No local status alone proves the provider attempt is resolved.
        // Retain reservations through failures, timeouts and delayed outcomes.
        payments: { none: {} },
      },
      data: {
        status: OrderStatus.EXPIRED,
        reservationExpiresAt: null,
      },
    });

    if (claim.count === 0) return null;

    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { productListingId: true, quantity: true },
    });
    for (const item of items.sort((a, b) => a.productListingId - b.productListingId)) {
      const release = await tx.productListing.updateMany({
        where: {
          id: item.productListingId,
          reservedStock: { gte: item.quantity },
        },
        data: { reservedStock: { decrement: item.quantity } },
      });
      if (release.count === 0) {
        throw new InsufficientReservedStockError(item.productListingId, item.quantity);
      }
    }

    await queueCartReconciliation(tx, orderId, false);
    return tx.order.findUnique({ where: { id: orderId } });
  });
}
