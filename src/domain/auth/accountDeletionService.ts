import { ReauthenticationRequired } from "./reauthentication.js";
import { randomBytes } from "node:crypto";
import bcrypt from "bcrypt";
import type { Prisma } from "../../generated/prisma-client/client.js";
import { prisma } from "../../prisma/runtime.js";
import {
  AccountDeletionAdminNotAllowedError,
  AccountDeletionUserNotFoundError,
} from "./accountDeletionErrors.js";

type AccountDeletionTransactionClient = Prisma.TransactionClient;

async function deleteCustomerAccountInTransaction(
  tx: AccountDeletionTransactionClient,
  userId: number,
  now: Date,
  unusablePasswordHash: string,
  expectedHash?:string,
): Promise<void> {
  const locked = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE
  `;
  if (locked.length !== 1) throw new AccountDeletionUserNotFoundError();

  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, deletedAt: true, passwordHash:true },
  });
  if (!user) throw new AccountDeletionUserNotFoundError();
  if (user.role === "ADMIN") throw new AccountDeletionAdminNotAllowedError();
  if (user.deletedAt !== null) return;
  if(expectedHash!==undefined&&user.passwordHash!==expectedHash)throw new ReauthenticationRequired();

  await tx.$executeRaw`INSERT INTO "OperationalAudit" (kind,"actorId",details) VALUES ('ACCOUNT_DELETED',${userId},'{"source":"self-service"}'::jsonb)`;
  const tombstoneEmail = `deleted-${user.id}-${randomBytes(16).toString("hex")}@deleted.invalid`;
  await tx.address.deleteMany({ where: { userId } });
  await tx.emailVerificationToken.deleteMany({ where: { userId } });
  await tx.passwordResetToken.deleteMany({ where: { userId } });
  await tx.user.update({
    where: { id: userId },
    data: {
      email: tombstoneEmail,
      passwordHash: unusablePasswordHash,
      firstName: null,
      lastName: null,
      phone: null,
      deletedAt: now,
    },
  });
}

export async function deleteCustomerAccount(userId: number, now = new Date(), expectedHash?:string): Promise<void> {
  const unusablePasswordHash = await bcrypt.hash(randomBytes(32).toString("hex"), 12);
  await prisma.$transaction((tx) => deleteCustomerAccountInTransaction(tx, userId, now, unusablePasswordHash, expectedHash));
}
