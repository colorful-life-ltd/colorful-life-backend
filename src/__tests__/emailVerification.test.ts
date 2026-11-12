import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { prisma } from "../prisma/runtime.js";
import {
  createOrReplaceEmailVerificationToken,
  hashEmailVerificationToken,
  verifyEmailVerificationToken,
} from "../domain/auth/emailVerificationService.js";
import {
  EmailVerificationUserNotFoundError,
  InvalidOrExpiredVerificationTokenError,
} from "../domain/auth/emailVerificationErrors.js";

const userIds: number[] = [];

async function createUser(emailVerified = false) {
  const user = await prisma.user.create({
    data: {
      email: `verification-${randomUUID()}@example.com`,
      passwordHash: "hash",
      emailVerified,
    },
  });
  userIds.push(user.id);
  return user;
}

after(async () => {
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("email verification token domain", () => {
  it("creates a secure hashed token with a 24-hour expiry", async () => {
    const user = await createUser();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = await createOrReplaceEmailVerificationToken(user.id, now);
    assert.strictEqual(result.created, true);
    if (!result.created) return;
    const persisted = await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } });
    assert.notStrictEqual(result.rawToken, persisted?.tokenHash);
    assert.strictEqual(persisted?.tokenHash, hashEmailVerificationToken(result.rawToken));
    assert.strictEqual(result.expiresAt.getTime(), now.getTime() + 24 * 60 * 60 * 1000);
  });

  it("replaces the previous token and leaves one current token", async () => {
    const user = await createUser();
    const first = await createOrReplaceEmailVerificationToken(user.id);
    const second = await createOrReplaceEmailVerificationToken(user.id);
    if (!first.created || !second.created) return;
    await assert.rejects(() => verifyEmailVerificationToken(first.rawToken, "VerifiedPass1!"), InvalidOrExpiredVerificationTokenError);
    const persisted = await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } });
    assert.strictEqual(await prisma.emailVerificationToken.count({ where: { userId: user.id } }), 1);
    assert.strictEqual(persisted?.tokenHash, hashEmailVerificationToken(second.rawToken));
  });

  it("does not create a token for an already verified user", async () => {
    const user = await createUser(true);
    const result = await createOrReplaceEmailVerificationToken(user.id);
    assert.deepStrictEqual(result, { created: false });
    assert.strictEqual(await prisma.emailVerificationToken.count({ where: { userId: user.id } }), 0);
  });

  it("rejects a missing user and invalid tokens", async () => {
    await assert.rejects(() => createOrReplaceEmailVerificationToken(2_147_483_647), EmailVerificationUserNotFoundError);
    await assert.rejects(() => verifyEmailVerificationToken("unknown-token", "VerifiedPass1!"), InvalidOrExpiredVerificationTokenError);
  });

  it("verifies and consumes a valid token exactly once", async () => {
    const user = await createUser();
    const result = await createOrReplaceEmailVerificationToken(user.id);
    if (!result.created) return;
    assert.deepStrictEqual(await verifyEmailVerificationToken(result.rawToken, "VerifiedPass1!"), { verified: true });
    assert.strictEqual((await prisma.user.findUnique({ where: { id: user.id } }))?.emailVerified, true);
    assert.strictEqual(await prisma.emailVerificationToken.count({ where: { userId: user.id } }), 0);
    await assert.rejects(() => verifyEmailVerificationToken(result.rawToken, "VerifiedPass1!"), InvalidOrExpiredVerificationTokenError);
  });

  it("rejects expired tokens at and after the expiry boundary", async () => {
    const user = await createUser();
    const now = new Date("2026-01-01T00:00:00.000Z");
    const result = await createOrReplaceEmailVerificationToken(user.id, now);
    if (!result.created) return;
    await assert.rejects(() => verifyEmailVerificationToken(result.rawToken, "VerifiedPass1!", result.expiresAt), InvalidOrExpiredVerificationTokenError);
    await assert.rejects(() => verifyEmailVerificationToken(result.rawToken, "VerifiedPass1!", new Date(result.expiresAt.getTime() + 1)), InvalidOrExpiredVerificationTokenError);
  });

  it("allows exactly one concurrent consumer of the same token", async () => {
    const user = await createUser();
    const result = await createOrReplaceEmailVerificationToken(user.id);
    if (!result.created) return;
    const outcomes = await Promise.allSettled([
      verifyEmailVerificationToken(result.rawToken, "VerifiedPass1!"),
      verifyEmailVerificationToken(result.rawToken, "VerifiedPass1!"),
    ]);
    assert.strictEqual(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
    assert.strictEqual(outcomes.filter((outcome) => outcome.status === "rejected" && outcome.reason instanceof InvalidOrExpiredVerificationTokenError).length, 1);
  });

  it("leaves one token under concurrent replacement", async () => {
    const user = await createUser();
    const results = await Promise.all([
      createOrReplaceEmailVerificationToken(user.id),
      createOrReplaceEmailVerificationToken(user.id),
    ]);
    const tokens = results.filter((result) => result.created).map((result) => result.rawToken);
    const persisted = await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } });
    assert.strictEqual(await prisma.emailVerificationToken.count({ where: { userId: user.id } }), 1);
    assert.ok(tokens.some((token) => hashEmailVerificationToken(token) === persisted?.tokenHash));
    const valid = await verifyEmailVerificationToken(tokens.find((token) => hashEmailVerificationToken(token) === persisted?.tokenHash)!, "VerifiedPass1!");
    assert.deepStrictEqual(valid, { verified: true });
    const stale = tokens.filter((token) => hashEmailVerificationToken(token) !== persisted?.tokenHash)[0];
    if (stale) await assert.rejects(() => verifyEmailVerificationToken(stale, "VerifiedPass1!"), InvalidOrExpiredVerificationTokenError);
  });
});
