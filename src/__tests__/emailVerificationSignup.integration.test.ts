import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { hashEmailVerificationToken } from "../domain/auth/emailVerificationService.js";
import bcrypt from "bcrypt";
import { setVerificationEmailSenderForTests, type VerificationEmail } from "../services/emailService.js";
// Public registration is closed by default; these tests exercise the signup flow explicitly.
before(() => { config.REGISTRATION_ENABLED = true; });

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

after(async () => {
  await prisma.$disconnect();
  server.close();
});

describe("signup verification email integration", () => {
  it("persists a hashed token and sends a trusted verification URL", async () => {
    let email: VerificationEmail | undefined;
    restoreSender = setVerificationEmailSenderForTests(async (value) => { email = value; });
    const registeredEmail = `Verify-${randomUUID()}@Example.COM`;
    const response = await fetch(`${url}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `  ${registeredEmail}  `, password: "Abcdef1!" }),
    });
    const body = await response.json();
    assert.strictEqual(response.status, 202);
    assert.deepStrictEqual(Object.keys(body), ["message"]);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: registeredEmail.trim().toLowerCase() } });
    userIds.push(user.id);
    const token = await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } });
    assert.strictEqual(user?.email, registeredEmail.trim().toLowerCase());
    assert.strictEqual(user?.emailVerified, false);
    assert.ok(token);
    assert.ok(email);
    const rawToken = new URL(email!.verificationUrl).searchParams.get("token");
    assert.ok(rawToken);
    assert.strictEqual(token!.tokenHash, hashEmailVerificationToken(rawToken!));
    assert.strictEqual(new URL(email!.verificationUrl).origin, config.FRONTEND_URL);
    assert.strictEqual(email!.recipientEmail, registeredEmail.trim().toLowerCase());
    assert.equal(JSON.stringify(body).includes(rawToken!), false);
  });

  it("registers with the email only, then activates the password chosen at verification", async () => {
    const emails: VerificationEmail[] = [];
    restoreSender = setVerificationEmailSenderForTests(async (value) => { emails.push(value); });
    const registeredEmail = `email-only-${randomUUID()}@example.com`;
    const post = (path: string, body: unknown) => fetch(`${url}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const first = await post("/auth/signup", { email: registeredEmail });
    assert.strictEqual(first.status, 202);
    const generic = await first.json();
    const user = await prisma.user.findUniqueOrThrow({ where: { email: registeredEmail } });
    userIds.push(user.id);
    assert.strictEqual(user.emailVerified, false);
    assert.strictEqual(emails.length, 1);
    // A repeated email-only registration answers identically and sends nothing new (no enumeration).
    const repeat = await post("/auth/signup", { email: registeredEmail });
    assert.strictEqual(repeat.status, 202);
    assert.deepStrictEqual(await repeat.json(), generic);
    assert.strictEqual(emails.length, 1);
    // Unverified accounts cannot sign in.
    assert.strictEqual((await post("/auth/login", { email: registeredEmail, password: "Chosen1!pass" })).status, 401);
    const rawToken = new URL(emails[0].verificationUrl).searchParams.get("token")!;
    assert.strictEqual((await post("/auth/verify-email", { token: rawToken })).status, 400, "verification still requires the new password");
    assert.strictEqual((await post("/auth/verify-email", { token: rawToken, newPassword: "Chosen1!pass" })).status, 200);
    const verified = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    assert.strictEqual(verified.emailVerified, true);
    assert.equal(await bcrypt.compare("Chosen1!pass", verified.passwordHash!), true);
    assert.strictEqual((await post("/auth/verify-email", { token: rawToken, newPassword: "Other1!pass" })).status, 400, "tokens are single-use");
    assert.strictEqual((await post("/auth/login", { email: registeredEmail, password: "Chosen1!pass" })).status, 200);
  });

  it("still rejects an invalid email, and a weak password from an older client, on email-only signup", async () => {
    restoreSender = setVerificationEmailSenderForTests(async () => undefined);
    const post = (body: unknown) => fetch(`${url}/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.strictEqual((await post({})).status, 400);
    assert.strictEqual((await post({ email: "not-an-email" })).status, 400);
    const weak = `weak-${randomUUID()}@example.com`;
    assert.strictEqual((await post({ email: weak, password: "short" })).status, 400);
    assert.equal(await prisma.user.findUnique({ where: { email: weak } }), null);
  });

  it("keeps signup successful and preserves the token when email delivery fails", async () => {
    restoreSender = setVerificationEmailSenderForTests(async () => { throw new Error("SES unavailable"); });
    const registeredEmail = `${randomUUID()}@example.com`;
    const response = await fetch(`${url}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: registeredEmail, password: "Abcdef1!" }),
    });
    assert.strictEqual(response.status, 202);
    const user = await prisma.user.findUniqueOrThrow({ where: { email: registeredEmail } });
    userIds.push(user.id);
    assert.ok(await prisma.emailVerificationToken.findUnique({ where: { userId: user.id } }));
  });

  it("rolls back the user when token persistence fails inside the signup transaction", async () => {
    const registeredEmail = `${randomUUID()}@example.com`;
    const originalTransaction = prisma.$transaction.bind(prisma);
    (prisma as any).$transaction = (callback: (tx: unknown) => Promise<unknown>) =>
      originalTransaction(async (tx) => {
        const failingTx = new Proxy(tx, {
          get(target, property, receiver) {
            if (property === "emailVerificationToken") {
              return new Proxy(Reflect.get(target, property, receiver), {
                get(tokenTarget, tokenProperty, tokenReceiver) {
                  if (tokenProperty === "upsert") {
                    return async () => { throw new Error("token persistence failed"); };
                  }
                  return Reflect.get(tokenTarget, tokenProperty, tokenReceiver);
                },
              });
            }
            return Reflect.get(target, property, receiver);
          },
        });
        return callback(failingTx);
      });

    try {
      const response = await fetch(`${url}/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: registeredEmail, password: "Abcdef1!" }),
      });
      assert.strictEqual(response.status, 500);
      assert.equal(await prisma.user.findUnique({ where: { email: registeredEmail } }), null);
      assert.equal(await prisma.emailVerificationToken.findFirst({ where: { user: { email: registeredEmail } } }), null);
    } finally {
      (prisma as any).$transaction = originalTransaction;
    }
  });
});
