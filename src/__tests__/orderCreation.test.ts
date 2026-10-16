import { strict as assert } from "node:assert";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { prisma } from "../prisma/runtime.js";
import { Decimal } from "@prisma/client/runtime/client";
import { createOrder } from "../domain/orders/orderService.js";
import type { CreateOrderInput } from "../domain/orders/orderValidator.js";
import {
  NoDefaultBillingAddressError,
  MultipleDefaultBillingAddressesError,
  ProductListingNotFoundError,
  ProductListingInactiveError,
  DuplicateProductListingError,
  InsufficientAvailableStockError,
} from "../domain/orders/orderErrors.js";
import { writeOffInventory } from "../domain/inventory/inventoryAdjustmentService.js";

const TEST_PREFIX = `orderTest-${Date.now()}`;
let userId: number;
let defaultAddressId: number;
let legoProductId: number;
let productListingIds: number[] = [];
let inactiveListingId: number | null = null;
const createdOrderIds: number[] = [];
const extraAddressIds: number[] = [];

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
    listings: product.productListings,
  };
}

async function recordOrder(input: CreateOrderInput) {
  const order = await createOrder(userId, input);
  createdOrderIds.push(order.id);
  return order;
}

before(async () => {
  const { user, address } = await createUserWithAddress();
  userId = user.id;
  defaultAddressId = address.id;
  const { productId, listingIds, listings } = await createProductAndListings(3);
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
  await prisma.productListing.updateMany({ where: { id: { in: productListingIds } }, data: { reservedStock: 0 } });
  await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: productListingIds } } });
  await prisma.inventoryAudit.deleteMany({ where: { sourceProductListingId: { in: productListingIds } } });
  await prisma.productListing.updateMany({ where: { id: { in: productListingIds } }, data: { currentStock: 10 } });
  if (extraAddressIds.length) {
    await prisma.address.deleteMany({ where: { id: { in: extraAddressIds } } });
    extraAddressIds.length = 0;
  }
  const addresses = await prisma.address.findMany({ where: { userId } });
  const defaults = addresses.filter((a) => a.isDefaultBilling);
  if (defaults.length !== 1) {
    await prisma.address.updateMany({ where: { userId, isDefaultBilling: true }, data: { isDefaultBilling: false } });
    await prisma.address.update({ where: { id: addresses[0].id }, data: { isDefaultBilling: true } });
  }
});

