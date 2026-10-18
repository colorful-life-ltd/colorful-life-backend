import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { createUsedOfferService, UsedOfferValidationError } from "../domain/usedOffers/usedOfferService.js";
import { hasValidListingPrices, positivePriceSchema, salePriceSchema } from "../domain/products/listingPrice.js";

const products: number[] = [];
let server: ReturnType<ReturnType<typeof createApp>["listen"]>, base: string;
let adminId: number, customerId: number, adminToken: string, customerToken: string, categoryId: number, purchaseId: number;
let uploads = 0;
const storage = { async upload() { uploads++; throw new Error("Unexpected image upload"); }, async delete() {} };
before(async () => {
  const admin = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", role: "ADMIN", emailVerified: true } });
  const customer = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", emailVerified: true,
    addresses: { create: { recipientName: "Price test", line1: "1 Test Road", city: "Testville", postcode: "T1", countryCode: "GB", isDefaultBilling: true } } } });
  adminId = admin.id; customerId = customer.id;
  adminToken = jwt.sign({ id: adminId, role: "ADMIN" }, config.JWT_SECRET);
  customerToken = jwt.sign({ id: customerId, role: "CUSTOMER" }, config.JWT_SECRET);
  categoryId = (await prisma.category.findUniqueOrThrow({ where: { name: "Others" } })).id;
  const purchase = await prisma.purchase.create({ data: { sourceOrderReference: randomUUID(), purchaseDocuments: { create: { partNumber: 1, importHash: randomUUID(), importedByUserId: adminId, originalGrossMerchandiseTotal: 0, shippingTotal: 0, discountTotal: 0, finalTotalPaid: 0 } } } });
  purchaseId = purchase.id;
  server = createApp(storage).listen(0, "127.0.0.1");
  await new Promise<void>(r => server.once("listening", r));
  const address = server.address(); assert.ok(address && typeof address !== "string"); base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  await prisma.order.deleteMany({ where: { userId: customerId } });
  await prisma.cartItem.deleteMany({ where: { productListing: { legoProductId: { in: products } } } });
  await prisma.inventoryMovement.deleteMany({ where: { listing: { legoProductId: { in: products } } } });
  await prisma.productListing.deleteMany({ where: { legoProductId: { in: products } } });
  await prisma.legoProduct.deleteMany({ where: { id: { in: products.splice(0) } } });
});
after(async () => {
  await prisma.purchaseDocument.deleteMany({ where: { purchaseId } }); await prisma.purchase.delete({ where: { id: purchaseId } });
  await prisma.user.deleteMany({ where: { id: { in: [adminId, customerId] } } });
  await new Promise<void>(r => server.close(() => r())); await prisma.$disconnect();
});
function request(path: string, method: string, body?: unknown, token = adminToken) {
  return fetch(base + path, { method, headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function input() { return { setNumber: `PRICE-${randomUUID()}`, title: "Price fixture", theme: "TEST", categoryId, ageRecommendation: "8+", pieceCount: 10, condition: "NEW", originalPrice: 20, currentStock: 4 }; }
async function listing(prices: { originalPrice?: number; salePrice?: number | null } = {}) {
  const p = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: "Price fixture", theme: "TEST", ageRecommendation: "8+", pieceCount: 10, categoryId } }); products.push(p.id);
  return prisma.productListing.create({ data: { legoProductId: p.id, condition: "NEW", currentStock: 4, originalPrice: 20, ...prices } });
}
async function checkout(id: number) { return request("/orders", "POST", { shippingMethod: "STANDARD", items: [{ productListingId: id, quantity: 2 }] }, customerToken); }

