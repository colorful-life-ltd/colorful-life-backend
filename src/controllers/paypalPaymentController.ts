import { sendProtectionError } from "../middleware/checkoutProtection.js";
import { PaymentAdmissionClosedError, PaymentResolutionUnavailableError } from "../domain/payments/paymentResolutionService.js";
import type { Request, Response } from "express";
import { sendApiError } from "../utils/apiErrorResponse.js";
import { capturePayPalOrder, PayPalCaptureAlreadyCompletedError, PayPalCaptureCancelledError, PayPalCaptureExpiredError, PayPalCaptureMismatchError, PayPalCaptureOrderNotFoundError, PayPalCaptureOwnershipError, PayPalCapturePaymentNotFoundError, PayPalCaptureProviderError, PayPalCaptureWrongProviderError } from "../domain/payments/paypalCaptureService.js";

export async function createPayPalOrderHandler(req: Request, res: Response) {
  const orderId = Number(req.params.orderId); const userId = req.user?.id;
  if (!Number.isInteger(orderId) || orderId < 1) return res.status(400).json({ error: "Invalid order id" });
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  // PayPal checkout is unsupported. Keep this unconditional and before any
  // service call: a pending payment can prevent reservation expiry indefinitely.
  return sendApiError(res, 503, "PAYPAL_INITIATION_DISABLED", "PayPal checkout is currently unavailable");
}

export async function capturePayPalOrderHandler(req: Request, res: Response) {
  const orderId = Number(req.params.orderId); const userId = req.user?.id;
  if (!Number.isInteger(orderId) || orderId < 1) return res.status(400).json({ error: "Invalid order id" });
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try { const result = await capturePayPalOrder(orderId, userId); return res.status(200).json({ paypalOrderId: result.paypalOrderId, captureId: result.captureId }); }
  catch (error) { if (sendProtectionError(res, error)) return; if (error instanceof PaymentAdmissionClosedError || error instanceof PaymentResolutionUnavailableError) return res.status(409).json({ error: "Payment admission is closed or a prior operation requires resolution" }); if (error instanceof PayPalCaptureOrderNotFoundError || error instanceof PayPalCaptureOwnershipError || error instanceof PayPalCapturePaymentNotFoundError) return res.status(404).json({ error: "Order not found" }); if (error instanceof PayPalCaptureCancelledError || error instanceof PayPalCaptureExpiredError || error instanceof PayPalCaptureAlreadyCompletedError || error instanceof PayPalCaptureWrongProviderError || error instanceof PayPalCaptureMismatchError) return res.status(409).json({ error: "Order is not payable" }); if (error instanceof PayPalCaptureProviderError) return res.status(503).json({ error: "Payment service unavailable" }); console.error("PayPal capture error", error); return res.status(500).json({ error: "Internal server error" }); }
}
