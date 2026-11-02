import { Prisma } from "../../generated/prisma-client/client.js";
import type { PrismaClient } from "../../generated/prisma-client/client.js";
import { prisma as defaultPrisma } from "../../prisma/runtime.js";

/** sitemaps.org protocol limits for one sitemap or sitemap index file. */
export const SITEMAP_MAX_URLS = 50_000;
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;

/** Public legal/trust pages and home. Private routes never enter the sitemap. */
const STATIC_PATHS = ["/", "/help", "/legal/contact", "/legal/delivery-returns", "/legal/cancellation-form", "/legal/terms", "/legal/privacy", "/legal/cookies"] as const;

const CURATED_CATEGORY_SLUGS: Record<string, string> = {
  "harry potter": "harry-potter", "star wars": "star-wars", friends: "friends", city: "city", disney: "disney",
  marvel: "marvel", "jurassic world": "jurassic-world", "flowers botanicals": "flowers-botanicals",
  ninjago: "ninjago", "dc batman": "dc-batman", vehicles: "vehicles", creator: "creator", others: "others",
};
const normalizeCategoryName = (name: string) => name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, " ").trim();
const categorySlug = (name: string, id: number) => CURATED_CATEGORY_SLUGS[normalizeCategoryName(name)] ??
  (name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `category-${id}`);

/** Stable canonical product URL path, keyed by LegoProduct ID and independent of offers or stock. */
export const productPath = (productId: number) => `/products/${productId}`;

type SitemapUrl = { loc: string; lastmod: Date | null };

export type SitemapDocument =
  | { kind: "urlset"; xml: string }
  | { kind: "index"; xml: string };

const XML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" };
export const escapeXml = (value: string) => value.replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);

function urlEntry({ loc, lastmod }: SitemapUrl) {
  const lastmodTag = lastmod ? `<lastmod>${lastmod.toISOString()}</lastmod>` : "";
  return `<url><loc>${escapeXml(loc)}</loc>${lastmodTag}</url>`;
}

function finish(xml: string) {
  // Defensive: entries are bounded (origin <= 200 chars), so 50,000 URLs stay far below 50 MiB.
  if (Buffer.byteLength(xml, "utf8") > SITEMAP_MAX_BYTES) throw new Error("Sitemap exceeds the 50 MiB protocol limit");
  return xml;
}

