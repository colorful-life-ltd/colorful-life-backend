import {logOperationalError} from "../utils/operationalLog.js";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { authMiddleware } from "../middleware/auth.js";
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js";
import { ReviewError, getPurchaseReview, amendReviewLine, resolveReviewGroup, setReviewGroupDisposition, receiveReviewGroup } from "../domain/purchases/purchaseReview.js";
import { ValidationError } from "../domain/purchases/purchaseImport.js";
import { purchaseListingsRouter } from "./purchaseListings.js";
import { sendApiError } from "../utils/apiErrorResponse.js";

export const purchaseReviewRouter = Router({ mergeParams: true });
purchaseReviewRouter.use(authMiddleware, requireVerifiedEmail, (req, res, next) => {
  if (req.user?.role !== "ADMIN") { sendApiError(res, 403, "FORBIDDEN", "Forbidden: ADMIN only"); return; }
  next();
});
purchaseReviewRouter.use(purchaseListingsRouter);
for (const [method, path, action] of [
  ["get", "/", getPurchaseReview],
  ["patch", "/items/:itemId", amendReviewLine],
  ["patch", "/groups/:itemId/listing", resolveReviewGroup],
  ["patch", "/groups/:itemId/disposition", setReviewGroupDisposition],
  ["post", "/groups/:itemId/receive", receiveReviewGroup],
] as const) {
  purchaseReviewRouter[method](path, async (req: Request, res: Response) => {
    try {
      const purchaseId = z.coerce.number().int().positive().parse(req.params.id);
      const itemId = method === "get" ? 0 : z.coerce.number().int().positive().parse(req.params.itemId);
      res.json(await action(req.user!.id, purchaseId, itemId, req.body));
    } catch (error) {
      if (error instanceof z.ZodError) { res.status(400).json({ error: "Invalid purchase review input", details: error.flatten() }); return; }
      if (error instanceof ReviewError) { res.status(error.status).json({ error: error.message }); return; }
      if (error instanceof ValidationError) { res.status(400).json({ error: error.message }); return; }
      logOperationalError("Purchase review failed", error);
      res.status(500).json({ error: "Purchase review could not be completed" });
    }
  });
}
