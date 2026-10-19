import {logOperationalError} from "../utils/operationalLog.js";
import type { Request, Response } from "express";
import { AdminProductListingQuerySchema } from "../domain/products/adminProductListingValidator.js";
import { createAdminProductListingService } from "../domain/products/adminProductListingService.js";

export function createAdminProductListingsController() {
  const service = createAdminProductListingService();
  return {
    list: async (req: Request, res: Response) => {
      const parsed = AdminProductListingQuerySchema.safeParse(req.query);
      if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
      try {
        return res.json(await service.list(parsed.data));
      } catch (error) {
        logOperationalError("Admin product listing feed failed", error);
        return res.status(500).json({ error: "Product listing feed failed" });
      }
    },
  };
}
