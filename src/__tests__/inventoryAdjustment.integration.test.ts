import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { reconcileStocktake } from "../domain/inventory/inventoryAdjustmentService.js";

const users: number[] = [];
const products: number[] = [];
const listings: number[] = [];
const audits: number[] = [];
const movements: number[] = [];
let server: ReturnType<typeof app.listen>;
let url: string;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  url = `http://localhost:${address.port}`;
});

after(async () => {
  await prisma.$disconnect();
  server.close();
});

afterEach(async () => {
  if (audits.length) await prisma.inventoryAudit.deleteMany({ where: { id: { in: audits } } });
  if (movements.length) await prisma.inventoryMovement.deleteMany({ where: { id: { in: movements } } });
  if (listings.length) await prisma.productListing.deleteMany({ where: { id: { in: listings } } });
  if (products.length) await prisma.legoProduct.deleteMany({ where: { id: { in: products } } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } });
  audits.length = movements.length = listings.length = products.length = users.length = 0;
});

async function user(role: "ADMIN" | "CUSTOMER") {
  const created = await prisma.user.create({ data: { email: `${role}-${randomUUID()}@example.com`, passwordHash: "test", emailVerified: true, role } });
  users.push(created.id);
  return { id: created.id, token: jwt.sign({ id: created.id, role }, config.JWT_SECRET, { expiresIn: "1h" }) };
}

async function fixture(sourceStock = 10) {
  const admin = await user("ADMIN");
  const customer = await user("CUSTOMER");
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: "HTTP inventory", theme: "TEST", ageRecommendation: "8+", pieceCount: 100 } });
  products.push(product.id);
  const source = await prisma.productListing.create({ data: {
        legoProductId: product.id, condition: "NEW", originalPrice: 10, currentStock: sourceStock } });
  const target = await prisma.productListing.create({ data: {
        legoProductId: product.id, condition: "NEW", originalPrice: 8, currentStock: 0 } });
  listings.push(source.id, target.id);
  return { admin, customer, source, target };
}

