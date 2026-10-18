import { hasValidListingPrices } from "./listingPrice.js";
import { Prisma } from "../../generated/prisma-client/client.js";
import { prisma } from "../../prisma/runtime.js";
import type { ProductCatalogueQuery } from "./productCatalogueValidator.js";
import { storefrontSellableListingExistsPredicate } from "./storefrontSellability.js";

const offerSelect = {
  id: true, legoProductId: true,
  active: true, condition: true, usedLifecycle: true, damageDescription: true, originalPrice: true,
  salePrice: true, currentStock: true, reservedStock: true,
  usedConditionPhotos: { orderBy: { sortOrder: "asc" as const } },
};

const productImages = {
  select: { id: true, url: true, publicId: true, altText: true, sortOrder: true },
  orderBy: [{ sortOrder: "asc" as const }, { id: "asc" as const }],
};

function eligibleProductPredicate(query: ProductCatalogueQuery): Prisma.Sql {
  const predicates: Prisma.Sql[] = [];
  if (query.q) predicates.push(Prisma.sql`(
    strpos(lower(lp."setNumber"), lower(${query.q})) > 0 OR
    strpos(lower(lp."title"), lower(${query.q})) > 0
  )`);
  if (query.theme) predicates.push(Prisma.sql`lower(lp."theme") = lower(${query.theme})`);
  if (query.categoryId !== undefined) predicates.push(Prisma.sql`lp."categoryId" = ${query.categoryId}`);

  // Publication decides discoverability; sold-out products remain listed. A price
  // filter can only match a sellable offer, so it still requires one in range.
  predicates.push(Prisma.sql`lp."isPublished" = TRUE`);
  if (query.minPrice !== undefined || query.maxPrice !== undefined) {
    predicates.push(storefrontSellableListingExistsPredicate(query));
  }
  return Prisma.join(predicates, " AND ");
}

function offerMatchesQuery(listing: any, query: ProductCatalogueQuery) {
  if (!listing.active || listing.currentStock <= listing.reservedStock || !hasValidListingPrices(listing)) return false;
  if (listing.condition !== "NEW" && !(listing.condition === "USED_LIKE_NEW" && listing.usedLifecycle === "AVAILABLE")) return false;
  const effectivePrice = Number(listing.salePrice ?? listing.originalPrice);
  return (query.minPrice === undefined || effectivePrice >= query.minPrice)
    && (query.maxPrice === undefined || effectivePrice <= query.maxPrice);
}

export type ProductAvailability = "IN_STOCK" | "OUT_OF_STOCK";

function presentProduct(product: any, query?: ProductCatalogueQuery) {
  const { category, productListings, ...shared } = product;
  // Offers stay sellable-only; availability ignores search price bounds.
  const availability: ProductAvailability = productListings.some((listing: any) => offerMatchesQuery(listing, {} as ProductCatalogueQuery))
    ? "IN_STOCK" : "OUT_OF_STOCK";
  const offers = productListings
    .filter((listing: any) => query ? offerMatchesQuery(listing, query) : offerMatchesQuery(listing, {} as ProductCatalogueQuery))
    .map(({ reservedStock, ...listing }: any) => ({
      ...listing,
      availableStock: Math.max(0, listing.currentStock - reservedStock),
      effectivePrice: listing.salePrice ?? listing.originalPrice,
    }));
  return {
    ...shared,
    category: category ?? null,
    availability,
    offers,
  };
}

export async function listCatalogueProducts(query: ProductCatalogueQuery) {
  const predicate = eligibleProductPredicate(query);
  return prisma.$transaction(async (tx) => {
    const [countRows, pageRows] = await Promise.all([
      tx.$queryRaw<Array<{ totalItems: bigint }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS "totalItems"
        FROM "LegoProduct" lp
        WHERE ${predicate}
      `),
      tx.$queryRaw<Array<{ id: number }>>(Prisma.sql`
        SELECT lp."id"
        FROM "LegoProduct" lp
        WHERE ${predicate}
        ORDER BY lp."createdAt" DESC, lp."id" DESC
        OFFSET ${(query.page - 1) * query.pageSize}
        LIMIT ${query.pageSize}
      `),
    ]);
    const productIds = pageRows.map((row) => row.id);
    const products = await tx.legoProduct.findMany({
      where: { id: { in: productIds } },
      include: {
        category: { select: { id: true, name: true, subtitle: true, description: true, imageUrl: true, thumbnailUrl: true } },
        productImages,
        productListings: { select: offerSelect, orderBy: [{ condition: "asc" }, { id: "asc" }] },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const totalItems = Number(countRows[0]?.totalItems ?? 0n);
    return {
      items: products.map((product) => presentProduct(product, query)),
      pagination: { page: query.page, pageSize: query.pageSize, totalItems, totalPages: Math.ceil(totalItems / query.pageSize) },
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function getCatalogueProductById(productId: number) {
  const product = await prisma.legoProduct.findUnique({
    where: { id: productId, isPublished: true },
    include: {
      category: { select: { id: true, name: true, subtitle: true, description: true, imageUrl: true, thumbnailUrl: true } },
      productImages,
      productListings: { select: offerSelect, orderBy: [{ condition: "asc" }, { id: "asc" }] },
    },
  });
  // Published products keep a permanent detail page, including when sold out.
  return product ? presentProduct(product) : null;
}
