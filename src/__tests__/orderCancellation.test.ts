import { strict as assert } from "node:assert";
import { describe, it, before, after, afterEach } from "node:test";
import { prisma } from "../prisma/runtime.js";
import { Decimal } from "@prisma/client/runtime/client";
import { createOrder } from "../domain/orders/orderService.js";
import { cancelOrder, cancelOrderByAdmin } from "../domain/orders/orderCancellationService.js";
import { OrderNotFoundError, OrderNotCancellableError, InsufficientReservedStockError } from "../domain/orders/orderCancellationErrors.js";
import { CancellationReason, InventoryMovementType } from "../generated/prisma-client/enums.js";

const TEST_PREFIX = `orderCancelTest-${Date.now()}`;
let userId: number;
let legoProductId: number;
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
          countryCode: "GB",
          isDefaultBilling: true,
        },
      },
    },
    include: { addresses: true },
  });
  return { user, address: user.addresses[0] };
}

async function createAdminUserWithAddress() {
  const user = await prisma.user.create({
    data: {
      email: `${TEST_PREFIX}-admin@example.com`,
      passwordHash: "hashed",
      emailVerified: true,
      role: "ADMIN",
      addresses: {
        create: {
          recipientName: "Admin User",
          line1: "Admin St 1",
          city: "Adminville",
          postcode: "99999",
          countryCode: "GB",
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
  const order = await createOrder(userId, input);
  createdOrderIds.push(order.id);
  return order;
}

before(async () => {
  const { user } = await createUserWithAddress();
  userId = user.id;
  const { productId, listingIds } = await createProductAndListings(2);
  legoProductId = productId;
  productListingIds = listingIds;
});

after(async () => {
  await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await prisma.productListing.deleteMany({ where: { legoProductId } });
  await prisma.legoProduct.deleteMany({ where: { id: legoProductId } });
  await prisma.address.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
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

describe("Order Cancellation Domain Tests", () => {
  it("customer can cancel own PENDING order", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    const cancelled = await cancelOrder(userId, order.id, CancellationReason.CHANGED_MIND);
    assert.strictEqual(cancelled.status, "CANCELLED");
    assert.ok(cancelled.cancelledAt);
    assert.strictEqual(cancelled.cancelledBy, "CUSTOMER");
    assert.strictEqual(cancelled.cancellationReason, CancellationReason.CHANGED_MIND);
    const listing = await prisma.productListing.findUnique({ where: { id: productListingIds[0] } });
    assert.strictEqual(listing?.currentStock, 10);
    assert.strictEqual(listing?.reservedStock, 0);
    assert.strictEqual(cancelled.reservationExpiresAt, null);
  });

  it("customer can cancel own CONFIRMED order", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[1], quantity: 1 }] });
    const before = (await prisma.productListing.findUnique({ where: { id: productListingIds[1] } }))!.currentStock;
    await prisma.productListing.update({ where: { id: productListingIds[1] }, data: { currentStock: { decrement: 1 }, reservedStock: { decrement: 1 } } });
    await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
    const cancelled = await cancelOrder(userId, order.id, CancellationReason.ORDERED_BY_MISTAKE);
    assert.strictEqual(cancelled.status, "CANCELLED");
    assert.strictEqual((await prisma.productListing.findUnique({ where: { id: productListingIds[1] } }))!.currentStock, before);
    assert.strictEqual((await prisma.productListing.findUnique({ where: { id: productListingIds[1] } }))!.reservedStock, 0);
    const movement = await prisma.inventoryMovement.findFirstOrThrow({ where: { listingId: productListingIds[1], type: InventoryMovementType.ORDER_CANCELLATION_RETURN } });
    assert.strictEqual(movement.quantityChange, 1);
  });

  it("restores multiple confirmed order items and never restores twice", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [
      { productListingId: productListingIds[0], quantity: 2 },
      { productListingId: productListingIds[1], quantity: 3 },
    ] });
    const before = await prisma.productListing.findMany({ where: { id: { in: productListingIds } }, select: { id: true, currentStock: true } });
    for (const item of [{ id: productListingIds[0], quantity: 2 }, { id: productListingIds[1], quantity: 3 }]) {
      await prisma.productListing.update({ where: { id: item.id }, data: { currentStock: { decrement: item.quantity }, reservedStock: { decrement: item.quantity } } });
    }
    await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
    await cancelOrder(userId, order.id, CancellationReason.CHANGED_MIND);
    await assert.rejects(() => cancelOrder(userId, order.id, CancellationReason.ORDERED_BY_MISTAKE), OrderNotCancellableError);
    for (const listing of before) {
      assert.strictEqual((await prisma.productListing.findUnique({ where: { id: listing.id } }))!.currentStock, listing.currentStock);
    }
    assert.strictEqual(await prisma.inventoryMovement.count({ where: { listingId: { in: productListingIds }, type: InventoryMovementType.ORDER_CANCELLATION_RETURN } }), 2);
  });

  it("concurrent confirmed cancellations restore inventory only once", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    const before = (await prisma.productListing.findUnique({ where: { id: productListingIds[0] } }))!.currentStock;
    await prisma.productListing.update({ where: { id: productListingIds[0] }, data: { currentStock: { decrement: 1 }, reservedStock: { decrement: 1 } } });
    await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
    const results = await Promise.allSettled([
      cancelOrder(userId, order.id, CancellationReason.CHANGED_MIND),
      cancelOrder(userId, order.id, CancellationReason.ORDERED_BY_MISTAKE),
    ]);
    assert.strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.strictEqual((await prisma.productListing.findUnique({ where: { id: productListingIds[0] } }))!.currentStock, before);
    assert.strictEqual(await prisma.inventoryMovement.count({ where: { listingId: productListingIds[0], type: InventoryMovementType.ORDER_CANCELLATION_RETURN } }), 1);
  });

  it("cannot cancel another customer's order", async () => {
    const otherUser = await prisma.user.create({
      data: {
        email: `${TEST_PREFIX}-other@example.com`,
        passwordHash: "hashed",
        emailVerified: true,
        role: "CUSTOMER",
        addresses: {
          create: {
            recipientName: "Other User",
            line1: "456 Test Ave",
            city: "Testville",
            postcode: "67890",
            countryCode: "GB",
            isDefaultBilling: true,
          },
        },
      },
      include: { addresses: true },
    });
    const order = await createOrder(otherUser.id, { shippingMethod: "STANDARD" as const,
      items: [{ productListingId: productListingIds[0], quantity: 1 }],
    });
    await assert.rejects(
      async () => cancelOrder(userId, order.id, CancellationReason.CHANGED_MIND),
      (err) => err instanceof OrderNotFoundError,
    );
    const after = await prisma.order.findUnique({ where: { id: order.id } });
    assert.strictEqual(after?.status, "PENDING");
    assert.strictEqual(after?.cancelledAt, null);
    assert.strictEqual(after?.cancellationReason, null);
    await prisma.order.deleteMany({ where: { id: { in: [order.id] } } });
    await prisma.user.deleteMany({ where: { id: otherUser.id } });
  });

  it("already CANCELLED order cannot be cancelled again", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    const cancelled = await cancelOrder(userId, order.id, CancellationReason.CHANGED_MIND);
    const originalCancelledAt = cancelled.cancelledAt;
    const originalReason = cancelled.cancellationReason;
    await assert.rejects(
      async () => cancelOrder(userId, order.id, CancellationReason.ORDERED_BY_MISTAKE),
      (err) => err instanceof OrderNotCancellableError,
    );
    const after = await prisma.order.findUnique({ where: { id: order.id } });
    assert.strictEqual(after?.status, "CANCELLED");
    assert.deepStrictEqual(after?.cancelledAt, originalCancelledAt);
    assert.strictEqual(after?.cancellationReason, originalReason);
  });

  const nonCancellableStatuses = ["DISPATCHED", "COMPLETED", "RETURNED"] as const;
  nonCancellableStatuses.forEach((status) => {
    it(`${status} order cannot be cancelled`, async () => {
      const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
      await prisma.order.update({ where: { id: order.id }, data: { status } });
      await assert.rejects(
        async () => cancelOrder(userId, order.id, CancellationReason.CHANGED_MIND),
        (err) => err instanceof OrderNotCancellableError,
      );
    });
  });

  it("no InventoryMovement and stock unchanged on cancellation", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    const initialStock = (await prisma.productListing.findUnique({ where: { id: productListingIds[0] } }))?.currentStock;
    await cancelOrder(userId, order.id, CancellationReason.CHANGED_MIND);
    const afterStock = (await prisma.productListing.findUnique({ where: { id: productListingIds[0] } }))?.currentStock;
    assert.strictEqual(afterStock, initialStock);
    const movements = await prisma.inventoryMovement.findMany({ where: { listingId: productListingIds[0] } });
    assert.strictEqual(movements.length, 0);
  });

  it("fails atomically when a PENDING reservation is missing", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    await prisma.productListing.update({ where: { id: productListingIds[0] }, data: { reservedStock: 0 } });
    await assert.rejects(() => cancelOrder(userId, order.id, CancellationReason.CHANGED_MIND), InsufficientReservedStockError);
    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    const listing = await prisma.productListing.findUnique({ where: { id: productListingIds[0] } });
    assert.strictEqual(persisted?.status, "PENDING");
    assert.strictEqual(listing?.currentStock, 10);
    assert.strictEqual(listing?.reservedStock, 0);
  });

  it("concurrent cancellation: exactly one succeeds", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    const promise1 = cancelOrder(userId, order.id, CancellationReason.CHANGED_MIND);
    const promise2 = cancelOrder(userId, order.id, CancellationReason.ORDERED_BY_MISTAKE);
    const results = await Promise.allSettled([promise1, promise2]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.strictEqual(fulfilled.length, 1);
    assert.strictEqual(rejected.length, 1);
    const finalOrder = await prisma.order.findUnique({ where: { id: order.id } });
    assert.strictEqual(finalOrder?.status, "CANCELLED");
    assert.ok(finalOrder?.cancelledAt);
  });
});
