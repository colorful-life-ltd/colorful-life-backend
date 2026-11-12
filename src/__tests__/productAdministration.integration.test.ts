import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";

const userIds: number[] = [];
const productIds: number[] = [];
const listingIds: number[] = [];
const categoryIds: number[] = [];
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
  if (listingIds.length) {
    await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.productListing.deleteMany({ where: { id: { in: listingIds } } });
  }
  if (productIds.length) await prisma.legoProduct.deleteMany({ where: { id: { in: productIds } } });
  if (categoryIds.length) await prisma.category.deleteMany({ where: { id: { in: categoryIds } } });
  if (userIds.length) {
    await prisma.address.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  userIds.length = productIds.length = listingIds.length = categoryIds.length = 0;
});

after(async () => {
  await prisma.$disconnect();
  server.close();
});

async function makeUser(role: "ADMIN" | "CUSTOMER") {
  const user = await prisma.user.create({
    data: {
      email: `${role.toLowerCase()}-${randomUUID()}@example.com`,
      passwordHash: "test-hash",
      emailVerified: true,
      role,
      addresses: { create: { recipientName: role, line1: "1 Test Street", city: "Testville", postcode: "T1", countryCode: "GB", isDefaultBilling: true } },
    },
  });
  userIds.push(user.id);
  return { id: user.id, token: jwt.sign({ id: user.id, role }, config.JWT_SECRET, { expiresIn: "1h" }) };
}

async function makeCategory() {
  const category = await prisma.category.create({ data: { name: `Auto Feature ${randomUUID()}` } });
  categoryIds.push(category.id);
  return category;
}

async function makeListing() {
  const category = await prisma.category.findUniqueOrThrow({ where: { name: "Others" } });
  const product = await prisma.legoProduct.create({
    data: { setNumber: `ADMIN-${randomUUID()}`, title: "Administration Product", theme: "TEST", ageRecommendation: "8+", pieceCount: 100, categoryId: category.id },
  });
  productIds.push(product.id);
  const listing = await prisma.productListing.create({
    data: {
        legoProductId: product.id, condition: "NEW", originalPrice: 20, currentStock: 3, active: true },
  });
  listingIds.push(listing.id);
  return listing;
}

