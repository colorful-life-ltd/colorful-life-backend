import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import bcrypt from "bcrypt";
import app from "../app.js";
import { prisma } from "../prisma/runtime.js";
import { createOrReplacePasswordResetToken } from "../domain/auth/passwordResetService.js";

const userIds: number[] = [];
const recoveryClientIp = `2001:db8:${randomUUID().replaceAll("-", "").slice(0, 20).match(/.{4}/g)!.join(":")}:1`;
let server: Server;
let url: string;

before(async () => {
  app.set("trust proxy", "loopback");
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  url = `http://localhost:${address.port}`;
});
afterEach(async () => {
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  userIds.length = 0;
});
after(async () => { await prisma.$disconnect(); server.close(); });

async function createUser(emailVerified = false) {
  const email = `reset-http-${randomUUID()}@example.com`;
  const user = await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash("OldPassword1!", 4), emailVerified } });
  userIds.push(user.id);
  return { ...user, email };
}

async function reset(token: string, newPassword: unknown) {
  return fetch(`${url}/auth/reset-password`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": recoveryClientIp }, body: JSON.stringify({ token, newPassword }) });
}

describe("reset-password HTTP", () => {
  it("is public and changes login password while consuming the token", async () => {
    const user = await createUser();
    const token = await createOrReplacePasswordResetToken(user.id);
    const before = await fetch(`${url}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": recoveryClientIp }, body: JSON.stringify({ email: user.email, password: "OldPassword1!" }) });
    assert.strictEqual(before.status, 200);
    const response = await reset(token.rawToken, "NewPassword1!");
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { message: "Password reset successfully" });
    const oldLogin = await fetch(`${url}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": recoveryClientIp }, body: JSON.stringify({ email: user.email, password: "OldPassword1!" }) });
    const newLogin = await fetch(`${url}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": recoveryClientIp }, body: JSON.stringify({ email: user.email, password: "NewPassword1!" }) });
    assert.strictEqual(oldLogin.status, 401);
    assert.strictEqual(newLogin.status, 200);
    assert.strictEqual(await prisma.passwordResetToken.count({ where: { userId: user.id } }), 0);
    assert.equal((await prisma.user.findUnique({ where: { id: user.id } }))?.emailVerified, false);
  });

  it("rejects invalid, expired, and consumed tokens generically", async () => {
    const invalid = await reset("unknown", "NewPassword1!");
    assert.strictEqual(invalid.status, 400);
    assert.deepStrictEqual(await invalid.json(), { error: "Invalid or expired password reset token" });
    const user = await createUser(true);
    const expired = await createOrReplacePasswordResetToken(user.id, new Date(Date.now() - 2 * 60 * 60 * 1000));
    assert.strictEqual((await reset(expired.rawToken, "NewPassword1!")).status, 400);
    const valid = await createOrReplacePasswordResetToken(user.id);
    assert.strictEqual((await reset(valid.rawToken, "NewPassword1!")).status, 200);
    assert.strictEqual((await reset(valid.rawToken, "AnotherPassword1!")).status, 400);
  });

  it("validates the password before consuming a token", async () => {
    const user = await createUser();
    const token = await createOrReplacePasswordResetToken(user.id);
    const invalid = await reset(token.rawToken, "weak");
    assert.strictEqual(invalid.status, 400);
    assert.ok(await prisma.passwordResetToken.findUnique({ where: { userId: user.id } }));
    assert.strictEqual((await reset(token.rawToken, "ValidPassword1!")).status, 200);
  });

  it("preserves verification state for verified users and supports one winner", async () => {
    const user = await createUser(true);
    const token = await createOrReplacePasswordResetToken(user.id);
    const results = await Promise.all([reset(token.rawToken, "FirstPassword1!"), reset(token.rawToken, "SecondPassword1!")]);
    assert.deepStrictEqual(results.map((result) => result.status).sort(), [200, 400]);
    assert.equal((await prisma.user.findUnique({ where: { id: user.id } }))?.emailVerified, true);
  });
});
