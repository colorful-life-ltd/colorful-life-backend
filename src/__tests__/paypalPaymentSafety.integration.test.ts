import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { after, afterEach, before, describe, it } from "node:test";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { createOrder } from "../domain/orders/orderService.js";
import { cancelOrder, cancelOrderByAdmin } from "../domain/orders/orderCancellationService.js";
import { OrderCancellationPaymentError } from "../domain/orders/orderCancellationErrors.js";
import { expireOrderReservation } from "../domain/orders/orderExpiryService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import { createOrReusePayPalOrder, PayPalOrderAlreadyCompletedError } from "../domain/payments/paypalOrderService.js";
import { capturePayPalOrder, PayPalCaptureCancelledError, PayPalCaptureExpiredError, PayPalCaptureMismatchError, PayPalCaptureOwnershipError, type PayPalCaptureClient } from "../domain/payments/paypalCaptureService.js";
import { reconcilePayPalWebhookEvent, persistVerifiedPayPalWebhookEvent } from "../domain/payments/paypalReconciliationService.js";
import { replayPendingPayPalWebhooks } from "../domain/payments/paypalWebhookReplayService.js";
import { setPayPalCaptureClientForTests } from "../domain/payments/paypalCaptureService.js";
import { setPayPalWebhookVerifierForTests } from "../controllers/paypalWebhookController.js";

const users: number[] = [], orders: number[] = [], listings: number[] = [], products: number[] = [], receipts: string[] = [];
let server: ReturnType<typeof app.listen>, url: string;
before(async () => {
  server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  url = `http://localhost:${(server.address() as { port: number }).port}`;
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await prisma.$disconnect(); });
afterEach(async () => {
  await prisma.paymentWebhookEvent.deleteMany({ where: { providerEventId: { in: receipts.splice(0) } } });
  await prisma.order.deleteMany({ where: { id: { in: orders.splice(0) } } });
  await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listings } } });
  await prisma.productListing.deleteMany({ where: { id: { in: listings.splice(0) } } });
  await prisma.legoProduct.deleteMany({ where: { id: { in: products.splice(0) } } });
  await prisma.address.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
