import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { Prisma } from "../generated/prisma-client/client.js";
import { prisma } from "../prisma/runtime.js";
import { amendReviewLine, getPurchaseReview } from "../domain/purchases/purchaseReview.js";
import { serializePurchaseAnalyticsSummary } from "../domain/purchases/purchaseAnalytics.js";

type ItemFixture = {
  quantity: number;
  unitCost?: string;
  receivedAt?: Date | null;
  returnedAt?: Date | null;
  inventoryDisposition?: "INVENTORY" | "NON_INVENTORY";
};

type DocumentFixture = {
  total: string;
  items: ItemFixture[];
};

type PurchaseFixture = {
  merchantName?: string | null;
  sourceOrderDate?: Date | null;
  createdAt?: Date;
  importedByUserId?: number;
  documents: DocumentFixture[];
};

const userIds: number[] = [];
const purchaseIds: number[] = [];
const documentIds: number[] = [];
const itemIds: number[] = [];
let server: Server;
let baseUrl: string;
let adminId: number;
let otherAdminId: number;
let customerToken: string;
let adminToken: string;

type PurchaseAnalyticsSummary = {
  totalQuantity: number;
  totalAmount: string;
  suppliers: Array<{ supplierKey: string; supplierName: string; totalAmount: string }>;
};

function tokenFor(userId: number, role: "ADMIN" | "CUSTOMER"): string {
  return jwt.sign({ id: userId, role }, config.JWT_SECRET, { expiresIn: "1h" });
}

async function createPurchase(fixture: PurchaseFixture): Promise<{ id: number; itemIds: number[] }> {
  const purchase = await prisma.purchase.create({
    data: {
      sourceOrderReference: `analytics-${randomUUID()}`,
      merchantName: fixture.merchantName ?? null,
      sourceOrderDate: fixture.sourceOrderDate ?? null,
      ...(fixture.createdAt ? { createdAt: fixture.createdAt } : {}),
    },
  });
  purchaseIds.push(purchase.id);
  const createdItemIds: number[] = [];

  for (const [partIndex, document] of fixture.documents.entries()) {
    const persistedDocument = await prisma.purchaseDocument.create({
      data: {
        purchaseId: purchase.id,
        partNumber: partIndex + 1,
        importHash: randomUUID(),
        importedByUserId: fixture.importedByUserId ?? adminId,
        originalGrossMerchandiseTotal: document.total,
        shippingTotal: "0.00",
        discountTotal: "0.00",
        finalTotalPaid: document.total,
      },
    });
    documentIds.push(persistedDocument.id);

    for (const [itemIndex, item] of document.items.entries()) {
      const persistedItem = await prisma.purchaseItem.create({
        data: {
          purchaseDocumentId: persistedDocument.id,
          sourceDescription: `Analytics fixture ${itemIndex + 1}`,
          sourceLineNumber: itemIndex + 1,
          quantity: item.quantity,
          originalGrossUnitCost: item.unitCost ?? "0.01",
          originalGrossLineTotal: new Prisma.Decimal(item.unitCost ?? "0.01").mul(item.quantity).toFixed(2),
          allocatedShipping: "0.00",
          allocatedDiscount: "0.00",
          finalLineCost: "999999.99",
          finalUnitCost: "1.000000",
          ...(item.receivedAt !== undefined ? { receivedAt: item.receivedAt } : {}),
          ...(item.returnedAt !== undefined ? { returnedAt: item.returnedAt } : {}),
          ...(item.inventoryDisposition ? { inventoryDisposition: item.inventoryDisposition } : {}),
        },
      });
      itemIds.push(persistedItem.id);
      createdItemIds.push(persistedItem.id);
    }
  }

  return { id: purchase.id, itemIds: createdItemIds };
}

