import { checkoutProtection } from "../middleware/checkoutProtection.js";
import { registrationOpen } from "../middleware/registrationOpen.js";
import { signupEmailReady } from "../middleware/emailDeliveryReady.js";
import { Router } from "express";
import { signup, login, refreshSession, logout, verifyEmail, resendVerification, forgotPassword, resetPasswordHandler } from "../controllers/authController.js";

import { passwordRecoveryLimit } from "../middleware/passwordRecoveryLimit.js";

const router = Router();

router.post("/signup", registrationOpen, signupEmailReady, checkoutProtection("signup"), signup);
router.post("/login", checkoutProtection("login"), login);
router.post("/refresh", refreshSession);
router.post("/logout", logout);
router.post("/verify-email", passwordRecoveryLimit("verify-token"), verifyEmail);
router.post("/resend-verification", passwordRecoveryLimit("verify"), resendVerification);
router.post("/forgot-password", passwordRecoveryLimit("forgot"), forgotPassword);
router.post("/reset-password", passwordRecoveryLimit("reset"), resetPasswordHandler);

export default router;
