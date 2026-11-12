import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import type { ImageStorage, ImageUploadInput, StoredImage } from "../infrastructure/imageStorage/imageStorage.js";
import { createProductImageService } from "../domain/productImages/productImageService.js";

class FakeStorage implements ImageStorage {
  uploads: ImageUploadInput[] = [];
  deletions: string[] = [];
  failUpload = false;
  failDelete = false;
  async upload(input: ImageUploadInput): Promise<StoredImage> {
    if (this.failUpload) throw new Error("fake upload failed");
    this.uploads.push(input);
    const publicId = `colorful-life/products/${input.publicId}`;
    return { publicId, secureUrl: `https://cdn.example/${publicId}.jpg` };
  }
  async delete(publicId: string) {
    if (this.failDelete) throw new Error("fake delete failed");
    this.deletions.push(publicId);
  }
}

const ids = { users: [] as number[], products: [] as number[], listings: [] as number[] };
let server: Server;
let url: string;
let storage: FakeStorage;

before(async () => {
  storage = new FakeStorage();
  server = createApp(storage).listen(0);
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
  storage.uploads.length = storage.deletions.length = 0;
  storage.failUpload = storage.failDelete = false;
});

after(async () => { await prisma.$disconnect(); server.close(); });

async function user(role: "ADMIN" | "CUSTOMER") {
  const created = await prisma.user.create({ data: { email: `${role}-${randomUUID()}@example.com`, passwordHash: "test", emailVerified: true, role } });
  ids.users.push(created.id);
  return jwt.sign({ id: created.id, role }, config.JWT_SECRET, { expiresIn: "1h" });
}

async function listing() {
  const product = await prisma.legoProduct.create({ data: { setNumber: `IMG-${randomUUID()}`, title: "Image Product", theme: "TEST", ageRecommendation: "8+", pieceCount: 100 } });
  ids.products.push(product.id);
  const created = await prisma.productListing.create({ data: {
        legoProductId: product.id, condition: "NEW", originalPrice: 10, currentStock: 1 } });
  ids.listings.push(created.id);
  return product.id;
}

