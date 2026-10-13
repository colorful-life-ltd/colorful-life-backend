import assert from "node:assert/strict";
import type { Server } from "node:http";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import pg from "pg";
import { Decimal } from "@prisma/client/runtime/client";
import app from "../app.js";
import { prisma } from "../prisma/runtime.js";
import { config } from "../config/index.js";
import { createOrder } from "../domain/orders/orderService.js";
import { setDispatchNotificationSenderForTests, type DispatchNotification } from "../services/emailService.js";
import { recordVerifiedPayment } from "./fixtures/verifiedPayment.js";
import { startPreparing } from "../domain/fulfilment/fulfilmentService.js";
import { FulfilmentPaymentNotVerifiedError } from "../domain/fulfilment/fulfilmentErrors.js";

const userIds: number[] = [];
const productIds: number[] = [];
const listingIds: number[] = [];
const orderIds: number[] = [];
const notifications: DispatchNotification[] = [];
let restoreSender: () => void;
let server: Server;
let url: string;

before(async () => {
  restoreSender = setDispatchNotificationSenderForTests(async (notification) => { notifications.push(notification); });
  server = app.listen(0);
  await new Promise<void>((done) => server.once("listening", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  url = `http://localhost:${address.port}`;
});

afterEach(async () => {
  // Orders cascade to payments, resolutions, shipments and fulfilment events.
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
  orderIds.length = listingIds.length = productIds.length = userIds.length = notifications.length = 0;
});

after(async () => { restoreSender(); server.close(); await prisma.$disconnect(); });

async function makeUser(role: "ADMIN" | "CUSTOMER") {
  const user = await prisma.user.create({ data: {
    email: `${randomUUID()}@example.com`, passwordHash: "hash", emailVerified: true, role,
    addresses: { create: { recipientName: "Fulfilment", line1: "1 Test Street", city: "Testville", postcode: "T1", countryCode: "GB", isDefaultBilling: true } },
  } });
  userIds.push(user.id);
  return { ...user, token: jwt.sign({ id: user.id, role }, config.JWT_SECRET, { expiresIn: "1h" }) };
}

/** A CONFIRMED order (status set directly; inventory conversion is not under test here). */
async function makeOrder(customerId: number, { paid = true, status = "CONFIRMED" as const } : { paid?: boolean; status?: "CONFIRMED" | "PENDING" | "CANCELLED" | "EXPIRED" } = {}) {
  const product = await prisma.legoProduct.create({ data: { setNumber: `FUL-${randomUUID()}`, title: "Fulfilment", theme: "Test", ageRecommendation: "8+", pieceCount: 1 } });
  productIds.push(product.id);
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: new Decimal(20), currentStock: 5 } });
  listingIds.push(listing.id);
  const order = await createOrder(customerId, { items: [{ productListingId: listing.id, quantity: 1 }] });
  orderIds.push(order.id);
  await prisma.order.update({ where: { id: order.id }, data: { status } });
  if (paid) await recordVerifiedPayment(order.id);
  return { order, listing };
}

