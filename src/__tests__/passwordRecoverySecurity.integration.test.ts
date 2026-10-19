import assert from "node:assert/strict";
import { before, after, it } from "node:test";
import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import type { Server } from "node:http";
import app from "../app.js";
import { prisma } from "../prisma/runtime.js";
import { createOrReplacePasswordResetToken, resetPassword } from "../domain/auth/passwordResetService.js";
import { buildPasswordResetEmailCommand, setPasswordResetEmailSenderForTests, setVerificationEmailSenderForTests } from "../services/emailService.js";
import { consumeRecoveryLimit, passwordRecoveryLimit, pruneExpiredRecoveryLimits } from "../middleware/passwordRecoveryLimit.js";
import express from "express";

let server: Server;
let base: string;
const clientIp = `2001:db8:${randomUUID().replaceAll("-", "").slice(0, 20).match(/.{4}/g)!.join(":")}:1`;
before(async () => {
  app.set("trust proxy", "loopback");
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await prisma.$disconnect();
});
async function post(path: string, body: unknown) {
  const response = await fetch(base + path, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, "Content-Type": "application/json", "X-Forwarded-For": clientIp }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
it("uses the generated SES body URL, revokes both credentials, and preserves identity and order ownership", async () => {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: await bcrypt.hash("OldPassword1!", 4), emailVerified: true } });
  await prisma.order.create({ data: { userId: user.id, totalAmount: 10,
    billingRecipientName: "Test", billingLine1: "Test", billingCity: "Test", billingPostcode: "TEST", billingCountryCode: "GB",
    deliveryRecipientName: "Test", deliveryLine1: "Test", deliveryCity: "Test", deliveryPostcode: "TEST", deliveryCountryCode: "GB" } });
  const ownershipBefore = await prisma.order.findMany({ where: { userId: user.id }, select: { id: true, userId: true } });
  const loggedIn = await post("/auth/login", { email: user.email, password: "OldPassword1!" });
  assert.equal(loggedIn.status, 200);
  let body = "";
  const restore = setPasswordResetEmailSenderForTests(async email => {
    body = buildPasswordResetEmailCommand(email).input.Message!.Body!.Text!.Data!;
  });
  try {
    const known = await post("/auth/forgot-password", { email: `  ${user.email.toUpperCase()}  ` });
    const unknown = await post("/auth/forgot-password", { email: `${randomUUID()}@example.test` });
    assert.deepEqual(known, unknown);
    assert.equal(known.status, 200);
    assert.equal(body.includes("\\n"), false);
    assert.equal(body.split("\n").length, 3);
    const url = new URL(body.split("\n")[1]);
    const token = url.searchParams.get("token");
    assert.ok(token);
    assert.equal((await post("/auth/reset-password", { token, newPassword: "NewPassword1!" })).status, 200);
    assert.equal((await post("/auth/reset-password", { token, newPassword: "OtherPassword1!" })).status, 400);
    assert.equal((await post("/auth/refresh", { refreshToken: loggedIn.body.refreshToken })).status, 401);
    assert.equal((await fetch(base + "/orders", { headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${loggedIn.body.token}` } })).status, 401);
    assert.equal((await post("/auth/login", { email: user.email, password: "OldPassword1!" })).status, 401);
    const fresh = await post("/auth/login", { email: user.email, password: "NewPassword1!" });
    assert.equal(fresh.status, 200);
    assert.equal((await fetch(base + "/orders", { headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${fresh.body.token}` } })).status, 200);
    const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.equal(current.email, user.email);
    assert.equal(current.emailVerified, user.emailVerified);
    assert.equal(current.role, user.role);
    assert.deepEqual(await prisma.order.findMany({ where: { userId: user.id }, select: { id: true, userId: true } }), ownershipBefore);
  } finally { restore(); }
});
it("enforces a distributed limit under real concurrent PostgreSQL requests", async () => {
  const key = `test:${randomUUID()}`;
  const results = await Promise.all(Array.from({ length: 12 }, () => consumeRecoveryLimit(key, 3)));
  assert.equal(results.filter(Boolean).length, 3);
});
it("email throttling normalizes addresses and returns the same generic response", async () => {
  const email = `${randomUUID()}@example.test`;
  await prisma.user.create({ data: { email, passwordHash: await bcrypt.hash("OldPassword1!", 4) } });
  let sent = 0;
  const restore = setPasswordResetEmailSenderForTests(async () => { sent++; });
  try {
    const results = [];
    for (let i = 0; i < 4; i++) {
      const started = performance.now();
      results.push(await post("/auth/forgot-password", { email: i % 2 ? ` ${email.toUpperCase()} ` : email }));
      assert.ok(performance.now() - started >= 1950);
    }
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.equal(sent, 3);
  } finally { restore(); }
});
it("does not trust a forged forwarded IP and returns 429 after the IP budget", async () => {
  const local = express();
  local.use(express.json());
  local.set("trust proxy", "loopback");
  const key = `2001:db8:${randomUUID().replaceAll("-", "").slice(0, 20).match(/.{4}/g)!.join(":")}:1`;
  local.use((req, _res, next) => { assert.equal(req.ip, key); next(); });
  local.post("/reset", passwordRecoveryLimit("reset"), (_req, res) => res.sendStatus(204));
  const s = local.listen(0);
  await new Promise<void>(resolve => s.once("listening", resolve));
  const address = s.address(); assert.ok(address && typeof address !== "string");
  try {
    for (let i = 0; i < 31; i++) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/reset`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, "X-Forwarded-For": `192.0.2.${i}, ${key}` } });
      assert.equal(response.status, i < 30 ? 204 : 429);
    }
  } finally { await new Promise<void>(resolve => s.close(() => resolve())); }
});
it("concurrent token consumers revoke all sessions exactly once", async () => {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: await bcrypt.hash("OldPassword1!", 4) } });
  const login = await post("/auth/login", { email: user.email, password: "OldPassword1!" });
  assert.equal(login.status, 200);
  const token = await createOrReplacePasswordResetToken(user.id);
  const results = await Promise.allSettled([resetPassword(token.rawToken, "NewPassword1!"), resetPassword(token.rawToken, "OtherPassword1!")]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(await prisma.refreshSession.count({ where: { userId: user.id, revokedAt: null } }), 0);
  assert.equal(await prisma.passwordResetToken.count({ where: { userId: user.id } }), 0);
});
it("refresh racing with reset cannot leave a renewable or usable old session", async () => {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: await bcrypt.hash("OldPassword1!", 4) } });
  const loggedIn = await post("/auth/login", { email: user.email, password: "OldPassword1!" });
  const token = await createOrReplacePasswordResetToken(user.id);
  const [refreshed] = await Promise.all([
    post("/auth/refresh", { refreshToken: loggedIn.body.refreshToken }),
    resetPassword(token.rawToken, "NewPassword1!"),
  ]);
  assert.ok(refreshed.status === 200 || refreshed.status === 401);
  if (refreshed.status === 200) {
    assert.equal((await post("/auth/refresh", { refreshToken: refreshed.body.refreshToken })).status, 401);
    assert.equal((await fetch(base + "/orders", { headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${refreshed.body.token}` } })).status, 401);
  }
  assert.equal(await prisma.refreshSession.count({ where: { userId: user.id, revokedAt: null } }), 0);
});
it("an old-password verified before reset cannot create a session after reset commits", async (t) => {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: await bcrypt.hash("OldPassword1!", 4) } });
  const token = await createOrReplacePasswordResetToken(user.id);
  let signalVerified!: () => void;
  let releaseVerification!: () => void;
  const verified = new Promise<void>(resolve => { signalVerified = resolve; });
  const release = new Promise<void>(resolve => { releaseVerification = resolve; });
  const compare = bcrypt.compare.bind(bcrypt);
  t.mock.method(bcrypt, "compare", async (password: string, hash: string) => {
    const matches = await compare(password, hash);
    signalVerified();
    await release;
    return matches;
  });
  const pendingLogin = post("/auth/login", { email: user.email, password: "OldPassword1!" });
  try {
    await verified;
    await resetPassword(token.rawToken, "NewPassword1!");
  } finally { releaseVerification(); }
  const loggedIn = await pendingLogin;
  assert.equal(loggedIn.status, 401);
  assert.equal(await prisma.refreshSession.count({ where: { userId: user.id, revokedAt: null } }), 0);
});
it("prunes stale limiter counters without resetting live budgets", async () => {
  const key = randomUUID().replaceAll("-", "");
  await prisma.passwordRecoveryLimit.create({ data: { key, count: 1, windowStartedAt: new Date(Date.now() - 3 * 3600000) } });
  const liveIdentity = `live:${randomUUID()}`;
  assert.equal(await consumeRecoveryLimit(liveIdentity, 1), true);
  await pruneExpiredRecoveryLimits();
  assert.equal(await prisma.passwordRecoveryLimit.count({ where: { key } }), 0);
  assert.equal(await consumeRecoveryLimit(liveIdentity, 1), false);
});
it("retains legacy access compatibility until the first reset and revokes versions on every reset", async () => {
  const { default: jwt } = await import("jsonwebtoken");
  const { config } = await import("../config/index.js");
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: await bcrypt.hash("OldPassword1!", 4), emailVerified: true } });
  const legacy = jwt.sign({ id: user.id, role: user.role }, config.JWT_SECRET, { expiresIn: "1h" });
  const getOrders = (token: string) => fetch(base + "/orders", { headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${token}` } });
  assert.equal((await getOrders(legacy)).status, 200);
  await resetPassword((await createOrReplacePasswordResetToken(user.id)).rawToken, "NewPassword1!");
  assert.equal((await getOrders(legacy)).status, 401);
  const firstVersion = (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credentialVersion;
  const login = await post("/auth/login", { email: user.email, password: "NewPassword1!" });
  const refresh = await post("/auth/refresh", { refreshToken: login.body.refreshToken });
  assert.equal(refresh.status, 200);
  assert.equal((await getOrders(refresh.body.token)).status, 200);
  await resetPassword((await createOrReplacePasswordResetToken(user.id)).rawToken, "AgainPassword1!");
  assert.notEqual((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).credentialVersion, firstVersion);
  assert.equal((await getOrders(refresh.body.token)).status, 401);
});
it("opens a new limiter window only after the persisted fixed deadline", async () => {
  const { createHmac } = await import("node:crypto");
  const { config } = await import("../config/index.js");
  const identity = `expired:${randomUUID()}`;
  const key = createHmac("sha256", config.JWT_SECRET).update(identity).digest("hex");
  await prisma.passwordRecoveryLimit.create({ data: { key, count: 4, windowStartedAt: new Date(Date.now() - 70 * 60000) } });
  assert.equal(await consumeRecoveryLimit(identity, 3), true);
  assert.equal((await prisma.passwordRecoveryLimit.findUniqueOrThrow({ where: { key } })).count, 1);
});
it("limiter database failure fails closed with a generic 503", async () => {
  const query = prisma.$queryRaw;
  prisma.$queryRaw = (() => { throw new Error("simulated persistence outage"); }) as typeof query;
  try {
    const result = await post("/auth/forgot-password", { email: `${randomUUID()}@example.test` });
    assert.deepEqual(result, { status: 503, body: { error: "Password recovery temporarily unavailable" } });
  } finally { prisma.$queryRaw = query; }
});
it("a refresh blocked behind reset rechecks revocation after the PostgreSQL user lock", async () => {
  const { setTimeout: delay } = await import("node:timers/promises");
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: await bcrypt.hash("OldPassword1!", 4) } });
  const loggedIn = await post("/auth/login", { email: user.email, password: "OldPassword1!" });
  assert.equal(loggedIn.status, 200);
  const token = await createOrReplacePasswordResetToken(user.id);
  let signalLocked!: () => void;
  let releaseLock!: () => void;
  const locked = new Promise<void>(resolve => { signalLocked = resolve; });
  const released = new Promise<void>(resolve => { releaseLock = resolve; });
  const blocker = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${user.id} FOR UPDATE`;
    signalLocked();
    await released;
  }, { timeout: 10000 });
  const waitForWaiters = async (expected: number) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::integer AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%FROM "User"%FOR UPDATE%'
      `;
      if (rows[0].count >= expected) return;
      await delay(10);
    }
    assert.fail("Expected real PostgreSQL lock contention was not observed");
  };
  await locked;
  let reset: Promise<unknown> | undefined;
  let refresh: ReturnType<typeof post> | undefined;
  try {
    reset = resetPassword(token.rawToken, "NewPassword1!");
    await waitForWaiters(1);
    refresh = post("/auth/refresh", { refreshToken: loggedIn.body.refreshToken });
    await waitForWaiters(2);
  } finally { releaseLock(); await blocker; }
  await reset;
  assert.equal((await refresh!)!.status, 401);
  assert.equal(await prisma.refreshSession.count({ where: { userId: user.id, revokedAt: null } }), 0);
});
it("email changes revoke prior reset authority and reject stale email lookups", async () => {
  const { changeUnverifiedUserEmail } = await import("../domain/auth/emailChangeService.js");
  const { PasswordResetUserNotFoundError, InvalidOrExpiredPasswordResetTokenError } = await import("../domain/auth/passwordResetErrors.js");
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: await bcrypt.hash("OldPassword1!", 4) } });
  const old = await createOrReplacePasswordResetToken(user.id, new Date(), user.email);
  const newEmail = `${randomUUID()}@example.test`;
  await changeUnverifiedUserEmail(user.id, newEmail);
  assert.equal(await prisma.passwordResetToken.count({ where: { userId: user.id } }), 0);
  await assert.rejects(resetPassword(old.rawToken, "NewPassword1!"), InvalidOrExpiredPasswordResetTokenError);
  await assert.rejects(createOrReplacePasswordResetToken(user.id, new Date(), user.email), PasswordResetUserNotFoundError);
  const fresh = await createOrReplacePasswordResetToken(user.id, new Date(), newEmail);
  await resetPassword(fresh.rawToken, "NewPassword1!");
  const current = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  assert.equal(current.email, newEmail);
  assert.equal(current.emailVerified, false);
  assert.equal(current.id, user.id);
});

it("rejects oversized reset and signup passwords without consuming a token, and supports historical login", async () => {
  const boundary = "Aa1!" + "a".repeat(68);
  const oldPassword = boundary + "historical";
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: await bcrypt.hash(oldPassword, 4) } });
  assert.equal((await post("/auth/login", { email: user.email, password: oldPassword })).status, 200);
  const restoreVerification = setVerificationEmailSenderForTests(async () => undefined);
  const signupEmail = `${randomUUID()}@example.test`;
  try {
    assert.equal((await post("/auth/signup", { email: signupEmail, password: boundary })).status, 201);
    assert.equal((await post("/auth/login", { email: signupEmail, password: boundary })).status, 200);
  } finally { restoreVerification(); }
  const token = await createOrReplacePasswordResetToken(user.id);
  assert.equal((await post("/auth/reset-password", { token: token.rawToken, newPassword: boundary + "x" })).status, 400);
  assert.equal((await post("/auth/signup", { email: `${randomUUID()}@example.test`, password: boundary + "x" })).status, 400);
  assert.ok(await prisma.passwordResetToken.findUnique({ where: { userId: user.id } }));
  await assert.rejects(resetPassword(token.rawToken, boundary + "x"));
  assert.equal((await post("/auth/reset-password", { token: token.rawToken, newPassword: "New1!" + "é".repeat(33) + "x" })).status, 200);
  assert.equal((await post("/auth/login", { email: user.email, password: oldPassword })).status, 401);
  assert.equal((await post("/auth/login", { email: user.email, password: "New1!" + "é".repeat(33) + "x" })).status, 200);
});

it("shares a real PostgreSQL recovery budget across different IPv6 addresses in a /56", async () => {
  const application = express();
  application.set("trust proxy", "loopback");
  application.use(passwordRecoveryLimit("reset"));
  application.post("/", (_req, res) => res.sendStatus(204));
  const listener = application.listen(0);
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  const prefix = randomUUID().slice(0, 4);
  try {
    for (let i = 0; i < 31; i++) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, "X-Forwarded-For": `2001:db8:${prefix}:56${i.toString(16).padStart(2, "0")}::${i + 1}` } });
      assert.equal(response.status, i < 30 ? 204 : 429);
    }
  } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
});

it("awaits slow email delivery and returns generic responses on slow delivery failure", async () => {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: await bcrypt.hash("OldPassword1!", 4) } });
  for (const fail of [false, true]) {
    let completed = false;
    const restore = setPasswordResetEmailSenderForTests(async () => {
      await new Promise(resolve => setTimeout(resolve, 2200));
      completed = true;
      if (fail) throw new Error("test delivery failure");
    });
    try {
      const started = performance.now();
      const result = await post("/auth/forgot-password", { email: user.email });
      assert.equal(completed, true);
      assert.ok(performance.now() - started >= 2150);
      assert.deepEqual(result, { status: 200, body: { message: "If an account exists, a password reset email has been sent" } });
      assert.ok(await prisma.passwordResetToken.findUnique({ where: { userId: user.id } }));
    } finally { restore(); }
  }
});

it("preserves the generic response through slow database lookup and failure paths", async () => {
  const original = prisma.user.findUnique;
  for (const fail of [false, true]) {
    prisma.user.findUnique = (async () => {
      await new Promise(resolve => setTimeout(resolve, 2200));
      if (fail) throw new Error("test database failure");
      return null;
    }) as unknown as typeof prisma.user.findUnique;
    try {
      const started = performance.now();
      const result = await post("/auth/forgot-password", { email: `${randomUUID()}@example.test` });
      assert.ok(performance.now() - started >= 2150);
      assert.deepEqual(result, { status: 200, body: { message: "If an account exists, a password reset email has been sent" } });
    } finally { prisma.user.findUnique = original; }
  }
});

it("ignores forwarding headers entirely when no proxy is trusted", async () => {
  const application = express();
  application.get("/", (req, res) => {
    assert.equal(req.ip, req.socket.remoteAddress);
    res.sendStatus(204);
  });
  const listener = application.listen(0);
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const address = listener.address(); assert.ok(address && typeof address !== "string");
  try {
    for (const forwarded of ["2001:db8::1", "192.0.2.42", "spoofed"]) {
      const response: Response = await fetch(`http://127.0.0.1:${address.port}/`, { headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, "X-Forwarded-For": forwarded } });
      assert.equal(response.status, 204);
    }
  } finally { await new Promise<void>(resolve => listener.close(() => resolve())); }
});
