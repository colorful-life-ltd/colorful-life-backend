import type { Request, Response } from "express";
import { sendApiError } from "../utils/apiErrorResponse.js";

/** Stripe is the only supported checkout provider. No environment flag can reopen PayPal. */
export async function createPayPalOrderHandler(req: Request, res: Response) {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) return res.status(400).json({ error: "Invalid order id" });
  if (!req.user?.id) return res.status(401).json({ error: "Unauthorized" });
  return sendApiError(res, 503, "PAYPAL_INITIATION_DISABLED", "PayPal checkout is currently unavailable");
}

// Capture is also a new financial transaction, including for an existing test order.
export const capturePayPalOrderHandler = createPayPalOrderHandler;
