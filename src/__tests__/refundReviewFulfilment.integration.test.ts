import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { createOrder } from "../domain/orders/orderService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import { createOrReuseStripeRefund } from "../domain/refunds/stripeRefundService.js";
import { reconcileRefundWebhook } from "../domain/refunds/refundWebhookService.js";

const users: number[] = [], products: number[] = [], orders: number[] = [], receipts: string[] = [];
let server: ReturnType<typeof app.listen>, base: string;
const originalEmailFlag = config.DISPATCH_CONFIRMATION_EMAIL_ENABLED;
beforeEach(() => { config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = true; });
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
});
afterEach(async () => {
  config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = originalEmailFlag;
  await prisma.paymentWebhookEvent.deleteMany({ where: { providerEventId: { in: receipts.splice(0) } } });
  await prisma.order.deleteMany({ where: { id: { in: orders.splice(0) } } });
  await prisma.inventoryMovement.deleteMany({ where: { listing: { legoProductId: { in: products } } } });
  await prisma.productListing.deleteMany({ where: { legoProductId: { in: products } } });
  await prisma.legoProduct.deleteMany({ where: { id: { in: products.splice(0) } } });
  await prisma.address.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await prisma.$disconnect(); });

async function fixture() {
  const identity = async (role: "ADMIN" | "CUSTOMER") => {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "synthetic", emailVerified: true, role,
      addresses: { create: { recipientName: "Test", line1: "1 Test Road", city: "London", postcode: "SW1A 1AA", countryCode: "GB", isDefaultBilling: true } } } });
    users.push(user.id); return { ...user, token: jwt.sign({ id: user.id, role }, config.JWT_SECRET) };
  };
  const admin = await identity("ADMIN"), customer = await identity("CUSTOMER");
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: "Refund review fixture", theme: "TEST", ageRecommendation: "8+", pieceCount: 1 } }); products.push(product.id);
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: 20, currentStock: 5 } });
  const order = await createOrder(customer.id, { shippingMethod: "STANDARD", items: [{ productListingId: listing.id, quantity: 1 }] }); orders.push(order.id);
  const payment = await prisma.payment.create({ data: { orderId: order.id, amount: order.totalAmount, currency: "GBP", provider: "STRIPE", providerReference: `pi_${randomUUID()}`, status: "SUCCEEDED", paidAt: new Date() } });
  await confirmOrder(admin.id, order.id); // Real sale deduction, not a fabricated CONFIRMED state.
  return { admin, customer, listing, order, payment };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const royalMail = { carrier: "ROYAL_MAIL", trackingNumber: "AB123456789GB", actualShippingCost: 3.5 };
const paths = ["preparing", "dispatch", "legacy"] as const;
type Path = typeof paths[number];
function action(f: Fixture, path: Path, token = f.admin.token) {
  return fetch(base + (path === "legacy" ? `/orders/${f.order.id}/dispatch` : `/admin/orders/${f.order.id}/fulfilment/${path}`), {
    method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(path === "preparing" ? {} : path === "legacy" ? { actualShippingCost: 3.5, shippingCarrier: "Royal Mail", trackingNumber: "AB123456789GB" } : royalMail),
  });
}
async function refund(f: Fixture, status: "SUCCEEDED" | "FAILED" | "PROCESSING", amount = 5) {
  return createOrReuseStripeRefund(f.order.id, f.payment.id, amount, "Synthetic refund", f.admin.id, {
    createRefund: async () => ({ id: `re_${randomUUID()}`, status: status === "SUCCEEDED" ? "succeeded" : status === "FAILED" ? "failed" : "pending",
      amount: Math.round(amount * 100), currency: "gbp", payment_intent: f.payment.providerReference, metadata: {} }),
  }, undefined, randomUUID());
}
async function observe(f: Fixture, reference: string, status: "SUCCEEDED" | "FAILED", amount = "5") {
  const id = randomUUID(); receipts.push(id);
  return reconcileRefundWebhook({ version: 2, kind: "refund", provider: "STRIPE", id, eventType: "refund.updated", reference,
    parentReference: f.payment.providerReference, amount, currency: "GBP", status });
}
async function snapshot(f: Fixture) {
  return {
    stock: await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } }),
    payment: await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } }),
    refunds: await prisma.refund.findMany({ where: { paymentId: f.payment.id }, orderBy: { id: "asc" } }),
    order: await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } }),
    movements: await prisma.inventoryMovement.findMany({ where: { listingId: f.listing.id } }),
    shipments: await prisma.shipment.findMany({ where: { orderId: f.order.id } }),
    events: await prisma.orderFulfilmentEvent.findMany({ where: { orderId: f.order.id } }),
    notifications: await prisma.orderConfirmationJob.findMany({ where: { orderId: f.order.id } }),
  };
}
async function assertReviewRejected(response: Response) {
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "reason"]);
  assert.equal(body.error.code, "REFUND_REVIEW_REQUIRED");
  assert.equal(body.error.reason, "REFUND_REVIEW_REQUIRED");
  assert.match(body.error.message, /Resolve the refund review before preparing or dispatching/);
  assert.doesNotMatch(JSON.stringify(body), /pi_|re_|providerReference|reviewEvidence|clientRequestKey/);
}

