import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";

const productIds: number[] = [];
const listingIds: number[] = [];
const userIds: number[] = [];
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
  if (listingIds.length) await prisma.productListing.deleteMany({ where: { id: { in: listingIds } } });
  if (productIds.length) await prisma.legoProduct.deleteMany({ where: { id: { in: productIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  if (categoryIds.length) await prisma.category.deleteMany({ where: { id: { in: categoryIds } } });
  listingIds.length = productIds.length = userIds.length = categoryIds.length = 0;
});

after(async () => { await prisma.$disconnect(); server.close(); });

function request(path: string, token?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  return fetch(`${url}${path}`, { ...init, headers });
}

async function makeAdmin() {
  const user = await prisma.user.create({
    data: { email: `category-admin-${randomUUID()}@example.com`, passwordHash: "test-hash", emailVerified: true, role: "ADMIN" },
  });
  userIds.push(user.id);
  return jwt.sign({ id: user.id, role: "ADMIN" }, config.JWT_SECRET, { expiresIn: "1h" });
}

describe("Category public contract", () => {
  it("returns the 13 mapped categories in catalogue order without public image IDs", async () => {
    const response = await request("/categories");
    assert.equal(response.status, 200);
    const categories = await response.json();
    assert.equal(categories.length, 13);
    assert.deepEqual(categories.map((category: { id: number; name: string; subtitle: string; description: string | null }) => ({
      id: category.id, name: category.name, subtitle: category.subtitle, description: category.description,
    })), [
      { id: 1, name: "Harry Potter", subtitle: "Magic in every build", description: "Step into a world of spells, secret rooms and stirring adventures, where every build holds a little magic." },
      { id: 2, name: "Star Wars", subtitle: "Adventure among the stars", description: "Travel to galaxies far away, bringing daring journeys, loyal companions and legendary moments to life." },
      { id: 3, name: "Friends", subtitle: "Build brighter days together", description: "Find bright, everyday adventures filled with friendship, creativity and cheerful places to share." },
      { id: 4, name: "City", subtitle: "Every street tells a story", description: "Explore busy streets, helpful heroes and familiar scenes where there is always another story unfolding." },
      { id: 5, name: "Disney", subtitle: "Build a little wonder", description: "Revisit beloved tales and build a little wonder, with familiar characters and magical moments around every corner." },
      { id: 6, name: "Marvel", subtitle: "Heroes assemble here", description: "Assemble a world of brave heroes, bold choices and extraordinary adventures ready to leap into action." },
      { id: 7, name: "Jurassic World", subtitle: "Big adventures from another age", description: "Enter a prehistoric world of mighty dinosaurs, untamed landscapes and exciting discoveries." },
      { id: 8, name: "Flowers & Botanicals", subtitle: "Build something beautiful", description: "Bring a little calm indoors with graceful blooms, leafy treasures and nature-inspired details to enjoy." },
      { id: 9, name: "NINJAGO", subtitle: "Train. Build. Adventure.", description: "Train alongside courageous ninja, discover ancient secrets and build adventures full of skill, spirit and surprise." },
      { id: 10, name: "DC & Batman", subtitle: "Heroes after dark", description: "Enter the night with legendary heroes, daring rescues and Gotham adventures waiting to unfold." },
      { id: 11, name: "Vehicles", subtitle: "Built for the thrill", description: "Feel the joy of movement with speedy cars, powerful machines and journeys limited only by imagination." },
      { id: 12, name: "Creator", subtitle: "Imagine it. Build it differently.", description: "Let curiosity lead the way, rebuilding familiar ideas into something wonderfully unexpected." },
      { id: 13, name: "Others", subtitle: "More little worlds to discover", description: "Wander into a collection of delightful worlds, unusual ideas and small surprises waiting to be discovered." },
    ]);
    assert.ok(categories.every((category: Record<string, unknown>) =>
      typeof category.description === "string" && category.imageUrl === null && category.thumbnailUrl === null &&
      !("imagePublicId" in category) && !("thumbnailPublicId" in category)));
  });

  it("creates a product by Category identity and returns the related category", async () => {
    const token = await makeAdmin();
    const vehicles = await prisma.category.findUniqueOrThrow({ where: { name: "Vehicles" } });
    const setNumber = `CATEGORY-${randomUUID()}`;
    const response = await request("/products", token, {
      method: "POST",
      body: JSON.stringify({
        setNumber, title: "Category contract", theme: "Technic", ageRecommendation: "8+",
        pieceCount: 100, categoryId: vehicles.id, condition: "NEW", originalPrice: 20,
      }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    productIds.push(body.legoProductId);
    listingIds.push(body.id);
    assert.deepEqual(body.category, { id: vehicles.id, name: "Vehicles", subtitle: "Built for the thrill", description: "Feel the joy of movement with speedy cars, powerful machines and journeys limited only by imagination.", imageUrl: null, thumbnailUrl: null });
    assert.equal(body.legoProduct.categoryId, vehicles.id);
  });

  it("rejects a nonexistent Category without creating a product", async () => {
    const token = await makeAdmin();
    const setNumber = `CATEGORY-INVALID-${randomUUID()}`;
    const response = await request("/products", token, {
      method: "POST",
      body: JSON.stringify({
        setNumber, title: "Invalid category", theme: "Test", ageRecommendation: "8+",
        pieceCount: 10, categoryId: 999999999, condition: "NEW", originalPrice: 20,
      }),
    });
    assert.equal(response.status, 400);
    assert.equal(await prisma.legoProduct.count({ where: { setNumber } }), 0);
  });

  it("assigns a newly created arbitrary Category without a legacy enum mapping", async () => {
    const token = await makeAdmin();
    const category = await prisma.category.create({
      data: { name: `Space Adventures ${randomUUID()}`, subtitle: "Beyond the stars" },
    });
    categoryIds.push(category.id);
    const response = await request("/products", token, {
      method: "POST",
      body: JSON.stringify({
        setNumber: `CATEGORY-ARBITRARY-${randomUUID()}`, title: "Space explorer", theme: "Test",
        ageRecommendation: "8+", pieceCount: 10, categoryId: category.id, condition: "NEW", originalPrice: 20,
      }),
    });
    assert.equal(response.status, 201);
    const body = await response.json();
    productIds.push(body.legoProductId);
    listingIds.push(body.id);
    assert.equal(body.category.id, category.id);
    assert.equal(body.category.name, category.name);
  });
});

describe("Category relation catalogue and feature behavior", () => {
  it("filters and scopes feature selection through LegoProduct.category", async () => {
    const token = await makeAdmin();
    const vehicles = await prisma.category.findUniqueOrThrow({ where: { name: "Vehicles" } });
    const products = await Promise.all(["A", "B"].map((suffix) => prisma.legoProduct.create({
      data: {
        setNumber: `CATEGORY-FEATURE-${suffix}-${randomUUID()}`, title: `Feature ${suffix}`,
        theme: "Test", ageRecommendation: "8+", pieceCount: 10, categoryId: vehicles.id,
      },
    })));
    productIds.push(...products.map((product) => product.id));
    const listings = await Promise.all(products.map((product) => prisma.productListing.create({
      data: { legoProductId: product.id, condition: "NEW", originalPrice: 10, currentStock: 1 },
    })));
    listingIds.push(...listings.map((listing) => listing.id));

    const filtered = await request(`/products?categoryId=${vehicles.id}&q=${encodeURIComponent("CATEGORY-FEATURE")}`);
    assert.equal(filtered.status, 200);
    assert.equal((await filtered.json()).items.length, 2);
    assert.equal((await request(`/products/by-product/${products[0].id}/feature`, token, { method: "PATCH" })).status, 200);
    assert.equal((await request(`/products/by-product/${products[1].id}/feature`, token, { method: "PATCH" })).status, 200);
    const state = await prisma.legoProduct.findMany({ where: { id: { in: products.map((product) => product.id) } }, orderBy: { id: "asc" } });
    assert.equal(state.filter((product) => product.isFeatureProduct).length, 1);
  });
});
