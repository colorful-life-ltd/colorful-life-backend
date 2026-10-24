import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { hashEmailVerificationToken } from "../domain/auth/emailVerificationService.js";
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
    assert.strictEqual(response.status, 201);
    assert.deepStrictEqual(Object.keys(body), ["token"]);
    const payload = jwt.verify(body.token, config.JWT_SECRET) as Record<string, unknown>;
    userIds.push(payload.id as number);
    const user = await prisma.user.findUnique({ where: { id: payload.id as number } });
    const token = await prisma.emailVerificationToken.findUnique({ where: { userId: payload.id as number } });
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
    assert.equal(JSON.stringify(payload).includes(rawToken!), false);
  });

  it("keeps signup successful and preserves the token when email delivery fails", async () => {
    restoreSender = setVerificationEmailSenderForTests(async () => { throw new Error("SES unavailable"); });
    const response = await fetch(`${url}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `${randomUUID()}@example.com`, password: "Abcdef1!" }),
    });
    const body = await response.json();
    assert.strictEqual(response.status, 201);
    const payload = jwt.verify(body.token, config.JWT_SECRET) as Record<string, unknown>;
    userIds.push(payload.id as number);
    assert.ok(await prisma.user.findUnique({ where: { id: payload.id as number } }));
    assert.ok(await prisma.emailVerificationToken.findUnique({ where: { userId: payload.id as number } }));
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
