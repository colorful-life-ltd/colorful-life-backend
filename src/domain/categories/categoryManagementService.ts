import {logOperationalError} from "../../utils/operationalLog.js";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../generated/prisma-client/client.js";
import { prisma as defaultPrisma } from "../../prisma/runtime.js";
import type { ImageStorage } from "../../infrastructure/imageStorage/imageStorage.js";
import { isOwnedCategoryArtworkPublicId } from "../../infrastructure/imageStorage/cloudinaryImageStorage.js";
import { validateImage } from "../productImages/productImageValidator.js";
import { createProductAvailabilitySummaryService } from "../products/productAvailabilitySummary.js";

export class CategoryNotFoundError extends Error {}
type Db = PrismaClient;
type ArtworkSlot = "opening" | "thumbnail";
const categorySelect = {
  id: true, name: true, subtitle: true, description: true,
  imageUrl: true, imagePublicId: true, thumbnailUrl: true, thumbnailPublicId: true,
} as const;
async function lockCategory(tx: Db, categoryId: number) {
  await tx.$queryRaw`SELECT id FROM "Category" WHERE id = ${categoryId} FOR UPDATE`;
}
export function createCategoryManagementService(storage: ImageStorage, db: Db = defaultPrisma) {
  const availabilitySummary = createProductAvailabilitySummaryService(db);

  async function uploadArtwork(categoryId: number, file: Express.Multer.File | undefined, slot: ArtworkSlot) {
    const { mimeType } = await validateImage(file);
    const existing = await db.category.findUnique({ where: { id: categoryId }, select: { id: true } });
    if (!existing) throw new CategoryNotFoundError("Category not found");
    const stored = await storage.upload({ buffer: file!.buffer, mimeType, publicId: `${categoryId}-${randomUUID()}` });
    const fields = slot === "opening"
      ? { publicId: "imagePublicId" as const, siblingPublicId: "thumbnailPublicId" as const }
      : { publicId: "thumbnailPublicId" as const, siblingPublicId: "imagePublicId" as const };
    const label = slot === "opening" ? "Category artwork" : "Category thumbnail artwork";
    let previous: { publicId: string | null; stillUsedBySibling: boolean };
    try {
      previous = await db.$transaction(async (tx) => {
        await lockCategory(tx as Db, categoryId);
        const category = await tx.category.findUnique({
          where: { id: categoryId },
          select: { imagePublicId: true, thumbnailPublicId: true },
        });
        if (!category) throw new CategoryNotFoundError("Category not found");
        const previousPublicId = category[fields.publicId];
        const stillUsedBySibling = previousPublicId !== null && previousPublicId === category[fields.siblingPublicId];
        await tx.category.update({
          where: { id: categoryId },
          data: slot === "opening"
            ? { imageUrl: stored.secureUrl, imagePublicId: stored.publicId }
            : { thumbnailUrl: stored.secureUrl, thumbnailPublicId: stored.publicId },
        });
        return { publicId: previousPublicId, stillUsedBySibling };
      });
    } catch (error) {
      try { await storage.delete(stored.publicId); } catch (compensationError) { logOperationalError(`${label} upload compensation failed`, compensationError); }
      throw error;
    }
    if (previous.publicId && previous.publicId !== stored.publicId && !previous.stillUsedBySibling && isOwnedCategoryArtworkPublicId(previous.publicId, categoryId)) {
      try { await storage.delete(previous.publicId); } catch (error) { logOperationalError(`${label} replacement cleanup failed`, error); }
    }
    return db.category.findUniqueOrThrow({ where: { id: categoryId }, select: categorySelect });
  }

  async function deleteArtwork(categoryId: number, slot: ArtworkSlot) {
    const fields = slot === "opening"
      ? { publicId: "imagePublicId" as const, siblingPublicId: "thumbnailPublicId" as const }
      : { publicId: "thumbnailPublicId" as const, siblingPublicId: "imagePublicId" as const };
    const label = slot === "opening" ? "Category artwork" : "Category thumbnail artwork";
    const previous = await db.$transaction(async (tx) => {
      await lockCategory(tx as Db, categoryId);
      const category = await tx.category.findUnique({
        where: { id: categoryId },
        select: { imagePublicId: true, thumbnailPublicId: true },
      });
      if (!category) throw new CategoryNotFoundError("Category not found");
      const previousPublicId = category[fields.publicId];
      const stillUsedBySibling = previousPublicId !== null && previousPublicId === category[fields.siblingPublicId];
      await tx.category.update({
        where: { id: categoryId },
        data: slot === "opening"
          ? { imageUrl: null, imagePublicId: null }
          : { thumbnailUrl: null, thumbnailPublicId: null },
      });
      return { publicId: previousPublicId, stillUsedBySibling };
    });
    if (previous.publicId && !previous.stillUsedBySibling && isOwnedCategoryArtworkPublicId(previous.publicId, categoryId)) {
      try { await storage.delete(previous.publicId); } catch (error) { logOperationalError(`${label} removal cleanup failed`, error); }
    }
    return db.category.findUniqueOrThrow({ where: { id: categoryId }, select: categorySelect });
  }

  return {
    async list() { return db.category.findMany({ orderBy: { id: "asc" }, select: categorySelect }); },
    async productAvailabilitySummary(categoryId: number) {
      return availabilitySummary.forCategory(categoryId);
    },
    async create(data: { name: string; subtitle?: string | null; description?: string | null }) {
      return db.category.create({ data, select: categorySelect });
    },
    async update(categoryId: number, data: { name: string; subtitle: string | null; description: string | null }) {
      if (!await db.category.findUnique({ where: { id: categoryId }, select: { id: true } })) throw new CategoryNotFoundError("Category not found");
      await db.category.update({ where: { id: categoryId }, data });
      return db.category.findUniqueOrThrow({ where: { id: categoryId }, select: categorySelect });
    },
    async setArtwork(categoryId: number, file: Express.Multer.File | undefined) { return uploadArtwork(categoryId, file, "opening"); },
    async removeArtwork(categoryId: number) { return deleteArtwork(categoryId, "opening"); },
    async setThumbnailArtwork(categoryId: number, file: Express.Multer.File | undefined) { return uploadArtwork(categoryId, file, "thumbnail"); },
    async removeThumbnailArtwork(categoryId: number) { return deleteArtwork(categoryId, "thumbnail"); },
  };
}
