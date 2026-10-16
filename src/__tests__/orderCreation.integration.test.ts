import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { Decimal } from "@prisma/client/runtime/client";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";

const userIds: number[] = [];
const productIds: number[] = [];
const listingIds: number[] = [];
const orderIds: number[] = [];
let server: Server;
let url: string;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  url = `http://localhost:${address.port}`;
});

afterEach(async () => {
  if (orderIds.length) await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  if (listingIds.length) await prisma.productListing.deleteMany({ where: { id: { in: listingIds } } });
  if (productIds.length) await prisma.legoProduct.deleteMany({ where: { id: { in: productIds } } });
  if (userIds.length) {
    await prisma.address.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  orderIds.length = listingIds.length = productIds.length = userIds.length = 0;
});

after(async () => {
  await prisma.$disconnect();
  server.close();
});

async function makeCustomer(emailVerified = true) {
  const user = await prisma.user.create({
    data: {
      email: `${randomUUID()}@example.com`,
      passwordHash: "test-hash",
      emailVerified,
      role: "CUSTOMER",
      addresses: {
        create: {
          recipientName: "HTTP Customer",
          line1: "1 Test Street",
          city: "Testville",
          postcode: "T1",
          countryCode: "GB",
          isDefaultBilling: true,
        },
      },
    },
  });
  userIds.push(user.id);
  return { ...user, token: jwt.sign({ id: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: "1h" }) };
}

async function makeListing() {
  const product = await prisma.legoProduct.create({
    data: {
      setNumber: `CREATE-${randomUUID()}`,
      title: "HTTP Creation Product",
      theme: "TEST",
      ageRecommendation: "8+",
      pieceCount: 100,
    },
  });
  productIds.push(product.id);
  const listing = await prisma.productListing.create({
    data: {
        legoProductId: product.id, condition: "NEW", originalPrice: new Decimal(20), salePrice: new Decimal(15), currentStock: 7, active: true },
  });
  listingIds.push(listing.id);
  return listing;
}

describe("order creation HTTP integration", () => {
  it("authenticated customer creates an order through POST /orders", async () => {
    const customer = await makeCustomer();
    const listing = await makeListing();
    const response = await fetch(`${url}/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${customer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 2 }] }),
    });
    assert.strictEqual(response.status, 201);
    const body = await response.json();
    orderIds.push(body.id);
    assert.strictEqual(body.userId, customer.id);
    assert.strictEqual(body.orderItems.length, 1);
    assert.strictEqual(body.orderItems[0].productListingId, listing.id);
    assert.strictEqual(body.orderItems[0].quantity, 2);
    assert.strictEqual(body.orderItems[0].unitPrice, "15");
    assert.strictEqual(body.orderItems[0].lineTotal, "30");
    const persisted = await prisma.order.findUnique({ where: { id: body.id } });
    assert.strictEqual(persisted?.userId, customer.id);
    assert.strictEqual((await prisma.productListing.findUnique({ where: { id: listing.id } }))?.currentStock, 7);
  });

  it("rejects unauthenticated order creation", async () => {
    const response = await fetch(`${url}/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shippingMethod: "STANDARD" as const, items: [] }) });
    assert.strictEqual(response.status, 401);
  });

  it("rejects unverified customers before any order or inventory side effect", async () => {
    const customer = await makeCustomer(false);
    const listing = await makeListing();
    const before = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const response = await fetch(`${url}/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${customer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 1 }] }),
    });
    assert.strictEqual(response.status, 403);
    assert.deepStrictEqual(await response.json(), { error: { code: "EMAIL_VERIFICATION_REQUIRED", message: "Email verification required" } });
    assert.strictEqual(await prisma.order.count({ where: { userId: customer.id } }), 0);
    assert.deepStrictEqual(await prisma.productListing.findUnique({ where: { id: listing.id } }), before);
  });

  it("uses current database verification state with the same JWT", async () => {
    const customer = await makeCustomer(false);
    const listing = await makeListing();
    const request = () => fetch(`${url}/orders`, {
      method: "POST",
      headers: { Authorization: `Bearer ${customer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 1 }] }),
    });
    assert.strictEqual((await request()).status, 403);
    await prisma.user.update({ where: { id: customer.id }, data: { emailVerified: true } });
    const response = await request();
    assert.strictEqual(response.status, 201);
    const body = await response.json();
    orderIds.push(body.id);
  });
});

