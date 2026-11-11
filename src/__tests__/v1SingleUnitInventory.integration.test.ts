import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { prisma } from "../prisma/runtime.js";
import { reconcileStocktake } from "../domain/inventory/inventoryAdjustmentService.js";
import { createOrder } from "../domain/orders/orderService.js";
import { expireOrderReservation } from "../domain/orders/orderExpiryService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import { InsufficientAvailableStockError } from "../domain/orders/orderErrors.js";
import { OrderNotConfirmableError } from "../domain/orders/orderConfirmationErrors.js";
import { getCatalogueProductById } from "../domain/products/productCatalogueService.js";

// V1 publish plan: every product gets exactly one sellable unit through the existing,
// audited stocktake operation (no new stock system). This pins the lifecycle that plan
// relies on for a listing whose stock is exactly 1.
const PREFIX = `v1-single-unit-${Date.now()}`;
let customerId: number;
let actorId: number;
let createdActor = false;
let productId: number;
let listingId: number;
const orderIds: number[] = [];

const listing = () => prisma.productListing.findUniqueOrThrow({ where: { id: listingId }, select: { currentStock: true, reservedStock: true } });
const availability = async () => (await getCatalogueProductById(productId))?.availability;
const order = () => createOrder(customerId, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listingId, quantity: 1 }] });

describe("V1 single sellable unit per product", { concurrency: 1 }, () => {
  before(async () => {
    const customer = await prisma.user.create({ data: {
      email: `${PREFIX}@example.com`, passwordHash: "hashed", emailVerified: true, role: "CUSTOMER",
      addresses: { create: { recipientName: "Test User", line1: "1 Test St", city: "Testville", postcode: "AB1 2CD", countryCode: "GB", isDefaultBilling: true } },
    } });
    customerId = customer.id;
    // Production has exactly one ADMIN; reuse an existing one rather than violating the single-admin index.
    const admin = await prisma.user.findFirst({ where: { role: "ADMIN", deletedAt: null }, select: { id: true } });
    if (admin) actorId = admin.id;
    else { actorId = (await prisma.user.create({ data: { email: `${PREFIX}-admin@example.com`, passwordHash: "hashed", emailVerified: true, role: "ADMIN" } })).id; createdActor = true; }
    // Matches the 42 Production products today: one active, published NEW listing with zero stock.
    const product = await prisma.legoProduct.create({ data: {
      setNumber: `${PREFIX}-SET`, title: `${PREFIX} set`, theme: "TEST", ageRecommendation: "8+", pieceCount: 100,
      productListings: { create: { condition: "NEW", originalPrice: 20, currentStock: 0, reservedStock: 0, active: true } },
    }, include: { productListings: true } });
    productId = product.id;
    listingId = product.productListings[0].id;
  });

  after(async () => {
    await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await prisma.inventoryMovement.deleteMany({ where: { listingId } });
    await prisma.productListing.deleteMany({ where: { id: listingId } });
    await prisma.legoProduct.deleteMany({ where: { id: productId } });
    await prisma.address.deleteMany({ where: { userId: customerId } });
    await prisma.user.deleteMany({ where: { id: { in: createdActor ? [customerId, actorId] : [customerId] } } });
  });

  it("starts Sold Out with zero stock", async () => {
    assert.deepEqual(await listing(), { currentStock: 0, reservedStock: 0 });
    assert.equal(await availability(), "OUT_OF_STOCK");
  });

  it("the audited stocktake sets exactly one unit once, and a replay adds nothing", async () => {
    const input = { productListingId: listingId, actualStock: 1, performedByUserId: actorId, reasonNote: "V1 publish: one sellable unit (owner approved)" };
    const key = `v1-single-unit:${listingId}`;
    const first = await reconcileStocktake(input, key);
    const replay = await reconcileStocktake(input, key);
    assert.deepEqual(replay, JSON.parse(JSON.stringify(first)));
    // A second, differently keyed stocktake to the same count is a no-op, never a second unit.
    assert.equal((await reconcileStocktake(input, `${key}:again`)).movement, null);
    assert.deepEqual(await listing(), { currentStock: 1, reservedStock: 0 });
    const movements = await prisma.inventoryMovement.findMany({ where: { listingId } });
    assert.equal(movements.length, 1);
    assert.equal(movements[0].type, "MANUAL_ADJUSTMENT");
    assert.equal(movements[0].quantityChange, 1);
    assert.equal(movements[0].performedByUserId, actorId);
    assert.equal(await availability(), "IN_STOCK");
  });

  it("concurrent checkouts reserve the single unit at most once and the product shows Sold Out while held", async () => {
    const results = await Promise.allSettled([order(), order(), order()]);
    const won = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof order>>> => r.status === "fulfilled");
    assert.equal(won.length, 1);
    assert.ok(results.every(r => r.status === "fulfilled" || r.reason instanceof InsufficientAvailableStockError));
    orderIds.push(won[0].value.id);
    assert.deepEqual(await listing(), { currentStock: 1, reservedStock: 1 });
    assert.equal(await availability(), "OUT_OF_STOCK");
  });

  it("an abandoned (expired) checkout releases the unit exactly once", async () => {
    const [held] = orderIds;
    const later = new Date(Date.now() + 86_400_000);
    assert.equal((await expireOrderReservation(held, later))?.status, "EXPIRED");
    assert.equal(await expireOrderReservation(held, later), null);
    assert.deepEqual(await listing(), { currentStock: 1, reservedStock: 0 });
    assert.equal(await availability(), "IN_STOCK");
  });

  it("a paid order consumes the unit once; the product becomes Sold Out and cannot be sold again", async () => {
    const paid = await order();
    orderIds.push(paid.id);
    await prisma.payment.create({ data: { orderId: paid.id, amount: paid.totalAmount, provider: "MANUAL", providerReference: randomUUID(), status: "SUCCEEDED", paidAt: new Date() } });
    const confirmations = await Promise.allSettled([confirmOrder(actorId, paid.id), confirmOrder(actorId, paid.id)]);
    assert.equal(confirmations.filter(r => r.status === "fulfilled").length, 1);
    assert.ok(confirmations.every(r => r.status === "fulfilled" || r.reason instanceof OrderNotConfirmableError));
    assert.deepEqual(await listing(), { currentStock: 0, reservedStock: 0 });
    const sales = await prisma.inventoryMovement.findMany({ where: { listingId, type: "WEBSITE_SALE" } });
    assert.deepEqual(sales.map(m => m.quantityChange), [-1]);
    assert.equal(await availability(), "OUT_OF_STOCK");
    await assert.rejects(order(), InsufficientAvailableStockError);
    // History is append-only: the stocktake and the sale both remain.
    assert.deepEqual((await prisma.inventoryMovement.findMany({ where: { listingId }, orderBy: { id: "asc" } })).map(m => [m.type, m.quantityChange]),
      [["MANUAL_ADJUSTMENT", 1], ["WEBSITE_SALE", -1]]);
  });
});
