import {logOperationalError} from "../../utils/operationalLog.js";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma-client/client.js";
import { prisma as defaultPrisma } from "../../prisma/runtime.js";
import type { ImageStorage } from "../../infrastructure/imageStorage/imageStorage.js";
import { isCatalogueArtworkPublicId } from "../../infrastructure/imageStorage/cloudinaryImageStorage.js";
import { validateImage } from "../productImages/productImageValidator.js";

export class CatalogueArtworkProductNotFoundError extends Error {}

type Db = PrismaClient;

async function lockProduct(tx: Db, productId: number) {
  await tx.$queryRaw`SELECT id FROM "LegoProduct" WHERE id = ${productId} FOR UPDATE`;
}

export function createCatalogueArtworkService(storage: ImageStorage, db: Db = defaultPrisma) {
  return {
    async set(productId: number, file: Express.Multer.File | undefined) {
      const { mimeType } = await validateImage(file);
      const existing = await db.legoProduct.findUnique({
        where: { id: productId },
        select: { id: true, catalogueArtworkPublicId: true },
      });
      if (!existing) throw new CatalogueArtworkProductNotFoundError("Product not found");

      const stored = await storage.upload({ buffer: file!.buffer, mimeType, publicId: `${productId}-${randomUUID()}` });
      try {
        const previous = await db.$transaction(async (tx) => {
          await lockProduct(tx as Db, productId);
          const product = await tx.legoProduct.findUnique({ where: { id: productId }, select: { catalogueArtworkPublicId: true } });
          if (!product) throw new CatalogueArtworkProductNotFoundError("Product not found");
          await tx.legoProduct.update({
            where: { id: productId },
            data: { catalogueArtworkUrl: stored.secureUrl, catalogueArtworkPublicId: stored.publicId },
          });
          return product.catalogueArtworkPublicId;
        });
        if (previous && previous !== stored.publicId && isCatalogueArtworkPublicId(previous)) {
          try { await storage.delete(previous); } catch (error) {
            logOperationalError("Catalogue artwork replacement cleanup failed", error);
          }
        }
        return { url: stored.secureUrl, publicId: stored.publicId };
      } catch (error) {
        try { await storage.delete(stored.publicId); } catch (compensationError) {
          logOperationalError("Catalogue artwork upload compensation failed", compensationError);
        }
        throw error;
      }
    },

    async remove(productId: number) {
      const previous = await db.$transaction(async (tx) => {
        await lockProduct(tx as Db, productId);
        const product = await tx.legoProduct.findUnique({ where: { id: productId }, select: { catalogueArtworkPublicId: true } });
        if (!product) throw new CatalogueArtworkProductNotFoundError("Product not found");
        await tx.legoProduct.update({ where: { id: productId }, data: { catalogueArtworkUrl: null, catalogueArtworkPublicId: null } });
        return product.catalogueArtworkPublicId;
      });
      if (previous && isCatalogueArtworkPublicId(previous)) {
        try { await storage.delete(previous); } catch (error) {
          logOperationalError("Catalogue artwork removal cleanup failed", error);
        }
      }
    },
  };
}
