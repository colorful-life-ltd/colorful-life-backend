import { prisma } from "../prisma/runtime.js";
import { Decimal } from "@prisma/client/runtime/client";
import { createPayment } from "../domain/payments/paymentService.js";
import { PaymentAlreadySucceededError, PaymentConflictError, PaymentExpiredError, PaymentNotFoundError } from "../domain/payments/paymentErrors.js";
import { createOrder } from "../domain/orders/orderService.js";
import { strict as assert } from "node:assert";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
const TEST_PREFIX = `paymentTest-${Date.now()}`;
// ---- global fixture variables ---------------------------------------------------
let userId: number;
let addressId: number;
let legoProductId: number;
let productListingId: number;
let zeroPriceProductId: number | null = null;
let zeroPriceListingId: number | null = null;
const createdOrderIds: number[] = [];
const createdPaymentIds: number[] = [];
// ---------------------------------------------------------------------------
// Shared fixture setup – runs once before all tests
before(async () => {
  // 1️⃣ Create a user with a default billing address
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
  userId = user.id;
  addressId = user.addresses[0].id;

  // 2️⃣ Create a Lego product and a single listing (non‑zero price)
  const product = await prisma.legoProduct.create({
    data: {
      setNumber: `${TEST_PREFIX}-SET`,
      title: `${TEST_PREFIX} Lego`,
      theme: "TEST",
      ageRecommendation: "8+",
      pieceCount: 100,
    },
  });
  legoProductId = product.id;
  const listing = await prisma.productListing.create({
    data: {

      legoProductId: product.id,
      condition: "NEW",
      originalPrice: new Decimal(20),
      salePrice: new Decimal(15),
      currentStock: 10,
      active: true,
    },
  });
  productListingId = listing.id;
});
// OrderStatus is not required in the test file – removed import

// Helper to create a basic order with one item and a totalAmount
async function createTestOrder() {
  const order = await createOrder(userId, { shippingMethod: "STANDARD" as const,
    items: [{ productListingId, quantity: 1 }],
  });
  createdOrderIds.push(order.id);
  return order;
}

/**
 * Creates a Lego product with a zero‑price listing for the “non‑positive total” test.
 */
async function createZeroPriceListing() {
  const product = await prisma.legoProduct.create({
    data: {
      setNumber: `${TEST_PREFIX}-ZERO-SET`,
      title: `${TEST_PREFIX} Zero`,
      theme: "TEST",
      ageRecommendation: "0",
      pieceCount: 0,
    },
  });
  const listing = await prisma.productListing.create({
    data: {

      legoProductId: product.id,
      condition: "NEW",
      originalPrice: new Decimal(0),
      salePrice: new Decimal(0),
      currentStock: 10,
      active: true,
    },
  });
  return { productId: product.id, listingId: listing.id };
}

