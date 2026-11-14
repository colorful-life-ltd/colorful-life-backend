import {logOperationalError} from "../utils/operationalLog.js";
import { sendProtectionError } from "../middleware/checkoutProtection.js";
import { setTimeout as delay } from "node:timers/promises";
import { randomBytes } from "node:crypto";
import { Request, Response } from "express";
import { registrationSchema, loginSchema, verifyEmailSchema, forgotPasswordSchema, resetPasswordSchema } from "../utils/authValidation.js";
import bcrypt from "bcrypt";
import jwt, { type SignOptions } from "jsonwebtoken";
import { Prisma } from "../generated/prisma-client/client.js";
import { prisma } from "../prisma/runtime.js";
import { config } from "../config/index.js";
import { createOrReplaceEmailVerificationToken, restoreReplacedEmailVerificationToken, verifyEmailVerificationToken } from "../domain/auth/emailVerificationService.js";
import { classifySesError } from "../domain/orderConfirmation/delivery.js";
import { InvalidOrExpiredVerificationTokenError } from "../domain/auth/emailVerificationErrors.js";
import { sendVerificationEmail } from "../services/emailService.js";
import { sendPasswordResetEmail } from "../services/emailService.js";
import { emailCredentialReadiness } from "../services/sesRuntime.js";
import { sendEmailUnavailable } from "../middleware/emailDeliveryReady.js";
import { createOrReplacePasswordResetToken } from "../domain/auth/passwordResetService.js";
import { resetPassword } from "../domain/auth/passwordResetService.js";
import { InvalidOrExpiredPasswordResetTokenError } from "../domain/auth/passwordResetErrors.js";
import { sendApiError } from "../utils/apiErrorResponse.js";
import {
  createRefreshSession,
  InvalidRefreshSessionError,
  revokeRefreshSession,
  rotateRefreshSession,
  type RefreshSessionUser,
} from "../domain/auth/refreshSessionService.js";

// Public dummy hash, never an account credential; absent accounts still perform bcrypt work.
const DUMMY_LOGIN_HASH = "$2b$12$3nZrxbFbXyf62sW1/ZgQ.O44bjJHseudB4lTWVEs5/geqipBrrNNq";

const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function issueAccessToken(user: Pick<RefreshSessionUser, "id" | "role" | "credentialVersion">) {
  const token = jwt.sign(
    { id: user.id, role: user.role, credentialVersion: user.credentialVersion ?? null },
    config.JWT_SECRET,
    { expiresIn: config.JWT_EXPIRES_IN } as SignOptions,
  );
  const payload = jwt.decode(token);
  if (!payload || typeof payload === "string" || typeof payload.exp !== "number") {
    throw new Error("Configured access token has no expiry");
  }
  return { token, accessTokenExpiresAt: new Date(payload.exp * 1000).toISOString() };
}

function parseRefreshToken(req: Request, res: Response): string | null {
  const value = req.body?.refreshToken;
  if (value === undefined || value === null || value === "") {
    sendApiError(res, 401, "AUTH_REQUIRED", "Refresh token is required");
    return null;
  }
  if (typeof value !== "string" || !REFRESH_TOKEN_PATTERN.test(value)) {
    sendApiError(res, 401, "SESSION_INVALID", "Invalid or expired token");
    return null;
  }
  return value;
}

type RefreshRotation = typeof rotateRefreshSession;
let rotateSession: RefreshRotation = rotateRefreshSession;

export function setRefreshSessionRotationForTests(testRotation: RefreshRotation): () => void {
  const previous = rotateSession;
  rotateSession = testRotation;
  return () => { rotateSession = previous; };
}


