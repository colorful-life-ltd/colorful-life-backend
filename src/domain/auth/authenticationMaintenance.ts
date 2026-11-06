import type { Prisma } from "../../generated/prisma-client/client.js";

/** Called by existing ADMIN maintenance, not a new worker. At most 1,000 rows per
 * table per invocation; unexpired credentials and financial evidence are untouched.
 * Row locks serialize with token replacement/refresh; SKIP LOCKED avoids waiting
 * behind an active authentication transaction. Counts contain no identities.
 */
export async function pruneExpiredAuthentication(tx: Prisma.TransactionClient) {
  const refreshSessions = await tx.$executeRaw`DELETE FROM "RefreshSession" WHERE "id" IN
    (SELECT "id" FROM "RefreshSession" WHERE "expiresAt" <= statement_timestamp()
      ORDER BY "expiresAt", "id" LIMIT 1000 FOR UPDATE SKIP LOCKED)`;
  const verificationTokens = await tx.$executeRaw`DELETE FROM "EmailVerificationToken" WHERE "id" IN
    (SELECT "id" FROM "EmailVerificationToken" WHERE "expiresAt" <= statement_timestamp()
      ORDER BY "expiresAt", "id" LIMIT 1000 FOR UPDATE SKIP LOCKED)`;
  const resetTokens = await tx.$executeRaw`DELETE FROM "PasswordResetToken" WHERE "id" IN
    (SELECT "id" FROM "PasswordResetToken" WHERE "expiresAt" <= statement_timestamp()
      ORDER BY "expiresAt", "id" LIMIT 1000 FOR UPDATE SKIP LOCKED)`;
  return { refreshSessions, verificationTokens, resetTokens };
}
