import assert from "node:assert";
import type { Server } from "node:http";
import { describe, it, before, after, afterEach } from "node:test";
import { prisma } from "../prisma/runtime.js";
import app from "../app.js";
import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";
import { config } from "../config/index.js";
import { randomUUID } from "node:crypto";
import { setVerificationEmailSenderForTests } from "../services/emailService.js";
// Public registration is closed by default; these tests exercise the signup flow explicitly.
before(() => { config.REGISTRATION_ENABLED = true; });

/**
 * Helper to start the Express app on an OS‑assigned port.
 */
async function startServer(): Promise<{ server: Server; url: string }> {
  const server = app.listen(0);
  return new Promise((resolve, reject) => {
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to obtain server address"));
        return;
      }
      const url = `http://localhost:${address.port}`;
      resolve({ server, url });
    });
  });
}

/**
 * Record the user ID extracted from a JWT so it can be cleaned up after each test.
 */
function recordUserIdFromToken(token: string, cleanupArray: number[]) {
  const payload = jwt.verify(token, config.JWT_SECRET) as any;
  cleanupArray.push(payload.id as number);
}

describe("Auth API", () => {
  let server: Server;
  let url: string;
  const userIdsForCleanup: number[] = [];
  let restoreVerificationSender: (() => void) | undefined;

  before(async () => {
    restoreVerificationSender = setVerificationEmailSenderForTests(async () => undefined);
    const { server: srv, url: u } = await startServer();
    server = srv;
    url = u;
  });

  after(async () => {
    restoreVerificationSender?.();
    await new Promise((resolve) => server.close(resolve));
  });

  afterEach(async () => {
    if (userIdsForCleanup.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIdsForCleanup } } });
      userIdsForCleanup.length = 0;
    }
  });

  /**
   * Helper to create a user via the public signup API.
   * Automatically tracks the created user for cleanup when the signup is
   * successful (status 201 with a token in the response body).
   */
  async function signup(url: string, email: string, password: string) {
    const res = await fetch(`${url}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    if (res.status === 201 && body.token) {
      recordUserIdFromToken(body.token, userIdsForCleanup);
    }
    return { res, body };
  }

  /**
   * Helper to log in a user via the public login API.
   */
  async function login(url: string, email: string, password: string) {
    const res = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    return { res, body };
  }

  // --------------------- Signup tests ---------------------------------
  it("valid signup returns 201 and a token", async () => {
    const email = `user-${randomUUID()}@example.com`;
    const password = "Abcdef1!";
    const { res, body } = await signup(url, email, password);
    assert.strictEqual(res.status, 201);
    assert.ok(body.token, "Token should be present");
  });

  it("signup persistence and password security", async () => {
    const rawEmail = `user-${randomUUID()}@example.com`;
    const password = "Strong1!";
    const { res, body } = await signup(url, rawEmail, password);
    assert.strictEqual(res.status, 201);
    const token = body.token;
    const payload = jwt.verify(token, config.JWT_SECRET) as any;
    const userId = payload.id as number;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    assert.ok(user, "User should exist in DB");
    assert.strictEqual(user.email, rawEmail.toLowerCase(), "Email should be normalized to lowercase");
    assert.ok(user.passwordHash, "passwordHash should exist");
    assert.notStrictEqual(user.passwordHash, password, "passwordHash should not equal plaintext");
    const matches = await bcrypt.compare(password, user.passwordHash!);
    assert.ok(matches, "bcrypt.compare should succeed");
    assert.ok(!body.hasOwnProperty("passwordHash"), "Response should not expose passwordHash");
  });

  it("signup rejects passwords failing each strength rule", async () => {
    const baseEmail = `pass-${randomUUID()}@example.com`;
    const testCases = [
      { pwd: "Ab1!", desc: "too short" },
      { pwd: "ABCDEF1!", desc: "no lowercase" },
      { pwd: "abcdef1!", desc: "no uppercase" },
      { pwd: "Abcdefgh!", desc: "no digit" },
      { pwd: "Abcdef12", desc: "no special" },
    ];
    for (const { pwd, desc } of testCases) {
      const { res } = await signup(url, baseEmail, pwd);
      assert.strictEqual(res.status, 400, `Expected 400 for ${desc}`);
    }
  });

  it("signup rejects invalid email", async () => {
    const { res } = await signup(url, "invalid-email", "Abcdef1!");
    assert.strictEqual(res.status, 400);
  });

  it("signup normalizes email with surrounding whitespace and mixed case", async () => {
    const rawEmail = `  MixedCase-${randomUUID()}@Example.COM  `;
    const password = "Abcdef1!";
    const { res, body } = await signup(url, rawEmail, password);
    assert.strictEqual(res.status, 201);
    const token = body.token;
    const payload = jwt.verify(token, config.JWT_SECRET) as any;
    const userId = payload.id as number;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    assert.ok(user, "User should exist");
    const expectedEmail = rawEmail.trim().toLowerCase();
    assert.strictEqual(user.email, expectedEmail, "Email should be trimmed and lowercased");
  });

  it("signup rejects duplicate normalized email", async () => {
    const baseEmail = `dup-${randomUUID()}@example.com`;
    const password = "Abcdef1!";
    const { res: res1, body: body1 } = await signup(url, baseEmail, password);
    assert.strictEqual(res1.status, 201);
    // Attempt duplicate with different case
    const { res: res2 } = await signup(url, baseEmail.toUpperCase(), password);
    assert.strictEqual(res2.status, 409, "Duplicate email should yield 409");
    const users = await prisma.user.findMany({ where: { email: baseEmail.toLowerCase() } });
    assert.strictEqual(users.length, 1, "Only one user should exist for normalized email");
  });

  // --------------------- Login tests ----------------------------------
  it("successful login returns 200 and token", async () => {
    const email = `login-${randomUUID()}@example.com`;
    const password = "Abcdef1!";
    await signup(url, email, password);
    const { res: loginRes, body } = await login(url, email, password);
    assert.strictEqual(loginRes.status, 200);
    assert.ok(body.token, "Login should return a token");
    const payload = jwt.verify(body.token, config.JWT_SECRET) as any;
    assert.strictEqual(payload.role, "CUSTOMER");
  });

  it("login email normalization works", async () => {
    const rawEmail = `Norm-${randomUUID()}@Example.com`;
    const password = "Abcdef1!";
    await signup(url, rawEmail, password);
    const { res: loginRes, body } = await login(url, rawEmail.toUpperCase(), password);
    assert.strictEqual(loginRes.status, 200);
    assert.ok(body.token);
  });

  it("login with wrong password returns 401", async () => {
    const email = `wrong-${randomUUID()}@example.com`;
    const password = "Abcdef1!";
    await signup(url, email, password);
    const { res, body } = await login(url, email, "WrongPass1!");
    assert.strictEqual(res.status, 401);
    assert.deepEqual(body, { error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } });
  });

  it("login with unknown email returns 401", async () => {
    const { res, body } = await login(url, `unknown-${randomUUID()}@example.com`, "Abcdef1!");
    assert.strictEqual(res.status, 401);
    assert.deepEqual(body, { error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } });
  });

  it("login payload validation – missing or malformed fields", async () => {
    // Missing email
    let res = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "Abcdef1!" }),
    });
    assert.strictEqual(res.status, 400);
    // Missing password
    res = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: `missing-${randomUUID()}@example.com` }),
    });
    assert.strictEqual(res.status, 400);
    // Malformed email
    res = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bad", password: "Abcdef1!" }),
    });
    assert.strictEqual(res.status, 400);
  });

  // --------------------- JWT & Middleware tests -----------------------
  it("profile endpoint requires valid token and returns user data", async () => {
    const email = `profile-${randomUUID()}@example.com`;
    const password = "Abcdef1!";
    await signup(url, email, password);
    await prisma.user.update({ where: { email: email.toLowerCase() }, data: { emailVerified: true } });
    const { body: loginBody } = await login(url, email, password);
    const token = loginBody.token;
    const res = await fetch(`${url}/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const profile = await res.json();
    assert.ok(profile.id, "Profile should contain id");
    assert.strictEqual(profile.email.toLowerCase(), email.toLowerCase());
    assert.strictEqual(profile.role, "CUSTOMER");
    assert.ok(!profile.hasOwnProperty("passwordHash"), "Profile should not expose passwordHash");
  });

  it("profile missing Authorization header returns 401", async () => {
    const res = await fetch(`${url}/profile`);
    assert.strictEqual(res.status, 401);
    assert.deepEqual(await res.json(), { error: { code: "AUTH_REQUIRED", message: "Missing or invalid authorization header" } });

    const malformedHeader = await fetch(`${url}/profile`, { headers: { Authorization: "Basic abc123" } });
    assert.strictEqual(malformedHeader.status, 401);
    assert.deepEqual(await malformedHeader.json(), { error: { code: "AUTH_REQUIRED", message: "Missing or invalid authorization header" } });
  });

  it("profile with malformed and invalid-signature tokens returns SESSION_INVALID", async () => {
    const res = await fetch(`${url}/profile`, {
      headers: { Authorization: "Bearer invalid.token.here" },
    });
    assert.strictEqual(res.status, 401);
    assert.deepEqual(await res.json(), { error: { code: "SESSION_INVALID", message: "Invalid or expired token" } });

    const invalidSignature = jwt.sign({ id: 1, role: "ADMIN" }, "not-the-configured-secret");
    const invalidSignatureResponse = await fetch(`${url}/profile`, {
      headers: { Authorization: `Bearer ${invalidSignature}` },
    });
    assert.strictEqual(invalidSignatureResponse.status, 401);
    assert.deepEqual(await invalidSignatureResponse.json(), { error: { code: "SESSION_INVALID", message: "Invalid or expired token" } });
  });

  it("profile with expired token returns 401", async () => {
    const email = `expired-${randomUUID()}@example.com`;
    const password = "Abcdef1!";
    const { body: signupBody } = await signup(url, email, password);
    const payload = jwt.verify(signupBody.token, config.JWT_SECRET) as any;
    const expiredToken = jwt.sign({ id: payload.id, role: payload.role }, config.JWT_SECRET, { expiresIn: "-1s" });
    const res = await fetch(`${url}/profile`, {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    assert.strictEqual(res.status, 401);
    assert.deepEqual(await res.json(), { error: { code: "SESSION_INVALID", message: "Invalid or expired token" } });
  });
});

/**
 * NOTE: The test suite verifies that surrounding‑whitespace is trimmed
 * before the Zod schema validation. The current production controller
 * performs Zod validation **before** calling `trim().toLowerCase()`.
 * Therefore, if a signup request includes leading/trailing spaces in the
 * email, the Zod schema may reject the request, causing a mismatch
 * between expected behaviour (whitespace normalisation) and actual
 * implementation.
 *
 * This mismatch is reported for human review and should not be silently
 * fixed by modifying production code.
 */
