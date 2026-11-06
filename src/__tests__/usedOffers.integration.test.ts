import { dispatchOrder } from "../domain/orders/orderDispatchService.js";
import {historicalUnpaidConfirmedFixture} from "./fixtures/historicalUnpaidOrder.js";
import {recordVerifiedPayment} from "./fixtures/verifiedPayment.js";
import { OrderReturnEligibilityError } from "../domain/orders/returnInventorySafety.js";
import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import { Pool, type PoolClient } from "pg";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { createOrder } from "../domain/orders/orderService.js";
import { createUsedOfferService } from "../domain/usedOffers/usedOfferService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import { cancelOrder, cancelOrderByAdmin } from "../domain/orders/orderCancellationService.js";
import { authorizeOrderReturn, completeOrderReturn, inspectOrderReturn, InvalidInspectionRestockConditionError, receiveOrderReturn, requestOrderReturn } from "../domain/orders/orderReturnService.js";
import { ReturnReason, ReturnShippingPayer } from "../generated/prisma-client/enums.js";
import type { ImageStorage, ImageUploadInput, StoredImage } from "../infrastructure/imageStorage/imageStorage.js";

const png = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082", "hex"));
class FakeStorage implements ImageStorage {
  uploaded: string[] = []; deleted: string[] = []; failOnUploadNumber = 0;
  async upload(input: ImageUploadInput): Promise<StoredImage> { if (this.failOnUploadNumber && this.uploaded.length + 1 === this.failOnUploadNumber) throw new Error("upload failed"); const publicId = `condition/${input.publicId}`; this.uploaded.push(publicId); return { publicId, secureUrl: `https://images.test/${publicId}` }; }
  async delete(publicId: string) { this.deleted.push(publicId); }
}
const products: number[] = [], listings: number[] = [], users: number[] = [];
const categories: number[] = [];
const orders: number[] = [];
let server: Server, base: string, storage: FakeStorage;
let adminToken: string, customerToken: string;
let adminId: number;
const sqlPool = new Pool({ connectionString: config.DATABASE_URL, max: 4 });
before(async () => {
  storage = new FakeStorage(); server = createApp(storage).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("server address unavailable");
  base = `http://localhost:${address.port}`;
  async function createUser(role: "ADMIN" | "CUSTOMER") {
    const user = await prisma.user.create({ data: { email: `${role}-${randomUUID()}@example.test`, passwordHash: "test", role } });
    users.push(user.id); if (role === "ADMIN") adminId = user.id;
    return jwt.sign({ id: user.id, role }, config.JWT_SECRET, { expiresIn: "1h" });
  }
  adminToken = await createUser("ADMIN"); customerToken = await createUser("CUSTOMER");
});
afterEach(async () => {
  if (orders.length) await prisma.order.deleteMany({ where: { id: { in: orders } } });
  if (listings.length) {
    await prisma.cartItem.deleteMany({ where: { productListingId: { in: listings } } });
    await prisma.inventoryAudit.deleteMany({ where: { OR: [{ sourceProductListingId: { in: listings } }, { targetProductListingId: { in: listings } }] } });
    await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listings } } });
    await prisma.$executeRawUnsafe('ALTER TABLE "UsedConditionPhoto" DISABLE TRIGGER "UsedConditionPhoto_terminal_immutable"');
    await prisma.$executeRawUnsafe('ALTER TABLE "ProductListing" DISABLE TRIGGER "ProductListing_used_lifecycle_guard"');
    try { await prisma.productListing.deleteMany({ where: { id: { in: listings } } }); }
    finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "ProductListing" ENABLE TRIGGER "ProductListing_used_lifecycle_guard"');
      await prisma.$executeRawUnsafe('ALTER TABLE "UsedConditionPhoto" ENABLE TRIGGER "UsedConditionPhoto_terminal_immutable"');
    }
  }
  if (products.length) await prisma.legoProduct.deleteMany({ where: { id: { in: products } } });
  if (categories.length) await prisma.category.deleteMany({ where: { id: { in: categories } } });
  listings.length = products.length = 0;
  categories.length = 0;
  orders.length = 0;
  storage.deleted.push(...storage.uploaded); storage.uploaded.length = 0;
  storage.failOnUploadNumber = 0;
});
after(async () => { await prisma.user.deleteMany({ where: { id: { in: users } } }); await sqlPool.end(); await prisma.$disconnect(); await new Promise<void>((resolve) => server.close(() => resolve())); });

