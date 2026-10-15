import { assertReturnInventoryEligible, lockReturnScope } from "./returnInventorySafety.js";
import { prisma } from "../../prisma/runtime.js";
import {
  ReturnReason,
  ReturnShippingPayer,
  ReturnCondition,
  OrderReturnStatus,
} from "../../generated/prisma-client/enums.js";

export class InvalidReturnQuantityError extends Error {
  constructor() {
    super("Return quantity must be a positive integer");
    this.name = "InvalidReturnQuantityError";
  }
}

export class InvalidReturnReasonError extends Error {
  constructor() {
    super("Return reason is invalid");
    this.name = "InvalidReturnReasonError";
  }
}

export class InvalidReturnShippingPayerError extends Error {
  constructor() {
    super("Return shipping payer is required");
    this.name = "InvalidReturnShippingPayerError";
  }
}

export class InvalidReturnShippingCostError extends Error {
  constructor() {
    super("Return shipping cost must be non-negative");
    this.name = "InvalidReturnShippingCostError";
  }
}

export class OrderNotFoundError extends Error {
  constructor(orderId: number) {
    super(`Order with id ${orderId} not found`);
    this.name = "OrderNotFoundError";
  }
}

export class OrderItemNotFoundError extends Error {
  constructor(orderItemId: number, orderId: number) {
    super(`Order item ${orderItemId} not found for order ${orderId}`);
    this.name = "OrderItemNotFoundError";
  }
}

export class OrderReturnQuantityExceededError extends Error {
  constructor(
    orderItemId: number,
    requestedQuantity: number,
    remainingQuantity: number,
  ) {
    super(
      `Cannot return ${requestedQuantity} units for order item ${orderItemId}; ` +
        `only ${remainingQuantity} remain returnable`,
    );
    this.name = "OrderReturnQuantityExceededError";
  }
}

export class ProductListingMissingError extends Error {
  constructor(productListingId: number) {
    super(`Product listing ${productListingId} not found`);
    this.name = "ProductListingMissingError";
  }
}

export class OrderReturnNotFoundError extends Error {
  constructor(returnId: number, orderId: number) {
    super(`Order return ${returnId} not found for order ${orderId}`);
    this.name = "OrderReturnNotFoundError";
  }
}

export class OrderReturnNotAuthorizableError extends Error {
  constructor(returnId: number, status: OrderReturnStatus) {
    super(
      `Order return ${returnId} cannot be authorized in its current status: ${status}`,
    );
    this.name = "OrderReturnNotAuthorizableError";
  }
}

export class OrderReturnNotReceivableError extends Error {
  constructor(returnId: number, status: OrderReturnStatus) {
    super(
      `Order return ${returnId} cannot be received in its current status: ${status}`,
    );
    this.name = "OrderReturnNotReceivableError";
  }
}

export class InvalidReturnConditionError extends Error {
  constructor() {
    super("Return condition is invalid");
    this.name = "InvalidReturnConditionError";
  }
}

export class InvalidInspectionRestockQuantityError extends Error {
  constructor() {
    super("Inspection restock quantity must be a non-negative integer");
    this.name = "InvalidInspectionRestockQuantityError";
  }
}

export class InvalidInspectionRestockConditionError extends Error {
  constructor() {
    super("Only AS_NEW returns may have a positive restock quantity");
    this.name = "InvalidInspectionRestockConditionError";
  }
}

export class OrderReturnNotInspectableError extends Error {
  constructor(returnId: number, status: OrderReturnStatus) {
    super(
      `Order return ${returnId} cannot be inspected in its current status: ${status}`,
    );
    this.name = "OrderReturnNotInspectableError";
  }
}

export class OrderReturnNotCompletableError extends Error {
  constructor(returnId: number, status: OrderReturnStatus) {
    super(
      `Order return ${returnId} cannot be completed in its current status: ${status}`,
    );
    this.name = "OrderReturnNotCompletableError";
  }
}

export class OrderReturnNotCancellableError extends Error {
  constructor(returnId: number, status: OrderReturnStatus) {
    super(
      `Order return ${returnId} cannot be cancelled in its current status: ${status}`,
    );
    this.name = "OrderReturnNotCancellableError";
  }
}