export const signup = async (req: Request, res: Response) => {
  const parseResult = registrationSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }
  const started = performance.now();
  const generic = { message: "If registration is available for this address, check your email for next steps." };
  const finish = async () => { await delay(Math.max(0, 1500 - (performance.now() - started))); return res.status(202).json(generic); };
  const { email } = parseResult.data;
  // `email` is already normalized by the Zod schema via trim+lowercase
  const normalizedEmail = email;
  try {
    // Signup does not establish a credential. Even an older verifier that only
    // flips emailVerified cannot activate the password supplied by a stranger.
    const hashedPassword = await bcrypt.hash(randomBytes(32).toString("hex"), 12);
    const persistence = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          passwordHash: hashedPassword,
        },
      });
      const verification = await createOrReplaceEmailVerificationToken(
        user.id,
        new Date(),
        tx,
      );
      return { user, verification };
    });
    const { user, verification } = persistence;
    if (verification.created) {
      const verificationUrl = `${config.FRONTEND_URL}/verify-email?token=${encodeURIComponent(verification.rawToken)}`;
      // Delivery runs after the same response deadline for new and existing addresses.
      // Failures are logged without exposing account existence to the requester.
      void sendVerificationEmail({ recipientEmail: user.email, verificationUrl }).catch(error => logOperationalError("Verification email delivery failed", error));
    }
    return finish();
   } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002" && err.meta?.modelName === "User") return finish();

     logOperationalError("Signup error", err);
     return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
   }
};

export const login = async (req: Request, res: Response) => {
  const parseResult = loginSchema.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: parseResult.error.format() });
  }
  const { email, password } = parseResult.data;
  const normalizedEmail = email;
  try {
    const user = await prisma.user.findFirst({ where: { email: normalizedEmail, deletedAt: null } });
    const passwordMatches = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_LOGIN_HASH);
    if (!user || !passwordMatches || !user.emailVerified) {
      return sendApiError(res, 401, "INVALID_CREDENTIALS", "Invalid credentials");
    }
    const issued = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: user.id } });
      if (!current || current.deletedAt !== null || !current.emailVerified || current.passwordHash !== user.passwordHash) return null;
      return { accessToken: issueAccessToken(current), refreshSession: await createRefreshSession(current.id, new Date(), tx) };
    });
    if (!issued) return sendApiError(res, 401, "INVALID_CREDENTIALS", "Invalid credentials");
    const { accessToken, refreshSession } = issued;
    return res.json({
      ...accessToken,
      ...refreshSession,
      refreshExpiresAt: refreshSession.refreshExpiresAt.toISOString(),
    });
  } catch (err) {
    logOperationalError("Login error", err);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
  }
};

