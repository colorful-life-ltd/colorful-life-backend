import {logOperationalError} from "../utils/operationalLog.js";
import { sendProtectionError } from "../middleware/checkoutProtection.js";
import { PaymentAdmissionClosedError, PaymentResolutionUnavailableError } from "../domain/payments/paymentResolutionService.js";
import { sendApiError } from "../utils/apiErrorResponse.js";
import type { Request, Response } from "express";
import { createOrReuseStripePaymentIntent, StripePaymentAlreadyCompletedError, StripePaymentExpiredError, StripePaymentOrderNotFoundError, StripePaymentOwnershipError, StripePaymentProviderError, StripePaymentNotPayableError } from "../domain/payments/stripePaymentService.js";

export async function createStripePaymentIntentHandler(req: Request, res: Response) {
  const orderId = Number(req.params.orderId);
  if (!Number.isInteger(orderId) || orderId < 1) return res.status(400).json({ error: "Invalid order id" });
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const result = await createOrReuseStripePaymentIntent(orderId, userId);
    return res.status(201).json({ clientSecret: result.clientSecret });
  } catch (error) { if (sendProtectionError(res, error)) return;
    if (error instanceof PaymentAdmissionClosedError) return sendApiError(res, 409, "PAYMENT_ADMISSION_CLOSED", "Payment admission window is closed");
    if (error instanceof PaymentResolutionUnavailableError) return sendApiError(res, 409, "PAYMENT_OUTCOME_UNRESOLVED", "A prior payment operation requires resolution");
    if (error instanceof StripePaymentOrderNotFoundError || error instanceof StripePaymentOwnershipError) return res.status(404).json({ error: "Order not found" });
    if (error instanceof StripePaymentExpiredError) return sendApiError(res, 409, "ORDER_EXPIRED", "Order reservation has expired");
    if (error instanceof StripePaymentAlreadyCompletedError) return sendApiError(res, 409, "PAYMENT_ALREADY_COMPLETED", "Order already has a completed payment or another provider");
    if (error instanceof StripePaymentNotPayableError) return sendApiError(res, 409, "ORDER_NOT_PAYABLE", "Only a PENDING order can initiate checkout payment");
    if (error instanceof StripePaymentProviderError) return res.status(503).json({ error: "Payment service unavailable" });
    logOperationalError("Stripe payment initiation error", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