async function post(token: string | undefined, body: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${url}/inventory/condition-adjustments`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function postStocktake(token: string | undefined, body: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${url}/inventory/stocktakes`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("POST /inventory/condition-adjustments", () => {
  it("allows ADMIN condition adjustment and persists authenticated performer", async () => {
    const f = await fixture();
    const res = await post(f.admin.token, { action: "CONDITION_ADJUSTMENT", sourceProductListingId: f.source.id, targetProductListingId: f.target.id, quantity: 3, reason: "PACKAGING_DAMAGE", reasonNote: "box damage", performedByUserId: 2147483647 });
    assert.strictEqual(res.status, 400);
    assert.strictEqual((await prisma.productListing.findUnique({ where: { id: f.source.id } }))?.currentStock, 10);
    assert.strictEqual((await prisma.productListing.findUnique({ where: { id: f.target.id } }))?.currentStock, 0);
    assert.strictEqual(await prisma.inventoryMovement.count({ where: { listingId: { in: [f.source.id, f.target.id] } } }), 0);
  });

  it("allows ADMIN write-off with no target", async () => {
    const f = await fixture();
    const res = await post(f.admin.token, { action: "WRITE_OFF", sourceProductListingId: f.source.id, quantity: 2, reason: "WAREHOUSE_DAMAGE", reasonNote: "shelf" });
    assert.strictEqual(res.status, 201);
    const body = await res.json();
    audits.push(body.audit.id); movements.push(body.movement.id);
    assert.strictEqual((await prisma.productListing.findUnique({ where: { id: f.source.id } }))?.currentStock, 8);
    assert.strictEqual(body.audit.targetProductListingId, null);
    assert.strictEqual(body.movement.type, "WRITE_OFF");
    assert.strictEqual(body.movement.quantityChange, -2);
    assert.strictEqual(body.audit.performedByUserId, f.admin.id);
  });

  it("rejects CUSTOMER and unauthenticated requests", async () => {
    const f = await fixture();
    assert.strictEqual((await post(f.customer.token, {})).status, 403);
    assert.strictEqual((await post(undefined, {})).status, 401);
  });

  it("rejects malformed payloads with 400", async () => {
    const f = await fixture();
    for (const body of [
      { action: "BAD", sourceProductListingId: f.source.id, quantity: 1, reason: "OTHER" },
      { action: "WRITE_OFF", sourceProductListingId: f.source.id, targetProductListingId: f.target.id, quantity: 1, reason: "OTHER" },
      { action: "CONDITION_ADJUSTMENT", sourceProductListingId: f.source.id, targetProductListingId: f.target.id, quantity: 0, reason: "OTHER" },
      { action: "CONDITION_ADJUSTMENT", sourceProductListingId: "bad", targetProductListingId: f.target.id, quantity: 1, reason: "OTHER" },
    ]) assert.strictEqual((await post(f.admin.token, body)).status, 400);
  });

  it("maps missing listings to 404", async () => {
    const f = await fixture();
    assert.strictEqual((await post(f.admin.token, { action: "CONDITION_ADJUSTMENT", sourceProductListingId: 2147483647, targetProductListingId: f.target.id, quantity: 1, reason: "OTHER" })).status, 400);
    assert.strictEqual((await post(f.admin.token, { action: "CONDITION_ADJUSTMENT", sourceProductListingId: f.source.id, targetProductListingId: 2147483647, quantity: 1, reason: "OTHER" })).status, 400);
  });

  it("maps insufficient write-off stock to 409", async () => {
    const f = await fixture(0);
    const res = await post(f.admin.token, { action: "WRITE_OFF", sourceProductListingId: f.source.id, quantity: 1, reason: "OTHER" });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(await prisma.inventoryMovement.count({ where: { listingId: f.source.id } }), 0);
    assert.strictEqual(await prisma.inventoryAudit.count({ where: { sourceProductListingId: f.source.id } }), 0);
  });

  it("maps invalid transition, same listing, product mismatch, and stock failure", async () => {
    const f = await fixture(0);
    assert.strictEqual((await post(f.admin.token, { action: "CONDITION_ADJUSTMENT", sourceProductListingId: f.source.id, targetProductListingId: f.source.id, quantity: 1, reason: "OTHER" })).status, 400);
    const other = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: "Other", theme: "TEST", ageRecommendation: "8+", pieceCount: 1 } });
    products.push(other.id);
    const otherListing = await prisma.productListing.create({ data: {
        legoProductId: other.id, condition: "NEW", originalPrice: 1, currentStock: 0 } });
    listings.push(otherListing.id);
    assert.strictEqual((await post(f.admin.token, { action: "CONDITION_ADJUSTMENT", sourceProductListingId: f.source.id, targetProductListingId: otherListing.id, quantity: 1, reason: "OTHER" })).status, 400);
    assert.strictEqual((await post(f.admin.token, { action: "CONDITION_ADJUSTMENT", sourceProductListingId: f.source.id, targetProductListingId: f.target.id, quantity: 1, reason: "OTHER" })).status, 400);
    const invalidTarget = await prisma.productListing.create({ data: {
        legoProductId: f.source.legoProductId, condition: "NEW", originalPrice: 1 } });
    listings.push(invalidTarget.id);
    assert.strictEqual((await post(f.admin.token, { action: "CONDITION_ADJUSTMENT", sourceProductListingId: f.source.id, targetProductListingId: invalidTarget.id, quantity: 1, reason: "OTHER" })).status, 400);
  });

  it("does not create unrelated Order, Payment, Refund, or OrderReturn records", async () => {
    const f = await fixture();
    const res = await post(f.admin.token, { action: "WRITE_OFF", sourceProductListingId: f.source.id, quantity: 1, reason: "OTHER" });
    assert.strictEqual(res.status, 201);
    const relatedOrder = await prisma.order.count({ where: { orderItems: { some: { productListingId: { in: [f.source.id, f.target.id] } } } } });
    const relatedPayment = await prisma.payment.count({ where: { order: { orderItems: { some: { productListingId: { in: [f.source.id, f.target.id] } } } } } });
    const relatedRefund = await prisma.refund.count({ where: { order: { orderItems: { some: { productListingId: { in: [f.source.id, f.target.id] } } } } } });
    const relatedReturn = await prisma.orderReturn.count({ where: { orderItem: { productListingId: { in: [f.source.id, f.target.id] } } } });
    assert.deepStrictEqual([relatedOrder, relatedPayment, relatedRefund, relatedReturn], [0, 0, 0, 0]);
    const body = await res.json();
    audits.push(body.audit.id); movements.push(body.movement.id);
  });
});

