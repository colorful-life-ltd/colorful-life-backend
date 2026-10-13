import { Router } from "express";
import { signup, login, refreshSession, logout, verifyEmail, resendVerification, forgotPassword, resetPasswordHandler } from "../controllers/authController.js";
import { authMiddleware } from "../middleware/auth.js";

import { passwordRecoveryLimit } from "../middleware/passwordRecoveryLimit.js";

const router = Router();

router.post("/signup", signup);
router.post("/login", login);
router.post("/refresh", refreshSession);
router.post("/logout", logout);
router.post("/verify-email", verifyEmail);
router.post("/resend-verification", authMiddleware, resendVerification);
router.post("/forgot-password", passwordRecoveryLimit("forgot"), forgotPassword);
router.post("/reset-password", passwordRecoveryLimit("reset"), resetPasswordHandler);

export default router;
