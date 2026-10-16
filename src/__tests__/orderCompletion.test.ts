import { strict as assert } from "node:assert";
import { describe, it, before, after, afterEach } from "node:test";
import { prisma } from "../prisma/runtime.js";
import { recordVerifiedPayment } from "./fixtures/verifiedPayment.js";
import { Decimal } from "@prisma/client/runtime/client";
import { createOrder } from "../domain/orders/orderService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import { dispatchOrder } from "../domain/orders/orderDispatchService.js";
import { completeOrder } from "../domain/orders/orderCompletionService.js";
import { cancelOrder } from "../domain/orders/orderCancellationService.js";
import { OrderStatus } from "../generated/prisma-client/enums.js";
import { OrderNotFoundError } from "../domain/orders/orderDispatchErrors.js";
import { OrderNotCompletableError } from "../domain/orders/orderCompletionErrors.js";
  // OrderNotCancellableError is not used in this test file

/**
 * Utility helpers mirroring the fixture structure used in the existing order
 * tests.  They create a user with a default billing address, an admin user,
 * a Lego product with a listing, and return the relevant IDs for use in
 * individual test cases.
 */
const TEST_PREFIX = `orderCompletionTest-${Date.now()}`;
let userId: number;
let adminId: number;
let listingId: number;
let legoProductId: number;

async function createUserWithAddress(): Promise<number> {
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
  return user.id;
}

async function createAdmin(): Promise<number> {
  const admin = await prisma.user.create({
    data: {
      email: `${TEST_PREFIX}-admin@example.com`,
      passwordHash: "hashed",
      emailVerified: true,
      role: "ADMIN",
    },
  });
  return admin.id;
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

describe("Order completion workflow", () => {
  const createdOrderIds: number[] = [];

  before(async () => {
    userId = await createUserWithAddress();
    adminId = await createAdmin();
    const { listingId: lId, legoProductId: lpId } = await createListing();
    listingId = lId;
    legoProductId = lpId;
  });

  after(async () => {
    // Clean up users
    await prisma.user.deleteMany({ where: { id: { in: [userId, adminId] } } });
    // Clean up listings & product
    await prisma.productListing.deleteMany({ where: { id: listingId } });
    await prisma.legoProduct.deleteMany({ where: { id: legoProductId } });
  });

  afterEach(async () => {
    if (createdOrderIds.length) {
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      createdOrderIds.length = 0;
    }
    // Remove any inventory movements for the test listing
    await prisma.inventoryMovement.deleteMany({ where: { listingId } });
  });

  /**
   * Helper that creates an order, confirms it, and dispatches it so that the
   * order is in DISPATCHED state.  The created order ID is pushed into
   * `createdOrderIds` for cleanup.
   */
  async function prepareDispatchedOrder(): Promise<number> {
    const order = await createOrder(userId, { shippingMethod: "STANDARD" as const,
      items: [{ productListingId: listingId, quantity: 1 }],
    });
    createdOrderIds.push(order.id);
    await confirmOrder(adminId, order.id);
    await recordVerifiedPayment(order.id);
    await dispatchOrder(order.id, 5, "UPS", "TRACK123", adminId);
    return order.id;
  }

  it("DISPATCHED -> COMPLETED succeeds and preserves shipping details", async () => {
    const orderId = await prepareDispatchedOrder();
    // Capture state before completion
    const pre = await prisma.order.findUnique({ where: { id: orderId } });
    assert(pre, "Order should exist before completion");
    const preStock = (await prisma.productListing.findUnique({ where: { id: listingId } }))?.currentStock;
    const preMovementCount = await prisma.inventoryMovement.count({ where: { listingId } });

    const completed = await completeOrder(orderId);
    const post = await prisma.order.findUnique({ where: { id: orderId } });
    assert(post, "Order should exist after completion");
    // Verify status and timestamps
    assert.strictEqual(post.status, OrderStatus.COMPLETED);
    assert.ok(post.completedAt, "completedAt should be set");
    assert.strictEqual(post.dispatchedAt?.toString(), pre?.dispatchedAt?.toString(), "dispatchedAt should be unchanged");
    assert.strictEqual(post.actualShippingCost?.toString(), pre?.actualShippingCost?.toString(), "actualShippingCost should be unchanged");
    assert.strictEqual(post.shippingCarrier, pre?.shippingCarrier, "shippingCarrier should be unchanged");
    assert.strictEqual(post.trackingNumber, pre?.trackingNumber, "trackingNumber should be unchanged");
    // Stock and movements unchanged
    const postStock = (await prisma.productListing.findUnique({ where: { id: listingId } }))?.currentStock;
    assert.strictEqual(postStock, preStock, "productListing currentStock should not change on completion");
    const postMovementCount = await prisma.inventoryMovement.count({ where: { listingId } });
    assert.strictEqual(postMovementCount, preMovementCount, "no new InventoryMovement should be created on completion");
  });

  it("missing order throws OrderNotFoundError", async () => {
    await assert.rejects(() => completeOrder(9999999), (err) => err instanceof OrderNotFoundError);
  });

  it("PENDING order cannot be completed", async () => {
    const order = await createOrder(userId, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listingId, quantity: 1 }] });
    createdOrderIds.push(order.id);
    await assert.rejects(() => completeOrder(order.id), (err) => err instanceof OrderNotCompletableError);
  });

  it("CONFIRMED order cannot be completed", async () => {
    const order = await createOrder(userId, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listingId, quantity: 1 }] });
    createdOrderIds.push(order.id);
    await confirmOrder(adminId, order.id);
    await assert.rejects(() => completeOrder(order.id), (err) => err instanceof OrderNotCompletableError);
  });

  it("CANCELLED order cannot be completed", async () => {
    const order = await createOrder(userId, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listingId, quantity: 1 }] });
    createdOrderIds.push(order.id);
     // Use a valid CancellationReason value (e.g., OTHER)
     await cancelOrder(userId, order.id, "OTHER");
    await assert.rejects(() => completeOrder(order.id), (err) => err instanceof OrderNotCompletableError);
  });

  it("COMPLETED order cannot be completed again", async () => {
    const orderId = await prepareDispatchedOrder();
    // First completion
    await completeOrder(orderId);
    // Second call should reject
    await assert.rejects(() => completeOrder(orderId), (err) => err instanceof OrderNotCompletableError);
  });

  it("concurrency: only one completeOrder succeeds", async () => {
    const orderId = await prepareDispatchedOrder();
    const [r1, r2] = await Promise.allSettled([completeOrder(orderId), completeOrder(orderId)]);
    const fulfilled = [r1, r2].filter((r) => r.status === "fulfilled");
    const rejected = [r1, r2].filter((r) => r.status === "rejected");
    assert.strictEqual(fulfilled.length, 1, "only one request should succeed");
    assert.strictEqual(rejected.length, 1, "one request should be rejected");
    assert.ok(rejected[0].reason instanceof OrderNotCompletableError, "rejection should be OrderNotCompletableError");
    // Verify final state is COMPLETED
    const final = await prisma.order.findUnique({ where: { id: orderId } });
    assert.strictEqual(final?.status, OrderStatus.COMPLETED);
  });
});
