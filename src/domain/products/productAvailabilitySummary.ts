import { Prisma } from "../../generated/prisma-client/client.js";
import type { PrismaClient } from "../../generated/prisma-client/client.js";
import { prisma as defaultPrisma } from "../../prisma/runtime.js";
import { storefrontSellableListingExistsPredicate } from "./storefrontSellability.js";

type AvailabilitySummary = {
  totalProducts: number;
  totalInventory: number;
  activeProducts: number;
  inactiveProducts: number;
};

/**
 * Create the shared product availability summary used by category and global
 * Admin endpoints. Products are counted from LegoProduct; a product is active
 * only when it is published and the storefront predicate finds a sellable offer.
 */
export function createProductAvailabilitySummaryService(db: PrismaClient = defaultPrisma) {
  async function summarize(categoryId?: number): Promise<AvailabilitySummary | null> {
    const listingInventory = Prisma.sql`
      LEFT JOIN (
        SELECT "legoProductId", SUM("currentStock") AS "totalInventory"
        FROM "ProductListing"
        GROUP BY "legoProductId"
      ) listing_inventory ON listing_inventory."legoProductId" = lp."id"
    `;
    const productScope = categoryId === undefined
      ? Prisma.sql`FROM "LegoProduct" lp ${listingInventory}`
      : Prisma.sql`
        FROM "Category" c
        LEFT JOIN "LegoProduct" lp ON lp."categoryId" = c."id"
        ${listingInventory}
        WHERE c."id" = ${categoryId}
        GROUP BY c."id"
      `;

    const rows = await db.$queryRaw<Array<{ totalProducts: bigint; totalInventory: bigint; activeProducts: bigint }>>(Prisma.sql`
      SELECT COUNT(lp."id") AS "totalProducts",
             COALESCE(SUM(listing_inventory."totalInventory"), 0)::bigint AS "totalInventory",
             COUNT(lp."id") FILTER (WHERE lp."isPublished" = TRUE AND ${storefrontSellableListingExistsPredicate()}) AS "activeProducts"
      ${productScope}
    `);
    const row = rows[0];
    if (!row) return null;

    const totalProducts = Number(row.totalProducts);
    const totalInventory = Number(row.totalInventory);
    const activeProducts = Number(row.activeProducts);
    return {
      totalProducts,
      totalInventory,
      activeProducts,
      inactiveProducts: totalProducts - activeProducts,
    };
  }

  return {
    global: () => summarize(),
    forCategory: (categoryId: number) => summarize(categoryId),
  };
}
