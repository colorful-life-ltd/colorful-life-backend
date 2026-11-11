import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { randomUUID } from "node:crypto";
import http, { type Server } from "node:http";
import express from "express";
import bcrypt from "bcrypt";
import app from "../app.js";
import { createAdminBootstrapRouter } from "../routes/adminBootstrap.js";
import { BootstrapAuthorizationStore, BOOTSTRAP_AUTHORIZATION_TTL_MS } from "../domain/auth/bootstrapAuthorization.js";
import { FIRST_ADMIN_REGISTRATION_ARMED, runArmFirstAdminRegistration } from "../domain/auth/firstAdminRegistrationArming.js";
import { adminBootstrapMode } from "../config/adminBootstrap.js";
import { prisma } from "../prisma/runtime.js";
import { setVerificationEmailSenderForTests } from "../services/emailService.js";

// The Production policy ("private") mounted against the test database, as on the Production API.
let clock = Date.now();
const store = new BootstrapAuthorizationStore(() => clock);
const servers: Server[] = [];
let privatePort = 0;
let unarmedPort = 0;
let appUrl = "";
const created: string[] = [];
const verificationEmails: string[] = [];
let restoreVerificationSender: (() => void) | undefined;
const reference = `test/${randomUUID()}`;

async function listen(handler: express.Express | typeof app): Promise<number> {
  const server = handler.listen(0, "127.0.0.1"); servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return address.port;
}
before(async () => {
  restoreVerificationSender = setVerificationEmailSenderForTests(async ({ verificationUrl }) => { verificationEmails.push(verificationUrl); });
  const privateApp = express(); privateApp.use(express.json());
  privateApp.use("/admin/bootstrap", createAdminBootstrapRouter("private", { authorizations: store }));
  privatePort = await listen(privateApp);
  // Same policy with a 1-second window: any arming older than that is expired.
  const unarmedApp = express(); unarmedApp.use(express.json());
  unarmedApp.use("/admin/bootstrap", createAdminBootstrapRouter("private", { armingWindowSeconds: 1 }));
  unarmedPort = await listen(unarmedApp);
  appUrl = `http://127.0.0.1:${await listen(app)}`;
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 0, "isolated test DB must start without Admins");
});
after(async () => {
  restoreVerificationSender?.();
  if (created.length) await prisma.user.deleteMany({ where: { email: { in: created } } });
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await prisma.$disconnect();
});

type Reply = { status: number; body: any };
/** node:http so the Host and proxy headers are exactly what a tunnel or Nginx would send. */
function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Reply> {
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: `/admin/bootstrap/${path}`, method: options.method ?? "GET",
      headers: { Host: `localhost:${port}`, ...(body ? { "Content-Type": "application/json" } : {}), ...options.headers } }, (response) => {
      let text = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
    });
    request.on("error", reject); if (body) request.write(body); request.end();
  });
}
const status = (port = privatePort, headers: Record<string, string> = {}) => call(port, "status", { headers });
const authorize = (port = privatePort, headers: Record<string, string> = {}) => call(port, "authorization", { method: "POST", headers, body: {} });
const register = (email: string, authorization: string, port = privatePort, headers: Record<string, string> = {}) =>
  call(port, "register", { method: "POST", headers: { "X-Admin-Bootstrap-Authorization": authorization, ...headers }, body: { email, password: "StrongPass1!" } });
