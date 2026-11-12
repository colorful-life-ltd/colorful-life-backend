import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";

const productIds: number[] = [];
const listingIds: number[] = [];
const userIds: number[] = [];
let server: Server;
let base: string;
let adminToken: string;
let customerToken: string;
let adminUserId: number;

before(async () => {
  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  base = `http://localhost:${address.port}`;

  async function makeUser(role: "ADMIN" | "CUSTOMER") {
    const user = await prisma.user.create({ data: { email: `${role}-${randomUUID()}@example.test`, passwordHash: "test", emailVerified: true, role } });
    userIds.push(user.id);
    return { id: user.id, token: jwt.sign({ id: user.id, role }, config.JWT_SECRET, { expiresIn: "1h" }) };
  }
  const admin = await makeUser("ADMIN");
  adminUserId = admin.id;
  adminToken = admin.token;
  customerToken = (await makeUser("CUSTOMER")).token;
});

afterEach(async () => {
  if (listingIds.length) {
    await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.$executeRawUnsafe('ALTER TABLE "UsedConditionPhoto" DISABLE TRIGGER "UsedConditionPhoto_terminal_immutable"');
    await prisma.$executeRawUnsafe('ALTER TABLE "ProductListing" DISABLE TRIGGER "ProductListing_used_lifecycle_guard"');
    try { await prisma.productListing.deleteMany({ where: { id: { in: listingIds } } }); }
    finally {
      await prisma.$executeRawUnsafe('ALTER TABLE "ProductListing" ENABLE TRIGGER "ProductListing_used_lifecycle_guard"');
      await prisma.$executeRawUnsafe('ALTER TABLE "UsedConditionPhoto" ENABLE TRIGGER "UsedConditionPhoto_terminal_immutable"');
    }
  }
  if (productIds.length) await prisma.legoProduct.deleteMany({ where: { id: { in: productIds } } });
  listingIds.length = productIds.length = 0;
});

