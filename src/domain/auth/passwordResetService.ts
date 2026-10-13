import { createHash, randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import { prisma } from "../../prisma/runtime.js";
import type { Prisma } from "../../generated/prisma-client/client.js";
import {
  PasswordResetUserNotFoundError,
  InvalidOrExpiredPasswordResetTokenError,
} from "./passwordResetErrors.js";

import { passwordSchema } from "../../utils/authValidation.js";

const RESET_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
type PasswordResetTransactionClient = Prisma.TransactionClient;

export function hashPasswordResetToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

async function createTokenInTransaction(
  tx: PasswordResetTransactionClient,
  userId: number,
  now: Date,
  expectedEmail?: string,
) {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
  const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, deletedAt: true, email: true } });
  if (!user || user.deletedAt !== null || (expectedEmail !== undefined && user.email !== expectedEmail)) {
    throw new PasswordResetUserNotFoundError(userId);
  }

  const rawToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + RESET_TOKEN_LIFETIME_MS);
  await tx.passwordResetToken.upsert({
    where: { userId },
    create: { userId, tokenHash: hashPasswordResetToken(rawToken), expiresAt },
    update: { tokenHash: hashPasswordResetToken(rawToken), expiresAt, createdAt: now },
  });
  return { rawToken, expiresAt };
}

export async function createOrReplacePasswordResetToken(userId: number, now = new Date(), expectedEmail?: string) {
  return prisma.$transaction((tx) => createTokenInTransaction(tx, userId, now, expectedEmail));
}

export async function resetPassword(
  rawToken: string,
  newPassword: string,
  decisionTime?: Date,
) {
  passwordSchema.parse(newPassword);
  const passwordHash = await bcrypt.hash(newPassword, 12);
  const tokenHash = hashPasswordResetToken(rawToken);

  return prisma.$transaction(async (tx) => {
    const token = await tx.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, expiresAt: true },
    });
    if (!token) {
      throw new InvalidOrExpiredPasswordResetTokenError();
    }

    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${token.userId} FOR UPDATE`;
    const checkedAt = decisionTime ?? new Date();
    const consumed = await tx.passwordResetToken.deleteMany({
      where: { id: token.id, tokenHash, expiresAt: { gt: checkedAt } },
    });
    if (consumed.count !== 1) throw new InvalidOrExpiredPasswordResetTokenError();

    const user = await tx.user.findUnique({ where: { id: token.userId }, select: { deletedAt: true } });
    if (!user || user.deletedAt !== null) throw new InvalidOrExpiredPasswordResetTokenError();
    await tx.user.update({ where: { id: token.userId }, data: { passwordHash, credentialVersion: randomUUID() } });
    await tx.refreshSession.updateMany({ where: { userId: token.userId, revokedAt: null }, data: { revokedAt: checkedAt } });
    return { reset: true as const };
  });
}
