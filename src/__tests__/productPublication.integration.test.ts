import assert from "node:assert/strict";
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { Pool } from "pg";
import { Decimal } from "@prisma/client/runtime/client";
import app from "../app.js";
import { prisma } from "../prisma/runtime.js";
import { config } from "../config/index.js";
import { TEST_DATABASE_NAME, validateTestDatabase } from "../config/testDatabase.js";

const migration = readFileSync(resolve(process.cwd(), "prisma/migrations/20261016120000_add_product_publication/migration.sql"), "utf8");
const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
const productIds: number[] = [];
const listingIds: number[] = [];
const userIds: number[] = [];
const orderIds: number[] = [];
let server: Server;
let url: string;

before(async () => {
  assert.equal(config.DATABASE_URL, validateTestDatabase(process.env).url);
  server = app.listen(0);
  await new Promise<void>((done) => server.once("listening", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  url = `http://localhost:${address.port}`;
});

afterEach(async () => {
  if (orderIds.length) await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  if (userIds.length) {
    await prisma.cart.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.address.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  const createdListings = await prisma.productListing.findMany({ where: { legoProductId: { in: productIds } }, select: { id: true } });
  const allListingIds = [...listingIds, ...createdListings.map((listing) => listing.id)];
  if (allListingIds.length) {
    await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: allListingIds } } });
    await prisma.productListing.deleteMany({ where: { id: { in: allListingIds } } });
  }
  if (productIds.length) await prisma.legoProduct.deleteMany({ where: { id: { in: productIds } } });
  orderIds.length = userIds.length = listingIds.length = productIds.length = 0;
});

after(async () => { await pool.end(); await prisma.$disconnect(); server.close(); });

async function makeListing({ isPublished, currentStock = 5 }: { isPublished?: boolean; currentStock?: number } = {}) {
  const product = await prisma.legoProduct.create({
    data: { setNumber: `PUB-${randomUUID()}`, title: "Publication product", theme: "Test", ageRecommendation: "8+", pieceCount: 100, isPublished },
  });
  productIds.push(product.id);
  const listing = await prisma.productListing.create({
    data: { legoProductId: product.id, condition: "NEW", originalPrice: new Decimal(20), currentStock },
  });
  listingIds.push(listing.id);
  return listing;
}

async function makeUser(role: "CUSTOMER" | "ADMIN" = "CUSTOMER") {
  const user = await prisma.user.create({
    data: {
      email: `${randomUUID()}@example.com`, passwordHash: "hash", emailVerified: true, role,
      addresses: { create: { recipientName: "Publication Customer", line1: "1 Test Street", city: "Testville", postcode: "T1", countryCode: "GB", isDefaultBilling: true } },
    },
  });
  userIds.push(user.id);
  return { ...user, token: jwt.sign({ id: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: "1h" }) };
}

function call(path: string, init: RequestInit & { token?: string } = {}) {
  const { token, ...rest } = init;
  return fetch(`${url}${path}`, {
    ...rest,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(rest.headers ?? {}) },
  });
}

const setPublished = (productId: number, isPublished: boolean) =>
  prisma.legoProduct.update({ where: { id: productId }, data: { isPublished } });