async function user() {
  const u = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "test", emailVerified: true,
    addresses: { create: { recipientName: "Buyer", line1: "1 Test Street", city: "London", postcode: "T1", countryCode: "GB", isDefaultBilling: true } } } });
  users.push(u.id); return u;
}
async function fixture(withPayment = true) {
  const owner = await user();
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: "PayPal safety", theme: "TEST", ageRecommendation: "8+", pieceCount: 10 } }); products.push(product.id);
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: 10, currentStock: 10 } }); listings.push(listing.id);
  const order = await createOrder(owner.id, { items: [{ productListingId: listing.id, quantity: 2 }] }); orders.push(order.id);
  const f = { owner, listing, order };
  return { ...f, payment: withPayment ? await addPayment(f) : null };
}
async function addPayment(f: { order: { id: number; totalAmount: unknown } }) {
  return prisma.payment.create({ data: { orderId: f.order.id, amount: String(f.order.totalAmount), currency: "GBP", provider: "PAYPAL", providerReference: `PP-${randomUUID()}`, status: "PENDING" } });
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function gate<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function captureClient(f: Fixture, captureId = `CAP-${randomUUID()}`) {
  receipts.push(`capture:${captureId}`);
  return { captureId, client: { captureOrder: async (id: string) => ({ id, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: captureId, status: "COMPLETED", amount: { value: String(Number(f.order.totalAmount).toFixed(2)), currency_code: "GBP" } }] } }] }) } satisfies PayPalCaptureClient };
}
function event(f: Fixture, captureId: string, eventType = "PAYMENT.CAPTURE.COMPLETED") {
  const id = `WH-${randomUUID()}`; receipts.push(id);
  return { id, eventType, paypalOrderId: f.payment!.providerReference, captureId, amount: Number(f.order.totalAmount).toFixed(2), currency: "GBP" };
}
async function inventory(f: Fixture, reserved: number, current = 10, sales = 0) {
  const row = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } });
  assert.equal(row.reservedStock, reserved); assert.equal(row.currentStock, current);
  assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.listing.id, type: "WEBSITE_SALE" } }), sales);
  assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.listing.id, type: "ORDER_CANCELLATION_RETURN" } }), 0);
}
async function paid(f: Fixture, captureId: string, paidAt?: Date) {
  const p = await prisma.payment.findUniqueOrThrow({ where: { orderId: f.order.id } });
  assert.equal(p.status, "SUCCEEDED"); assert.equal(p.providerCaptureReference, captureId); assert.ok(p.paidAt);
  if (paidAt) assert.equal(p.paidAt.getTime(), paidAt.getTime());
  return p.paidAt;
}
async function holdOrder(orderId: number) {
  const entered = gate<number>(), release = gate();
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    entered.resolve(pid); await release.promise;
  }, { timeout: 15_000 });
  const pid = await entered.promise;
  return { holder, release, async wait(count = 1) {
    const deadline = Date.now() + 5000;
    while (true) {
      const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
        WITH RECURSIVE blocked(pid) AS (SELECT ${pid}::integer UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid)))
        SELECT (count(*) - 1)::integer AS count FROM blocked`;
      if (row.count >= count) return;
      assert.ok(Date.now() < deadline, "operation did not reach a real PostgreSQL lock wait");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } };
}

async function receipt(id: string) {
  return prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: "PAYPAL", providerEventId: id } } });
}
async function deliver(e: ReturnType<typeof event>) {
  return fetch(`${url}/payments/paypal/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
    id: e.id, event_type: e.eventType, resource: { id: e.captureId, amount: { value: e.amount, currency_code: e.currency },
      supplementary_data: { related_ids: { order_id: e.paypalOrderId } } },
  }) });
}
function replayProcess(paypalOrderId: string) {
  const replayUrl = new URL("../domain/payments/paypalWebhookReplayService.js", import.meta.url).href;
  const prismaUrl = new URL("../prisma/runtime.js", import.meta.url).href;
  const source = `const { replayPendingPayPalWebhooks } = await import(${JSON.stringify(replayUrl)});
    const { prisma } = await import(${JSON.stringify(prismaUrl)});
    try { process.stdout.write(JSON.stringify(await replayPendingPayPalWebhooks({ paypalOrderId: ${JSON.stringify(paypalOrderId)}, pageSize: 1 }))); }
    finally { await prisma.$disconnect(); }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (data) => { stdout += data; }); child.stderr.on("data", (data) => { stderr += data; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}

// Only provider I/O is faked. Transactions, authorization, constraints and lock
// contention below use the guarded PostgreSQL test database.
describe("PayPal lifecycle security (#153)", { concurrency: 1, timeout: 30_000 }, () => {
  it("authorizes a second customer before exposing an in-flight capture over HTTP", async () => {
    const f = await fixture(), other = await user(), entered = gate(), release = gate();
    const c = captureClient(f); let calls = 0;
    const restore = setPayPalCaptureClientForTests({ captureOrder: async (...args) => { calls++; entered.resolve(); await release.promise; return c.client.captureOrder(args[0]); } });
    const post = (id: number) => fetch(`${url}/orders/${f.order.id}/payments/paypal/capture`, { method: "POST", headers: { Authorization: `Bearer ${jwt.sign({ id }, config.JWT_SECRET)}` } });
    const first = post(f.owner.id);
    try {
      await entered.promise;
      const denied = await post(other.id); assert.equal(denied.status, 404); assert.deepEqual(await denied.json(), { error: "Order not found" });
      const repeated = post(f.owner.id); release.resolve();
      const responses = await Promise.all([first, repeated]);
      assert.ok(responses.every((r) => r.status === 200));
      for (const response of responses) assert.deepEqual(await response.json(), { paypalOrderId: f.payment!.providerReference, captureId: c.captureId });
      assert.equal(calls, 1); await paid(f, c.captureId); await inventory(f, 2);
    } finally { release.resolve(); await first; restore(); }
  });

  it("replays successful capture without provider I/O and retains the first paidAt", async () => {
    const f = await fixture(), c = captureClient(f);
    const first = await capturePayPalOrder(f.order.id, f.owner.id, c.client); const at = await paid(f, c.captureId);
    await prisma.order.update({ where: { id: f.order.id }, data: { reservationExpiresAt: new Date(0) } });
    const replay = await capturePayPalOrder(f.order.id, f.owner.id, { captureOrder: async () => { assert.fail("replay called PayPal"); } });
    assert.deepEqual(replay, first); await paid(f, c.captureId, at); await inventory(f, 2);
  });

  it("does not return cached identifiers after database ownership changes", async () => {
    const f = await fixture(), other = await user(), c = captureClient(f), entered = gate(), release = gate();
    const first = capturePayPalOrder(f.order.id, f.owner.id, { captureOrder: async (id) => { entered.resolve(); await release.promise; return c.client.captureOrder(id); } });
    const rejected = assert.rejects(first, PayPalCaptureOwnershipError);
    try { await entered.promise; await prisma.order.update({ where: { id: f.order.id }, data: { userId: other.id } }); release.resolve(); await rejected; await paid(f, c.captureId); }
    finally { release.resolve(); await rejected; }
  });

  for (const completion of ["capture", "webhook"] as const) {
  it(`preserves successful ${completion} when another initiation response arrives late`, async () => {
    const f = await fixture(false), entered = gate(), release = gate(); const providerId = `PP-${randomUUID()}`;
    let calls = 0;
    const client = { createOrder: async () => { if (++calls === 1) { entered.resolve(); await release.promise; } return { id: providerId }; } };
    const delayed = createOrReusePayPalOrder(f.order.id, f.owner.id, client);
    const rejected = assert.rejects(delayed, PayPalOrderAlreadyCompletedError);
    try {
      await entered.promise; await createOrReusePayPalOrder(f.order.id, f.owner.id, client);
      f.payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: f.order.id } });
      const c = captureClient(f);
      if (completion === "capture") await capturePayPalOrder(f.order.id, f.owner.id, c.client);
      else assert.equal((await reconcilePayPalWebhookEvent(event(f, c.captureId))).handled, true);
      const at = await paid(f, c.captureId);
      release.resolve(); await rejected; await paid(f, c.captureId, at);
      assert.equal((await prisma.payment.findUniqueOrThrow({ where: { orderId: f.order.id } })).providerReference, providerId);
      assert.equal(await prisma.payment.count({ where: { orderId: f.order.id } }), 1); await inventory(f, 2);
    } finally { release.resolve(); await rejected; }
  });

  }

  for (const status of ["PROCESSING", "FAILED", "CANCELED"] as const) {
    it(`does not reset ${status} after a delayed initiation response`, async () => {
      const f = await fixture(false), entered = gate(), release = gate();
      const delayed = createOrReusePayPalOrder(f.order.id, f.owner.id, { createOrder: async () => { entered.resolve(); await release.promise; return { id: `PP-${randomUUID()}` }; } });
      try { await entered.promise; await prisma.payment.update({ where: { orderId: f.order.id }, data: { status } }); release.resolve(); await delayed;
        assert.equal((await prisma.payment.findUniqueOrThrow({ where: { orderId: f.order.id } })).status, status); }
      finally { release.resolve(); await delayed; }
    });
  }

  for (const terminal of ["CANCELLED", "EXPIRED"] as const) {
    it(`rejects a new capture on a historically ${terminal} order without touching inventory`, async () => {
      const f = await fixture(false);
      if (terminal === "CANCELLED") await cancelOrder(f.owner.id, f.order.id, "CHANGED_MIND");
      else await expireOrderReservation(f.order.id, new Date(f.order.reservationExpiresAt!.getTime() + 1));
      f.payment = await addPayment(f); // Explicit historical inconsistency: stock was already released.
      await assert.rejects(capturePayPalOrder(f.order.id, f.owner.id, { captureOrder: async () => { assert.fail("terminal order called PayPal"); } }), terminal === "CANCELLED" ? PayPalCaptureCancelledError : PayPalCaptureExpiredError);
      assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, "PENDING"); await inventory(f, 0);
    });

    it(`records repeated late success on historical ${terminal} without fulfilment or stock resurrection`, async () => {
      const f = await fixture(false);
      if (terminal === "CANCELLED") await cancelOrder(f.owner.id, f.order.id, "CHANGED_MIND");
      else await expireOrderReservation(f.order.id, new Date(f.order.reservationExpiresAt!.getTime() + 1));
      f.payment = await addPayment(f); const c = captureClient(f), e = event(f, c.captureId);
      assert.deepEqual(await reconcilePayPalWebhookEvent(e), { duplicate: false, handled: true }); const at = await paid(f, c.captureId);
      assert.deepEqual(await reconcilePayPalWebhookEvent(e), { duplicate: true, handled: true });
      assert.equal((await reconcilePayPalWebhookEvent(event(f, c.captureId))).handled, true);
      await reconcilePayPalWebhookEvent(event(f, c.captureId, "PAYMENT.CAPTURE.DENIED"));
      await paid(f, c.captureId, at); assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, terminal);
      const receipt = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: "PAYPAL", providerEventId: e.id } } });
      assert.ok(receipt.processedAt); assert.match(receipt.processingError!, /requires refund\/reconciliation/); await inventory(f, 0);
    });
  }

  it("serializes pending and denied events behind success using real Order lock waits", async () => {
    const f = await fixture(), c = captureClient(f), held = await holdOrder(f.order.id);
    const pending = reconcilePayPalWebhookEvent(event(f, c.captureId, "PAYMENT.CAPTURE.PENDING"));
    const denied = reconcilePayPalWebhookEvent(event(f, c.captureId, "PAYMENT.CAPTURE.DENIED"));
    const results = Promise.all([pending, denied]); const at = new Date("2025-01-01T00:00:00Z");
    try { await held.wait(2); await prisma.payment.update({ where: { id: f.payment!.id }, data: { status: "SUCCEEDED", paidAt: at, providerCaptureReference: c.captureId } }); }
    finally { held.release.resolve(); await held.holder; }
    assert.ok((await results).every((r) => r.handled)); await paid(f, c.captureId, at); await inventory(f, 2);
  });

  it("serializes concurrent completed webhook receipts and preserves first paidAt", async () => {
    const f = await fixture(), c = captureClient(f), e = event(f, c.captureId), held = await holdOrder(f.order.id);
    const results = Promise.all([reconcilePayPalWebhookEvent(e), reconcilePayPalWebhookEvent(e)]);
    try { await held.wait(2); } finally { held.release.resolve(); await held.holder; }
    const r = await results; assert.equal(r.filter((x) => x.duplicate).length, 1); assert.ok(r.every((x) => x.handled));
    const at = await paid(f, c.captureId); await reconcilePayPalWebhookEvent(event(f, c.captureId)); await paid(f, c.captureId, at);
    assert.equal(await prisma.paymentWebhookEvent.count({ where: { provider: "PAYPAL", providerEventId: e.id } }), 1); await inventory(f, 2);
  });

  it("does not acknowledge duplicate validation failures as handled success", async () => {
    const f = await fixture(), c = captureClient(f), bad = { ...event(f, c.captureId), amount: "99.00" };
    assert.deepEqual(await reconcilePayPalWebhookEvent(bad), { duplicate: false, handled: false });
    assert.deepEqual(await reconcilePayPalWebhookEvent(bad), { duplicate: true, handled: false });
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } })).status, "PENDING"); await inventory(f, 2);
  });

  it("rolls back financial processing on unrelated uniqueness failures while retaining durable evidence and HTTP 500", async () => {
    const f = await fixture(), other = await fixture(), c = captureClient(f), e = event(f, c.captureId), held = await holdOrder(f.order.id);
    const restore = setPayPalWebhookVerifierForTests(async () => true);
    const post = () => fetch(`${url}/payments/paypal/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: e.id, event_type: e.eventType, resource: { id: c.captureId, amount: { value: e.amount, currency_code: e.currency }, supplementary_data: { related_ids: { order_id: e.paypalOrderId } } } }) });
    const request = post();
    try {
      await held.wait();
      // Correlation has found f; introduce a real, unrelated unique-key collision
      // before its locked payment update, rather than mocking a Prisma exception.
      await prisma.payment.update({ where: { id: other.payment!.id }, data: { providerCaptureReference: c.captureId } });
      held.release.resolve(); await held.holder;
      const failed = await request; assert.equal(failed.status, 500); assert.deepEqual(await failed.json(), { error: "Webhook processing failed" });
      const retained = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: "PAYPAL", providerEventId: e.id } } });
      assert.equal(retained.processedAt, null); assert.ok(retained.evidence);
      const p = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } }); assert.equal(p.status, "PENDING"); assert.equal(p.paidAt, null);
      await prisma.payment.update({ where: { id: other.payment!.id }, data: { providerCaptureReference: null } });
      assert.equal((await post()).status, 200); await paid(f, c.captureId); await inventory(f, 2); await inventory(other, 2);
    } finally { held.release.resolve(); await held.holder; await request; restore(); }
  });

  it("protects durable capture idempotency across independent service instances", async () => {
    const f = await fixture(), c = captureClient(f), entered = gate(), release = gate();
    const worker = await import(`../domain/payments/paypalCaptureService.js?worker=${randomUUID()}`) as typeof import("../domain/payments/paypalCaptureService.js");
    const keys: string[] = []; const ledger = new Map<string, ReturnType<typeof c.client.captureOrder>>();
    const client: PayPalCaptureClient = { captureOrder: async (id, key) => {
      keys.push(key); if (keys.length === 2) entered.resolve(); await release.promise;
      if (!ledger.has(key)) ledger.set(key, c.client.captureOrder(id)); return ledger.get(key)!;
    } };
    const results = Promise.all([capturePayPalOrder(f.order.id, f.owner.id, client), worker.capturePayPalOrder(f.order.id, f.owner.id, client)]);
    try { await entered.promise; assert.deepEqual(keys, [`order-${f.order.id}-paypal-capture`, `order-${f.order.id}-paypal-capture`]); }
    finally { release.resolve(); }
    const [a, b] = await results; assert.deepEqual(a, b); assert.equal(ledger.size, 1);
    const at = await paid(f, c.captureId); await reconcilePayPalWebhookEvent(event(f, c.captureId)); await paid(f, c.captureId, at); await inventory(f, 2);
  });

  it("retains inventory and seller/customer guards while capture is in flight past deadline", async () => {
    const f = await fixture(), c = captureClient(f), entered = gate(), release = gate();
    const capture = capturePayPalOrder(f.order.id, f.owner.id, { captureOrder: async (id) => { entered.resolve(); await release.promise; return c.client.captureOrder(id); } });
    try {
      await entered.promise; await prisma.order.update({ where: { id: f.order.id }, data: { reservationExpiresAt: new Date(0) } });
      await assert.rejects(cancelOrder(f.owner.id, f.order.id, "CHANGED_MIND"), OrderCancellationPaymentError);
      await assert.rejects(cancelOrderByAdmin(f.order.id, "OUT_OF_STOCK", f.owner.id), OrderCancellationPaymentError);
      assert.equal(await expireOrderReservation(f.order.id), null); await inventory(f, 2);
    } finally { release.resolve(); await capture; }
    await paid(f, c.captureId); assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, "PENDING");
    const receipt = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: "PAYPAL", providerEventId: `capture:${c.captureId}` } } });
    assert.match(receipt.processingError!, /after reservation deadline/); await inventory(f, 2);
  });

  it("serializes capture completion, expiry, and cancellation on the same Order row", async () => {
    const f = await fixture(), c = captureClient(f), entered = gate(), release = gate();
    const capture = capturePayPalOrder(f.order.id, f.owner.id, { captureOrder: async (id) => { entered.resolve(); await release.promise; return c.client.captureOrder(id); } });
    await entered.promise; await prisma.order.update({ where: { id: f.order.id }, data: { reservationExpiresAt: new Date(0) } });
    const held = await holdOrder(f.order.id);
    const cancellation = assert.rejects(cancelOrder(f.owner.id, f.order.id, "CHANGED_MIND"), OrderCancellationPaymentError);
    const expiry = expireOrderReservation(f.order.id); release.resolve();
    try { await held.wait(3); } finally { held.release.resolve(); await held.holder; }
    await Promise.all([capture, cancellation]); assert.equal(await expiry, null); await paid(f, c.captureId); await inventory(f, 2);
  });

  it("serializes customer cancellation against PayPal initiation with database lock waits", async () => {
    const f = await fixture(false), held = await holdOrder(f.order.id); let calls = 0;
    const results = Promise.allSettled([
      cancelOrder(f.owner.id, f.order.id, "CHANGED_MIND"),
      createOrReusePayPalOrder(f.order.id, f.owner.id, { createOrder: async () => { calls++; return { id: `PP-${randomUUID()}` }; } }),
    ]);
    try { await held.wait(2); } finally { held.release.resolve(); await held.holder; }
    const r = await results; assert.equal(r.filter((result) => result.status === "fulfilled").length, 1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } });
    if (order.status === "CANCELLED") {
      assert.equal(calls, 0); assert.equal(await prisma.payment.count({ where: { orderId: order.id } }), 0); await inventory(f, 0);
    } else {
      assert.equal(order.status, "PENDING"); assert.equal(calls, 1); assert.equal(await prisma.payment.count({ where: { orderId: order.id } }), 1); await inventory(f, 2);
    }
  });

  it("locks delayed initiation persistence before rereading payment state", async () => {
    const f = await fixture(false), entered = gate(), release = gate();
    const initiation = createOrReusePayPalOrder(f.order.id, f.owner.id, { createOrder: async () => { entered.resolve(); await release.promise; return { id: `PP-${randomUUID()}` }; } });
    await entered.promise; const held = await holdOrder(f.order.id); release.resolve();
    try { await held.wait(); await prisma.payment.update({ where: { orderId: f.order.id }, data: { status: "PROCESSING" } }); }
    finally { held.release.resolve(); await held.holder; }
    await initiation; assert.equal((await prisma.payment.findUniqueOrThrow({ where: { orderId: f.order.id } })).status, "PROCESSING"); await inventory(f, 2);
  });

  for (const terminal of ["CANCELLED", "EXPIRED"] as const) {
    it(`records in-flight capture success after a historical ${terminal} transition once`, async () => {
      const f = await fixture(), c = captureClient(f), entered = gate(), release = gate();
      const capture = capturePayPalOrder(f.order.id, f.owner.id, { captureOrder: async (id) => { entered.resolve(); await release.promise; return c.client.captureOrder(id); } });
      try {
        await entered.promise;
        // Simulate a historical/pre-#154 release while provider I/O was in flight.
        // Ordinary cancellation/expiry cannot perform this transition anymore.
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${f.order.id} FOR UPDATE`;
          await tx.order.update({ where: { id: f.order.id }, data: { status: terminal } });
          await tx.productListing.update({ where: { id: f.listing.id }, data: { reservedStock: { decrement: 2 } } });
        });
        release.resolve(); await capture; const at = await paid(f, c.captureId);
        assert.equal((await reconcilePayPalWebhookEvent(event(f, c.captureId))).handled, true);
        await paid(f, c.captureId, at); assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, terminal);
        const receipt = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: "PAYPAL", providerEventId: `capture:${c.captureId}` } } });
        assert.ok(receipt.processedAt); assert.match(receipt.processingError!, /requires refund\/reconciliation/); await inventory(f, 0);
      } finally { release.resolve(); await capture; }
    });
  }

  it("does not overwrite an established capture identity with another completed response", async () => {
    const f = await fixture(), c = captureClient(f), entered = gate(), release = gate();
    const capture = capturePayPalOrder(f.order.id, f.owner.id, { captureOrder: async (id) => { entered.resolve(); await release.promise; return c.client.captureOrder(id); } });
    const rejected = assert.rejects(capture, PayPalCaptureMismatchError);
    const original = `CAP-${randomUUID()}`, e = event(f, original);
    try { await entered.promise; assert.equal((await reconcilePayPalWebhookEvent(e)).handled, true); const at = await paid(f, original); release.resolve(); await rejected; await paid(f, original, at); }
    finally { release.resolve(); await rejected; }
    assert.equal((await reconcilePayPalWebhookEvent(event(f, c.captureId))).handled, false); await inventory(f, 2);
  });

  it("consumes inventory once through existing confirmation despite capture/webhook retries", async () => {
    const f = await fixture(), c = captureClient(f); await capturePayPalOrder(f.order.id, f.owner.id, c.client);
    const at = await paid(f, c.captureId); await confirmOrder(f.owner.id, f.order.id);
    await Promise.all([reconcilePayPalWebhookEvent(event(f, c.captureId)), capturePayPalOrder(f.order.id, f.owner.id, c.client)]);
    await assert.rejects(confirmOrder(f.owner.id, f.order.id)); await paid(f, c.captureId, at); await inventory(f, 0, 8, 1);
  });

  for (const terminal of ["PENDING", "CANCELLED", "EXPIRED"] as const) {
    it(`durably recovers early success on ${terminal} after identity binding and deduplicates redelivery`, async () => {
      const f = await fixture(false);
      if (terminal === "CANCELLED") await cancelOrder(f.owner.id, f.order.id, "CHANGED_MIND");
      if (terminal === "EXPIRED") await expireOrderReservation(f.order.id, new Date(f.order.reservationExpiresAt!.getTime() + 1));
      f.payment = await addPayment(f);
      f.payment = await prisma.payment.update({ where: { id: f.payment.id }, data: { providerReference: `pending:order-${f.order.id}-paypal` } });
      const providerId = `PP-${randomUUID()}`, c = captureClient(f), e = { ...event(f, c.captureId), paypalOrderId: providerId };
      const restore = setPayPalWebhookVerifierForTests(async () => true);
      try {
        const early = await deliver(e); assert.equal(early.status, 200); assert.deepEqual(await early.json(), { duplicate: false, handled: false });
        const pending = await receipt(e.id); assert.equal(pending.processedAt, null); assert.match(pending.processingError!, /Unknown PayPal/);
        assert.deepEqual(pending.evidence, { version: 1, ...e });
        assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, "PENDING");
        await inventory(f, terminal === "PENDING" ? 2 : 0);
        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${f.order.id} FOR UPDATE`;
          await tx.payment.update({ where: { id: f.payment!.id }, data: { providerReference: providerId } });
        });
        const retried = await deliver(e); assert.equal(retried.status, 200); assert.deepEqual(await retried.json(), { duplicate: true, handled: true });
        const at = await paid(f, c.captureId), completed = await receipt(e.id); assert.ok(completed.processedAt);
        assert.equal(completed.receivedAt.getTime(), pending.receivedAt.getTime()); assert.deepEqual(completed.evidence, pending.evidence);
        assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, terminal);
        if (terminal !== "PENDING") assert.match(completed.processingError!, /requires refund\/reconciliation/);
        const duplicate = await deliver(e); assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), { duplicate: true, handled: true });
        await paid(f, c.captureId, at); assert.equal((await receipt(e.id)).processedAt!.getTime(), completed.processedAt.getTime());
        assert.equal(await prisma.paymentWebhookEvent.count({ where: { provider: "PAYPAL", providerEventId: e.id } }), 1);
        await inventory(f, terminal === "PENDING" ? 2 : 0);
      } finally { restore(); }
    });
  }

  it("replays early verified success immediately after real initiation binds identity, without redelivery", async () => {
    const f = await fixture(false), entered = gate(), release = gate(), providerId = `PP-${randomUUID()}`, c = captureClient(f);
    const initiation = createOrReusePayPalOrder(f.order.id, f.owner.id, { createOrder: async () => { entered.resolve(); await release.promise; return { id: providerId }; } });
    const restore = setPayPalWebhookVerifierForTests(async () => true);
    try {
      await entered.promise; f.payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: f.order.id } });
      assert.ok(f.payment.providerReference.startsWith("pending:"));
      const e = { ...event(f, c.captureId), paypalOrderId: providerId };
      const early = await deliver(e); assert.equal(early.status, 200); assert.deepEqual(await early.json(), { duplicate: false, handled: false });
      assert.equal((await receipt(e.id)).processedAt, null);
      release.resolve(); assert.equal((await initiation).paypalOrderId, providerId);
      const at = await paid(f, c.captureId); assert.ok((await receipt(e.id)).processedAt);
      assert.deepEqual(await reconcilePayPalWebhookEvent(e), { duplicate: true, handled: true }); await paid(f, c.captureId, at); await inventory(f, 2);
    } finally { release.resolve(); await initiation; restore(); }
  });

  it("discovers durable receipts from a new process after binding, with no in-memory queue or redelivery", async () => {
    const f = await fixture(), c = captureClient(f), actualReference = f.payment!.providerReference;
    await prisma.payment.update({ where: { id: f.payment!.id }, data: { providerReference: `pending:${randomUUID()}` } });
    const e = { ...event(f, c.captureId), paypalOrderId: actualReference };
    assert.deepEqual(await reconcilePayPalWebhookEvent(e), { duplicate: false, handled: false }); assert.equal((await receipt(e.id)).processedAt, null);
    // Simulate binding having committed but the original process dying before its immediate callback.
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${f.order.id} FOR UPDATE`;
      await tx.payment.update({ where: { id: f.payment!.id }, data: { providerReference: actualReference } });
    });
    const restarted = await replayProcess(actualReference).done;
    assert.equal(restarted.code, 0, restarted.stderr); assert.deepEqual(JSON.parse(restarted.stdout), { scanned: 1, processed: 1, pending: 0, failed: 0 });
    const at = await paid(f, c.captureId); assert.ok((await receipt(e.id)).processedAt);
    assert.deepEqual(await reconcilePayPalWebhookEvent(e), { duplicate: true, handled: true }); await paid(f, c.captureId, at); await inventory(f, 2);
  });

  it("leaves a crashed worker's pending receipt discoverable and recovers in a replacement process", async () => {
    const f = await fixture(), c = captureClient(f), e = event(f, c.captureId);
    await persistVerifiedPayPalWebhookEvent(e); const held = await holdOrder(f.order.id), interrupted = replayProcess(f.payment!.providerReference);
    try { await held.wait(); interrupted.child.kill("SIGKILL"); const stopped = await interrupted.done; assert.equal(stopped.signal, "SIGKILL"); }
    finally { interrupted.child.kill("SIGKILL"); await interrupted.done; held.release.resolve(); await held.holder; }
    assert.equal((await receipt(e.id)).processedAt, null); assert.ok((await receipt(e.id)).evidence);
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } }); assert.equal(before.status, "PENDING"); assert.equal(before.paidAt, null);
    const replacement = await replayProcess(f.payment!.providerReference).done; assert.equal(replacement.code, 0, replacement.stderr);
    assert.equal(JSON.parse(replacement.stdout).processed, 1); await paid(f, c.captureId); await inventory(f, 2);
  });

  it("serializes replay in two independent OS processes using the Order lock", async () => {
    const f = await fixture(), c = captureClient(f), e = event(f, c.captureId); await persistVerifiedPayPalWebhookEvent(e);
    const held = await holdOrder(f.order.id), a = replayProcess(f.payment!.providerReference), b = replayProcess(f.payment!.providerReference);
    try { await held.wait(2); } finally { held.release.resolve(); await held.holder; }
    const results = await Promise.all([a.done, b.done]);
    for (const result of results) { assert.equal(result.code, 0, result.stderr); assert.equal(JSON.parse(result.stdout).failed, 0); }
    const at = await paid(f, c.captureId), completed = await receipt(e.id); assert.ok(completed.processedAt);
    assert.equal(await prisma.paymentWebhookEvent.count({ where: { provider: "PAYPAL", providerEventId: e.id } }), 1);
    assert.deepEqual(await reconcilePayPalWebhookEvent(e), { duplicate: true, handled: true });
    await paid(f, c.captureId, at); assert.equal((await receipt(e.id)).processedAt!.getTime(), completed.processedAt.getTime()); await inventory(f, 2);
  });

  it("advances past older uncorrelated receipts using bounded keyset pages", async () => {
    const f = await fixture(), c = captureClient(f), unbound = { ...event(f, `CAP-${randomUUID()}`), paypalOrderId: `UNKNOWN-${randomUUID()}` };
    await persistVerifiedPayPalWebhookEvent(unbound);
    const known = event(f, c.captureId); await persistVerifiedPayPalWebhookEvent(known);
    assert.ok((await receipt(unbound.id)).id < (await receipt(known.id)).id);
    const result = await replayPendingPayPalWebhooks({ pageSize: 1 }); assert.ok(result.scanned >= 2); assert.ok(result.pending >= 1); assert.ok(result.processed >= 1);
    assert.equal((await receipt(unbound.id)).processedAt, null); assert.ok((await receipt(known.id)).processedAt); await paid(f, c.captureId); await inventory(f, 2);
  });

  it("does not acknowledge an unrelated receipt primary-key persistence failure", async () => {
    const f = await fixture(), c = captureClient(f), e = event(f, c.captureId), restore = setPayPalWebhookVerifierForTests(async () => true);
    const [{ value }] = await prisma.$queryRaw<Array<{ value: bigint }>>`SELECT nextval(pg_get_serial_sequence('"PaymentWebhookEvent"', 'id')) AS value`;
    const blockerId = `unrelated-receipt-${randomUUID()}`; receipts.push(blockerId);
    // Reserve the next serial value explicitly. No reset/sequence rewind; this
    // produces a real unrelated uniqueness error on the next default INSERT.
    await prisma.paymentWebhookEvent.create({ data: { id: Number(value) + 1, provider: "STRIPE", providerEventId: blockerId, eventType: "TEST" } });
    try {
      const failed = await deliver(e); assert.equal(failed.status, 500); assert.deepEqual(await failed.json(), { error: "Webhook processing failed" });
      assert.equal(await prisma.paymentWebhookEvent.count({ where: { provider: "PAYPAL", providerEventId: e.id } }), 0);
      const p = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } }); assert.equal(p.status, "PENDING"); assert.equal(p.paidAt, null);
      const retried = await deliver(e); assert.equal(retried.status, 200); assert.deepEqual(await retried.json(), { duplicate: false, handled: true });
      await paid(f, c.captureId); await inventory(f, 2);
    } finally { restore(); }
  });

  for (const mismatch of ["amount", "currency", "orderIdentity", "captureIdentity"] as const) {
    it(`retains ${mismatch} evidence without applying financial success during replay`, async () => {
      const f = await fixture(), c = captureClient(f); await prisma.payment.update({ where: { id: f.payment!.id }, data: { providerCaptureReference: c.captureId } });
      const e = { ...event(f, c.captureId), ...(mismatch === "amount" ? { amount: "999.00" } : mismatch === "currency" ? { currency: "USD" }
        : mismatch === "orderIdentity" ? { paypalOrderId: `OTHER-${randomUUID()}` } : { captureId: `OTHER-${randomUUID()}` }) };
      const restore = setPayPalWebhookVerifierForTests(async () => true);
      try {
        const response = await deliver(e); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { duplicate: false, handled: false });
        const saved = await receipt(e.id); assert.equal(saved.processedAt, null); assert.match(saved.processingError!, /identity mismatch/); assert.deepEqual(saved.evidence, { version: 1, ...e });
        const worker = await replayPendingPayPalWebhooks({ paypalOrderId: e.paypalOrderId }); assert.equal(worker.failed, 0); assert.ok(worker.pending >= 1);
        const duplicate = await deliver(e); assert.equal(duplicate.status, 200); assert.deepEqual(await duplicate.json(), { duplicate: true, handled: false });
        const p = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } }); assert.equal(p.status, "PENDING"); assert.equal(p.paidAt, null);
        assert.equal(p.providerCaptureReference, c.captureId); assert.equal(p.providerReference, f.payment!.providerReference);
        assert.equal((await receipt(e.id)).processedAt, null); assert.deepEqual((await receipt(e.id)).evidence, saved.evidence); await inventory(f, 2);
      } finally { restore(); }
    });
  }

  it("rejects conflicting event-key evidence without overwriting the verified inbox payload", async () => {
    const f = await fixture(), c = captureClient(f), providerId = f.payment!.providerReference, e = event(f, c.captureId);
    await prisma.payment.update({ where: { id: f.payment!.id }, data: { providerReference: `pending:${randomUUID()}` } });
    const restore = setPayPalWebhookVerifierForTests(async () => true);
    try {
      assert.equal((await deliver(e)).status, 200); const saved = await receipt(e.id);
      for (const conflict of [{ ...e, amount: "999.00" }, { ...e, eventType: "PAYMENT.CAPTURE.DENIED" }]) {
        const response = await deliver(conflict); assert.equal(response.status, 500); assert.deepEqual(await response.json(), { error: "Webhook processing failed" });
        assert.deepEqual((await receipt(e.id)).evidence, saved.evidence); assert.equal((await receipt(e.id)).processedAt, null);
      }
      await prisma.$transaction(async (tx) => { await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${f.order.id} FOR UPDATE`;
        await tx.payment.update({ where: { id: f.payment!.id }, data: { providerReference: providerId } }); });
      assert.equal((await deliver(e)).status, 200); const at = await paid(f, c.captureId);
      assert.equal((await deliver({ ...e, amount: "999.00" })).status, 500); await paid(f, c.captureId, at); await inventory(f, 2);
    } finally { restore(); }
  });

  it("backfills verified evidence and reopens a legacy uncorrelated receipt on redelivery", async () => {
    const f = await fixture(), c = captureClient(f), e = event(f, c.captureId);
    const old = await prisma.paymentWebhookEvent.create({ data: { provider: "PAYPAL", providerEventId: e.id, eventType: e.eventType,
      processedAt: new Date(0), processingError: "Unknown PayPal payment or capture" } });
    assert.equal(old.evidence, null);
    assert.deepEqual(await reconcilePayPalWebhookEvent(e), { duplicate: true, handled: true });
    const current = await receipt(e.id); assert.equal(current.id, old.id); assert.equal(current.receivedAt.getTime(), old.receivedAt.getTime()); assert.ok(current.processedAt);
    assert.deepEqual(current.evidence, { version: 1, ...e }); const at = await paid(f, c.captureId);
    assert.deepEqual(await reconcilePayPalWebhookEvent(e), { duplicate: true, handled: true }); await paid(f, c.captureId, at); await inventory(f, 2);
  });

  it("keeps legacy pending receipts without evidence visible for operational recovery", async () => {
    const f = await fixture(), e = event(f, `CAP-${randomUUID()}`);
    await prisma.paymentWebhookEvent.create({ data: { provider: "PAYPAL", providerEventId: e.id, eventType: e.eventType } });
    const result = await replayPendingPayPalWebhooks({ pageSize: 1 }); assert.ok(result.pending >= 1);
    const retained = await receipt(e.id); assert.equal(retained.processedAt, null); assert.equal(retained.evidence, null);
    assert.match(retained.processingError!, /Missing or invalid verified PayPal evidence/);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } })).status, "PENDING"); await inventory(f, 2);
  });

});
