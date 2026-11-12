import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import type { ImageStorage, ImageUploadInput, StoredImage } from "../infrastructure/imageStorage/imageStorage.js";

class CategoryStorage implements ImageStorage {
  uploads: ImageUploadInput[] = [];
  deletions: string[] = [];
  async upload(input: ImageUploadInput): Promise<StoredImage> {
    this.uploads.push(input);
    const publicId = `colorful-life/category-artwork/${input.publicId}`;
    return { publicId, secureUrl: `https://cdn.example/${publicId}.jpg` };
  }
  async delete(publicId: string) { this.deletions.push(publicId); }
}
const storage = new CategoryStorage();
const users: number[] = [];
const categories: number[] = [];
let server: Server;
let url: string;

before(async () => {
  server = createApp(undefined, undefined, storage).listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  url = `http://localhost:${address.port}`;
});
afterEach(async () => {
  if (categories.length) await prisma.category.deleteMany({ where: { id: { in: categories } } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } });
  categories.length = users.length = 0; storage.uploads.length = storage.deletions.length = 0;
});
after(async () => { await prisma.$disconnect(); server.close(); });

async function admin(role: "ADMIN" | "CUSTOMER" = "ADMIN") {
  const user = await prisma.user.create({ data: { email: `category-management-${role}-${randomUUID()}@example.com`, passwordHash: "test", emailVerified: true, role } });
  users.push(user.id);
  return jwt.sign({ id: user.id, role }, config.JWT_SECRET, { expiresIn: "1h" });
}
async function category() {
  const value = await prisma.category.create({ data: { name: `Managed ${randomUUID()}`, subtitle: "Initial subtitle", description: "Initial description" } });
  categories.push(value.id);
  return value;
}
function request(path: string, token?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers); if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
  return fetch(`${url}${path}`, { ...init, headers });
}
function artworkForm(seed = 1) {
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 0, seed, 0, 0, 0, 0xff, 0xd9])], { type: "image/jpeg" }), "artwork.jpg");
  return form;
}

