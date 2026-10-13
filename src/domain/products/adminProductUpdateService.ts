import { Prisma } from "../../generated/prisma-client/client.js";
import { prisma as defaultPrisma } from "../../prisma/runtime.js";
import type { ProductMetadataUpdate } from "./productMetadataUpdateValidator.js";

export class AdminProductNotFoundError extends Error {}
export class AdminProductCategoryNotFoundError extends Error {}

const updatedProductSelect = {
  id: true,
  setNumber: true,
  title: true,
  description: true,
  theme: true,
  ageRecommendation: true,
  pieceCount: true,
  isRetired: true,
  isPublished: true,
  categoryId: true,
  category: { select: { id: true, name: true, subtitle: true, description: true, imageUrl: true, thumbnailUrl: true } },
  productImages: {
    select: { id: true, url: true, publicId: true, altText: true, sortOrder: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.LegoProductSelect;

export function createAdminProductUpdateService(db = defaultPrisma) {
  return {
    async update(productId: number, fields: ProductMetadataUpdate) {
      return db.$transaction(async (tx) => {
        const product = await tx.legoProduct.findUnique({ where: { id: productId }, select: { id: true } });
        if (!product) throw new AdminProductNotFoundError("Product not found");

        if (fields.categoryId !== undefined) {
          const category = await tx.category.findUnique({ where: { id: fields.categoryId }, select: { id: true } });
          if (!category) throw new AdminProductCategoryNotFoundError("Category not found");
        }

        const data: Prisma.LegoProductUncheckedUpdateInput = {};
        if (fields.setNumber !== undefined) data.setNumber = fields.setNumber;
        if (fields.title !== undefined) data.title = fields.title;
        if (fields.description !== undefined) data.description = fields.description;
        if (fields.theme !== undefined) data.theme = fields.theme;
        if (fields.ageRecommendation !== undefined) data.ageRecommendation = fields.ageRecommendation;
        if (fields.pieceCount !== undefined) data.pieceCount = fields.pieceCount;
        if (fields.isRetired !== undefined) data.isRetired = fields.isRetired;
        if (fields.isPublished !== undefined) data.isPublished = fields.isPublished;
        if (fields.categoryId !== undefined) data.categoryId = fields.categoryId;

        return tx.legoProduct.update({ where: { id: productId }, data, select: updatedProductSelect });
      });
    },
  };
}
