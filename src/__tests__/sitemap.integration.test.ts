import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import express from "express";
import { Decimal } from "@prisma/client/runtime/client";
import defaultApp from "../app.js";
import { prisma } from "../prisma/runtime.js";
import { config } from "../config/index.js";
import { createSitemapRouter } from "../routes/sitemap.js";
import { escapeXml } from "../domain/seo/sitemapService.js";
import { parsePublicSiteOrigin } from "../domain/seo/publicSiteOrigin.js";

const ORIGIN = "https://shop.example.co.uk";
const productIds: number[] = [];
const categoryIds: number[] = [];
const servers: Server[] = [];

afterEach(async () => {
  if (productIds.length) {
    await prisma.productListing.deleteMany({ where: { legoProductId: { in: productIds } } });
    await prisma.legoProduct.deleteMany({ where: { id: { in: productIds } } });
  }
  productIds.length = 0;
  if (categoryIds.length) await prisma.category.deleteMany({ where: { id: { in: categoryIds } } });
  categoryIds.length = 0;
});

after(async () => { for (const server of servers) server.close(); await prisma.$disconnect(); });

async function serve(app: express.Express) {
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((done) => server.once("listening", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  return `http://localhost:${address.port}`;
}

async function sitemapServer(options: { siteUrl?: string; maxUrlsPerSitemap?: number }) {
  const app = express();
  app.use(createSitemapRouter(options));
  return serve(app);
}

async function makeProduct({ isPublished = true, currentStock = 1, title = "Sitemap product" } = {}) {
  const product = await prisma.legoProduct.create({
    data: { setNumber: `SITEMAP-${randomUUID()}`, title, theme: "Test", ageRecommendation: "8+", pieceCount: 1, isPublished },
  });
  productIds.push(product.id);
  await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: new Decimal(10), currentStock } });
  return product;
}

const locs = (xml: string) => [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]);
const urlEntries = (xml: string) => [...xml.matchAll(/<url>(.*?)<\/url>/g)].map((match) => match[1]);
const productUrl = (id: number) => `${ORIGIN}/products/${id}`;
const basePaths = ["/", "/help", "/legal/contact", "/legal/delivery-returns", "/legal/cancellation-form", "/legal/terms", "/legal/privacy", "/legal/cookies"];
const categorySlug = (name: string, id: number) => {
  const normalized = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, " ").trim();
  const curated: Record<string, string> = { "harry potter": "harry-potter", "star wars": "star-wars", friends: "friends", city: "city", disney: "disney", marvel: "marvel", "jurassic world": "jurassic-world", "flowers botanicals": "flowers-botanicals", ninjago: "ninjago", "dc batman": "dc-batman", vehicles: "vehicles", creator: "creator", others: "others" };
  return curated[normalized] ?? (normalized.replace(/ /g, "-") || `category-${id}`);
};

async function expectedNonProductLocs() {
  const categories = await prisma.category.findMany({ where: { legoProducts: { some: { isPublished: true } } }, select: { id: true, name: true } });
  const curatedOrder = ["harry-potter", "star-wars", "friends", "city", "disney", "marvel", "jurassic-world", "flowers-botanicals", "ninjago", "dc-batman", "vehicles", "creator", "others"];
  const ordered = categories.map(row => ({ ...row, normalized: row.name.toLocaleLowerCase("en"), base: categorySlug(row.name, row.id) }))
    .sort((a, b) => (curatedOrder.indexOf(a.base) < 0 ? 999 : curatedOrder.indexOf(a.base)) - (curatedOrder.indexOf(b.base) < 0 ? 999 : curatedOrder.indexOf(b.base)) || a.normalized.localeCompare(b.normalized, "en") || a.id - b.id);
  const used = new Set<string>();
  const paths = ordered.map(({ base, id }) => { let slug = base; if (used.has(slug)) slug = `${base}-${id}`; while (used.has(slug)) slug = `${slug}-${id}`; used.add(slug); return `/categories/${slug}`; });
  return [...basePaths.map(path => `${ORIGIN}${path}`), ...paths.map(path => `${ORIGIN}${path}`)];
}

async function expectedProductLocs() {
  const published = await prisma.legoProduct.findMany({ where: { isPublished: true }, select: { id: true }, orderBy: { id: "asc" } });
  return published.map((product) => productUrl(product.id));
}