function call(path: string, token?: string, body?: unknown) {
  return fetch(`${url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const royalMail = { carrier: "ROYAL_MAIL", trackingNumber: "ab 123 456 789 gb", actualShippingCost: 3.5 };
const preparing = (orderId: number, token: string) => call(`/admin/orders/${orderId}/fulfilment/preparing`, token, {});
const dispatch = (orderId: number, token: string, body: unknown = royalMail) => call(`/admin/orders/${orderId}/fulfilment/dispatch`, token, body);
const events = (orderId: number) => prisma.orderFulfilmentEvent.findMany({ where: { orderId }, orderBy: { id: "asc" } });

async function errorCode(response: Response) {
  const body = await response.json();
  return [response.status, body.error?.code ?? body.error];
}

describe("admin fulfilment workflow", () => {
  it("moves CONFIRMED -> PREPARING -> DISPATCHED with an audited shipment and customer tracking", async () => {
    const admin = await makeUser("ADMIN");
    const customer = await makeUser("CUSTOMER");
    const { order, listing } = await makeOrder(customer.id);
    const stockBefore = await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } });
    const movementsBefore = await prisma.inventoryMovement.count({ where: { listingId: listing.id } });

    const prepared = await preparing(order.id, admin.token);
    assert.equal(prepared.status, 200);
    const preparedBody = await prepared.json();
    assert.deepEqual([preparedBody.status, preparedBody.fulfilmentStage, preparedBody.fulfilment.stage], ["CONFIRMED", "PREPARING", "PREPARING"]);
    assert.ok(preparedBody.preparingAt);

    const shipped = await dispatch(order.id, admin.token);
    assert.equal(shipped.status, 200);
    const body = await shipped.json();
    assert.deepEqual([body.status, body.fulfilmentStage, body.shippingCarrier, body.trackingNumber], ["DISPATCHED", "DISPATCHED", "Royal Mail", "AB123456789GB"]);
    assert.equal(body.actualShippingCost, "3.5");
    assert.equal(body.shipments.length, 1);
    assert.deepEqual([body.shipments[0].sequence, body.shipments[0].carrier, body.shipments[0].createdByUserId], [1, "ROYAL_MAIL", admin.id]);
    assert.deepEqual(body.fulfilmentEvents.map((event: any) => [event.action, event.fromStage, event.toStage, event.performedByUser.id, event.source]), [
      ["PREPARING_STARTED", "CONFIRMED", "PREPARING", admin.id, "ADMIN_FULFILMENT_API"],
      ["DISPATCHED", "PREPARING", "DISPATCHED", admin.id, "ADMIN_FULFILMENT_API"],
    ]);
    assert.equal(body.fulfilmentEvents[1].shipmentId, body.shipments[0].id);
    assert.deepEqual(notifications.map((n) => [n.orderId, n.customerEmail, n.shippingCarrier, n.trackingNumber]), [[order.id, customer.email, "Royal Mail", "AB123456789GB"]]);

    const customerView = await (await call(`/orders/${order.id}`, customer.token)).json();
    assert.deepEqual(customerView.fulfilment, {
      stage: "DISPATCHED", preparingAt: preparedBody.preparingAt, dispatchedAt: body.dispatchedAt,
      shipments: [{ sequence: 1, carrier: "ROYAL_MAIL", carrierName: "Royal Mail", trackingNumber: "AB123456789GB", dispatchedAt: body.dispatchedAt,
        trackingUrl: "https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB", trackingUrlIncludesNumber: true }],
    });
    assert.ok(!("shipments" in customerView) && !("fulfilmentEvents" in customerView) && !("actualShippingCost" in customerView));
    const listed = (await (await call("/orders", customer.token)).json()).find((row: any) => row.id === order.id);
    assert.equal(listed.fulfilment.stage, "DISPATCHED");

    const stockAfter = await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } });
    assert.deepEqual([stockAfter.currentStock, stockAfter.reservedStock], [stockBefore.currentStock, stockBefore.reservedStock]);
    assert.equal(await prisma.inventoryMovement.count({ where: { listingId: listing.id } }), movementsBefore);
  });

  it("allows CONFIRMED -> DISPATCHED directly and treats repeated preparing as a no-op", async () => {
    const admin = await makeUser("ADMIN");
    const customer = await makeUser("CUSTOMER");
    const direct = await makeOrder(customer.id);
    assert.equal((await dispatch(direct.order.id, admin.token)).status, 200);
    assert.deepEqual((await events(direct.order.id)).map((e) => [e.action, e.fromStage]), [["DISPATCHED", "CONFIRMED"]]);

    const repeated = await makeOrder(customer.id);
    assert.equal((await preparing(repeated.order.id, admin.token)).status, 200);
    const first = await prisma.order.findUniqueOrThrow({ where: { id: repeated.order.id } });
    assert.equal((await preparing(repeated.order.id, admin.token)).status, 200);
    assert.deepEqual((await prisma.order.findUniqueOrThrow({ where: { id: repeated.order.id } })).preparingAt, first.preparingAt);
    assert.equal((await events(repeated.order.id)).length, 1);
  });

  it("rejects invalid transitions without side effects", async () => {
    const admin = await makeUser("ADMIN");
    const customer = await makeUser("CUSTOMER");
    for (const status of ["PENDING", "CANCELLED", "EXPIRED"] as const) {
      const { order } = await makeOrder(customer.id, { status });
      assert.deepEqual(await errorCode(await preparing(order.id, admin.token)), [409, "FULFILMENT_TRANSITION_INVALID"], status);
      assert.deepEqual(await errorCode(await dispatch(order.id, admin.token)), [409, "FULFILMENT_TRANSITION_INVALID"], status);
      const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      assert.deepEqual([after.status, after.preparingAt, after.dispatchedAt], [status, null, null]);
      assert.equal((await events(order.id)).length, 0);
    }
    const { order } = await makeOrder(customer.id);
    await dispatch(order.id, admin.token);
    assert.deepEqual(await errorCode(await preparing(order.id, admin.token)), [409, "FULFILMENT_TRANSITION_INVALID"]);
    assert.equal((await call(`/admin/orders/2147483647/fulfilment/preparing`, admin.token, {})).status, 404);
    assert.equal((await call(`/admin/orders/abc/fulfilment/dispatch`, admin.token, royalMail)).status, 400);
  });
});

describe("payment eligibility", () => {
  it("rejects orders whose payment is missing, unsuccessful, refunding or refunded", async () => {
    const admin = await makeUser("ADMIN");
    const customer = await makeUser("CUSTOMER");
    const cases: Array<[string, (orderId: number) => Promise<unknown>]> = [
      ["NO_PAYMENT", async () => {}],
      ...(["PENDING", "PROCESSING", "FAILED", "CANCELED"] as const).map((status): [string, (orderId: number) => Promise<unknown>] => [status, async (orderId) => {
        const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
        await prisma.payment.create({ data: { orderId, amount: order.totalAmount, provider: "STRIPE", providerReference: `pi_${randomUUID()}`, status } });
      }]),
      ["SUCCEEDED without paidAt", async (orderId) => {
        const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
        await prisma.payment.create({ data: { orderId, amount: order.totalAmount, providerReference: `m_${randomUUID()}`, status: "SUCCEEDED" } });
      }],
      ["REFUND_IN_PROGRESS", async (orderId) => { const p = await recordVerifiedPayment(orderId); await prisma.payment.update({ where: { id: p.id }, data: { reservedRefundAmount: new Decimal(1) } }); }],
      ["FULLY_REFUNDED", async (orderId) => { const p = await recordVerifiedPayment(orderId); await prisma.payment.update({ where: { id: p.id }, data: { refundedAmount: p.amount } }); }],
    ];
    for (const [label, setup] of cases) {
      const { order } = await makeOrder(customer.id, { paid: false });
      await setup(order.id);
      assert.deepEqual(await errorCode(await preparing(order.id, admin.token)), [409, "ORDER_PAYMENT_NOT_VERIFIED"], label);
      assert.deepEqual(await errorCode(await dispatch(order.id, admin.token)), [409, "ORDER_PAYMENT_NOT_VERIFIED"], label);
      const legacy = await call(`/orders/${order.id}/dispatch`, admin.token, { actualShippingCost: 1, shippingCarrier: "Royal Mail" });
      assert.deepEqual(await errorCode(legacy), [409, "ORDER_PAYMENT_NOT_VERIFIED"], `legacy ${label}`);
      const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      assert.deepEqual([after.status, after.preparingAt, after.dispatchedAt], ["CONFIRMED", null, null], label);
      assert.equal(await prisma.shipment.count({ where: { orderId: order.id } }), 0);
      assert.equal((await events(order.id)).length, 0);
    }
    assert.equal(notifications.length, 0);
  });

  it("requires managed payment resolutions to be PAID while historical rows defer to the verified payment", async () => {
    const admin = await makeUser("ADMIN");
    const customer = await makeUser("CUSTOMER");
    // Timestamps must match the order exactly (enforced by the #156 schema), as in initializePaymentResolution().
    const resolution = async (orderId: number, data: Record<string, unknown>) => {
      const [stamp] = await prisma.$queryRaw<Array<{ createdAt: Date }>>`SELECT "createdAt" AT TIME ZONE 'UTC' AS "createdAt" FROM "Order" WHERE id = ${orderId}`;
      return prisma.paymentResolution.create({ data: {
        orderId, orderCreatedAt: stamp.createdAt, initialPaymentDeadline: new Date(stamp.createdAt.getTime() + 30 * 60_000), ...data,
      } });
    };
    for (const [label, data, expected] of [
      ["managed REVIEW_REQUIRED", { state: "REVIEW_REQUIRED", reservationDisposition: "HELD", dispositionAt: new Date() }, 409],
      ["managed SAFETY_HOLD", { state: "SAFETY_HOLD", reservationDisposition: "HELD", dispositionAt: new Date() }, 409],
      ["managed PAID but quarantined", { state: "PAID", reservationDisposition: "CONSUMED", dispositionAt: new Date(), quarantineReason: "conflicting evidence" }, 409],
      ["managed PAID", { state: "PAID", reservationDisposition: "CONSUMED", dispositionAt: new Date() }, 200],
      ["historical REVIEW_REQUIRED", { state: "REVIEW_REQUIRED", historical: true, quarantineReason: "historical" }, 200],
    ] as const) {
      const { order } = await makeOrder(customer.id);
      await resolution(order.id, data);
      const response = await dispatch(order.id, admin.token);
      assert.equal(response.status, expected, label);
      if (expected === 409) assert.equal((await response.json()).error.code, "ORDER_PAYMENT_NOT_VERIFIED", label);
    }
  });
});

describe("refund lock ordering", () => {
  it("does not deadlock with a concurrent refund reservation and rejects the refunding order", async () => {
    const admin = await makeUser("ADMIN");
    const customer = await makeUser("CUSTOMER");
    const { order } = await makeOrder(customer.id);
    const refund = new pg.Client({ connectionString: config.DATABASE_URL });
    await refund.connect();
    try {
      // Refund preparation: lock Payment and reserve capacity (refundCapacityService) ...
      await refund.query("BEGIN");
      await refund.query(`SELECT id FROM "Payment" WHERE "orderId" = $1 FOR UPDATE`, [order.id]);
      await refund.query(`UPDATE "Payment" SET "reservedRefundAmount" = 1 WHERE "orderId" = $1`, [order.id]);
      // ... while fulfilment takes the Order lock and waits for the Payment lock.
      const fulfilment = startPreparing(admin.id, order.id).then(() => null, (error: unknown) => error);
      for (let i = 0; i < 100; i += 1) {
        const { rows } = await refund.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%"Payment"%FOR UPDATE%' AND pid <> pg_backend_pid()`);
        if (rows[0].n > 0) break;
        await new Promise((done) => setTimeout(done, 20));
      }
      // ... then the refund row is inserted, whose foreign key takes FOR KEY SHARE on the Order row.
      await refund.query(`SELECT id FROM "Order" WHERE id = $1 FOR KEY SHARE`, [order.id]);
      await refund.query("COMMIT");
      const error = await fulfilment;
      assert.ok(error instanceof FulfilmentPaymentNotVerifiedError && error.reason === "REFUND_IN_PROGRESS", String(error));
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).preparingAt, null);
    } finally {
      await refund.query("ROLLBACK").catch(() => {});
      await refund.end();
    }
  });
});