describe("product publication legacy migration", () => {
  it("publishes stocked or previously sold products, keeps drafts and deactivated products private, and defaults new products to published", async () => {
    const client = await pool.connect();
    const schema = `product_publication_${randomUUID().replaceAll("-", "")}`;
    try {
      assert.equal((await client.query<{ name: string }>("SELECT current_database() AS name")).rows[0]?.name, TEST_DATABASE_NAME);
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET search_path TO "${schema}"`);
      await client.query("SET statement_timeout = '5s'");
      await client.query(`
        CREATE TABLE "LegoProduct" ("id" INTEGER PRIMARY KEY);
        CREATE TABLE "ProductListing" (
          "id" SERIAL PRIMARY KEY,
          "legoProductId" INTEGER NOT NULL REFERENCES "LegoProduct"("id"),
          "condition" TEXT NOT NULL,
          "usedLifecycle" TEXT,
          "currentStock" INTEGER NOT NULL,
          "reservedStock" INTEGER NOT NULL DEFAULT 0,
          "active" BOOLEAN NOT NULL DEFAULT true
        );
        CREATE TABLE "InventoryMovement" ("id" SERIAL PRIMARY KEY, "listingId" INTEGER NOT NULL REFERENCES "ProductListing"("id"));
        CREATE TABLE "OrderItem" ("id" SERIAL PRIMARY KEY, "productListingId" INTEGER NOT NULL REFERENCES "ProductListing"("id"));
      `);
      type History = "movement" | "order" | null;
      const cases: Array<[string, boolean, Array<[string, string | null, number, number, boolean, History?]>]> = [
        // [label, expected, listings: condition, usedLifecycle, currentStock, reservedStock, active, history]
        ["in-stock NEW", true, [["NEW", null, 3, 0, true]]],
        ["fully reserved NEW (transient checkout hold)", true, [["NEW", null, 2, 2, true]]],
        ["available Used", true, [["USED_LIKE_NEW", "AVAILABLE", 1, 0, true]]],
        ["mixed zero-stock and in-stock offers", true, [["NEW", null, 0, 0, true], ["USED_LIKE_NEW", "AVAILABLE", 1, 0, true]]],
        ["sold-out NEW with sales history", true, [["NEW", null, 0, 0, true, "order"]]],
        ["sold-out NEW with stock history only", true, [["NEW", null, 0, 0, true, "movement"]]],
        ["sold Used with history", true, [["USED_LIKE_NEW", "SOLD", 0, 0, true, "order"]]],
        ["draft: zero-stock NEW that never held stock", false, [["NEW", null, 0, 0, true]]],
        ["draft: no listings", false, []],
        ["private: deactivated with stock", false, [["NEW", null, 4, 0, false]]],
        ["private: deactivated with sales history", false, [["NEW", null, 0, 0, false, "order"]]],
        ["private history plus active draft offer", false, [["NEW", null, 0, 0, false, "movement"], ["NEW", null, 0, 0, true]]],
        ["retired Used with stale stock and no history", false, [["USED_LIKE_NEW", "RETIRED", 1, 0, true]]],
      ];
      for (const [index, [, , listings]] of cases.entries()) {
        await client.query(`INSERT INTO "LegoProduct" ("id") VALUES ($1)`, [index + 1]);
        for (const [condition, lifecycle, stock, reserved, active, history] of listings) {
          const { rows: [listing] } = await client.query<{ id: number }>(
            `INSERT INTO "ProductListing" ("legoProductId", "condition", "usedLifecycle", "currentStock", "reservedStock", "active") VALUES ($1, $2, $3, $4, $5, $6) RETURNING "id"`,
            [index + 1, condition, lifecycle, stock, reserved, active],
          );
          if (history === "movement") await client.query(`INSERT INTO "InventoryMovement" ("listingId") VALUES ($1)`, [listing.id]);
          if (history === "order") await client.query(`INSERT INTO "OrderItem" ("productListingId") VALUES ($1)`, [listing.id]);
        }
      }
      await client.query(migration);
      const rows = (await client.query<{ id: number; isPublished: boolean }>(`SELECT "id", "isPublished" FROM "LegoProduct" ORDER BY "id"`)).rows;
      assert.deepEqual(rows.map((row) => [cases[row.id - 1][0], row.isPublished]), cases.map(([label, expected]) => [label, expected]));
      await client.query(`INSERT INTO "LegoProduct" ("id") VALUES (100)`);
      assert.equal((await client.query(`SELECT "isPublished" FROM "LegoProduct" WHERE "id" = 100`)).rows[0].isPublished, true);
      await assert.rejects(client.query(`UPDATE "LegoProduct" SET "isPublished" = NULL WHERE "id" = 1`));
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await client.query("RESET search_path");
      client.release();
    }
  });
});

describe("product publication HTTP integration", () => {
  it("hides unpublished products from every public product API even when in stock", async () => {
    const listing = await makeListing({ isPublished: false, currentStock: 5 });
    const product = await prisma.legoProduct.findUniqueOrThrow({ where: { id: listing.legoProductId } });
    const list = await (await call(`/products?q=${product.setNumber}`)).json();
    assert.deepEqual(list.items, []);
    assert.equal(list.pagination.totalItems, 0);
    assert.equal((await call(`/products?q=${product.setNumber}&minPrice=1`)).status, 200);
    assert.deepEqual((await (await call(`/products?q=${product.setNumber}&minPrice=1`)).json()).items, []);
    assert.equal((await call(`/products/by-product/${product.id}`)).status, 404);
    assert.equal((await call(`/products/${listing.id}`)).status, 404);

    await setPublished(product.id, true);
    assert.equal((await call(`/products/by-product/${product.id}`)).status, 200);
    assert.equal((await call(`/products/${listing.id}`)).status, 200);
  });

  it("keeps published sold-out products visible while purchases stay restricted", async () => {
    const listing = await makeListing({ currentStock: 0 });
    const detail = await call(`/products/by-product/${listing.legoProductId}`);
    assert.equal(detail.status, 200);
    const body = await detail.json();
    assert.deepEqual([body.isPublished, body.availability, body.offers], [true, "OUT_OF_STOCK", []]);
    const customer = await makeUser();
    assert.equal((await call("/cart/items", { method: "POST", token: customer.token, body: JSON.stringify({ productListingId: listing.id, quantity: 1 }) })).status, 409);
    // Availability conflicts use the actionable Issue #173 checkout envelope.
    assert.equal((await call("/orders", { method: "POST", token: customer.token, body: JSON.stringify({ shippingMethod: "STANDARD", items: [{ productListingId: listing.id, quantity: 1 }] }) })).status, 409);
  });

  it("rejects cart and order purchases of unpublished products without reserving stock", async () => {
    const listing = await makeListing({ currentStock: 5 });
    const customer = await makeUser();
    assert.equal((await call("/cart/items", { method: "POST", token: customer.token, body: JSON.stringify({ productListingId: listing.id, quantity: 1 }) })).status, 200);

    await setPublished(listing.legoProductId, false);
    assert.equal((await call("/cart/items", { method: "POST", token: customer.token, body: JSON.stringify({ productListingId: listing.id, quantity: 1 }) })).status, 409);
    const order = await call("/orders", { method: "POST", token: customer.token, body: JSON.stringify({ shippingMethod: "STANDARD", items: [{ productListingId: listing.id, quantity: 1 }] }) });
    assert.equal(order.status, 409);
    const error = (await order.json()).error;
    assert.equal(error.code, "LISTING_UNAVAILABLE");
    assert.equal(error.reason, "PRODUCT_UNPUBLISHED");
    assert.equal(error.productListingId, listing.id);
    const persisted = await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.deepEqual([persisted.currentStock, persisted.reservedStock], [5, 0]);
    assert.equal(await prisma.order.count({ where: { userId: customer.id } }), 0);
    // The existing cart line is preserved, matching deactivated-listing behaviour.
    assert.equal((await (await call("/cart", { token: customer.token })).json()).items.length, 1);

    await setPublished(listing.legoProductId, true);
    const republished = await call("/orders", { method: "POST", token: customer.token, body: JSON.stringify({ shippingMethod: "STANDARD", items: [{ productListingId: listing.id, quantity: 1 }] }) });
    assert.equal(republished.status, 201);
    orderIds.push((await republished.json()).id);
  });

  it("leaves historical orders untouched when a product is unpublished", async () => {
    const listing = await makeListing({ currentStock: 5 });
    const customer = await makeUser();
    const created = await call("/orders", { method: "POST", token: customer.token, body: JSON.stringify({ shippingMethod: "STANDARD", items: [{ productListingId: listing.id, quantity: 2 }] }) });
    assert.equal(created.status, 201);
    const orderId = (await created.json()).id;
    orderIds.push(orderId);
    const snapshot = () => prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { orderItems: true } });
    const before = await snapshot();

    await setPublished(listing.legoProductId, false);
    assert.deepEqual(await snapshot(), before);
    const read = await call(`/orders/${orderId}`, { token: customer.token });
    assert.equal(read.status, 200);
    assert.deepEqual((await read.json()).orderItems.map((item: any) => item.quantity), [2]);
  });

  it("lets ADMIN publish and unpublish through product metadata and exposes the state to Admin reads", async () => {
    const listing = await makeListing();
    const product = await prisma.legoProduct.findUniqueOrThrow({ where: { id: listing.legoProductId } });
    const admin = await makeUser("ADMIN");
    const customer = await makeUser();
    const patch = (token: string, body: unknown) => call(`/admin/products/${product.id}`, { method: "PATCH", token, body: JSON.stringify(body) });

    assert.equal((await patch(customer.token, { isPublished: false })).status, 403);
    assert.equal((await patch(admin.token, { isPublished: "no" })).status, 400);
    const unpublished = await patch(admin.token, { isPublished: false });
    assert.equal(unpublished.status, 200);
    assert.equal((await unpublished.json()).isPublished, false);
    assert.equal((await call(`/products/by-product/${product.id}`)).status, 404);

    const lookup = await (await call(`/admin/products?q=${product.setNumber}`, { token: admin.token })).json();
    assert.deepEqual(lookup.items.map((item: any) => [item.id, item.isPublished]), [[product.id, false]]);

    assert.equal((await (await patch(admin.token, { isPublished: true })).json()).isPublished, true);
    assert.equal((await call(`/products/by-product/${product.id}`)).status, 200);

    // Legacy listing editing ignores publication; it stays a product-level Admin operation.
    const legacy = await call(`/products/${listing.id}`, { method: "PATCH", token: admin.token, body: JSON.stringify({ isPublished: false }) });
    assert.equal(legacy.status, 400);
    assert.equal((await prisma.legoProduct.findUniqueOrThrow({ where: { id: product.id } })).isPublished, true);
  });

  it("creates products published by default and honours an explicit unpublished creation", async () => {
    const admin = await makeUser("ADMIN");
    const category = await prisma.category.findUniqueOrThrow({ where: { name: "Others" } });
    const create = async (extra: Record<string, unknown>) => {
      const response = await call("/products", {
        method: "POST", token: admin.token,
        body: JSON.stringify({ setNumber: `PUB-NEW-${randomUUID()}`, title: "New", theme: "Test", categoryId: category.id, ageRecommendation: "8+", pieceCount: 10, condition: "NEW", originalPrice: 10, currentStock: 1, ...extra }),
      });
      assert.equal(response.status, 201);
      const body = await response.json();
      productIds.push(body.legoProductId);
      return body;
    };
    const defaulted = await create({});
    assert.equal(defaulted.legoProduct.isPublished, true);
    assert.equal((await call(`/products/by-product/${defaulted.legoProductId}`)).status, 200);
    const draft = await create({ isPublished: false });
    assert.equal(draft.legoProduct.isPublished, false);
    assert.equal((await call(`/products/by-product/${draft.legoProductId}`)).status, 404);
  });
});
