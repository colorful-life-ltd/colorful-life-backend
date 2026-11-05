import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { setPasswordResetEmailSenderForTests, setVerificationEmailSenderForTests, type PasswordResetEmail, type VerificationEmail } from "../services/emailService.js";
import { setEmailCredentialReadinessForTests } from "../services/sesRuntime.js";
import { SES_SESSION_FILE_NAME, SesCredentialsUnavailableError, resetSesCredentialObservationForTests, type SesCredentialProblem } from "../services/sesCredentials.js";
import { createOrReplaceEmailVerificationToken, hashEmailVerificationToken } from "../domain/auth/emailVerificationService.js";

// Synthetic only: no real SES, credentials or Production access.
const SOURCE = "arn:aws:sts::000000000000:federated-user/colorful-production-mail";
const userIds: number[] = [];
const restores: Array<() => void> = [];
const recoveryClientIp = `2001:db8:${randomUUID().replaceAll("-", "").slice(0, 20).match(/.{4}/g)!.join(":")}:1`;
let server: Server;
let url: string;
let logs: string[] = [];
const consoleError = console.error, consoleInfo = console.info;

before(async () => {
  config.REGISTRATION_ENABLED = true;
  app.set("trust proxy", "loopback");
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  url = `http://localhost:${address.port}`;
});
afterEach(async () => {
  while (restores.length) restores.pop()!();
  console.error = consoleError; console.info = consoleInfo;
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  userIds.length = 0;
});
after(async () => { await prisma.$disconnect(); server.close(); });

function captureLogs() {
  logs = [];
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  console.info = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
}
function unavailable(reason: SesCredentialProblem = "expired") {
  restores.push(setEmailCredentialReadinessForTests(async () => ({ ready: false, reason })));
}
function verificationSender(sender: (email: VerificationEmail) => Promise<void>) { restores.push(setVerificationEmailSenderForTests(sender)); }
function resetSender(sender: (email: PasswordResetEmail) => Promise<void>) { restores.push(setPasswordResetEmailSenderForTests(sender)); }
const post = (path: string, body: unknown, token?: string) => fetch(`${url}${path}`, { method: "POST",
  headers: { "Content-Type": "application/json", "X-Forwarded-For": recoveryClientIp, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
const bearer = (user: { id: number; role: string; credentialVersion: string | null }) =>
  jwt.sign({ id: user.id, role: user.role, credentialVersion: user.credentialVersion ?? null }, config.JWT_SECRET, { expiresIn: "1h" });
async function makeUser(emailVerified: boolean, password = "Abcdef1!") {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, passwordHash: await bcrypt.hash(password, 4), emailVerified } });
  userIds.push(user.id);
  return user;
}
async function signup(email = `${randomUUID()}@example.com`) {
  const response = await post("/auth/signup", { email, password: "Abcdef1!" });
  const body = await response.json();
  if (response.status === 201) userIds.push((jwt.decode(body.token) as { id: number }).id);
  return { response, body, email };
}
/** Customer-facing bodies must not reveal internals. */
function assertGeneric(body: unknown) {
  const text = JSON.stringify(body).toLowerCase();
  for (const word of ["ses", "aws", "credential", "expired", "token", "session", "arn", "/run"]) assert.equal(text.includes(word), false, `exposes ${word}: ${text}`);
}

