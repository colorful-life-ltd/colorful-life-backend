import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import app from "../app.js";
import { prisma } from "../prisma/runtime.js";
import { setVerificationEmailSenderForTests } from "../services/emailService.js";

let server: Server;
let url = "";
const created: string[] = [];
const verificationEmails: string[] = [];
let restoreVerificationSender: (() => void) | undefined;
before(async () => {
  restoreVerificationSender = setVerificationEmailSenderForTests(async ({ verificationUrl }) => { verificationEmails.push(verificationUrl); });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}`;
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 0, "isolated test DB must start without Admins");
});
after(async () => {
  restoreVerificationSender?.();
  if (created.length) await prisma.user.deleteMany({ where: { email: { in: created } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});
const status = () => fetch(`${url}/admin/bootstrap/status`);
const authorize = async () => {
  const response = await fetch(`${url}/admin/bootstrap/authorization`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(response.status, 200);
  return (await response.json() as { authorization: string }).authorization;
};
const register = (email: string, authorization: string, password = "StrongPass1!") => fetch(`${url}/admin/bootstrap/register`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Admin-Bootstrap-Authorization": authorization },
  body: JSON.stringify({ email, password }),
});

it("creates exactly one first Admin under concurrent requests and never reopens for a soft-deleted Admin", async () => {
  const emails = [`${randomUUID()}@bootstrap.test`, `${randomUUID()}@bootstrap.test`, `${randomUUID()}@bootstrap.test`]; created.push(...emails);
  assert.deepEqual(await (await status()).json(), { registrationAvailable: true });
  assert.equal((await register(emails[0], "")).status, 400);
  const retryableGrant = await authorize();
  assert.equal((await register(emails[0], retryableGrant, "weak")).status, 400);
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 0);
  const grants = await Promise.all([authorize(), authorize()]);
  const results = await Promise.all([register(emails[1], grants[0]), register(emails[2], grants[1])]);
  assert.deepEqual(results.map((response) => response.status).sort(), [201, 409]);
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 1);
  assert.deepEqual(await (await status()).json(), { registrationAvailable: false });
  const winner = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  assert.equal(winner.emailVerified, false);
  assert.equal(verificationEmails.length, 1);
  const verificationToken = new URL(verificationEmails[0]).searchParams.get("token");
  assert.ok(verificationToken);
  const verify = await fetch(`${url}/auth/verify-email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: verificationToken }) });
  assert.equal(verify.status, 200);
  const login = await fetch(`${url}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: winner.email, password: "StrongPass1!" }) });
  assert.equal(login.status, 200);
  await prisma.user.update({ where: { id: winner.id }, data: { deletedAt: new Date() } });
  assert.deepEqual(await (await status()).json(), { registrationAvailable: false });
  const customer = await prisma.user.create({ data: { email: `${randomUUID()}@bootstrap.test`, passwordHash: "fixture" } });
  await assert.rejects(() => prisma.user.update({ where: { id: customer.id }, data: { role: "ADMIN" } }));
  await assert.rejects(() => prisma.user.create({ data: { email: `${randomUUID()}@bootstrap.test`, passwordHash: "not-used", role: "ADMIN" } }));
});