function request(path: string, token?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${url}${path}`, { ...init, headers });
}

function imageForm(bytes: Uint8Array, type: string, altText?: string) {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(bytes)], { type }), "image");
  if (altText !== undefined) form.append("altText", altText);
  return form;
}

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const png = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082", "hex"));
const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x04, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe("product image administration", () => {
  it("uploads supported images, persists returned storage values, and preserves catalogue ordering", async () => {
    const admin = await user("ADMIN"); const productId = await listing();
    for (const [bytes, type] of [[jpeg, "image/jpeg"], [png, "image/png"], [webp, "image/webp"]] as const) {
      const response = await request(`/products/by-product/${productId}/images`, admin, { method: "POST", body: imageForm(bytes, type, " Product image ") });
      assert.equal(response.status, 201);
    }
    const images = await prisma.productImage.findMany({ where: { legoProductId: productId }, orderBy: { sortOrder: "asc" } });
    assert.deepEqual(images.map((image) => image.sortOrder), [0, 1, 2]);
    assert.equal(images[0].altText, "Product image");
    assert.ok(images.every((image) => image.publicId.startsWith(`colorful-life/products/${productId}-`)));
    assert.ok(images.every((image) => image.url.startsWith("https://cdn.example/")));
    const catalogue = await request("/products");
    const productCard = (await catalogue.json()).items.find((entry: any) => entry.id === productId);
    assert.deepEqual(productCard.productImages.map((image: any) => image.id), images.map((image) => image.id));
    const secondListing = await prisma.productListing.create({ data: {
      legoProductId: productId, condition: "USED_LIKE_NEW", originalPrice: 8, currentStock: 1,
      usedLifecycle: "AVAILABLE", damageDescription: "Small crease",
      usedConditionPhotos: { create: { url: "https://images.test/evidence.jpg", publicId: randomUUID(), sortOrder: 0 } },
    } });
    ids.listings.push(secondListing.id);
    const listedImages = await prisma.productImage.findMany({ where: { legoProductId: productId } });
    assert.equal(listedImages.length, 3, "sibling offers do not receive duplicate ProductImage rows");
    const feed = await request(`/products/by-product/${productId}/images`, admin);
    assert.equal(feed.status, 200);
    assert.deepEqual((await feed.json()).productImages.map((image: any) => image.id), images.map((image) => image.id));
  });

  it("requires ADMIN authorization", async () => {
    const productId = await listing(); const customer = await user("CUSTOMER");
    assert.equal((await request(`/products/by-product/${productId}/images`, undefined, { method: "POST", body: imageForm(jpeg, "image/jpeg") })).status, 401);
    assert.equal((await request(`/products/by-product/${productId}/images`, customer, { method: "POST", body: imageForm(jpeg, "image/jpeg") })).status, 403);
  });

  it("rejects invalid content, empty files, and unsupported formats", async () => {
    const admin = await user("ADMIN"); const productId = await listing();
    for (const form of [imageForm(new Uint8Array([1, 2, 3]), "image/jpeg"), imageForm(new Uint8Array(), "image/png"), imageForm(new Uint8Array([1, 2, 3]), "image/gif")]) {
      assert.equal((await request(`/products/by-product/${productId}/images`, admin, { method: "POST", body: form })).status, 400);
    }
    assert.equal(storage.uploads.length, 0);
  });

  it("rejects oversized files before storage and ignores client storage identity fields", async () => {
    const admin = await user("ADMIN"); const productId = await listing();
    const oversized = imageForm(new Uint8Array(8 * 1024 * 1024 + 1), "image/jpeg");
    assert.equal((await request(`/products/by-product/${productId}/images`, admin, { method: "POST", body: oversized })).status, 400);
    const form = imageForm(jpeg, "image/jpeg"); form.append("publicId", "other/project/asset"); form.append("folder", "other-project");
    assert.equal((await request(`/products/by-product/${productId}/images`, admin, { method: "POST", body: form })).status, 201);
    assert.match(storage.uploads[0].publicId, new RegExp(`^${productId}-`));
    assert.notEqual(storage.uploads[0].publicId, "other/project/asset");
  });

  it("returns a controlled error when storage upload or deletion fails", async () => {
    const admin = await user("ADMIN"); const productId = await listing();
    storage.failUpload = true;
    assert.equal((await request(`/products/by-product/${productId}/images`, admin, { method: "POST", body: imageForm(jpeg, "image/jpeg") })).status, 500);
    storage.failUpload = false;
    const uploaded = await (await request(`/products/by-product/${productId}/images`, admin, { method: "POST", body: imageForm(jpeg, "image/jpeg") })).json();
    storage.failDelete = true;
    assert.equal((await request(`/products/by-product/${productId}/images/${uploaded.image.id}`, admin, { method: "DELETE" })).status, 500);
    assert.ok(await prisma.productImage.findUnique({ where: { id: uploaded.image.id } }));
  });

  it("rejects nonexistent listings and enforces ten images", async () => {
    const admin = await user("ADMIN"); const productId = await listing();
    assert.equal((await request(`/products/by-product/${productId + 99999}/images`, admin, { method: "POST", body: imageForm(jpeg, "image/jpeg") })).status, 404);
    for (let i = 0; i < 10; i++) assert.equal((await request(`/products/by-product/${productId}/images`, admin, { method: "POST", body: imageForm(jpeg, "image/jpeg") })).status, 201);
    assert.equal((await request(`/products/by-product/${productId}/images`, admin, { method: "POST", body: imageForm(jpeg, "image/jpeg") })).status, 409);
    assert.equal(storage.deletions.length, 1);
  });

  it("reorders atomically and rejects incomplete, duplicate, and foreign orders", async () => {
    const admin = await user("ADMIN"); const productId = await listing(); const otherProductId = await listing();
    const imageIds: number[] = [];
    for (let i = 0; i < 3; i++) { const body = await (await request(`/products/by-product/${productId}/images`, admin, { method: "POST", body: imageForm(jpeg, "image/jpeg") })).json(); imageIds.push(body.image.id); }
    const reordered = await request(`/products/by-product/${productId}/images/order`, admin, { method: "PATCH", body: JSON.stringify({ imageIds: imageIds.slice().reverse() }), headers: { "Content-Type": "application/json" } });
    assert.equal(reordered.status, 200);
    assert.deepEqual((await reordered.json()).productImages.map((image: any) => image.id), imageIds.slice().reverse());
    for (const imageIdsValue of [[imageIds[0], imageIds[0]], [imageIds[0]], [imageIds[0], 999999]]) {
      assert.equal((await request(`/products/by-product/${productId}/images/order`, admin, { method: "PATCH", body: JSON.stringify({ imageIds: imageIdsValue }), headers: { "Content-Type": "application/json" } })).status, 400);
    }
    assert.equal((await request(`/products/by-product/${otherProductId}/images/order`, admin, { method: "PATCH", body: JSON.stringify({ imageIds }), headers: { "Content-Type": "application/json" } })).status, 400);
  });

  it("updates alt text and deletes only the database-owned image, compacting order", async () => {
    const admin = await user("ADMIN"); const productId = await listing(); const imageIds: number[] = [];
    for (let i = 0; i < 3; i++) { const body = await (await request(`/products/by-product/${productId}/images`, admin, { method: "POST", body: imageForm(jpeg, "image/jpeg") })).json(); imageIds.push(body.image.id); }
    assert.equal((await request(`/products/by-product/${productId}/images/${imageIds[1]}`, admin, { method: "PATCH", body: JSON.stringify({ altText: "Updated" }), headers: { "Content-Type": "application/json" } })).status, 200);
    const deleted = await request(`/products/by-product/${productId}/images/${imageIds[0]}`, admin, { method: "DELETE" });
    assert.equal(deleted.status, 204);
    assert.deepEqual((await prisma.productImage.findMany({ where: { legoProductId: productId }, orderBy: { sortOrder: "asc" } })).map((image) => image.sortOrder), [0, 1]);
    assert.equal(storage.deletions.at(-1), `colorful-life/products/${storage.uploads[0].publicId}`);
  });

  it("can remove a migrated image with its preserved listing-prefixed Cloudinary ID by product owner", async () => {
    const admin = await user("ADMIN"); const productId = await listing();
    const oldListing = await prisma.productListing.findFirstOrThrow({ where: { legoProductId: productId } });
    const legacyPublicId = `colorful-life/products/${oldListing.id}-${randomUUID()}`;
    const image = await prisma.productImage.create({ data: { legoProductId: productId, url: "https://cdn.example/legacy.jpg", publicId: legacyPublicId } });
    const response = await request(`/products/by-product/${productId}/images/${image.id}`, admin, { method: "DELETE" });
    assert.equal(response.status, 204);
    assert.deepEqual(storage.deletions, [legacyPublicId]);
    assert.equal(await prisma.productImage.findUnique({ where: { id: image.id } }), null);
  });

  it("rejects cross-listing and lookalike namespace deletion", async () => {
    const admin = await user("ADMIN"); const productId = await listing(); const otherProductId = await listing();
    const image = await prisma.productImage.create({ data: { legoProductId: productId, url: "https://x", publicId: "colorful-life/products-evil/foo", sortOrder: 0 } });
    assert.equal((await request(`/products/by-product/${otherProductId}/images/${image.id}`, admin, { method: "DELETE" })).status, 404);
    assert.equal((await request(`/products/by-product/${productId}/images/${image.id}`, admin, { method: "DELETE" })).status, 500);
    assert.equal(storage.deletions.length, 0);
  });
});

describe("product image compensation", () => {
  it("attempts storage cleanup when the database insert fails", async () => {
    const fakeStorage = new FakeStorage();
    const failingDb: any = {
      legoProduct: { findUnique: async () => ({ id: 1 }) },
      $transaction: async (callback: any) => callback({
        $queryRaw: async () => [], legoProduct: { findUnique: async () => ({ id: 1 }) },
        productImage: { count: async () => 0, create: async () => { throw new Error("db failed"); } },
      }),
    };
    const service = createProductImageService(fakeStorage, failingDb);
    await assert.rejects(() => service.upload(1, { buffer: Buffer.from(jpeg), size: jpeg.length, mimetype: "image/jpeg" } as Express.Multer.File, undefined));
    assert.equal(fakeStorage.deletions.length, 1);
  });
});
