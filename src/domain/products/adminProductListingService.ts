import { Prisma } from "../../generated/prisma-client/client.js";
import { prisma as defaultPrisma } from "../../prisma/runtime.js";
import type { AdminProductListingQuery } from "./adminProductListingValidator.js";

export function createAdminProductListingService(db = defaultPrisma) {
  return {
    async list(query: AdminProductListingQuery) {
      // Management visibility is independent of stock, activation and Used lifecycle.
      return db.$transaction(async (tx) => {
        const [totalItems, listings] = await Promise.all([
          tx.productListing.count(),
          tx.productListing.findMany({
            select: {
              id: true,
              condition: true,
              active: true,
              usedLifecycle: true,
              currentStock: true,
              reservedStock: true,
              legoProduct: {
                select: {
                  id: true,
                  setNumber: true,
                  title: true,
                  isFeatureProduct: true,
                  isPublished: true,
                  catalogueArtworkUrl: true,
                  catalogueArtworkPublicId: true,
                  productImages: {
                    select: { id: true, url: true, publicId: true, altText: true, sortOrder: true },
                    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
                  },
                  category: { select: { id: true, name: true } },
                },
              },
            },
            orderBy: { id: "asc" },
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
          }),
        ]);

        return {
          items: listings.map(({ reservedStock, ...listing }) => ({
            ...listing,
            availableStock: Math.max(0, listing.currentStock - reservedStock),
          })),
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