describe("positive selling prices", () => {
  it("validates positive whole-penny prices and nullable optional promotions", () => {
    for (const value of [0, -1, 0.001, 0.005, 1.234, NaN, Infinity, "0", "10", true]) assert.equal(positivePriceSchema.safeParse(value).success, false);
    for (const value of [0.01, 1.23, 19.99]) assert.equal(positivePriceSchema.safeParse(value).success, true);
    for (const value of [undefined, null, 0.01, 12.34]) assert.equal(salePriceSchema.safeParse(value).success, true);
    assert.equal(hasValidListingPrices({ originalPrice: 0, salePrice: 1 }), false);
  });
  for (const field of ["originalPrice", "salePrice"]) for (const value of [0, -1, 0.001, 0.005]) {
    it(`rejects ${field}=${value} at create and update without changing valid prices`, async () => {
      const body = { ...input(), [field]: value };
      assert.equal((await request("/products", "POST", body)).status, 400);
      assert.equal(await prisma.legoProduct.count({ where: { setNumber: body.setNumber } }), 0);
      const f = await listing({ salePrice: 15 });
      assert.equal((await request(`/products/${f.id}`, "PATCH", { [field]: value })).status, 400);
      const saved = await prisma.productListing.findUniqueOrThrow({ where: { id: f.id } });
      assert.equal(saved.originalPrice.toString(), "20"); assert.equal(saved.salePrice?.toString(), "15");
    });
  }
  for (const salePrice of [undefined, null, 0.01, 12.34]) it(`creates valid optional promotional pricing: ${salePrice}`, async () => {
    const response = await request("/products", "POST", { ...input(), salePrice }); assert.equal(response.status, 201);
    const body = await response.json(); products.push(body.legoProductId);
    const saved = await prisma.productListing.findUniqueOrThrow({ where: { id: body.id } });
    assert.equal(saved.salePrice?.toString() ?? null, salePrice == null ? null : String(salePrice));
  });
  it("preserves an omitted promotion, updates a valid promotion and clears it explicitly with null", async () => {
    const f = await listing({ salePrice: 15 });
    assert.equal((await request(`/products/${f.id}`, "PATCH", { title: "Renamed" })).status, 200);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.id } })).salePrice?.toString(), "15");
    assert.equal((await request(`/products/${f.id}`, "PATCH", { salePrice: 12.34 })).status, 200);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.id } })).salePrice?.toString(), "12.34");
    assert.equal((await request(`/products/${f.id}`, "PATCH", { salePrice: null })).status, 200);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.id } })).salePrice, null);
    const response = await checkout(f.id); assert.equal(response.status, 201); assert.equal((await response.json()).orderItems[0].unitPrice, "20");
  });
  it("rejects zero purchase-listing promotions and permits null without inventory", async () => {
    const f = await listing();
    const body = { existingProductId: f.legoProductId, condition: "NEW", originalPrice: 20, currentStock: 0 };
    for (const prices of [{ salePrice: 0 }, { originalPrice: 0 }, { salePrice: 0.001 }]) assert.equal((await request(`/purchases/${purchaseId}/review/listings`, "POST", { ...body, ...prices })).status, 400);
    const response = await request(`/purchases/${purchaseId}/review/listings`, "POST", { ...body, salePrice: null });
    assert.equal(response.status, 201); const created = await response.json(); assert.equal(created.salePrice, null); assert.equal(created.currentStock, 0);
  });
  it("rejects invalid Used offer prices before photo upload in HTTP and domain entry points", async () => {
    const f = await listing(); const service = createUsedOfferService(storage);
    for (const prices of [{ salePrice: 0 }, { originalPrice: 0 }, { salePrice: 0.001 }]) {
      const body = { originalPrice: 20, damageDescription: "Creased box", ...prices };
      assert.equal((await request(`/products/${f.legoProductId}/used-offers`, "POST", body)).status, 400);
      await assert.rejects(service.create({ ...body, legoProductId: f.legoProductId, performedByUserId: adminId }, []), UsedOfferValidationError);
    }
    assert.equal(uploads, 0);
  });
  for (const prices of [{ salePrice: 0 }, { originalPrice: 0, salePrice: 5 }, { salePrice: -1 }]) {
    it(`blocks corrupt stored prices from catalogue, cart and checkout: ${JSON.stringify(prices)}`, async () => {
      const f = await listing();
      assert.equal((await request("/cart/items", "POST", { productListingId: f.id, quantity: 2 }, customerToken)).status, 200);
      await prisma.productListing.update({ where: { id: f.id }, data: prices }); // New isolated test fixture only.
      const cart = await (await request("/cart", "GET", undefined, customerToken)).json();
      assert.equal(cart.items[0].availability.status, "UNAVAILABLE"); assert.equal(cart.items[0].availability.reason, "INVALID_PRICE");
      assert.equal((await request("/cart/items", "POST", { productListingId: f.id, quantity: 1 }, customerToken)).status, 409);
      const product = await (await request(`/products/by-product/${f.legoProductId}`, "GET")).json();
      assert.equal(product.offers.length, 0); assert.equal(product.availability, "OUT_OF_STOCK");
      const filtered = await (await request(`/products?categoryId=${categoryId}&minPrice=0&maxPrice=100`, "GET")).json();
      assert.ok(!filtered.items.some((p: { id: number }) => p.id === f.legoProductId));
      const response = await checkout(f.id); assert.equal(response.status, 409); const error = (await response.json()).error;
      assert.equal(error.code, "LISTING_UNAVAILABLE"); assert.equal(error.reason, "INVALID_PRICE");
      assert.equal(await prisma.order.count({ where: { userId: customerId } }), 0);
      const saved = await prisma.productListing.findUniqueOrThrow({ where: { id: f.id } }); assert.equal(saved.currentStock, 4); assert.equal(saved.reservedStock, 0);
      assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.id } }), 0);
    });
  }
  it("charges the exact valid promotion and preserves regular and promotional values", async () => {
    const f = await listing({ salePrice: 1.23 }); const response = await checkout(f.id); assert.equal(response.status, 201);
    const body = await response.json(); assert.equal(body.orderItems[0].unitPrice, "1.23"); assert.equal(body.orderItems[0].lineTotal, "2.46");
    const saved = await prisma.productListing.findUniqueOrThrow({ where: { id: f.id } }); assert.equal(saved.originalPrice.toString(), "20"); assert.equal(saved.salePrice?.toString(), "1.23");
  });
});
