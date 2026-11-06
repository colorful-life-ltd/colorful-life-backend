import { dispatchOrder } from "../domain/orders/orderDispatchService.js";
import { recordVerifiedPayment } from "./fixtures/verifiedPayment.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { Decimal } from "@prisma/client/runtime/client";
import { prisma } from "../prisma/runtime.js";
import { createOrder } from "../domain/orders/orderService.js";
import {
  InvalidReturnQuantityError,
  InvalidReturnReasonError,
  InvalidReturnShippingPayerError,
  InvalidReturnShippingCostError,
  OrderItemNotFoundError,
  OrderNotFoundError,
  OrderReturnNotAuthorizableError,
  OrderReturnNotFoundError,
  OrderReturnNotReceivableError,
  InvalidReturnConditionError,
  InvalidInspectionRestockQuantityError,
  InvalidInspectionRestockConditionError,
  OrderReturnNotInspectableError,
  OrderReturnNotCompletableError,
  OrderReturnNotCancellableError,
  OrderReturnQuantityExceededError,
  cancelOrderReturn,
  authorizeOrderReturn,
  inspectOrderReturn,
  completeOrderReturn,
  receiveOrderReturn,
  requestOrderReturn,
} from "../domain/orders/orderReturnService.js";
import {
  InventoryMovementType,
  OrderReturnStatus,
  PaymentProvider,
  PaymentStatus,
  ReturnReason,
  ReturnShippingPayer,
  ReturnCondition,
} from "../generated/prisma-client/enums.js";

const userIds: number[] = [];
const legoProductIds: number[] = [];
const listingIds: number[] = [];
const orderIds: number[] = [];
const paymentIds: number[] = [];
const returnIds: number[] = [];

async function createCustomer() {
  const user = await prisma.user.create({
    data: {
      email: `return-${randomUUID()}@example.com`,
      passwordHash: "hashed",
      emailVerified: true,
      role: "CUSTOMER",
      addresses: {
        create: {
          recipientName: "Return Test User",
          line1: "1 Test Street",
          city: "Testville",
          postcode: "TEST1",
          countryCode: "GB",
          isDefaultBilling: true,
        },
      },
    },
  });
  userIds.push(user.id);
  return user;
}

async function createListing() {
  const product = await prisma.legoProduct.create({
    data: {
      setNumber: `RETURN-${randomUUID()}`,
      title: "Return Test Product",
      theme: "TEST",
      ageRecommendation: "8+",
      pieceCount: 100,
      productListings: {
        create: {

          condition: "NEW",
          originalPrice: new Decimal("20.00"),
          salePrice: new Decimal("15.00"),
          currentStock: 10,
          active: true,
        },
      },
    },
    include: { productListings: true },
  });
  legoProductIds.push(product.id);
  listingIds.push(product.productListings[0].id);
  return product.productListings[0];
}

async function createFixture(quantity = 3) {
  const customer = await createCustomer();
  const listing = await createListing();
  const order = await createOrder(customer.id, { shippingMethod: "STANDARD" as const,
    items: [{ productListingId: listing.id, quantity }],
  });
  await recordVerifiedPayment(order.id);
  await confirmOrder(customer.id, order.id);
  await dispatchOrder(order.id,0,"Royal Mail","AB123456789GB",customer.id);
  orderIds.push(order.id);
  return { customer, listing, order, orderItem: order.orderItems[0] };
}

async function requestReturn(
  orderId: number,
  orderItemId: number,
  quantity: number,
  performedByUserId: number,
  reason: ReturnReason = ReturnReason.CHANGE_OF_MIND,
  reasonNote?: string,
  shippingPayer: ReturnShippingPayer = ReturnShippingPayer.CUSTOMER,
  returnShippingCost?: number,
) {
  const result = await requestOrderReturn(
    orderId,
    orderItemId,
    quantity,
    reason,
    reasonNote,
    shippingPayer,
    returnShippingCost,
    performedByUserId,
  );
  returnIds.push(result.id);
  return result;
}

async function createReceivedReturn(
  orderId: number,
  orderItemId: number,
  performedByUserId: number,
  quantity = 2,
) {
  const requested = await requestReturn(
    orderId,
    orderItemId,
    quantity,
    performedByUserId,
  );
  await authorizeOrderReturn(orderId, requested.id);
  return receiveOrderReturn(orderId, requested.id);
}

