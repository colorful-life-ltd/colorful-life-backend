import { strict as assert } from "node:assert";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { prisma } from "../prisma/runtime.js";
import { Decimal } from "@prisma/client/runtime/client";
import { createOrder } from "../domain/orders/orderService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import {
  OrderNotFoundError,
  OrderNotConfirmableError,
  InsufficientStockError,
} from "../domain/orders/orderConfirmationErrors.js";
import { InventoryMovementType, OrderStatus } from "../generated/prisma-client/enums.js";

// Common test data setup
const TEST_PREFIX = `orderConfirmTest-${Date.now()}`;
let userId: number;
let productListingIds: number[] = [];
let legoProductId: number;
const createdOrderIds: number[] = [];
let adminUserId: number;

async function createUserWithAddress(): Promise<void> {
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
  userId = user.id;
}

async function createProductAndListings(count: number): Promise<void> {
  const product = await prisma.legoProduct.create({
    data: {
      setNumber: `${TEST_PREFIX}-SET`,
      title: `${TEST_PREFIX} Lego`,
      theme: "TEST",
      ageRecommendation: "8+",
      pieceCount: 100,
      productListings: {
        create: Array.from({ length: count }, () => ({

          condition: "NEW",
          originalPrice: new Decimal(20),
          salePrice: new Decimal(15),
          currentStock: 10,
          active: true,
        })),
      },
    },
    include: { productListings: true },
  });
  legoProductId = product.id;
  productListingIds = product.productListings.map((l) => l.id);
}

async function recordOrder(input: { shippingMethod: "STANDARD"; items: { productListingId: number; quantity: number }[] }) {
  const order = await createOrder(userId, input);
  await prisma.payment.create({data:{orderId:order.id,amount:order.totalAmount,currency:"GBP",provider:"STRIPE",providerReference:crypto.randomUUID(),status:"SUCCEEDED",paidAt:new Date()}});
  createdOrderIds.push(order.id);
  return order;
}

before(async () => {
  await createUserWithAddress();

  const admin = await prisma.user.create({
    data: {
      email: `${TEST_PREFIX}-admin@example.com`,
      passwordHash: "hashed",
      emailVerified: true,
      role: "ADMIN",
    },
  });

  adminUserId = admin.id;

  await createProductAndListings(2);
});

after(async () => {
  await prisma.order.deleteMany({
    where: { id: { in: createdOrderIds } },
  });

  await prisma.inventoryMovement.deleteMany({
    where: {
      listingId: { in: productListingIds },
    },
  });

  await prisma.productListing.deleteMany({
    where: { legoProductId },
  });

  await prisma.legoProduct.deleteMany({
    where: { id: legoProductId },
  });

  await prisma.address.deleteMany({
    where: { userId },
  });

  await prisma.user.deleteMany({
    where: { id: { in: [userId, adminUserId] } },
  });
});

beforeEach(async () => {
  if (productListingIds.length) {
    await prisma.inventoryMovement.deleteMany({
      where: {
        listingId: { in: productListingIds },
        type: InventoryMovementType.WEBSITE_SALE,
      },
    });

    await prisma.productListing.updateMany({
      where: {
        id: { in: productListingIds },
      },
      data: {
        currentStock: 10,
        reservedStock: 0,
      },
    });
  }
});

afterEach(async () => {
  if (createdOrderIds.length) {
    await prisma.order.deleteMany({
      where: {
        id: { in: createdOrderIds },
      },
    });

    createdOrderIds.length = 0;
  }
});