function assertUrlset(xml: string) {
  assert.ok(xml.startsWith(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`));
  assert.ok(xml.trimEnd().endsWith("</urlset>"));
  for (const entry of urlEntries(xml)) {
    assert.match(entry, /^<loc>[^<]+<\/loc>(<lastmod>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z<\/lastmod>)?$/);
  }
  assert.equal(urlEntries(xml).length, locs(xml).length);
  assert.doesNotMatch(xml, /&(?!amp;|lt;|gt;|quot;|apos;)/, "text must be XML-escaped");
}

describe("public site origin and XML escaping", () => {
  it("accepts only bare http(s) origins", () => {
    assert.equal(parsePublicSiteOrigin("https://Shop.Example.co.uk/"), "https://shop.example.co.uk");
    assert.equal(parsePublicSiteOrigin("http://localhost:5173"), "http://localhost:5173");
    for (const invalid of ["shop.example.co.uk", "ftp://shop.example.co.uk", "https://shop.example.co.uk/store", "https://shop.example.co.uk/?a=1", "https://shop.example.co.uk/#x", "https://user:pw@shop.example.co.uk", ""]) {
      assert.equal(parsePublicSiteOrigin(invalid), null, invalid);
    }
  });

  it("escapes every XML special character", () => {
    assert.equal(escapeXml(`a&b<c>d"e'f`), "a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });
});