describe("Payment Service", () => {
  // Clean up this file's fixtures in the guarded, dedicated test database.
  beforeEach(async () => {
    // Scoped cleanup: only delete rows created by this test file
    if (createdPaymentIds.length) {
      await prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } });
      createdPaymentIds.length = 0;
    }
    if (createdOrderIds.length) {
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      createdOrderIds.length = 0;
    }
    // Order items belong to orders; deleting orders will cascade
  });
  afterEach(async () => {
    // Scoping already handled in beforeEach; keep for safety if future tests
    if (createdPaymentIds.length) {
      await prisma.payment.deleteMany({ where: { id: { in: createdPaymentIds } } });
      createdPaymentIds.length = 0;
    }
    if (createdOrderIds.length) {
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      createdOrderIds.length = 0;
    }
  });

  it("successful manual payment", async () => {
    const order = await createTestOrder();
    const providerRef = "ref-123";
    const payment = await createPayment(order.id, { providerReference: providerRef });
    createdPaymentIds.push(payment.id);
    assert.ok(payment);
    assert.strictEqual(payment.orderId, order.id);
    assert.strictEqual(payment.amount.toString(), order.totalAmount.toString());
    assert.strictEqual(payment.currency, "GBP");
    assert.strictEqual(payment.provider, "MANUAL");
    assert.strictEqual(payment.status, "SUCCEEDED");
    assert.ok(payment.paidAt instanceof Date);
  })

  it("same order + same providerReference is idempotent", async () => {
    const order = await createTestOrder();
    const providerRef = "ref-idempotent";
    const first = await createPayment(order.id, { providerReference: providerRef });
    createdPaymentIds.push(first.id);
    const second = await createPayment(order.id, { providerReference: providerRef });
    assert.strictEqual(first.id, second.id);
    const count = await prisma.payment.count({ where: { providerReference: providerRef } });
    assert.strictEqual(count, 1);
  })

  it("rejects a new payment after the reservation deadline without releasing stock", async () => {
    const order = await createTestOrder();
    const reservedBefore = (await prisma.productListing.findUnique({ where: { id: productListingId } }))?.reservedStock;
    await prisma.order.update({
      where: { id: order.id },
      data: { reservationExpiresAt: new Date(Date.now() - 1_000) },
    });

    await assert.rejects(
      () => createPayment(order.id, { providerReference: "late-payment" }),
      (error) => error instanceof PaymentExpiredError,
    );
    assert.strictEqual(await prisma.payment.count({ where: { orderId: order.id } }), 0);
    const persistedOrder = await prisma.order.findUnique({ where: { id: order.id } });
    assert.strictEqual(persistedOrder?.status, "PENDING");
    assert.strictEqual(
      (await prisma.productListing.findUnique({ where: { id: productListingId } }))?.reservedStock,
      reservedBefore,
    );
  })

  it("replays an existing successful payment after the deadline", async () => {
    const order = await createTestOrder();
    const providerReference = "late-replay";
    const first = await createPayment(order.id, { providerReference });
    createdPaymentIds.push(first.id);
    await prisma.order.update({
      where: { id: order.id },
      data: { reservationExpiresAt: new Date(Date.now() - 1_000) },
    });

    const replay = await createPayment(order.id, { providerReference });
    assert.strictEqual(replay.id, first.id);
    assert.strictEqual(await prisma.payment.count({ where: { orderId: order.id } }), 1);
  })

  it("rejects a distinct reference after the order is paid", async () => {
    const order = await createTestOrder();
    const first = await createPayment(order.id, { providerReference: "first-payment" });
    createdPaymentIds.push(first.id);
    await assert.rejects(
      () => createPayment(order.id, { providerReference: "second-payment" }),
      (e) => e instanceof PaymentAlreadySucceededError,
    );
    assert.strictEqual(await prisma.payment.count({ where: { orderId: order.id } }), 1);
  })

  it("concurrent distinct references create only one payment", async () => {
    const order = await createTestOrder();
    const results = await Promise.allSettled([
      createPayment(order.id, { providerReference: "concurrent-first" }),
      createPayment(order.id, { providerReference: "concurrent-second" }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.strictEqual(fulfilled.length, 1);
    assert.strictEqual(rejected.length, 1);
    if (fulfilled[0].status === "fulfilled") createdPaymentIds.push(fulfilled[0].value.id);
    assert.strictEqual(await prisma.payment.count({ where: { orderId: order.id } }), 1);
  })

  it("cross-order providerReference conflict throws PaymentConflictError", async () => {
    const orderA = await createTestOrder();
    const orderB = await createTestOrder();
    const providerRef = "conflict-ref";
    const first = await createPayment(orderA.id, { providerReference: providerRef });
    createdPaymentIds.push(first.id);
    await assert.rejects(
      () => createPayment(orderB.id, { providerReference: providerRef }),
      (e) => e instanceof PaymentConflictError
    );
    const count = await prisma.payment.count({ where: { providerReference: providerRef } });
    assert.strictEqual(count, 1);
  })

  it("concurrent identical requests result in one payment", async () => {
    const order = await createTestOrder()
    const providerRef = "concurrent-ref"
    const [p1, p2] = await Promise.all([
      createPayment(order.id, { providerReference: providerRef }),
      createPayment(order.id, { providerReference: providerRef }),
    ]);
    createdPaymentIds.push(p1.id, p2.id);
    assert.strictEqual(p1.id, p2.id);
    const count = await prisma.payment.count({ where: { providerReference: providerRef } });
    assert.strictEqual(count, 1);
  })

  it("missing order throws PaymentNotFoundError", async () => {
    await assert.rejects(
      () => createPayment(9999, { providerReference: "missing-order" }),
      (e) => e instanceof PaymentNotFoundError
    );
  })

  it("non‑positive total amount rejects payment", async () => {
    // Create a zero‑price listing and an order that references it
    const { productId, listingId } = await createZeroPriceListing();
    zeroPriceProductId = productId;
    zeroPriceListingId = listingId;
    const order = await createOrder(userId, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listingId, quantity: 1 }] });
    createdOrderIds.push(order.id);
    // Model a historical zero-total row: new checkout now includes a delivery charge.
    await prisma.order.update({ where: { id: order.id }, data: { totalAmount: 0 } });
    await assert.rejects(() => createPayment(order.id, { providerReference: "zero-total" }));
  })

  it("payment does not alter order status or inventory", async () => {
    const order = await createTestOrder()
    const initialStatus = order.status
    const initialStock = (await prisma.productListing.findUnique({ where: { id: productListingId } }))?.currentStock
    const payment = await createPayment(order.id, { providerReference: "side-effect-test" });
    createdPaymentIds.push(payment.id);
    const afterOrder = await prisma.order.findUnique({ where: { id: order.id } })
    const afterStock = (await prisma.productListing.findUnique({ where: { id: productListingId } }))?.currentStock;
    const movements = await prisma.inventoryMovement.count({ where: { listingId: productListingId } });
    assert.strictEqual(afterOrder?.status, initialStatus);
    assert.strictEqual(afterStock, initialStock);
    assert.strictEqual(movements, 0);
  })
});
// ---------------------------------------------------------------------------
// Shared fixture teardown – runs once after all tests
after(async () => {
  // Clean up zero‑price listing/product if created
  if (zeroPriceListingId) {
    await prisma.productListing.deleteMany({ where: { id: { in: [zeroPriceListingId] } } });
  }
  if (zeroPriceProductId) {
    await prisma.legoProduct.deleteMany({ where: { id: { in: [zeroPriceProductId] } } });
  }
  // Clean up shared normal listing/product
  if (productListingId) {
    await prisma.productListing.deleteMany({ where: { id: { in: [productListingId] } } });
  }
  if (legoProductId) {
    await prisma.legoProduct.deleteMany({ where: { id: { in: [legoProductId] } } });
  }
  // Clean up shared address/user
  if (addressId) {
    await prisma.address.deleteMany({ where: { id: { in: [addressId] } } });
  }
  if (userId) {
    await prisma.user.deleteMany({ where: { id: { in: [userId] } } });
  }
  await prisma.$disconnect();
});
