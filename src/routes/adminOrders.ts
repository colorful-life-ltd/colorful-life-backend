import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { sendApiError } from "../utils/apiErrorResponse.js";
import { AdminOrderIdSchema, AdminOrderQuerySchema } from "../domain/orders/adminOrderValidator.js";
import { getAdminOrder, listAdminOrders } from "../domain/orders/orderReadService.js";

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
export default router;