after(async () => {
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function request(path: string, token?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

async function makeProduct(data: { setNumber?: string; title?: string; categoryId?: number } = {}) {
  const category = data.categoryId === undefined
    ? await prisma.category.findUniqueOrThrow({ where: { name: "Others" }, select: { id: true } })
    : { id: data.categoryId };
  const product = await prisma.legoProduct.create({
    data: {
      setNumber: data.setNumber ?? `ADMIN-EDIT-${randomUUID()}`,
      title: data.title ?? `Editable product ${randomUUID()}`,
      description: "Original description",
      theme: "Original theme",
      ageRecommendation: "8+",
      pieceCount: 120,
      categoryId: category.id,
    },
  });
  productIds.push(product.id);
  return { ...product, categoryId: category.id };
}

async function update(productId: number, body: unknown, token = adminToken) {
  return request(`/admin/products/${productId}`, token, { method: "PATCH", body: JSON.stringify(body) });
}

describe("Admin LegoProduct metadata update", () => {
  it("updates a product directly by LegoProduct ID, including products with no listings, and preserves omitted fields", async () => {
    const product = await makeProduct();
    assert.deepEqual(await prisma.productListing.findMany({ where: { legoProductId: product.id } }), []);

    const lookup = await (await request(`/admin/products?q=${encodeURIComponent(product.setNumber)}`, adminToken)).json();
    assert.equal(lookup.items[0].id, product.id);
    assert.equal(lookup.items[0].category.id, product.categoryId);
    const category = await prisma.category.findUniqueOrThrow({ where: { id: product.categoryId } });

    const response = await update(product.id, {
      title: "Updated title",
      description: "Updated description",
      theme: "Updated theme",
      ageRecommendation: "10+",
      pieceCount: 250,
    });
    assert.equal(response.status, 200, await response.clone().text());
    const updated = await response.json();
    assert.equal(updated.id, product.id);
    assert.equal(updated.setNumber, product.setNumber);
    assert.equal(updated.title, "Updated title");
    assert.equal(updated.description, "Updated description");
    assert.equal(updated.theme, "Updated theme");
    assert.equal(updated.ageRecommendation, "10+");
    assert.equal(updated.pieceCount, 250);
    assert.equal(updated.isRetired, product.isRetired);
    assert.equal(updated.categoryId, product.categoryId);
    assert.deepEqual(updated.category, {
      id: category.id,
      name: category.name,
      subtitle: category.subtitle,
      description: category.description,
      imageUrl: category.imageUrl,
      thumbnailUrl: category.thumbnailUrl,
    });
    assert.deepEqual(updated.productImages, []);

    const stored = await prisma.legoProduct.findUniqueOrThrow({ where: { id: product.id } });
    assert.equal(stored.title, "Updated title");
    assert.equal(stored.description, "Updated description");
    assert.equal(stored.theme, "Updated theme");
    assert.equal(stored.ageRecommendation, "10+");
    assert.equal(stored.pieceCount, 250);
  });

  it("updates categoryId, rejects malformed or missing categories without changing the product", async () => {
    const product = await makeProduct();
    const target = await prisma.category.findUniqueOrThrow({ where: { name: "Vehicles" } });

    const success = await update(product.id, { categoryId: target.id });
    assert.equal(success.status, 200, await success.clone().text());
    const updated = await success.json();
    assert.equal(updated.categoryId, target.id);
    assert.equal(updated.category.id, target.id);
    assert.equal(updated.category.name, "Vehicles");

    for (const categoryId of [0, -1, 1.5, "not-an-id", null]) {
      assert.equal((await update(product.id, { categoryId })).status, 400);
    }
    const beforeMissing = await prisma.legoProduct.findUniqueOrThrow({ where: { id: product.id } });
    const missing = await update(product.id, { categoryId: 999_999_999, title: "Must not partially update" });
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error, "Category not found");
    assert.deepEqual(await prisma.legoProduct.findUniqueOrThrow({ where: { id: product.id } }), beforeMissing);
  });

  it("updates setNumber and returns 409 for duplicates without changing either product", async () => {
    const product = await makeProduct();
    const other = await makeProduct();
    const newSetNumber = `ADMIN-EDIT-SET-${randomUUID()}`;

    const success = await update(product.id, { setNumber: newSetNumber });
    assert.equal(success.status, 200, await success.clone().text());
    assert.equal((await success.json()).setNumber, newSetNumber);

    const beforeConflict = await prisma.legoProduct.findUniqueOrThrow({ where: { id: product.id } });
    const conflict = await update(product.id, { setNumber: other.setNumber });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error, "setNumber already exists");
    assert.deepEqual(await prisma.legoProduct.findUniqueOrThrow({ where: { id: product.id } }), beforeConflict);
    assert.equal((await prisma.legoProduct.findUniqueOrThrow({ where: { id: other.id } })).setNumber, other.setNumber);
  });

  it("leaves listing, inventory movement, Used lifecycle, and condition-photo data unchanged", async () => {
    const product = await makeProduct();
    const newListing = await prisma.productListing.create({ data: {
      legoProductId: product.id, condition: "NEW", originalPrice: 45, salePrice: 40,
      currentStock: 3, reservedStock: 1, active: false,
    } });
    listingIds.push(newListing.id);
    const usedListing = await prisma.productListing.create({ data: {
      legoProductId: product.id, condition: "USED_LIKE_NEW", originalPrice: 20, salePrice: 18,
      currentStock: 1, active: true, usedLifecycle: "AVAILABLE", damageDescription: "Small box crease",
      usedConditionPhotos: { create: { url: "https://images.example/used.jpg", publicId: `used-${randomUUID()}`, sortOrder: 0 } },
    } });
    listingIds.push(usedListing.id);
    await prisma.inventoryMovement.create({ data: {
      listingId: newListing.id, quantityChange: 3, type: "MANUAL_ADJUSTMENT", note: "test fixture",
      performedByUserId: adminUserId,
    } });

    const listingsBefore = await prisma.productListing.findMany({ where: { legoProductId: product.id }, orderBy: { id: "asc" }, include: { usedConditionPhotos: true } });
    const movementsBefore = await prisma.inventoryMovement.findMany({ where: { listingId: { in: listingIds } }, orderBy: { id: "asc" } });
    const photosBefore = await prisma.usedConditionPhoto.findMany({ where: { listingId: usedListing.id }, orderBy: { id: "asc" } });

    const response = await update(product.id, { title: "Metadata only", isRetired: true });
    assert.equal(response.status, 200, await response.clone().text());

    const listingsAfter = await prisma.productListing.findMany({ where: { legoProductId: product.id }, orderBy: { id: "asc" }, include: { usedConditionPhotos: true } });
    assert.deepEqual(listingsAfter, listingsBefore);
    assert.deepEqual(await prisma.inventoryMovement.findMany({ where: { listingId: { in: listingIds } }, orderBy: { id: "asc" } }), movementsBefore);
    assert.deepEqual(await prisma.usedConditionPhoto.findMany({ where: { listingId: usedListing.id }, orderBy: { id: "asc" } }), photosBefore);
  });

  it("enforces Admin authorization and rejects empty or unsupported updates", async () => {
    const product = await makeProduct();
    assert.equal((await update(product.id, { title: "Unauthenticated" }, "")).status, 401);
    assert.equal((await update(product.id, { title: "Forbidden" }, customerToken)).status, 403);
    assert.equal((await update(product.id, {})).status, 400);
    assert.equal((await update(product.id, { currentStock: 10 })).status, 400);
    assert.equal((await update(product.id, { unknownField: "value" })).status, 400);
    assert.equal((await update(product.id, { description: null })).status, 400);
    assert.equal((await update(product.id, { title: "" })).status, 400);
    assert.equal((await prisma.legoProduct.findUniqueOrThrow({ where: { id: product.id } })).title, product.title);

    const authorized = await update(product.id, { isRetired: true });
    assert.equal(authorized.status, 200);
    assert.equal((await authorized.json()).isRetired, true);
  });
});
