import {logOperationalError} from "../utils/operationalLog.js";
import type { Request, Response } from "express";
import { ImageLimitExceededError, ImageNamespaceError, ImageValidationError, InvalidImageOrderError, ProductImageNotFoundError, ProductNotFoundError } from "../domain/productImages/productImageErrors.js";
import { createProductImageService } from "../domain/productImages/productImageService.js";
import type { ImageStorage } from "../infrastructure/imageStorage/imageStorage.js";

function id(value: string | undefined) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; }

export function createProductImageController(storage: ImageStorage) {
  const service = createProductImageService(storage);
  const mapError = (res: Response, error: unknown) => {
    if (error instanceof ImageValidationError || error instanceof InvalidImageOrderError) return res.status(400).json({ error: error.message });
    if (error instanceof ProductNotFoundError || error instanceof ProductImageNotFoundError) return res.status(404).json({ error: error.message });
    if (error instanceof ImageLimitExceededError) return res.status(409).json({ error: error.message });
    if (error instanceof ImageNamespaceError) return res.status(500).json({ error: "Internal server error" });
    logOperationalError("Product image operation error");
    return res.status(500).json({ error: "Internal server error" });
  };
  return {
    list: async (req: Request, res: Response) => {
      const productId = id(req.params.productId);
      if (!productId) return res.status(404).json({ error: "Product not found" });
      try { return res.json({ productImages: await service.list(productId) }); } catch (error) { return mapError(res, error); }
    },
    upload: async (req: Request, res: Response) => {
      const productId = id(req.params.productId);
      if (!productId) return res.status(404).json({ error: "Product not found" });
      try { return res.status(201).json({ image: await service.upload(productId, req.file, req.body?.altText) }); } catch (error) { return mapError(res, error); }
    },
    reorder: async (req: Request, res: Response) => {
      const productId = id(req.params.productId);
      if (!productId) return res.status(404).json({ error: "Product not found" });
      try { return res.json({ productImages: await service.reorder(productId, req.body?.imageIds) }); } catch (error) { return mapError(res, error); }
    },
    updateAltText: async (req: Request, res: Response) => {
      const productId = id(req.params.productId); const imageId = id(req.params.imageId);
      if (!productId || !imageId) return res.status(404).json({ error: "Image not found" });
      try { return res.json({ image: await service.updateAltText(productId, imageId, req.body?.altText) }); } catch (error) { return mapError(res, error); }
    },
    delete: async (req: Request, res: Response) => {
      const productId = id(req.params.productId); const imageId = id(req.params.imageId);
      if (!productId || !imageId) return res.status(404).json({ error: "Image not found" });
      try { await service.delete(productId, imageId); return res.status(204).send(); } catch (error) { return mapError(res, error); }
    },
  };
}
