import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import type { ImageStorage, ImageUploadInput, StoredImage } from "../infrastructure/imageStorage/imageStorage.js";

const png = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082", "hex"));

class TestImageStorage implements ImageStorage {
  async upload(input: ImageUploadInput): Promise<StoredImage> {
    const publicId = `admin-lookup/${input.publicId}`;
    return { publicId, secureUrl: `https://images.test/${publicId}` };
  }
  async delete(_publicId: string) {}
}

const productIds: number[] = [];
const listingIds: number[] = [];
const userIds: number[] = [];
let server: Server;
let base: string;
let adminToken: string;
let customerToken: string;

before(async () => {
  server = createApp(new TestImageStorage()).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  base = `http://localhost:${address.port}`;

  async function makeUser(role: "ADMIN" | "CUSTOMER") {
    const user = await prisma.user.create({ data: { email: `${role}-${randomUUID()}@example.test`, passwordHash: "test", role } });
    userIds.push(user.id);
    return jwt.sign({ id: user.id, role }, config.JWT_SECRET, { expiresIn: "1h" });
  }
  adminToken = await makeUser("ADMIN");
  customerToken = await makeUser("CUSTOMER");
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
  return fetch(`${base}${path}`, { ...init, headers });
}

async function makeProduct(data: { setNumber?: string; title?: string; currentStock?: number }) {
  const category = await prisma.category.findUniqueOrThrow({ where: { name: "Others" }, select: { id: true } });
  const product = await prisma.legoProduct.create({
    data: {
      setNumber: data.setNumber ?? `ADMIN-LOOKUP-${randomUUID()}`,
      title: data.title ?? `Lookup ${randomUUID()}`,
      theme: "Test",
      ageRecommendation: "8+",
      pieceCount: 100,
      categoryId: category.id,
    },
  });
  productIds.push(product.id);
  if (data.currentStock !== undefined) {
    const listing = await prisma.productListing.create({
      data: { legoProductId: product.id, condition: "NEW", originalPrice: 50, currentStock: data.currentStock },
    });
    listingIds.push(listing.id);
  }
  return product;
}

async function createUsed(productId: number) {
  const form = new FormData();
  form.append("originalPrice", "50");
  form.append("damageDescription", "Outer box corner dent");
  form.append("conditionPhotos", new Blob([Buffer.from(png)], { type: "image/png" }), "condition.png");
  const response = await request(`/products/${productId}/used-offers`, adminToken, { method: "POST", body: form });
  assert.equal(response.status, 201, await response.clone().text());
  const listing = await response.json();
  listingIds.push(listing.id);
  return listing;
}

async function search(q: string, token = adminToken, params = "") {
  return request(`/admin/products?q=${encodeURIComponent(q)}${params}`, token);
}

describe("Admin LegoProduct lookup", () => {
  it("requires authentication and ADMIN role, then searches set number and title", async () => {
    const product = await makeProduct({ setNumber: `112-${randomUUID()}`, title: `Admin title ${randomUUID()}`, currentStock: 2 });
    assert.equal((await search(product.setNumber, "")).status, 401);
    assert.equal((await search(product.setNumber, customerToken)).status, 403);

    const bySetNumber = await (await search(product.setNumber.toLowerCase())).json();
    assert.equal(bySetNumber.items.length, 1);
    assert.deepEqual(bySetNumber.items[0], {
      id: product.id,
      setNumber: product.setNumber,
      title: product.title,
      description: null,
      theme: "Test",
      ageRecommendation: "8+",
      pieceCount: 100,
      category: { id: product.categoryId, name: "Others" },
      isRetired: false,
      isPublished: true,
      usedOfferStatus: "NONE",
    });
    assert.equal(bySetNumber.pagination.totalItems, 1);

    const byTitle = await (await search(product.title.toUpperCase())).json();
    assert.deepEqual(byTitle.items.map((item: any) => item.id), [product.id]);
  });

  it("returns zero-stock products and products with no listing, which the public catalogue shows as sold out", async () => {
    const zeroStock = await makeProduct({ setNumber: `112-ZERO-${randomUUID()}`, currentStock: 0 });
    const noListing = await makeProduct({ setNumber: `112-NONE-${randomUUID()}` });

    for (const product of [zeroStock, noListing]) {
      const response = await search(product.setNumber);
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).items.map((item: any) => item.id), [product.id]);
      const publicCatalogue = await (await request(`/products?q=${encodeURIComponent(product.setNumber)}`)).json();
      assert.deepEqual(publicCatalogue.items.map((item: any) => [item.id, item.availability, item.offers]), [[product.id, "OUT_OF_STOCK", []]]);
      assert.equal(publicCatalogue.pagination.totalItems, 1);
    }
  });

  it("reports AVAILABLE, HISTORICAL_ONLY and NONE Used states accurately", async () => {
    const availableProduct = await makeProduct({ setNumber: `112-AVAILABLE-${randomUUID()}` });
    const available = await createUsed(availableProduct.id);

    const soldProduct = await makeProduct({ setNumber: `112-SOLD-${randomUUID()}` });
    const sold = await createUsed(soldProduct.id);
    await prisma.productListing.update({ where: { id: sold.id }, data: { currentStock: 0, usedLifecycle: "SOLD" } });

    const retiredProduct = await makeProduct({ setNumber: `112-RETIRED-${randomUUID()}` });
    const retired = await createUsed(retiredProduct.id);
    await prisma.productListing.update({ where: { id: retired.id }, data: { currentStock: 0, usedLifecycle: "RETIRED" } });

    const noHistoryProduct = await makeProduct({ setNumber: `112-NO-HISTORY-${randomUUID()}`, currentStock: 0 });
    const cases = [
      [availableProduct, "AVAILABLE"],
      [soldProduct, "HISTORICAL_ONLY"],
      [retiredProduct, "HISTORICAL_ONLY"],
      [noHistoryProduct, "NONE"],
    ] as const;
    for (const [product, expectedStatus] of cases) {
      const response = await search(product.setNumber);
      assert.equal(response.status, 200);
      const result = (await response.json()).items[0];
      assert.equal(result.id, product.id);
      assert.equal(result.usedOfferStatus, expectedStatus);
      assert.equal(result.isRetired, false, "Used offer lifecycle must not infer product retirement");
    }

    for (const product of [soldProduct, retiredProduct]) {
      const publicCatalogue = await (await request(`/products?q=${encodeURIComponent(product.setNumber)}`)).json();
      assert.deepEqual(publicCatalogue.items.map((item: any) => [item.id, item.availability, item.offers]), [[product.id, "OUT_OF_STOCK", []]]);
    }
    assert.equal(available.usedLifecycle, "AVAILABLE");
  });

  it("toggles shared retirement through either offer without changing inventory, lifecycle or sellability", async () => {
    const product = await makeProduct({ currentStock: 3 });
    assert.equal(product.isRetired, false);
    const newListing = await prisma.productListing.findFirstOrThrow({ where: { legoProductId: product.id, condition: "NEW" } });
    const used = await createUsed(product.id);
    assert.equal(used.legoProduct.isRetired, false);
    const listingsBefore = await prisma.productListing.findMany({ where: { legoProductId: product.id }, orderBy: { id: "asc" } });
    const movementsBefore = await prisma.inventoryMovement.findMany({ where: { listingId: { in: [newListing.id, used.id] } }, orderBy: { id: "asc" } });
    const publicBefore = await (await request(`/products/by-product/${product.id}`)).json();
    assert.equal(publicBefore.offers.length, 2);

    for (const [listingId, isRetired] of [[newListing.id, true], [used.id, false]] as const) {
      const response = await request(`/products/${listingId}`, adminToken, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ isRetired }),
      });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).legoProduct.isRetired, isRetired);
      assert.equal((await prisma.legoProduct.findUniqueOrThrow({ where: { id: product.id } })).isRetired, isRetired);
      // An unrelated shared edit must preserve the manually selected value.
      assert.equal((await request(`/products/${listingId}`, adminToken, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: product.title }),
      })).status, 200);

      const lookup = (await (await search(product.setNumber)).json()).items[0];
      assert.equal(lookup.isRetired, isRetired);
      assert.equal(lookup.usedOfferStatus, "AVAILABLE");
      const catalogue = await (await request(`/products?q=${encodeURIComponent(product.setNumber)}`)).json();
      assert.equal(catalogue.pagination.totalItems, 1);
      const detail = await (await request(`/products/by-product/${product.id}`)).json();
      for (const result of [catalogue.items[0], detail]) {
        assert.equal(result.isRetired, isRetired);
        assert.deepEqual(result.offers, publicBefore.offers);
        assert.equal(result.isFeatureProduct, publicBefore.isFeatureProduct);
        assert.ok(result.offers.every((offer: any) => !Object.hasOwn(offer, "isRetired")));
      }
      for (const id of [newListing.id, used.id]) {
        const listingResponse = await request(`/products/${id}`);
        assert.equal(listingResponse.status, 200);
        const listing = await listingResponse.json();
        assert.equal(listing.legoProduct.isRetired, isRetired);
        assert.equal(Object.hasOwn(listing, "isRetired"), false);
      }
      const withoutTimestamp = ({ updatedAt, ...listing }: typeof newListing) => listing;
      const listingsAfter = await prisma.productListing.findMany({ where: { legoProductId: product.id }, orderBy: { id: "asc" } });
      assert.deepEqual(listingsAfter.map(withoutTimestamp), listingsBefore.map(withoutTimestamp));
      assert.deepEqual(await prisma.inventoryMovement.findMany({ where: { listingId: { in: [newListing.id, used.id] } }, orderBy: { id: "asc" } }), movementsBefore);
    }
  });

  it("bounds queries and paginates matches", async () => {
    const phrase = `112-GROUP-${randomUUID()}`;
    const first = await makeProduct({ setNumber: `${phrase}-A` });
    const second = await makeProduct({ setNumber: `${phrase}-B` });
    const third = await makeProduct({ setNumber: `${phrase}-C` });

    const page1Response = await search(phrase, adminToken, "&pageSize=2");
    assert.equal(page1Response.status, 200);
    const page1 = await page1Response.json();
    assert.deepEqual(page1.items.map((item: any) => item.id), [first.id, second.id]);
    assert.deepEqual(page1.pagination, { page: 1, pageSize: 2, totalItems: 3, totalPages: 2 });

    const page2Response = await search(phrase, adminToken, "&page=2&pageSize=2");
    assert.equal(page2Response.status, 200);
    const page2 = await page2Response.json();
    assert.deepEqual(page2.items.map((item: any) => item.id), [third.id]);
    assert.deepEqual(page2.pagination, { page: 2, pageSize: 2, totalItems: 3, totalPages: 2 });

    for (const query of ["", "  ", "x".repeat(101)]) assert.equal((await search(query)).status, 400);
    assert.equal((await search(phrase, adminToken, "&pageSize=51")).status, 400);
    assert.equal((await search(phrase, adminToken, "&page=0")).status, 400);
  });

  it("does not affect the existing Used creation conflict contract", async () => {
    const product = await makeProduct({ setNumber: `112-CONFLICT-${randomUUID()}` });
    await createUsed(product.id);
    const form = new FormData();
    form.append("originalPrice", "50");
    form.append("damageDescription", "A second damaged box");
    form.append("conditionPhotos", new Blob([Buffer.from(png)], { type: "image/png" }), "condition.png");
    const second = await request(`/products/${product.id}/used-offers`, adminToken, { method: "POST", body: form });
    assert.equal(second.status, 409);
    assert.equal((await second.json()).error, "An available Used offer already exists for this product");
  });
});
