import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { Decimal } from "@prisma/client/runtime/client";
import app from "../app.js";
import { prisma } from "../prisma/runtime.js";
import { config } from "../config/index.js";
import { createOrder } from "../domain/orders/orderService.js";
import { recordVerifiedPayment } from "./fixtures/verifiedPayment.js";
import { MANUAL_DELIVERY_KIND, manualDeliveryKey, readManualDeliveries } from "../domain/fulfilment/manualDelivery.js";

// OperationalAudit is immutable (database trigger), so delivery rows outlive their orders by design.
const userIds: number[] = [], productIds: number[] = [], listingIds: number[] = [], orderIds: number[] = [];
let server: Server; let url: string;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((done) => server.once("listening", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  url = `http://localhost:${address.port}`;
});
afterEach(async () => {
  if (orderIds.length) await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  if (listingIds.length) {
    await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listingIds } } });
    await prisma.productListing.deleteMany({ where: { id: { in: listingIds } } });
  }
  if (productIds.length) await prisma.legoProduct.deleteMany({ where: { id: { in: productIds } } });
  if (userIds.length) {
    await prisma.address.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  orderIds.length = listingIds.length = productIds.length = userIds.length = 0;
});
after(async () => { server.close(); await prisma.$disconnect(); });

async function makeUser(role: "ADMIN" | "CUSTOMER") {
  const user = await prisma.user.create({ data: {
    email: `${randomUUID()}@example.com`, passwordHash: "hash", emailVerified: true, role,
    addresses: { create: { recipientName: "Delivery", line1: "1 Test Street", city: "Testville", postcode: "T1", countryCode: "GB", isDefaultBilling: true } },
  } });
  userIds.push(user.id);
  return { ...user, token: jwt.sign({ id: user.id, role }, config.JWT_SECRET, { expiresIn: "1h" }) };
}
async function makeOrder(customerId: number) {
  const product = await prisma.legoProduct.create({ data: { setNumber: `DEL-${randomUUID()}`, title: "Delivery", theme: "Test", ageRecommendation: "8+", pieceCount: 1 } });
  productIds.push(product.id);
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: new Decimal(20), currentStock: 5 } });
  listingIds.push(listing.id);
  const order = await createOrder(customerId, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 1 }] });
  orderIds.push(order.id);
  await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
  await recordVerifiedPayment(order.id);
  return order;
}
function call(path: string, token?: string, body?: unknown) {
  return fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Idempotency-Key": randomUUID(), "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const confirmed = { verifiedOnCarrierWebsite: true };
const dispatch = (orderId: number, token: string) => call(`/admin/orders/${orderId}/fulfilment/dispatch`, token, { carrier: "ROYAL_MAIL", trackingNumber: "AB123456789GB", actualShippingCost: 3.99 });
const deliver = (orderId: number, token?: string, body: unknown = confirmed) => call(`/admin/orders/${orderId}/fulfilment/delivered`, token, body);
const auditRows = (orderId: number) => prisma.operationalAudit.findMany({ where: { orderId, kind: MANUAL_DELIVERY_KIND }, orderBy: { id: "asc" } });
async function errorCode(response: Response) { const body = await response.json(); return [response.status, body.error?.code ?? body.error]; }
async function dispatched() {
  const admin = await makeUser("ADMIN"), customer = await makeUser("CUSTOMER");
  const order = await makeOrder(customer.id);
  const shipped = await dispatch(order.id, admin.token);
  assert.equal(shipped.status, 200);
  return { admin, customer, order, shipped: await shipped.json() };
}

describe("manual delivery confirmation", () => {
  it("records DISPATCHED -> DELIVERED with operator, database time and shipment, and shows it to the customer", async () => {
    const { admin, customer, order, shipped } = await dispatched();
    const paymentBefore = await prisma.payment.findUniqueOrThrow({ where: { orderId: order.id } });
    const before = Date.now();
    const response = await deliver(order.id, admin.token);
    const after = Date.now();
    assert.equal(response.status, 200);
    const body = await response.json();
    // Order status, shipment, tracking and the fulfilment event history are preserved.
    assert.deepEqual([body.status, body.fulfilmentStage, body.fulfilment.stage], ["DISPATCHED", "DELIVERED", "DELIVERED"]);
    assert.equal(body.actualShippingCost, "3.99");
    assert.deepEqual(body.shipments.map((s: any) => [s.id, s.trackingNumber, s.dispatchedAt]), shipped.shipments.map((s: any) => [s.id, s.trackingNumber, s.dispatchedAt]));
    assert.deepEqual(body.fulfilmentEvents, shipped.fulfilmentEvents);
    assert.equal(body.deliveryConfirmations.length, 1);
    const [confirmation] = body.deliveryConfirmations;
    assert.deepEqual([confirmation.shipmentId, confirmation.shipmentSequence, confirmation.source, confirmation.performedByUser],
      [shipped.shipments[0].id, 1, "MANUAL_OPERATOR_CONFIRMATION", { id: admin.id, email: admin.email }]);
    const confirmedAt = Date.parse(confirmation.confirmedAt);
    assert.ok(confirmedAt >= Date.parse(shipped.dispatchedAt), "delivered after dispatch");
    assert.ok(confirmedAt >= before - 5000 && confirmedAt <= after + 5000, "database time near the request");
    assert.equal(body.fulfilment.shipments[0].tracking.deliveredAt, confirmation.confirmedAt);

    const [row] = await auditRows(order.id);
    assert.deepEqual([row.actorId, row.orderId, row.requestKey, row.createdAt.toISOString()], [admin.id, order.id, manualDeliveryKey(shipped.shipments[0].id), confirmation.confirmedAt]);
    assert.deepEqual(row.details, { shipmentId: shipped.shipments[0].id, shipmentSequence: 1, carrier: "ROYAL_MAIL", carrierName: "Royal Mail",
      trackingNumber: "AB123456789GB", verification: "OPERATOR_CHECKED_CARRIER_TRACKING_WEBSITE", source: "ADMIN_FULFILMENT_API" });

    const customerView = await (await call(`/orders/${order.id}`, customer.token)).json();
    assert.equal(customerView.status, "DISPATCHED");
    assert.equal(customerView.fulfilment.stage, "DELIVERED");
    assert.deepEqual(customerView.fulfilment.shipments[0].tracking, { progress: "DELIVERED", lastEventAt: null, exception: null, exceptionAt: null,
      deliveredAt: confirmation.confirmedAt, deliveryConfirmation: "MANUAL" });
    assert.ok(!JSON.stringify(customerView).includes(admin.email), "operator identity is never exposed to customers");
    assert.ok(!("deliveryConfirmations" in customerView) && !("id" in customerView.fulfilment.shipments[0]));
    const listed = (await (await call("/orders", customer.token)).json()).find((r: any) => r.id === order.id);
    assert.equal(listed.fulfilment.stage, "DELIVERED");
    const adminList = (await (await call("/admin/orders?page=1&pageSize=50", admin.token)).json()).items.find((r: any) => r.id === order.id);
    assert.equal(adminList.fulfilmentStage, "DELIVERED");

    // Refund and payment protections are untouched.
    const paymentAfter = await prisma.payment.findUniqueOrThrow({ where: { orderId: order.id } });
    assert.deepEqual([paymentAfter.status, paymentAfter.amount.toString(), paymentAfter.refundedAmount.toString()], [paymentBefore.status, paymentBefore.amount.toString(), paymentBefore.refundedAmount.toString()]);
    assert.equal(await prisma.refund.count({ where: { orderId: order.id } }), 0);
  });

  it("rejects duplicate and concurrent confirmations without a second delivery event", async () => {
    const { admin, order } = await dispatched();
    const results = await Promise.all([deliver(order.id, admin.token), deliver(order.id, admin.token), deliver(order.id, admin.token)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409]);
    for (const r of results.filter(r => r.status === 409)) assert.deepEqual(await errorCode(r), [409, "ORDER_ALREADY_DELIVERED"]);
    assert.deepEqual(await errorCode(await deliver(order.id, admin.token)), [409, "ORDER_ALREADY_DELIVERED"]);
    const rows = await auditRows(order.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actorId, admin.id);
    // The unique request key rejects a second row even if the order lock were bypassed.
    await assert.rejects(prisma.operationalAudit.create({ data: { kind: MANUAL_DELIVERY_KIND, orderId: order.id, actorId: admin.id,
      requestKey: rows[0].requestKey, details: rows[0].details as object } }));
    await assert.rejects(prisma.operationalAudit.deleteMany({ where: { id: rows[0].id } }), "delivery audit is immutable");
  });

  it("only accepts DISPATCHED orders", async () => {
    const admin = await makeUser("ADMIN"), customer = await makeUser("CUSTOMER");
    const order = await makeOrder(customer.id);
    assert.deepEqual(await errorCode(await deliver(order.id, admin.token)), [409, "FULFILMENT_TRANSITION_INVALID"], "CONFIRMED");
    assert.equal((await call(`/admin/orders/${order.id}/fulfilment/preparing`, admin.token, {})).status, 200);
    assert.deepEqual(await errorCode(await deliver(order.id, admin.token)), [409, "FULFILMENT_TRANSITION_INVALID"], "PREPARING");
    assert.equal((await dispatch(order.id, admin.token)).status, 200);
    for (const status of ["COMPLETED", "RETURNED", "CANCELLED"] as const) {
      await prisma.order.update({ where: { id: order.id }, data: { status } });
      assert.deepEqual(await errorCode(await deliver(order.id, admin.token)), [409, "FULFILMENT_TRANSITION_INVALID"], status);
    }
    // A legacy dispatch without a Shipment row has nothing to reference.
    const legacy = await makeOrder(customer.id);
    await prisma.order.update({ where: { id: legacy.id }, data: { status: "DISPATCHED", dispatchedAt: new Date(), shippingCarrier: "Royal Mail" } });
    assert.deepEqual(await errorCode(await deliver(legacy.id, admin.token)), [409, "FULFILMENT_TRANSITION_INVALID"], "no shipment");
    assert.equal((await auditRows(order.id)).length + (await auditRows(legacy.id)).length, 0);
    assert.equal((await deliver(2147483647, admin.token)).status, 404);
    assert.equal((await deliver(0, admin.token)).status, 400);
    assert.equal((await call(`/admin/orders/abc/fulfilment/delivered`, admin.token, confirmed)).status, 400);
  });

  it("requires an authenticated administrator and an explicit manual verification", async () => {
    const { admin, customer, order } = await dispatched();
    assert.equal((await deliver(order.id)).status, 401);
    assert.equal((await deliver(order.id, "not-a-token")).status, 401);
    assert.equal((await deliver(order.id, customer.token)).status, 403, "the order's own customer cannot mark it delivered");
    const forged = jwt.sign({ id: customer.id, role: "CUSTOMER" }, "wrong-secret", { expiresIn: "1h" });
    assert.equal((await deliver(order.id, forged)).status, 401);
    // No customer route exists for delivery.
    assert.ok([403, 404].includes((await call(`/orders/${order.id}/fulfilment/delivered`, customer.token, confirmed)).status));
    assert.ok([403, 404].includes((await call(`/orders/${order.id}/delivered`, customer.token, confirmed)).status));
    for (const body of [{}, { verifiedOnCarrierWebsite: false }, { verifiedOnCarrierWebsite: "true" }, { ...confirmed, deliveredAt: "2020-01-01T00:00:00Z" }, { ...confirmed, actorId: 1 }]) {
      assert.deepEqual(await errorCode(await deliver(order.id, admin.token, body)), [400, "DELIVERY_CONFIRMATION_REQUIRED"], JSON.stringify(body));
    }
    assert.equal((await auditRows(order.id)).length, 0);
    const view = await (await call(`/orders/${order.id}`, customer.token)).json();
    assert.equal(view.fulfilment.stage, "DISPATCHED");
  });

  it("never trusts a delivery-looking audit row that was not written by the confirmation", async () => {
    const { admin, customer, order, shipped } = await dispatched();
    const shipmentId = shipped.shipments[0].id;
    await prisma.operationalAudit.create({ data: { kind: MANUAL_DELIVERY_KIND, orderId: order.id, actorId: admin.id, details: { shipmentId } } });
    await prisma.operationalAudit.create({ data: { kind: MANUAL_DELIVERY_KIND, orderId: order.id, actorId: admin.id, requestKey: `other:${randomUUID()}`, details: { shipmentId } } });
    assert.equal((await readManualDeliveries(prisma, [order.id])).size, 0);
    assert.equal((await (await call(`/orders/${order.id}`, customer.token)).json()).fulfilment.stage, "DISPATCHED");
    assert.equal((await deliver(order.id, admin.token)).status, 200);
    assert.equal((await readManualDeliveries(prisma, [order.id])).get(shipmentId)?.actorId, admin.id);
  });
});