async function createInspectedReturn(orderId: number, orderItemId: number, userId: number, quantity = 1, restockQuantity = 1) {
  const received = await createReceivedReturn(orderId, orderItemId, userId, quantity);
  return inspectOrderReturn(orderId, received.id, ReturnCondition.AS_NEW, restockQuantity, "Inspection passed", userId);
}

describe("Order return domain service", () => {
  afterEach(async () => {
    if (returnIds.length) {
      await prisma.orderReturn.deleteMany({ where: { id: { in: returnIds } } });
      returnIds.length = 0;
    }
    if (paymentIds.length) {
      await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
      paymentIds.length = 0;
    }
    if (orderIds.length) {
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      orderIds.length = 0;
    }
    if (listingIds.length) {
      await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listingIds } } });
      await prisma.productListing.updateMany({ where: { id: { in: listingIds } }, data: { reservedStock: 0 } });
      await prisma.productListing.deleteMany({ where: { id: { in: listingIds } } });
      listingIds.length = 0;
    }
    if (legoProductIds.length) {
      await prisma.legoProduct.deleteMany({ where: { id: { in: legoProductIds } } });
      legoProductIds.length = 0;
    }
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      userIds.length = 0;
    }
  });

  it("creates a REQUESTED return with lifecycle and request fields", async () => {
    const { customer, order, orderItem } = await createFixture(3);
    const result = await requestReturn(order.id, orderItem.id, 2, customer.id, ReturnReason.DAMAGED, "Box damaged on arrival", ReturnShippingPayer.SELLER, 4.5);
    assert.strictEqual(result.status, "REQUESTED");
    assert.strictEqual(result.quantity, 2);
    assert.strictEqual(result.reason, ReturnReason.DAMAGED);
    assert.strictEqual(result.reasonNote, "Box damaged on arrival");
    assert.strictEqual(result.shippingPayer, ReturnShippingPayer.SELLER);
    assert.strictEqual(String(result.returnShippingCost), "4.5");
    assert.strictEqual(result.restockQuantity, 0);
    assert.strictEqual(result.performedByUserId, customer.id);
    assert.ok(result.requestedAt instanceof Date);
    assert.strictEqual(result.receivedAt, null);
    assert.strictEqual(result.inspectedAt, null);
    assert.strictEqual(result.completedAt, null);
  });

  it("creates an optional-fields request when reasonNote and returnShippingCost are omitted", async () => {
    const { customer, order, orderItem } = await createFixture();
    const result = await requestReturn(order.id, orderItem.id, 1, customer.id, ReturnReason.OTHER);
    assert.strictEqual(result.reasonNote, null);
    assert.strictEqual(result.returnShippingCost, null);
  });

  it("has no side effects at REQUESTED", async () => {
    const { customer, listing, order, orderItem } = await createFixture();
    const itemBefore = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingBefore = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderBefore = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentBefore = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsBefore = await prisma.inventoryMovement.findMany({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    await requestReturn(order.id, orderItem.id, 1, customer.id);
    const itemAfter = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingAfter = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderAfter = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentAfter = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsAfter = await prisma.inventoryMovement.findMany({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    assert.strictEqual(itemAfter?.returnedQuantity, itemBefore?.returnedQuantity);
    assert.strictEqual(listingAfter?.currentStock, listingBefore?.currentStock);
    assert.strictEqual(orderAfter?.status, orderBefore?.status);
    assert.deepStrictEqual(paymentAfter, paymentBefore);
    assert.deepStrictEqual(movementsAfter, movementsBefore);
  });

  it("rejects zero, negative, and non-integer quantities", async () => {
    const { customer, order, orderItem } = await createFixture();
    for (const quantity of [0, -1, 1.5]) {
      await assert.rejects(requestOrderReturn(order.id, orderItem.id, quantity, ReturnReason.OTHER, undefined, ReturnShippingPayer.CUSTOMER, undefined, customer.id), InvalidReturnQuantityError);
    }
  });

  it("rejects quantities greater than the original order-item quantity", async () => {
    const { customer, order, orderItem } = await createFixture();
    await assert.rejects(requestOrderReturn(order.id, orderItem.id, orderItem.quantity + 1, ReturnReason.OTHER, undefined, ReturnShippingPayer.CUSTOMER, undefined, customer.id), OrderReturnQuantityExceededError);
  });

  it("rejects invalid reason, missing shipping payer, and negative shipping cost at the service boundary", async () => {
    const { customer, order, orderItem } = await createFixture();
    await assert.rejects(requestOrderReturn(order.id, orderItem.id, 1, "INVALID_REASON" as ReturnReason, undefined, ReturnShippingPayer.CUSTOMER, undefined, customer.id), InvalidReturnReasonError);
    await assert.rejects(requestOrderReturn(order.id, orderItem.id, 1, ReturnReason.OTHER, undefined, undefined as unknown as ReturnShippingPayer, undefined, customer.id), InvalidReturnShippingPayerError);
    await assert.rejects(requestOrderReturn(order.id, orderItem.id, 1, ReturnReason.OTHER, undefined, ReturnShippingPayer.CUSTOMER, -1, customer.id), InvalidReturnShippingCostError);
  });

  it("rejects a missing order", async () => {
    const { customer, orderItem } = await createFixture();
    await assert.rejects(requestOrderReturn(999999999, orderItem.id, 1, ReturnReason.OTHER, undefined, ReturnShippingPayer.CUSTOMER, undefined, customer.id), OrderNotFoundError);
  });

  it("rejects a missing order item", async () => {
    const { customer, order } = await createFixture();
    await assert.rejects(requestOrderReturn(order.id, 999999999, 1, ReturnReason.OTHER, undefined, ReturnShippingPayer.CUSTOMER, undefined, customer.id), OrderItemNotFoundError);
  });

  it("rejects an order item belonging to another order", async () => {
    const first = await createFixture();
    const second = await createFixture();
    await assert.rejects(requestOrderReturn(first.order.id, second.orderItem.id, 1, ReturnReason.OTHER, undefined, ReturnShippingPayer.CUSTOMER, undefined, first.customer.id), OrderItemNotFoundError);
  });

  it("authorizes a REQUESTED return without changing business side effects", async () => {
    const { customer, listing, order, orderItem } = await createFixture(3);
    const requested = await requestReturn(order.id, orderItem.id, 2, customer.id, ReturnReason.DAMAGED, "Damaged packaging", ReturnShippingPayer.SELLER, 4.5);
    const payment = await prisma.payment.findUniqueOrThrow({where:{orderId:order.id}});
    paymentIds.push(payment.id);
    const itemBefore = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingBefore = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderBefore = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentsBefore = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsBefore = await prisma.inventoryMovement.findMany({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    const authorized = await authorizeOrderReturn(order.id, requested.id);
    assert.strictEqual(authorized.status, OrderReturnStatus.AUTHORIZED);
    assert.ok(authorized.authorizedAt instanceof Date);
    assert.strictEqual(authorized.performedByUserId, requested.performedByUserId);
    assert.strictEqual(authorized.quantity, requested.quantity);
    assert.strictEqual(authorized.restockQuantity, requested.restockQuantity);
    assert.strictEqual(authorized.receivedAt, null);
    assert.strictEqual(authorized.inspectedAt, null);
    assert.strictEqual(authorized.completedAt, null);
    const itemAfter = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingAfter = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderAfter = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentsAfter = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsAfter = await prisma.inventoryMovement.findMany({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    assert.strictEqual(itemAfter?.returnedQuantity, itemBefore?.returnedQuantity);
    assert.strictEqual(listingAfter?.currentStock, listingBefore?.currentStock);
    assert.strictEqual(orderAfter?.status, orderBefore?.status);
    assert.deepStrictEqual(paymentsAfter, paymentsBefore);
    assert.deepStrictEqual(movementsAfter, movementsBefore);
  });

  it("rejects authorization when the return is not REQUESTED", async () => {
    const { customer, order, orderItem } = await createFixture();
    const requested = await requestReturn(order.id, orderItem.id, 1, customer.id);
    await prisma.orderReturn.update({ where: { id: requested.id }, data: { status: OrderReturnStatus.AUTHORIZED, authorizedAt: new Date() } });
    await assert.rejects(authorizeOrderReturn(order.id, requested.id), OrderReturnNotAuthorizableError);
  });

  it("rejects a missing order, missing return, and return from another order", async () => {
    const first = await createFixture();
    const second = await createFixture();
    const firstReturn = await requestReturn(first.order.id, first.orderItem.id, 1, first.customer.id);
    await assert.rejects(authorizeOrderReturn(999999999, firstReturn.id), OrderNotFoundError);
    await assert.rejects(authorizeOrderReturn(first.order.id, 999999999), OrderReturnNotFoundError);
    const secondReturn = await requestReturn(second.order.id, second.orderItem.id, 1, second.customer.id);
    await assert.rejects(authorizeOrderReturn(first.order.id, secondReturn.id), OrderReturnNotFoundError);
  });

  it("allows only one concurrent REQUESTED-to-AUTHORIZED transition", async () => {
    const { customer, order, orderItem } = await createFixture();
    const requested = await requestReturn(order.id, orderItem.id, 1, customer.id);
    const results = await Promise.allSettled([
      authorizeOrderReturn(order.id, requested.id),
      authorizeOrderReturn(order.id, requested.id),
    ]);
    assert.strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.strictEqual(results.filter((result) => result.status === "rejected" && result.reason instanceof OrderReturnNotAuthorizableError).length, 1);
    const persisted = await prisma.orderReturn.findUnique({ where: { id: requested.id } });
    assert.strictEqual(persisted?.status, OrderReturnStatus.AUTHORIZED);
    assert.ok(persisted?.authorizedAt instanceof Date);
  });

  it("receives an AUTHORIZED return without changing business side effects", async () => {
    const { customer, listing, order, orderItem } = await createFixture(3);
    const requested = await requestReturn(
      order.id,
      orderItem.id,
      2,
      customer.id,
      ReturnReason.DAMAGED,
      "Damaged packaging",
      ReturnShippingPayer.SELLER,
      4.5,
    );
    const authorized = await authorizeOrderReturn(order.id, requested.id);
    const itemBefore = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingBefore = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderBefore = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentsBefore = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsBefore = await prisma.inventoryMovement.findMany({
      where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN },
    });

    const received = await receiveOrderReturn(order.id, requested.id);

    assert.strictEqual(received.status, OrderReturnStatus.RECEIVED);
    assert.ok(received.receivedAt instanceof Date);
    assert.strictEqual(received.authorizedAt?.getTime(), authorized.authorizedAt?.getTime());
    assert.strictEqual(received.requestedAt.getTime(), requested.requestedAt.getTime());
    assert.strictEqual(received.performedByUserId, requested.performedByUserId);
    assert.strictEqual(received.quantity, requested.quantity);
    assert.strictEqual(received.restockQuantity, requested.restockQuantity);
    assert.strictEqual(received.inspectedAt, null);
    assert.strictEqual(received.completedAt, null);

    const itemAfter = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingAfter = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderAfter = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentsAfter = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsAfter = await prisma.inventoryMovement.findMany({
      where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN },
    });

    assert.strictEqual(itemAfter?.returnedQuantity, itemBefore?.returnedQuantity);
    assert.strictEqual(listingAfter?.currentStock, listingBefore?.currentStock);
    assert.strictEqual(orderAfter?.status, orderBefore?.status);
    assert.deepStrictEqual(paymentsAfter, paymentsBefore);
    assert.deepStrictEqual(movementsAfter, movementsBefore);
  });

  it("rejects receiving returns that are not AUTHORIZED", async () => {
    const { customer, order, orderItem } = await createFixture();
    const requested = await requestReturn(order.id, orderItem.id, 1, customer.id);
    await assert.rejects(
      receiveOrderReturn(order.id, requested.id),
      OrderReturnNotReceivableError,
    );

    await authorizeOrderReturn(order.id, requested.id);
    await receiveOrderReturn(order.id, requested.id);
    await assert.rejects(
      receiveOrderReturn(order.id, requested.id),
      OrderReturnNotReceivableError,
    );
  });

  it("rejects missing orders, missing returns, and returns from another order", async () => {
    const first = await createFixture();
    const second = await createFixture();
    const firstReturn = await requestReturn(first.order.id, first.orderItem.id, 1, first.customer.id);
    await authorizeOrderReturn(first.order.id, firstReturn.id);

    await assert.rejects(
      receiveOrderReturn(999999999, firstReturn.id),
      OrderNotFoundError,
    );
    await assert.rejects(
      receiveOrderReturn(first.order.id, 999999999),
      OrderReturnNotFoundError,
    );

    const secondReturn = await requestReturn(second.order.id, second.orderItem.id, 1, second.customer.id);
    await authorizeOrderReturn(second.order.id, secondReturn.id);
    await assert.rejects(
      receiveOrderReturn(first.order.id, secondReturn.id),
      OrderReturnNotFoundError,
    );
  });

  it("allows only one concurrent AUTHORIZED-to-RECEIVED transition", async () => {
    const { customer, order, orderItem } = await createFixture();
    const requested = await requestReturn(order.id, orderItem.id, 1, customer.id);
    await authorizeOrderReturn(order.id, requested.id);

    const results = await Promise.allSettled([
      receiveOrderReturn(order.id, requested.id),
      receiveOrderReturn(order.id, requested.id),
    ]);

    assert.strictEqual(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.strictEqual(
      results.filter(
        (result) =>
          result.status === "rejected" &&
          result.reason instanceof OrderReturnNotReceivableError,
      ).length,
      1,
    );

    const persisted = await prisma.orderReturn.findUnique({
      where: { id: requested.id },
    });
    assert.strictEqual(persisted?.status, OrderReturnStatus.RECEIVED);
    assert.ok(persisted?.receivedAt instanceof Date);
  });

  it("inspects a RECEIVED return and preserves lifecycle data", async () => {
    const { customer, order, orderItem } = await createFixture(3);
    const received = await createReceivedReturn(order.id, orderItem.id, customer.id, 2);
    const inspected = await inspectOrderReturn(order.id, received.id, ReturnCondition.AS_NEW, 1, "  Passed inspection  ", customer.id);
    assert.strictEqual(inspected.status, OrderReturnStatus.INSPECTED);
    assert.strictEqual(inspected.condition, ReturnCondition.AS_NEW);
    assert.strictEqual(inspected.restockQuantity, 1);
    assert.strictEqual(inspected.inspectionNote, "Passed inspection");
    assert.ok(inspected.inspectedAt instanceof Date);
    assert.strictEqual(inspected.inspectedByUserId, customer.id);
    assert.strictEqual(inspected.requestedAt.getTime(), received.requestedAt.getTime());
    assert.strictEqual(inspected.authorizedAt?.getTime(), received.authorizedAt?.getTime());
    assert.strictEqual(inspected.receivedAt?.getTime(), received.receivedAt?.getTime());
    assert.strictEqual(inspected.quantity, received.quantity);
    assert.strictEqual(inspected.performedByUserId, received.performedByUserId);
    assert.strictEqual(inspected.completedAt, null);
  });

  it("has no business side effects at INSPECTED", async () => {
    const { customer, listing, order, orderItem } = await createFixture(3);
    const received = await createReceivedReturn(order.id, orderItem.id, customer.id, 2);
    const payment = await prisma.payment.findUniqueOrThrow({where:{orderId:order.id}});
    paymentIds.push(payment.id);
    const itemBefore = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingBefore = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderBefore = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentsBefore = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsBefore = await prisma.inventoryMovement.findMany({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    await inspectOrderReturn(order.id, received.id, ReturnCondition.AS_NEW, 1, undefined, customer.id);
    const itemAfter = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingAfter = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderAfter = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentsAfter = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsAfter = await prisma.inventoryMovement.findMany({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    assert.strictEqual(itemAfter?.returnedQuantity, itemBefore?.returnedQuantity);
    assert.strictEqual(listingAfter?.currentStock, listingBefore?.currentStock);
    assert.strictEqual(orderAfter?.status, orderBefore?.status);
    assert.deepStrictEqual(paymentsAfter, paymentsBefore);
    assert.deepStrictEqual(movementsAfter, movementsBefore);
  });

  it("validates inspection condition and restock quantity", async () => {
    const { customer, order, orderItem } = await createFixture(3);
    const received = await createReceivedReturn(order.id, orderItem.id, customer.id);
    await assert.rejects(inspectOrderReturn(order.id, received.id, "INVALID" as ReturnCondition, 0, undefined, customer.id), InvalidReturnConditionError);
    await assert.rejects(inspectOrderReturn(order.id, received.id, ReturnCondition.AS_NEW, -1, undefined, customer.id), InvalidInspectionRestockQuantityError);
    await assert.rejects(inspectOrderReturn(order.id, received.id, ReturnCondition.AS_NEW, 1.5, undefined, customer.id), InvalidInspectionRestockQuantityError);
    await assert.rejects(inspectOrderReturn(order.id, received.id, ReturnCondition.AS_NEW, received.quantity + 1, undefined, customer.id), InvalidInspectionRestockQuantityError);
  });

  it("enforces the AS_NEW restock rule", async () => {
    const { customer, order, orderItem } = await createFixture(6);
    const opened = await createReceivedReturn(order.id, orderItem.id, customer.id);
    await assert.rejects(inspectOrderReturn(order.id, opened.id, ReturnCondition.OPENED_COMPLETE, 1, undefined, customer.id), InvalidInspectionRestockConditionError);
    const damaged = await createReceivedReturn(order.id, orderItem.id, customer.id);
    await assert.rejects(inspectOrderReturn(order.id, damaged.id, ReturnCondition.DAMAGED, 1, undefined, customer.id), InvalidInspectionRestockConditionError);
    const other = await createReceivedReturn(order.id, orderItem.id, customer.id);
    const inspected = await inspectOrderReturn(order.id, other.id, ReturnCondition.DAMAGED, 0, undefined, customer.id);
    assert.strictEqual(inspected.status, OrderReturnStatus.INSPECTED);
    assert.strictEqual(inspected.restockQuantity, 0);
  });

  it("rejects inspection from REQUESTED, AUTHORIZED, and INSPECTED states", async () => {
    const requestedFixture = await createFixture();
    const requested = await requestReturn(requestedFixture.order.id, requestedFixture.orderItem.id, 1, requestedFixture.customer.id);
    await assert.rejects(inspectOrderReturn(requestedFixture.order.id, requested.id, ReturnCondition.AS_NEW, 0, undefined, requestedFixture.customer.id), OrderReturnNotInspectableError);
    const authorizedFixture = await createFixture();
    const authorized = await requestReturn(authorizedFixture.order.id, authorizedFixture.orderItem.id, 1, authorizedFixture.customer.id);
    await authorizeOrderReturn(authorizedFixture.order.id, authorized.id);
    await assert.rejects(inspectOrderReturn(authorizedFixture.order.id, authorized.id, ReturnCondition.AS_NEW, 0, undefined, authorizedFixture.customer.id), OrderReturnNotInspectableError);
    const inspectedFixture = await createFixture();
    const received = await createReceivedReturn(inspectedFixture.order.id, inspectedFixture.orderItem.id, inspectedFixture.customer.id);
    await inspectOrderReturn(inspectedFixture.order.id, received.id, ReturnCondition.AS_NEW, 0, undefined, inspectedFixture.customer.id);
    await assert.rejects(inspectOrderReturn(inspectedFixture.order.id, received.id, ReturnCondition.AS_NEW, 0, undefined, inspectedFixture.customer.id), OrderReturnNotInspectableError);
  });

  it("rejects missing and wrongly scoped inspection resources", async () => {
    const first = await createFixture();
    const second = await createFixture();
    const firstReturn = await createReceivedReturn(first.order.id, first.orderItem.id, first.customer.id);
    await assert.rejects(inspectOrderReturn(999999999, firstReturn.id, ReturnCondition.AS_NEW, 0, undefined, first.customer.id), OrderNotFoundError);
    await assert.rejects(inspectOrderReturn(first.order.id, 999999999, ReturnCondition.AS_NEW, 0, undefined, first.customer.id), OrderReturnNotFoundError);
    const secondReturn = await createReceivedReturn(second.order.id, second.orderItem.id, second.customer.id);
    await assert.rejects(inspectOrderReturn(first.order.id, secondReturn.id, ReturnCondition.AS_NEW, 0, undefined, first.customer.id), OrderReturnNotFoundError);
  });

  it("allows only one concurrent RECEIVED-to-INSPECTED transition", async () => {
    const { customer, order, orderItem } = await createFixture();
    const received = await createReceivedReturn(order.id, orderItem.id, customer.id);
    const results = await Promise.allSettled([
      inspectOrderReturn(order.id, received.id, ReturnCondition.AS_NEW, 1, undefined, customer.id),
      inspectOrderReturn(order.id, received.id, ReturnCondition.AS_NEW, 1, undefined, customer.id),
    ]);
    assert.strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.strictEqual(results.filter((result) => result.status === "rejected" && result.reason instanceof OrderReturnNotInspectableError).length, 1);
    const persisted = await prisma.orderReturn.findUnique({ where: { id: received.id } });
    assert.strictEqual(persisted?.status, OrderReturnStatus.INSPECTED);
    assert.ok(persisted?.inspectedAt instanceof Date);
  });

  it("completes an INSPECTED return and restores restock quantity", async () => {
    const { customer, listing, order, orderItem } = await createFixture(3);
    const inspected = await createInspectedReturn(order.id, orderItem.id, customer.id, 2, 1);
    const itemBefore = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingBefore = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const movementsBefore = await prisma.inventoryMovement.count({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    const completed = await completeOrderReturn(order.id, inspected.id, customer.id);
    assert.strictEqual(completed.status, OrderReturnStatus.COMPLETED);
    assert.ok(completed.completedAt instanceof Date);
    const itemAfter = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingAfter = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const movementsAfter = await prisma.inventoryMovement.findMany({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    assert.strictEqual(itemAfter?.returnedQuantity, (itemBefore?.returnedQuantity ?? 0) + inspected.quantity);
    assert.strictEqual(listingAfter?.currentStock, (listingBefore?.currentStock ?? 0) + inspected.restockQuantity);
    assert.strictEqual(movementsAfter.length, movementsBefore + 1);
    assert.strictEqual(movementsAfter.at(-1)?.quantityChange, inspected.restockQuantity);
  });

  it("completes zero-restock returns without stock or movement changes", async () => {
    const { customer, listing, order, orderItem } = await createFixture(3);
    const inspected = await createInspectedReturn(order.id, orderItem.id, customer.id, 2, 0);
    const before = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const movementsBefore = await prisma.inventoryMovement.count({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    await completeOrderReturn(order.id, inspected.id, customer.id);
    const item = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const after = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const movementsAfter = await prisma.inventoryMovement.count({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    assert.strictEqual(item?.returnedQuantity, 2);
    assert.strictEqual(after?.currentStock, before?.currentStock);
    assert.strictEqual(movementsAfter, movementsBefore);
  });

  it("rejects completion unless the return is INSPECTED", async () => {
    const { customer, order, orderItem } = await createFixture();
    const requested = await requestReturn(order.id, orderItem.id, 1, customer.id);
    await assert.rejects(completeOrderReturn(order.id, requested.id, customer.id), OrderReturnNotCompletableError);
    await authorizeOrderReturn(order.id, requested.id);
    await assert.rejects(completeOrderReturn(order.id, requested.id, customer.id), OrderReturnNotCompletableError);
    await receiveOrderReturn(order.id, requested.id);
    await assert.rejects(completeOrderReturn(order.id, requested.id, customer.id), OrderReturnNotCompletableError);
    await inspectOrderReturn(order.id, requested.id, ReturnCondition.AS_NEW, 0, undefined, customer.id);
    await completeOrderReturn(order.id, requested.id, customer.id);
    await assert.rejects(completeOrderReturn(order.id, requested.id, customer.id), OrderReturnNotCompletableError);
  });

  it("rejects missing and wrongly scoped completion resources", async () => {
    const first = await createFixture();
    const second = await createFixture();
    const firstReturn = await createInspectedReturn(first.order.id, first.orderItem.id, first.customer.id);
    await assert.rejects(completeOrderReturn(999999999, firstReturn.id, first.customer.id), OrderNotFoundError);
    await assert.rejects(completeOrderReturn(first.order.id, 999999999, first.customer.id), OrderReturnNotFoundError);
    const secondReturn = await createInspectedReturn(second.order.id, second.orderItem.id, second.customer.id);
    await assert.rejects(completeOrderReturn(first.order.id, secondReturn.id, first.customer.id), OrderReturnNotFoundError);
  });

  it("guards cumulative quantity across returns", async () => {
    const { customer, listing, order, orderItem } = await createFixture(3);
    const first = await createInspectedReturn(order.id, orderItem.id, customer.id, 2, 2);
    await completeOrderReturn(order.id, first.id, customer.id);
    const stock = (await prisma.productListing.findUnique({ where: { id: listing.id } }))!.currentStock;
    const movements = await prisma.inventoryMovement.count({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    await assert.rejects(requestReturn(order.id, orderItem.id, 2, customer.id), OrderReturnQuantityExceededError);
    const item = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingAfter = await prisma.productListing.findUnique({ where: { id: listing.id } });
    assert.ok((item?.returnedQuantity ?? 0) <= item!.quantity);
    assert.strictEqual(listingAfter?.currentStock, stock);
    assert.strictEqual(await prisma.inventoryMovement.count({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } }), movements);
    assert.strictEqual((await prisma.orderItem.findUnique({ where: { id: orderItem.id } }))?.reservedReturnQuantity, 0);
  });

  it("allows only one concurrent completion of the same return", async () => {
    const { customer, listing, order, orderItem } = await createFixture();
    const inspected = await createInspectedReturn(order.id, orderItem.id, customer.id);
    const results = await Promise.allSettled([completeOrderReturn(order.id, inspected.id, customer.id), completeOrderReturn(order.id, inspected.id, customer.id)]);
    assert.strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.strictEqual(results.filter((result) => result.status === "rejected" && result.reason instanceof OrderReturnNotCompletableError).length, 1);
    const item = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingAfter = await prisma.productListing.findUnique({ where: { id: listing.id } });
    assert.strictEqual(item?.returnedQuantity, 1);
    assert.strictEqual(listingAfter?.currentStock, listing.currentStock - orderItem.quantity + 1);
    assert.strictEqual(await prisma.inventoryMovement.count({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } }), 1);
  });

  it("protects cumulative quantity across concurrent returns", async () => {
    const { customer, listing, order, orderItem } = await createFixture(3);
    const results = await Promise.allSettled([requestReturn(order.id, orderItem.id, 2, customer.id), requestReturn(order.id, orderItem.id, 2, customer.id)]);
    assert.strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.strictEqual(results.filter((result) => result.status === "rejected" && result.reason instanceof OrderReturnQuantityExceededError).length, 1);
    const item = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    assert.ok((item?.returnedQuantity ?? 0) <= item!.quantity);
    assert.strictEqual(item?.reservedReturnQuantity, 2);
  });

  it("cancels a REQUESTED return and releases its reservation", async () => {
    const { customer, order, orderItem } = await createFixture(3);
    const requested = await requestReturn(order.id, orderItem.id, 2, customer.id);
    const cancelled = await cancelOrderReturn(order.id, requested.id);
    assert.strictEqual(cancelled.status, OrderReturnStatus.CANCELLED);
    assert.strictEqual((await prisma.orderItem.findUnique({ where: { id: orderItem.id } }))?.reservedReturnQuantity, 0);
    const later = await requestReturn(order.id, orderItem.id, 3, customer.id);
    assert.strictEqual(later.quantity, 3);
  });

  it("allows only one concurrent cancellation and releases once", async () => {
    const { customer, order, orderItem } = await createFixture(3);
    const requested = await requestReturn(order.id, orderItem.id, 2, customer.id);
    const results = await Promise.allSettled([
      cancelOrderReturn(order.id, requested.id),
      cancelOrderReturn(order.id, requested.id),
    ]);
    assert.strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.strictEqual(results.filter((result) => result.status === "rejected" && result.reason instanceof OrderReturnNotCancellableError).length, 1);
    assert.strictEqual((await prisma.orderItem.findUnique({ where: { id: orderItem.id } }))?.reservedReturnQuantity, 0);
  });
});
