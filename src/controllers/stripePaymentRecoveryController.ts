import {logOperationalError} from "../utils/operationalLog.js";
import type { Request, Response } from "express";
import { sendApiError } from "../utils/apiErrorResponse.js";
import { StripePaymentProviderError } from "../domain/payments/stripePaymentService.js";
import { recoverStripePayment, StripeRecoveryMismatchError, StripeRecoveryOrderNotFoundError, StripeRecoveryUnavailableError } from "../domain/payments/stripePaymentRecoveryService.js";

export async function recoverStripePaymentHandler(req: Request, res: Response) {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) return res.status(400).json({ error: "Invalid order id" });
  const userId = req.user?.id;
  if (!userId) return sendApiError(res, 401, "AUTH_REQUIRED", "Missing or invalid authorization header");
  try {
    return res.status(200).json(await recoverStripePayment(orderId, userId));
  } catch (error) {
    if (error instanceof StripeRecoveryOrderNotFoundError) return res.status(404).json({ error: "Order not found" });
    if (error instanceof StripeRecoveryUnavailableError) return sendApiError(res, 409, "STRIPE_RECOVERY_UNAVAILABLE", "Order has no recoverable Stripe payment reference");
    if (error instanceof StripeRecoveryMismatchError) return sendApiError(res, 409, "STRIPE_RECOVERY_MISMATCH", "Stripe payment correlation or amount validation failed");
    if (error instanceof StripePaymentProviderError) return res.status(503).json({ error: "Payment service unavailable" });
    logOperationalError("Stripe payment recovery failed", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
  }
}
