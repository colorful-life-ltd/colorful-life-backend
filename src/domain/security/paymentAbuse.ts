import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';
import { stagingLimits, parseAbuseLimits } from '../../config/paymentAbuse.js';
export { stagingLimits } from '../../config/paymentAbuse.js';
import type { Prisma } from '../../generated/prisma-client/client.js';
import { config } from '../../config/index.js';

export type Provider = 'STRIPE' | 'PAYPAL';
type Context = { network: string; accountId?: number; challengeVerified?: boolean };
export const abuseContext = new AsyncLocalStorage<Context>();
export class PaymentAbuseError extends Error {
  constructor(public code: 'PAYMENT_INITIATION_DISABLED' | 'CHECKOUT_RATE_LIMITED' | 'CHECKOUT_CHALLENGE_REQUIRED' | 'CHECKOUT_PROTECTION_UNAVAILABLE', public status: number, public retryAfter = 60) {
    super('Checkout temporarily unavailable. Please wait and try again, or contact support.');
  }
}
type Limit = keyof typeof stagingLimits;
export function limits(): typeof stagingLimits {
  try { return parseAbuseLimits(config.PAYMENT_ABUSE_LIMITS_JSON); }
  catch { throw new PaymentAbuseError('CHECKOUT_PROTECTION_UNAVAILABLE', 503); }
}
export function digest(value: string): string {
  // A dedicated, shared deployment secret is mandatory; no per-process random fallback.
  if (!config.PAYMENT_ABUSE_HMAC_SECRET) throw new PaymentAbuseError('CHECKOUT_PROTECTION_UNAVAILABLE', 503);
  return createHmac('sha256', config.PAYMENT_ABUSE_HMAC_SECRET).update(value).digest('hex');
}
type Bucket = { key: string; capacity: number; seconds: number };
export function bucket(name: Limit, subject: string, capacity?: number): Bucket {
  const [defaultCapacity, seconds] = limits()[name];
  return { key: digest(`${name}:${subject}`), capacity: capacity ?? defaultCapacity, seconds };
}
/** Caller must commit only if every bucket is allowed. Sorted advisory locks serialize across processes. */
export async function consume(tx: Prisma.TransactionClient, input: Bucket[]): Promise<void> {
  const buckets = [...new Map(input.map(b => [b.key, b])).values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  for (const b of buckets) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`abuse:${b.key}`}, 0))`;
  for (const b of buckets) {
    const changed = await tx.$queryRaw<Array<{ key: string }>>`
      INSERT INTO "AbuseBucket" ("key", "tokens", "updatedAt", "expiresAt")
      VALUES (${b.key}, ${b.capacity - 1}, clock_timestamp(), clock_timestamp() + ${b.seconds * 2} * interval '1 second')
      ON CONFLICT ("key") DO UPDATE SET
        "tokens" = LEAST(${b.capacity}::double precision, "AbuseBucket"."tokens" +
          GREATEST(0, EXTRACT(EPOCH FROM clock_timestamp() - "AbuseBucket"."updatedAt")) * ${b.capacity / b.seconds}) - 1,
        "updatedAt" = clock_timestamp(), "expiresAt" = clock_timestamp() + ${b.seconds * 2} * interval '1 second'
      WHERE LEAST(${b.capacity}::double precision, "AbuseBucket"."tokens" +
        GREATEST(0, EXTRACT(EPOCH FROM clock_timestamp() - "AbuseBucket"."updatedAt")) * ${b.capacity / b.seconds}) >= 1
      RETURNING "key"`;
    if (!changed.length) throw new PaymentAbuseError('CHECKOUT_RATE_LIMITED', 429, Math.ceil(b.seconds / b.capacity));
  }
}
export async function policy(tx: Prisma.TransactionClient, provider: Provider) {
  const envEnabled = provider === 'STRIPE' ? config.PAYMENT_STRIPE_INITIATION_ENABLED : config.PAYMENT_PAYPAL_INITIATION_ENABLED;
  // SHARE conflicts with operator policy UPDATE, allowing already admitted calls to complete.
  const rows = await tx.$queryRaw<Array<{ enabled: boolean; capacity: number | null }>>`SELECT "enabled", "capacity" FROM "PaymentInitiationPolicy" WHERE "provider"=${provider} FOR SHARE`;
  if (!envEnabled || !rows[0]?.enabled) throw new PaymentAbuseError('PAYMENT_INITIATION_DISABLED', 503);
  return rows[0];
}
/** The caller holds the Order lock. Admission identity is server-generated, never a client retry header. */
async function admitFinancialOperationInner(tx: Prisma.TransactionClient, provider: Provider, orderId: number, userId: number, identity: string, attemptIdentity = identity) {
  const settings = await policy(tx, provider);
  const prior = await tx.$queryRaw<Array<{ orderId: number; provider: string }>>`SELECT "orderId", "provider" FROM "PaymentAdmission" WHERE "identity"=${identity}`;
  if (prior.length) {
    if (prior[0].orderId !== orderId || prior[0].provider !== provider) throw new PaymentAbuseError('CHECKOUT_PROTECTION_UNAVAILABLE', 503);
    return;
  }
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`abuse-account:${userId}`}, 0))`;
  const network = abuseContext.getStore()?.network ?? 'unknown';
  // One account cannot bypass progressive friction through new orders or sessions.
  const [challengeCapacity, challengeSeconds] = limits().challengeAfter;
  const recent = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT count(DISTINCT a."attemptIdentity") AS count FROM "PaymentAdmission" a JOIN "Order" o ON o.id=a."orderId"
    WHERE o."userId"=${userId} AND a."createdAt" > clock_timestamp() - ${challengeSeconds} * interval '1 second'`;
  const continuing = await tx.$queryRaw<Array<{ identity: string }>>`SELECT "identity" FROM "PaymentAdmission"
    WHERE "orderId"=${orderId} AND "provider"=${provider} AND "attemptIdentity"=${attemptIdentity} LIMIT 1`;
  const elevated = !continuing.length && Number(recent[0].count) >= challengeCapacity;
  if (elevated && (!config.PAYMENT_CHALLENGE_ENABLED || !abuseContext.getStore()?.challengeVerified)) {
    throw new PaymentAbuseError('CHECKOUT_CHALLENGE_REQUIRED', 403);
  }
  await consume(tx, [bucket('paymentAccount', String(userId)), bucket('paymentAccountDay', String(userId)),
    bucket('paymentNetwork', network), bucket('paymentNetworkDay', network), bucket('paymentOrder', String(orderId)), bucket('provider', provider, settings.capacity ?? undefined)]);
  await tx.$executeRaw`INSERT INTO "PaymentAdmission" ("identity", "orderId", "provider", "attemptIdentity") VALUES (${identity}, ${orderId}, ${provider}, ${attemptIdentity})`;
  if (elevated) {
    await tx.$executeRaw`INSERT INTO "PaymentFulfilmentReview" ("orderId", "reason") VALUES (${orderId}, 'ELEVATED_PAYMENT_VELOCITY') ON CONFLICT ("orderId") DO NOTHING`;
    await tx.$executeRaw`INSERT INTO "PaymentSecurityEvent" ("kind", "reason", "orderId", "provider") VALUES ('REVIEW_HELD', 'ELEVATED_PAYMENT_VELOCITY', ${orderId}, ${provider})`;
  }
}
export async function assertNoFulfilmentHold(tx: Prisma.TransactionClient, orderId: number) {
  const rows = await tx.$queryRaw<Array<{ orderId: number }>>`SELECT "orderId" FROM "PaymentFulfilmentReview" WHERE "orderId"=${orderId} AND "releasedAt" IS NULL`;
  return rows.length === 0;
}

/** New orders only: idempotent replay is checked by the caller first. */
async function admitOrderCreationInner(tx: Prisma.TransactionClient, userId: number) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`abuse-account:${userId}`}, 0))`;
  const [active] = await tx.$queryRaw<Array<{ count: bigint }>>`SELECT count(*) AS count FROM "Order" o
    WHERE o."userId"=${userId} AND o.status='PENDING'
    AND (o."reservationExpiresAt" IS NULL OR o."reservationExpiresAt" > clock_timestamp())
    AND NOT EXISTS (SELECT 1 FROM "Payment" p WHERE p."orderId"=o.id)`;
  if (Number(active.count) >= limits().activeReservations[0]) throw new PaymentAbuseError('CHECKOUT_RATE_LIMITED', 429, 900);
  await consume(tx, [bucket('orderAccount', String(userId)), bucket('orderNetwork', abuseContext.getStore()?.network ?? 'unknown')]);
}

function protectionUnavailable(error: unknown): never {
  if (error instanceof PaymentAbuseError) throw error;
  // Database/config errors occur before provider I/O. Never leak query parameters or driver diagnostics.
  throw new PaymentAbuseError('CHECKOUT_PROTECTION_UNAVAILABLE', 503);
}
export async function admitFinancialOperation(...args: Parameters<typeof admitFinancialOperationInner>) {
  try { await admitFinancialOperationInner(...args); } catch (error) { protectionUnavailable(error); }
}
export async function admitOrderCreation(...args: Parameters<typeof admitOrderCreationInner>) {
  try { await admitOrderCreationInner(...args); } catch (error) { protectionUnavailable(error); }
}
