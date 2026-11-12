import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import type { ImageStorage, ImageUploadInput, StoredImage } from "../infrastructure/imageStorage/imageStorage.js";

class FakeArtworkStorage implements ImageStorage {
  uploads: ImageUploadInput[] = [];
  deletions: string[] = [];
  failUpload = false;
  async upload(input: ImageUploadInput): Promise<StoredImage> {
    if (this.failUpload) throw new Error("fake upload failed");
    this.uploads.push(input);
    const publicId = `colorful-life/catalogue-artwork/${input.publicId}`;
    return { publicId, secureUrl: `https://cdn.example/${publicId}.jpg` };
  }
  async delete(publicId: string) { this.deletions.push(publicId); }
}

const ids = { users: [] as number[], products: [] as number[], listings: [] as number[] };
const artworkStorage = new FakeArtworkStorage();
let server: Server;
let url: string;

before(async () => {
  server = createApp(undefined, artworkStorage).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  url = `http://localhost:${address.port}`;
});

afterEach(async () => {
  if (ids.listings.length) await prisma.productListing.deleteMany({ where: { id: { in: ids.listings } } });
  if (ids.products.length) await prisma.legoProduct.deleteMany({ where: { id: { in: ids.products } } });
  if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  ids.users.length = ids.products.length = ids.listings.length = 0;
  artworkStorage.uploads.length = artworkStorage.deletions.length = 0;
  artworkStorage.failUpload = false;
});

after(async () => { await prisma.$disconnect(); server.close(); });

async function user(role: "ADMIN" | "CUSTOMER") {
  const created = await prisma.user.create({ data: { email: `${role}-${randomUUID()}@example.com`, passwordHash: "test", emailVerified: true, role } });
  ids.users.push(created.id);
  return jwt.sign({ id: created.id, role }, config.JWT_SECRET, { expiresIn: "1h" });
}

async function listing(category: "VEHICLES" | "CITY" = "VEHICLES", theme = "Technic") {
  const categoryRecord = await prisma.category.findUniqueOrThrow({ where: { name: category === "VEHICLES" ? "Vehicles" : "City" } });
  const product = await prisma.legoProduct.create({ data: { setNumber: `PRESENTATION-${randomUUID()}`, title: "Presentation Product", theme, ageRecommendation: "8+", pieceCount: 100, categoryId: categoryRecord.id } });
  ids.products.push(product.id);
  const created = await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: 10, currentStock: 2 } });
  ids.listings.push(created.id);
  return created;
}

