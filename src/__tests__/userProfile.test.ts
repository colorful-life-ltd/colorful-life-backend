import assert from "node:assert";
import type { Server } from "node:http";
import { describe, it, before, after, afterEach } from "node:test";
import { prisma } from "../prisma/runtime.js";
import app from "../app.js";
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import { randomUUID } from "node:crypto";
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

describe("User Profile API", () => {
  let server: Server;
  let url: string;
  const userIdsForCleanup: number[] = [];

  before(async () => {
    const { server: srv, url: u } = await startServer();
    server = srv;
    url = u;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  afterEach(async () => {
    if (userIdsForCleanup.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIdsForCleanup } } });
      userIdsForCleanup.length = 0;
    }
  });

  async function signupAndLogin(email: string, password: string) {
    const signupRes = await fetch(`${url}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const signupBody = await signupRes.json();
    assert.strictEqual(signupRes.status, 201);
    assert.ok(signupBody.token);
    recordUserIdFromToken(signupBody.token, userIdsForCleanup);
    const userId = (jwt.decode(signupBody.token) as { id: number }).id;
    await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
    const loginRes = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const loginBody = await loginRes.json();
    return { token: loginBody.token, email: email.toLowerCase() };
  }

  // GET /users/me
  it("GET /users/me returns authenticated profile and hides sensitive fields", async () => {
    const { token, email } = await signupAndLogin(`profile-${randomUUID()}@example.com`, "Abcdef1!");
    const res = await fetch(`${url}/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const profile = await res.json();
    assert.strictEqual(typeof profile.id, "number");
    assert.strictEqual(profile.email, email);
    assert.ok(!profile.hasOwnProperty("role"));
    assert.ok(!profile.hasOwnProperty("passwordHash"));
  });

  it("GET /users/me without auth returns 401", async () => {
    const res = await fetch(`${url}/users/me`);
    assert.strictEqual(res.status, 401);
  });

  // PATCH /users/me
  it("PATCH /users/me without authentication returns 401", async () => {
    const res = await fetch(`${url}/users/me`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ firstName: "NoAuth" }),
    });
    assert.strictEqual(res.status, 401);
  });

  it("PATCH /users/me rejects invalid editable values (empty firstName)", async () => {
    const { token } = await signupAndLogin(`invalid-${randomUUID()}@example.com`, "Abcdef1!");
    for (const payload of [{firstName:"  "},{firstName:"x".repeat(81)},{lastName:"x".repeat(81)},{phone:"invalid"},{phone:"1".repeat(33)}]) {
      const res = await fetch(`${url}/users/me`, {method:"PATCH",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(payload)});
      assert.strictEqual(res.status,400);
    }
  });

  it("PATCH /users/me with empty body returns 400", async () => {
    const { token } = await signupAndLogin(`empty-${randomUUID()}@example.com`, "Abcdef1!");
    const res = await fetch(`${url}/users/me`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.strictEqual(res.status, 400);
  });

  it("PATCHing only one editable field leaves omitted fields unchanged in DB", async () => {
    const { token } = await signupAndLogin(`partial-${randomUUID()}@example.com`, "Abcdef1!");
    // First set all fields
    const initPayload = { firstName: "Initial", lastName: "User", phone: "07700900123" };
    const initRes = await fetch(`${url}/users/me`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(initPayload),
    });
    assert.strictEqual(initRes.status, 200);
    // Now patch only firstName
    const patchPayload = { firstName: "Updated" };
    const res = await fetch(`${url}/users/me`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patchPayload),
    });
    assert.strictEqual(res.status, 200);
    const updated = await res.json();
    assert.strictEqual(updated.firstName, patchPayload.firstName);
    const userInDb = await prisma.user.findUnique({ where: { id: updated.id } });
    assert.ok(userInDb);
    assert.strictEqual(userInDb?.lastName, initPayload.lastName);
    assert.strictEqual(userInDb?.phone, initPayload.phone);
  });

  it("PATCH normalizes leading/trailing whitespace before persistence", async () => {
    const { token } = await signupAndLogin(`normalize-${randomUUID()}@example.com`, "Abcdef1!");
    const payload = { firstName: "  TrimMe  ", lastName: "  KeepMe  " };
    const res = await fetch(`${url}/users/me`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    assert.strictEqual(res.status, 200);
    const updated = await res.json();
    const dbUser = await prisma.user.findUnique({ where: { id: updated.id } });
    assert.ok(dbUser);
    assert.strictEqual(dbUser?.firstName, payload.firstName.trim());
    assert.strictEqual(dbUser?.lastName, payload.lastName.trim());
  });

  it("PATCH response does not expose protected/sensitive fields", async () => {
    const { token } = await signupAndLogin(`sensitive-${randomUUID()}@example.com`, "Abcdef1!");
    const res = await fetch(`${url}/users/me`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ firstName: "Secure" }),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.ok(!body.hasOwnProperty("role"));
    assert.ok(!body.hasOwnProperty("passwordHash"));
  });

  it("PATCH /users/me attempts to modify protected fields and returns 400", async () => {
    const { token, email } = await signupAndLogin(`protected-${randomUUID()}@example.com`, "Abcdef1!");
    const res = await fetch(`${url}/users/me`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "ADMIN", email: "hacker@example.com" }),
    });
    assert.strictEqual(res.status, 400);
    const userInDb = await prisma.user.findUnique({ where: { email } });
    assert.ok(userInDb);
    assert.strictEqual(userInDb?.role, "CUSTOMER");
  });

  it("PATCH /users/me cannot modify another user via id field", async () => {
    const { token } = await signupAndLogin(`other-${randomUUID()}@example.com`, "Abcdef1!");
    const other = await prisma.user.create({ data: { email: `second-${randomUUID()}@example.com`, passwordHash: "dummy" } });
    userIdsForCleanup.push(other.id);
    const res = await fetch(`${url}/users/me`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: other.id, firstName: "Hacker" }),
    });
    assert.strictEqual(res.status, 200);
    const updated = await res.json();
    const otherInDb = await prisma.user.findUnique({ where: { id: other.id } });
    assert.ok(otherInDb);
    assert.strictEqual(otherInDb?.firstName, null);
  });
});
