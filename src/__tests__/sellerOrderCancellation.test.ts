import { strict as assert } from "node:assert";
import { describe, it, before, after, afterEach } from "node:test";
import { prisma } from "../prisma/runtime.js";
import { Decimal } from "@prisma/client/runtime/client";
import { createOrder } from "../domain/orders/orderService.js";
import { cancelOrderByAdmin } from "../domain/orders/orderCancellationService.js";
import { OrderNotFoundError, OrderNotCancellableError } from "../domain/orders/orderCancellationErrors.js";
import { CancellationReason } from "../generated/prisma-client/enums.js";

const TEST_PREFIX = `sellerCancelTest-${Date.now()}`;
let buyerId: number;
let productListingIds: number[] = [];
const createdOrderIds: number[] = [];

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

async function createProductAndListings(count: number) {
  const product = await prisma.legoProduct.create({
    data: {
      setNumber: `${TEST_PREFIX}-SET`,
      title: `${TEST_PREFIX} Lego`,
      theme: "TEST",
      ageRecommendation: "8+",
      pieceCount: 100,
      productListings: {
        create: Array.from({ length: count }, (_, i) => ({

          condition: "NEW",
          originalPrice: new Decimal(20 + i * 5),
          salePrice: i % 2 === 0 ? new Decimal(15 + i * 5) : null,
          currentStock: 10,
          active: true,
        })),
      },
    },
    include: { productListings: true },
  });
  return {
    productId: product.id,
    listingIds: product.productListings.map((l) => l.id),
  };
}

async function recordOrder(input: { shippingMethod: "STANDARD"; items: { productListingId: number; quantity: number }[] }) {
  const order = await createOrder(buyerId, { shippingMethod: "STANDARD" as const, items: input.items });
  createdOrderIds.push(order.id);
  return order;
}

before(async () => {
  const { user } = await createUserWithAddress();
  buyerId = user.id;
  const { listingIds } = await createProductAndListings(2);
  productListingIds = listingIds;
});

afterEach(async () => {
  if (createdOrderIds.length) {
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    createdOrderIds.length = 0;
  }
  if (productListingIds.length) {
    await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: productListingIds } } });
  }
});

after(async () => {
  await prisma.productListing.deleteMany({ where: { id: { in: productListingIds } } });
  await prisma.legoProduct.deleteMany({ where: { setNumber: `${TEST_PREFIX}-SET` } });
  await prisma.user.deleteMany({ where: { id: buyerId } });
  await prisma.$disconnect();
});

describe("Seller Order Cancellation Domain Tests", () => {
  it("seller can cancel a customer's PENDING order", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    const cancelled = await cancelOrderByAdmin(order.id, CancellationReason.OUT_OF_STOCK, buyerId);
    assert.strictEqual(cancelled.status, "CANCELLED");
    assert.ok(cancelled.cancelledAt);
    assert.strictEqual(cancelled.cancelledBy, "SELLER");
    assert.strictEqual(cancelled.cancellationReason, CancellationReason.OUT_OF_STOCK);
  });

  it("seller can cancel a customer's CONFIRMED order", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
    const cancelled = await cancelOrderByAdmin(order.id, CancellationReason.PRICING_ERROR, buyerId);
    assert.strictEqual(cancelled.status, "CANCELLED");
  });

  it("cannot cancel an already CANCELLED order", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    await cancelOrderByAdmin(order.id, CancellationReason.FULFILMENT_ISSUE, buyerId);
    await assert.rejects(
      async () => cancelOrderByAdmin(order.id, CancellationReason.PRODUCT_UNAVAILABLE, buyerId),
      (err) => err instanceof OrderNotCancellableError,
    );
  });

  const nonCancellableStatuses = ["DISPATCHED", "COMPLETED", "RETURNED"] as const;
  nonCancellableStatuses.forEach((status) => {
    it(`${status} order cannot be cancelled by seller`, async () => {
      const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
      await prisma.order.update({ where: { id: order.id }, data: { status } });
      await assert.rejects(
        async () => cancelOrderByAdmin(order.id, CancellationReason.OTHER, buyerId),
        (err) => err instanceof OrderNotCancellableError,
      );
    });
  });

  it("no InventoryMovement and stock unchanged on seller cancellation", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    const initialStock = (await prisma.productListing.findUnique({ where: { id: productListingIds[0] } }))?.currentStock;
    await cancelOrderByAdmin(order.id, CancellationReason.OTHER, buyerId);
    const afterStock = (await prisma.productListing.findUnique({ where: { id: productListingIds[0] } }))?.currentStock;
    assert.strictEqual(afterStock, initialStock);
    const movements = await prisma.inventoryMovement.findMany({ where: { listingId: productListingIds[0] } });
    assert.strictEqual(movements.length, 0);
  });

  it("concurrent seller cancellation: exactly one succeeds", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    const promise1 = cancelOrderByAdmin(order.id, CancellationReason.OTHER, buyerId);
    const promise2 = cancelOrderByAdmin(order.id, CancellationReason.FULFILMENT_ISSUE, buyerId);
    const results = await Promise.allSettled([promise1, promise2]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.strictEqual(fulfilled.length, 1);
    assert.strictEqual(rejected.length, 1);
    const finalOrder = await prisma.order.findUnique({ where: { id: order.id } });
    assert.strictEqual(finalOrder?.status, "CANCELLED");
  });

  it("non‑existent order triggers OrderNotFoundError", async () => {
    const fakeId = 999999;
    await assert.rejects(
      async () => cancelOrderByAdmin(fakeId, CancellationReason.OTHER, buyerId),
      (err) => err instanceof OrderNotFoundError,
    );
  });
});
