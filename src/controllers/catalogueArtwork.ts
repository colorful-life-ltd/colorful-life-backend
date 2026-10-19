import {logOperationalError} from "../utils/operationalLog.js";
import type { Request, Response } from "express";
import { CatalogueArtworkProductNotFoundError, createCatalogueArtworkService } from "../domain/catalogueArtwork/catalogueArtworkService.js";
import { ImageValidationError } from "../domain/productImages/productImageErrors.js";
import type { ImageStorage } from "../infrastructure/imageStorage/imageStorage.js";

function productId(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function createCatalogueArtworkController(storage: ImageStorage) {
  const service = createCatalogueArtworkService(storage);
  const mapError = (res: Response, error: unknown) => {
    if (error instanceof ImageValidationError) return res.status(400).json({ error: error.message });
    if (error instanceof CatalogueArtworkProductNotFoundError) return res.status(404).json({ error: error.message });
    logOperationalError("Catalogue artwork operation error");
    return res.status(500).json({ error: "Internal server error" });
  };
  return {
    set: async (req: Request, res: Response) => {
      const id = productId(req.params.productId);
      if (!id) return res.status(404).json({ error: "Product not found" });
      try { return res.status(200).json({ catalogueArtwork: await service.set(id, req.file) }); } catch (error) { return mapError(res, error); }
    },
    remove: async (req: Request, res: Response) => {
      const id = productId(req.params.productId);
      if (!id) return res.status(404).json({ error: "Product not found" });
      try { await service.remove(id); return res.status(204).send(); } catch (error) { return mapError(res, error); }
    },
  };
}