export async function requestOrderReturn(
  orderId: number,
  orderItemId: number,
  quantity: number,
  reason: ReturnReason,
  reasonNote: string | undefined,
  shippingPayer: ReturnShippingPayer,
  returnShippingCost: number | undefined,
  performedByUserId: number,
) {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new InvalidReturnQuantityError();
  }

  if (!Object.values(ReturnReason).includes(reason)) {
    throw new InvalidReturnReasonError();
  }

  if (!Object.values(ReturnShippingPayer).includes(shippingPayer)) {
    throw new InvalidReturnShippingPayerError();
  }

  if (
    returnShippingCost !== undefined &&
    (!Number.isFinite(returnShippingCost) || returnShippingCost < 0)
  ) {
    throw new InvalidReturnShippingCostError();
  }

  return prisma.$transaction(async (tx) => {
    await lockReturnScope(tx, orderId);
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });

    if (!order) {
      throw new OrderNotFoundError(orderId);
    }

    const orderItem = await tx.orderItem.findFirst({
      where: {
        id: orderItemId,
        orderId,
      },
      include: { productListing: true },
    });

    if (!orderItem) {
      throw new OrderItemNotFoundError(orderItemId, orderId);
    }

    await tx.$queryRaw`SELECT id FROM "OrderItem" WHERE id=${orderItem.id} FOR UPDATE`;
    await assertReturnInventoryEligible(tx, orderId, orderItem.id);

    const reservationResult = await tx.$executeRaw`
      UPDATE "OrderItem"
      SET "reservedReturnQuantity" = "reservedReturnQuantity" + ${quantity}
      WHERE id = ${orderItem.id}
        AND "orderId" = ${orderId}
        AND "reservedReturnQuantity" <= "quantity" - "returnedQuantity" - ${quantity}
    `;

    if (reservationResult === 0) {
      const latest = await tx.orderItem.findUnique({
        where: { id: orderItem.id },
        select: { quantity: true, returnedQuantity: true, reservedReturnQuantity: true },
      });
      throw new OrderReturnQuantityExceededError(
        orderItemId,
        quantity,
        Math.max(0, (latest?.quantity ?? orderItem.quantity) - (latest?.returnedQuantity ?? orderItem.returnedQuantity) - (latest?.reservedReturnQuantity ?? orderItem.reservedReturnQuantity)),
      );
    }

    return tx.orderReturn.create({
      data: {
        orderItemId,
        quantity,
        reason,
        reasonNote: reasonNote?.trim() || undefined,
        status: OrderReturnStatus.REQUESTED,
        restockQuantity: 0,
        shippingPayer,
        returnShippingCost,
        performedByUserId,
      },
    });
  });
}

export async function cancelOrderReturn(orderId: number, returnId: number) {
  return prisma.$transaction(async (tx) => {
    await lockReturnScope(tx, orderId, returnId);
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) throw new OrderNotFoundError(orderId);

    const orderReturn = await tx.orderReturn.findFirst({
      where: { id: returnId, orderItem: { orderId } },
      select: { id: true, quantity: true, status: true, orderItemId: true },
    });
    if (!orderReturn) throw new OrderReturnNotFoundError(returnId, orderId);

    const cancelledAt = new Date();
    const claimResult = await tx.orderReturn.updateMany({
      where: {
        id: returnId,
        status: OrderReturnStatus.REQUESTED,
        orderItem: { orderId },
      },
      data: { status: OrderReturnStatus.CANCELLED, cancelledAt },
    });
    if (claimResult.count === 0) {
      const latest = await tx.orderReturn.findFirst({
        where: { id: returnId, orderItem: { orderId } },
        select: { status: true },
      });
      if (!latest) throw new OrderReturnNotFoundError(returnId, orderId);
      throw new OrderReturnNotCancellableError(returnId, latest.status);
    }

    const releaseResult = await tx.orderItem.updateMany({
      where: {
        id: orderReturn.orderItemId,
        orderId,
        reservedReturnQuantity: { gte: orderReturn.quantity },
      },
      data: { reservedReturnQuantity: { decrement: orderReturn.quantity } },
    });
    if (releaseResult.count === 0) {
      throw new OrderReturnQuantityExceededError(orderReturn.orderItemId, orderReturn.quantity, 0);
    }

    return tx.orderReturn.findFirstOrThrow({ where: { id: returnId, orderItem: { orderId } } });
  });
}

