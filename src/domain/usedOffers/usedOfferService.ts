import {logOperationalError} from "../../utils/operationalLog.js";
import { hasValidListingPrices, priceMessage } from "../products/listingPrice.js";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma-client/client.js";
import { InventoryAuditAction, InventoryAdjustmentReason, InventoryMovementType, ListingCondition, UsedOfferLifecycle } from "../../generated/prisma-client/enums.js";
import { prisma as defaultPrisma } from "../../prisma/runtime.js";
import type { ImageStorage } from "../../infrastructure/imageStorage/imageStorage.js";
import { validateImage } from "../productImages/productImageValidator.js";
import { hasCategoryFeatureProduct, lockCategoryFeatureSelection } from "../products/productListingCreationService.js";

export class UsedOfferValidationError extends Error {}
export class UsedOfferProductNotFoundError extends Error {}
export class UsedOfferConflictError extends Error {}
export class UsedOfferInsufficientNewStockError extends Error {}

export type UsedOfferInput = {
  legoProductId: number;
  originalPrice: number;
  salePrice?: number | null;
  damageDescription: string;
  reason?: InventoryAdjustmentReason;
  reasonNote?: string;
  performedByUserId: number;
  sourceNewListingId?: number;
};

async function validateEvidence(damageDescription: string, files: Express.Multer.File[] | undefined) {
  if (typeof damageDescription !== "string" || !damageDescription.trim() || damageDescription.trim().length > 2000) throw new UsedOfferValidationError("damageDescription must contain 1 to 2000 characters");
  if (!Array.isArray(files) || files.length < 1 || files.length > 3) throw new UsedOfferValidationError("Provide between 1 and 3 condition photos");
  const validated: { file: Express.Multer.File; mimeType: string }[] = [];
  for (const file of files) validated.push({ file, mimeType: (await validateImage(file)).mimeType });
  return validated;
}

async function uploadEvidence(storage: ImageStorage, files: { file: Express.Multer.File; mimeType: string }[]) {
  const uploaded: Awaited<ReturnType<ImageStorage["upload"]>>[] = [];
  try {
    for (const { file, mimeType } of files) {
      uploaded.push(await storage.upload({ buffer: file.buffer, mimeType, publicId: `used-condition/${randomUUID()}` }));
    }
    return uploaded;
  } catch (error) {
    await deleteUploaded(storage, uploaded);
    throw error;
  }
}

async function deleteUploaded(storage: ImageStorage, uploaded: Awaited<ReturnType<ImageStorage["upload"]>>[]) {
  const results = await Promise.allSettled(uploaded.map((image) => storage.delete(image.publicId)));
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      logOperationalError("Used condition photo compensation failed");
    }
  }
}