export function createSitemapService({ siteOrigin, maxUrlsPerSitemap = SITEMAP_MAX_URLS, db = defaultPrisma }: {
  /** Normalised public storefront origin, never the API host. */
  siteOrigin: string;
  maxUrlsPerSitemap?: number;
  db?: PrismaClient;
}) {
  if (!Number.isInteger(maxUrlsPerSitemap) || maxUrlsPerSitemap < 1 || maxUrlsPerSitemap > SITEMAP_MAX_URLS) {
    throw new Error(`maxUrlsPerSitemap must be between 1 and ${SITEMAP_MAX_URLS}`);
  }
  const absolute = (path: string) => `${siteOrigin}${path}`;
  const staticUrls: SitemapUrl[] = STATIC_PATHS.map((path) => ({ loc: absolute(path), lastmod: null }));

  async function publicUrls(tx: Prisma.TransactionClient): Promise<SitemapUrl[]> {
    const rows = await tx.$queryRaw<Array<{ id: number; name: string }>>(Prisma.sql`
      SELECT DISTINCT c."id", c."name"
      FROM "Category" c
      JOIN "LegoProduct" lp ON lp."categoryId" = c."id"
      WHERE lp."isPublished" = TRUE
    `);
    const curatedOrder = Object.values(CURATED_CATEGORY_SLUGS);
    const candidates = rows.map((row) => ({ ...row, normalized: normalizeCategoryName(row.name), base: categorySlug(row.name, row.id) }))
      .sort((a, b) => {
        const ai = curatedOrder.indexOf(a.base), bi = curatedOrder.indexOf(b.base);
        return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi) || a.normalized.localeCompare(b.normalized, "en") || a.id - b.id;
      });
    const used = new Set<string>();
    const categories = candidates.map((row) => {
      let slug = row.base;
      if (used.has(slug)) slug = `${slug}-${row.id}`;
      while (used.has(slug)) slug = `${slug}-${row.id}`;
      used.add(slug);
      return { loc: absolute(`/categories/${slug}`), lastmod: null };
    });
    return [...staticUrls, ...categories];
  }

  /**
   * Published products only, sold out or not. lastmod covers product-level page
   * content (metadata, publication and added images); offer price/stock churn is
   * deliberately excluded because it is not tracked reliably at product level.
   */
  async function publishedProducts(tx: Prisma.TransactionClient, offset: number, limit: number) {
    if (limit <= 0) return [];
    const rows = await tx.$queryRaw<Array<{ id: number; lastmod: Date }>>(Prisma.sql`
      SELECT lp."id",
             GREATEST(lp."updatedAt", (SELECT MAX(pi."createdAt") FROM "ProductImage" pi WHERE pi."legoProductId" = lp."id")) AS "lastmod"
      FROM "LegoProduct" lp
      WHERE lp."isPublished" = TRUE
      ORDER BY lp."id" ASC
      OFFSET ${offset}
      LIMIT ${limit}
    `);
    return rows.map((row): SitemapUrl => ({ loc: absolute(productPath(row.id)), lastmod: row.lastmod }));
  }

  /** Static URLs first, then products by ascending ID: a stable order for page partitioning. */
  async function pageUrls(tx: Prisma.TransactionClient, page: number, publicPaths: SitemapUrl[]): Promise<SitemapUrl[]> {
    const start = (page - 1) * maxUrlsPerSitemap;
    const end = start + maxUrlsPerSitemap;
    const fromStatic = publicPaths.slice(start, end);
    const productOffset = Math.max(0, start - publicPaths.length);
    return [...fromStatic, ...await publishedProducts(tx, productOffset, maxUrlsPerSitemap - fromStatic.length)];
  }

  const urlset = (urls: SitemapUrl[]) => finish(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(urlEntry).join("\n")}\n</urlset>\n`,
  );

  const read = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) =>
    db.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

  async function pageCount(tx: Prisma.TransactionClient, publicPaths: SitemapUrl[]) {
    const [row] = await tx.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS "count" FROM "LegoProduct" WHERE "isPublished" = TRUE
    `);
    return Math.max(1, Math.ceil((publicPaths.length + Number(row?.count ?? 0n)) / maxUrlsPerSitemap));
  }

  return {
    /** Child sitemap path used by the index; served on the public origin beside /sitemap.xml. */
    childPath: (page: number) => `/sitemap-${page}.xml`,

    /** A single urlset when everything fits, otherwise a sitemap index of child sitemaps. */
    async root(): Promise<SitemapDocument> {
      return read(async (tx) => {
        const publicPaths = await publicUrls(tx);
        const pages = await pageCount(tx, publicPaths);
        if (pages === 1) return { kind: "urlset", xml: urlset(await pageUrls(tx, 1, publicPaths)) };
        const entries = Array.from({ length: pages }, (_, index) =>
          `<sitemap><loc>${escapeXml(absolute(`/sitemap-${index + 1}.xml`))}</loc></sitemap>`);
        return {
          kind: "index",
          xml: finish(`<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join("\n")}\n</sitemapindex>\n`),
        };
      });
    },

    /** Child sitemap page (1-based); null when the catalogue fits one file or the page is out of range. */
    async page(page: number): Promise<string | null> {
      return read(async (tx) => {
        const publicPaths = await publicUrls(tx);
        const pages = await pageCount(tx, publicPaths);
        if (pages === 1 || page < 1 || page > pages) return null;
        return urlset(await pageUrls(tx, page, publicPaths));
      });
    },
  };
}
