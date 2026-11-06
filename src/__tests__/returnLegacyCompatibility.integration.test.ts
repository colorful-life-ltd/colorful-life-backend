import { dispatchOrder } from "../domain/orders/orderDispatchService.js";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Server } from "node:http";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { createOrder } from "../domain/orders/orderService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import { recordVerifiedPayment } from "./fixtures/verifiedPayment.js";
import { submitReturns, returnAction, customerReturnCase, adminReturnCase, submissionSchema } from "../domain/orders/returnManagement.js";

// Rollback compatibility for schema 74: the PREVIOUS image writes OrderReturn rows through a Prisma client
// that has no submissionId column. Migration 74's return_legacy_attach trigger must attach every such row.
const orders: number[] = [], listings: number[] = [], products: number[] = [], users: number[] = [];
let url: string, server: Server, admin: { id: number; token: string }, customer: { id: number; token: string };

async function user(role: "ADMIN" | "CUSTOMER") {
  const u = await prisma.user.create({ data: { email: `legacy-${randomUUID()}@example.invalid`, passwordHash: "synthetic", emailVerified: true, role,
    addresses: { create: { recipientName: "Synthetic", line1: "1 Test Road", city: "Test", postcode: "S63 8NS", countryCode: "GB", isDefaultBilling: true } } } });
  users.push(u.id);
  return { id: u.id, token: jwt.sign({ id: u.id, role }, config.JWT_SECRET, { expiresIn: "1h" }) };
}
async function dispatchedOrder(quantity = 4) {
  const p = await prisma.legoProduct.create({ data: { setNumber: `LEG-${randomUUID()}`, title: "Synthetic legacy set", theme: "TEST", ageRecommendation: "8+", pieceCount: 100,
    productListings: { create: { condition: "NEW", originalPrice: 20, salePrice: 15, currentStock: 10, active: true } } }, include: { productListings: true } });
  products.push(p.id); listings.push(p.productListings[0].id);
  const o = await createOrder(customer.id, { shippingMethod: "STANDARD", items: [{ productListingId: p.productListings[0].id, quantity }] });
  orders.push(o.id);
  await recordVerifiedPayment(o.id);
  await confirmOrder(customer.id, o.id);
  await dispatchOrder(o.id, 0, "Royal Mail", "AB123456789GB", admin.id);
  return { orderId: o.id, itemId: o.orderItems[0].id };
}
/** Exactly what the previous requestOrderReturn does: reserve, then insert a row without submissionId. */
async function previousImageRequest(orderId: number, itemId: number, quantity = 1, db: Pick<typeof prisma, "$executeRaw" | "$queryRaw"> = prisma) {
  const reserved = await db.$executeRaw`UPDATE "OrderItem" SET "reservedReturnQuantity"="reservedReturnQuantity"+${quantity}
    WHERE id=${itemId} AND "orderId"=${orderId} AND "reservedReturnQuantity" <= "quantity"-"returnedQuantity"-${quantity}`;
  assert.equal(reserved, 1);
  const [row] = await db.$queryRaw<Array<{ id: number; submissionId: string | null; status: string; requestedAt: Date }>>`
    INSERT INTO "OrderReturn" ("orderItemId",quantity,"restockQuantity",reason,status,"shippingPayer","performedByUserId","updatedAt")
    VALUES (${itemId},${quantity},0,'CHANGE_OF_MIND'::"ReturnReason",'REQUESTED'::"OrderReturnStatus",'CUSTOMER'::"ReturnShippingPayer",${admin.id},now())
    RETURNING id,"submissionId",status::text,"requestedAt"`;
  return row;
}
const counters = (itemId: number) => prisma.orderItem.findUniqueOrThrow({ where: { id: itemId }, select: { reservedReturnQuantity: true, returnedQuantity: true } });
const lineIds = (view: { submissions: Array<{ lines: Array<{ id: number }> }> }) => view.submissions.flatMap((s) => s.lines.map((l) => l.id));
async function http(path: string, token: string) {
  const r = await fetch(url + path, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, json: await r.json() };
}