describe("GET /sitemap.xml", () => {
  before(() => { assert.ok(config.DATABASE_URL); });

  it("is unavailable rather than guessing a host when PUBLIC_SITE_URL is not configured", async () => {
    const base = await sitemapServer({ siteUrl: "" });
    const response = await fetch(`${base}/sitemap.xml`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "SITEMAP_UNAVAILABLE");
    if (!config.PUBLIC_SITE_URL) assert.equal((await fetch(`${await serve(defaultApp)}/sitemap.xml`)).status, 503);
  });

  it("lists the home page and every published product, including sold-out, with canonical absolute URLs", async () => {
    const inStock = await makeProduct({ currentStock: 3 });
    const soldOut = await makeProduct({ currentStock: 0 });
    const unpublished = await makeProduct({ isPublished: false, currentStock: 3 });
    const tricky = await makeProduct({ title: `Bricks & <Mortar> "quoted" 'single'` });
    const base = await sitemapServer({ siteUrl: `${ORIGIN}/` });

    const response = await fetch(`${base}/sitemap.xml`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^application\/xml; charset=utf-8$/);
    assert.match(response.headers.get("cache-control") ?? "", /public/);
    const xml = await response.text();
    assertUrlset(xml);

    const found = locs(xml);
    const nonProductLocs = await expectedNonProductLocs();
    assert.deepEqual(found.slice(0, nonProductLocs.length), nonProductLocs);
    assert.deepEqual(found.slice(nonProductLocs.length), await expectedProductLocs());
    assert.equal(new Set(found).size, found.length, "no duplicate URLs");
    for (const product of [inStock, soldOut, tricky]) assert.ok(found.includes(productUrl(product.id)));
    assert.ok(!found.includes(productUrl(unpublished.id)));
    assert.ok(found.every((loc) => /^https:\/\/shop\.example\.co\.uk\/(?:|products\/[1-9]\d*|categories\/[a-z0-9-]+|help|legal\/[a-z-]+)$/.test(loc)));
    assert.doesNotMatch(xml, /localhost|\/(checkout|account|admin|orders|cart|verify-email|reset-password)\b/);
    assert.doesNotMatch(xml, /Bricks/, "only URLs, never product text, are emitted");
  });

  it("includes categories with published products and excludes empty or unpublished-only categories", async () => {
    const suffix = randomUUID();
    const live = await prisma.category.create({ data: { name: `Marvel ${suffix}` } });
    const empty = await prisma.category.create({ data: { name: `Empty ${suffix}` } });
    categoryIds.push(live.id, empty.id);
    const product = await makeProduct({ currentStock: 0 });
    await prisma.legoProduct.update({ where: { id: product.id }, data: { categoryId: live.id } });
    const hidden = await makeProduct({ isPublished: false });
    await prisma.legoProduct.update({ where: { id: hidden.id }, data: { categoryId: empty.id } });
    const base = await sitemapServer({ siteUrl: ORIGIN });
    const xml = await (await fetch(`${base}/sitemap.xml`)).text();
    assert.ok(locs(xml).includes(`${ORIGIN}/categories/marvel-${suffix.toLocaleLowerCase("en")}`));
    assert.ok(!locs(xml).some(loc => loc.includes(`empty-${suffix.toLocaleLowerCase("en")}`)));
  });

  it("reports a product-level lastmod and keeps product URLs stable as offers sell out", async () => {
    const product = await makeProduct({ currentStock: 2 });
    const base = await sitemapServer({ siteUrl: ORIGIN });
    const entryFor = async () => urlEntries(await (await fetch(`${base}/sitemap.xml`)).text()).find((entry) => entry.includes(`<loc>${productUrl(product.id)}</loc>`));

    const initial = await entryFor();
    assert.equal(initial, `<loc>${productUrl(product.id)}</loc><lastmod>${product.updatedAt.toISOString()}</lastmod>`);

    await prisma.productListing.updateMany({ where: { legoProductId: product.id }, data: { currentStock: 0, active: false } });
    await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: new Decimal(99), currentStock: 0 } });
    assert.equal(await entryFor(), initial, "offer and stock changes keep the URL and product lastmod");

    const image = await prisma.productImage.create({ data: { legoProductId: product.id, url: "https://cdn.example/x.jpg", publicId: `sitemap-${product.id}`, createdAt: new Date(product.updatedAt.getTime() + 1) } });
    assert.equal(await entryFor(), `<loc>${productUrl(product.id)}</loc><lastmod>${image.createdAt.toISOString()}</lastmod>`);

    const unpublished = await prisma.legoProduct.update({ where: { id: product.id }, data: { isPublished: false } });
    assert.equal(await entryFor(), undefined, "unpublishing removes the URL");
    await prisma.legoProduct.update({ where: { id: product.id }, data: { isPublished: true } });
    const republished = await prisma.legoProduct.findUniqueOrThrow({ where: { id: product.id } });
    assert.ok(republished.updatedAt >= unpublished.updatedAt);
    assert.equal(await entryFor(), `<loc>${productUrl(product.id)}</loc><lastmod>${republished.updatedAt.toISOString()}</lastmod>`);
  });

  it("splits a larger catalogue into a sitemap index whose pages cover every URL exactly once", async () => {
    const created = await prisma.legoProduct.createManyAndReturn({
      data: Array.from({ length: 130 }, (_, index) => ({
        setNumber: `SITEMAP-BULK-${randomUUID()}`, title: "Bulk", theme: "Test", ageRecommendation: "8+", pieceCount: 1, isPublished: index % 10 !== 0,
      })),
      select: { id: true, isPublished: true },
    });
    productIds.push(...created.map((product) => product.id));
    const pageSize = 25;
    const base = await sitemapServer({ siteUrl: ORIGIN, maxUrlsPerSitemap: pageSize });
    const expected = [...await expectedNonProductLocs(), ...await expectedProductLocs()];
    const pages = Math.ceil(expected.length / pageSize);
    assert.ok(pages > 1);

    const root = await fetch(`${base}/sitemap.xml`);
    assert.equal(root.status, 200);
    const index = await root.text();
    assert.ok(index.startsWith(`<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`));
    assert.deepEqual(locs(index), Array.from({ length: pages }, (_, page) => `${ORIGIN}/sitemap-${page + 1}.xml`));

    const seen: string[] = [];
    for (let page = 1; page <= pages; page += 1) {
      const response = await fetch(`${base}/sitemap-${page}.xml`);
      assert.equal(response.status, 200);
      const xml = await response.text();
      assertUrlset(xml);
      assert.ok(locs(xml).length <= pageSize);
      seen.push(...locs(xml));
    }
    assert.deepEqual(seen, expected, "pages are ordered, complete and duplicate-free");
    for (const product of created.filter((row) => !row.isPublished)) assert.ok(!seen.includes(productUrl(product.id)));

    for (const missing of [`/sitemap-${pages + 1}.xml`, "/sitemap-0.xml", "/sitemap-abc.xml"]) {
      assert.equal((await fetch(`${base}${missing}`)).status, 404, missing);
    }
  });

  it("does not serve child pages when everything fits in /sitemap.xml", async () => {
    const base = await sitemapServer({ siteUrl: ORIGIN });
    assert.equal((await fetch(`${base}/sitemap-1.xml`)).status, 404);
  });
});
