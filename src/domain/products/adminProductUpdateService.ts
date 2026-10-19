import { Prisma } from "../../generated/prisma-client/client.js";
import { prisma as defaultPrisma } from "../../prisma/runtime.js";
import type { ProductMetadataUpdate } from "./productMetadataUpdateValidator.js";

export class AdminProductPolicyError extends Error {}

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
  availabilityState: true,
  categoryId: true,
  category: { select: { id: true, name: true, subtitle: true, description: true, imageUrl: true, thumbnailUrl: true } },
  productImages: {
    select: { id: true, url: true, publicId: true, altText: true, sortOrder: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  },
} satisfies Prisma.LegoProductSelect;

export function createAdminProductUpdateService(db = defaultPrisma) {
  return {
    async update(productId: number, fields: ProductMetadataUpdate, actorId?: number) {
      return db.$transaction(async (tx) => {
        // Serialize publication/policy changes with checkout's listing locks.
        if (fields.isPublished !== undefined || fields.availabilityState !== undefined) {
          await tx.$queryRaw`SELECT id FROM "ProductListing" WHERE "legoProductId"=${productId} ORDER BY id FOR UPDATE`;
        }
        const product = await tx.legoProduct.findUnique({ where: { id: productId }, select: { id: true, availabilityState: true } });
        if (!product) throw new AdminProductNotFoundError("Product not found");

        if (fields.availabilityState !== undefined) {
          const actor = actorId ? await tx.user.findUnique({ where: { id: actorId }, select: { role: true, deletedAt: true } }) : null;
          if (!actor || actor.deletedAt || actor.role !== 'ADMIN' || !fields.availabilityReason || fields.availabilityReason.trim().length < 10)
            throw new AdminProductPolicyError('An active ADMIN and explicit availability evidence/reason are required. Never infer discontinuation from stock.');
          if (fields.availabilityState === 'DISCONTINUED' && fields.permanentDiscontinuationConfirmed !== true)
            throw new AdminProductPolicyError('Explicit confirmation that the product will never be restocked or sold again is required.');
          if (fields.availabilityState === 'MORE_ON_THE_WAY' && fields.restockExpectationConfirmed !== true)
            throw new AdminProductPolicyError('Explicit confirmation of a genuine restock expectation is required.');
          // Leaving a permanent discontinuation is as deliberate as entering it.
          if (product.availabilityState === 'DISCONTINUED' && fields.availabilityState !== 'DISCONTINUED' && fields.discontinuationReversalConfirmed !== true)
            throw new AdminProductPolicyError('Explicit confirmation is required to reverse a permanent discontinuation.');
          await tx.operationalAudit.create({ data: { kind: 'PRODUCT_AVAILABILITY_UPDATED', actorId, details: {
            productId, previous: product.availabilityState, availabilityState: fields.availabilityState, permanentDiscontinuationConfirmed: fields.permanentDiscontinuationConfirmed === true, restockExpectationConfirmed: fields.restockExpectationConfirmed === true, discontinuationReversalConfirmed: fields.discontinuationReversalConfirmed === true, reason: fields.availabilityReason.trim(),
          } } });
        } else if (fields.availabilityReason !== undefined) throw new AdminProductPolicyError('Availability reason requires an explicit policy state.');
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
        if (fields.availabilityState !== undefined) data.availabilityState = fields.availabilityState;
        if (fields.isPublished !== undefined) data.isPublished = fields.isPublished;
        if (fields.categoryId !== undefined) data.categoryId = fields.categoryId;

        return tx.legoProduct.update({ where: { id: productId }, data, select: updatedProductSelect });
      });
    },
  };
}
