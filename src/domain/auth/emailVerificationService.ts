import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../../prisma/runtime.js";
import type { Prisma } from "../../generated/prisma-client/client.js";
import {
  EmailVerificationUserNotFoundError,
  InvalidOrExpiredVerificationTokenError,
} from "./emailVerificationErrors.js";

export const EMAIL_VERIFICATION_TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;
const TOKEN_LIFETIME_MS = EMAIL_VERIFICATION_TOKEN_LIFETIME_MS;
type VerificationTransactionClient = Prisma.TransactionClient;

export function hashEmailVerificationToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

async function createOrReplaceEmailVerificationTokenInTransaction(
  tx: VerificationTransactionClient,
  userId: number,
  now: Date,
) {
  const user = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, emailVerified: true },
  });
  if (!user) throw new EmailVerificationUserNotFoundError(userId);
  if (user.emailVerified) return { created: false as const };

  const rawToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + TOKEN_LIFETIME_MS);
  // Read in the same transaction so a definitively failed send can restore exactly this row.
  const previous = await tx.emailVerificationToken.findUnique({ where: { userId }, select: { tokenHash: true, expiresAt: true, createdAt: true } });
  await tx.emailVerificationToken.upsert({
    where: { userId },
    create: { userId, tokenHash: hashEmailVerificationToken(rawToken), expiresAt },
    update: { tokenHash: hashEmailVerificationToken(rawToken), expiresAt, createdAt: now },
  });
  return { created: true as const, rawToken, expiresAt, previous };
}

export async function createOrReplaceEmailVerificationToken(
  userId: number,
  now = new Date(),
  tx?: VerificationTransactionClient,
) {
  if (tx) return createOrReplaceEmailVerificationTokenInTransaction(tx, userId, now);
  return prisma.$transaction((transaction) =>
    createOrReplaceEmailVerificationTokenInTransaction(transaction, userId, now),
  );
}

/**
 * Undo a replacement whose email provably was not accepted, so the previously emailed link
 * keeps working. Conditional on the replacement still being current: a newer link from a
 * concurrent resend, or a verification that consumed it, is never overwritten.
 */
export async function restoreReplacedEmailVerificationToken(
  userId: number,
  replacementRawToken: string,
  previous: { tokenHash: string; expiresAt: Date; createdAt: Date } | null,
) {
  const where = { userId, tokenHash: hashEmailVerificationToken(replacementRawToken) };
  if (previous) await prisma.emailVerificationToken.updateMany({ where, data: previous });
  else await prisma.emailVerificationToken.deleteMany({ where });
}

export async function verifyEmailVerificationToken(rawToken: string, decisionTime = new Date()) {
  const tokenHash = hashEmailVerificationToken(rawToken);
  return prisma.$transaction(async (tx) => {
    const token = await tx.emailVerificationToken.findUnique({
      where: { tokenHash },
      select: { userId: true },
    });
    if (!token) {
      throw new InvalidOrExpiredVerificationTokenError();
    }

    // Serialize verification with future email changes on the owning User row.
    // The token is deliberately re-read after the lock: the initial lookup is
    // discovery only and may have become stale while waiting for the lock.
    const lockedUser = await tx.$queryRaw<Array<{ id: number; deletedAt: Date | null }>>`
      SELECT "id", "deletedAt" FROM "User" WHERE "id" = ${token.userId} FOR UPDATE
    `;
    if (lockedUser.length !== 1 || lockedUser[0].deletedAt !== null) {
      throw new InvalidOrExpiredVerificationTokenError();
    }
    const currentToken = await tx.emailVerificationToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true },
    });
    if (!currentToken || currentToken.userId !== token.userId || currentToken.expiresAt <= decisionTime) {
      throw new InvalidOrExpiredVerificationTokenError();
    }
    const consumed = await tx.emailVerificationToken.deleteMany({
      where: { id: currentToken.id, userId: token.userId, tokenHash, expiresAt: { gt: decisionTime } },
    });
    if (consumed.count !== 1) throw new InvalidOrExpiredVerificationTokenError();

    const updatedUser = await tx.user.updateMany({
      where: { id: token.userId, emailVerified: false, deletedAt: null },
      data: { emailVerified: true },
    });
    if (updatedUser.count !== 1) throw new InvalidOrExpiredVerificationTokenError();
    return { verified: true as const };
  });
}