function request(path: string, token: string | undefined, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${url}${path}`, { ...init, headers });
}

const productBody = (categoryId: number) => ({
  setNumber: "ADMIN-ROUTED-UNIQUE",
  title: "Created Product",
  theme: "TEST",
  ageRecommendation: "8+",
  pieceCount: 50,
  condition: "NEW",
  categoryId,
  originalPrice: 12,
  currentStock: 2,
});

describe("product administration authorization", () => {
  it("keeps catalogue reads public and protects every administration surface", async () => {
    const admin = await makeUser("ADMIN");
    const customer = await makeUser("CUSTOMER");
    const listing = await makeListing();

    assert.strictEqual((await request("/products", undefined)).status, 200);
    const publicProductResponse = await request(`/products/${listing.id}`, undefined);
    assert.strictEqual(publicProductResponse.status, 200);
    assert.strictEqual((await publicProductResponse.json()).category.name, "Others");
    const vehicles = await prisma.category.findUniqueOrThrow({ where: { name: "Vehicles" } });

    const protectedRequests: Array<{ path: string; method: string; body?: unknown }> = [
      { path: "/products", method: "POST", body: productBody(vehicles.id) },
      { path: `/products/${listing.id}`, method: "PATCH", body: { title: "Changed" } },
      { path: `/products/${listing.id}`, method: "PATCH", body: { isRetired: true } },
      { path: `/products/${listing.id}/deactivate`, method: "PATCH" },
      { path: `/products/${listing.id}/reactivate`, method: "PATCH" },
      { path: `/products/${listing.id}/inventory-adjustments`, method: "POST", body: { quantity: 1 } },
      { path: `/products/${listing.id}/inventory-movements`, method: "GET" },
    ];
    for (const target of protectedRequests) {
      const body = target.body === undefined ? undefined : JSON.stringify(target.body);
      assert.strictEqual((await request(target.path, undefined, { method: target.method, body })).status, 401);
      assert.strictEqual((await request(target.path, customer.token, { method: target.method, body })).status, 403);
    }

    const createdResponse = await request("/products", admin.token, { method: "POST", body: JSON.stringify(productBody(vehicles.id)) });
    assert.strictEqual(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.strictEqual(created.category.name, "Vehicles");
    assert.strictEqual(created.legoProduct.isRetired, false);
    listingIds.push(created.id);
    productIds.push(created.legoProductId);

    const updateResponse = await request(`/products/${listing.id}`, admin.token, { method: "PATCH", body: JSON.stringify({ title: "Updated Product" }) });
    assert.strictEqual(updateResponse.status, 200);
    assert.strictEqual((await updateResponse.json()).category.name, "Others");
    const stockEditResponse = await request(`/products/${listing.id}`, admin.token, { method: "PATCH", body: JSON.stringify({ currentStock: 99 }) });
    assert.strictEqual(stockEditResponse.status, 400);
    const mixedStockEditResponse = await request(`/products/${listing.id}`, admin.token, { method: "PATCH", body: JSON.stringify({ title: "Should not update", currentStock: 99 }) });
    assert.strictEqual(mixedStockEditResponse.status, 400);
    assert.strictEqual((await prisma.legoProduct.findUniqueOrThrow({ where: { id: listing.legoProductId } })).title, "Updated Product");
    assert.strictEqual((await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } })).currentStock, 3);
    assert.strictEqual((await request(`/products/${listing.id}`, admin.token, { method: "PATCH", body: JSON.stringify({ categoryId: vehicles.id }) })).status, 400);
    assert.strictEqual((await request(`/products/${listing.id}/deactivate`, admin.token, { method: "PATCH" })).status, 200);
    assert.strictEqual((await request(`/products/${listing.id}/reactivate`, admin.token, { method: "PATCH" })).status, 200);
    assert.strictEqual((await request(`/products/${listing.id}/inventory-adjustments`, admin.token, { method: "POST", body: JSON.stringify({ quantity: 1 }) })).status, 200);
    const movementsResponse = await request(`/products/${listing.id}/inventory-movements`, admin.token);
    assert.strictEqual(movementsResponse.status, 200);
    assert.strictEqual((await movementsResponse.json()).movements.length, 1);
  });

  it("requires and validates Category identity on creation", async () => {
    const admin = await makeUser("ADMIN");
    const vehicles = await prisma.category.findUniqueOrThrow({ where: { name: "Vehicles" } });
    const missing = { ...productBody(vehicles.id), setNumber: `ADMIN-MISSING-${randomUUID()}` };
    delete (missing as Partial<typeof missing>).categoryId;
    assert.strictEqual((await request("/products", admin.token, { method: "POST", body: JSON.stringify(missing) })).status, 400);

    const invalid = { ...productBody(vehicles.id), setNumber: `ADMIN-INVALID-${randomUUID()}`, categoryId: 999999999 };
    assert.strictEqual((await request("/products", admin.token, { method: "POST", body: JSON.stringify(invalid) })).status, 400);
  });

  it("creates manually retired and explicitly non-retired products", async () => {
    const admin = await makeUser("ADMIN");
    const category = await makeCategory();
    for (const isRetired of [true, false]) {
      const response = await request("/products", admin.token, {
        method: "POST",
        body: JSON.stringify({ ...productBody(category.id), setNumber: `RETIRED-${randomUUID()}`, isRetired }),
      });
      assert.equal(response.status, 201, await response.clone().text());
      const created = await response.json();
      listingIds.push(created.id);
      productIds.push(created.legoProductId);
      assert.equal(created.legoProduct.isRetired, isRetired);
      assert.equal(Object.hasOwn(created, "isRetired"), false);
      assert.equal((await prisma.legoProduct.findUniqueOrThrow({ where: { id: created.legoProductId } })).isRetired, isRetired);
      const detail = await request(`/products/${created.id}`, undefined);
      assert.equal(detail.status, 200);
      assert.equal((await detail.json()).legoProduct.isRetired, isRetired);
    }
  });

  it("rejects non-boolean retirement values on create and shared edits without partial writes", async () => {
    const admin = await makeUser("ADMIN");
    const category = await makeCategory();
    const listing = await makeListing();
    const productBefore = await prisma.legoProduct.findUniqueOrThrow({ where: { id: listing.legoProductId } });
    for (const isRetired of ["true", "false", 0, 1, null, {}, []]) {
      const setNumber = `INVALID-RETIRED-${randomUUID()}`;
      const create = await request("/products", admin.token, {
        method: "POST", body: JSON.stringify({ ...productBody(category.id), setNumber, isRetired }),
      });
      assert.equal(create.status, 400);
      assert.ok((await create.json()).error.isRetired);
      assert.equal(await prisma.legoProduct.count({ where: { setNumber } }), 0);
      const update = await request(`/products/${listing.id}`, admin.token, {
        method: "PATCH", body: JSON.stringify({ isRetired, title: "Must not change", originalPrice: 99 }),
      });
      assert.equal(update.status, 400);
      assert.ok((await update.json()).error.isRetired);
    }
    assert.deepEqual(await prisma.legoProduct.findUniqueOrThrow({ where: { id: listing.legoProductId } }), productBefore);
    assert.deepEqual(await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } }), listing);
  });

  it("automatically features the first listing per category, preserves it, and serializes concurrent creation", async () => {
    const admin = await makeUser("ADMIN");
    const category = await makeCategory();
    const secondCategory = await makeCategory();
    const create = async (categoryId: number, title: string) => {
      const response = await request("/products", admin.token, {
        method: "POST",
        body: JSON.stringify({ ...productBody(categoryId), setNumber: `AUTO-FEATURE-${randomUUID()}`, title }),
      });
      assert.equal(response.status, 201);
      const listing = await response.json();
      listingIds.push(listing.id);
      productIds.push(listing.legoProductId);
      return listing;
    };

    const first = await create(category.id, "First category listing");
    const second = await create(category.id, "Second category listing");
    assert.equal(first.legoProduct.isFeatureProduct, true);
    assert.equal(second.legoProduct.isFeatureProduct, false);
    assert.equal((await prisma.legoProduct.findUniqueOrThrow({ where: { id: first.legoProductId } })).isFeatureProduct, true);

    const otherCategoryListing = await create(secondCategory.id, "Other category listing");
    assert.equal(otherCategoryListing.legoProduct.isFeatureProduct, true);

    assert.equal((await request(`/products/by-product/${second.legoProductId}/feature`, admin.token, { method: "PATCH" })).status, 200);
    assert.equal((await prisma.legoProduct.findUniqueOrThrow({ where: { id: first.legoProductId } })).isFeatureProduct, false);
    assert.equal((await prisma.legoProduct.findUniqueOrThrow({ where: { id: second.legoProductId } })).isFeatureProduct, true);
    assert.equal((await prisma.legoProduct.findUniqueOrThrow({ where: { id: otherCategoryListing.legoProductId } })).isFeatureProduct, true);

    const concurrentCategory = await makeCategory();
    const concurrentListings = await Promise.all([
      create(concurrentCategory.id, "Concurrent listing A"),
      create(concurrentCategory.id, "Concurrent listing B"),
    ]);
    assert.equal(concurrentListings.filter((listing) => listing.legoProduct.isFeatureProduct).length, 1);
    assert.equal(await prisma.legoProduct.count({
      where: { id: { in: concurrentListings.map((listing) => listing.legoProductId) }, isFeatureProduct: true },
    }), 1);

    const rollbackCategory = await makeCategory();
    const duplicateSetNumber = `AUTO-FEATURE-DUPLICATE-${randomUUID()}`;
    const conflictingProduct = await prisma.legoProduct.create({ data: {
      setNumber: duplicateSetNumber, title: "Existing product", theme: "TEST", ageRecommendation: "8+", pieceCount: 1,
    } });
    productIds.push(conflictingProduct.id);
    const failedCreate = await request("/products", admin.token, {
      method: "POST",
      body: JSON.stringify({ ...productBody(rollbackCategory.id), setNumber: duplicateSetNumber, title: "Conflicting listing" }),
    });
    assert.equal(failedCreate.status, 409);
    assert.equal(await prisma.legoProduct.count({ where: { categoryId: rollbackCategory.id } }), 0);
    assert.equal(await prisma.legoProduct.count({ where: { categoryId: rollbackCategory.id, isFeatureProduct: true } }), 0);
  });
});
