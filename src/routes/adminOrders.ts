import { Router, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { sendApiError } from "../utils/apiErrorResponse.js";
import { AdminOrderIdSchema, AdminOrderQuerySchema } from "../domain/orders/adminOrderValidator.js";
import { getAdminOrder, listAdminOrders } from "../domain/orders/orderReadService.js";
import { DispatchShipmentSchema, StartPreparingSchema } from "../domain/fulfilment/fulfilmentValidator.js";
import { dispatchShipment, startPreparing } from "../domain/fulfilment/fulfilmentService.js";
import {
  FulfilmentOrderNotFoundError,
  FulfilmentPaymentNotVerifiedError,
  FulfilmentTransitionError,
  OrderAlreadyDispatchedError,
} from "../domain/fulfilment/fulfilmentErrors.js";
import { sendDispatchNotification } from "../services/emailService.js";

const router = Router();
router.use(authMiddleware, (req, res, next) => {
  if (req.user?.role !== "ADMIN") return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  next();
});
router.get("/", async (req, res) => {
  const query = AdminOrderQuerySchema.safeParse(req.query);
  if (!query.success) return res.status(400).json({ error: query.error.format() });
  try {
    return res.json(await listAdminOrders(query.data));
  } catch (error) {
    console.error("Admin order listing error", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
  }
});
router.get("/:orderId", async (req, res) => {
  const id = AdminOrderIdSchema.safeParse(req.params.orderId);
  if (!id.success) return res.status(400).json({ error: "Invalid order id" });
  if (Object.keys(req.query).length) return res.status(400).json({ error: "Unexpected query parameters" });
  try {
    const order = await getAdminOrder(id.data);
    if (!order) return res.status(404).json({ error: "Order not found" });
    return res.json(order);
  } catch (error) {
    console.error("Admin order read error", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
  }
});
function sendFulfilmentError(res: Response, error: unknown, operation: string) {
  if (error instanceof FulfilmentOrderNotFoundError) return res.status(404).json({ error: "Order not found" });
  if (error instanceof FulfilmentPaymentNotVerifiedError) return sendApiError(res, 409, "ORDER_PAYMENT_NOT_VERIFIED", error.message);
  if (error instanceof FulfilmentTransitionError) return sendApiError(res, 409, "FULFILMENT_TRANSITION_INVALID", error.message);
  if (error instanceof OrderAlreadyDispatchedError) return sendApiError(res, 409, "ORDER_ALREADY_DISPATCHED", error.message);
  console.error(`Admin fulfilment ${operation} error`, error);
  return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
}

// CONFIRMED -> PREPARING. Repeats are idempotent and return the current order.
router.post("/:orderId/fulfilment/preparing", async (req: Request, res: Response) => {
  const id = AdminOrderIdSchema.safeParse(req.params.orderId);
  if (!id.success) return res.status(400).json({ error: "Invalid order id" });
  const body = StartPreparingSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: body.error.format() });
  try {
    await startPreparing(req.user!.id, id.data);
    return res.json(await getAdminOrder(id.data));
  } catch (error) {
    return sendFulfilmentError(res, error, "preparing");
  }
});

// CONFIRMED/PREPARING -> DISPATCHED with one trusted-carrier shipment.
router.post("/:orderId/fulfilment/dispatch", async (req: Request, res: Response) => {
  const id = AdminOrderIdSchema.safeParse(req.params.orderId);
  if (!id.success) return res.status(400).json({ error: "Invalid order id" });
  const body = DispatchShipmentSchema.safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: body.error.format() });
  try {
    const { changed } = await dispatchShipment(req.user!.id, id.data, body.data);
    const order = await getAdminOrder(id.data);
    if (changed && order?.dispatchedAt) {
      try {
        await sendDispatchNotification({
          customerEmail: order.user.email, orderId: order.id, shippingCarrier: body.data.carrierName,
          trackingNumber: body.data.trackingNumber, dispatchedAt: order.dispatchedAt,
        });
      } catch (notificationError) {
        console.error("Dispatch notification error", notificationError instanceof Error ? notificationError.message : "Unknown notification failure");
      }
    }
    return res.json(order);
  } catch (error) {
    return sendFulfilmentError(res, error, "dispatch");
  }
});

export default router;