export async function authorizeOrderReturn(
  orderId: number,
  returnId: number,
) {
  return prisma.$transaction(async (tx) => {
    await lockReturnScope(tx, orderId, returnId);
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });

    if (!order) {
      throw new OrderNotFoundError(orderId);
    }

    const orderReturn = await tx.orderReturn.findFirst({
      where: {
        id: returnId,
        orderItem: {
          orderId,
        },
      },
    });

    if (!orderReturn) {
      throw new OrderReturnNotFoundError(returnId, orderId);
    }

    const authorizedAt = new Date();
    const updateResult = await tx.orderReturn.updateMany({
      where: {
        id: returnId,
        status: OrderReturnStatus.REQUESTED,
        orderItem: {
          orderId,
        },
      },
      data: {
        status: OrderReturnStatus.AUTHORIZED,
        authorizedAt,
      },
    });

    if (updateResult.count === 0) {
      const latest = await tx.orderReturn.findFirst({
        where: {
          id: returnId,
          orderItem: {
            orderId,
          },
        },
        select: {
          status: true,
        },
      });

      if (!latest) {
        throw new OrderReturnNotFoundError(returnId, orderId);
      }

      throw new OrderReturnNotAuthorizableError(returnId, latest.status);
    }

    return tx.orderReturn.findFirstOrThrow({
      where: {
        id: returnId,
        orderItem: {
          orderId,
        },
      },
    });
  });
}

export async function receiveOrderReturn(
  orderId: number,
  returnId: number,
) {
  return prisma.$transaction(async (tx) => {
    await lockReturnScope(tx, orderId, returnId);
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });

    if (!order) {
      throw new OrderNotFoundError(orderId);
    }

    const orderReturn = await tx.orderReturn.findFirst({
      where: {
        id: returnId,
        orderItem: {
          orderId,
        },
      },
    });

    if (!orderReturn) {
      throw new OrderReturnNotFoundError(returnId, orderId);
    }

    const receivedAt = new Date();
    const updateResult = await tx.orderReturn.updateMany({
      where: {
        id: returnId,
        status: OrderReturnStatus.AUTHORIZED,
        orderItem: {
          orderId,
        },
      },
      data: {
        status: OrderReturnStatus.RECEIVED,
        receivedAt,
      },
    });

    if (updateResult.count === 0) {
      const latest = await tx.orderReturn.findFirst({
        where: {
          id: returnId,
          orderItem: {
            orderId,
          },
        },
        select: {
          status: true,
        },
      });

      if (!latest) {
        throw new OrderReturnNotFoundError(returnId, orderId);
      }

      throw new OrderReturnNotReceivableError(returnId, latest.status);
    }

    return tx.orderReturn.findFirstOrThrow({
      where: {
        id: returnId,
        orderItem: {
          orderId,
        },
      },
    });
  });
}

export async function inspectOrderReturn(
  orderId: number,
  returnId: number,
  condition: ReturnCondition,
  restockQuantity: number,
  inspectionNote: string | undefined,
  inspectedByUserId: number,
) {
  if (!Object.values(ReturnCondition).includes(condition)) {
    throw new InvalidReturnConditionError();
  }

  if (!Number.isInteger(restockQuantity) || restockQuantity < 0) {
    throw new InvalidInspectionRestockQuantityError();
  }

  if (condition !== ReturnCondition.AS_NEW && restockQuantity !== 0) {
    throw new InvalidInspectionRestockConditionError();
  }

  return prisma.$transaction(async (tx) => {
    await lockReturnScope(tx, orderId, returnId);
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });

    if (!order) {
      throw new OrderNotFoundError(orderId);
    }

    const orderReturn = await tx.orderReturn.findFirst({
      where: {
        id: returnId,
        orderItem: {
          orderId,
        },
      },
      select: {
        quantity: true,
        orderItem: { select: { productListing: { select: { condition: true } } } },
      },
    });

    if (!orderReturn) {
      throw new OrderReturnNotFoundError(returnId, orderId);
    }
    if (restockQuantity > 0 && orderReturn.orderItem.productListing.condition === "USED_LIKE_NEW") {
      throw new InvalidInspectionRestockConditionError();
    }

    if (restockQuantity > orderReturn.quantity) {
      throw new InvalidInspectionRestockQuantityError();
    }

    const inspectedAt = new Date();
    const updateResult = await tx.orderReturn.updateMany({
      where: {
        id: returnId,
        status: OrderReturnStatus.RECEIVED,
        orderItem: {
          orderId,
        },
      },
      data: {
        status: OrderReturnStatus.INSPECTED,
        condition,
        restockQuantity,
        inspectionNote: inspectionNote?.trim() || undefined,
        inspectedAt,
        inspectedByUserId,
      },
    });

    if (updateResult.count === 0) {
      const latest = await tx.orderReturn.findFirst({
        where: {
          id: returnId,
          orderItem: {
            orderId,
          },
        },
        select: {
          status: true,
        },
      });

      if (!latest) {
        throw new OrderReturnNotFoundError(returnId, orderId);
      }

      throw new OrderReturnNotInspectableError(returnId, latest.status);
    }

    return tx.orderReturn.findFirstOrThrow({
      where: {
        id: returnId,
        orderItem: {
          orderId,
        },
      },
    });
  });
}

