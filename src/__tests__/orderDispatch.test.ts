import { strict as assert } from "node:assert";
import { describe, it, before, after, afterEach } from "node:test";
import { prisma } from "../prisma/runtime.js";
import { recordVerifiedPayment } from "./fixtures/verifiedPayment.js";
import { Decimal } from "@prisma/client/runtime/client";
import { createOrder } from "../domain/orders/orderService.js";
import { dispatchOrder } from "../domain/orders/orderDispatchService.js";
import { OrderNotFoundError, OrderNotDispatchableError } from "../domain/orders/orderDispatchErrors.js";
import { OrderStatus } from "../generated/prisma-client/enums.js";
import { InventoryMovementType } from "../generated/prisma-client/enums.js";

const TEST_PREFIX = `orderDispatchTest-${Date.now()}`;
let userId: number;
let productListingId: number;
let orderId: number;
const createdOrderIds: number[] = [];
const createdListingIds: number[] = [];
const createdLegoProductIds: number[] = [];
const createdUserIds: number[] = [];

async function createUserWithAddress() {
  const user = await prisma.user.create({
    data: {
      email: `${TEST_PREFIX}@example.com`,
      passwordHash: "hashed",
      emailVerified: true,
      role: "CUSTOMER",
      addresses: {
        create: {
          recipientName: "Test User",
          line1: "123 Test St",
          city: "Testville",
          postcode: "12345",
          countryCode: "US",
          isDefaultBilling: true,
        },
      },
    },
    include: { addresses: true },
  });
  return { user, address: user.addresses[0] };
}

async function createListing(): Promise<{ listingId: number; legoProductId: number }> {
  const product = await prisma.legoProduct.create({
    data: {
      setNumber: `${TEST_PREFIX}-SET`,
      title: `${TEST_PREFIX} Lego`,
      theme: "TEST",
      ageRecommendation: "8+",
      pieceCount: 100,
      productListings: {
        create: {

          condition: "NEW",
          originalPrice: new Decimal(20),
          salePrice: new Decimal(15),
          currentStock: 10,
          active: true,
        },
      },
    },
    include: { productListings: true },
  });
   return { listingId: product.productListings[0].id, legoProductId: product.id };
}

before(async () => {
  const { user } = await createUserWithAddress();
  userId = user.id;
  createdUserIds.push(userId);
  const { listingId, legoProductId } = await createListing();
  productListingId = listingId;
  createdListingIds.push(productListingId);
  createdLegoProductIds.push(legoProductId);
});

  after(async () => {
    // Clean up in a FK-safe order: delete inventory movements first
    await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: createdListingIds } } });
    // Then delete orders (cascades orderItems)
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    await prisma.productListing.updateMany({
      where: { id: { in: createdListingIds } },
      data: { reservedStock: 0 },
    });
    // Delete product listings
    await prisma.productListing.deleteMany({ where: { id: { in: createdListingIds } } });
    // Delete lego products
    await prisma.legoProduct.deleteMany({ where: { id: { in: createdLegoProductIds } } });
    // Finally delete users
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  });

