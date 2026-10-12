import type { Request, Response } from "express";
import { createOrReusePayPalOrder, PayPalOrderAlreadyCompletedError, PayPalOrderExpiredError, PayPalOrderNotFoundError, PayPalOrderOwnershipError, PayPalProviderError } from "../domain/payments/paypalOrderService.js";
import { capturePayPalOrder, PayPalCaptureAlreadyCompletedError, PayPalCaptureCancelledError, PayPalCaptureExpiredError, PayPalCaptureMismatchError, PayPalCaptureOrderNotFoundError, PayPalCaptureOwnershipError, PayPalCapturePaymentNotFoundError, PayPalCaptureProviderError, PayPalCaptureWrongProviderError } from "../domain/payments/paypalCaptureService.js";

export async function createPayPalOrderHandler(req: Request, res: Response) {
  const orderId = Number(req.params.orderId); const userId = req.user?.id;
  if (!Number.isInteger(orderId) || orderId < 1) return res.status(400).json({ error: "Invalid order id" });
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try { const result = await createOrReusePayPalOrder(orderId, userId); return res.status(201).json({ paypalOrderId: result.paypalOrderId, ...(result.approvalUrl ? { approvalUrl: result.approvalUrl } : {}) }); }
  catch (error) { if (error instanceof PayPalOrderNotFoundError || error instanceof PayPalOrderOwnershipError) return res.status(404).json({ error: "Order not found" }); if (error instanceof PayPalOrderExpiredError || error instanceof PayPalOrderAlreadyCompletedError) return res.status(409).json({ error: "Order is not payable" }); if (error instanceof PayPalProviderError) return res.status(503).json({ error: "Payment service unavailable" }); console.error("PayPal order initiation error", error); return res.status(500).json({ error: "Internal server error" }); }
}

export async function capturePayPalOrderHandler(req: Request, res: Response) {
  const orderId = Number(req.params.orderId); const userId = req.user?.id;
  if (!Number.isInteger(orderId) || orderId < 1) return res.status(400).json({ error: "Invalid order id" });
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try { const result = await capturePayPalOrder(orderId, userId); return res.status(200).json({ paypalOrderId: result.paypalOrderId, captureId: result.captureId }); }
  catch (error) { if (error instanceof PayPalCaptureOrderNotFoundError || error instanceof PayPalCaptureOwnershipError || error instanceof PayPalCapturePaymentNotFoundError) return res.status(404).json({ error: "Order not found" }); if (error instanceof PayPalCaptureCancelledError || error instanceof PayPalCaptureExpiredError || error instanceof PayPalCaptureAlreadyCompletedError || error instanceof PayPalCaptureWrongProviderError || error instanceof PayPalCaptureMismatchError) return res.status(409).json({ error: "Order is not payable" }); if (error instanceof PayPalCaptureProviderError) return res.status(503).json({ error: "Payment service unavailable" }); console.error("PayPal capture error", error); return res.status(500).json({ error: "Internal server error" }); }
}
