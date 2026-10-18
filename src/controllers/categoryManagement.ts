import {logOperationalError} from "../utils/operationalLog.js";
import type { Request, Response } from "express";
import { Prisma } from "../generated/prisma-client/client.js";
import { z } from "zod";
import { CategoryNotFoundError, createCategoryManagementService } from "../domain/categories/categoryManagementService.js";
import { ImageValidationError } from "../domain/productImages/productImageErrors.js";
import type { ImageStorage } from "../infrastructure/imageStorage/imageStorage.js";

const text = (max: number) => z.preprocess((value) => typeof value === "string" ? value.trim() || null : value, z.string().max(max).nullable());
const createSchema = z.object({ name: z.string().trim().min(1).max(200), subtitle: text(300).optional(), description: text(2000).optional() });
const updateSchema = z.object({ name: z.string().trim().min(1).max(200), subtitle: text(300), description: text(2000) });
function categoryId(value: string | undefined) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; }

export function createCategoryManagementController(storage: ImageStorage) {
  const service = createCategoryManagementService(storage);
  const mapError = (res: Response, error: unknown) => {
    if (error instanceof CategoryNotFoundError) return res.status(404).json({ error: error.message });
    if (error instanceof ImageValidationError) return res.status(400).json({ error: error.message });
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return res.status(409).json({ error: "Category name already exists" });
    logOperationalError("Category management error");
    return res.status(500).json({ error: "Internal server error" });
  };
  return {
    list: async (_req: Request, res: Response) => { try { return res.json(await service.list()); } catch (error) { return mapError(res, error); } },
    productAvailabilitySummary: async (req: Request, res: Response) => {
      const id = categoryId(req.params.id);
      if (!id) return res.status(404).json({ error: "Category not found" });
      try {
        const summary = await service.productAvailabilitySummary(id);
        if (!summary) return res.status(404).json({ error: "Category not found" });
        return res.json(summary);
      } catch (error) {
        return mapError(res, error);
      }
    },
    create: async (req: Request, res: Response) => {
      const parsed = createSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
      try { return res.status(201).json(await service.create(parsed.data)); } catch (error) { return mapError(res, error); }
    },
    update: async (req: Request, res: Response) => {
      const id = categoryId(req.params.id);
      if (!id) return res.status(404).json({ error: "Category not found" });
      const parsed = updateSchema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
      try { return res.json(await service.update(id, parsed.data)); } catch (error) { return mapError(res, error); }
    },
    setArtwork: async (req: Request, res: Response) => {
      const id = categoryId(req.params.id);
      if (!id) return res.status(404).json({ error: "Category not found" });
      try { return res.json(await service.setArtwork(id, req.file)); } catch (error) { return mapError(res, error); }
    },
    removeArtwork: async (req: Request, res: Response) => {
      const id = categoryId(req.params.id);
      if (!id) return res.status(404).json({ error: "Category not found" });
      try { return res.json(await service.removeArtwork(id)); } catch (error) { return mapError(res, error); }
    },
    setThumbnailArtwork: async (req: Request, res: Response) => {
      const id = categoryId(req.params.id);
      if (!id) return res.status(404).json({ error: "Category not found" });
      try { return res.json(await service.setThumbnailArtwork(id, req.file)); } catch (error) { return mapError(res, error); }
    },
    removeThumbnailArtwork: async (req: Request, res: Response) => {
      const id = categoryId(req.params.id);
      if (!id) return res.status(404).json({ error: "Category not found" });
      try { return res.json(await service.removeThumbnailArtwork(id)); } catch (error) { return mapError(res, error); }
    },
  };
}
