import { createFbaOutbound, readFbaOutbound } from "../controllers/fbaOutbound.js";
import { Router } from "express";
import { createInventoryAdjustment, reconcileStocktakeInventory } from "../controllers/inventory.js";
import { authMiddleware } from "../middleware/auth.js";

const router = Router();

router.post("/fba-outbounds", authMiddleware, createFbaOutbound);
router.get("/fba-outbounds/:id", authMiddleware, readFbaOutbound);

router.post("/condition-adjustments", authMiddleware, createInventoryAdjustment);
router.post("/stocktakes", authMiddleware, reconcileStocktakeInventory);

export default router;
