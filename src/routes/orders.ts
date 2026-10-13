import { prisma } from "../prisma/runtime.js";
import { abandonPaymentReservation } from "../domain/payments/stripeResolutionService.js";
import { PaymentResolutionOwnershipError, PaymentResolutionUnavailableError, databaseNow } from "../domain/payments/paymentResolutionService.js";
import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js";
import {
  createOrderHandler,
  cancelOrderHandler,
  cancelOrderBySellerHandler,
  confirmOrderHandler,
  dispatchOrderHandler,
  completeOrderHandler,
  processOrderReturnHandler,
  authorizeOrderReturnHandler,
  receiveOrderReturnHandler,
  inspectOrderReturnHandler,
  completeOrderReturnHandler,
  cancelOrderReturnHandler,
  listCustomerOrdersHandler,
  getCustomerOrderHandler,
} from "../controllers/orders.js";
import {
  createPaymentHandler,
  listPaymentsHandler,
} from "../controllers/payments.js";
import {
  createRefundHandler,
  listRefundsHandler,
} from "../controllers/refunds.js";
import { createStripePaymentIntentHandler } from "../controllers/stripePaymentController.js";
import { recoverStripePaymentHandler } from "../controllers/stripePaymentRecoveryController.js";
import { createPayPalOrderHandler, capturePayPalOrderHandler } from "../controllers/paypalPaymentController.js";

const router = Router();

router.post("/", authMiddleware, requireVerifiedEmail, createOrderHandler);
router.get("/", authMiddleware, requireVerifiedEmail, listCustomerOrdersHandler);
router.get("/:orderId", authMiddleware, requireVerifiedEmail, getCustomerOrderHandler);
router.post("/:orderId/dispatch", authMiddleware, dispatchOrderHandler);
router.get("/:orderId/payment-resolution", authMiddleware, requireVerifiedEmail, async (req, res) => {
  const id = Number(req.params.orderId);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid order identifier" }); return; }
  try {
    const order = await prisma.order.findFirst({ where: { id, userId: req.user!.id }, select: { paymentResolution: { select: {
      state: true, reservationDisposition: true, initialPaymentDeadline: true, firstFailureVerifiedAt: true,
      retryDeadline: true, paymentAdmissionClosedAt: true,
    } } } });
    if (!order) { res.status(404).json({ error: "Order not found" }); return; }
    res.json({ serverTime: await prisma.$transaction(databaseNow), paymentResolution: order.paymentResolution });
  } catch { res.status(503).json({ error: "Payment resolution unavailable" }); }
});
router.post("/:orderId/abandon", authMiddleware, requireVerifiedEmail, async (req, res) => {
  const id = Number(req.params.orderId);
  if (!Number.isSafeInteger(id) || id <= 0) { res.status(400).json({ error: "Invalid order identifier" }); return; }
  try { res.json(await abandonPaymentReservation(id, req.user!.id)); }
  catch (error) { res.status(error instanceof PaymentResolutionOwnershipError ? 404 : error instanceof PaymentResolutionUnavailableError ? 409 : 503).json({ error: "Payment resolution unavailable or order ineligible" }); }
});
router.post("/:orderId/cancel", authMiddleware, requireVerifiedEmail, cancelOrderHandler);
router.post("/:orderId/seller-cancel", authMiddleware, cancelOrderBySellerHandler);
router.post("/:orderId/confirm", authMiddleware, confirmOrderHandler);
router.post("/:orderId/complete", authMiddleware, completeOrderHandler);
router.post("/:orderId/returns", authMiddleware, requireVerifiedEmail, processOrderReturnHandler);
router.post(
  "/:orderId/returns/:returnId/authorize",
  authMiddleware,
  authorizeOrderReturnHandler,
);
router.post(
  "/:orderId/returns/:returnId/receive",
  authMiddleware,
  receiveOrderReturnHandler,
);
router.post(
  "/:orderId/returns/:returnId/inspect",
  authMiddleware,
  inspectOrderReturnHandler,
);
router.post(
  "/:orderId/returns/:returnId/complete",
  authMiddleware,
  completeOrderReturnHandler,
);
router.post(
  "/:orderId/returns/:returnId/cancel",
  authMiddleware,
  cancelOrderReturnHandler,
);
// Payment routes
router.post("/:orderId/payments", authMiddleware, createPaymentHandler);
router.post("/:orderId/payments/stripe", authMiddleware, requireVerifiedEmail, createStripePaymentIntentHandler);
router.post("/:orderId/payments/stripe/reconcile", authMiddleware, requireVerifiedEmail, recoverStripePaymentHandler);
router.post("/:orderId/payments/paypal", authMiddleware, requireVerifiedEmail, createPayPalOrderHandler);
router.post("/:orderId/payments/paypal/capture", authMiddleware, requireVerifiedEmail, capturePayPalOrderHandler);
router.get("/:orderId/payments", authMiddleware, listPaymentsHandler);
router.post("/:orderId/refunds", authMiddleware, createRefundHandler);
router.get("/:orderId/refunds", authMiddleware, listRefundsHandler);

export default router;
