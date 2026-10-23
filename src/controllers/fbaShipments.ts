import {logOperationalError} from "../utils/operationalLog.js";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { FbaShipmentError, FbaShipmentPageSchema, getFbaShipment, listFbaShipments, recordFbaShipment } from "../domain/inventory/fbaShipmentService.js";
import { sendApiError } from "../utils/apiErrorResponse.js";

function failure(res: Response, error: unknown) {
  if (error instanceof ZodError) return sendApiError(res, 400, "VALIDATION_ERROR", "Provide a shipment key and 1–100 distinct listings with positive whole quantities. Notes and the Amazon reference are optional; duplicate acknowledgements apply only without an Amazon reference.");
  if (error instanceof FbaShipmentError) return sendApiError(res, error.status, error.code, error.message, error.items.length || error.duplicates.length ? { ...(error.items.length ? { items: error.items } : {}), ...(error.duplicates.length ? { duplicates: error.duplicates } : {}) } : undefined);
  // Do not log payloads or database errors containing shipment/idempotency details.
  logOperationalError("FBA shipment operation failed");
  return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "The shipment could not be confirmed. Retry with the same shipment key.");
}
export async function createFbaShipment(req: Request, res: Response) {
  if (req.user?.role !== "ADMIN") return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  try {
    const result = await recordFbaShipment(req.body, req.user.id);
    return res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) { return failure(res, error); }
}
export async function readFbaShipments(req: Request, res: Response) {
  if (req.user?.role !== "ADMIN") return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  try { return res.json(await listFbaShipments(FbaShipmentPageSchema.parse(req.query))); }
  catch (error) { return failure(res, error); }
}
export async function readFbaShipment(req: Request, res: Response) {
  if (req.user?.role !== "ADMIN") return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) return sendApiError(res, 400, "VALIDATION_ERROR", "Provide a valid shipment ID.");
  try { return res.json(await getFbaShipment(id)); }
  catch (error) { return failure(res, error); }
}
