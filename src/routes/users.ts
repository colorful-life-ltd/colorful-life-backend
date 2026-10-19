import {checkoutProtection} from "../middleware/checkoutProtection.js";
import { changePassword } from "../controllers/passwordChange.js";
import { Router } from "express";
import { authMiddleware } from "../middleware/auth.js";
import { requireVerifiedEmail } from "../middleware/requireVerifiedEmail.js";
import { getCurrentUserProfile, updateCurrentUserProfile, changeCurrentUserEmail } from "../controllers/userProfile.js";
import {
  getAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
  lookupAddresses,
} from "../controllers/addressController.js";
import { deleteCurrentUserAccount } from "../controllers/accountDeletionController.js";

const router = Router();

router.get("/me", authMiddleware, requireVerifiedEmail, getCurrentUserProfile);
router.patch("/me", authMiddleware, requireVerifiedEmail, updateCurrentUserProfile);
router.patch("/me/email", authMiddleware, checkoutProtection("recovery"), changeCurrentUserEmail);
router.post("/me/password", authMiddleware, checkoutProtection("recovery"), changePassword);
router.delete("/me", authMiddleware, checkoutProtection("recovery"), deleteCurrentUserAccount);
// Address management endpoints
router.get("/me/addresses/lookup", authMiddleware, requireVerifiedEmail, lookupAddresses);
router.get("/me/addresses", authMiddleware, requireVerifiedEmail, getAddresses);
router.post("/me/addresses", authMiddleware, requireVerifiedEmail, createAddress);
router.patch("/me/addresses/:addressId", authMiddleware, requireVerifiedEmail, updateAddress);
router.delete("/me/addresses/:addressId", authMiddleware, requireVerifiedEmail, deleteAddress);

export default router;