for (const status of ["SUCCEEDED", "FAILED"] as const) {
  for (const code of ["PROVIDER_EVIDENCE_MISMATCH", "TERMINAL_EVIDENCE_CONFLICT", "PROVIDER_EVIDENCE_REVIEW_REQUIRED"] as const) {
    it(`blocks all fulfilment paths for terminal ${status} / ${code} without any mutation`, async () => {
      const f = await fixture();
      const r = await refund(f, code === "PROVIDER_EVIDENCE_REVIEW_REQUIRED" ? "PROCESSING" : status);
      if (code === "PROVIDER_EVIDENCE_REVIEW_REQUIRED") { await observe(f, r.providerReference, status, "4"); await observe(f, r.providerReference, status); }
      else await observe(f, r.providerReference, code === "TERMINAL_EVIDENCE_CONFLICT" ? status === "SUCCEEDED" ? "FAILED" : "SUCCEEDED" : status, code === "PROVIDER_EVIDENCE_MISMATCH" ? "4" : "5");
      const current = await prisma.refund.findUniqueOrThrow({ where: { id: r.id } });
      assert.equal(current.status, status); assert.equal(current.resolutionCode, code); assert.equal(current.reviewRequired, true);
      const before = await snapshot(f);
      for (const path of paths) await assertReviewRejected(await action(f, path));
      assert.deepEqual(await snapshot(f), before);
    });
  }
}
for (const path of ["dispatch", "legacy"] as const) {
  it(`preserves legitimate partial refunds and ${path} dispatch`, async () => {
    const f = await fixture(); await refund(f, "SUCCEEDED"); const before = await snapshot(f);
    assert.equal((await action(f, "preparing")).status, 200);
    assert.equal((await action(f, path)).status, 200);
    const after = await snapshot(f);
    assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.movements, before.movements);
    assert.deepEqual(after.payment, before.payment); assert.deepEqual(after.refunds, before.refunds);
    assert.equal(after.shipments.length, 1); assert.equal(after.events.length, 2);
    if (path === "dispatch") { assert.equal((await action(f, path)).status, 200); assert.deepEqual(await snapshot(f), after); }
  });
}
it("preserves eligibility after an unconflicted failed refund", async () => {
  const f = await fixture(); await refund(f, "FAILED"); assert.equal((await action(f, "dispatch")).status, 200);
});
for (const state of ["pending", "full"] as const) {
  it(`preserves ${state} refund restrictions on all paths`, async () => {
    const f = await fixture(); await refund(f, state === "pending" ? "PROCESSING" : "SUCCEEDED", state === "full" ? Number(f.payment.amount) : 5);
    const before = await snapshot(f);
    for (const path of paths) { const response = await action(f, path); assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "ORDER_PAYMENT_NOT_VERIFIED"); }
    assert.deepEqual(await snapshot(f), before);
  });
}
it("preserves payment-security holds", async () => {
  const f = await fixture(); await refund(f, "SUCCEEDED");
  await prisma.paymentFulfilmentReview.create({ data: { orderId: f.order.id, reason: "ADMIN_REVIEW" } });
  const before = await snapshot(f);
  for (const path of paths) { const response = await action(f, path); assert.equal(response.status, 409); assert.match((await response.json()).error.message, /SECURITY_REVIEW_REQUIRED/); }
  assert.deepEqual(await snapshot(f), before);
});
it("scopes review blocking to the payment rather than unrelated refunds", async () => {
  const unrelated = await fixture(), f = await fixture(); const r = await refund(unrelated, "SUCCEEDED");
  await observe(unrelated, r.providerReference, "FAILED");
  assert.equal((await action(f, "dispatch")).status, 200);
});
it("blocks processing refunds requiring review too, without clearing their reservation", async () => {
  const f = await fixture(); const r = await refund(f, "PROCESSING"); await observe(f, r.providerReference, "SUCCEEDED", "4");
  const before = await snapshot(f); for (const path of paths) await assertReviewRejected(await action(f, path)); assert.deepEqual(await snapshot(f), before);
});
it("keeps authentication and ADMIN authorization before review information", async () => {
  const f = await fixture(); const r = await refund(f, "SUCCEEDED"); await observe(f, r.providerReference, "FAILED");
  for (const path of paths) {
    const denied = await action(f, path, f.customer.token); assert.equal(denied.status, 403); assert.doesNotMatch(await denied.text(), /REFUND_REVIEW_REQUIRED/);
    assert.equal((await action(f, path, "")).status, 401);
  }
});

