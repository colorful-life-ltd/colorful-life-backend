import { Prisma } from "../../generated/prisma-client/client.js";
import { ListingCondition, UsedOfferLifecycle } from "../../generated/prisma-client/enums.js";
import { prisma as defaultPrisma } from "../../prisma/runtime.js";
import type { AdminProductLookupQuery } from "./adminProductLookupValidator.js";

export function createAdminProductLookupService(db = defaultPrisma) {
  return {
    async search(query: AdminProductLookupQuery) {
      const where: Prisma.LegoProductWhereInput = {
        OR: [
          { setNumber: { contains: query.q, mode: "insensitive" } },
          { title: { contains: query.q, mode: "insensitive" } },
        ],
      };

      return db.$transaction(async (tx) => {
        const [totalItems, products] = await Promise.all([
          tx.legoProduct.count({ where }),
          tx.legoProduct.findMany({
            where,
            select: {
              id: true,
              setNumber: true,
              title: true,
              description: true,
              theme: true,
              ageRecommendation: true,
              pieceCount: true,
              isRetired: true,
              isPublished: true,
              category: { select: { id: true, name: true } },
              productListings: {
                where: { condition: ListingCondition.USED_LIKE_NEW },
                select: { currentStock: true, usedLifecycle: true },
              },
            },
            orderBy: [{ setNumber: "asc" }, { id: "asc" }],
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
          }),
        ]);

        return {
          items: products.map(({ productListings, ...product }) => {
            const hasAvailableUsedOffer = productListings.some((listing) =>
              listing.usedLifecycle === UsedOfferLifecycle.AVAILABLE && listing.currentStock === 1,
            );
            return {
              ...product,
              usedOfferStatus: hasAvailableUsedOffer
                ? "AVAILABLE" as const
                : productListings.length > 0
                  ? "HISTORICAL_ONLY" as const
                  : "NONE" as const,
            };
          }),
          pagination: {
            page: query.page,
            pageSize: query.pageSize,
            totalItems,
            totalPages: Math.ceil(totalItems / query.pageSize),
          },
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },
  };
}