async function category() {
  const row = await prisma.category.create({ data: { name: `Used Feature ${randomUUID()}` } });
  categories.push(row.id); return row;
}
async function product(categoryId?: number) {
  const row = await prisma.legoProduct.create({ data: { setNumber: `USED-${randomUUID()}`, title: "Used test product", theme: "TEST", ageRecommendation: "8+", pieceCount: 100, categoryId } });
  products.push(row.id); return row;
}
function form(description = "Small crease on the top right corner", photos = 1, extras: Record<string, string> = {}) {
  const body = new FormData(); body.append("originalPrice", "49.99"); body.append("salePrice", "39.99"); body.append("damageDescription", description);
  Object.entries(extras).forEach(([k, v]) => body.append(k, v));
  for (let i = 0; i < photos; i++) body.append("conditionPhotos", new Blob([Buffer.from(png)], { type: "image/png" }), `damage-${i}.png`);
  return body;
}
function request(path: string, token: string | undefined, body?: FormData) {
  const headers = new Headers(); if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(base + path, { method: "POST", headers, body });
}
async function waitForBlockedTransaction(observer: PoolClient, blockedPid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blocked: boolean }>("SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked", [blockedPid]);
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`PostgreSQL backend ${blockedPid} did not block on the listing lock`);
}
async function withTwoSqlConnections<T>(run: (first: PoolClient, second: PoolClient) => Promise<T>) {
  const first = await sqlPool.connect();
  const second = await sqlPool.connect();
  try { return await run(first, second); }
  finally {
    await first.query("ROLLBACK").catch(() => {});
    await second.query("ROLLBACK").catch(() => {});
    first.release(); second.release();
  }
}
async function createOffer(productId: number, data = form()) { return request(`/products/${productId}/used-offers`, adminToken, data); }