export function createUsedOfferService(storage: ImageStorage, db: PrismaClient = defaultPrisma) {
  async function persist(input: UsedOfferInput, files: Express.Multer.File[] | undefined, conversion: boolean) {
    if (conversion !== (input.sourceNewListingId !== undefined)) {
      throw new UsedOfferValidationError(conversion ? "A NEW source listing is required" : "A source listing is only accepted for condition conversion");
    }
    if (!hasValidListingPrices(input)) {
      throw new UsedOfferValidationError(priceMessage);
    }
    if (conversion && input.reason !== undefined && input.reason !== InventoryAdjustmentReason.PACKAGING_DAMAGE) {
      throw new UsedOfferValidationError("Used Like New conversion requires the PACKAGING_DAMAGE reason");
    }
    const evidence = await validateEvidence(input.damageDescription, files);
    const uploaded = await uploadEvidence(storage, evidence);
    try {
      return await db.$transaction(async (tx) => {
        // Read the category, then take the same category lock used by ordinary
        // listing creation and feature selection before locking product/listing
        // rows. This keeps all feature-related locks in one order.
        const initialProduct = await tx.legoProduct.findUnique({ where: { id: input.legoProductId }, select: { categoryId: true } });
        if (!initialProduct) throw new UsedOfferProductNotFoundError();
        if (initialProduct.categoryId !== null) await lockCategoryFeatureSelection(tx, initialProduct.categoryId);
        if (initialProduct.categoryId !== null && !(await hasCategoryFeatureProduct(tx, initialProduct.categoryId))) {
          await tx.legoProduct.update({ where: { id: input.legoProductId }, data: { isFeatureProduct: true } });
        }

        // Serialize all offers for this product, including categories without a feature lock.
        const products = await tx.$queryRaw<Array<{ id: number }>>`SELECT id FROM "LegoProduct" WHERE id = ${input.legoProductId} FOR UPDATE`;
        if (!products.length) throw new UsedOfferProductNotFoundError();
        if (await tx.productListing.findFirst({ where: { legoProductId: input.legoProductId, condition: ListingCondition.USED_LIKE_NEW, currentStock: 1 }, select: { id: true } })) {
          throw new UsedOfferConflictError();
        }

        let source: { id: number } | undefined;
        if (input.sourceNewListingId !== undefined) {
          const locked = await tx.$queryRaw<Array<{ id: number; legoProductId: number; condition: ListingCondition; currentStock: number; reservedStock: number }>>`
            SELECT id, "legoProductId", condition, "currentStock", "reservedStock"
            FROM "ProductListing" WHERE id = ${input.sourceNewListingId} FOR UPDATE`;
          const candidate = locked[0];
          if (!candidate || candidate.legoProductId !== input.legoProductId || candidate.condition !== ListingCondition.NEW) throw new UsedOfferValidationError("Source listing must be a NEW listing for this product");
          const changed = await tx.$executeRaw`
            UPDATE "ProductListing" SET "currentStock" = "currentStock" - 1
            WHERE id = ${candidate.id} AND "currentStock" - "reservedStock" >= 1`;
          if (!changed) throw new UsedOfferInsufficientNewStockError();
          source = { id: candidate.id };
        }

        const listing = await tx.productListing.create({
          data: {
            legoProductId: input.legoProductId,
            condition: ListingCondition.USED_LIKE_NEW,
            usedLifecycle: UsedOfferLifecycle.AVAILABLE,
            damageDescription: input.damageDescription.trim(),
            originalPrice: input.originalPrice,
            salePrice: input.salePrice,
            currentStock: 1,
            usedConditionPhotos: { create: uploaded.map((photo, sortOrder) => ({ url: photo.secureUrl, publicId: photo.publicId, sortOrder })) },
          },
          include: {
            usedConditionPhotos: { orderBy: { sortOrder: "asc" } },
            legoProduct: { include: {
              productImages: {
                select: { id: true, url: true, publicId: true, altText: true, sortOrder: true },
                orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
              },
              category: true,
            } },
          },
        });

        if (source) {
          const note = input.reasonNote?.trim() || `One unit converted from NEW listing ${source.id}`;
          await tx.inventoryMovement.create({ data: { listingId: source.id, quantityChange: -1, type: InventoryMovementType.CONDITION_ADJUSTMENT_SOURCE, note, performedByUserId: input.performedByUserId } });
          await tx.inventoryMovement.create({ data: { listingId: listing.id, quantityChange: 1, type: InventoryMovementType.CONDITION_ADJUSTMENT_TARGET, note, performedByUserId: input.performedByUserId } });
          await tx.inventoryAudit.create({
            data: {
              sourceProductListingId: source.id,
              targetProductListingId: listing.id,
              action: InventoryAuditAction.CONDITION_ADJUSTMENT,
              quantity: 1,
              reason: input.reason ?? InventoryAdjustmentReason.PACKAGING_DAMAGE,
              reasonNote: input.reasonNote?.trim() || null,
              performedByUserId: input.performedByUserId,
            },
          });
        } else {
          await tx.inventoryMovement.create({ data: { listingId: listing.id, quantityChange: 1, type: InventoryMovementType.MANUAL_ADJUSTMENT, note: "Used physical offer created", performedByUserId: input.performedByUserId } });
        }
        return listing;
      });
    } catch (error) {
      await deleteUploaded(storage, uploaded);
      throw error;
    }
  }
  return {
    create: (input: UsedOfferInput, files: Express.Multer.File[] | undefined) => persist(input, files, false),
    convert: (input: UsedOfferInput, files: Express.Multer.File[] | undefined) => persist(input, files, true),
  };
}
