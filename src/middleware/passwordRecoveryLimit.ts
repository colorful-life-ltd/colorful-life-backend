import type { RequestHandler } from "express";
import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { prisma } from "../prisma/runtime.js";
import { config } from "../config/index.js";
import { forgotPasswordSchema } from "../utils/authValidation.js";

import { recoveryClientIp } from "../utils/recoveryClientIp.js";

const WINDOW_MS = 60 * 60 * 1000;
export async function consumeRecoveryLimit(identity: string, maximum: number): Promise<boolean> {
  const key = createHmac("sha256", config.JWT_SECRET).update(identity).digest("hex");
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "PasswordRecoveryLimit" ("key", "windowStartedAt", "count")
    VALUES (${key}, statement_timestamp(), 1)
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "PasswordRecoveryLimit"."windowStartedAt" <= statement_timestamp() - interval '1 hour'
        THEN 1 ELSE LEAST("PasswordRecoveryLimit"."count" + 1, ${maximum + 1}) END,
      "windowStartedAt" = CASE WHEN "PasswordRecoveryLimit"."windowStartedAt" <= statement_timestamp() - interval '1 hour'
        THEN statement_timestamp() ELSE "PasswordRecoveryLimit"."windowStartedAt" END
    RETURNING "count"
  `;
  return rows[0].count <= maximum;
}

/** Prune only expired limiter counters, never account/token/payment/order data.
 * Bounded and SKIP LOCKED so concurrent API processes cannot block each other.
 */
export async function pruneExpiredRecoveryLimits(): Promise<void> {
  await prisma.$executeRaw`
    DELETE FROM "PasswordRecoveryLimit" WHERE "key" IN (
      SELECT "key" FROM "PasswordRecoveryLimit"
      WHERE "windowStartedAt" < clock_timestamp() - interval '2 hours'
      ORDER BY "windowStartedAt", "key" LIMIT 100 FOR UPDATE SKIP LOCKED
    )
  `;
}

export function passwordRecoveryLimit(kind: "forgot" | "reset"): RequestHandler {
  return async (req, res, next) => {
    const started = performance.now();
    res.locals.passwordRecoveryStartedAt = started;
    try {
      // Express alone decides which proxy addresses are trusted. Never parse X-Forwarded-For here.
      const allowedIp = await consumeRecoveryLimit(`${kind}:ip:${recoveryClientIp(req.ip ?? req.socket.remoteAddress ?? "unknown")}`, 30);
      if (!allowedIp) {
        res.setHeader("Retry-After", String(WINDOW_MS / 1000));
        res.status(429).json({ error: "Too many requests. Please try again later." });
        return;
      }
      await pruneExpiredRecoveryLimits();
      if (kind === "forgot") {
        const parsed = forgotPasswordSchema.safeParse(req.body);
        if (parsed.success && !await consumeRecoveryLimit(`forgot:email:${parsed.data.email}`, 3)) {
          // Silently suppress email delivery for both existing and nonexistent accounts.
          await delay(Math.max(0, 2000 - (performance.now() - started)));
          res.status(200).json({ message: "If an account exists, a password reset email has been sent" });
          return;
        }
      }
      next();
    } catch {
      // Shared limiter failures fail closed, without logging identities or credentials.
      res.status(503).json({ error: "Password recovery temporarily unavailable" });
    }
  };
}
