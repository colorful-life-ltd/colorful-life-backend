import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { config } from "../config/index.js";
import { TEST_DATABASE_NAME, validateTestDatabase } from "../config/testDatabase.js";
import { prisma } from "../prisma/runtime.js";
import type { Prisma } from "../generated/prisma-client/client.js";

const ids = { users: [] as number[], products: [] as number[], listings: [] as number[], categories: [] as number[] };
let server: Server;
let base: string;
let adminToken: string;
let customerToken: string;
let databaseVerified = false;

before(async () => {
  assert.equal(config.DATABASE_URL, validateTestDatabase(process.env).url);
  const [target] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
  assert.equal(target?.name, TEST_DATABASE_NAME);
  databaseVerified = true;

  server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  base = `http://localhost:${address.port}`;
  async function user(role: "ADMIN" | "CUSTOMER") {
    const created = await prisma.user.create({ data: { email: `feed-${randomUUID()}@example.test`, passwordHash: "test", role } });
    ids.users.push(created.id);
    return jwt.sign({ id: created.id, role }, config.JWT_SECRET, { expiresIn: "1h" });
  }
  adminToken = await user("ADMIN");
  customerToken = await user("CUSTOMER");
});

afterEach(async () => {
  if (!databaseVerified) return;
  if (ids.listings.length) {
    // Terminal Used fixtures require the same cleanup exception as the existing
    // Used suites. Keep it transactional and limited to the verified test DB.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "UsedConditionPhoto" DISABLE TRIGGER "UsedConditionPhoto_terminal_immutable"');
      await tx.$executeRawUnsafe('ALTER TABLE "ProductListing" DISABLE TRIGGER "ProductListing_used_lifecycle_guard"');
      await tx.productListing.deleteMany({ where: { id: { in: ids.listings } } });
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
      await tx.$executeRawUnsafe('ALTER TABLE "ProductListing" ENABLE TRIGGER "ProductListing_used_lifecycle_guard"');
      await tx.$executeRawUnsafe('ALTER TABLE "UsedConditionPhoto" ENABLE TRIGGER "UsedConditionPhoto_terminal_immutable"');
    });
  }
  if (ids.products.length) await prisma.legoProduct.deleteMany({ where: { id: { in: ids.products } } });
  if (ids.categories.length) await prisma.category.deleteMany({ where: { id: { in: ids.categories } } });
  ids.products.length = ids.listings.length = ids.categories.length = 0;
});