const arm = async () => {
  const out: string[] = []; const err: string[] = [];
  const code = await runArmFirstAdminRegistration({ args: ["Owner-approved first administrator", reference], stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out, err };
};
const newEmail = () => { const email = `${randomUUID()}@private-bootstrap.test`; created.push(email); return email; };

it("policy: Production is private (never open); an explicit false closes it; staging and development are unchanged", () => {
  assert.equal(adminBootstrapMode({ NODE_ENV: "production" }), "private");
  assert.equal(adminBootstrapMode({ NODE_ENV: "production", DEPLOYMENT_ENVIRONMENT: "production", ADMIN_BOOTSTRAP_HTTP_ENABLED: "true" }), "private");
  assert.equal(adminBootstrapMode({ NODE_ENV: "production", ADMIN_BOOTSTRAP_HTTP_ENABLED: "false" }), "closed");
  assert.equal(adminBootstrapMode({ NODE_ENV: "production", DEPLOYMENT_ENVIRONMENT: "staging" }), "closed");
  assert.equal(adminBootstrapMode({ NODE_ENV: "production", DEPLOYMENT_ENVIRONMENT: "staging", ADMIN_BOOTSTRAP_HTTP_ENABLED: "true" }), "open");
  assert.equal(adminBootstrapMode({ NODE_ENV: "development" }), "open");
});

it("without an owner arming window, nothing is offered or created (and an expired window does not count)", async () => {
  await prisma.$executeRaw`INSERT INTO "OperationalAudit" (kind, details, "createdAt") VALUES (${FIRST_ADMIN_REGISTRATION_ARMED}, '{"test":"expired"}'::jsonb, clock_timestamp() - interval '2 seconds')`;
  assert.deepEqual((await status(unarmedPort)).body, { registrationAvailable: false });
  const grant = await authorize(unarmedPort);
  assert.equal(grant.status, 403); assert.equal(grant.body.error.code, "BOOTSTRAP_NOT_ARMED");
  const forged = await register(newEmail(), "A".repeat(43), unarmedPort);
  assert.equal(forged.status, 403);
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 0);
});

it("a grant issued inside the window cannot register after the window has closed", async () => {
  await prisma.$executeRaw`INSERT INTO "OperationalAudit" (kind, details) VALUES (${FIRST_ADMIN_REGISTRATION_ARMED}, '{"test":"short-window"}'::jsonb)`;
  const grant = await authorize(unarmedPort);
  assert.equal(grant.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  const email = newEmail();
  const late = await register(email, grant.body.authorization, unarmedPort);
  assert.equal(late.status, 403); assert.equal(late.body.error.code, "BOOTSTRAP_NOT_ARMED");
  assert.equal(await prisma.user.count({ where: { email } }), 0);
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 0);
});

it("arming requires a valid audit reason and reference, and opens a fixed window", async () => {
  const out: string[] = []; const err: string[] = [];
  assert.equal(await runArmFirstAdminRegistration({ args: ["short", reference], stdout: (l) => out.push(l), stderr: (l) => err.push(l) }), 1);
  assert.equal(await runArmFirstAdminRegistration({ args: ["Owner-approved first administrator"], stdout: (l) => out.push(l), stderr: (l) => err.push(l) }), 1);
  assert.deepEqual(out, []); assert.equal(err.length, 2);
  const armed = await arm();
  assert.equal(armed.code, 0, armed.err.join("|"));
  assert.match(armed.out[0], /^First-admin registration open until \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z; register from the private Admin connection$/);
  assert.deepEqual((await status()).body, { registrationAvailable: true });
});

it("public and proxied requests are refused even while armed: Nginx headers or a public Host", async () => {
  const proxied: Array<Record<string, string>> = [
    { "X-Forwarded-For": "203.0.113.9" }, { "X-Real-IP": "203.0.113.9" }, { Forwarded: "for=203.0.113.9" },
    { "X-Forwarded-Proto": "https" }, { Via: "1.1 nginx" }, { Host: "build-and-bloom.co.uk" }, { Host: "localhost.attacker.test" },
  ];
  for (const headers of proxied) {
    assert.deepEqual((await status(privatePort, headers)).body, { registrationAvailable: false }, JSON.stringify(headers));
    const grant = await authorize(privatePort, headers);
    assert.equal(grant.status, 403, JSON.stringify(headers)); assert.equal(grant.body.error.code, "BOOTSTRAP_DISABLED");
  }
  // A real grant obtained privately cannot be redeemed through a proxied request either.
  const token = (await authorize()).body.authorization as string;
  const email = newEmail();
  const relayed = await register(email, token, privatePort, { "X-Forwarded-For": "203.0.113.9" });
  assert.equal(relayed.status, 403); assert.equal(relayed.body.error.code, "BOOTSTRAP_DISABLED");
  assert.equal(await prisma.user.count({ where: { email } }), 0);
});