function request(path: string, token?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${url}${path}`, { ...init, headers });
}

async function adminRowsForProduct(token: string, productId: number) {
  const firstResponse = await request("/admin/product-listings?pageSize=50", token);
  assert.equal(firstResponse.status, 200);
  const firstPage = await firstResponse.json();
  const rows = [...firstPage.items];
  for (let page = 2; page <= firstPage.pagination.totalPages; page++) {
    rows.push(...(await (await request(`/admin/product-listings?pageSize=50&page=${page}`, token)).json()).items);
  }
  return rows.filter((row: any) => row.legoProduct.id === productId);
}

function artworkForm() {
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9])], { type: "image/jpeg" }), "artwork.jpg");
  return form;
}

describe("product presentation administration", () => {
  it("selects one Feature Product per category by LegoProduct identity with category locking", async () => {
    const admin = await user("ADMIN");
    const customer = await user("CUSTOMER");
    const first = await listing("VEHICLES", "Speed Champions");
    const siblingOffer = await prisma.productListing.create({ data: { legoProductId: first.legoProductId, condition: "USED_LIKE_NEW", originalPrice: 9, currentStock: 1, usedLifecycle: "AVAILABLE", damageDescription: "Small crease", usedConditionPhotos: { create: { url: "https://x/condition.jpg", publicId: randomUUID(), sortOrder: 0 } } } });
    ids.listings.push(siblingOffer.id);
    const second = await listing("VEHICLES", "Technic");
    const otherCategory = await listing("CITY", "City");

    assert.equal((await prisma.legoProduct.findUniqueOrThrow({ where: { id: first.legoProductId } })).isFeatureProduct, false);
    assert.equal((await request(`/products/by-product/${first.legoProductId}/feature`, undefined, { method: "PATCH" })).status, 401);
    assert.equal((await request(`/products/by-product/${first.legoProductId}/feature`, customer, { method: "PATCH" })).status, 403);
    assert.equal((await request("/products/by-product/999999/feature", admin, { method: "PATCH" })).status, 404);

    assert.equal((await request(`/products/by-product/${first.legoProductId}/feature`, admin, { method: "PATCH" })).status, 200);
    assert.equal((await request(`/products/by-product/${second.legoProductId}/feature`, admin, { method: "PATCH" })).status, 200);
    assert.equal((await prisma.legoProduct.findUniqueOrThrow({ where: { id: first.legoProductId } })).isFeatureProduct, false);
    assert.equal((await prisma.legoProduct.findUniqueOrThrow({ where: { id: second.legoProductId } })).isFeatureProduct, true);
    assert.equal((await prisma.legoProduct.findUniqueOrThrow({ where: { id: otherCategory.legoProductId } })).isFeatureProduct, false);
    assert.equal((await prisma.legoProduct.findUniqueOrThrow({ where: { id: first.legoProductId } })).isFeatureProduct, false, "a sibling offer has no independent Feature state");

    const third = await listing("CITY", "Icons");
    const fourth = await listing("CITY", "Creator");
    const concurrentSelections = await Promise.all([
      request(`/products/by-product/${third.legoProductId}/feature`, admin, { method: "PATCH" }),
      request(`/products/by-product/${fourth.legoProductId}/feature`, admin, { method: "PATCH" }),
    ]);
    assert.ok(concurrentSelections.every((response) => response.status === 200));
    const selectedProducts = await prisma.legoProduct.findMany({ where: { id: { in: [third.legoProductId, fourth.legoProductId] } } });
    assert.equal(selectedProducts.filter((product) => product.isFeatureProduct).length, 1);
    const unfeaturedProduct = selectedProducts.find((product) => !product.isFeatureProduct)!;
    await assert.rejects(
      prisma.legoProduct.update({ where: { id: unfeaturedProduct.id }, data: { isFeatureProduct: true } }),
      (error: any) => error.code === "P2002",
    );
  });

  it("uploads, replaces, and removes one product artwork shared by all sibling offers", async () => {
    const admin = await user("ADMIN");
    const created = await listing();
    const productId = created.legoProductId;
    const legacyArtworkPublicId = `colorful-life/catalogue-artwork/${created.id}-${randomUUID()}`;
    await prisma.legoProduct.update({ where: { id: productId }, data: {
      catalogueArtworkUrl: `https://cdn.example/${legacyArtworkPublicId}.jpg`,
      catalogueArtworkPublicId: legacyArtworkPublicId,
    } });
    const image = await prisma.productImage.create({ data: { legoProductId: productId, url: "https://cdn.example/product.jpg", publicId: `colorful-life/products/${created.id}-legacy`, sortOrder: 0, altText: "product" } });
    const sibling = await prisma.productListing.create({ data: { legoProductId: productId, condition: "USED_LIKE_NEW", originalPrice: 8, currentStock: 1, usedLifecycle: "AVAILABLE", damageDescription: "Box wear", usedConditionPhotos: { create: { url: "https://x/condition.jpg", publicId: randomUUID(), sortOrder: 0 } } } });
    ids.listings.push(sibling.id);

    const initialRead = await (await request(`/products/${created.id}`)).json();
    assert.equal(initialRead.legoProduct.catalogueArtworkPublicId, legacyArtworkPublicId);
    assert.equal(initialRead.legoProduct.isFeatureProduct, false);

    const firstUpload = await request(`/products/by-product/${productId}/catalogue-artwork`, admin, { method: "PUT", body: artworkForm() });
    assert.equal(firstUpload.status, 200);
    const firstArtwork = (await firstUpload.json()).catalogueArtwork;
    assert.ok(firstArtwork.publicId.startsWith(`colorful-life/catalogue-artwork/${productId}-`));
    assert.equal((await prisma.productImage.findUnique({ where: { id: image.id } }))?.publicId, image.publicId);

    const secondUpload = await request(`/products/by-product/${productId}/catalogue-artwork`, admin, { method: "PUT", body: artworkForm() });
    assert.equal(secondUpload.status, 200);
    const secondArtwork = (await secondUpload.json()).catalogueArtwork;
    assert.notEqual(secondArtwork.publicId, firstArtwork.publicId);
    assert.deepEqual(artworkStorage.deletions, [legacyArtworkPublicId, firstArtwork.publicId]);

    const catalogue = await (await request(`/products/by-product/${productId}`)).json();
    assert.equal(catalogue.catalogueArtworkUrl, secondArtwork.url);
    assert.equal(catalogue.catalogueArtworkPublicId, secondArtwork.publicId);
    assert.ok(!Object.hasOwn(catalogue.offers.find((offer: any) => offer.id === created.id), "catalogueArtworkUrl"));
    const adminRows = await adminRowsForProduct(admin, productId);
    assert.equal(adminRows.length, 2);
    assert.ok(adminRows.every((row: any) => row.legoProduct.catalogueArtworkPublicId === secondArtwork.publicId));
    assert.ok(adminRows.every((row: any) => row.legoProduct.productImages.some((entry: any) => entry.id === image.id)));

    assert.equal((await request(`/products/by-product/${productId}/catalogue-artwork`, admin, { method: "DELETE" })).status, 204);
    const removed = await prisma.legoProduct.findUnique({ where: { id: productId } });
    assert.equal(removed?.catalogueArtworkUrl, null);
    assert.equal(removed?.catalogueArtworkPublicId, null);
    assert.deepEqual(artworkStorage.deletions, [legacyArtworkPublicId, firstArtwork.publicId, secondArtwork.publicId]);
    assert.equal((await request(`/products/by-product/${productId}/catalogue-artwork`, undefined, { method: "DELETE" })).status, 401);
  });

  it("rejects invalid artwork and leaves product presentation unchanged when storage fails", async () => {
    const admin = await user("ADMIN");
    const created = await listing();
    const invalid = new FormData();
    invalid.append("file", new Blob(["not an image"], { type: "image/jpeg" }), "bad.jpg");
    assert.equal((await request(`/products/by-product/${created.legoProductId}/catalogue-artwork`, admin, { method: "PUT", body: invalid })).status, 400);
    artworkStorage.failUpload = true;
    assert.equal((await request(`/products/by-product/${created.legoProductId}/catalogue-artwork`, admin, { method: "PUT", body: artworkForm() })).status, 500);
    const unchanged = await prisma.legoProduct.findUnique({ where: { id: created.legoProductId } });
    assert.equal(unchanged?.catalogueArtworkUrl, null);
    assert.equal(unchanged?.catalogueArtworkPublicId, null);
  });
});