describe("authorization and ownership", () => {
  it("restricts fulfilment changes to ADMIN and order reads to the owning customer", async () => {
    const admin = await makeUser("ADMIN");
    const owner = await makeUser("CUSTOMER");
    const other = await makeUser("CUSTOMER");
    const { order } = await makeOrder(owner.id);
    assert.equal((await preparing(order.id, owner.token)).status, 403);
    assert.equal((await dispatch(order.id, owner.token)).status, 403);
    assert.equal((await preparing(order.id, "")).status, 401);
    assert.equal((await dispatch(order.id, "")).status, 401);
    assert.equal((await call(`/orders/${order.id}/dispatch`, owner.token, { actualShippingCost: 1, shippingCarrier: "Royal Mail" })).status, 403);

    assert.equal((await dispatch(order.id, admin.token)).status, 200);
    assert.equal((await call(`/orders/${order.id}`, other.token)).status, 404);
    assert.equal((await call(`/orders/${order.id}`, admin.token)).status, 404, "customer reads stay ownership-scoped for admins");
    assert.ok(!(await (await call("/orders", other.token)).json()).some((row: any) => row.id === order.id));
    assert.equal((await call(`/admin/orders/${order.id}`, owner.token)).status, 403);
  });
});

describe("tracking validation", () => {
  it("rejects untrusted carriers, URLs and invalid tracking numbers before any change", async () => {
    const admin = await makeUser("ADMIN");
    const customer = await makeUser("CUSTOMER");
    const { order } = await makeOrder(customer.id);
    for (const body of [
      { ...royalMail, carrier: "UPS" },
      { ...royalMail, trackingNumber: "NOT-A-ROYAL-MAIL-NUMBER" },
      { ...royalMail, trackingUrl: "https://evil.example/track" },
      { ...royalMail, carrier: "OTHER", trackingNumber: "TRACK123" },
      { ...royalMail, carrierName: "Royal Mail" },
    ]) {
      assert.equal((await dispatch(order.id, admin.token, body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, "CONFIRMED");

    const other = await dispatch(order.id, admin.token, { carrier: "OTHER", carrierName: "Local Courier", trackingNumber: "lc-998877", actualShippingCost: 0 });
    assert.equal(other.status, 200);
    const customerView = await (await call(`/orders/${order.id}`, customer.token)).json();
    assert.deepEqual(customerView.fulfilment.shipments.map((s: any) => [s.carrier, s.carrierName, s.trackingNumber, s.trackingUrl]), [["OTHER", "Local Courier", "LC998877", null]]);
  });
});

describe("repeated and concurrent dispatch", () => {
  it("serializes concurrent identical dispatches into one shipment, one audit event and one notification", async () => {
    const admin = await makeUser("ADMIN");
    const customer = await makeUser("CUSTOMER");
    const { order } = await makeOrder(customer.id);
    const responses = await Promise.all([dispatch(order.id, admin.token), dispatch(order.id, admin.token), dispatch(order.id, admin.token)]);
    assert.deepEqual(responses.map((r) => r.status), [200, 200, 200]);
    assert.equal(await prisma.shipment.count({ where: { orderId: order.id } }), 1);
    assert.deepEqual((await events(order.id)).map((e) => e.action), ["DISPATCHED"]);
    assert.equal(notifications.length, 1);
  });

  it("never overwrites shipment details when concurrent or later requests differ", async () => {
    const admin = await makeUser("ADMIN");
    const customer = await makeUser("CUSTOMER");
    const { order } = await makeOrder(customer.id);
    const evri = { carrier: "EVRI", trackingNumber: "H01ABC2345678901", actualShippingCost: 2 };
    const responses = await Promise.all([dispatch(order.id, admin.token), dispatch(order.id, admin.token, evri)]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    const loser = responses.find((r) => r.status === 409)!;
    assert.equal((await loser.json()).error.code, "ORDER_ALREADY_DISPATCHED");
    const before = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { shipments: true } });
    assert.equal(before.shipments.length, 1);
    assert.equal(before.shipments[0].trackingNumber, before.trackingNumber);

    const later = before.shipments[0].carrier === "ROYAL_MAIL" ? evri : royalMail;
    assert.deepEqual(await errorCode(await dispatch(order.id, admin.token, later)), [409, "ORDER_ALREADY_DISPATCHED"]);
    assert.equal((await call(`/orders/${order.id}/dispatch`, admin.token, { actualShippingCost: 9, shippingCarrier: "DPD" })).status, 400, "legacy repeat keeps its 400");
    assert.deepEqual(await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { shipments: true } }), before);
    assert.equal((await events(order.id)).length, 1);
  });
});