describe("per-item Used offers", () => {
  it("requires Admin and validates required evidence and disallows caller stock", async () => {
    const lego = await product();
    assert.equal((await request(`/products/${lego.id}/used-offers`, undefined, form())).status, 401);
    assert.equal((await request(`/products/${lego.id}/used-offers`, customerToken, form())).status, 403);
    assert.equal((await createOffer(lego.id, form("   "))).status, 400);
    assert.equal((await createOffer(lego.id, form("damage", 0))).status, 400);
    assert.equal((await createOffer(lego.id, form("damage", 4))).status, 400);
    assert.equal((await createOffer(2147483647)).status, 404);
    assert.equal((await createOffer(lego.id, form("damage", 1, { currentStock: "8" }))).status, 400);
    assert.equal(await prisma.productListing.count({ where: { legoProductId: lego.id } }), 0);
    await assert.rejects(() => prisma.productListing.create({ data: { legoProductId: lego.id, condition: "USED_LIKE_NEW", originalPrice: 20, currentStock: 2, damageDescription: "invalid pooled stock", usedLifecycle: "AVAILABLE" } }));
    await assert.rejects(() => prisma.productListing.create({ data: {
      legoProductId: lego.id, condition: "USED_LIKE_NEW", originalPrice: 20, currentStock: 1,
      damageDescription: "Missing condition photos", usedLifecycle: "AVAILABLE",
    } }));
  });

  it("creates one exact item with its own ordered photos and price", async () => {
    const lego = await product();
    const response = await createOffer(lego.id, form("Creased outer box", 2));
    assert.equal(response.status, 201);
    const listing = await response.json(); listings.push(listing.id);
    assert.equal(listing.legoProductId, lego.id); assert.equal(listing.condition, "USED_LIKE_NEW");
    assert.equal(listing.currentStock, 1); assert.equal(listing.usedLifecycle, "AVAILABLE");
    assert.equal(listing.damageDescription, "Creased outer box"); assert.equal(Number(listing.originalPrice), 49.99); assert.equal(Number(listing.salePrice), 39.99);
    assert.deepEqual(listing.usedConditionPhotos.map((p: any) => p.sortOrder), [0, 1]);
    assert.deepEqual(listing.legoProduct.productImages, []);
    assert.equal(await prisma.inventoryMovement.count({ where: { listingId: listing.id, quantityChange: 1 } }), 1);

    const customer = await prisma.user.create({ data: { email: `buyer-${randomUUID()}@example.test`, passwordHash: "test", emailVerified: true,
      addresses: { create: { recipientName: "Buyer", line1: "1 High Street", city: "London", postcode: "SW1A 1AA", countryCode: "GB", isDefaultBilling: true } } } });
    users.push(customer.id);
    await assert.rejects(() => createOrder(customer.id, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 2 }] }));
    const order = await createOrder(customer.id, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 1 }] }); orders.push(order.id);
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    assert.equal(item.productListingId, listing.id); assert.equal(item.conditionSnapshot, "USED_LIKE_NEW");
    assert.equal(item.damageDescriptionSnapshot, "Creased outer box");
    assert.deepEqual(item.conditionPhotoSnapshot, listing.usedConditionPhotos.map((p: any) => ({ id: p.id, url: p.url, publicId: p.publicId, sortOrder: p.sortOrder })));
    assert.equal(Number(item.unitPrice), 39.99);

    const adjustment = await fetch(`${base}/products/${listing.id}/inventory-adjustments`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ quantity: 1 }) });
    assert.equal(adjustment.status, 409);
    const stocktake = await fetch(`${base}/inventory/stocktakes`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ productListingId: listing.id, actualStock: 2 }) });
    assert.equal(stocktake.status, 400);
    const patch = await fetch(`${base}/products/${listing.id}`, { method: "PATCH", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ condition: "NEW" }) });
    assert.equal(patch.status, 400);
    const stockPatch = await fetch(`${base}/products/${listing.id}`, { method: "PATCH", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ currentStock: 2 }) });
    assert.equal(stockPatch.status, 400);
  });

  it("allows only one Used unit in a customer's cart", async () => {
    const lego = await product();
    const response = await createOffer(lego.id);
    const listing = await response.json(); listings.push(listing.id);
    const headers = { Authorization: `Bearer ${customerToken}`, "Content-Type": "application/json" };
    const add = () => fetch(`${base}/cart/items`, { method: "POST", headers, body: JSON.stringify({ productListingId: listing.id, quantity: 1 }) });
    assert.equal((await add()).status, 200);
    const cart = await (await fetch(`${base}/cart`, { headers })).json();
    assert.equal(cart.items[0].productListingId, listing.id);
    assert.equal(cart.items[0].productListing.availableStock, 1);
    assert.equal((await add()).status, 409);
    assert.equal((await fetch(`${base}/cart/items/${listing.id}`, { method: "PATCH", headers, body: JSON.stringify({ quantity: 2 }) })).status, 409);
  });

  it("permits a new copy after historical Used stock is zero, and serializes concurrent creation", async () => {
    const lego = await product();
    const firstResponse = await createOffer(lego.id, form("First item's damaged corner", 1));
    assert.equal(firstResponse.status, 201);
    const historical = await firstResponse.json(); listings.push(historical.id);
    await prisma.productListing.update({ where: { id: historical.id }, data: { currentStock: 0, usedLifecycle: "SOLD" } });
    const responses = await Promise.all([createOffer(lego.id), createOffer(lego.id)]);
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    const rows = await prisma.productListing.findMany({ where: { legoProductId: lego.id, condition: "USED_LIKE_NEW", currentStock: 1 } });
    assert.equal(rows.length, 1); listings.push(rows[0]!.id);
  });

  it("converts exactly one unreserved NEW unit to a new Used listing with paired audit", async () => {
    const lego = await product();
    const source = await prisma.productListing.create({ data: { legoProductId: lego.id, condition: "NEW", originalPrice: 60, currentStock: 4 } }); listings.push(source.id);
    const body = form("Corner crushed", 1, { sourceNewListingId: String(source.id), reason: "PACKAGING_DAMAGE" });
    const response = await request(`/inventory/condition-conversions/${lego.id}`, adminToken, body);
    assert.equal(response.status, 201, await response.clone().text());
    const target = await response.json(); listings.push(target.id);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: source.id } })).currentStock, 3);
    assert.equal(target.currentStock, 1);
    const movements = await prisma.inventoryMovement.findMany({ where: { listingId: { in: [source.id, target.id] } }, orderBy: { id: "asc" } });
    assert.deepEqual(movements.map(m => [m.type, m.quantityChange]), [["CONDITION_ADJUSTMENT_SOURCE", -1], ["CONDITION_ADJUSTMENT_TARGET", 1]]);
    assert.equal(await prisma.inventoryAudit.count({ where: { sourceProductListingId: source.id, targetProductListingId: target.id, quantity: 1 } }), 1);
  });

  it("rejects conversion consuming reserved NEW stock and keeps both inventories unchanged", async () => {
    const lego = await product();
    const source = await prisma.productListing.create({ data: { legoProductId: lego.id, condition: "NEW", originalPrice: 60, currentStock: 1, reservedStock: 1 } }); listings.push(source.id);
    const response = await request(`/inventory/condition-conversions/${lego.id}`, adminToken, form("Damage", 1, { sourceNewListingId: String(source.id) }));
    assert.equal(response.status, 409);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: source.id } })).currentStock, 1);
    assert.equal(await prisma.productListing.count({ where: { legoProductId: lego.id, condition: "USED_LIKE_NEW" } }), 0);
  });

  it("rejects MISSING_PARTS conversion in the domain before upload or inventory changes", async () => {
    const lego = await product();
    const source = await prisma.productListing.create({ data: { legoProductId: lego.id, condition: "NEW", originalPrice: 60, currentStock: 1 } }); listings.push(source.id);
    const uploadCount = storage.uploaded.length;
    const response = await request(`/inventory/condition-conversions/${lego.id}`, adminToken, form("Contents are incomplete", 1, {
      sourceNewListingId: String(source.id), reason: "MISSING_PARTS",
    }));
    assert.equal(response.status, 400);
    assert.equal(storage.uploaded.length, uploadCount);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: source.id } })).currentStock, 1);
    assert.equal(await prisma.productListing.count({ where: { legoProductId: lego.id, condition: "USED_LIKE_NEW" } }), 0);
  });

  it("preserves the selected product feature when its last NEW unit converts to Used", async () => {
    const cat = await category();
    const lego = await product(cat.id);
    await prisma.legoProduct.update({ where: { id: lego.id }, data: { isFeatureProduct: true } });
    const source = await prisma.productListing.create({ data: { legoProductId: lego.id, condition: "NEW", originalPrice: 60, currentStock: 1 } }); listings.push(source.id);
    const response = await request(`/inventory/condition-conversions/${lego.id}`, adminToken, form("Outer box corner dent", 1, {
      sourceNewListingId: String(source.id), reason: "PACKAGING_DAMAGE",
    }));
    assert.equal(response.status, 201);
    const used = await response.json(); listings.push(used.id);
    assert.equal(used.legoProduct.isFeatureProduct, true);
    const catalogue = await (await fetch(`${base}/products?q=${encodeURIComponent(lego.setNumber)}`)).json();
    assert.equal(catalogue.items[0].id, lego.id);
    assert.equal(catalogue.items[0].isFeatureProduct, true);
    assert.deepEqual(catalogue.items[0].offers.map((offer: any) => offer.id), [used.id]);
  });

  it("applies first-feature policy to Used-only products and preserves another category feature", async () => {
    const emptyCategory = await category();
    const firstProduct = await product(emptyCategory.id);
    const firstResponse = await createOffer(firstProduct.id);
    assert.equal(firstResponse.status, 201);
    const firstUsed = await firstResponse.json(); listings.push(firstUsed.id);
    assert.equal(firstUsed.legoProduct.isFeatureProduct, true);

    const occupiedCategory = await category();
    const featuredProduct = await product(occupiedCategory.id);
    await prisma.legoProduct.update({ where: { id: featuredProduct.id }, data: { isFeatureProduct: true } });
    const featuredNew = await prisma.productListing.create({ data: { legoProductId: featuredProduct.id, condition: "NEW", originalPrice: 30, currentStock: 1 } }); listings.push(featuredNew.id);
    const otherProduct = await product(occupiedCategory.id);
    const otherResponse = await createOffer(otherProduct.id);
    assert.equal(otherResponse.status, 201);
    const otherUsed = await otherResponse.json(); listings.push(otherUsed.id);
    assert.equal(otherUsed.legoProduct.isFeatureProduct, false);
    assert.equal((await prisma.legoProduct.findUniqueOrThrow({ where: { id: featuredProduct.id } })).isFeatureProduct, true);
  });

  it("filters product eligibility and price on the same available offer", async () => {
    const lego = await product();
    const newListing = await prisma.productListing.create({ data: { legoProductId: lego.id, condition: "NEW", originalPrice: 100, currentStock: 1 } }); listings.push(newListing.id);
    const usedResponse = await createOffer(lego.id);
    assert.equal(usedResponse.status, 201);
    const used = await usedResponse.json(); listings.push(used.id);
    await prisma.productListing.update({ where: { id: used.id }, data: { salePrice: 30 } });

    const buyer = await prisma.user.create({ data: { email: `price-${randomUUID()}@example.test`, passwordHash: "test", emailVerified: true,
      addresses: { create: { recipientName: "Buyer", line1: "1 High Street", city: "London", postcode: "SW1A 1AA", countryCode: "GB", isDefaultBilling: true } } } });
    users.push(buyer.id);
    const reservedOrder = await createOrder(buyer.id, { shippingMethod: "STANDARD" as const, items: [{ productListingId: used.id, quantity: 1 }] }); orders.push(reservedOrder.id);

    const excluded = await (await fetch(`${base}/products?q=${encodeURIComponent(lego.setNumber)}&maxPrice=50`)).json();
    assert.deepEqual(excluded.items, []);
    assert.deepEqual(excluded.pagination, { page: 1, pageSize: 20, totalItems: 0, totalPages: 0 });
    const all = await (await fetch(`${base}/products?q=${encodeURIComponent(lego.setNumber)}`)).json();
    assert.equal(all.items.length, 1);
    assert.deepEqual(all.items[0].offers.map((offer: any) => offer.id), [newListing.id]);
  });

  it("rejects a conversion while another physical Used offer is available", async () => {
    const lego = await product();
    const newListing = await prisma.productListing.create({ data: { legoProductId: lego.id, condition: "NEW", originalPrice: 60, currentStock: 2 } }); listings.push(newListing.id);
    const existingResponse = await createOffer(lego.id);
    assert.equal(existingResponse.status, 201);
    const existing = await existingResponse.json(); listings.push(existing.id);
    const conversion = await request(`/inventory/condition-conversions/${lego.id}`, adminToken, form("Another damaged box", 1, { sourceNewListingId: String(newListing.id) }));
    assert.equal(conversion.status, 409);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: newListing.id } })).currentStock, 2);
    assert.equal(await prisma.productListing.count({ where: { legoProductId: lego.id, condition: "USED_LIKE_NEW", currentStock: 1 } }), 1);
  });

  it("cleans up earlier photo uploads when a later upload fails", async () => {
    const lego = await product();
    const beforeUploaded = storage.uploaded.length, beforeDeleted = storage.deleted.length;
    storage.failOnUploadNumber = beforeUploaded + 2;
    const response = await createOffer(lego.id, form("Damage", 2));
    assert.equal(response.status, 500);
    assert.equal(storage.uploaded.length, beforeUploaded + 1);
    assert.equal(storage.deleted.length, beforeDeleted + 1);
    assert.equal(await prisma.productListing.count({ where: { legoProductId: lego.id } }), 0);
  });

  it("serializes concurrent conversions so only one NEW unit is converted", async () => {
    const lego = await product();
    const sources = await Promise.all([0, 1].map(() => prisma.productListing.create({ data: { legoProductId: lego.id, condition: "NEW", originalPrice: 60, currentStock: 1 } })));
    listings.push(...sources.map(s => s.id));
    const responses = await Promise.all(sources.map(source => request(`/inventory/condition-conversions/${lego.id}`, adminToken, form("Damage", 1, { sourceNewListingId: String(source.id) }))));
    assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
    const target = await prisma.productListing.findFirstOrThrow({ where: { legoProductId: lego.id, condition: "USED_LIKE_NEW", currentStock: 1 } });
    listings.push(target.id);
    const currentNew = await prisma.productListing.aggregate({ where: { id: { in: sources.map(s => s.id) } }, _sum: { currentStock: true } });
    assert.equal(currentNew._sum.currentStock, 1);
  });

  it("serializes Used conversion against a real NEW order reservation", async () => {
    const lego = await product();
    const source = await prisma.productListing.create({ data: { legoProductId: lego.id, condition: "NEW", originalPrice: 60, currentStock: 1 } }); listings.push(source.id);
    const buyer = await prisma.user.create({ data: { email: `race-${randomUUID()}@example.test`, passwordHash: "test", emailVerified: true,
      addresses: { create: { recipientName: "Buyer", line1: "1 High Street", city: "London", postcode: "SW1A 1AA", countryCode: "GB", isDefaultBilling: true } } } });
    users.push(buyer.id);

    const [conversionResult, reservationResult] = await Promise.allSettled([
      request(`/inventory/condition-conversions/${lego.id}`, adminToken, form("Outer box damage", 1, { sourceNewListingId: String(source.id), reason: "PACKAGING_DAMAGE" })),
      createOrder(buyer.id, { shippingMethod: "STANDARD" as const, items: [{ productListingId: source.id, quantity: 1 }] }).then((order) => { orders.push(order.id); return order; }),
    ]);
    assert.equal(conversionResult.status, "fulfilled");
    const conversionResponse = conversionResult.value;
    const conversionWon = conversionResponse.status === 201;
    if (conversionWon) {
      const used = await conversionResponse.json();
      listings.push(used.id);
    }
    assert.equal(conversionWon, reservationResult.status === "rejected");
    const sourceAfter = await prisma.productListing.findUniqueOrThrow({ where: { id: source.id } });
    if (conversionWon) {
      assert.equal(sourceAfter.currentStock, 0);
      assert.equal(sourceAfter.reservedStock, 0);
      assert.equal(await prisma.productListing.count({ where: { legoProductId: lego.id, condition: "USED_LIKE_NEW", currentStock: 1 } }), 1);
    } else {
      assert.equal(conversionResponse.status, 409);
      assert.equal(sourceAfter.currentStock, 1);
      assert.equal(sourceAfter.reservedStock, 1);
      assert.equal(await prisma.productListing.count({ where: { legoProductId: lego.id, condition: "USED_LIKE_NEW" } }), 0);
    }
  });

  it("serializes a condition-photo mutation against a SOLD transition across database connections", async () => {
    const lego = await product();
    const response = await createOffer(lego.id);
    const listing = await response.json(); listings.push(listing.id);
    const photoId = listing.usedConditionPhotos[0].id;
    await withTwoSqlConnections(async (sale, photoMutation) => {
      await sale.query("BEGIN");
      await sale.query('SELECT "id" FROM "ProductListing" WHERE "id" = $1 FOR UPDATE', [listing.id]);
      await photoMutation.query("BEGIN");
      const pid = Number((await photoMutation.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const update = photoMutation.query('UPDATE "UsedConditionPhoto" SET "url" = $2 WHERE "id" = $1', [photoId, "https://images.test/raced-photo"])
        .then(() => null, (error: Error) => error);
      await waitForBlockedTransaction(sale, pid);
      await sale.query(`UPDATE "ProductListing" SET "currentStock" = 0, "reservedStock" = 0, "usedLifecycle" = 'SOLD' WHERE "id" = $1`, [listing.id]);
      await sale.query("COMMIT");
      const mutationError = await update;
      assert.ok(mutationError instanceof Error);
      await photoMutation.query("ROLLBACK");
      const photo = await prisma.usedConditionPhoto.findUniqueOrThrow({ where: { id: photoId } });
      assert.equal(photo.url, listing.usedConditionPhotos[0].url);
      const sold = await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } });
      assert.equal(sold.usedLifecycle, "SOLD");
    });
  });

  it("serializes concurrent photo deletions at the one-photo boundary", async () => {
    const lego = await product();
    const response = await createOffer(lego.id, form("Damage", 2));
    const listing = await response.json(); listings.push(listing.id);
    const [firstPhoto, secondPhoto] = listing.usedConditionPhotos;
    await withTwoSqlConnections(async (firstDelete, secondDelete) => {
      await firstDelete.query("BEGIN");
      await firstDelete.query('DELETE FROM "UsedConditionPhoto" WHERE "id" = $1', [firstPhoto.id]);
      await secondDelete.query("BEGIN");
      const pid = Number((await secondDelete.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const deletion = secondDelete.query('DELETE FROM "UsedConditionPhoto" WHERE "id" = $1', [secondPhoto.id])
        .then(() => null, (error: Error) => error);
      await waitForBlockedTransaction(firstDelete, pid);
      await firstDelete.query("SET CONSTRAINTS ALL IMMEDIATE");
      await firstDelete.query("COMMIT");
      assert.equal(await deletion, null);
      await assert.rejects(secondDelete.query("COMMIT"));
      await secondDelete.query("ROLLBACK").catch(() => {});
      assert.equal(await prisma.usedConditionPhoto.count({ where: { listingId: listing.id } }), 1);
    });
  });

  it("serializes concurrent photo additions at the three-photo boundary", async () => {
    const lego = await product();
    const response = await createOffer(lego.id, form("Damage", 2));
    const listing = await response.json(); listings.push(listing.id);
    await withTwoSqlConnections(async (firstAdd, secondAdd) => {
      await firstAdd.query("BEGIN");
      await firstAdd.query(`INSERT INTO "UsedConditionPhoto" ("listingId", "url", "publicId", "sortOrder") VALUES ($1, $2, $3, 2)`, [listing.id, "https://images.test/third", `third-${randomUUID()}`]);
      await secondAdd.query("BEGIN");
      const pid = Number((await secondAdd.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      const addition = secondAdd.query(`INSERT INTO "UsedConditionPhoto" ("listingId", "url", "publicId", "sortOrder") VALUES ($1, $2, $3, 3)`, [listing.id, "https://images.test/fourth", `fourth-${randomUUID()}`])
        .then(() => null, (error: Error) => error);
      await waitForBlockedTransaction(firstAdd, pid);
      await firstAdd.query("SET CONSTRAINTS ALL IMMEDIATE");
      await firstAdd.query("COMMIT");
      assert.equal(await addition, null);
      await assert.rejects(secondAdd.query("COMMIT"));
      await secondAdd.query("ROLLBACK").catch(() => {});
      assert.equal(await prisma.usedConditionPhoto.count({ where: { listingId: listing.id } }), 3);
    });
  });

  it("rolls back conversion stock/listing/movements and compensates photos when persistence fails", async () => {
    const lego = await product();
    const source = await prisma.productListing.create({ data: { legoProductId: lego.id, condition: "NEW", originalPrice: 60, currentStock: 1 } }); listings.push(source.id);
    const file = { buffer: Buffer.from(png), size: png.length, mimetype: "image/png" } as Express.Multer.File;
    const beforeUploads = storage.uploaded.length, beforeDeletes = storage.deleted.length;
    const service = createUsedOfferService(storage, prisma);
    await assert.rejects(() => service.convert({ legoProductId: lego.id, sourceNewListingId: source.id, originalPrice: 30, damageDescription: "Damage", performedByUserId: 2147483647 }, [file]));
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: source.id } })).currentStock, 1);
    assert.equal(await prisma.productListing.count({ where: { legoProductId: lego.id, condition: "USED_LIKE_NEW" } }), 0);
    assert.equal(await prisma.inventoryMovement.count({ where: { listingId: source.id } }), 0);
    assert.equal(storage.deleted.length, beforeDeletes + 1);
    assert.equal(storage.uploaded.length, beforeUploads + 1);
  });

  it("groups stocked offers under one product card when NEW stock is zero", async () => {
    const lego = await product();
    const newListing = await prisma.productListing.create({ data: { legoProductId: lego.id, condition: "NEW", originalPrice: 59.99, currentStock: 0 } });
    listings.push(newListing.id);
    const response = await createOffer(lego.id);
    assert.equal(response.status, 201);
    const listing = await response.json(); listings.push(listing.id);
    const catalogue = await (await fetch(`${base}/products?q=${encodeURIComponent(lego.setNumber)}`)).json();
    assert.equal(catalogue.items.length, 1);
    assert.equal(catalogue.items[0].id, lego.id);
    assert.equal(catalogue.items[0].offers.length, 1);
    assert.equal(catalogue.items[0].offers[0].id, listing.id);
    assert.equal(catalogue.items[0].offers[0].damageDescription, "Small crease on the top right corner");
    const detail = await (await fetch(`${base}/products/by-product/${lego.id}`)).json();
    assert.equal(detail.offers[0].usedConditionPhotos.length, 1);
  });

  it("groups available NEW and Used offers on one product with exact listing identities", async () => {
    const lego = await product();
    const newListing = await prisma.productListing.create({ data: { legoProductId: lego.id, condition: "NEW", originalPrice: 59.99, currentStock: 2 } });
    listings.push(newListing.id);
    const response = await createOffer(lego.id);
    assert.equal(response.status, 201);
    const used = await response.json(); listings.push(used.id);
    const catalogue = await (await fetch(`${base}/products?q=${encodeURIComponent(lego.setNumber)}`)).json();
    assert.equal(catalogue.items.length, 1);
    assert.deepEqual(catalogue.items[0].offers.map((offer: any) => [offer.id, offer.condition]), [[newListing.id, "NEW"], [used.id, "USED_LIKE_NEW"]]);
  });

  it("releases a pre-consumption Used reservation without terminalizing the item", async () => {
    const lego = await product();
    const response = await createOffer(lego.id);
    const listing = await response.json(); listings.push(listing.id);
    const buyer = await prisma.user.create({ data: { email: `pending-${randomUUID()}@example.test`, passwordHash: "test", emailVerified: true,
      addresses: { create: { recipientName: "Buyer", line1: "1 High Street", city: "London", postcode: "SW1A 1AA", countryCode: "GB", isDefaultBilling: true } } } });
    users.push(buyer.id);
    const order = await createOrder(buyer.id, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 1 }] }); orders.push(order.id);
    let state = await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(state.currentStock, 1); assert.equal(state.reservedStock, 1); assert.equal(state.usedLifecycle, "AVAILABLE");
    await cancelOrder(buyer.id, order.id, "CHANGED_MIND");
    state = await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(state.currentStock, 1); assert.equal(state.reservedStock, 0); assert.equal(state.usedLifecycle, "AVAILABLE");
  });

  it("marks a consumed Used item SOLD and cancellation cannot revive it or alter its evidence", async () => {
    const lego = await product();
    const response = await createOffer(lego.id);
    assert.equal(response.status, 201);
    const listing = await response.json(); listings.push(listing.id);
    const buyer = await prisma.user.create({ data: { email: `sale-${randomUUID()}@example.test`, passwordHash: "test", emailVerified: true,
      addresses: { create: { recipientName: "Buyer", line1: "1 High Street", city: "London", postcode: "SW1A 1AA", countryCode: "GB", isDefaultBilling: true } } } });
    users.push(buyer.id);
    const order = await createOrder(buyer.id, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 1 }] }); orders.push(order.id);
    await historicalUnpaidConfirmedFixture(order.id,adminId);
    const sold = await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.equal(sold.currentStock, 0); assert.equal(sold.usedLifecycle, "SOLD");
    await assert.rejects(() => prisma.usedConditionPhoto.deleteMany({ where: { listingId: listing.id } }));
    await cancelOrderByAdmin(order.id, "PRODUCT_UNAVAILABLE", adminId);
    const afterCancel = await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id }, include: { usedConditionPhotos: true } });
    assert.equal(afterCancel.currentStock, 0); assert.equal(afterCancel.usedLifecycle, "SOLD");
    assert.equal(afterCancel.usedConditionPhotos.length, 1);
    assert.equal((await prisma.productListing.count({ where: { legoProductId: lego.id, condition: "USED_LIKE_NEW", currentStock: 1 } })), 0);
    const cancelledItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    await assert.rejects(() => requestOrderReturn(order.id, cancelledItem.id, 1, ReturnReason.DAMAGED, undefined, ReturnShippingPayer.SELLER, undefined, buyer.id), OrderReturnEligibilityError);
    // A legitimate physical return uses a separate confirmed sale, not the cancelled order.
    const returnResponse = await createOffer(lego.id);
    assert.equal(returnResponse.status, 201);
    const returnListing = await returnResponse.json(); listings.push(returnListing.id);
    const returnOrder = await createOrder(buyer.id, { shippingMethod: "STANDARD" as const, items: [{ productListingId: returnListing.id, quantity: 1 }] }); orders.push(returnOrder.id);
    await recordVerifiedPayment(returnOrder.id);
    await confirmOrder(adminId, returnOrder.id);
    await dispatchOrder(returnOrder.id,0,"Royal Mail","AB123456789GB",adminId);
    const orderItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: returnOrder.id } });
    const returnedItem = await requestOrderReturn(returnOrder.id, orderItem.id, 1, ReturnReason.DAMAGED, "Box damaged in transit", ReturnShippingPayer.SELLER, undefined, buyer.id);
    await authorizeOrderReturn(returnOrder.id, returnedItem.id);
    await receiveOrderReturn(returnOrder.id, returnedItem.id);
    await assert.rejects(() => inspectOrderReturn(returnOrder.id, returnedItem.id, "AS_NEW", 1, "Returned Used item", adminId), InvalidInspectionRestockConditionError);
    const inspected = await inspectOrderReturn(returnOrder.id, returnedItem.id, "AS_NEW", 0, "Returned Used item requires reinspection", adminId);
    assert.equal(inspected.restockQuantity, 0);
    const completed = await completeOrderReturn(returnOrder.id, returnedItem.id, adminId);
    assert.equal(completed.status, "COMPLETED");
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: returnListing.id } })).currentStock, 0);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: returnListing.id } })).usedLifecycle, "SOLD");
    const replacement = await createOffer(lego.id, form("New inspection and new photos", 1));
    assert.equal(replacement.status, 201);
    const replacementListing = await replacement.json(); listings.push(replacementListing.id);
    const historicalOrderItem = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
    assert.equal(historicalOrderItem.damageDescriptionSnapshot, "Small crease on the top right corner");
    assert.equal((historicalOrderItem.conditionPhotoSnapshot as any[]).length, 1);
    assert.notEqual(replacementListing.usedConditionPhotos[0].id, (historicalOrderItem.conditionPhotoSnapshot as any[])[0].id);
    await assert.rejects(() => prisma.productListing.update({ where: { id: listing.id }, data: { currentStock: 1 } }));
    const reactivate = await fetch(`${base}/products/${listing.id}/reactivate`, { method: "PATCH", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${adminToken}` } });
    assert.equal(reactivate.status, 409);
  });
});
