import {logOperationalError} from "../utils/operationalLog.js";
import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js";
import { prisma } from "../prisma/runtime.js";

const router = Router();

router.get("/profile", authMiddleware, requireVerifiedEmail, async (req, res) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.json(user);
  } catch (err) {
    logOperationalError("Profile error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
