import { Prisma } from "../../generated/prisma-client/client.js";
import type { ProductCatalogueQuery } from "./productCatalogueValidator.js";

/**
 * EXISTS predicate for a LegoProduct aliased as `lp` having at least one
 * storefront-eligible listing. Optional price bounds retain catalogue search
 * semantics; callers calculating unfiltered availability omit them.
 */
export function storefrontSellableListingExistsPredicate(
  query: Pick<ProductCatalogueQuery, "minPrice" | "maxPrice"> = {},
): Prisma.Sql {
  const pricePredicates: Prisma.Sql[] = [];
  if (query.minPrice !== undefined) {
    pricePredicates.push(Prisma.sql`COALESCE(pl."salePrice", pl."originalPrice") >= ${query.minPrice}`);
  }
  if (query.maxPrice !== undefined) {
    pricePredicates.push(Prisma.sql`COALESCE(pl."salePrice", pl."originalPrice") <= ${query.maxPrice}`);
  }
  const pricePredicate = pricePredicates.length
    ? Prisma.sql`AND ${Prisma.join(pricePredicates, " AND ")}`
    : Prisma.empty;

  return Prisma.sql`EXISTS (
    SELECT 1 FROM "ProductListing" pl
    WHERE pl."legoProductId" = lp."id"
      AND pl."active" = TRUE
      AND pl."originalPrice" > 0
      AND (pl."salePrice" IS NULL OR pl."salePrice" > 0)
      AND pl."currentStock" > pl."reservedStock"
      AND (pl."condition" = 'NEW' OR (pl."condition" = 'USED_LIKE_NEW' AND pl."usedLifecycle" = 'AVAILABLE'))
      ${pricePredicate}
  )`;
}
