import assert from "node:assert/strict";
import { after, afterEach, before, it } from "node:test";
import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { setPasswordResetEmailSenderForTests } from "../services/emailService.js";

// Captured at import, before any test touches it: the deployed default when REGISTRATION_ENABLED is unset.
const defaultEnabled = config.REGISTRATION_ENABLED;
let server: ReturnType<typeof app.listen>, base = "";
const emails: string[] = [];
before(async () => {
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  const address = server.address(); assert.ok(address && typeof address !== "string"); base = `http://127.0.0.1:${address.port}`;
});
afterEach(() => { config.REGISTRATION_ENABLED = defaultEnabled; });
after(async () => {
  await prisma.user.deleteMany({ where: { email: { in: emails } } });
  await new Promise<void>(r => server.close(() => r())); await prisma.$disconnect();
});
const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const email = () => { const value = `${randomUUID()}@registration.test`; emails.push(value); return value; };

it("is closed by default when REGISTRATION_ENABLED is not set", () => {
  assert.equal(process.env.REGISTRATION_ENABLED, undefined);
  assert.equal(defaultEnabled, false);
});

it("refuses signup while closed and writes no account, token or rate-limit row", async () => {
  const address = email();
  const before = { users: await prisma.user.count(), tokens: await prisma.emailVerificationToken.count(), buckets: await prisma.abuseBucket.count() };
  for (const body of [{ email: address, password: "Synthetic1!Password" }, { email: "not-an-email", password: "x" }, {}]) {
    const response = await post("/auth/signup", body);
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: { code: "REGISTRATION_DISABLED", message: "Account registration is not open yet." } });
  }
  assert.equal(await prisma.user.findUnique({ where: { email: address } }), null);
  assert.deepEqual({ users: await prisma.user.count(), tokens: await prisma.emailVerificationToken.count(), buckets: await prisma.abuseBucket.count() }, before);
});

it("still lets existing accounts sign in and recover passwords while registration is closed", async () => {
  const address = email(), password = "Synthetic1!Password";
  await prisma.user.create({ data: { email: address, passwordHash: await bcrypt.hash(password, 4), emailVerified: true } });
  const login = await post("/auth/login", { email: address, password });
  assert.equal(login.status, 200); assert.ok((await login.json()).token);
  let sent = 0;
  const restore = setPasswordResetEmailSenderForTests(async () => { sent++; });
  try {
    const recovery = await post("/auth/forgot-password", { email: address });
    assert.equal(recovery.status, 200);
    assert.equal(sent, 1);
  } finally { restore(); }
});

it("allows signup once REGISTRATION_ENABLED is turned on", async () => {
  config.REGISTRATION_ENABLED = true;
  const address = email();
  const response = await post("/auth/signup", { email: address, password: "Synthetic1!Password" });
  assert.equal(response.status, 201);
  assert.ok(await prisma.user.findUnique({ where: { email: address } }));
});