async function keyedCreate(customer: { token: string }, payload: unknown, key: string) {
  return fetch(`${url}/orders`, {
    method: "POST", headers: { Authorization: `Bearer ${customer.token}`, "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(payload),
  });
}

describe("durable order creation idempotency", () => {
  it("serializes concurrent retries, reuses persisted results and isolates customers", async () => {
    const customer = await makeCustomer();
    const listing = await makeListing();
    const key = randomUUID();
    const payload = { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 2 }] };
    const responses = await Promise.all(Array.from({ length: 4 }, () => keyedCreate(customer, payload, key)));
    const bodies = await Promise.all(responses.map((r) => r.json()));
    orderIds.push(...new Set(bodies.map((b) => b.id)));
    assert.ok(responses.every((r) => r.status === 201));
    assert.equal(new Set(bodies.map((b) => b.id)).size, 1);
    assert.equal(bodies[0].creationRequestHash, undefined);
    assert.equal(bodies[0].creationIdempotencyKey, undefined);
    assert.equal(await prisma.order.count({ where: { userId: customer.id } }), 1);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } })).reservedStock, 2);
    // A fresh DB connection plus changed server pricing/address must still replay
    // the original order rather than recalculate it.
    await prisma.$disconnect();
    await prisma.productListing.update({ where: { id: listing.id }, data: { salePrice: 19 } });
    await prisma.address.updateMany({ where: { userId: customer.id }, data: { line1: "Changed saved address" } });
    const replay = await (await keyedCreate(customer, payload, key)).json();
    assert.equal(replay.id, bodies[0].id);
    assert.equal(replay.totalAmount, "33.99");
    assert.equal(replay.billingLine1, "1 Test Street");
    const other = await makeCustomer();
    const isolated = await keyedCreate(other, payload, key);
    assert.equal(isolated.status, 201);
    const otherBody = await isolated.json(); orderIds.push(otherBody.id);
    assert.notEqual(otherBody.id, replay.id);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } })).reservedStock, 4);
  });

  it("rejects changed quantity or delivery address and invalid keys", async () => {
    const customer = await makeCustomer(); const listing = await makeListing(); const key = randomUUID();
    const payload = { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 1 }] };
    const first = await (await keyedCreate(customer, payload, key)).json(); orderIds.push(first.id);
    for (const changed of [
      { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 2 }] },
      { ...payload, deliveryAddress: { recipientName: "Other", line1: "2 Street", city: "London", postcode: "T2", countryCode: "GB" } },
    ]) {
      const response = await keyedCreate(customer, changed, key);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, "ORDER_IDEMPOTENCY_MISMATCH");
    }
    const invalid = await keyedCreate(customer, payload, "bad key");
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, "INVALID_IDEMPOTENCY_KEY");
    assert.equal(await prisma.order.count({ where: { userId: customer.id } }), 1);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } })).reservedStock, 1);
  });

  it("canonicalizes item ordering and validated address field ordering", async () => {
    const customer = await makeCustomer(); const a = await makeListing(); const b = await makeListing(); const key = randomUUID();
    const address = { recipientName: "Customer", line1: "3 Street", city: "London", postcode: "T3", countryCode: "GB" };
    const items = [{ productListingId: a.id, quantity: 1 }, { productListingId: b.id, quantity: 1 }];
    const first = await (await keyedCreate(customer, { shippingMethod: "STANDARD", items, deliveryAddress: address }, key)).json(); orderIds.push(first.id);
    const second = await keyedCreate(customer, { shippingMethod: "STANDARD" as const, items: [...items].reverse(), deliveryAddress: { countryCode: "GB", postcode: "T3", city: "London", line1: "3 Street", recipientName: " Customer " } }, key);
    assert.equal(second.status, 201);
    assert.equal((await second.json()).id, first.id);
  });

  it("rolls back a failed request so the same key can be retried", async () => {
    const customer = await makeCustomer(); const listing = await makeListing(); const key = randomUUID();
    const payload = { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 8 }] };
    assert.equal((await keyedCreate(customer, payload, key)).status, 409);
    assert.equal(await prisma.order.count({ where: { userId: customer.id } }), 0);
    await prisma.productListing.update({ where: { id: listing.id }, data: { currentStock: 8 } });
    const result = await keyedCreate(customer, payload, key); assert.equal(result.status, 201);
    orderIds.push((await result.json()).id);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } })).reservedStock, 8);
  });
});