describe("historical and legacy compatibility", () => {
  it("presents pre-existing dispatched orders without fabricating progress or untrusted links", async () => {
    const customer = await makeUser("CUSTOMER");
    const { order: rm } = await makeOrder(customer.id);
    const dispatchedAt = new Date("2026-01-02T03:04:05.000Z");
    await prisma.order.update({ where: { id: rm.id }, data: { status: "COMPLETED", shippingCarrier: "royal mail", trackingNumber: "AB123456789GB", dispatchedAt } });
    const { order: ups } = await makeOrder(customer.id);
    await prisma.order.update({ where: { id: ups.id }, data: { status: "DISPATCHED", shippingCarrier: "UPS", trackingNumber: "1Z999AA10123456784", dispatchedAt } });
    const { order: confirmed } = await makeOrder(customer.id);
    const { order: completedWithoutDispatch } = await makeOrder(customer.id);
    await prisma.order.update({ where: { id: completedWithoutDispatch.id }, data: { status: "COMPLETED" } });

    const view = async (id: number) => (await (await call(`/orders/${id}`, customer.token)).json()).fulfilment;
    const rmView = await view(rm.id);
    assert.equal(rmView.stage, "DISPATCHED");
    assert.deepEqual(rmView.shipments.map((s: any) => [s.carrier, s.carrierName, s.trackingUrl]), [["ROYAL_MAIL", "royal mail", "https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB"]]);
    const upsView = await view(ups.id);
    assert.deepEqual([upsView.stage, upsView.shipments[0].carrier, upsView.shipments[0].trackingUrl], ["DISPATCHED", null, null]);
    assert.deepEqual(await view(confirmed.id), { stage: "CONFIRMED", preparingAt: null, dispatchedAt: null, shipments: [] });
    assert.deepEqual(await view(completedWithoutDispatch.id), { stage: null, preparingAt: null, dispatchedAt: null, shipments: [] });
    assert.equal(await prisma.shipment.count({ where: { orderId: { in: [rm.id, ups.id] } } }), 0, "reads never write shipments");
  });

  it("records a shipment and audit event for the existing dispatch endpoint, including from Preparing", async () => {
    const admin = await makeUser("ADMIN");
    const customer = await makeUser("CUSTOMER");
    const { order } = await makeOrder(customer.id);
    await preparing(order.id, admin.token);
    const response = await call(`/orders/${order.id}/dispatch`, admin.token, { actualShippingCost: 4, shippingCarrier: "Royal Mail", trackingNumber: "AB123456789GB" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual([body.status, body.shippingCarrier, body.trackingNumber], ["DISPATCHED", "Royal Mail", "AB123456789GB"]);
    assert.ok(!("actualShippingCost" in body));
    const shipment = await prisma.shipment.findFirstOrThrow({ where: { orderId: order.id } });
    assert.deepEqual([shipment.carrier, shipment.carrierName, shipment.createdByUserId], ["ROYAL_MAIL", "Royal Mail", admin.id]);
    assert.deepEqual((await events(order.id)).map((e) => [e.action, e.fromStage, e.source]), [
      ["PREPARING_STARTED", "CONFIRMED", "ADMIN_FULFILMENT_API"], ["DISPATCHED", "PREPARING", "LEGACY_DISPATCH_API"],
    ]);
    const customerView = await (await call(`/orders/${order.id}`, customer.token)).json();
    assert.equal(customerView.fulfilment.shipments[0].trackingUrl, "https://www.royalmail.com/track-your-item#/tracking-results/AB123456789GB");
  });
});
