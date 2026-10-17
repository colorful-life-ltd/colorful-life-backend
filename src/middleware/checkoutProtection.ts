import type { Request, Response, NextFunction } from 'express';
import { sendApiError } from '../utils/apiErrorResponse.js';
import { createHash } from 'node:crypto';
import { prisma } from '../prisma/runtime.js';
import { config } from '../config/index.js';
import { recoveryClientIp } from '../utils/recoveryClientIp.js';
import { abuseContext, bucket, consume, digest, PaymentAbuseError } from '../domain/security/paymentAbuse.js';

export function sendProtectionError(res: Response, error: unknown): boolean {
  if (!(error instanceof PaymentAbuseError)) return false;
  const context = abuseContext.getStore();
  let networkKey: string | undefined, accountKey: string | undefined;
  try {
    if (context) networkKey = digest(`network:${context.network}`);
    if (context?.accountId) accountKey = digest(`account:${context.accountId}`);
  } catch { /* Missing secret is reported only as the coarse unavailable decision. */ }
  console.warn(JSON.stringify({ event: 'checkout_protection', decision: error.code, networkKey, accountKey }));
  res.set('Retry-After', String(error.retryAfter));
  sendApiError(res, error.status, error.code, error.message);
  return true;
}
/** Request work budgets are distinct from durable new financial-operation budgets. */
export function checkoutProtection(action: 'signup' | 'login' | 'order' | 'payment' | 'recovery') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const network = recoveryClientIp(req.ip ?? '');
    try {
      const buckets = action === 'signup' ? [bucket('signupNetwork', network)]
        : action === 'login' ? [bucket('loginNetwork', network)]
        : action === 'recovery' ? [bucket('recoveryNetwork', network), bucket('recoveryAccount', String(req.user!.id)),
          ...(req.params.orderId ? [bucket('recoveryOrder', `${req.user!.id}:${req.params.orderId}`)] : [])]
        : [bucket('requestNetwork', network), bucket('requestAccount', String(req.user!.id))];
      await prisma.$transaction(tx => consume(tx, buckets));
      let challengeVerified = false;
      const token = req.get('X-Checkout-Challenge');
      if (token !== undefined && (action === 'payment' || action === 'order')) {
        if (!config.PAYMENT_CHALLENGE_ENABLED || !config.TURNSTILE_SECRET_KEY || !config.TURNSTILE_HOSTNAME
          || token.length < 1 || token.length > 2048) throw new PaymentAbuseError('CHECKOUT_CHALLENGE_REQUIRED', 403);
        // Tokens are never logged or persisted. Siteverify is the only allowed challenge authority.
        const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(3000),
          body: JSON.stringify({ secret: config.TURNSTILE_SECRET_KEY, response: token }),
        });
        const result = await response.json() as { success?: boolean; hostname?: string; action?: string; challenge_ts?: string };
        const age = Date.now() - Date.parse(result.challenge_ts ?? '');
        if (!response.ok || result.success !== true || result.hostname !== config.TURNSTILE_HOSTNAME || result.action !== 'checkout'
          || !Number.isFinite(age) || age < -30000 || age > 300000) throw new PaymentAbuseError('CHECKOUT_CHALLENGE_REQUIRED', 403);
        const hash = createHash('sha256').update(token).digest('hex');
        const used = await prisma.$executeRaw`INSERT INTO "PaymentChallengeUse" ("digest", "expiresAt") VALUES (${hash}, clock_timestamp() + interval '10 minutes') ON CONFLICT DO NOTHING`;
        if (!used) throw new PaymentAbuseError('CHECKOUT_CHALLENGE_REQUIRED', 403);
        challengeVerified = true;
      }
      abuseContext.run({ network, accountId: req.user?.id, challengeVerified }, next);
    } catch (error) {
      const safe = error instanceof PaymentAbuseError ? error : new PaymentAbuseError('CHECKOUT_PROTECTION_UNAVAILABLE', 503);
      // Do not amplify rejected traffic with unbounded durable per-request logs.
      abuseContext.run({ network, accountId: req.user?.id }, () => sendProtectionError(res, safe));
    }
  };
}
