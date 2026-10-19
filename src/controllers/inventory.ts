import { InventoryOperationConflict, inventoryOperationKey } from '../domain/inventory/inventoryOperationJournal.js';
import {logOperationalError} from "../utils/operationalLog.js";
import type { Request, Response } from "express";
import { InventoryAdjustmentRequestSchema } from "../domain/inventory/inventoryAdjustmentValidator.js";
import {
  conditionAdjustInventory,
  writeOffInventory,
  InvalidConditionAdjustmentError,
  InvalidInventoryAdjustmentReasonError,
  InvalidInventoryAdjustmentQuantityError,
  InventoryInsufficientStockError,
  InventoryListingNotFoundError,
  InventoryListingsMustDifferError,
  InventoryListingsMustShareProductError,
  reconcileStocktake,
  InvalidStocktakeQuantityError,
  StocktakeBelowReservedStockError,
  StocktakeListingNotFoundError,
} from "../domain/inventory/inventoryAdjustmentService.js";
import { z } from "zod";
import { sendApiError } from "../utils/apiErrorResponse.js";

export const reconcileStocktakeInventory = async (req: Request, res: Response) => {
  const user = req.user as { id: number; role: string };
  if (user.role !== "ADMIN") return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");

  const parsed = z.object({
    productListingId: z.number().int().positive(),
    actualStock: z.number().int().nonnegative().max(2_147_483_647),
    reasonNote: z.string().trim().optional(),
  }).strict().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });

  try {
    const result = await reconcileStocktake({ ...parsed.data, performedByUserId: user.id },inventoryOperationKey(req.get('Idempotency-Key')));
    return res.status(200).json(result);
  } catch (err: unknown) {
    if (err instanceof InventoryOperationConflict) return res.status(err.code === 'INVALID_IDEMPOTENCY_KEY' ? 400 : 409).json({error:err.code});
    if (err instanceof InvalidInventoryAdjustmentReasonError)return res.status(400).json({error:"DISCREPANCY_STOCKTAKE_REASON_REQUIRED"});
    if (err instanceof InvalidStocktakeQuantityError) return res.status(400).json({ error: err.message });
    if (err instanceof StocktakeListingNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof StocktakeBelowReservedStockError) return res.status(409).json({ error: err.message });
    logOperationalError("Stocktake reconciliation error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const createInventoryAdjustment = async (req: Request, res: Response) => {
  const user = req.user as { id: number; role: string };
  if (user.role !== "ADMIN") {
    return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  }

  const parsed = InventoryAdjustmentRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.format() });
  }

  try {
    const input = parsed.data;
    const result = input.action === "CONDITION_ADJUSTMENT"
      ? await conditionAdjustInventory({ ...input, performedByUserId: user.id })
      : await writeOffInventory({ ...input, performedByUserId: user.id },inventoryOperationKey(req.get('Idempotency-Key')));
    return res.status(201).json(result);
  } catch (err: unknown) {
    if (err instanceof InventoryOperationConflict) return res.status(err.code === 'INVALID_IDEMPOTENCY_KEY' ? 400 : 409).json({error:err.code});
    if (err instanceof InventoryListingNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof InvalidConditionAdjustmentError || err instanceof InvalidInventoryAdjustmentQuantityError || err instanceof InvalidInventoryAdjustmentReasonError) return res.status(400).json({ error: err.message });
    if (err instanceof InventoryInsufficientStockError || err instanceof InventoryListingsMustDifferError || err instanceof InventoryListingsMustShareProductError) return res.status(409).json({ error: err.message });
    logOperationalError("Inventory adjustment error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