describe("Schema 74 legacy-write compatibility", () => {
  before(async () => {
    admin = await user("ADMIN"); customer = await user("CUSTOMER");
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    url = `http://127.0.0.1:${address.port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.orderReturn.deleteMany({ where: { orderItem: { orderId: { in: orders } } } });
    await prisma.returnCase.deleteMany({ where: { orderId: { in: orders } } }).catch(() => undefined);
  });

  it("attaches a first-ever legacy return to a new permanent case without changing the row", async () => {
    const { orderId, itemId } = await dispatchedOrder();
    const before = await counters(itemId);
    const row = await previousImageRequest(orderId, itemId);
    assert.equal(row.submissionId, `return-legacy-${row.id}`);
    assert.equal(row.status, "REQUESTED");
    const stored = await prisma.orderReturn.findUniqueOrThrow({ where: { id: row.id }, include: { submission: { include: { returnCase: true } } } });
    assert.deepEqual(stored.requestedAt, row.requestedAt);
    assert.equal(stored.submission!.idempotencyKey, `legacy-${row.id}`);
    assert.equal(stored.submission!.requestHash, "LEGACY");
    assert.deepEqual(stored.submission!.requestedAt, row.requestedAt);
    assert.equal(stored.submission!.returnCase.reference, `BB-R-${orderId}`);
    assert.equal(stored.submission!.returnCase.id, `return-case-${orderId}`);
    const afterInsert = await counters(itemId);
    assert.equal(afterInsert.reservedReturnQuantity, before.reservedReturnQuantity + 1, "only the legacy reservation itself");
    assert.equal(afterInsert.returnedQuantity, before.returnedQuantity);
  });

  it("joins an order's existing case and never rewrites explicit submissions", async () => {
    const { orderId, itemId } = await dispatchedOrder();
    await submitReturns(orderId, customer.id, submissionSchema.parse({ idempotencyKey: randomUUID(), lines: [{ orderItemId: itemId, quantity: 1 }] }));
    const existing = await prisma.returnCase.findUniqueOrThrow({ where: { orderId }, include: { submissions: { include: { lines: true } } } });
    const explicit = existing.submissions[0];
    const row = await previousImageRequest(orderId, itemId);
    const legacy = await prisma.returnSubmission.findUniqueOrThrow({ where: { id: row.submissionId! } });
    assert.equal(legacy.caseId, existing.id, "same permanent case");
    assert.equal(await prisma.returnCase.count({ where: { orderId } }), 1);
    const untouched = await prisma.orderReturn.findUniqueOrThrow({ where: { id: explicit.lines[0].id } });
    assert.equal(untouched.submissionId, explicit.id);
  });

  it("is safe for concurrent first-ever legacy inserts on one order", async () => {
    const { orderId, itemId } = await dispatchedOrder();
    const rows = await Promise.all([1, 2].map(() => prisma.$transaction((tx) => previousImageRequest(orderId, itemId, 1, tx))));
    assert.equal(await prisma.returnCase.count({ where: { orderId } }), 1);
    const subs = await prisma.returnSubmission.findMany({ where: { id: { in: rows.map((r) => r.submissionId!) } } });
    assert.equal(subs.length, 2);
    assert.equal(new Set(subs.map((s) => s.caseId)).size, 1);
    assert.equal((await counters(itemId)).reservedReturnQuantity, 2);
  });

  it("rollback then redeployment: a previous-image return is visible to customer, Admin detail and the filtered queue", async () => {
    const { orderId, itemId } = await dispatchedOrder();
    const row = await previousImageRequest(orderId, itemId);     // written by the previous image after rollback
    // ...then the candidate is redeployed and reads it with its own code and routes.
    assert.ok(lineIds(await customerReturnCase(orderId, customer.id)).includes(row.id));
    assert.ok(lineIds(await adminReturnCase(orderId)).includes(row.id));
    const customerHttp = await http(`/orders/${orderId}/return-case`, customer.token);
    assert.equal(customerHttp.status, 200);
    assert.ok(lineIds(customerHttp.json).includes(row.id));
    const detail = await http(`/admin/returns/${orderId}`, admin.token);
    assert.equal(detail.status, 200);
    assert.ok(lineIds(detail.json).includes(row.id));
    let found = false;
    for (let page = 1; page <= 20 && !found; page++) {
      const queue = await http(`/admin/returns?status=REQUESTED&page=${page}&pageSize=100`, admin.token);
      assert.equal(queue.status, 200);
      found = JSON.stringify(queue.json).includes(`"orderId":${orderId}`);
      if (!JSON.stringify(queue.json).includes('"orderId"')) break;
    }
    assert.ok(found, "status-filtered Admin queue lists the order");
  });

  it("releases a previous-image reservation when the candidate cancels or processes it", async () => {
    const { orderId, itemId } = await dispatchedOrder();
    const cancelled = await previousImageRequest(orderId, itemId);
    const processed = await previousImageRequest(orderId, itemId);
    assert.equal((await counters(itemId)).reservedReturnQuantity, 2);
    await returnAction(orderId, cancelled.id, admin.id, "cancel", { note: "Synthetic cancellation" });
    assert.equal((await prisma.orderReturn.findUniqueOrThrow({ where: { id: cancelled.id } })).status, "CANCELLED");
    assert.equal((await counters(itemId)).reservedReturnQuantity, 1, "cancel released exactly its unit");
    await returnAction(orderId, processed.id, admin.id, "authorize", { shippingPayer: "CUSTOMER", postageInstructions: "Synthetic postage instructions.", rightsReviewed: true });
    const authorized = await prisma.orderReturn.findUniqueOrThrow({ where: { id: processed.id } });
    assert.equal(authorized.status, "AUTHORIZED");
    assert.equal((authorized.instructions as { reference?: string })?.reference, `BB-R-${orderId}`);
    assert.equal((await counters(itemId)).reservedReturnQuantity, 1, "authorisation keeps the reservation");
  });

  it("lets the previous image keep updating an attached row (status only)", async () => {
    const { orderId, itemId } = await dispatchedOrder();
    const row = await previousImageRequest(orderId, itemId);
    const updated = await prisma.$executeRaw`UPDATE "OrderReturn" SET status='AUTHORIZED'::"OrderReturnStatus","authorizedAt"=now(),"updatedAt"=now() WHERE id=${row.id}`;
    assert.equal(updated, 1);
    const after = await prisma.orderReturn.findUniqueOrThrow({ where: { id: row.id } });
    assert.equal(after.submissionId, row.submissionId, "attachment is stable");
  });
});