describe("signup email readiness guard", () => {
  it("refuses signup before any account, token or abuse-limit write when SES credentials are unavailable", async () => {
    for (const reason of ["missing", "expired", "malformed", "unverifiable_source"] as const) {
      unavailable(reason);
      let sends = 0; verificationSender(async () => { sends++; });
      const usersBefore = await prisma.user.count();
      const tokensBefore = await prisma.emailVerificationToken.count();
      const { response, body, email } = await signup();
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("retry-after"), "300");
      assert.equal(body.error.code, "REGISTRATION_TEMPORARILY_UNAVAILABLE");
      assertGeneric(body);
      assert.equal(sends, 0);
      assert.equal(await prisma.user.findUnique({ where: { email } }), null);
      assert.equal(await prisma.user.count(), usersBefore);
      assert.equal(await prisma.emailVerificationToken.count(), tokensBefore);
      while (restores.length) restores.pop()!();
    }
  });

  it("does not reveal existing accounts while closed", async () => {
    const existing = await makeUser(true);
    unavailable();
    const { response, body } = await signup(existing.email);
    assert.equal(response.status, 503);
    assert.equal(body.error.code, "REGISTRATION_TEMPORARILY_UNAVAILABLE");
  });

  it("still applies the registration switch first", async () => {
    unavailable();
    config.REGISTRATION_ENABLED = false;
    try {
      const { response, body } = await signup();
      assert.equal(response.status, 403);
      assert.equal(body.error.code, "REGISTRATION_DISABLED");
    } finally { config.REGISTRATION_ENABLED = true; }
  });

  it("opens and closes with the mounted session file, without a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ses-guard-")); chmodSync(dir, 0o700);
    const saved = [config.SES_SESSION_DIRECTORY, config.SES_SESSION_SOURCE_ARN, process.env.NODE_ENV];
    const install = (expiresAt: number) => {
      const temp = join(dir, ".next"); writeFileSync(temp, JSON.stringify({
        Credentials: { AccessKeyId: "ASIAGUARD00000000000", SecretAccessKey: "SECRETMARKER-guard", SessionToken: "TOKENMARKER-guard", Expiration: new Date(expiresAt).toISOString() },
        FederatedUser: { Arn: SOURCE } }), { mode: 0o600 });
      renameSync(temp, join(dir, SES_SESSION_FILE_NAME));
    };
    captureLogs(); resetSesCredentialObservationForTests();
    try {
      config.SES_SESSION_DIRECTORY = dir; config.SES_SESSION_SOURCE_ARN = SOURCE;
      // Production readiness rules; actual sending stays on the injected test sender.
      process.env.NODE_ENV = "production";
      const sent: VerificationEmail[] = []; verificationSender(async email => { sent.push(email); });
      assert.equal((await signup()).response.status, 503, "no session installed");
      assert.equal((await fetch(`${url}/ready/email`)).status, 503);
      install(Date.now() + 3_600_000);
      const opened = await signup(); assert.equal(opened.response.status, 201, JSON.stringify(opened.body));
      assert.deepEqual(await (await fetch(`${url}/ready/email`)).json(), { status: "ready" });
      install(Date.now() + 60_000);
      assert.equal((await signup()).response.status, 503, "session about to expire closes signup");
      assert.equal(sent.length, 1);
      // Database readiness is independent: SES state must never fail API recovery health.
      assert.equal((await fetch(`${url}/ready`)).status, 200);
      for (const line of logs) for (const marker of ["SECRETMARKER", "TOKENMARKER", "ASIAGUARD", dir]) assert.equal(line.includes(marker), false, line);
      assert.ok(logs.some(line => line.includes('"ses_credentials_unavailable"')));
    } finally {
      [config.SES_SESSION_DIRECTORY, config.SES_SESSION_SOURCE_ARN] = saved;
      process.env.NODE_ENV = saved[2];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a recoverable unverified account when the send itself fails after readiness", async () => {
    captureLogs();
    verificationSender(async () => { throw Object.assign(new Error("SECRETMARKER transient"), { name: "Throttling" }); });
    const { response, body } = await signup();
    assert.equal(response.status, 201);
    const id = (jwt.decode(body.token) as { id: number }).id;
    const user = await prisma.user.findUniqueOrThrow({ where: { id } });
    assert.equal(user.emailVerified, false);
    const token = await prisma.emailVerificationToken.findUniqueOrThrow({ where: { userId: id } });
    // A duplicate signup cannot create a second account.
    const retry = await post("/auth/signup", { email: user.email, password: "Abcdef1!" });
    assert.equal(retry.status, 409);
    assert.equal(await prisma.user.count({ where: { email: user.email } }), 1);
    // Resend recovers once SES accepts again.
    while (restores.length) restores.pop()!();
    const sent: VerificationEmail[] = []; verificationSender(async email => { sent.push(email); });
    const resend = await post("/auth/resend-verification", {}, body.token);
    assert.equal(resend.status, 200);
    assert.equal(sent.length, 1);
    assert.notEqual((await prisma.emailVerificationToken.findUniqueOrThrow({ where: { userId: id } })).tokenHash, token.tokenHash);
    assert.ok(logs.every(line => !line.includes("SECRETMARKER")));
  });
});

