import {logOperationalError} from "../utils/operationalLog.js";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import { FbaOutboundError, recordFbaOutbound, getFbaOutbound } from "../domain/inventory/fbaOutboundService.js";
import { sendApiError } from "../utils/apiErrorResponse.js";

function failure(res: Response, error: unknown) {
  if (error instanceof ZodError) return sendApiError(res, 400, "VALIDATION_ERROR", "Provide a valid listing, positive whole quantity, shipment reference, note and idempotency key.");
  if (error instanceof FbaOutboundError) return sendApiError(res, error.status, error.code, error.message);
  // Do not log payloads or database errors containing shipment/idempotency details.
  logOperationalError("FBA outbound operation failed");
  return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "The outbound operation could not be completed. Retry with the same idempotency key.");
}
export async function createFbaOutbound(req: Request, res: Response) {
  if (req.user?.role !== "ADMIN") return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  try {
    const result = await recordFbaOutbound(req.body, req.user.id);
    return res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) { return failure(res, error); }
}
export async function readFbaOutbound(req: Request, res: Response) {
  if (req.user?.role !== "ADMIN") return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || id > 2_147_483_647) return sendApiError(res, 400, "VALIDATION_ERROR", "Provide a valid outbound record ID.");
  try { return res.json(await getFbaOutbound(id)); }
  catch (error) { return failure(res, error); }
}
