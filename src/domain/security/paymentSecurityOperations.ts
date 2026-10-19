import { prisma } from '../../prisma/runtime.js';
import type { Prisma } from '../../generated/prisma-client/client.js';
import type { Provider } from './paymentAbuse.js';

/** Definitive refusals. Nothing was written, so callers may map these to 4xx. */
export class PaymentSecurityOperationError extends Error {
  constructor(readonly code: 'INVALID_SECURITY_NOTE' | 'INVALID_POLICY' | 'ADMIN_REQUIRED' | 'ORDER_NOT_FOUND' | 'VERIFIED_PAYMENT_REQUIRED',
    readonly status: 400 | 403 | 404 | 409) { super(code); }
}
async function admin(tx: Prisma.TransactionClient, actorId: number) {
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, deletedAt: true } });
  if (!actor || actor.deletedAt || actor.role !== 'ADMIN') throw new PaymentSecurityOperationError('ADMIN_REQUIRED', 403);
}
/** Order lock serializes hold/release with both dispatch paths. Financial state is untouched. */
export async function reviewOrder(actorId: number, orderId: number, action: 'HOLD' | 'RELEASE', note: string) {
  if (note.trim().length < 10 || note.length > 500) throw new PaymentSecurityOperationError('INVALID_SECURITY_NOTE', 400);
  return prisma.$transaction(async tx => {
    await admin(tx, actorId);
    const order = await tx.$queryRaw<Array<{ id: number }>>`SELECT id FROM "Order" WHERE id=${orderId} FOR NO KEY UPDATE`;
    if (!order.length) throw new PaymentSecurityOperationError('ORDER_NOT_FOUND', 404);
    if (action === 'HOLD') await tx.$executeRaw`INSERT INTO "PaymentFulfilmentReview" ("orderId", "reason") VALUES (${orderId}, 'ADMIN_REVIEW')
      ON CONFLICT ("orderId") DO UPDATE SET "releasedAt"=NULL, "releasedBy"=NULL, "releaseNote"=NULL, "reason"='ADMIN_REVIEW'`;
    else {
      const payment = await tx.payment.findUnique({ where: { orderId }, select: { status: true, paidAt: true } });
      if (payment?.status !== 'SUCCEEDED' || !payment.paidAt) throw new PaymentSecurityOperationError('VERIFIED_PAYMENT_REQUIRED', 409);
      await tx.$executeRaw`UPDATE "PaymentFulfilmentReview" SET "releasedAt"=clock_timestamp(), "releasedBy"=${actorId}, "releaseNote"=${note.trim()}
      WHERE "orderId"=${orderId} AND "releasedAt" IS NULL`;
    }
    await tx.$executeRaw`INSERT INTO "PaymentSecurityEvent" ("kind", "reason", "orderId", "actorId") VALUES (${action === 'HOLD' ? 'ADMIN_HOLD' : 'ADMIN_RELEASE'}, ${note.trim()}, ${orderId}, ${actorId})`;
  });
}
export async function updatePolicy(actorId: number, provider: Provider, enabled: boolean, capacity: number | null, note: string) {
  if (!['STRIPE', 'PAYPAL'].includes(provider) || typeof enabled !== 'boolean'
    || (capacity !== null && (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1000000))
    || note.trim().length < 10 || note.length > 500) throw new PaymentSecurityOperationError('INVALID_POLICY', 400);
  return prisma.$transaction(async tx => {
    await admin(tx, actorId);
    await tx.$executeRaw`UPDATE "PaymentInitiationPolicy" SET "enabled"=${enabled}, "capacity"=${capacity}, "updatedAt"=clock_timestamp() WHERE "provider"=${provider}`;
    await tx.$executeRaw`INSERT INTO "PaymentSecurityEvent" ("kind", "provider", "actorId", "reason") VALUES ('POLICY_UPDATED', ${provider}, ${actorId}, ${note})`;
  });
}

/** Bounded maintenance; schedule externally. Never delete payment admissions or review audit here. */
export async function pruneSecurityState() {
  return prisma.$transaction(async tx => {
    const buckets = await tx.$executeRaw`DELETE FROM "AbuseBucket" WHERE "key" IN
      (SELECT "key" FROM "AbuseBucket" WHERE "expiresAt" < clock_timestamp() ORDER BY "expiresAt" LIMIT 1000 FOR UPDATE SKIP LOCKED)`;
    const challenges = await tx.$executeRaw`DELETE FROM "PaymentChallengeUse" WHERE "digest" IN
      (SELECT "digest" FROM "PaymentChallengeUse" WHERE "expiresAt" < clock_timestamp() ORDER BY "expiresAt" LIMIT 1000 FOR UPDATE SKIP LOCKED)`;
    return { buckets, challenges };
  });
}
