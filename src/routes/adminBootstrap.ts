import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
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
import { adminBootstrapMode, type AdminBootstrapMode } from "../config/adminBootstrap.js";
import { activeRegistrationArming, FIRST_ADMIN_REGISTRATION_WINDOW_SECONDS } from "../domain/auth/firstAdminRegistrationArming.js";

async function adminExists(): Promise<boolean> {
  return (await prisma.user.count({ where: { role: "ADMIN" } })) > 0;
}

// Any of these means the request passed through a proxy (the public Nginx always sets X-Forwarded-For).
const PROXY_HEADERS = ["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "via"];
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/** A direct loopback request (the owner's SSM port forward), never one relayed by Nginx or any proxy. */
export function privateBootstrapRequest(req: Request): boolean {
  return !PROXY_HEADERS.some((name) => req.headers[name] !== undefined) && LOOPBACK_HOST.test(req.headers.host ?? "");
}

export type AdminBootstrapRouterOptions = { authorizations?: BootstrapAuthorizationStore; armingWindowSeconds?: number };

/**
 * First-Administrator HTTP registration.
 * - `closed`: every route fails closed without touching the database.
 * - `open` (development, opted-in staging): the original flow; the account verifies its email.
 * - `private` (Production): only a direct loopback request, only while the owner's host-side arming
 *   window is open and no ADMIN exists. The account is created verified on the owner's attestation
 *   (no email is sent) with a FIRST_ADMIN_BOOTSTRAP audit row. Ordinary signup is unaffected.
 * `true`/`false` are accepted as `open`/`closed` for existing callers.
 */
export function createAdminBootstrapRouter(modeOrEnabled: AdminBootstrapMode | boolean = adminBootstrapMode(process.env), options: AdminBootstrapRouterOptions = {}) {
  const mode: AdminBootstrapMode = modeOrEnabled === true ? "open" : modeOrEnabled === false ? "closed" : modeOrEnabled;
  const router = Router();
  if (mode === "private") return privateRouter(router, options);
  if (mode === "closed") {
    router.get("/status", (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      return res.json({ registrationAvailable: false });
    });
    router.post(["/authorization", "/register"], (_req, res) =>
      sendApiError(res, 403, "BOOTSTRAP_DISABLED", "Administrator setup is not available in this environment."));
    return router;
  }
  const authorizations = options.authorizations ?? new BootstrapAuthorizationStore();

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

  return router;
}

function privateRouter(router: Router, options: AdminBootstrapRouterOptions) {
  const authorizations = options.authorizations ?? new BootstrapAuthorizationStore();
  const windowSeconds = options.armingWindowSeconds ?? FIRST_ADMIN_REGISTRATION_WINDOW_SECONDS;
  const notPrivate = (res: Response) =>
    sendApiError(res, 403, "BOOTSTRAP_DISABLED", "Administrator setup is not available in this environment.");

  router.get("/status", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    // Proxied (public) callers learn nothing and cause no database read.
    if (!privateBootstrapRequest(req)) return res.json({ registrationAvailable: false });
    try {
      const available = !(await adminExists()) && (await activeRegistrationArming(prisma, windowSeconds)) !== null;
      return res.json({ registrationAvailable: available });
    } catch {
      return sendApiError(res, 503, "BOOTSTRAP_UNAVAILABLE", "Administrator setup status is unavailable.");
    }
  });

  router.post("/authorization", checkoutProtection("login"), async (req, res) => {
    if (!privateBootstrapRequest(req)) return notPrivate(res);
    try {
      if (await adminExists()) return sendApiError(res, 409, "BOOTSTRAP_CLOSED", "Administrator setup is already complete.");
      if ((await activeRegistrationArming(prisma, windowSeconds)) === null)
        return sendApiError(res, 403, "BOOTSTRAP_NOT_ARMED", "Administrator setup is not open. The owner must open it on the server first.");
      const token = authorizations.issue(req.ip ?? req.socket.remoteAddress ?? "unknown");
      if (!token) return sendApiError(res, 503, "BOOTSTRAP_UNAVAILABLE", "Administrator setup is temporarily unavailable.");
      res.setHeader("Cache-Control", "no-store");
      return res.json({ authorization: token, expiresInSeconds: 300 });
    } catch {
      return sendApiError(res, 503, "BOOTSTRAP_UNAVAILABLE", "Administrator setup is temporarily unavailable.");
    }
  });

  router.post("/register", checkoutProtection("login"), async (req, res) => {
    if (!privateBootstrapRequest(req)) return notPrivate(res);
    const parsed = signupSchema.safeParse({ email: req.body?.email, password: req.body?.password });
    const authorization = req.get("X-Admin-Bootstrap-Authorization") ?? "";
    if (!parsed.success || !/^[A-Za-z0-9_-]{43}$/.test(authorization)) {
      return sendApiError(res, 400, "INVALID_REGISTRATION", "Enter a valid email and password.");
    }
    if (!authorizations.consume(authorization, req.ip ?? req.socket.remoteAddress ?? "unknown")) {
      return sendApiError(res, 403, "BOOTSTRAP_AUTHORIZATION_INVALID", "Setup authorization expired. Start administrator registration again.");
    }
    try {
      const passwordHash = await bcrypt.hash(parsed.data.password, 12);
      await prisma.$transaction(async (tx) => {
        // Same lock order as the CLI paths, so every first-Admin route is serialized.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('first-admin-bootstrap',0))`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('colorful-life-single-admin-bootstrap', 0))`;
        if (await tx.user.count({ where: { role: "ADMIN" } })) throw new Error("BOOTSTRAP_CLOSED");
        const arming = await activeRegistrationArming(tx, windowSeconds);
        if (arming === null) throw new Error("BOOTSTRAP_NOT_ARMED");
        if (await tx.user.findUnique({ where: { email: parsed.data.email }, select: { id: true } })) throw new Error("BOOTSTRAP_EMAIL_IN_USE");
        const user = await tx.user.create({ data: { email: parsed.data.email, passwordHash, role: "ADMIN", emailVerified: true, credentialVersion: randomUUID() }, select: { id: true } });
        await tx.$executeRaw`INSERT INTO "OperationalAudit" (kind,"actorId",details) VALUES ('FIRST_ADMIN_BOOTSTRAP',${user.id},${JSON.stringify({ source: "private-http-armed", emailVerification: "owner-attested", armingAuditId: arming.toString() })}::jsonb)`;
      });
      res.setHeader("Cache-Control", "no-store");
      return res.status(201).json({ registered: true, verificationRequired: false });
    } catch (error) {
      if (error instanceof Error && error.message === "BOOTSTRAP_CLOSED") return sendApiError(res, 409, "BOOTSTRAP_CLOSED", "Administrator setup is already complete.");
      if (error instanceof Error && error.message === "BOOTSTRAP_NOT_ARMED") return sendApiError(res, 403, "BOOTSTRAP_NOT_ARMED", "Administrator setup is not open. The owner must open it on the server first.");
      if (error instanceof Error && error.message === "BOOTSTRAP_EMAIL_IN_USE") return sendApiError(res, 409, "INVALID_REGISTRATION", "That email is already associated with an account.");
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return sendApiError(res, 409, "INVALID_REGISTRATION", "Registration conflicts with an existing account or completed setup.");
      logOperationalError("Administrator bootstrap failed", error);
      return sendApiError(res, 503, "BOOTSTRAP_UNAVAILABLE", "Administrator setup could not be completed. Request a new authorization and try again.");
    }
  });

  return router;
}

export default createAdminBootstrapRouter();
