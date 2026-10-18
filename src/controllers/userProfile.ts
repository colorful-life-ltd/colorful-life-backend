import {logOperationalError} from "../utils/operationalLog.js";
import { ReauthenticationRequired } from "../domain/auth/reauthentication.js";
import { Request, Response } from "express";
import { prisma } from "../prisma/runtime.js";
import { Prisma } from "../generated/prisma-client/client.js";
import { z } from "zod";
import { changeEmailSchema } from "../utils/authValidation.js";
import { changeUnverifiedUserEmail } from "../domain/auth/emailChangeService.js";
import { EmailChangeDuplicateEmailError, EmailChangeSameEmailError, EmailChangeUserNotFoundError, EmailChangeVerifiedUserError } from "../domain/auth/emailChangeErrors.js";
import { config } from "../config/index.js";
import { sendVerificationEmail } from "../services/emailService.js";

// ----- Zod validation for PATCH /users/me -----
const UpdateProfileSchema = z.object({
  firstName: z.string().trim().min(1, { message: "firstName cannot be empty" }).optional(),
  lastName: z.string().trim().min(1, { message: "lastName cannot be empty" }).optional(),
  phone: z.string().trim().optional(),
}).refine((data) => Object.keys(data).length > 0, {
  message: "No fields provided for update",
});

// ----- GET /users/me -----
export const getCurrentUserProfile = async (req: Request, res: Response) => {
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
        firstName: true,
        lastName: true,
        phone: true,
      },
    });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    return res.json(user);
  } catch (err) {
    logOperationalError("Get current user profile error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

// ----- PATCH /users/me -----
export const updateCurrentUserProfile = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const parseResult = UpdateProfileSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }
  const { firstName, lastName, phone } = parseResult.data;
  const updateData: Prisma.UserUpdateInput = {};
  if (firstName !== undefined) updateData.firstName = firstName;
  if (lastName !== undefined) updateData.lastName = lastName;
  if (phone !== undefined) updateData.phone = phone;
  try {
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        phone: true,
      },
    });
    return res.json(updatedUser);
  } catch (err) {
    logOperationalError("Update user profile error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};

export const changeCurrentUserEmail = async (req: Request, res: Response) => {
  const userId = req.user?.id;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  const parseResult = changeEmailSchema.safeParse(req.body);
  if (!parseResult.success) return res.status(400).json({ error: parseResult.error.format() });

  try {
    const result = await changeUnverifiedUserEmail(userId, parseResult.data.email, new Date(), parseResult.data.password);
    const verificationUrl = `${config.FRONTEND_URL}/verify-email?token=${encodeURIComponent(result.rawToken)}`;
    try {
      await sendVerificationEmail({ recipientEmail: result.email, verificationUrl });
    } catch (emailError) {
      logOperationalError("Verification email delivery failed", emailError);
    }
    return res.status(200).json({ message: "Email updated. Please verify your new email address." });
  } catch (err: unknown) {
    if(err instanceof ReauthenticationRequired)return res.status(403).json({error:"REAUTHENTICATION_REQUIRED"});
    if (err instanceof EmailChangeUserNotFoundError) return res.status(404).json({ error: err.message });
    if (err instanceof EmailChangeSameEmailError || err instanceof EmailChangeVerifiedUserError) return res.status(400).json({ error: err.message });
    if (err instanceof EmailChangeDuplicateEmailError) return res.status(409).json({ error: err.message });
    logOperationalError("Email change error", err);
    return res.status(500).json({ error: "Internal server error" });
  }
};