describe("verification resend", () => {
  it("refuses without touching the existing token when credentials are unavailable", async () => {
    const user = await makeUser(false);
    await prisma.emailVerificationToken.create({ data: { userId: user.id, tokenHash: "a".repeat(64), expiresAt: new Date(Date.now() + 3_600_000) } });
    unavailable("missing");
    let sends = 0; verificationSender(async () => { sends++; });
    const response = await post("/auth/resend-verification", {}, bearer(user));
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error.code, "EMAIL_DELIVERY_UNAVAILABLE");
    assertGeneric(body);
    assert.equal(sends, 0);
    assert.equal((await prisma.emailVerificationToken.findUniqueOrThrow({ where: { userId: user.id } })).tokenHash, "a".repeat(64));
  });

  it("does not claim success when the send fails", async () => {
    const user = await makeUser(false);
    verificationSender(async () => { throw new Error("SES unavailable"); });
    const response = await post("/auth/resend-verification", {}, bearer(user));
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.error.code, "EMAIL_DELIVERY_UNAVAILABLE");
    assert.equal(JSON.stringify(body).includes("has been sent"), false);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified, false);
  });
});

describe("verification resend token consistency", () => {
  const verify = (token: string) => post("/auth/verify-email", { token });
  // Definitive failures: SES provably did not accept the message.
  const definitive = [
    ["credentials unavailable", () => new SesCredentialsUnavailableError("expired")],
    ["message rejected", () => Object.assign(new Error("synthetic"), { name: "MessageRejected" })],
    ["connection not established", () => Object.assign(new Error("synthetic"), { code: "ECONNREFUSED" })],
  ] as const;
  for (const [label, failure] of definitive) it(`keeps the previously emailed link valid when the send definitively fails (${label})`, async () => {
    const user = await makeUser(false);
    const prior = await createOrReplaceEmailVerificationToken(user.id);
    assert.ok(prior.created);
    const before = await prisma.emailVerificationToken.findUniqueOrThrow({ where: { userId: user.id } });
    let attempts = 0; verificationSender(async () => { attempts++; throw failure(); });
    const response = await post("/auth/resend-verification", {}, bearer(user));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "EMAIL_DELIVERY_UNAVAILABLE");
    assert.equal(attempts, 1, "no automatic resend");
    assert.deepEqual(await prisma.emailVerificationToken.findUniqueOrThrow({ where: { userId: user.id } }), before);
    assert.equal((await verify(prior.rawToken)).status, 200);
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).emailVerified, true);
  });

  it("leaves no undeliverable token behind when there was no previous link", async () => {
    const user = await makeUser(false);
    verificationSender(async () => { throw new SesCredentialsUnavailableError("missing"); });
    assert.equal((await post("/auth/resend-verification", {}, bearer(user))).status, 503);
    assert.equal(await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } }), null);
    while (restores.length) restores.pop()!();
    const sent: VerificationEmail[] = []; verificationSender(async email => { sent.push(email); });
    assert.equal((await post("/auth/resend-verification", {}, bearer(user))).status, 200);
    assert.equal(sent.length, 1);
    assert.equal((await verify(new URL(sent[0].verificationUrl).searchParams.get("token")!)).status, 200);
  });

  it("keeps the new link when acceptance is ambiguous, so a possibly delivered email still works", async () => {
    const user = await makeUser(false);
    const prior = await createOrReplaceEmailVerificationToken(user.id);
    assert.ok(prior.created);
    let attempted: VerificationEmail | undefined;
    verificationSender(async email => { attempted = email; throw Object.assign(new Error("synthetic"), { name: "TimeoutError" }); });
    assert.equal((await post("/auth/resend-verification", {}, bearer(user))).status, 503);
    const current = await prisma.emailVerificationToken.findUniqueOrThrow({ where: { userId: user.id } });
    const attemptedToken = new URL(attempted!.verificationUrl).searchParams.get("token")!;
    assert.equal(current.tokenHash, hashEmailVerificationToken(attemptedToken));
    assert.equal((await verify(attemptedToken)).status, 200);
  });

  it("never overwrites a newer link issued by a concurrent resend", async () => {
    const user = await makeUser(false);
    await createOrReplaceEmailVerificationToken(user.id);
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    let entered!: () => void; const inFlight = new Promise<void>(r => { entered = r; });
    const delivered: VerificationEmail[] = [];
    let call = 0;
    verificationSender(async email => {
      if (++call === 1) { entered(); await gate; throw new SesCredentialsUnavailableError("expired"); }
      delivered.push(email);
    });
    const first = post("/auth/resend-verification", {}, bearer(user));
    await inFlight;
    assert.equal((await post("/auth/resend-verification", {}, bearer(user))).status, 200);
    release();
    assert.equal((await first).status, 503);
    const newer = new URL(delivered[0].verificationUrl).searchParams.get("token")!;
    assert.equal((await prisma.emailVerificationToken.findUniqueOrThrow({ where: { userId: user.id } })).tokenHash, hashEmailVerificationToken(newer));
    assert.equal((await verify(newer)).status, 200);
  });
});