it("an expired setup token is refused and creates nothing", async () => {
  const token = (await authorize()).body.authorization as string;
  clock += BOOTSTRAP_AUTHORIZATION_TTL_MS + 1;
  const email = newEmail();
  const expired = await register(email, token);
  assert.equal(expired.status, 403); assert.equal(expired.body.error.code, "BOOTSTRAP_AUTHORIZATION_INVALID");
  // A token is single use: replaying it after a refusal is refused too.
  assert.equal((await register(email, token)).status, 403);
  assert.equal(await prisma.user.count({ where: { email } }), 0);
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 0);
});

it("concurrent registrations create exactly one verified ADMIN with audit, no email, and normal login works", async () => {
  const emails = [newEmail(), newEmail()];
  const grants = await Promise.all([authorize(), authorize()]);
  const results = await Promise.all(grants.map((grant, index) => register(emails[index], grant.body.authorization)));
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  const success = results.find((result) => result.status === 201)!;
  assert.deepEqual(success.body, { registered: true, verificationRequired: false });
  assert.equal(results.find((result) => result.status === 409)!.body.error.code, "BOOTSTRAP_CLOSED");
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 1);
  const admin = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });
  assert.ok(emails.includes(admin.email));
  assert.equal(admin.emailVerified, true);
  assert.ok(admin.credentialVersion);
  assert.ok(await bcrypt.compare("StrongPass1!", admin.passwordHash));
  assert.equal(verificationEmails.length, 0);
  const audit = await prisma.$queryRaw<Array<{ details: { source: string; emailVerification: string; armingAuditId: string } }>>`
    SELECT details FROM "OperationalAudit" WHERE kind='FIRST_ADMIN_BOOTSTRAP' AND "actorId"=${admin.id}`;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].details.source, "private-http-armed");
  assert.equal(audit[0].details.emailVerification, "owner-attested");
  assert.match(audit[0].details.armingAuditId, /^[1-9][0-9]*$/);
  const login = await fetch(`${appUrl}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: admin.email, password: "StrongPass1!" }) });
  assert.equal(login.status, 200);
});

it("once an ADMIN exists, setup is closed for good: status, grants, arming and forged registrations all refuse", async () => {
  assert.deepEqual((await status()).body, { registrationAvailable: false });
  const grant = await authorize();
  assert.equal(grant.status, 409); assert.equal(grant.body.error.code, "BOOTSTRAP_CLOSED");
  const rearm = await arm();
  assert.equal(rearm.code, 1); assert.deepEqual(rearm.err, ["Bootstrap refused: an administrator already exists"]);
  const email = newEmail();
  assert.equal((await register(email, "A".repeat(43))).status, 403);
  assert.equal(await prisma.user.count({ where: { email } }), 0);
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 1);
  // Ordinary signup stays a customer registration with email verification; it can never create an ADMIN.
  const signupEmail = newEmail();
  const signup = await fetch(`${appUrl}/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: signupEmail, password: "StrongPass1!" }) });
  if (signup.status === 201) {
    const customer = await prisma.user.findUniqueOrThrow({ where: { email: signupEmail } });
    assert.equal(customer.role, "CUSTOMER"); assert.equal(customer.emailVerified, false);
  }
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 1);
  // The window was consumed by the creation: even if the Admin row were removed, setup does not reopen
  // until the owner arms again on the host.
  await prisma.user.deleteMany({ where: { role: "ADMIN" } });
  assert.equal(await prisma.user.count({ where: { role: "ADMIN" } }), 0);
  assert.deepEqual((await status()).body, { registrationAvailable: false });
  const reopened = await authorize();
  assert.equal(reopened.status, 403); assert.equal(reopened.body.error.code, "BOOTSTRAP_NOT_ARMED");
});