async function summary(token = adminToken): Promise<PurchaseAnalyticsSummary> {
  const response = await fetch(`${baseUrl}/purchase-analytics`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function cleanup(): Promise<void> {
  if (itemIds.length) await prisma.purchaseItem.deleteMany({ where: { id: { in: itemIds } } });
  if (documentIds.length) await prisma.purchaseDocument.deleteMany({ where: { id: { in: documentIds } } });
  if (purchaseIds.length) await prisma.purchase.deleteMany({ where: { id: { in: purchaseIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  itemIds.length = 0;
  documentIds.length = 0;
  purchaseIds.length = 0;
  userIds.length = 0;
}

before(() => {
  server = app.listen(0);
  return new Promise<void>((resolve, reject) => {
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Failed to start test server"));
      baseUrl = `http://localhost:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  const [admin, otherAdmin, customer] = await Promise.all([
    prisma.user.create({ data: { email: `${randomUUID()}@analytics.test`, passwordHash: "test", role: "ADMIN", emailVerified: true } }),
    // The database enforces a single Admin; a second operator-owned purchase still
    // needs only an ordinary user identity for the importedByUserId foreign key.
    prisma.user.create({ data: { email: `${randomUUID()}@analytics.test`, passwordHash: "test", role: "CUSTOMER", emailVerified: true } }),
    prisma.user.create({ data: { email: `${randomUUID()}@analytics.test`, passwordHash: "test", role: "CUSTOMER", emailVerified: true } }),
  ]);
  adminId = admin.id;
  otherAdminId = otherAdmin.id;
  userIds.push(admin.id, otherAdmin.id, customer.id);
  adminToken = tokenFor(admin.id, "ADMIN");
  customerToken = tokenFor(customer.id, "CUSTOMER");
});

afterEach(cleanup);

describe("Admin purchase analytics", () => {
  it("serializes the zero-purchase case without inventing totals", () => {
    assert.deepEqual(serializePurchaseAnalyticsSummary(null, null, []), {
      totalQuantity: 0,
      totalAmount: "0.00",
      suppliers: [],
    });
  });

  it("requires Admin authorization for company-wide totals", async () => {
    const anonymous = await fetch(`${baseUrl}/purchase-analytics`);
    assert.equal(anonymous.status, 401);
    assert.deepEqual(await anonymous.json(), {
      error: { code: "AUTH_REQUIRED", message: "Missing or invalid authorization header" },
    });

    const customer = await fetch(`${baseUrl}/purchase-analytics`, {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    assert.equal(customer.status, 403);
    assert.deepEqual(await customer.json(), { error: { code: "FORBIDDEN", message: "Forbidden: ADMIN only" } });

    assert.equal((await fetch(`${baseUrl}/purchase-analytics`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    })).status, 200);

    for (const [token, expectedStatus, expectedCode] of [
      [undefined, 401, "AUTH_REQUIRED"],
      [customerToken, 403, "FORBIDDEN"],
    ] as const) {
      const monthly = await fetch(`${baseUrl}/purchase-analytics/suppliers/unknown/monthly`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      assert.equal(monthly.status, expectedStatus);
      assert.equal((await monthly.json()).error.code, expectedCode);
    }
  });

  it("returns structured errors for invalid and unknown supplier keys", async () => {
    const invalid = await fetch(`${baseUrl}/purchase-analytics/suppliers/not-a-supplier-key/monthly`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), {
      error: { code: "INVALID_SUPPLIER_KEY", message: "Invalid supplier key" },
    });

    const unknownKey = `supplier-${createHash("sha256").update(randomUUID()).digest("hex")}`;
    const missing = await fetch(`${baseUrl}/purchase-analytics/suppliers/${unknownKey}/monthly`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), {
      error: { code: "PURCHASE_ANALYTICS_SUPPLIER_NOT_FOUND", message: "Supplier not found" },
    });
  });

  it("counts every document and item once, with exact money and normalized company-wide suppliers", async () => {
    const beforeTotals = await summary();
    const supplier = `Analytics Supplier ${randomUUID()}`;
    const canonical = supplier.trim().toLowerCase();

    await createPurchase({
      merchantName: supplier,
      sourceOrderDate: new Date("2026-09-10T00:00:00.000Z"),
      documents: [
        { total: "0.10", items: [{ quantity: 2 }, { quantity: 3 }] },
        { total: "0.20", items: [{ quantity: 4 }] },
      ],
    });
    await createPurchase({
      merchantName: `  ${supplier.toUpperCase()}  `,
      sourceOrderDate: new Date("2026-09-12T00:00:00.000Z"),
      importedByUserId: otherAdminId,
      documents: [{ total: "3.33", items: [{ quantity: 5 }] }],
    });
    await createPurchase({ merchantName: null, documents: [{ total: "4.00", items: [{ quantity: 1 }] }] });
    await createPurchase({ merchantName: "   ", documents: [{ total: "5.00", items: [{ quantity: 2 }] }] });

    const result = await summary();
    assert.equal(result.totalQuantity - beforeTotals.totalQuantity, 17);
    assert.equal(
      new Prisma.Decimal(result.totalAmount).minus(beforeTotals.totalAmount).toFixed(2),
      "12.63",
    );

    const matchingSupplier = result.suppliers.find((entry: { supplierName: string }) =>
      entry.supplierName.trim().toLowerCase() === canonical,
    );
    assert.ok(matchingSupplier);
    assert.equal(matchingSupplier.totalAmount, "3.63");
    assert.match(matchingSupplier.supplierKey, /^supplier-[a-f0-9]{64}$/);

    const unknown = result.suppliers.find((entry: { supplierKey: string }) => entry.supplierKey === "unknown");
    assert.ok(unknown);
    assert.equal(unknown.supplierName, "Unknown supplier");
    const beforeUnknown = beforeTotals.suppliers.find((entry: { supplierKey: string }) => entry.supplierKey === "unknown");
    assert.equal(new Prisma.Decimal(unknown.totalAmount).minus(beforeUnknown?.totalAmount ?? "0").toFixed(2), "9.00");

    const repeated = await summary();
    assert.deepEqual(repeated.suppliers, result.suppliers);
    for (let index = 1; index < result.suppliers.length; index++) {
      const previous = result.suppliers[index - 1];
      const current = result.suppliers[index];
      const amountOrder = new Prisma.Decimal(previous.totalAmount).comparedTo(current.totalAmount);
      assert.ok(amountOrder > 0 || (amountOrder === 0 && previous.supplierKey < current.supplierKey));
    }
  });

  it("groups by source order calendar month, isolates suppliers, and reports missing dates separately", async () => {
    const supplier = `Monthly Supplier ${randomUUID()}`;
    const otherSupplier = `Other Supplier ${randomUUID()}`;

    await createPurchase({
      merchantName: supplier,
      sourceOrderDate: new Date("2026-09-01T00:00:00.000Z"),
      createdAt: new Date("2030-01-01T00:00:00.000Z"),
      documents: [
        { total: "10.10", items: [{ quantity: 1, receivedAt: new Date("2026-12-01T00:00:00.000Z") }] },
        { total: "5.00", items: [{ quantity: 2, returnedAt: new Date("2026-12-02T00:00:00.000Z") }] },
      ],
    });
    await createPurchase({
      merchantName: ` ${supplier.toUpperCase()} `,
      sourceOrderDate: new Date("2026-08-31T00:00:00.000Z"),
      createdAt: new Date("2031-05-01T00:00:00.000Z"),
      documents: [{ total: "7.20", items: [{ quantity: 1 }] }],
    });
    await createPurchase({
      merchantName: supplier,
      sourceOrderDate: new Date("2026-09-30T00:00:00.000Z"),
      documents: [{ total: "2.00", items: [{ quantity: 1 }] }],
    });
    await createPurchase({
      merchantName: supplier.toLowerCase(),
      sourceOrderDate: new Date("2025-09-30T00:00:00.000Z"),
      documents: [{ total: "4.44", items: [{ quantity: 1 }] }],
    });
    await createPurchase({ merchantName: supplier, sourceOrderDate: null, documents: [{ total: "6.66", items: [{ quantity: 1 }] }] });
    await createPurchase({
      merchantName: otherSupplier,
      sourceOrderDate: new Date("2026-09-01T00:00:00.000Z"),
      documents: [{ total: "900.00", items: [{ quantity: 1 }] }],
    });

    const summaryResult = await summary();
    const supplierEntry = summaryResult.suppliers.find((entry: { supplierName: string }) =>
      entry.supplierName.trim().toLowerCase() === supplier.trim().toLowerCase(),
    );
    assert.ok(supplierEntry);

    const response = await fetch(`${baseUrl}/purchase-analytics/suppliers/${supplierEntry.supplierKey}/monthly`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.supplierKey, supplierEntry.supplierKey);
    assert.equal(result.supplierName.trim().toLowerCase(), supplier.trim().toLowerCase());
    assert.deepEqual(result.months, [
      { month: "2026-09", totalAmount: "17.10" },
      { month: "2026-08", totalAmount: "7.20" },
      { month: "2025-09", totalAmount: "4.44" },
    ]);
    assert.equal(result.undatedTotalAmount, "6.66");
  });

  it("keeps gross purchased quantity unchanged after receiving or returning a persisted item", async () => {
    const purchase = await createPurchase({
      merchantName: `Lifecycle ${randomUUID()}`,
      documents: [{ total: "14.25", items: [{ quantity: 7 }] }],
    });
    const beforeTotals = await summary();

    await prisma.purchaseItem.update({ where: { id: purchase.itemIds[0] }, data: { receivedAt: new Date() } });
    const receivedTotals = await summary();
    assert.equal(receivedTotals.totalQuantity, beforeTotals.totalQuantity);
    assert.equal(receivedTotals.totalAmount, beforeTotals.totalAmount);

    await prisma.purchaseItem.update({ where: { id: purchase.itemIds[0] }, data: { returnedAt: new Date() } });
    const returnedTotals = await summary();
    assert.equal(returnedTotals.totalQuantity, beforeTotals.totalQuantity);
    assert.equal(returnedTotals.totalAmount, beforeTotals.totalAmount);
  });

  it("reflects review-amended persisted quantity and document total", async () => {
    const beforeTotals = await summary();
    const purchase = await createPurchase({
      merchantName: `Amended ${randomUUID()}`,
      documents: [{ total: "20.00", items: [{ quantity: 2, unitCost: "10.00" }] }],
    });
    const review = await getPurchaseReview(adminId, purchase.id);
    await amendReviewLine(adminId, purchase.id, purchase.itemIds[0], {
      revision: review.revision,
      sourceDescription: "Amended analytics item",
      sourceSetNumber: null,
      quantity: 3,
      originalGrossUnitCost: "10.00",
    });

    const afterTotals = await summary();
    assert.equal(afterTotals.totalQuantity - beforeTotals.totalQuantity, 3);
    assert.equal(new Prisma.Decimal(afterTotals.totalAmount).minus(beforeTotals.totalAmount).toFixed(2), "30.00");
  });

  it("excludes explicitly non-inventory lines from unit totals but retains their actual document spend", async () => {
    const beforeTotals = await summary();
    await createPurchase({
      merchantName: `Mixed inventory ${randomUUID()}`,
      documents: [{
        total: "17.35",
        items: [
          { quantity: 3, unitCost: "2.00", inventoryDisposition: "INVENTORY" },
          { quantity: 7, unitCost: "1.05", inventoryDisposition: "NON_INVENTORY" },
        ],
      }],
    });

    const afterTotals = await summary();
    assert.equal(afterTotals.totalQuantity - beforeTotals.totalQuantity, 3);
    assert.equal(
      new Prisma.Decimal(afterTotals.totalAmount).minus(beforeTotals.totalAmount).toFixed(2),
      "17.35",
    );
  });
});
