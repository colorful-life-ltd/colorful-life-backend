import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import bcrypt from "bcrypt";
import app from "../app.js";
import { prisma } from "../prisma/runtime.js";
import { config } from "../config/index.js";
import { hashPasswordResetToken } from "../domain/auth/passwordResetService.js";
import { setPasswordResetEmailSenderForTests, type PasswordResetEmail } from "../services/emailService.js";

const userIds: number[] = [];
const recoveryClientIp = `2001:db8:${randomUUID().replaceAll("-", "").slice(0, 20).match(/.{4}/g)!.join(":")}:1`;
let server: Server;
let url: string;
let restoreSender: (() => void) | undefined;

before(async () => {
  app.set("trust proxy", "loopback");
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
  const user = await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash("OldPassword1!", 4), emailVerified } });
  userIds.push(user.id);
  return user;
}

describe("forgot-password HTTP", () => {
  it("creates one hashed token and sends a trusted URL for an existing user", async () => {
    const user = await createUser();
    let email: PasswordResetEmail | undefined;
    restoreSender = setPasswordResetEmailSenderForTests(async (value) => { email = value; });
    const response = await fetch(`${url}/auth/forgot-password`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": recoveryClientIp }, body: JSON.stringify({ email: `  ${user.email.toUpperCase()}  ` }) });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.deepStrictEqual(body, { message: "If an account exists, a password reset email has been sent" });
    assert.ok(email);
    assert.strictEqual(email!.recipientEmail, user.email);
    const raw = new URL(email!.resetUrl).searchParams.get("token");
    const stored = await prisma.passwordResetToken.findUnique({ where: { userId: user.id } });
    assert.ok(raw && stored);
    assert.strictEqual(new URL(email!.resetUrl).origin, config.FRONTEND_URL);
    assert.strictEqual(stored!.tokenHash, hashPasswordResetToken(raw!));
    assert.notStrictEqual(stored!.tokenHash, raw);
    assert.strictEqual((await prisma.user.findUnique({ where: { id: user.id } }))?.emailVerified, false);
  });

  it("returns the identical generic response for an unknown email and sends nothing", async () => {
    const sent: PasswordResetEmail[] = [];
    restoreSender = setPasswordResetEmailSenderForTests(async (value) => { sent.push(value); });
    const existing = await fetch(`${url}/auth/forgot-password`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": recoveryClientIp }, body: JSON.stringify({ email: "nobody@example.com" }) });
    const unknownBody = await existing.json();
    assert.strictEqual(existing.status, 200);
    assert.deepStrictEqual(unknownBody, { message: "If an account exists, a password reset email has been sent" });
    assert.equal(sent.length, 0);
  });

  it("keeps the same response and token when email delivery fails", async () => {
    const user = await createUser();
    restoreSender = setPasswordResetEmailSenderForTests(async () => { throw new Error("SES unavailable"); });
    const response = await fetch(`${url}/auth/forgot-password`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": recoveryClientIp }, body: JSON.stringify({ email: user.email }) });
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { message: "If an account exists, a password reset email has been sent" });
    assert.ok(await prisma.passwordResetToken.findUnique({ where: { userId: user.id } }));
  });

  it("replaces the previous token and validates the email input", async () => {
    const user = await createUser();
    const emails: PasswordResetEmail[] = [];
    restoreSender = setPasswordResetEmailSenderForTests(async (value) => { emails.push(value); });
    await fetch(`${url}/auth/forgot-password`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": recoveryClientIp }, body: JSON.stringify({ email: user.email }) });
    await fetch(`${url}/auth/forgot-password`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": recoveryClientIp }, body: JSON.stringify({ email: user.email }) });
    assert.strictEqual(await prisma.passwordResetToken.count({ where: { userId: user.id } }), 1);
    assert.notStrictEqual(emails[0].resetUrl, emails[1].resetUrl);
    const invalid = await fetch(`${url}/auth/forgot-password`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": recoveryClientIp }, body: JSON.stringify({ email: "not-an-email" }) });
    assert.strictEqual(invalid.status, 400);
  });
});