/** Observe actual PostgreSQL waiter chains so both transaction orders are deterministic. */
async function queued<T, U>(f: Fixture, first: () => Promise<T>, second: () => Promise<U>) {
  let unlock!: () => void, announce!: () => void, owner = 0;
  const locked = new Promise<void>(resolve => { announce = resolve; });
  const release = new Promise<void>(resolve => { unlock = resolve; });
  const blocker = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${f.order.id} FOR NO KEY UPDATE`;
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; owner = row.pid; announce(); await release;
  }, { timeout: 15000 });
  await locked;
  const waitFor = async (count: number) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const [row] = await prisma.$queryRaw<Array<{ count: number }>>`WITH RECURSIVE waiting AS (
        SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${owner}=ANY(pg_blocking_pids(pid))
        UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()
      ) SELECT count(*)::int AS count FROM waiting`;
      if (row.count >= count) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Expected PostgreSQL lock wait was not observed");
  };
  let a!: Promise<T>, b!: Promise<U>;
  try { a = first(); await waitFor(1); b = second(); await waitFor(2); }
  finally { unlock(); await blocker; }
  return Promise.all([a, b]);
}
for (const path of paths) {
  it(`blocks concurrent ${path} when the webhook conflict commits first`, async () => {
    const f = await fixture(); const r = await refund(f, "FAILED"); const before = await snapshot(f);
    const [, response] = await queued(f, () => observe(f, r.providerReference, "SUCCEEDED"), () => action(f, path));
    await assertReviewRejected(response);
    const after = await snapshot(f);
    assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.movements, before.movements); assert.deepEqual(after.payment, before.payment);
    assert.deepEqual(after.order, before.order); assert.deepEqual(after.shipments, before.shipments); assert.deepEqual(after.events, before.events); assert.deepEqual(after.notifications, before.notifications);
    assert.equal(after.refunds[0].reviewRequired, true); assert.equal(after.refunds[0].status, "FAILED");
  });
  it(`a durable receipt blocks queued ${path} before admission even while processing waits`, async () => {
    const f = await fixture(); const r = await refund(f, "SUCCEEDED"); const before = await snapshot(f);
    const [response] = await queued(f, () => action(f, path), () => observe(f, r.providerReference, "FAILED"));
    // Receipt persistence precedes processing. The new provider-evidence guard
    // conservatively sees it even though fulfilment queued for Order first.
    await assertReviewRejected(response);
    const after = await snapshot(f);
    assert.equal(after.refunds[0].reviewRequired, true); assert.equal(after.refunds[0].status, "SUCCEEDED");
    assert.deepEqual(after.stock, before.stock); assert.deepEqual(after.movements, before.movements); assert.deepEqual(after.payment, before.payment);
    assert.deepEqual(after.order,before.order);assert.equal(after.shipments.length,0);assert.equal(after.events.length,0);
    await assertReviewRejected(await action(f,path));
  });
}