export async function completeOrderReturn(
  orderId: number,
  returnId: number,
  performedByUserId: number,
) {
  return prisma.$transaction(async (tx) => {
    await lockReturnScope(tx, orderId, returnId);
    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });

    if (!order) {
      throw new OrderNotFoundError(orderId);
    }

    const orderReturn = await tx.orderReturn.findFirst({
      where: {
        id: returnId,
        orderItem: {
          orderId,
        },
      },
      include: {
        orderItem: {
          include: {
            productListing: true,
          },
        },
      },
    });

    if (!orderReturn) {
      throw new OrderReturnNotFoundError(returnId, orderId);
    }

    if (orderReturn.status !== OrderReturnStatus.INSPECTED) {
      throw new OrderReturnNotCompletableError(returnId, orderReturn.status);
    }

    const orderItem = orderReturn.orderItem;
    const listing = orderItem.productListing;
    if (!listing) {
      throw new ProductListingMissingError(orderItem.productListingId);
    }
    if (listing.condition === "USED_LIKE_NEW" && orderReturn.restockQuantity > 0) {
      throw new InvalidInspectionRestockConditionError();
    }

    await assertReturnInventoryEligible(tx, orderId, orderItem.id);
    if (!Number.isInteger(orderReturn.quantity) || orderReturn.quantity <= 0
      || !Number.isInteger(orderReturn.restockQuantity) || orderReturn.restockQuantity < 0 || orderReturn.restockQuantity > orderReturn.quantity) throw new InvalidInspectionRestockQuantityError();
    if (orderReturn.restockQuantity > 0 && orderReturn.condition !== "AS_NEW") throw new InvalidInspectionRestockConditionError();

    const claimResult = await tx.$executeRaw`
      UPDATE "OrderItem"
      SET "returnedQuantity" = "returnedQuantity" + ${orderReturn.quantity},
          "reservedReturnQuantity" = "reservedReturnQuantity" - ${orderReturn.quantity}
      WHERE id = ${orderItem.id}
        AND "orderId" = ${orderId}
        AND "reservedReturnQuantity" >= ${orderReturn.quantity}
        AND "returnedQuantity" + ${orderReturn.quantity} <= "quantity"
    `;

    if (claimResult === 0) {
      const latestReturn = await tx.orderReturn.findFirst({
        where: {
          id: returnId,
          orderItem: {
            orderId,
          },
        },
        select: {
          status: true,
          quantity: true,
          orderItem: {
            select: {
              quantity: true,
              returnedQuantity: true,
              reservedReturnQuantity: true,
            },
          },
        },
      });

      if (!latestReturn) {
        throw new OrderReturnNotFoundError(returnId, orderId);
      }

      if (latestReturn.status !== OrderReturnStatus.INSPECTED) {
        throw new OrderReturnNotCompletableError(returnId, latestReturn.status);
      }

      throw new OrderReturnQuantityExceededError(
        orderItem.id,
        latestReturn.quantity,
        latestReturn.orderItem.quantity - latestReturn.orderItem.returnedQuantity - latestReturn.orderItem.reservedReturnQuantity,
      );
    }

    if (orderReturn.restockQuantity > 0) {
      await tx.productListing.update({
        where: { id: listing.id },
        data: {
          currentStock: {
            increment: orderReturn.restockQuantity,
          },
        },
      });

      await tx.inventoryMovement.create({
        data: {
          listingId: listing.id,
          quantityChange: orderReturn.restockQuantity,
          type: "ORDER_RETURN",
          performedByUserId,
          note: `Completed order return ${returnId}`,
        },
      });
    }

    const completedAt = new Date();
    const completionResult = await tx.orderReturn.updateMany({
      where: {
        id: returnId,
        status: OrderReturnStatus.INSPECTED,
        orderItem: {
          orderId,
        },
      },
      data: {
        status: OrderReturnStatus.COMPLETED,
        completedAt,
      },
    });

    if (completionResult.count === 0) {
      const latest = await tx.orderReturn.findFirst({
        where: {
          id: returnId,
          orderItem: {
            orderId,
          },
        },
        select: {
          status: true,
        },
      });

      if (!latest) {
        throw new OrderReturnNotFoundError(returnId, orderId);
      }

      throw new OrderReturnNotCompletableError(returnId, latest.status);
    }

    return tx.orderReturn.findFirstOrThrow({
      where: {
        id: returnId,
        orderItem: {
          orderId,
        },
      },
    });
  });
}
