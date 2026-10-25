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

describe("Address API", () => {
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

  // Helpers
  async function signup(email: string, password: string) {
    const res = await fetch(`${url}/auth/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    if (res.status === 201 && body.token) {
      recordUserIdFromToken(body.token, userIdsForCleanup);
      const userId = (jwt.decode(body.token) as { id: number }).id;
      await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
    }
    return { res, body };
  }

  async function login(email: string, password: string) {
    const res = await fetch(`${url}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    return { res, body };
  }

  async function getToken(email: string, password: string) {
    const { body } = await login(email, password);
    return body.token;
  }

  it("normalises UK addresses, rejects bad input and serialises duplicate creation", async () => {
    const {body}=await signup(`rules-${randomUUID()}@example.com`,"Abcdef1!");
    const token=body.token;
    const input={recipientName:"Sandbox Buyer",line1:"1 Test Road",city:"London",postcode:"  sw1a   1aa  ",country:"GB",phone:"+44 7700 900123"};
    const post=(data:object)=>fetch(`${url}/users/me/addresses`,{method:"POST",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify(data)});
    for(const patch of [{postcode:"nonsense"},{country:"US"},{line1:"x".repeat(201)},{phone:"not-a-number"}])assert.equal((await post({...input,...patch})).status,400);
    const results=await Promise.all([post(input),post({...input,recipientName:" sandbox   buyer ",postcode:"SW1A 1AA"})]);
    assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
    const created=await results.find(r=>r.status===201)!.json();assert.equal(created.postcode,"SW1A 1AA");
    const patchPostcode=await fetch(`${url}/users/me/addresses/${created.id}`,{method:"PATCH",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({postcode:"  sw1a   1aa  "})});
    assert.equal(patchPostcode.status,200);assert.equal((await patchPostcode.json()).postcode,"SW1A 1AA");
    const other=await post({...input,recipientName:"Another Recipient"});assert.equal(other.status,201);
    const otherBody=await other.json();
    const patch=await fetch(`${url}/users/me/addresses/${otherBody.id}`,{method:"PATCH",headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},body:JSON.stringify({recipientName:input.recipientName,isDefaultBilling:true})});
    assert.equal(patch.status,409);
    const rows=await prisma.address.findMany({where:{userId:created.userId??(jwt.decode(token) as {id:number}).id}});
    assert.equal(rows.length,2);assert.equal(rows.filter(r=>r.isDefaultBilling).length,1);assert.equal(rows.find(r=>r.isDefaultBilling)!.id,created.id);
  });

  it("GET empty list for new user", async () => {
    const email = `user-${randomUUID()}@example.com`;
    const password = "Abcdef1!";
    const { body: signupBody } = await signup(email, password);
    const token = signupBody.token;
    const res = await fetch(`${url}/users/me/addresses`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(res.status, 200);
    const addresses = await res.json();
    assert.deepStrictEqual(addresses, []);
  });

  it("POST creates first address with defaults", async () => {
    const email = `user-${randomUUID()}@example.com`;
    const password = "Abcdef1!";
    const { body: signupBody } = await signup(email, password);
    const token = signupBody.token;
    const payload = await fetch(`${url}/users/me/addresses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientName: "John Doe",
        line1: "123 Main St",
        city: "Anytown",
        postcode: "SW1A 1AA",
        country: "GB",
      }),
    });
    const res = await payload.json();
    assert.strictEqual(payload.status, 201);
    assert.strictEqual(res.recipientName, "John Doe");
    assert.strictEqual(res.isDefaultShipping, true);
    assert.strictEqual(res.isDefaultBilling, true);
  });

  it("POST second address can set default shipping", async () => {
    const email = `user-${randomUUID()}@example.com`;
    const password = "Abcdef1!";
    const { body: signupBody } = await signup(email, password);
    const token = signupBody.token;
    // Create first address
    await fetch(`${url}/users/me/addresses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientName: "John Doe",
        line1: "123 Main St",
        city: "Anytown",
        postcode: "SW1A 1AA",
        country: "GB",
      }),
    });
    // Create second address with isDefaultShipping true
    const res = await fetch(`${url}/users/me/addresses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientName: "Jane Smith",
        line1: "456 Oak Ave",
        city: "Othertown",
        postcode: "SW1A 2AA",
        country: "GB",
        isDefaultShipping: true,
      }),
    });
    const data = await res.json();
    assert.strictEqual(res.status, 201);
    assert.strictEqual(data.recipientName, "Jane Smith");
    assert.strictEqual(data.isDefaultShipping, true);
    // Verify first address is no longer default shipping
    const list = await fetch(`${url}/users/me/addresses`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const addresses = await list.json();
    const first = addresses.find((a: any) => a.recipientName === "John Doe");
    assert.ok(first);
    assert.strictEqual(first.isDefaultShipping, false);
  });

  it("PATCH updates fields and preserves defaults", async () => {
    const email = `user-${randomUUID()}@example.com`;
    const password = "Abcdef1!";
    const { body: signupBody } = await signup(email, password);
    const token = signupBody.token;
    // Create address
    const createRes = await fetch(`${url}/users/me/addresses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientName: "John Doe",
        line1: "123 Main St",
        city: "Anytown",
        postcode: "SW1A 1AA",
        country: "GB",
      }),
    });
    const created = await createRes.json();
    // Patch
    const patchRes = await fetch(`${url}/users/me/addresses/${created.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ city: "New City" }),
    });
    const patched = await patchRes.json();
    assert.strictEqual(patchRes.status, 200);
    assert.strictEqual(patched.city, "New City");
    assert.strictEqual(patched.isDefaultShipping, true);
    assert.strictEqual(patched.isDefaultBilling, true);
  });

  it("PATCH cannot unset default when other addresses exist", async () => {
    const email = `user-${randomUUID()}@example.com`;
    const password = "Abcdef1!";
    const { body: signupBody } = await signup(email, password);
    const token = signupBody.token;
    // Create two addresses
    await fetch(`${url}/users/me/addresses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientName: "First",
        line1: "A",
        city: "A",
        postcode: "SW1A 1AA",
        country: "GB",
      }),
    });
    const secondRes = await fetch(`${url}/users/me/addresses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientName: "Second",
        line1: "B",
        city: "B",
        postcode: "SW1A 2AA",
        country: "GB",
        isDefaultShipping: true,
      }),
    });
    const second = await secondRes.json();
    // Attempt to unset default shipping on second address
    const patchRes = await fetch(`${url}/users/me/addresses/${second.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ isDefaultShipping: false }),
    });
    assert.strictEqual(patchRes.status, 400);
  });

  it("DELETE non-default address", async () => {
    const email = `user-${randomUUID()}@example.com`;
    const password = "Abcdef1!";
    const { body: signupBody } = await signup(email, password);
    const token = signupBody.token;
    // Create two addresses
    const firstRes = await fetch(`${url}/users/me/addresses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientName: "First",
        line1: "A",
        city: "A",
        postcode: "SW1A 1AA",
        country: "GB",
      }),
    });
    const first = await firstRes.json();
    const secondRes = await fetch(`${url}/users/me/addresses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientName: "Second",
        line1: "B",
        city: "B",
        postcode: "SW1A 2AA",
        country: "GB",
        isDefaultShipping: true,
      }),
    });
    const second = await secondRes.json();
    // Delete first (non-default)
    const delRes = await fetch(`${url}/users/me/addresses/${first.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(delRes.status, 204);
    // Verify second remains default
    const list = await fetch(`${url}/users/me/addresses`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const addresses = await list.json();
    const remaining = addresses[0];
    assert.strictEqual(remaining.isDefaultShipping, true);
  });

  it("DELETE default shipping promotes next address", async () => {
    const email = `user-${randomUUID()}@example.com`;
    const password = "Abcdef1!";
    const { body: signupBody } = await signup(email, password);
    const token = signupBody.token;
    // Create two addresses
    const firstRes = await fetch(`${url}/users/me/addresses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientName: "First",
        line1: "A",
        city: "A",
        postcode: "SW1A 1AA",
        country: "GB",
      }),
    });
    const first = await firstRes.json();
    const secondRes = await fetch(`${url}/users/me/addresses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        recipientName: "Second",
        line1: "B",
        city: "B",
        postcode: "SW1A 2AA",
        country: "GB",
        isDefaultShipping: true,
      }),
    });
    const second = await secondRes.json();
    // Delete second (default shipping)
    const delRes = await fetch(`${url}/users/me/addresses/${second.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.strictEqual(delRes.status, 204);
    // Verify first promoted
    const list = await fetch(`${url}/users/me/addresses`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const addresses = await list.json();
    const promoted = addresses[0];
    assert.strictEqual(promoted.recipientName, "First");
    assert.strictEqual(promoted.isDefaultShipping, true);
  });
});
