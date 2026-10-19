import {logOperationalError} from "../../utils/operationalLog.js";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma-client/client.js";
import { prisma as defaultPrisma } from "../../prisma/runtime.js";
import type { ImageStorage } from "../../infrastructure/imageStorage/imageStorage.js";
import { isProductImagePublicId } from "../../infrastructure/imageStorage/cloudinaryImageStorage.js";
import {
  ImageLimitExceededError, ImageNamespaceError, InvalidImageOrderError,
  ProductImageNotFoundError, ProductNotFoundError,
} from "./productImageErrors.js";
import { MAX_IMAGES_PER_PRODUCT, parseOptionalAltText, validateImage } from "./productImageValidator.js";

type Db = PrismaClient;

async function lockProduct(tx: Db, productId: number) {
  await tx.$queryRaw`SELECT id FROM "LegoProduct" WHERE id = ${productId} FOR UPDATE`;
}

export function createProductImageService(storage: ImageStorage, db: Db = defaultPrisma) {
  return {
    async upload(productId: number, file: Express.Multer.File | undefined, altTextValue: unknown) {
      const { mimeType } = await validateImage(file);
      const altText = parseOptionalAltText(altTextValue);
      if (!await db.legoProduct.findUnique({ where: { id: productId }, select: { id: true } })) {
        throw new ProductNotFoundError("Product not found");
      }
      const stored = await storage.upload({ buffer: file!.buffer, mimeType, publicId: `${productId}-${randomUUID()}` });
      try {
        return await db.$transaction(async (tx) => {
          await lockProduct(tx as Db, productId);
          if (!await tx.legoProduct.findUnique({ where: { id: productId }, select: { id: true } })) {
            throw new ProductNotFoundError("Product not found");
          }
          const count = await tx.productImage.count({ where: { legoProductId: productId } });
          if (count >= MAX_IMAGES_PER_PRODUCT) throw new ImageLimitExceededError("Maximum of 10 images per product reached");
          return tx.productImage.create({
            data: { legoProductId: productId, url: stored.secureUrl, publicId: stored.publicId, altText: altText ?? null, sortOrder: count },
          });
        });
      } catch (error) {
        try { await storage.delete(stored.publicId); } catch (compensationError) {
          logOperationalError("Product image upload compensation failed", compensationError);
        }
        throw error;
      }
    },

    async list(productId: number) {
      if (!await db.legoProduct.findUnique({ where: { id: productId }, select: { id: true } })) {
        throw new ProductNotFoundError("Product not found");
      }
      return db.productImage.findMany({ where: { legoProductId: productId }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
    },

    async reorder(productId: number, imageIdsValue: unknown) {
      if (!Array.isArray(imageIdsValue) || imageIdsValue.some((value) => !Number.isInteger(value) || value <= 0)) {
        throw new InvalidImageOrderError("imageIds must be an array of positive integers");
      }
      const imageIds = imageIdsValue as number[];
      return db.$transaction(async (tx) => {
        await lockProduct(tx as Db, productId);
        if (!await tx.legoProduct.findUnique({ where: { id: productId }, select: { id: true } })) {
          throw new ProductNotFoundError("Product not found");
        }
        const images = await tx.productImage.findMany({ where: { legoProductId: productId }, select: { id: true } });
        const expected = new Set(images.map((image) => image.id));
        if (new Set(imageIds).size !== imageIds.length || imageIds.length !== images.length || imageIds.some((id) => !expected.has(id))) {
          throw new InvalidImageOrderError("imageIds must contain every image exactly once");
        }
        for (const [sortOrder, id] of imageIds.entries()) {
          await tx.productImage.update({ where: { id }, data: { sortOrder } });
        }
        return tx.productImage.findMany({ where: { legoProductId: productId }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
      });
    },

    async updateAltText(productId: number, imageId: number, altTextValue: unknown) {
      const altText = parseOptionalAltText(altTextValue);
      const image = await db.productImage.findUnique({ where: { id: imageId } });
      if (!image || image.legoProductId !== productId) throw new ProductImageNotFoundError("Image not found");
      return db.productImage.update({ where: { id: imageId }, data: { altText: altText ?? null } });
    },

    async delete(productId: number, imageId: number) {
      const image = await db.productImage.findUnique({ where: { id: imageId } });
      if (!image || image.legoProductId !== productId) throw new ProductImageNotFoundError("Image not found");
      if (!isProductImagePublicId(image.publicId)) throw new ImageNamespaceError("Image is outside the product image namespace");
      await storage.delete(image.publicId);
      return db.$transaction(async (tx) => {
        await lockProduct(tx as Db, productId);
        const current = await tx.productImage.findUnique({ where: { id: imageId } });
        if (!current || current.legoProductId !== productId) throw new ProductImageNotFoundError("Image not found");
        await tx.productImage.delete({ where: { id: imageId } });
        const remaining = await tx.productImage.findMany({ where: { legoProductId: productId }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }] });
        for (const [sortOrder, remainingImage] of remaining.entries()) {
          await tx.productImage.update({ where: { id: remainingImage.id }, data: { sortOrder } });
        }
        return remaining.map((remainingImage, sortOrder) => ({ ...remainingImage, sortOrder }));
      });
    },
  };
}
