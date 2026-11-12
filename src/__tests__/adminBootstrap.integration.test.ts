import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import app from "../app.js";
import { createAdminBootstrapRouter } from "../routes/adminBootstrap.js";
import { bootstrapFirstAdmin } from "../domain/auth/adminBootstrap.js";
import { prisma } from "../prisma/runtime.js";
import { setVerificationEmailSenderForTests } from "../services/emailService.js";

let server: Server;
let url = "";
// The production policy: the same routes mounted fail-closed, against the same database.
let closedServer: Server;
let closedUrl = "";
const created: string[] = [];
const verificationEmails: string[] = [];
let restoreVerificationSender: (() => void) | undefined;
before(async () => {
  restoreVerificationSender = setVerificationEmailSenderForTests(async ({ verificationUrl }) => { verificationEmails.push(verificationUrl); });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  url = `http://127.0.0.1:${address.port}`;
  const closed = express(); closed.use(express.json()); closed.use("/admin/bootstrap", createAdminBootstrapRouter(false));
  closedServer = closed.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => closedServer.once("listening", resolve));
  const closedAddress = closedServer.address(); assert.ok(closedAddress && typeof closedAddress !== "string");
  closedUrl = `http://127.0.0.1:${closedAddress.port}`;
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 0, "isolated test DB must start without Admins");
});
after(async () => {
  restoreVerificationSender?.();
  if (created.length) await prisma.user.deleteMany({ where: { email: { in: created } } });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => closedServer.close(() => resolve()));
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

const closedPost = (path: string, headers: Record<string, string> = {}, body: unknown = {}) => fetch(`${closedUrl}/admin/bootstrap/${path}`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
});
const verifiedCustomer = async () => {
  const email = `${randomUUID()}@bootstrap.test`; created.push(email);
  return prisma.user.create({ data: { email, passwordHash: "fixture", emailVerified: true } });
};

it("production policy: a fresh database with no Admin still refuses every HTTP setup route", async () => {
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 0);
  const closedStatus = await fetch(`${closedUrl}/admin/bootstrap/status`);
  assert.equal(closedStatus.status, 200);
  assert.equal(closedStatus.headers.get("cache-control"), "no-store");
  assert.deepEqual(await closedStatus.json(), { registrationAvailable: false });
  const grant = await closedPost("authorization");
  assert.equal(grant.status, 403);
  assert.equal((await grant.json() as { error: { code: string } }).error.code, "BOOTSTRAP_DISABLED");
  // A forged, well-formed grant and valid credentials still cannot create an Admin.
  const email = `${randomUUID()}@bootstrap.test`; created.push(email);
  const register = await closedPost("register", { "X-Admin-Bootstrap-Authorization": "A".repeat(43) }, { email, password: "StrongPass1!" });
  assert.equal(register.status, 403);
  assert.equal(await prisma.user.count({ where: { email } }), 0);
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 0);
  // Sandbox/Production isolation: the policy, not the database, decides exposure. The same database
  // remains open through the development/test-policy router, and is untouched by the closed one.
  assert.deepEqual(await (await status()).json(), { registrationAvailable: true });
});

it("unauthorized initialization is refused when HTTP setup is enabled", async () => {
  const email = `${randomUUID()}@bootstrap.test`; created.push(email);
  const forged = await fetch(`${url}/admin/bootstrap/register`, { method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Bootstrap-Authorization": "A".repeat(43) }, body: JSON.stringify({ email, password: "StrongPass1!" }) });
  assert.equal(forged.status, 403);
  assert.equal((await forged.json() as { error: { code: string } }).error.code, "BOOTSTRAP_AUTHORIZATION_INVALID");
  assert.equal(await prisma.user.count({ where: { email } }), 0);
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 0);
});

it("production provisioning: only the owner-run CLI promotes a verified customer, with audit, while HTTP stays closed", async () => {
  const customer = await verifiedCustomer();
  // Missing audit details are refused before any database change.
  await assert.rejects(bootstrapFirstAdmin(customer.id, "too short", "owner-ref-1"));
  await assert.rejects(bootstrapFirstAdmin(customer.id, "Owner-approved first administrator", ""));
  class Rollback extends Error {}
  // Run the real CLI operation inside an outer transaction and roll it back, so this suite's
  // later Sandbox-path test still starts from a database without any Admin.
  await assert.rejects(prisma.$transaction(async (tx) => {
    await bootstrapFirstAdmin(customer.id, "Owner-approved first administrator", "owner-ref-0001",
      { $transaction: ((work: (client: typeof tx) => Promise<unknown>) => work(tx)) as unknown as typeof prisma.$transaction });
    const promoted = await tx.user.findUniqueOrThrow({ where: { id: customer.id } });
    assert.equal(promoted.role, "ADMIN");
    assert.notEqual(promoted.credentialVersion, customer.credentialVersion);
    const audit = await tx.$queryRaw<Array<{ details: { source: string; operatorReference: string } }>>`
      SELECT details FROM "OperationalAudit" WHERE kind='FIRST_ADMIN_BOOTSTRAP' AND "actorId"=${customer.id}`;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].details.source, "one-off-cli");
    assert.equal(audit[0].details.operatorReference, "owner-ref-0001");
    throw new Rollback();
  }), Rollback);
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).role, "CUSTOMER");
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 0);
  assert.equal((await closedPost("authorization")).status, 403);
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
  const verify = await fetch(`${url}/auth/verify-email`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: verificationToken, newPassword: "StrongPass1!" }) });
  assert.equal(verify.status, 200);
  const login = await fetch(`${url}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: winner.email, password: "StrongPass1!" }) });
  assert.equal(login.status, 200);
  await prisma.user.update({ where: { id: winner.id }, data: { deletedAt: new Date() } });
  assert.deepEqual(await (await status()).json(), { registrationAvailable: false });
  const customer = await prisma.user.create({ data: { email: `${randomUUID()}@bootstrap.test`, passwordHash: "fixture" } });
  await assert.rejects(() => prisma.user.update({ where: { id: customer.id }, data: { role: "ADMIN" } }));
  await assert.rejects(() => prisma.user.create({ data: { email: `${randomUUID()}@bootstrap.test`, passwordHash: "not-used", role: "ADMIN" } }));
});

it("after an Admin exists: HTTP setup stays closed under both policies and the CLI refuses another Admin", async () => {
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 1);
  assert.deepEqual(await (await fetch(`${closedUrl}/admin/bootstrap/status`)).json(), { registrationAvailable: false });
  assert.equal((await closedPost("authorization")).status, 403);
  const grant = await fetch(`${url}/admin/bootstrap/authorization`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(grant.status, 409);
  const customer = await verifiedCustomer();
  await assert.rejects(bootstrapFirstAdmin(customer.id, "Owner-approved replacement administrator", "owner-ref-0002"));
  assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: customer.id } })).role, "CUSTOMER");
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 1);
});
