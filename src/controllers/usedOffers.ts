import { hasValidListingPrices, priceMessage } from "../domain/products/listingPrice.js";
import type { Request, Response } from "express";
import { Prisma } from "../generated/prisma-client/client.js";
import { InventoryAdjustmentReason } from "../generated/prisma-client/enums.js";
import type { ImageStorage } from "../infrastructure/imageStorage/imageStorage.js";
import { createUsedOfferService, UsedOfferConflictError, UsedOfferInsufficientNewStockError, UsedOfferProductNotFoundError, UsedOfferValidationError } from "../domain/usedOffers/usedOfferService.js";
import { ImageValidationError } from "../domain/productImages/productImageErrors.js";

function positiveId(value: string | undefined) { const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : null; }

export function createUsedOfferController(storage: ImageStorage) {
  const service = createUsedOfferService(storage);
  const handle = async (req: Request, res: Response, sourceNewListingId?: number) => {
    const allowed = new Set(["originalPrice", "salePrice", "damageDescription", "reason", "reasonNote", ...(sourceNewListingId === undefined ? [] : ["sourceNewListingId"])]);
    if (Object.keys(req.body ?? {}).some((key) => !allowed.has(key))) return res.status(400).json({ error: "Unexpected Used offer field" });
    const legoProductId = positiveId(req.params.productId);
    if (!legoProductId) return res.status(400).json({ error: "Invalid LegoProduct id" });
    const originalPrice = Number(req.body?.originalPrice);
    const salePrice = req.body?.salePrice === undefined || req.body.salePrice === "" ? undefined : req.body.salePrice === null ? null : Number(req.body.salePrice);
    const reason = req.body?.reason;
    if (!hasValidListingPrices({ originalPrice, salePrice })) return res.status(400).json({ error: priceMessage });
    if (reason !== undefined && !Object.values(InventoryAdjustmentReason).includes(reason)) return res.status(400).json({ error: "Invalid inventory adjustment reason" });
    try {
      const input = {
        legoProductId,
        originalPrice,
        salePrice,
        damageDescription: req.body?.damageDescription,
        reason,
        reasonNote: typeof req.body?.reasonNote === "string" ? req.body.reasonNote : undefined,
        performedByUserId: req.user!.id,
        sourceNewListingId,
      };
      const operation = sourceNewListingId === undefined ? service.create : service.convert;
      const listing = await operation(input, req.files as Express.Multer.File[] | undefined);
      return res.status(201).json(listing);
    } catch (error) {
      if (error instanceof UsedOfferValidationError || error instanceof ImageValidationError) return res.status(400).json({ error: error.message });
      if (error instanceof UsedOfferProductNotFoundError) return res.status(404).json({ error: "LegoProduct not found" });
      if (error instanceof UsedOfferInsufficientNewStockError) return res.status(409).json({ error: "Insufficient available NEW stock" });
      if (error instanceof UsedOfferConflictError || (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) return res.status(409).json({ error: "An available Used offer already exists for this product" });
      console.error("Used offer operation failed", error);
      return res.status(500).json({ error: "Used offer could not be created" });
    }
  };
  return {
    create: (req: Request, res: Response) => handle(req, res),
    convert: (req: Request, res: Response) => {
      const sourceNewListingId = positiveId(req.body?.sourceNewListingId);
      if (!sourceNewListingId) return res.status(400).json({ error: "Invalid sourceNewListingId" });
      return handle(req, res, sourceNewListingId);
    },
  };
}