describe("category management administration", () => {
  it("allows Admins to create categories without artwork and normalizes metadata", async () => {
    const token = await admin();
    const response = await request("/admin/categories", token, { method: "POST", body: JSON.stringify({ name: "  New Category  ", subtitle: "   " }) });
    assert.equal(response.status, 201);
    const created = await response.json();
    categories.push(created.id);
    assert.deepEqual(created, { id: created.id, name: "New Category", subtitle: null, description: null, imageUrl: null, imagePublicId: null, thumbnailUrl: null, thumbnailPublicId: null });
    assert.equal((await prisma.category.findUniqueOrThrow({ where: { id: created.id } })).name, "New Category");

    const withMetadata = await request("/admin/categories", token, { method: "POST", body: JSON.stringify({ name: "  Another Category  ", subtitle: " subtitle ", description: " description " }) });
    assert.equal(withMetadata.status, 201);
    const second = await withMetadata.json();
    categories.push(second.id);
    assert.deepEqual(second, { id: second.id, name: "Another Category", subtitle: "subtitle", description: "description", imageUrl: null, imagePublicId: null, thumbnailUrl: null, thumbnailPublicId: null });
  });
  it("requires Admin authorization to create categories", async () => {
    const body = JSON.stringify({ name: "Authorized Category" });
    assert.equal((await request("/admin/categories", undefined, { method: "POST", body })).status, 401);
    assert.equal((await request("/admin/categories", await admin("CUSTOMER"), { method: "POST", body })).status, 403);
  });
  it("rejects invalid creation metadata and duplicate names", async () => {
    const token = await admin();
    const existing = await prisma.category.findFirstOrThrow();
    for (const body of [
      {},
      { name: "   " },
      { name: 42 },
      { name: "x".repeat(201) },
      { name: "Valid", subtitle: "s".repeat(301) },
      { name: "Valid", description: "d".repeat(2001) },
    ]) {
      assert.equal((await request("/admin/categories", token, { method: "POST", body: JSON.stringify(body) })).status, 400);
    }
    assert.equal((await request("/admin/categories", token, { method: "POST", body: JSON.stringify({ name: existing.name }) })).status, 409);
  });
  it("protects Admin reads and updates text metadata with authoritative data", async () => {
    const value = await category(); const token = await admin();
    assert.equal((await request("/admin/categories")).status, 401);
    assert.equal((await request("/admin/categories", await admin("CUSTOMER"))).status, 403);
    const list = await (await request("/admin/categories", token)).json();
    assert.ok(list.some((entry: { id: number }) => entry.id === value.id));
    const response = await request(`/admin/categories/${value.id}`, token, { method: "PATCH", body: JSON.stringify({ name: ` Renamed ${value.id} `, subtitle: " New subtitle ", description: "" }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { id: value.id, name: `Renamed ${value.id}`, subtitle: "New subtitle", description: null, imageUrl: null, imagePublicId: null, thumbnailUrl: null, thumbnailPublicId: null });
  });
  it("rejects invalid and missing IDs, invalid input, and duplicate names", async () => {
    const value = await category(); const token = await admin(); const existing = await prisma.category.findFirstOrThrow({ where: { id: { not: value.id } } });
    assert.equal((await request("/admin/categories/0", token, { method: "PATCH", body: JSON.stringify({ name: "x", subtitle: null, description: null }) })).status, 404);
    assert.equal((await request("/admin/categories/999999999", token, { method: "PATCH", body: JSON.stringify({ name: "x", subtitle: null, description: null }) })).status, 404);
    assert.equal((await request(`/admin/categories/${value.id}`, token, { method: "PATCH", body: JSON.stringify({ name: " ", subtitle: null, description: null }) })).status, 400);
    assert.equal((await request(`/admin/categories/${value.id}`, token, { method: "PATCH", body: JSON.stringify({ name: existing.name, subtitle: null, description: null }) })).status, 409);
  });
  it("uploads, replaces, and removes artwork while keeping both fields together", async () => {
    const value = await category(); const token = await admin();
    const first = await (await request(`/admin/categories/${value.id}/artwork`, token, { method: "PUT", body: artworkForm(1) })).json();
    assert.equal(first.imagePublicId, storage.uploads[0] && `colorful-life/category-artwork/${storage.uploads[0].publicId}`);
    assert.equal(first.thumbnailUrl, null); assert.equal(first.thumbnailPublicId, null);
    const second = await (await request(`/admin/categories/${value.id}/artwork`, token, { method: "PUT", body: artworkForm(2) })).json();
    assert.notEqual(second.imagePublicId, first.imagePublicId);
    assert.deepEqual(storage.deletions, [first.imagePublicId]);
    const removed = await (await request(`/admin/categories/${value.id}/artwork`, token, { method: "DELETE" })).json();
    assert.equal(removed.imageUrl, null); assert.equal(removed.imagePublicId, null);
    assert.equal(removed.thumbnailUrl, null); assert.equal(removed.thumbnailPublicId, null);
    assert.deepEqual(storage.deletions, [first.imagePublicId, second.imagePublicId]);
  });

  it("returns thumbnail URLs publicly without storage IDs and includes both thumbnail fields for Admins", async () => {
    const value = await category(); const token = await admin();
    await prisma.category.update({ where: { id: value.id }, data: {
      imageUrl: "https://cdn.example/opening.jpg", imagePublicId: `opening-${value.id}`,
      thumbnailUrl: "https://cdn.example/thumbnail.jpg", thumbnailPublicId: `thumbnail-${value.id}`,
    } });

    const publicCategories = await (await request("/categories")).json();
    const publicCategory = publicCategories.find((entry: { id: number }) => entry.id === value.id);
    assert.equal(publicCategory.imageUrl, "https://cdn.example/opening.jpg");
    assert.equal(publicCategory.thumbnailUrl, "https://cdn.example/thumbnail.jpg");
    assert.equal("imagePublicId" in publicCategory, false);
    assert.equal("thumbnailPublicId" in publicCategory, false);

    const adminCategories = await (await request("/admin/categories", token)).json();
    const adminCategory = adminCategories.find((entry: { id: number }) => entry.id === value.id);
    assert.equal(adminCategory.imagePublicId, `opening-${value.id}`);
    assert.equal(adminCategory.thumbnailUrl, "https://cdn.example/thumbnail.jpg");
    assert.equal(adminCategory.thumbnailPublicId, `thumbnail-${value.id}`);
  });

  it("uploads, replaces, and deletes thumbnails independently from opening artwork", async () => {
    const value = await category(); const token = await admin();

    const opening = await (await request(`/admin/categories/${value.id}/artwork`, token, { method: "PUT", body: artworkForm(3) })).json();
    assert.ok(opening.imageUrl); assert.ok(opening.imagePublicId);
    assert.equal(opening.thumbnailUrl, null); assert.equal(opening.thumbnailPublicId, null);

    const firstThumbnail = await (await request(`/admin/categories/${value.id}/thumbnail-artwork`, token, { method: "PUT", body: artworkForm(4) })).json();
    assert.ok(firstThumbnail.thumbnailUrl); assert.ok(firstThumbnail.thumbnailPublicId);
    assert.equal(firstThumbnail.imageUrl, opening.imageUrl);
    assert.equal(firstThumbnail.imagePublicId, opening.imagePublicId);
    const persisted = await prisma.category.findUniqueOrThrow({ where: { id: value.id } });
    assert.equal(persisted.thumbnailUrl, firstThumbnail.thumbnailUrl);
    assert.equal(persisted.thumbnailPublicId, firstThumbnail.thumbnailPublicId);
    assert.deepEqual(storage.deletions, []);

    const secondThumbnail = await (await request(`/admin/categories/${value.id}/thumbnail-artwork`, token, { method: "PUT", body: artworkForm(5) })).json();
    assert.notEqual(secondThumbnail.thumbnailPublicId, firstThumbnail.thumbnailPublicId);
    assert.equal(secondThumbnail.imageUrl, opening.imageUrl);
    assert.equal(secondThumbnail.imagePublicId, opening.imagePublicId);
    assert.deepEqual(storage.deletions, [firstThumbnail.thumbnailPublicId]);

    const thirdThumbnail = await (await request(`/admin/categories/${value.id}/thumbnail-artwork`, token, { method: "PUT", body: artworkForm(6) })).json();
    const replacedOpening = await (await request(`/admin/categories/${value.id}/artwork`, token, { method: "PUT", body: artworkForm(7) })).json();
    assert.equal(replacedOpening.thumbnailUrl, thirdThumbnail.thumbnailUrl);
    assert.equal(replacedOpening.thumbnailPublicId, thirdThumbnail.thumbnailPublicId);
    assert.deepEqual(storage.deletions, [firstThumbnail.thumbnailPublicId, secondThumbnail.thumbnailPublicId, opening.imagePublicId]);

    const openingRemoved = await (await request(`/admin/categories/${value.id}/artwork`, token, { method: "DELETE" })).json();
    assert.equal(openingRemoved.imageUrl, null); assert.equal(openingRemoved.imagePublicId, null);
    assert.equal(openingRemoved.thumbnailUrl, thirdThumbnail.thumbnailUrl);
    assert.equal(openingRemoved.thumbnailPublicId, thirdThumbnail.thumbnailPublicId);
    assert.deepEqual(storage.deletions, [firstThumbnail.thumbnailPublicId, secondThumbnail.thumbnailPublicId, opening.imagePublicId, replacedOpening.imagePublicId]);

    const thumbnailRemoved = await (await request(`/admin/categories/${value.id}/thumbnail-artwork`, token, { method: "DELETE" })).json();
    assert.equal(thumbnailRemoved.thumbnailUrl, null); assert.equal(thumbnailRemoved.thumbnailPublicId, null);
    assert.equal(thumbnailRemoved.imageUrl, null); assert.equal(thumbnailRemoved.imagePublicId, null);
    assert.deepEqual(storage.deletions, [firstThumbnail.thumbnailPublicId, secondThumbnail.thumbnailPublicId, opening.imagePublicId, replacedOpening.imagePublicId, thirdThumbnail.thumbnailPublicId]);
  });

  it("rejects unauthenticated, non-Admin, and invalid thumbnail uploads", async () => {
    const value = await category(); const token = await admin(); const customer = await admin("CUSTOMER");
    const path = `/admin/categories/${value.id}/thumbnail-artwork`;
    assert.equal((await request(path, undefined, { method: "PUT", body: artworkForm() })).status, 401);
    assert.equal((await request(path, customer, { method: "PUT", body: artworkForm() })).status, 403);
    assert.equal((await request(path, undefined, { method: "DELETE" })).status, 401);
    assert.equal((await request(path, customer, { method: "DELETE" })).status, 403);

    const invalid = new FormData();
    invalid.append("file", new Blob(["not an image"], { type: "image/jpeg" }), "bad.jpg");
    const response = await request(path, token, { method: "PUT", body: invalid });
    assert.equal(response.status, 400);
    assert.equal(storage.uploads.length, 0);
    const unchanged = await prisma.category.findUniqueOrThrow({ where: { id: value.id } });
    assert.equal(unchanged.thumbnailUrl, null); assert.equal(unchanged.thumbnailPublicId, null);
    assert.equal(unchanged.imageUrl, null); assert.equal(unchanged.imagePublicId, null);
  });

  it("keeps a stored asset when the other artwork slot still references its public ID", async () => {
    const value = await category(); const token = await admin();
    const sharedPublicId = `colorful-life/category-artwork/${value.id}-00000000-0000-4000-8000-000000000001`;
    await prisma.category.update({ where: { id: value.id }, data: {
      imageUrl: "https://cdn.example/shared.jpg", imagePublicId: sharedPublicId,
      thumbnailUrl: "https://cdn.example/shared.jpg", thumbnailPublicId: sharedPublicId,
    } });

    const removed = await (await request(`/admin/categories/${value.id}/thumbnail-artwork`, token, { method: "DELETE" })).json();
    assert.equal(removed.thumbnailUrl, null); assert.equal(removed.thumbnailPublicId, null);
    assert.equal(removed.imageUrl, "https://cdn.example/shared.jpg");
    assert.equal(removed.imagePublicId, sharedPublicId);
    assert.deepEqual(storage.deletions, []);
  });
  it("returns 404 for missing artwork targets and leaves state unchanged on upload failure", async () => {
    const token = await admin();
    assert.equal((await request("/admin/categories/999999999/artwork", token, { method: "PUT", body: artworkForm() })).status, 404);
  });
});
