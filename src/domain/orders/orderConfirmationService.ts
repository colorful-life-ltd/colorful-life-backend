import {assertListingCommitmentAllowed} from "../inventory/inventoryDiscrepancy.js";
import { managedResolution, markManagedConsumed } from "../payments/paymentResolutionService.js";
import { queueCartReconciliation } from "../cart/cartProvenanceService.js";
import type { Prisma } from "../../generated/prisma-client/client.js";
import { prisma } from "../../prisma/runtime.js";
import { OrderStatus, InventoryMovementType } from "../../generated/prisma-client/enums.js";
import {
  OrderNotFoundError,
  OrderNotConfirmableError,
  InsufficientStockError,
  ProductListingNotFoundError,
} from "./orderConfirmationErrors.js";

/** ADMIN authorization remains in the HTTP handler; this wrapper owns a transaction. */
export async function confirmOrder(performedByUserId: number, orderId: number) {
  return prisma.$transaction((tx) => confirmOrderInTransaction(tx, performedByUserId, orderId));
}

/** Shared atomic reservation conversion, callable by authoritative reconciliation. */
export async function confirmOrderInTransaction(tx: Prisma.TransactionClient, performedByUserId: number, orderId: number) {
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
  // Load order and its items.
  const order = await tx.order.findUnique({
    where: { id: orderId },
    include: { orderItems: true },
  });

  if (!order) {
    throw new OrderNotFoundError(orderId);
  }

  if (order.status !== OrderStatus.PENDING) {
    throw new OrderNotConfirmableError(orderId, order.status);
  }

  const managed = await managedResolution(tx, orderId);
  await tx.$queryRaw`SELECT id FROM "Payment" WHERE "orderId"=${orderId} FOR UPDATE`;
  {
    const paid = await tx.payment.findUnique({ where: { orderId } });
    if (!paid || paid.status !== "SUCCEEDED" || !paid.paidAt || !paid.amount.eq(order.totalAmount) || paid.currency!=="GBP") throw new OrderNotConfirmableError(orderId, order.status);
  }
  // Validate stock and perform deductions
  for (const item of [...order.orderItems].sort((a, b) => a.productListingId - b.productListingId)) {
    await tx.$queryRaw`SELECT id FROM "ProductListing" WHERE id = ${item.productListingId} FOR UPDATE`;
    await assertListingCommitmentAllowed(tx,item.productListingId);
    const conversionResult = await tx.$executeRaw`
      UPDATE "ProductListing"
      SET "currentStock" = "currentStock" - ${item.quantity},
          "reservedStock" = "reservedStock" - ${item.quantity},
          "usedLifecycle" = CASE WHEN "condition" = 'USED_LIKE_NEW' THEN 'SOLD'::"UsedOfferLifecycle" ELSE "usedLifecycle" END
      WHERE id = ${item.productListingId}
        AND "currentStock" >= ${item.quantity}
        AND "reservedStock" >= ${item.quantity}
        AND (${!managed} OR "reservedStock" >= (
          SELECT COALESCE(SUM(oi.quantity), 0) FROM "OrderItem" oi
          JOIN "PaymentResolution" r ON r."orderId" = oi."orderId"
          WHERE oi."productListingId" = ${item.productListingId} AND r."reservationDisposition" = 'HELD'
        ))
        AND ("condition" = 'NEW' OR ("condition" = 'USED_LIKE_NEW' AND "usedLifecycle" = 'AVAILABLE' AND ${item.quantity} = 1))
    `;
    if (conversionResult === 0) {
      const listing = await tx.productListing.findUnique({ where: { id: item.productListingId }, select: { currentStock: true } });
      if (!listing) throw new ProductListingNotFoundError(item.productListingId);
      throw new InsufficientStockError(item.productListingId, listing.currentStock, item.quantity);
    }
    // Create inventory movement
    await tx.inventoryMovement.create({
      data: {
        listingId: item.productListingId,
        quantityChange: -item.quantity,
        type: InventoryMovementType.WEBSITE_SALE,
        performedByUserId,
        note: `Order ${orderId} sale`,
      },
    });
  }

  // Update order status to CONFIRMED
  const updatedOrder = await tx.order.update({
    where: { id: orderId, status: OrderStatus.PENDING },
    data: { status: OrderStatus.CONFIRMED, reservationExpiresAt: null },
  });
  await markManagedConsumed(tx, orderId);
  await queueCartReconciliation(tx, orderId, true);
  return updatedOrder;
}