describe("Order Creation Domain Integration Tests", () => {
  it("successful order creation", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 2 }] });
    assert.strictEqual(order.userId, userId);
    assert.strictEqual(order.billingRecipientName, "Test User");
    assert.strictEqual(order.deliveryRecipientName, "Test User");
    assert.strictEqual(order.orderItems.length, 1);
  });

  it("multiple different product listings", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const,
      items: [
        { productListingId: productListingIds[0], quantity: 1 },
        { productListingId: productListingIds[1], quantity: 3 },
      ],
    });
    assert.strictEqual(order.orderItems.length, 2);
  });

  it("billing snapshot from default address", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    const addr = await prisma.address.findUnique({ where: { id: defaultAddressId } });
    assert.strictEqual(order.billingRecipientName, addr?.recipientName);
    assert.strictEqual(order.billingLine1, addr?.line1);
  });

  it("no default address throws error", async () => {
    await prisma.address.updateMany({ where: { userId }, data: { isDefaultBilling: false } });
    await assert.rejects(
      async () => recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] }),
      (e) => e instanceof NoDefaultBillingAddressError
    );
    const count = await prisma.order.count({ where: { userId } });
    assert.strictEqual(count, 0);
    await prisma.address.updateMany({ where: { userId }, data: { isDefaultBilling: true } });
  });

  it("multiple default addresses throws error", async () => {
    const second = await prisma.address.create({
      data: {
        userId,
        recipientName: "Second",
        line1: "456 Test Ave",
        city: "Testville",
        postcode: "67890",
        countryCode: "US",
        isDefaultBilling: true,
      },
    });
    extraAddressIds.push(second.id);
    await assert.rejects(
      async () => recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] }),
      (e) => e instanceof MultipleDefaultBillingAddressesError
    );
  });

  it("delivery override supplied", async () => {
    const deliveryDto = {
      recipientName: "Override",
      line1: "999 Override Rd",
      city: "Overtown",
      postcode: "00000",
      countryCode: "US",
    };
    const order = await recordOrder({ shippingMethod: "STANDARD" as const,
      items: [{ productListingId: productListingIds[0], quantity: 1 }],
      deliveryAddress: deliveryDto,
    });
    assert.strictEqual(order.deliveryRecipientName, "Override");
    assert.strictEqual(order.deliveryLine1, "999 Override Rd");
    const addr = await prisma.address.findUnique({ where: { id: defaultAddressId } });
    assert.strictEqual(order.billingRecipientName, addr?.recipientName);
  });

  it("nonexistent product listing throws error", async () => {
    await assert.rejects(
      async () => recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: 999999, quantity: 1 }] }),
      (e) => e instanceof ProductListingNotFoundError
    );
  });

  it("inactive product listing throws error", async () => {
    const inactive = await prisma.productListing.create({
      data: {

        legoProductId,
        condition: "NEW",
        originalPrice: new Decimal(30),
        active: false,
        currentStock: 5,
      },
    });
    inactiveListingId = inactive.id;
    await assert.rejects(
      async () => recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: inactive.id, quantity: 1 }] }),
      (e) => e instanceof ProductListingInactiveError
    );
  });

  it("duplicate productListingId in request throws error", async () => {
    await assert.rejects(
      async () =>
        recordOrder({ shippingMethod: "STANDARD" as const,
          items: [
            { productListingId: productListingIds[0], quantity: 1 },
            { productListingId: productListingIds[0], quantity: 2 },
          ],
        }),
      (e) => e instanceof DuplicateProductListingError
    );
  });

  it("unitPrice uses salePrice when present", async () => {
    const listing = productListingIds.find((id) => {
      // retrieve listing to check salePrice
      return true;
    });
    if (!listing) throw new Error("No listing with salePrice");
    const listingDetails = await prisma.productListing.findUnique({ where: { id: listing } });
    if (!listingDetails || listingDetails.salePrice === null) throw new Error("No salePrice present");
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: listing, quantity: 1 }] });
    const item = order.orderItems[0];
    assert.strictEqual(new Decimal(item.unitPrice.toString()).eq(listingDetails.salePrice!), true);
  });

  it("unitPrice uses originalPrice when salePrice is null", async () => {
    // Find a suite‑owned listing with salePrice === null
    const listing = await prisma.productListing.findFirst({
      where: { id: { in: productListingIds }, salePrice: null },
    });
    assert.ok(listing, "Expected a listing with null salePrice in the test data");
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 1 }] });
    const item = order.orderItems[0];
    assert.strictEqual(new Decimal(item.unitPrice.toString()).eq(listing.originalPrice), true);
  });

  it("lineTotal and totalAmount calculations", async () => {
    const ids = productListingIds.slice(0, 2);
    const items: any[] = ids.map((id) => ({ productListingId: id, quantity: 2 }));
    const order = await recordOrder({ shippingMethod: "STANDARD", items });
    const listings = await prisma.productListing.findMany({ where: { id: { in: ids } } });
    const listingsMap = new Map<number, any>();
    listings.forEach((l) => listingsMap.set(l.id, l));
    let expectedTotal = new Decimal(0);
    items.forEach((itm) => {
      const l = listingsMap.get(itm.productListingId)!;
      const unit = l.salePrice ?? l.originalPrice;
      expectedTotal = expectedTotal.add(new Decimal(unit).mul(itm.quantity));
    });
    assert.strictEqual(new Decimal(order.totalAmount.toString()).eq(expectedTotal.add("3.99")), true);
    order.orderItems.forEach((oi: any) => {
      const l = listingsMap.get(oi.productListingId)!;
      const unit = l.salePrice ?? l.originalPrice;
      const expectedLine = new Decimal(unit).mul(oi.quantity);
      assert.strictEqual(new Decimal(oi.lineTotal.toString()).eq(expectedLine), true);
    });
  });

  it("reserves available stock without changing physical stock and sets a 30-minute expiry", async () => {
    const listing = await prisma.productListing.findUnique({ where: { id: productListingIds[0] } });
    const before = new Date();
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 2 }] });
    const after = await prisma.productListing.findUnique({ where: { id: productListingIds[0] } });
    assert.strictEqual(after?.currentStock, listing?.currentStock);
    assert.strictEqual(after?.reservedStock, 2);
    assert.ok(order.reservationExpiresAt);
    assert.ok(order.reservationExpiresAt.getTime() >= before.getTime() + 30 * 60 * 1000 - 1000);
    assert.ok(order.reservationExpiresAt.getTime() <= Date.now() + 30 * 60 * 1000 + 1000);
  });

  it("rejects insufficient available stock and rolls back a multi-line reservation", async () => {
    await prisma.productListing.update({ where: { id: productListingIds[0] }, data: { currentStock: 2, reservedStock: 1 } });
    await prisma.productListing.update({ where: { id: productListingIds[1] }, data: { currentStock: 10, reservedStock: 0 } });
    await assert.rejects(
      () => recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[1], quantity: 2 }, { productListingId: productListingIds[0], quantity: 2 }] }),
      InsufficientAvailableStockError,
    );
    assert.strictEqual((await prisma.order.count({ where: { userId } })), 0);
    assert.strictEqual((await prisma.productListing.findUnique({ where: { id: productListingIds[1] } }))?.reservedStock, 0);
  });

  it("allows only one concurrent order to reserve the final unit", async () => {
    await prisma.productListing.update({ where: { id: productListingIds[0] }, data: { currentStock: 1, reservedStock: 0 } });
    const results = await Promise.allSettled([
      createOrder(userId, { shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] }),
      createOrder(userId, { shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] }),
    ]);
    assert.strictEqual(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.strictEqual(results.filter((result) => result.status === "rejected" && result.reason instanceof InsufficientAvailableStockError).length, 1);
    const successful = results.find((result) => result.status === "fulfilled");
    if (successful && successful.status === "fulfilled") createdOrderIds.push(successful.value.id);
    assert.strictEqual((await prisma.productListing.findUnique({ where: { id: productListingIds[0] } }))?.reservedStock, 1);
  });

  it("productListing currentStock remains unchanged", async () => {
    const listing = await prisma.productListing.findUnique({ where: { id: productListingIds[0] } });
    const stockBefore = listing!.currentStock;
    await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    const after = await prisma.productListing.findUnique({ where: { id: productListingIds[0] } });
    assert.strictEqual(after!.currentStock, stockBefore);
  });

  it("no InventoryMovement is created", async () => {
    // Count only movements for listings that belong to this test suite
    const countBefore = await prisma.inventoryMovement.count({
      where: { listingId: { in: productListingIds } },
    });
    await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    const countAfter = await prisma.inventoryMovement.count({
      where: { listingId: { in: productListingIds } },
    });
    assert.strictEqual(countAfter, countBefore);
  });

  it("order status defaults to PENDING", async () => {
    const order = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    assert.strictEqual(order.status, "PENDING");
  });

  it("atomicity – no partial order on invalid listing", async () => {
    const before = await prisma.order.count({ where: { userId } });
    await assert.rejects(
      async () =>
        recordOrder({ shippingMethod: "STANDARD" as const,
          items: [
            { productListingId: productListingIds[0], quantity: 1 },
            { productListingId: 999999, quantity: 1 },
          ],
        }),
      (e) => e instanceof ProductListingNotFoundError
    );
    const after = await prisma.order.count({ where: { userId } });
    assert.strictEqual(after, before);
  });

  it("lazily releases an expired reservation before a new reservation", async () => {
    const stockBefore = (await prisma.productListing.findUnique({ where: { id: productListingIds[0] } }))!.currentStock;
    const oldOrder = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    await prisma.order.update({ where: { id: oldOrder.id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });

    const newOrder = await recordOrder({ shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] });
    const oldState = await prisma.order.findUnique({ where: { id: oldOrder.id } });
    const listing = await prisma.productListing.findUnique({ where: { id: productListingIds[0] } });
    assert.strictEqual(oldState?.status, "EXPIRED");
    assert.strictEqual(listing?.currentStock, stockBefore);
    assert.strictEqual(listing?.reservedStock, 1);
    assert.ok(newOrder.reservationExpiresAt!.getTime() > Date.now() + 29 * 60 * 1000);
  });

  it("serializes reservation against a physical stock reduction", async () => {
    await prisma.productListing.update({ where: { id: productListingIds[0] }, data: { currentStock: 1, reservedStock: 0 } });
    const results = await Promise.allSettled([
      createOrder(userId, { shippingMethod: "STANDARD" as const, items: [{ productListingId: productListingIds[0], quantity: 1 }] }),
      writeOffInventory({ sourceProductListingId: productListingIds[0], quantity: 1, reason: "WAREHOUSE_DAMAGE", performedByUserId: userId }),
    ]);
    const listing = await prisma.productListing.findUnique({ where: { id: productListingIds[0] } });
    assert.ok((listing?.reservedStock ?? 0) >= 0);
    assert.ok((listing?.currentStock ?? 0) >= 0);
    assert.ok((listing?.reservedStock ?? 0) <= (listing?.currentStock ?? 0));
    assert.ok(results.filter((result) => result.status === "fulfilled").length === 1);
  });
});