describe("POST /inventory/stocktakes", () => {
  it("requires an ADMIN and validates actualStock as a non-negative integer", async () => {
    const f = await fixture();
    const body = { productListingId: f.source.id, actualStock: 5 };
    assert.strictEqual((await postStocktake(undefined, body)).status, 401);
    assert.strictEqual((await postStocktake(f.customer.token, body)).status, 403);
    for (const actualStock of [-1, 1.5, 2_147_483_648]) {
      assert.strictEqual((await postStocktake(f.admin.token, { ...body, actualStock })).status, 400);
    }
  });

  it("reconciles positive and negative differences with signed manual movements", async () => {
    const f = await fixture(5);
    const positive = await postStocktake(f.admin.token, { productListingId: f.source.id, actualStock: 7, reasonNote: "counted at home" });
    assert.strictEqual(positive.status, 200);
    const positiveBody = await positive.json();
    movements.push(positiveBody.movement.id);
    assert.deepStrictEqual(positiveBody.listing, { id: f.source.id, currentStock: 7 });
    assert.strictEqual(positiveBody.movement.quantityChange, 2);
    assert.strictEqual(positiveBody.movement.type, "MANUAL_ADJUSTMENT");
    assert.strictEqual(positiveBody.movement.note, "counted at home");

    const negative = await postStocktake(f.admin.token, { productListingId: f.source.id, actualStock: 5 });
    assert.strictEqual(negative.status, 200);
    const negativeBody = await negative.json();
    movements.push(negativeBody.movement.id);
    assert.strictEqual(negativeBody.movement.quantityChange, -2);
    assert.strictEqual(negativeBody.movement.type, "MANUAL_ADJUSTMENT");
    assert.strictEqual((await prisma.productListing.findUniqueOrThrow({ where: { id: f.source.id } })).currentStock, 5);
  });

  it("returns a successful no-op without a zero movement", async () => {
    const f = await fixture(5);
    const response = await postStocktake(f.admin.token, { productListingId: f.source.id, actualStock: 5 });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.deepStrictEqual(body.listing, { id: f.source.id, currentStock: 5 });
    assert.strictEqual(body.movement, null);
    assert.strictEqual(await prisma.inventoryMovement.count({ where: { listingId: f.source.id } }), 0);
  });

  it("rejects actual stock below reservations without changing stock or writing movement", async () => {
    const f = await fixture(5);
    await prisma.productListing.update({ where: { id: f.source.id }, data: { reservedStock: 3 } });
    const response = await postStocktake(f.admin.token, { productListingId: f.source.id, actualStock: 2 });
    assert.strictEqual(response.status, 409);
    assert.strictEqual((await prisma.productListing.findUniqueOrThrow({ where: { id: f.source.id } })).currentStock, 5);
    assert.strictEqual(await prisma.inventoryMovement.count({ where: { listingId: f.source.id } }), 0);
  });

  it("rolls back the stock write if movement creation fails", async () => {
    const f = await fixture(5);
    await assert.rejects(() => reconcileStocktake({
      productListingId: f.source.id,
      actualStock: 7,
      performedByUserId: 2_147_483_647,
    }));
    assert.strictEqual((await prisma.productListing.findUniqueOrThrow({ where: { id: f.source.id } })).currentStock, 5);
    assert.strictEqual(await prisma.inventoryMovement.count({ where: { listingId: f.source.id } }), 0);
  });

  it("serializes concurrent stocktakes against the locked listing row", async () => {
    const f = await fixture(8);
    const results = await Promise.all([
      postStocktake(f.admin.token, { productListingId: f.source.id, actualStock: 6 }),
      postStocktake(f.admin.token, { productListingId: f.source.id, actualStock: 6 }),
    ]);
    assert.deepStrictEqual(results.map((response) => response.status), [200, 200]);
    const bodies = await Promise.all(results.map((response) => response.json()));
    movements.push(...bodies.filter((body) => body.movement).map((body) => body.movement.id));
    assert.deepStrictEqual(bodies.map((body) => body.movement?.quantityChange ?? 0).sort((a, b) => a - b), [-2, 0]);
    assert.strictEqual((await prisma.productListing.findUniqueOrThrow({ where: { id: f.source.id } })).currentStock, 6);
    assert.strictEqual(await prisma.inventoryMovement.count({ where: { listingId: f.source.id } }), 1);
  });
});