after(async () => {
  if (databaseVerified && ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
  await prisma.$disconnect();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

function request(path: string, token = adminToken) {
  return fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
}

async function get(path: string) {
  const response = await request(path);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function allItems() {
  const first = await get("/admin/product-listings?pageSize=50");
  const items = [...first.items];
  for (let page = 2; page <= first.pagination.totalPages; page++) {
    items.push(...(await get(`/admin/product-listings?pageSize=50&page=${page}`)).items);
  }
  return items;
}

async function product(categoryId: number | null = null) {
  const created = await prisma.legoProduct.create({ data: {
    setNumber: `116-${randomUUID()}`, title: "Admin presentation set", theme: "Test",
    ageRecommendation: "8+", pieceCount: 100, categoryId,
  } });
  ids.products.push(created.id);
  return created;
}

async function listing(legoProductId: number, data: Partial<Prisma.ProductListingUncheckedCreateInput> = {}) {
  const created = await prisma.productListing.create({ data: {
    legoProductId, condition: "NEW", originalPrice: 30, currentStock: 0, ...data,
  } });
  ids.listings.push(created.id);
  return created;
}

async function snapshot() {
  return {
    listings: await prisma.productListing.findMany({ where: { id: { in: ids.listings } }, orderBy: { id: "asc" }, include: { usedConditionPhotos: true } }),
    products: await prisma.legoProduct.findMany({ where: { id: { in: ids.products } }, orderBy: { id: "asc" } }),
    movements: await prisma.inventoryMovement.findMany({ where: { listingId: { in: ids.listings } } }),
    audits: await prisma.inventoryAudit.findMany({ where: { sourceProductListingId: { in: ids.listings } } }),
  };
}

describe("Admin ProductListing feed", () => {
  it("requires ADMIN authentication according to existing auth conventions", async () => {
    const unauthenticated = await request("/admin/product-listings", "");
    assert.equal(unauthenticated.status, 401);
    assert.deepEqual(await unauthenticated.json(), { error: { code: "AUTH_REQUIRED", message: "Missing or invalid authorization header" } });
    assert.equal((await request("/admin/product-listings", "invalid-token")).status, 401);
    const customer = await request("/admin/product-listings", customerToken);
    assert.equal(customer.status, 403);
    assert.deepEqual(await customer.json(), { error: { code: "FORBIDDEN", message: "Forbidden: ADMIN only" } });
    assert.equal((await request("/admin/product-listings")).status, 200);
  });

  it("requires ADMIN authentication for category product availability summaries", async () => {
    const category = await prisma.category.create({ data: { name: `Summary auth ${randomUUID()}` } });
    ids.categories.push(category.id);
    const path = `/admin/categories/${category.id}/product-availability`;
    assert.equal((await request(path, "")).status, 401);
    assert.equal((await request(path, customerToken)).status, 403);
    assert.deepEqual(await get(path), { totalProducts: 0, totalInventory: 0, activeProducts: 0, inactiveProducts: 0 });
    assert.equal((await request(`/admin/categories/2147483647/product-availability`)).status, 404);
  });

  it("requires ADMIN authentication for the global product availability summary", async () => {
    const path = "/admin/products/product-availability";
    assert.equal((await request(path, "")).status, 401);
    assert.equal((await request(path, "invalid-token")).status, 401);
    assert.equal((await request(path, customerToken)).status, 403);
    const summary = await get(path);
    assert.deepEqual(Object.keys(summary).sort(), ["activeProducts", "inactiveProducts", "totalInventory", "totalProducts"]);
    assert.equal(summary.totalProducts, summary.activeProducts + summary.inactiveProducts);
  });

  it("summarizes unique global products with the same storefront sellability as category summaries", async () => {
    const category = await prisma.category.create({ data: { name: `Global availability ${randomUUID()}` } });
    const otherCategory = await prisma.category.create({ data: { name: `Global availability other ${randomUUID()}` } });
    ids.categories.push(category.id, otherCategory.id);

    const before = await get("/admin/products/product-availability");

    const multiOfferProduct = await product(category.id);
    await listing(multiOfferProduct.id, { currentStock: 3 });
    await listing(multiOfferProduct.id, {
      condition: "USED_LIKE_NEW", usedLifecycle: "AVAILABLE", currentStock: 1,
      damageDescription: "Box has a small crease",
      usedConditionPhotos: { create: { url: "https://images.test/global-summary.jpg", publicId: randomUUID(), sortOrder: 0 } },
    });
    // Each available Used offer represents one physical item. Additional NEW
    // stock keeps this product's total listing inventory at five units.
    await listing(multiOfferProduct.id, {
      currentStock: 1,
    });

    const inactiveInSameCategory = await product(category.id);
    await listing(inactiveInSameCategory.id, { active: false, currentStock: 4 });

    const inactiveInOtherCategory = await product(otherCategory.id);
    await listing(inactiveInOtherCategory.id, { currentStock: 5, reservedStock: 2 });

    const noListingProduct = await product(null);
    const noStockProduct = await product(category.id);
    await listing(noStockProduct.id, { currentStock: 0 });
    const unassignedProduct = await product(null);
    await listing(unassignedProduct.id, { active: false, currentStock: 7 });

    const summary = await get("/admin/products/product-availability");
    assert.deepEqual(summary, {
      totalProducts: before.totalProducts + 6,
      totalInventory: before.totalInventory + 21,
      activeProducts: before.activeProducts + 2,
      inactiveProducts: before.inactiveProducts + 4,
    });
    assert.equal(summary.totalProducts, summary.activeProducts + summary.inactiveProducts);
    assert.equal(await prisma.productListing.count({ where: { legoProductId: multiOfferProduct.id } }), 3);
    assert.equal(await prisma.productListing.count({ where: { legoProductId: noListingProduct.id } }), 0);
    assert.equal(await prisma.productListing.count({ where: { legoProductId: unassignedProduct.id } }), 1);

    // Both summaries use the same shared service and sellability predicate.
    assert.deepEqual(await get(`/admin/categories/${category.id}/product-availability`), {
      totalProducts: 3,
      totalInventory: 9,
      activeProducts: 1,
      inactiveProducts: 2,
    });
    assert.deepEqual(await get(`/admin/categories/${otherCategory.id}/product-availability`), {
      totalProducts: 1,
      totalInventory: 5,
      activeProducts: 1,
      inactiveProducts: 0,
    });

    await get("/admin/product-listings?page=1&pageSize=1");
    assert.deepEqual(await get("/admin/products/product-availability"), summary);
    await get("/admin/product-listings?page=2&pageSize=1");
    assert.deepEqual(await get("/admin/products/product-availability"), summary);
  });

  it("counts an unpublished product with sellable stock as inactive until it is published", async () => {
    const category = await prisma.category.create({ data: { name: `Publication availability ${randomUUID()}` } });
    ids.categories.push(category.id);
    const hidden = await product(category.id);
    await listing(hidden.id, { currentStock: 4 });
    await prisma.legoProduct.update({ where: { id: hidden.id }, data: { isPublished: false } });
    const globalBefore = await get("/admin/products/product-availability");

    assert.deepEqual(await get(`/admin/categories/${category.id}/product-availability`), {
      totalProducts: 1, totalInventory: 4, activeProducts: 0, inactiveProducts: 1,
    });
    await prisma.legoProduct.update({ where: { id: hidden.id }, data: { isPublished: true } });
    assert.deepEqual(await get(`/admin/categories/${category.id}/product-availability`), {
      totalProducts: 1, totalInventory: 4, activeProducts: 1, inactiveProducts: 0,
    });
    const globalAfter = await get("/admin/products/product-availability");
    assert.deepEqual(
      [globalAfter.totalProducts, globalAfter.activeProducts, globalAfter.inactiveProducts],
      [globalBefore.totalProducts, globalBefore.activeProducts + 1, globalBefore.inactiveProducts - 1],
    );
  });

  it("counts a product with both NEW and USED_LIKE_NEW stock once", async () => {
    const category = await prisma.category.create({ data: { name: `Dual condition ${randomUUID()}` } });
    ids.categories.push(category.id);
    const lego = await product(category.id);
    await listing(lego.id, { currentStock: 2 });
    await listing(lego.id, {
      condition: "USED_LIKE_NEW", usedLifecycle: "AVAILABLE", currentStock: 1,
      damageDescription: "Box has a small crease",
      usedConditionPhotos: { create: { url: "https://images.test/dual-condition.jpg", publicId: randomUUID(), sortOrder: 0 } },
    });

    assert.equal(await prisma.productListing.count({ where: { legoProductId: lego.id } }), 2);
    assert.deepEqual(await get(`/admin/categories/${category.id}/product-availability`), {
      totalProducts: 1,
      totalInventory: 3,
      activeProducts: 1,
      inactiveProducts: 0,
    });
  });

  it("uses the current database role rather than an ADMIN role embedded in an old JWT", async () => {
    const adminId = (jwt.verify(adminToken, config.JWT_SECRET) as { id: number }).id;
    await prisma.user.update({ where: { id: adminId }, data: { role: "CUSTOMER" } });
    try {
      const downgraded = await request("/admin/product-listings", adminToken);
      assert.equal(downgraded.status, 403);
      assert.deepEqual(await downgraded.json(), { error: { code: "FORBIDDEN", message: "Forbidden: ADMIN only" } });
    } finally {
      await prisma.user.update({ where: { id: adminId }, data: { role: "ADMIN" } });
    }
  });

  it("returns exact zero-stock listing metadata and dynamic categories while preserving public sellability and Admin lookup", async () => {
    const category = await prisma.category.create({ data: { name: `Juniors ${randomUUID()}` } });
    ids.categories.push(category.id);
    const zeroProduct = await product(category.id);
    const zero = await listing(zeroProduct.id);
    await prisma.legoProduct.update({ where: { id: zeroProduct.id }, data: {
      isFeatureProduct: true,
      catalogueArtworkUrl: "https://images.test/juniors.jpg",
      catalogueArtworkPublicId: "colorful-life/catalogue-artwork/juniors",
    } });
    const stockedProduct = await product(category.id);
    const stocked = await listing(stockedProduct.id, { currentStock: 5, reservedStock: 2 });
    const before = await snapshot();

    const items = await allItems();
    assert.deepEqual(items.find((item) => item.id === zero.id), {
      id: zero.id, condition: "NEW", active: true, usedLifecycle: null,
      currentStock: 0, availableStock: 0, originalPrice: "30", salePrice: null, discrepancies: [],
      legoProduct: {
        id: zeroProduct.id, setNumber: zeroProduct.setNumber, title: zeroProduct.title,
        isFeatureProduct: true, isPublished: true, availabilityState: "STANDARD",
        catalogueArtworkUrl: "https://images.test/juniors.jpg",
        catalogueArtworkPublicId: "colorful-life/catalogue-artwork/juniors",
        productImages: [], category: { id: category.id, name: category.name },
      },
    });
    assert.deepEqual(items.find((item) => item.id === stocked.id), {
      id: stocked.id, condition: "NEW", active: true, usedLifecycle: null,
      currentStock: 5, availableStock: 3, originalPrice: "30", salePrice: null, discrepancies: [],
      legoProduct: {
        id: stockedProduct.id, setNumber: stockedProduct.setNumber, title: stockedProduct.title,
        isFeatureProduct: false, isPublished: true, availabilityState: "STANDARD", catalogueArtworkUrl: null, catalogueArtworkPublicId: null,
        productImages: [], category: { id: category.id, name: category.name },
      },
    });
    const publicZero = await get(`/products?q=${zeroProduct.setNumber}`);
    // Published sold-out products stay public with no purchasable offers.
    assert.deepEqual(publicZero.items.map((item: any) => [item.id, item.availability, item.offers]), [[zeroProduct.id, "OUT_OF_STOCK", []]]);
    assert.equal(publicZero.pagination.totalItems, 1);
    const publicStocked = await get(`/products?q=${stockedProduct.setNumber}`);
    assert.equal(publicStocked.items[0].id, stockedProduct.id);
    assert.deepEqual(publicStocked.items[0].offers.map((offer: any) => offer.id), [stocked.id]);

    const lookup = await get(`/admin/products?q=${zeroProduct.setNumber}`);
    assert.deepEqual(lookup.items, [{
      id: zeroProduct.id, setNumber: zeroProduct.setNumber, title: zeroProduct.title,
      description: null, theme: "Test", ageRecommendation: "8+", pieceCount: 100,
      isRetired: false, isPublished: true, availabilityState: "STANDARD", category: { id: category.id, name: category.name }, usedOfferStatus: "NONE",
    }]);
    assert.equal((await request("/admin/products")).status, 400, "existing lookup still requires q");
    assert.deepEqual(await snapshot(), before, "GET requests must not mutate listing, product or inventory data");
  });

  it("includes inactive and fully reserved listings and permits a null category", async () => {
    const lego = await product();
    const inactive = await listing(lego.id, { active: false, currentStock: 2 });
    const reservedProduct = await product();
    const reserved = await listing(reservedProduct.id, { currentStock: 2, reservedStock: 2 });
    const noListing = await product();
    const items = await allItems();
    const inactiveItem = items.find((item) => item.id === inactive.id);
    assert.equal(inactiveItem.active, false);
    assert.equal(inactiveItem.legoProduct.category, null);
    assert.equal(items.find((item) => item.id === reserved.id).availableStock, 0);
    assert.ok(!items.some((item) => item.legoProduct.id === noListing.id));
    for (const row of [lego, reservedProduct]) {
      const items = (await get(`/products?q=${row.setNumber}`)).items;
      assert.deepEqual(items.map((item: any) => [item.id, item.availability, item.offers]), [[row.id, "OUT_OF_STOCK", []]]);
    }
  });

  it("preserves separate Used listing identities and lifecycle without changing photos or public offer selection", async () => {
    const lego = await product();
    const zero = await listing(lego.id);
    async function used() {
      return listing(lego.id, {
        condition: "USED_LIKE_NEW", currentStock: 1, usedLifecycle: "AVAILABLE", damageDescription: "Outer box corner dent",
        usedConditionPhotos: { create: { url: "https://images.test/condition.png", publicId: randomUUID(), sortOrder: 0 } },
      });
    }
    const sold = await used();
    await prisma.productListing.update({ where: { id: sold.id }, data: { currentStock: 0, usedLifecycle: "SOLD" } });
    const retired = await used();
    await prisma.productListing.update({ where: { id: retired.id }, data: { currentStock: 0, usedLifecycle: "RETIRED" } });
    const available = await used();
    const before = await snapshot();

    const items = (await allItems()).filter((item) => item.legoProduct.id === lego.id);
    assert.deepEqual(items.map((item) => [item.id, item.condition, item.usedLifecycle, item.currentStock, item.availableStock]), [
      [zero.id, "NEW", null, 0, 0],
      [sold.id, "USED_LIKE_NEW", "SOLD", 0, 0],
      [retired.id, "USED_LIKE_NEW", "RETIRED", 0, 0],
      [available.id, "USED_LIKE_NEW", "AVAILABLE", 1, 1],
    ]);
    const catalogue = await get(`/products?q=${lego.setNumber}`);
    assert.equal(catalogue.items[0].id, lego.id);
    assert.deepEqual(catalogue.items[0].offers.map((offer: any) => offer.id), [available.id]);
    assert.deepEqual(await snapshot(), before);
  });

  it("summarizes distinct category products using storefront sellability independently of listing pagination", async () => {
    const category = await prisma.category.create({ data: { name: `Availability ${randomUUID()}` } });
    const otherCategory = await prisma.category.create({ data: { name: `Other ${randomUUID()}` } });
    ids.categories.push(category.id, otherCategory.id);

    const multiOfferProduct = await product(category.id);
    await listing(multiOfferProduct.id, { currentStock: 3, reservedStock: 1 });
    await listing(multiOfferProduct.id, {
      condition: "USED_LIKE_NEW", usedLifecycle: "AVAILABLE", currentStock: 1,
      damageDescription: "Box has a small crease",
      usedConditionPhotos: { create: { url: "https://images.test/summary-condition.jpg", publicId: randomUUID(), sortOrder: 0 } },
    });

    const newOnlyProduct = await product(category.id);
    await listing(newOnlyProduct.id, { currentStock: 2 });

    const usedOnlyProduct = await product(category.id);
    await listing(usedOnlyProduct.id, {
      condition: "USED_LIKE_NEW", usedLifecycle: "AVAILABLE", currentStock: 1,
      damageDescription: "Box has a small crease",
      usedConditionPhotos: { create: { url: "https://images.test/summary-used-only.jpg", publicId: randomUUID(), sortOrder: 0 } },
    });

    const mixedAvailabilityProduct = await product(category.id);
    await listing(mixedAvailabilityProduct.id, { currentStock: 1 });
    const outOfStockUsedListing = await listing(mixedAvailabilityProduct.id, {
      condition: "USED_LIKE_NEW", usedLifecycle: "AVAILABLE", currentStock: 1,
      damageDescription: "Box has a small crease",
      usedConditionPhotos: { create: { url: "https://images.test/summary-mixed.jpg", publicId: randomUUID(), sortOrder: 0 } },
    });
    await prisma.productListing.update({
      where: { id: outOfStockUsedListing.id },
      data: { usedLifecycle: "SOLD", currentStock: 0 },
    });

    const noStockAcrossConditionsProduct = await product(category.id);
    await listing(noStockAcrossConditionsProduct.id);
    const soldUsedListing = await listing(noStockAcrossConditionsProduct.id, {
      condition: "USED_LIKE_NEW", usedLifecycle: "AVAILABLE", currentStock: 1,
      damageDescription: "Box has a small crease",
      usedConditionPhotos: { create: { url: "https://images.test/summary-no-stock.jpg", publicId: randomUUID(), sortOrder: 0 } },
    });
    await prisma.productListing.update({
      where: { id: soldUsedListing.id },
      data: { usedLifecycle: "SOLD", currentStock: 0 },
    });

    const zeroStockProduct = await product(category.id);
    await listing(zeroStockProduct.id);

    const fullyReservedProduct = await product(category.id);
    await listing(fullyReservedProduct.id, { currentStock: 2, reservedStock: 2 });

    const inactiveListingProduct = await product(category.id);
    await listing(inactiveListingProduct.id, { active: false, currentStock: 4 });

    const soldUsedProduct = await product(category.id);
    const soldUsedProductListing = await listing(soldUsedProduct.id, {
      condition: "USED_LIKE_NEW", usedLifecycle: "AVAILABLE", currentStock: 1,
      damageDescription: "Box has a small crease",
      usedConditionPhotos: { create: { url: "https://images.test/summary-condition.jpg", publicId: randomUUID(), sortOrder: 0 } },
    });
    await prisma.productListing.update({
      where: { id: soldUsedProductListing.id },
      data: { usedLifecycle: "SOLD", currentStock: 0 },
    });

    const noListingProduct = await product(category.id);

    const retiredProduct = await product(category.id);
    await prisma.legoProduct.update({ where: { id: retiredProduct.id }, data: { isRetired: true } });
    await listing(retiredProduct.id, { currentStock: 1 });

    const otherCategoryProduct = await product(otherCategory.id);
    await listing(otherCategoryProduct.id, { currentStock: 3 });

    const path = `/admin/categories/${category.id}/product-availability`;
    const summary = await get(path);
    assert.deepEqual(summary, {
      totalProducts: 11,
      totalInventory: 15,
      activeProducts: 5,
      inactiveProducts: 6,
    });
    assert.equal(summary.totalProducts, summary.activeProducts + summary.inactiveProducts);
    assert.equal(await prisma.legoProduct.count({ where: { categoryId: category.id } }), summary.totalProducts);
    assert.equal(await prisma.productListing.count({ where: { legoProduct: { categoryId: category.id } } }), 13);
    assert.equal(await prisma.productListing.count({ where: { legoProductId: noListingProduct.id } }), 0);

    const firstListingPage = await get("/admin/product-listings?page=1&pageSize=1");
    assert.equal(firstListingPage.items.length, 1);
    assert.deepEqual(await get(path), summary);
    const laterListingPage = await get("/admin/product-listings?page=2&pageSize=1");
    assert.equal(laterListingPage.pagination.page, 2);
    assert.deepEqual(await get(path), summary);
  });

  it("bounds and paginates listings in stable ID order, including pages beyond the end", async () => {
    for (let i = 0; i < 23; i++) await listing((await product()).id);
    const expected = await prisma.productListing.findMany({ select: { id: true }, orderBy: { id: "asc" } });
    const first = await get("/admin/product-listings");
    assert.deepEqual(first.pagination, { page: 1, pageSize: 20, totalItems: expected.length, totalPages: Math.ceil(expected.length / 20) });
    assert.deepEqual(first.items.map((item: any) => item.id), expected.slice(0, 20).map((row) => row.id));
    const second = await get("/admin/product-listings?page=2&pageSize=20");
    assert.deepEqual(second.items.map((item: any) => item.id), expected.slice(20, 40).map((row) => row.id));
    assert.equal(second.pagination.page, 2);
    assert.deepEqual((await allItems()).map((item) => item.id), expected.map((row) => row.id));
    const beyond = await get("/admin/product-listings?page=10000&pageSize=50");
    assert.deepEqual(beyond.items, []);
    assert.deepEqual(beyond.pagination, { page: 10000, pageSize: 50, totalItems: expected.length, totalPages: Math.ceil(expected.length / 50) });
  });

  it("rejects invalid, repeated, nested and unsupported query parameters", async () => {
    for (const query of [
      "page=0", "page=-1", "page=1.5", "page=10001", "page=abc", "page=", "page=1e2",
      "pageSize=0", "pageSize=51", "pageSize=1.5", "pageSize=", "pageSize=9007199254740993",
      "page=1&page=2", "pageSize[x]=2", "q=", "q=%20%20", "q=lego&q=duplo", "q[x]=lego", "active=true",
    ]) {
      assert.equal((await request(`/admin/product-listings?${query}`)).status, 400, query);
    }
    assert.equal((await request("/admin/product-listings?page=1&pageSize=1")).status, 200);
  });
});