describe("Order Confirmation Domain Service", () => {
  it("PENDING order confirms successfully and updates status", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 2 }] });
    const confirmed = await confirmOrder(adminUserId, order.id);
    assert.strictEqual(confirmed.status, OrderStatus.CONFIRMED);
    assert.strictEqual(confirmed.reservationExpiresAt, null);
  });

  it("stock is deducted correctly", async () => {
    const listingId = productListingIds[1];
    const startingStock = (await prisma.productListing.findUnique({ where: { id: listingId } }))?.currentStock ?? 0;
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: listingId, quantity: 3 }] });
    await confirmOrder(adminUserId, order.id);
    const afterStock = (await prisma.productListing.findUnique({ where: { id: listingId } }))?.currentStock ?? 0;
    assert.strictEqual(afterStock, startingStock - 3);
  });

  it("creates WEBSITE_SALE InventoryMovement with negative quantity", async () => {
    const listingId = productListingIds[0];
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: listingId, quantity: 1 }] });
    await confirmOrder(adminUserId, order.id);
    const movements = await prisma.inventoryMovement.findMany({ where: { listingId, type: InventoryMovementType.WEBSITE_SALE } });
    assert.strictEqual(movements.length, 1);
    assert.strictEqual(movements[0].quantityChange, -1);
  });

  it("rejects a PENDING order whose reservation is missing", async () => {
    const listingId = productListingIds[0];
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: listingId, quantity: 1 }] });
    await prisma.productListing.update({ where: { id: listingId }, data: { reservedStock: 0 } });
    await assert.rejects(() => confirmOrder(adminUserId, order.id), InsufficientStockError);
    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    assert.strictEqual(persisted?.status, OrderStatus.PENDING);
  });

  it("multiple items deduct respective listings correctly", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [
      { productListingId: productListingIds[0], quantity: 1 },
      { productListingId: productListingIds[1], quantity: 2 },
    ] });
    await confirmOrder(adminUserId, order.id);
    const after0 = await prisma.productListing.findUnique({ where: { id: productListingIds[0] } });
    const after1 = await prisma.productListing.findUnique({ where: { id: productListingIds[1] } });
    assert.strictEqual(after0?.currentStock, 9); // 10-1
    assert.strictEqual(after1?.currentStock, 8); // 10-2
  });

  it("insufficient stock rejects confirmation and rolls back", async () => {
    const listingId = productListingIds[0];
    const startingStock = (await prisma.productListing.findUnique({ where: { id: listingId } }))?.currentStock ?? 0;
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: listingId, quantity: 1 }] });
    await prisma.productListing.update({ where: { id: listingId }, data: { currentStock: 0, reservedStock: 0 } });
    await assert.rejects(() => confirmOrder(adminUserId, order.id), (err) => err instanceof InsufficientStockError);
    const afterStock = (await prisma.productListing.findUnique({ where: { id: listingId } }))?.currentStock ?? 0;
    assert.strictEqual(afterStock, 0); // no deduction after the failed conversion
  });

  it("insufficient stock creates no WEBSITE_SALE movement", async () => {
    const listingId = productListingIds[0];
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: listingId, quantity: 1 }] });
    await prisma.productListing.update({ where: { id: listingId }, data: { currentStock: 0, reservedStock: 0 } });
    await assert.rejects(() => confirmOrder(adminUserId, order.id), (err) => err instanceof InsufficientStockError);
    const movements = await prisma.inventoryMovement.findMany({ where: { listingId, type: InventoryMovementType.WEBSITE_SALE } });
    assert.strictEqual(movements.length, 0);
  });

  it("CONFIRMED order cannot be confirmed again", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    await confirmOrder(adminUserId, order.id);
    await assert.rejects(() => confirmOrder(adminUserId, order.id), (err) => err instanceof OrderNotConfirmableError);
  });

  it("CANCELLED order cannot be confirmed", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });
    await assert.rejects(() => confirmOrder(adminUserId, order.id), (err) => err instanceof OrderNotConfirmableError);
  });

  it("DISPATCHED order cannot be confirmed", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.DISPATCHED } });
    await assert.rejects(() => confirmOrder(adminUserId, order.id), (err) => err instanceof OrderNotConfirmableError);
  });

  it("concurrent confirmation of same order succeeds once", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    const [res1, res2] = await Promise.allSettled([confirmOrder(adminUserId, order.id), confirmOrder(adminUserId, order.id)]);
    const fulfilled = [res1, res2].filter((r) => r.status === "fulfilled");
    const rejected = [res1, res2].filter((r) => r.status === "rejected");
    assert.strictEqual(fulfilled.length, 1);
    assert.strictEqual(rejected.length, 1);
    assert(rejected[0].reason instanceof OrderNotConfirmableError || rejected[0].reason instanceof InsufficientStockError);
  });

  it("two reserved PENDING orders can consume their reservations without overselling", async () => {
    const listingId = productListingIds[0];
    const order1 = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: listingId, quantity: 5 }] });
    const order2 = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: listingId, quantity: 5 }] });
    const results = await Promise.allSettled([confirmOrder(adminUserId, order1.id), confirmOrder(adminUserId, order2.id)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    assert.strictEqual(fulfilled.length, 2);
    const afterStock = (await prisma.productListing.findUnique({ where: { id: listingId } }))?.currentStock ?? 0;
    const afterListing = await prisma.productListing.findUnique({ where: { id: listingId } });
    assert.strictEqual(afterStock, 0);
    assert.strictEqual(afterListing?.reservedStock, 0);
      });
});
