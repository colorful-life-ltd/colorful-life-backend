import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import bcrypt from "bcrypt";
import app from "../app.js";
import { prisma } from "../prisma/runtime.js";
import { createOrReplaceEmailVerificationToken, hashEmailVerificationToken } from "../domain/auth/emailVerificationService.js";
import { setVerificationEmailSenderForTests } from "../services/emailService.js";

const userIds: number[] = [];
let server: Server;
let url: string;
let restoreSender: (() => void) | undefined;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  url = `http://localhost:${address.port}`;
});

afterEach(async () => {
  restoreSender?.();
  restoreSender = undefined;
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  userIds.length = 0;
});

after(async () => { await prisma.$disconnect(); server.close(); });

async function createUser(email = `${randomUUID()}@example.com`, emailVerified = false) {
  const user = await prisma.user.create({
    data: { email, passwordHash: await bcrypt.hash("Abcdef1!", 4), emailVerified },
  });
  userIds.push(user.id);
  return user;
}

describe("email verification HTTP", () => {
  it("verifies a token publicly, consumes it, and rejects replay", async () => {
    const user = await createUser();
    const created = await createOrReplaceEmailVerificationToken(user.id);
    if (!created.created) throw new Error("token was not created");
    const response = await fetch(`${url}/auth/verify-email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: created.rawToken, newPassword: "VerifiedPass1!" }) });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { message: "Email verified successfully" });
    assert.strictEqual((await prisma.user.findUnique({ where: { id: user.id } }))?.emailVerified, true);
    assert.strictEqual(await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } }), null);
    const replay = await fetch(`${url}/auth/verify-email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: created.rawToken, newPassword: "VerifiedPass1!" }) });
    assert.strictEqual(replay.status, 400);
  });

  it("maps malformed, unknown, and expired tokens to 400 without auth", async () => {
    for (const body of [{}, { token: "   ", newPassword: "VerifiedPass1!" }, { token: 42, newPassword: "VerifiedPass1!" }, { token: "unknown", newPassword: "VerifiedPass1!" }]) {
      const response = await fetch(`${url}/auth/verify-email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      assert.strictEqual(response.status, 400);
    }
    const user = await createUser();
    const created = await createOrReplaceEmailVerificationToken(user.id, new Date(Date.now() - 25 * 60 * 60 * 1000));
    if (!created.created) throw new Error("token was not created");
    const response = await fetch(`${url}/auth/verify-email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: created.rawToken, newPassword: "VerifiedPass1!" }) });
    assert.strictEqual(response.status, 400);
  });

  it("resends to the requested unverified address and replaces the token", async () => {
    const user = await createUser();
    const first = await createOrReplaceEmailVerificationToken(user.id);
    if (!first.created) throw new Error("token was not created");
    const emails: { recipientEmail: string; verificationUrl: string }[] = [];
    restoreSender = setVerificationEmailSenderForTests(async (email) => { emails.push(email); });
    const response = await fetch(`${url}/auth/resend-verification`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: user.email }) });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { message: "If verification is needed, check your email for next steps." });
    assert.strictEqual(emails.length, 1);
    assert.strictEqual(emails[0].recipientEmail, user.email);
    const stored = await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } });
    const secondRaw = new URL(emails[0].verificationUrl).searchParams.get("token");
    assert.ok(stored && secondRaw);
    assert.strictEqual(stored.tokenHash, hashEmailVerificationToken(secondRaw!));
    await assert.rejects(() => import("../domain/auth/emailVerificationService.js").then(({ verifyEmailVerificationToken }) => verifyEmailVerificationToken(first.rawToken, "VerifiedPass1!")));
  });

  it("responds identically for verified and unknown users without sending", async () => {
    const user = await createUser(`${randomUUID()}@example.com`, true);
    let sends = 0;
    restoreSender = setVerificationEmailSenderForTests(async () => { sends++; });
    const response = await fetch(`${url}/auth/resend-verification`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({email:user.email}) });
    assert.strictEqual(response.status, 200);
    const unknown = await fetch(`${url}/auth/resend-verification`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({email:`${randomUUID()}@example.com`}) });
    assert.strictEqual(unknown.status, 200);
    assert.deepStrictEqual(await response.json(), await unknown.json());
    assert.strictEqual(sends, 0);
    assert.strictEqual(await prisma.emailVerificationToken.count({ where: { userId: user.id } }), 0);
  });
});