describe("orderDispatchService", () => {
  afterEach(async () => {
    await prisma.productListing.updateMany({
      where: { id: { in: createdListingIds } },
      data: { reservedStock: 0 },
    });
  });

  it("dispatches a CONFIRMED order and records shipping details", async () => {
    const order = await createOrder(userId, {
      items: [{ productListingId, quantity: 1 }],
    });
    createdOrderIds.push(order.id);
    // Update status to CONFIRMED
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED } }); await recordVerifiedPayment(order.id);
    const dispatched = await dispatchOrder(order.id, 5.99, "UPS", "1Z999AA10123456784", userId);
    assert.strictEqual(dispatched.status, OrderStatus.DISPATCHED);
    assert.strictEqual(dispatched.actualShippingCost?.toString(), new Decimal(5.99).toString());
    assert.strictEqual(dispatched.shippingCarrier, "UPS");
    assert.strictEqual(dispatched.trackingNumber, "1Z999AA10123456784");
    assert.ok(dispatched.dispatchedAt !== null);
  });

  it("throws OrderNotFoundError for non-existent order", async () => {
    await assert.rejects(
      async () => dispatchOrder(9999999, 5, "UPS", undefined, userId),
      (err) => err instanceof OrderNotFoundError,
    );
  });

  it("throws OrderNotDispatchableError if order not CONFIRMED", async () => {
    const order = await createOrder(userId, {
      items: [{ productListingId, quantity: 1 }],
    });
    createdOrderIds.push(order.id);
    // Order remains in PENDING
    await assert.rejects(
      async () => dispatchOrder(order.id, 5, "UPS", undefined, userId),
      (err) => err instanceof OrderNotDispatchableError,
    );
  });
  it("optional trackingNumber remains null if not provided", async () => {
    const order = await createOrder(userId, {
      items: [{ productListingId, quantity: 1 }],
    });
    createdOrderIds.push(order.id);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED } }); await recordVerifiedPayment(order.id);
    const dispatched = await dispatchOrder(order.id, 5.99, "UPS", undefined, userId);
    assert.strictEqual(dispatched.trackingNumber, null);
  });
  it("throws OrderNotDispatchableError for PENDING status", async () => {
    const order = await createOrder(userId, {
      items: [{ productListingId, quantity: 1 }],
    });
    createdOrderIds.push(order.id);
    await assert.rejects(
      async () => dispatchOrder(order.id, 5, "UPS", undefined, userId),
      (err) => err instanceof OrderNotDispatchableError,
    );
  });
  it("throws OrderNotDispatchableError for CANCELLED status", async () => {
    const order = await createOrder(userId, {
      items: [{ productListingId, quantity: 1 }],
    });
    createdOrderIds.push(order.id);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });
    await assert.rejects(
      async () => dispatchOrder(order.id, 5, "UPS", undefined, userId),
      (err) => err instanceof OrderNotDispatchableError,
    );
  });
  it("throws OrderNotDispatchableError for DISPATCHED status", async () => {
    const order = await createOrder(userId, {
      items: [{ productListingId, quantity: 1 }],
    });
    createdOrderIds.push(order.id);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.DISPATCHED } });
    await assert.rejects(
      async () => dispatchOrder(order.id, 5, "UPS", undefined, userId),
      (err) => err instanceof OrderNotDispatchableError,
    );
  });
  it("throws OrderNotDispatchableError for COMPLETED status", async () => {
    const order = await createOrder(userId, {
      items: [{ productListingId, quantity: 1 }],
    });
    createdOrderIds.push(order.id);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.COMPLETED } });
    await assert.rejects(
      async () => dispatchOrder(order.id, 5, "UPS", undefined, userId),
      (err) => err instanceof OrderNotDispatchableError,
    );
  });
  it("throws OrderNotDispatchableError for RETURNED status", async () => {
    const order = await createOrder(userId, {
      items: [{ productListingId, quantity: 1 }],
    });
    createdOrderIds.push(order.id);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.RETURNED } });
    await assert.rejects(
      async () => dispatchOrder(order.id, 5, "UPS", undefined, userId),
      (err) => err instanceof OrderNotDispatchableError,
    );
  });
  it("repeated dispatch metadata protection", async () => {
    const order = await createOrder(userId, {
      items: [{ productListingId, quantity: 1 }],
    });
    createdOrderIds.push(order.id);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED } }); await recordVerifiedPayment(order.id);
  const first = await dispatchOrder(order.id, 5, "UPS", "TRACK1", userId);
  const firstDispatchedAt = first.dispatchedAt;
  assert.strictEqual(first.trackingNumber, "TRACK1");
    await assert.rejects(
      async () => dispatchOrder(order.id, 10, "DHL", "TRACK2", userId),
      (err) => err instanceof OrderNotDispatchableError,
    );
    const final = await prisma.order.findUnique({ where: { id: order.id } });
    assert.strictEqual(final?.actualShippingCost?.toString(), new Decimal(5).toString());
    assert.strictEqual(final?.shippingCarrier, "UPS");
    assert.strictEqual(final?.trackingNumber, "TRACK1");
    // dispatchedAt should remain unchanged after failed second dispatch
    assert.strictEqual(final?.dispatchedAt?.toString(), firstDispatchedAt?.toString());
  });
  it("concurrent dispatch race condition protection", async () => {
    const order = await createOrder(userId, {
      items: [{ productListingId, quantity: 1 }],
    });
    createdOrderIds.push(order.id);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED } }); await recordVerifiedPayment(order.id);
    const payloadA = { actualShippingCost: 5, shippingCarrier: "UPS", trackingNumber: "A1" };
    const payloadB = { actualShippingCost: 10, shippingCarrier: "DHL", trackingNumber: "B1" };
    const [resA, resB] = await Promise.allSettled([
      dispatchOrder(order.id, payloadA.actualShippingCost, payloadA.shippingCarrier, payloadA.trackingNumber, userId),
      dispatchOrder(order.id, payloadB.actualShippingCost, payloadB.shippingCarrier, payloadB.trackingNumber, userId),
    ]);
    const fulfilled = [resA, resB].filter((r) => r.status === "fulfilled");
    const rejected = [resA, resB].filter((r) => r.status === "rejected");
    assert.strictEqual(fulfilled.length, 1);
    assert.strictEqual(rejected.length, 1);
    // The rejected request must be an OrderNotDispatchableError
    assert.ok(rejected[0].reason instanceof OrderNotDispatchableError);
    const final = await prisma.order.findUnique({ where: { id: order.id } });
    // The final state should match the fulfilled request
    if (fulfilled[0].status === "fulfilled") {
      const data = fulfilled[0].value;
      assert.strictEqual(final?.status, OrderStatus.DISPATCHED);
      assert.strictEqual(final?.actualShippingCost?.toString(), data.actualShippingCost.toString());
      assert.strictEqual(final?.shippingCarrier, data.shippingCarrier);
      assert.strictEqual(final?.trackingNumber, data.trackingNumber);
    }
  });
  it("inventory remains unchanged and no new WEBSITE_SALE movement on dispatch", async () => {
    const order = await createOrder(userId, {
      items: [{ productListingId, quantity: 1 }],
    });
    createdOrderIds.push(order.id);
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED } }); await recordVerifiedPayment(order.id);
    const stockBefore = (await prisma.productListing.findUnique({ where: { id: productListingId } }))?.currentStock ?? 0;
     const movementCountBefore = await prisma.inventoryMovement.count({ where: { listingId: productListingId, type: InventoryMovementType.WEBSITE_SALE } });
    await dispatchOrder(order.id, 5, "UPS", undefined, userId);
    const stockAfter = (await prisma.productListing.findUnique({ where: { id: productListingId } }))?.currentStock ?? 0;
     const movementCountAfter = await prisma.inventoryMovement.count({ where: { listingId: productListingId, type: InventoryMovementType.WEBSITE_SALE } });
    assert.strictEqual(stockBefore, stockAfter);
    assert.strictEqual(movementCountBefore, movementCountAfter);
  });
});
