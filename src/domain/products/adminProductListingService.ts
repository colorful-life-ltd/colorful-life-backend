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
              active: true, originalPrice: true, salePrice: true,
              usedLifecycle: true,
              currentStock: true,
              reservedStock: true,
              legoProduct: {
                select: {
                  id: true,
                  setNumber: true,
                  title: true,
                  isFeatureProduct: true,
                  isPublished: true, availabilityState: true,
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

        const discrepancies = await tx.$queryRaw<Array<{ productListingId: number; id: number; quantity: number; appliedQuantity: number; shortfall: number; shipmentReference: string }>>`
          SELECT f."productListingId",f.id,f."actualQuantity" AS quantity,f."appliedQuantity",f.shortfall,f."shipmentReference" FROM "FbaOutbound" f
          WHERE f."productListingId"=ANY(${listings.map(l => l.id)}::int[]) AND f.shortfall>0
          AND NOT EXISTS(SELECT 1 FROM "OperationalAudit" a WHERE a.kind='FBA_DISCREPANCY_RESOLVED' AND a."requestKey"='fba-resolved:'||f.id::text)`;
        return {
          items: listings.map(({ reservedStock, ...listing }) => ({
            ...listing,
            discrepancies: discrepancies.filter(d => d.productListingId === listing.id),
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
