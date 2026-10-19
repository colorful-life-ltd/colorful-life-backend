import {logOperationalError} from "../utils/operationalLog.js";
import { Router, type NextFunction, type Request, type Response } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js";
import {
  getPurchaseAnalyticsSummary,
  getSupplierMonthlyPurchaseAnalytics,
  InvalidPurchaseAnalyticsSupplierKeyError,
  PurchaseAnalyticsSupplierNotFoundError,
} from "../domain/purchases/purchaseAnalytics.js";
import { sendApiError } from "../utils/apiErrorResponse.js";

const router = Router();

const adminOnly = (req: Request, res: Response, next: NextFunction) => {
  if (req.user?.role !== "ADMIN") return sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only");
  next();
};

router.use(authMiddleware, adminOnly, requireVerifiedEmail);

router.get("/", async (_req, res) => {
  try {
    res.json(await getPurchaseAnalyticsSummary());
  } catch (error) {
    logOperationalError("Purchase analytics summary failed", error);
    sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Purchase analytics could not be retrieved");
  }
});

router.get("/suppliers/:supplierKey/monthly", async (req, res) => {
  try {
    res.json(await getSupplierMonthlyPurchaseAnalytics(req.params.supplierKey));
  } catch (error) {
    if (error instanceof InvalidPurchaseAnalyticsSupplierKeyError) {
      sendApiError(res, 400, "INVALID_SUPPLIER_KEY", error.message);
      return;
    }
    if (error instanceof PurchaseAnalyticsSupplierNotFoundError) {
      sendApiError(res, 404, "PURCHASE_ANALYTICS_SUPPLIER_NOT_FOUND", error.message);
      return;
    }
    logOperationalError("Supplier purchase analytics failed", error);
    sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Purchase analytics could not be retrieved");
  }
});

export default router;
