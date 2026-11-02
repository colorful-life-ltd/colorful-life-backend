import { Router, type Request, type Response } from "express";
import bcrypt from "bcrypt";
import { Prisma } from "../generated/prisma-client/client.js";
import { prisma } from "../prisma/runtime.js";
import { signupSchema } from "../utils/authValidation.js";
import { sendApiError } from "../utils/apiErrorResponse.js";
import { checkoutProtection } from "../middleware/checkoutProtection.js";
import { logOperationalError } from "../utils/operationalLog.js";
import { BootstrapAuthorizationStore } from "../domain/auth/bootstrapAuthorization.js";
import { createOrReplaceEmailVerificationToken } from "../domain/auth/emailVerificationService.js";
import { sendVerificationEmail } from "../services/emailService.js";
import { config } from "../config/index.js";

const router = Router();
const authorizations = new BootstrapAuthorizationStore();

async function adminExists(): Promise<boolean> {
  return (await prisma.user.count({ where: { role: "ADMIN" } })) > 0;
}

router.get("/status", async (_req, res) => {
  try {
    const exists = await adminExists();
    res.setHeader("Cache-Control", "no-store");
    return res.json({ registrationAvailable: !exists });
  } catch {
    return sendApiError(res, 503, "BOOTSTRAP_UNAVAILABLE", "Administrator setup status is unavailable.");
  }
});

// This path is separately restricted by the existing owner-IP Nginx include.
// The short-lived challenge exists only in API process memory and is never logged.
router.post("/authorization", checkoutProtection("login"), async (req, res) => {
  try {
    if (await adminExists()) return sendApiError(res, 409, "BOOTSTRAP_CLOSED", "Administrator setup is already complete.");
    const token = authorizations.issue(req.ip ?? req.socket.remoteAddress ?? "unknown");
    if (!token) return sendApiError(res, 503, "BOOTSTRAP_UNAVAILABLE", "Administrator setup is temporarily unavailable.");
    res.setHeader("Cache-Control", "no-store");
    return res.json({ authorization: token, expiresInSeconds: 300 });
  } catch {
    return sendApiError(res, 503, "BOOTSTRAP_UNAVAILABLE", "Administrator setup is temporarily unavailable.");
  }
});

router.post("/register", checkoutProtection("login"), async (req, res) => {
  const parsed = signupSchema.safeParse({ email: req.body?.email, password: req.body?.password });
  const authorization = req.get("X-Admin-Bootstrap-Authorization") ?? "";
  if (!parsed.success || !/^[A-Za-z0-9_-]{43}$/.test(authorization)) {
    return sendApiError(res, 400, "INVALID_REGISTRATION", "Enter a valid email and password.");
  }
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
  if (!authorizations.consume(authorization, ip)) {
    return sendApiError(res, 403, "BOOTSTRAP_AUTHORIZATION_INVALID", "Setup authorization expired. Start administrator registration again.");
  }
  // Authorization is consumed before database work, so failed attempts cannot replay it.
  try {
    const passwordHash = await bcrypt.hash(parsed.data.password, 12);
    const created = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('colorful-life-single-admin-bootstrap', 0))`;
      const count = await tx.user.count({ where: { role: "ADMIN" } });
      if (count !== 0) throw new Error("BOOTSTRAP_CLOSED");
      if (await tx.user.findUnique({ where: { email: parsed.data.email }, select: { id: true } })) throw new Error("BOOTSTRAP_EMAIL_IN_USE");
      const user = await tx.user.create({ data: { email: parsed.data.email, passwordHash, role: "ADMIN" } });
      const verification = await createOrReplaceEmailVerificationToken(user.id, new Date(), tx);
      return { user, verification };
    });
    if (created.verification.created) {
      const verificationUrl = `${config.FRONTEND_URL}/verify-email?token=${encodeURIComponent(created.verification.rawToken)}`;
      try { await sendVerificationEmail({ recipientEmail: created.user.email, verificationUrl }); }
      catch (error) { logOperationalError("Administrator verification email delivery failed", error); }
    }
    res.setHeader("Cache-Control", "no-store");
    return res.status(201).json({ registered: true, verificationRequired: true });
  } catch (error) {
    if (error instanceof Error && error.message === "BOOTSTRAP_CLOSED") return sendApiError(res, 409, "BOOTSTRAP_CLOSED", "Administrator setup is already complete.");
    if (error instanceof Error && error.message === "BOOTSTRAP_EMAIL_IN_USE") return sendApiError(res, 409, "INVALID_REGISTRATION", "That email is already associated with an account.");
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return sendApiError(res, 409, "INVALID_REGISTRATION", "Registration conflicts with an existing account or completed setup.");
    logOperationalError("Administrator bootstrap failed", error);
    return sendApiError(res, 503, "BOOTSTRAP_UNAVAILABLE", "Administrator setup could not be completed. Request a new authorization and try again.");
  }
});

export default router;
