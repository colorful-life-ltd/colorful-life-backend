import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "../../generated/prisma-client/client.js";
import { config } from "../../config/index.js";
import { prisma } from "../../prisma/runtime.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export type RefreshSessionUser = { id: number; role: string; credentialVersion?: string | null; deletedAt: Date | null };
export type AccessTokenIssuer<T> = (user: RefreshSessionUser) => T;

export class InvalidRefreshSessionError extends Error {
  constructor() {
    super("Invalid or expired refresh session");
    this.name = "InvalidRefreshSessionError";
  }
}

export function hashRefreshToken(refreshToken: string): string {
  return createHash("sha256").update(refreshToken, "utf8").digest("hex");
}

function createRefreshCredential() {
  const refreshToken = randomBytes(32).toString("base64url");
  return { refreshToken, refreshTokenHash: hashRefreshToken(refreshToken) };
}

export async function createRefreshSession(userId: number, now = new Date(), tx: Prisma.TransactionClient = prisma) {
  const credential = createRefreshCredential();
  const expiresAt = new Date(now.getTime() + config.REFRESH_SESSION_TTL_DAYS * DAY_MS);
  await tx.refreshSession.create({
    data: { userId, refreshTokenHash: credential.refreshTokenHash, expiresAt },
  });
  return { refreshToken: credential.refreshToken, refreshExpiresAt: expiresAt };
}

/** Rotates one stored credential under a transaction and a current-user row lock. */
export async function rotateRefreshSession<T>(
  presentedToken: string,
  issueAccessToken: AccessTokenIssuer<T>,
): Promise<{ accessToken: T; refreshToken: string; refreshExpiresAt: Date }> {
  const presentedHash = hashRefreshToken(presentedToken);
  const replacement = createRefreshCredential();

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const discovered = await tx.refreshSession.findUnique({
      where: { refreshTokenHash: presentedHash },
      select: { id: true, userId: true, expiresAt: true, revokedAt: true },
    });
    if (!discovered || discovered.revokedAt !== null || discovered.expiresAt <= new Date()) {
      throw new InvalidRefreshSessionError();
    }

    // Match account deletion's User-first lock order, then re-read session and user
    // state so concurrent refreshes or revocation cannot reuse the discovered row.
    const lockedUsers = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT "id" FROM "User" WHERE "id" = ${discovered.userId} FOR UPDATE
    `;
    if (lockedUsers.length !== 1) throw new InvalidRefreshSessionError();

    const user = await tx.user.findUnique({
      where: { id: discovered.userId },
      select: { id: true, role: true, deletedAt: true, credentialVersion: true },
    });
    if (!user || user.deletedAt !== null) throw new InvalidRefreshSessionError();

    // Evaluate expiry after acquiring the user lock: a request may have waited
    // behind another transaction long enough for the renewable session to expire.
    const decisionTime = new Date();
    const currentSession = await tx.refreshSession.findUnique({
      where: { id: discovered.id },
      select: { refreshTokenHash: true, expiresAt: true, revokedAt: true },
    });
    if (!currentSession || currentSession.refreshTokenHash !== presentedHash ||
        currentSession.revokedAt !== null || currentSession.expiresAt <= decisionTime) {
      throw new InvalidRefreshSessionError();
    }

    const accessToken = issueAccessToken(user);
    const rotated = await tx.refreshSession.updateMany({
      where: {
        id: discovered.id,
        refreshTokenHash: presentedHash,
        revokedAt: null,
        expiresAt: { gt: decisionTime },
      },
      data: { refreshTokenHash: replacement.refreshTokenHash },
    });
    if (rotated.count !== 1) throw new InvalidRefreshSessionError();

    return {
      accessToken,
      refreshToken: replacement.refreshToken,
      refreshExpiresAt: currentSession.expiresAt,
    };
  });
}

/** Revocation is intentionally idempotent and does not reveal whether a token existed. */
export async function revokeRefreshSession(presentedToken: string, now = new Date()): Promise<void> {
  const presentedHash = hashRefreshToken(presentedToken);
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const discovered = await tx.refreshSession.findUnique({
      where: { refreshTokenHash: presentedHash },
      select: { id: true, userId: true },
    });
    if (!discovered) return;

    // Use the same User-first lock order as rotation. If logout races with a
    // rotation after finding the old credential, revoke the same session row
    // even if rotation has already replaced its hash.
    const lockedUsers = await tx.$queryRaw<Array<{ id: number }>>`
      SELECT "id" FROM "User" WHERE "id" = ${discovered.userId} FOR UPDATE
    `;
    if (lockedUsers.length !== 1) return;

    await tx.refreshSession.updateMany({
      where: { id: discovered.id, revokedAt: null },
      data: { revokedAt: now },
    });
  });
}