describe("password reset", () => {
  it("answers generically, creates no token and preserves an emailed link when credentials are unavailable", async () => {
    const user = await makeUser(true);
    await prisma.passwordResetToken.create({ data: { userId: user.id, tokenHash: "b".repeat(64), expiresAt: new Date(Date.now() + 3_600_000) } });
    unavailable("expired");
    let sends = 0; resetSender(async () => { sends++; });
    const known = await post("/auth/forgot-password", { email: user.email });
    const unknown = await post("/auth/forgot-password", { email: `${randomUUID()}@example.com` });
    const generic = { message: "If an account exists, a password reset email has been sent" };
    assert.deepEqual([known.status, await known.json()], [200, generic]);
    assert.deepEqual([unknown.status, await unknown.json()], [200, generic]);
    assert.equal(sends, 0);
    assert.equal((await prisma.passwordResetToken.findUniqueOrThrow({ where: { userId: user.id } })).tokenHash, "b".repeat(64));
  });

  it("answers generically when the send fails", async () => {
    const user = await makeUser(true);
    resetSender(async () => { throw new Error("SES unavailable"); });
    const response = await post("/auth/forgot-password", { email: user.email });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: "If an account exists, a password reset email has been sent" });
  });
});

describe("existing accounts during an SES outage", () => {
  it("verified accounts still sign in", async () => {
    const user = await makeUser(true, "Verified1!");
    unavailable("missing");
    const response = await post("/auth/login", { email: user.email, password: "Verified1!" });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).token);
  });

  it("email change is refused before the address changes", async () => {
    const user = await makeUser(false, "Change1!");
    unavailable("expired");
    const response = await fetch(`${url}/users/me/email`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer(user)}` },
      body: JSON.stringify({ email: `${randomUUID()}@example.com`, password: "Change1!" }) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "EMAIL_DELIVERY_UNAVAILABLE");
    assert.equal((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).email, user.email);
  });
});
