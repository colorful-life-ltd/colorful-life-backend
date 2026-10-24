import assert from "node:assert";
import path from "node:path";
import fs from "node:fs";
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { config } from "../config/index.js";
import type { Server } from "node:http";
import { createHash } from "node:crypto";
import { prisma } from "../prisma/runtime.js";
import app from "../app.js";
// Public registration is closed by default; these tests exercise the signup flow explicitly.
before(() => { config.REGISTRATION_ENABLED = true; });

// Helper to start the server on a random port and return its URL
function startServer(): Promise<{ server: Server; url: string }> {
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

// Helper to create a new user and get an auth token
async function createTestUser(url: string): Promise<{ token: string; userId: number }> {
  const email = `import-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const password = "Test1234!";
  const signupRes = await fetch(`${url}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.strictEqual(signupRes.status, 201, "Signup should succeed");
  const signupBody = await signupRes.json();
  const token = signupBody.token;
  const payload = JSON.parse(
    Buffer.from(token.split(".")[1], "base64url").toString("utf8")
  );
  const userId = payload.id as number;
  await prisma.user.update({ where: { id: userId }, data: { emailVerified: true, role: "ADMIN" } });
  const loginRes = await fetch(`${url}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.strictEqual(loginRes.status, 200, "Admin login should succeed");
  const loginBody = await loginRes.json();
  return { token: loginBody.token as string, userId };
}

async function createVerifiedCustomer(url: string): Promise<{ token: string; userId: number }> {
  const email = `customer-import-test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const signupRes = await fetch(`${url}/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: "Test1234!" }) });
  const body = await signupRes.json();
  const token = body.token as string;
  const userId = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")).id as number;
  await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
  return { token, userId };
}

// Cleanup helper – delete all data related to a test user
async function cleanup(userId: number): Promise<void> {
  const purchaseDocs = await prisma.purchaseDocument.findMany({ where: { importedByUserId: userId } });
  const docIds = purchaseDocs.map((d) => d.id);
  const purchaseIds = purchaseDocs.map((d) => d.purchaseId);
  if (docIds.length) {
    await prisma.purchaseItem.deleteMany({ where: { purchaseDocumentId: { in: docIds } } });
    await prisma.purchaseDocument.deleteMany({ where: { id: { in: docIds } } });
  }
  if (purchaseIds.length) {
    const remainingDocs = await prisma.purchaseDocument.findMany({ where: { purchaseId: { in: purchaseIds } } });
    const remainingPurchaseIds = new Set(remainingDocs.map((d) => d.purchaseId));
    const idsToDelete = purchaseIds.filter((id) => !remainingPurchaseIds.has(id));
    if (idsToDelete.length) {
      await prisma.purchase.deleteMany({ where: { id: { in: idsToDelete } } });
    }
  }
  await prisma.user.deleteMany({ where: { id: userId } });
}

/**
 * Cleanup stale purchase data that may exist from a previous test run for the same
 * PDF fixture hash. This function only touches rows that have the exact
 * `importHash` value passed in.
 */
async function cleanupImportHash(importHash: string): Promise<void> {
  const docs = await prisma.purchaseDocument.findMany({ where: { importHash } });
  const docIds = docs.map((d) => d.id);
  const purchaseIds = docs.map((d) => d.purchaseId);
  if (docIds.length) {
    await prisma.purchaseItem.deleteMany({ where: { purchaseDocumentId: { in: docIds } } });
    await prisma.purchaseDocument.deleteMany({ where: { id: { in: docIds } } });
  }
  if (purchaseIds.length) {
    const remainingDocs = await prisma.purchaseDocument.findMany({ where: { purchaseId: { in: purchaseIds } } });
    const remainingPurchaseIds = new Set(remainingDocs.map((d) => d.purchaseId));
    const idsToDelete = purchaseIds.filter((id) => !remainingPurchaseIds.has(id));
    if (idsToDelete.length) {
      await prisma.purchase.deleteMany({ where: { id: { in: idsToDelete } } });
    }
  }
}

describe("Purchase Import API", () => {
  let server: Server;
  let url: string;
  let token: string;
  let userId: number;
  const fixturePath = path.resolve(
    process.cwd(),
    "src/__tests__/fixtures/purchases/multiPagePurchaseInvoice.pdf"
  );
  const fixtureBytes = Uint8Array.from(fs.readFileSync(fixturePath));
  const expectedHash = createHash("sha256").update(fixtureBytes).digest("hex");

  before(async () => {
    const { server: srv, url: u } = await startServer();
    server = srv;
    url = u;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(async () => {
    await cleanupImportHash(expectedHash);
    const user = await createTestUser(url);
    token = user.token;
    userId = user.userId;
  });

  afterEach(async () => {
    await cleanup(userId);
  });

  it("successfully imports a valid PDF invoice", async () => {
    const form = new FormData();
    form.append("file", new Blob([fixtureBytes], { type: "application/pdf" }), "invoice.pdf");
    const res = await fetch(`${url}/purchases/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    assert.strictEqual(res.status, 201, "Expected 201 on success");
    const body = await res.json();
    assert.strictEqual(body.importHash, expectedHash, "Hash should match expected");
    const doc = await prisma.purchaseDocument.findFirst({
      where: { importHash: expectedHash },
      include: { purchaseItems: true, purchase: true },
    });
    assert(doc, "PurchaseDocument should be persisted");
    assert.strictEqual(doc.importedByUserId, userId, "importedByUserId should match test user");
    assert.strictEqual(doc.purchaseItems.length, 5, "PurchaseDocument should have 5 items");
    assert.strictEqual(doc.finalTotalPaid.toFixed(2), "168.10", "finalTotalPaid should match fixture total");
  });

  it("returns 409 for duplicate import", async () => {
    const form1 = new FormData();
    form1.append("file", new Blob([fixtureBytes], { type: "application/pdf" }), "invoice.pdf");
    const first = await fetch(`${url}/purchases/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form1,
    });
    assert.strictEqual(first.status, 201);
    const form2 = new FormData();
    form2.append("file", new Blob([fixtureBytes], { type: "application/pdf" }), "invoice.pdf");
    const second = await fetch(`${url}/purchases/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form2,
    });
    assert.strictEqual(second.status, 409, "Expected 409 on duplicate");
    const body = await second.json();
    assert(body.error.includes("Duplicate"), "Error message should mention duplicate import");
  });

  it("returns 400 when file is missing", async () => {
    const res = await fetch(`${url}/purchases/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: new FormData(),
    });
    assert.strictEqual(res.status, 400);
  });

  it("returns 400 for non‑PDF file", async () => {
    const form = new FormData();
    form.append("file", new Blob(["not a pdf"], { type: "text/plain" }), "not.pdf");
    const res = await fetch(`${url}/purchases/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    assert.strictEqual(res.status, 400);
  });

  it("returns 401 when unauthenticated", async () => {
    const form = new FormData();
    form.append("file", new Blob([fixtureBytes], { type: "application/pdf" }), "invoice.pdf");
    const res = await fetch(`${url}/purchases/import`, {
      method: "POST",
      body: form,
    });
    assert.strictEqual(res.status, 401);
  });

  it("rejects an ordinary verified customer from the admin import operation", async () => {
    const customer = await createVerifiedCustomer(url);
    const form = new FormData();
    form.append("file", new Blob([fixtureBytes], { type: "application/pdf" }), "invoice.pdf");
    const res = await fetch(`${url}/purchases/import`, { method: "POST", headers: { Authorization: `Bearer ${customer.token}` }, body: form });
    assert.strictEqual(res.status, 403);
    await prisma.user.delete({ where: { id: customer.userId } });
  });

  it("returns 400 for empty uploaded PDF", async () => {
    const form = new FormData();
    form.append("file", new Blob([], { type: "application/pdf" }), "empty.pdf");
    const res = await fetch(`${url}/purchases/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    assert.strictEqual(res.status, 400);
  });

  it("returns 400 for malformed PDF content", async () => {
    // Content starts with %PDF- but is not a valid PDF
    const malformedBytes = Uint8Array.from([37, 80, 68, 70, 45, 49, 46, 50]); // "%PDF-1.2"
    const form = new FormData();
    form.append("file", new Blob([malformedBytes], { type: "application/pdf" }), "malformed.pdf");
    const res = await fetch(`${url}/purchases/import`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    assert.strictEqual(res.status, 400);
    // Verify no PurchaseDocument persisted
    const doc = await prisma.purchaseDocument.findFirst({ where: { importHash: createHash("sha256").update(malformedBytes).digest("hex") } });
    assert(!doc, "No PurchaseDocument should be created for malformed PDF");
  });
});