export const refreshSession = async (req: Request, res: Response) => {
  const refreshToken = parseRefreshToken(req, res);
  if (!refreshToken) return;
  try {
    const rotated = await rotateSession(refreshToken, issueAccessToken);
    return res.status(200).json({
      ...rotated.accessToken,
      refreshToken: rotated.refreshToken,
      refreshExpiresAt: rotated.refreshExpiresAt.toISOString(),
    });
  } catch (error) {
    if (sendProtectionError(res, error)) return;
    if (error instanceof InvalidRefreshSessionError) {
      return sendApiError(res, 401, "SESSION_INVALID", "Invalid or expired token");
    }
    logOperationalError("Refresh session error", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
  }
};

export const logout = async (req: Request, res: Response) => {
  const refreshToken = parseRefreshToken(req, res);
  if (!refreshToken) return;
  try {
    await revokeRefreshSession(refreshToken);
    return res.status(204).send();
  } catch (error) {
    logOperationalError("Refresh session revocation error", error);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
  }
};

export const verifyEmail = async (req: Request, res: Response) => {
  const parseResult = verifyEmailSchema.safeParse(req.body);
  if (!parseResult.success) return res.status(400).json({ error: parseResult.error.format() });
  try {
    await verifyEmailVerificationToken(parseResult.data.token, parseResult.data.newPassword);
    return res.status(200).json({ message: "Email verified successfully" });
  } catch (err) {
    if (err instanceof InvalidOrExpiredVerificationTokenError) {
      return res.status(400).json({ error: "Invalid or expired verification token" });
    }
    logOperationalError("Email verification error", err);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
  }
};

export const resendVerification = async (req: Request, res: Response) => {
  const started: number = res.locals?.passwordRecoveryStartedAt ?? performance.now();
  const parsed = forgotPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.format() });
  const generic = { message: "If verification is needed, check your email for next steps." };
  try {
    if ((await emailCredentialReadiness("account")).ready) {
      const user = await prisma.user.findFirst({ where: { email: parsed.data.email, deletedAt: null }, select: { id: true, email: true, emailVerified: true } });
      if (user && !user.emailVerified) {
        const verification = await createOrReplaceEmailVerificationToken(user.id, new Date(), undefined, user.email);
        if (verification.created) {
          const verificationUrl = `${config.FRONTEND_URL}/verify-email?token=${encodeURIComponent(verification.rawToken)}`;
          void sendVerificationEmail({ recipientEmail: user.email, verificationUrl }).catch(async error => {
            logOperationalError("Verification email delivery failed", error);
            if (classifySesError(error)) {
              try { await restoreReplacedEmailVerificationToken(user.id, verification.rawToken, verification.previous); }
              catch (restoreError) { logOperationalError("Verification token restore failed", restoreError); }
            }
          });
        }
      }
    }
  } catch (error) { logOperationalError("Verification resend unavailable", error); }
  await delay(Math.max(0, 2000 - (performance.now() - started)));
  return res.status(200).json(generic);
};

export const forgotPassword = async (req: Request, res: Response) => {
  const started: number = res.locals?.passwordRecoveryStartedAt ?? performance.now();
  const waitForResponse = () => delay(Math.max(0, 2000 - (performance.now() - started)));
  const parseResult = forgotPasswordSchema.safeParse(req.body);
  if (!parseResult.success) return res.status(400).json({ error: parseResult.error.format() });
  const genericResponse = { message: "If an account exists, a password reset email has been sent" };
  try {
    // Checked before the account lookup and answered identically, so availability cannot
    // be used for enumeration. Skipping keeps any previously emailed reset link valid.
    if (!(await emailCredentialReadiness("account")).ready) {
      logOperationalError("Password reset email unavailable");
      await waitForResponse();
      return res.status(200).json(genericResponse);
    }
    const user = await prisma.user.findUnique({
      where: { email: parseResult.data.email, deletedAt: null },
      select: { id: true, email: true },
    });
    if (!user) {
      await waitForResponse();
      return res.status(200).json(genericResponse);
    }

    const reset = await createOrReplacePasswordResetToken(user.id, new Date(), parseResult.data.email);
    const resetUrl = `${config.FRONTEND_URL}/reset-password?token=${encodeURIComponent(reset.rawToken)}`;
    try {
      await sendPasswordResetEmail({ recipientEmail: user.email, resetUrl });
    } catch (emailError) {
      logOperationalError("Password reset email delivery failed", emailError);
    }
    await waitForResponse();
    return res.status(200).json(genericResponse);
  } catch (err) {
    logOperationalError("Forgot password failed", err);
    await waitForResponse();
    return res.status(200).json(genericResponse);
  }
};

export const resetPasswordHandler = async (req: Request, res: Response) => {
  const parseResult = resetPasswordSchema.safeParse(req.body);
  if (!parseResult.success) return res.status(400).json({ error: parseResult.error.format() });
  try {
    await resetPassword(parseResult.data.token, parseResult.data.newPassword);
    return res.status(200).json({ message: "Password reset successfully" });
  } catch (err) {
    if (err instanceof InvalidOrExpiredPasswordResetTokenError) {
      return res.status(400).json({ error: "Invalid or expired password reset token" });
    }
    logOperationalError("Password reset failed", err);
    return sendApiError(res, 500, "INTERNAL_SERVER_ERROR", "Internal server error");
  }
};
