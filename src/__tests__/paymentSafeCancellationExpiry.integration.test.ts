import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { createOrder } from "../domain/orders/orderService.js";
import { InsufficientAvailableStockError } from "../domain/orders/orderErrors.js";
import { cancelOrder, cancelOrderByAdmin } from "../domain/orders/orderCancellationService.js";
import { OrderCancellationPaymentError, OrderNotCancellableError, InsufficientReservedStockError } from "../domain/orders/orderCancellationErrors.js";
import { expireOrderReservation } from "../domain/orders/orderExpiryService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import { createOrReuseStripePaymentIntent, StripePaymentNotPayableError, StripePaymentExpiredError, StripePaymentProviderError, type StripePaymentClient } from "../domain/payments/stripePaymentService.js";
import { reconcileStripePaymentEvent, type StripePaymentIntentEvent } from "../domain/payments/stripeReconciliationService.js";
import { recoverStripePayment } from "../domain/payments/stripePaymentRecoveryService.js";
import { createOrReusePayPalOrder } from "../domain/payments/paypalOrderService.js";
import { capturePayPalOrder } from "../domain/payments/paypalCaptureService.js";
import { reconcilePayPalWebhookEvent } from "../domain/payments/paypalReconciliationService.js";
import { createPayment } from "../domain/payments/paymentService.js";
import { PaymentOrderCancelledError } from "../domain/payments/paymentErrors.js";
import { PaymentStatus, PaymentProvider } from "../generated/prisma-client/enums.js";

const users: number[] = [], orders: number[] = [], listings: number[] = [], products: number[] = [], events: string[] = [];
let server: ReturnType<typeof app.listen>, url: string;
const previousWebhookSecret = config.STRIPE_WEBHOOK_SECRET;
before(async () => {
  config.STRIPE_WEBHOOK_SECRET = "whsec_cancellation_expiry_local_test";
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  url = `http://localhost:${(server.address() as { port: number }).port}`;
});
after(async () => { config.STRIPE_WEBHOOK_SECRET = previousWebhookSecret; await new Promise<void>((resolve) => server.close(() => resolve())); await prisma.$disconnect(); });
afterEach(async () => {
  await prisma.paymentWebhookEvent.deleteMany({ where: { providerEventId: { in: events.splice(0) } } });
  await prisma.order.deleteMany({ where: { id: { in: orders.splice(0) } } });
  await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listings } } });
  await prisma.productListing.deleteMany({ where: { id: { in: listings.splice(0) } } });
  await prisma.legoProduct.deleteMany({ where: { id: { in: products.splice(0) } } });
  await prisma.address.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
});
async function user(role: "ADMIN" | "CUSTOMER" = "CUSTOMER", verified = true) {
  const u = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: "test", emailVerified: verified, role,
    addresses: { create: { recipientName: "Buyer", line1: "1 Test Street", city: "London", postcode: "T1", countryCode: "GB", isDefaultBilling: true } } } });
  users.push(u.id); return u;
}
async function fixture(multi = false) {
  const owner = await user();
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: "Payment safety", theme: "TEST", ageRecommendation: "8+", pieceCount: 10 } }); products.push(product.id);
  const offers = [];
  for (let i = 0; i < (multi ? 2 : 1); i++) {
    const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: 10, currentStock: 10 } });
    listings.push(listing.id); offers.push(listing);
  }
  const order = await createOrder(owner.id, { items: offers.map((listing) => ({ productListingId: listing.id, quantity: 2 })) }); orders.push(order.id);
  return { owner, order, offers };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function payment(f: Fixture, status: PaymentStatus = "PROCESSING", provider: PaymentProvider = "STRIPE", reference = `${provider === "STRIPE" ? "pi_" : "ref_"}${randomUUID()}`) {
  return prisma.payment.create({ data: { orderId: f.order.id, amount: f.order.totalAmount, status, provider, providerReference: reference, paidAt: status === "SUCCEEDED" ? new Date() : null } });
}
function gate<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function inventory(f: Fixture, currentStock: number, reservedStock: number, sales = 0, returns = 0) {
  for (const offer of f.offers) {
    const row = await prisma.productListing.findUniqueOrThrow({ where: { id: offer.id } });
    assert.equal(row.currentStock, currentStock); assert.equal(row.reservedStock, reservedStock);
    assert.equal(await prisma.inventoryMovement.count({ where: { listingId: offer.id, type: "WEBSITE_SALE" } }), sales);
    assert.equal(await prisma.inventoryMovement.count({ where: { listingId: offer.id, type: "ORDER_CANCELLATION_RETURN" } }), returns);
  }
}
async function elapsed(f: Fixture) {
  await prisma.order.update({ where: { id: f.order.id }, data: { reservationExpiresAt: new Date(0) } });
}
function event(f: Fixture, intentId: string, type: StripePaymentIntentEvent["type"] = "payment_intent.succeeded") {
  const id = `evt_${randomUUID()}`; events.push(id);
  return { id, type, paymentIntentId: intentId, amount: Number(f.order.totalAmount) * 100, currency: "gbp", metadata: { orderId: String(f.order.id) } };
}
async function cancelHttp(orderId: number, owner?: { id: number }, seller = false) {
  return fetch(`${url}/orders/${orderId}/${seller ? "seller-cancel" : "cancel"}`, { method: "POST", headers: {
    "Content-Type": "application/json", ...(owner ? { Authorization: `Bearer ${jwt.sign({ id: owner.id }, config.JWT_SECRET)}` } : {}),
  }, body: JSON.stringify({ reason: seller ? "OUT_OF_STOCK" : "CHANGED_MIND" }) });
}
// Observe actual PostgreSQL lock waits before releasing the holder. The recursive
// wait graph includes contenders queued behind another waiting tuple lock.
async function contend(orderId: number, actions: Array<() => Promise<unknown>>) {
  const locked = gate<number>(), release = gate();
  const holder = prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    locked.resolve(pid); await release.promise;
  }, { timeout: 15_000 });
  const pid = await locked.promise;
  const results = Promise.allSettled(actions.map((action) => action()));
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      const [{ count }] = await prisma.$queryRaw<Array<{ count: number }>>`
        WITH RECURSIVE blocked(pid) AS (
          SELECT ${pid}::integer
          UNION
          SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
        ) SELECT (count(*) - 1)::integer AS count FROM blocked
      `;
      if (count >= actions.length) break;
      assert.ok(Date.now() < deadline, "contenders did not reach real database lock waits");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  } finally { release.resolve(); await holder; }
  return results;
}

describe("payment-safe customer cancellation and expiry", () => {
  it("allows cancellation before initiation and rejects a new payment without provider I/O", async () => {
    const f = await fixture(); assert.equal((await cancelHttp(f.order.id, f.owner)).status, 200);
    let calls = 0;
    const client = { paymentIntents: { create: async () => { calls++; }, retrieve: async () => { calls++; } } } as unknown as StripePaymentClient;
    await assert.rejects(createOrReuseStripePaymentIntent(f.order.id, f.owner.id, client), StripePaymentNotPayableError);
    await assert.rejects(createPayment(f.order.id, { providerReference: randomUUID() }), PaymentOrderCancelledError);
    assert.equal(calls, 0); assert.equal(await prisma.payment.count({ where: { orderId: f.order.id } }), 0);
    await assert.rejects(cancelOrder(f.owner.id, f.order.id, "CHANGED_MIND"), OrderNotCancellableError);
    await inventory(f, 10, 0);
  });

  for (const provider of Object.values(PaymentProvider)) {
    it(`blocks cancellation and expiry for every ${provider} payment state, preserving ownership`, async () => {
      const f = await fixture(); const other = await user(); const admin = await user("ADMIN");
      const p = await payment(f, "PENDING", provider); await elapsed(f);
      for (const status of Object.values(PaymentStatus)) {
        await prisma.payment.update({ where: { id: p.id }, data: { status, paidAt: status === "SUCCEEDED" ? new Date() : null } });
        const response = await cancelHttp(f.order.id, f.owner);
        assert.equal(response.status, 409);
        const body = await response.json();
        assert.equal(body.error.code, status === "SUCCEEDED" ? "ORDER_ALREADY_PAID" : "ORDER_PAYMENT_UNRESOLVED");
        assert.match(body.error.message, /customer-cancelled/);
        assert.equal((await cancelHttp(f.order.id, other)).status, 404);
        assert.equal((await cancelHttp(f.order.id, admin, true)).status, 409);
        assert.equal(await expireOrderReservation(f.order.id), null);
        assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, "PENDING");
        await inventory(f, 10, 2);
      }
      // Evidence of previous success blocks cancellation even if a local status regressed.
      await prisma.payment.update({ where: { id: p.id }, data: { status: "FAILED", paidAt: new Date() } });
      assert.equal((await (await cancelHttp(f.order.id, f.owner)).json()).error.code, "ORDER_ALREADY_PAID");
    });
  }

  it("rejects paid CONFIRMED orders without restocking and retains customer authentication", async () => {
    const f = await fixture(); await payment(f, "SUCCEEDED", "MANUAL"); await confirmOrder(f.owner.id, f.order.id);
    assert.equal((await cancelHttp(f.order.id)).status, 401);
    const unverified = await user("CUSTOMER", false); assert.equal((await cancelHttp(f.order.id, unverified)).status, 403);
    assert.equal((await cancelHttp(2147483647, f.owner)).status, 404);
    assert.equal((await cancelHttp(f.order.id, f.owner)).status, 409);
    await inventory(f, 8, 0, 1);
  });

  it("retains placeholders during paused Stripe initiation and provider timeout", async () => {
    const f = await fixture(); const entered = gate(), release = gate();
    const client = { paymentIntents: { create: async () => { entered.resolve(); await release.promise; throw new Error("timeout"); } } } as unknown as StripePaymentClient;
    const initiation = createOrReuseStripePaymentIntent(f.order.id, f.owner.id, client);
    const rejected = assert.rejects(initiation, StripePaymentProviderError);
    try {
      await entered.promise; await elapsed(f);
      const p = await prisma.payment.findUniqueOrThrow({ where: { orderId: f.order.id } });
      assert.ok(p.providerReference.startsWith("pending:"));
      assert.equal((await cancelHttp(f.order.id, f.owner)).status, 409);
      assert.equal(await expireOrderReservation(f.order.id), null);
    } finally { release.resolve(); await rejected; }
    assert.equal(await expireOrderReservation(f.order.id), null); await inventory(f, 10, 2);
    const delayed = event(f, `pi_${randomUUID()}`); await reconcileStripePaymentEvent(delayed);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, "CONFIRMED"); await inventory(f, 8, 0, 1);
  });

  it("confirms delayed signed Stripe success after the deadline once, despite retries and failures", async () => {
    const f = await fixture(); const p = await payment(f, "FAILED"); await elapsed(f);
    assert.equal(await expireOrderReservation(f.order.id), null);
    const e = event(f, p.providerReference);
    const payload = JSON.stringify({ id: e.id, type: e.type, data: { object: { id: e.paymentIntentId, amount: e.amount, currency: e.currency, metadata: e.metadata } } });
    const signature = new Stripe("sk_test_local").webhooks.generateTestHeaderString({ payload, secret: config.STRIPE_WEBHOOK_SECRET! });
    const post = () => fetch(`${url}/payments/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": signature }, body: payload });
    assert.ok((await Promise.all([post(), post()])).every((r) => r.status === 200));
    const first = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    for (const type of ["payment_intent.payment_failed", "payment_intent.canceled", "payment_intent.succeeded"] as const) await reconcileStripePaymentEvent(event(f, p.providerReference, type));
    assert.equal((await cancelHttp(f.order.id, f.owner)).status, 409); assert.equal(await expireOrderReservation(f.order.id), null);
    const final = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    assert.equal(final.status, "SUCCEEDED"); assert.equal(final.paidAt?.getTime(), first.paidAt?.getTime());
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, "CONFIRMED");
    assert.equal(await prisma.paymentWebhookEvent.count({ where: { providerEventId: e.id } }), 1);
    await inventory(f, 8, 0, 1);
  });

  it("observes real lock contention between cancellation and Stripe initiation", async () => {
    const f = await fixture(); let calls = 0;
    const client = { paymentIntents: { create: async () => { calls++; return { id: `pi_${randomUUID()}`, status: "requires_payment_method", client_secret: "local" }; } } } as unknown as StripePaymentClient;
    const results = await contend(f.order.id, [() => cancelOrder(f.owner.id, f.order.id, "CHANGED_MIND"), () => createOrReuseStripePaymentIntent(f.order.id, f.owner.id, client)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const final = await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } });
    if (final.status === "CANCELLED") {
      assert.equal(calls, 0); assert.equal(await prisma.payment.count({ where: { orderId: f.order.id } }), 0); await inventory(f, 10, 0);
    } else { assert.equal(final.status, "PENDING"); assert.equal(calls, 1); await inventory(f, 10, 2); }
  });

  it("serializes customer cancellation with manual payment creation", async () => {
    const f = await fixture();
    const results = await contend(f.order.id, [() => cancelOrder(f.owner.id, f.order.id, "OTHER"), () => createPayment(f.order.id, { providerReference: randomUUID() })]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } });
    if (order.status === "CANCELLED") {
      assert.equal(await prisma.payment.count({ where: { orderId: order.id } }), 0); await inventory(f, 10, 0);
    } else {
      assert.equal(order.status, "PENDING");
      assert.equal((await prisma.payment.findUniqueOrThrow({ where: { orderId: order.id } })).status, "SUCCEEDED");
      await inventory(f, 10, 2);
    }
  });

  for (const provider of ["STRIPE", "PAYPAL", "MANUAL"] as const) {
    it(`serializes expiry with ${provider} initiation using real lock waits`, async () => {
      const f = await fixture(); let calls = 0;
      // Advance only expiry's explicit asOf argument: both decisions are eligible
      // at the barrier, without a timing-dependent wall-clock deadline.
      const asOf = new Date(f.order.reservationExpiresAt!.getTime() + 1);
      const initiate = () => provider === "MANUAL"
        ? createPayment(f.order.id, { providerReference: randomUUID() })
        : provider === "PAYPAL"
          ? createOrReusePayPalOrder(f.order.id, f.owner.id, { createOrder: async () => { calls++; return { id: `PP_${randomUUID()}` }; } })
          : createOrReuseStripePaymentIntent(f.order.id, f.owner.id, { paymentIntents: { create: async () => { calls++; return { id: `pi_${randomUUID()}`, client_secret: "local", status: "requires_payment_method" }; } } } as unknown as StripePaymentClient);
      const results = await contend(f.order.id, [() => expireOrderReservation(f.order.id, asOf), initiate]);
      assert.equal(results[0].status, "fulfilled");
      const order = await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } });
      if (order.status === "EXPIRED") {
        assert.equal(results[1].status, "rejected"); assert.equal(calls, 0);
        assert.equal(await prisma.payment.count({ where: { orderId: order.id } }), 0); await inventory(f, 10, 0);
      } else {
        assert.equal(order.status, "PENDING"); assert.equal(results[1].status, "fulfilled");
        assert.equal((results[0] as PromiseFulfilledResult<unknown>).value, null);
        assert.equal(await prisma.payment.count({ where: { orderId: order.id } }), 1); await inventory(f, 10, 2);
      }
    });
  }

  it("serializes expiry with success while retaining the active reservation", async () => {
    const f = await fixture(); const p = await payment(f); await elapsed(f);
    const results = await contend(f.order.id, [() => expireOrderReservation(f.order.id), () => reconcileStripePaymentEvent(event(f, p.providerReference))]);
    assert.ok(results.every((r) => r.status === "fulfilled"));
    assert.equal((results[0] as PromiseFulfilledResult<unknown>).value, null);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, "CONFIRMED"); await inventory(f, 8, 0, 1);
  });

  it("serializes customer cancellation with success without restoring a paid sale", async () => {
    const f = await fixture(); const p = await payment(f);
    const results = await contend(f.order.id, [() => cancelOrder(f.owner.id, f.order.id, "CHANGED_MIND"), () => reconcileStripePaymentEvent(event(f, p.providerReference))]);
    assert.equal(results[0].status, "rejected"); if (results[0].status === "rejected") assert.ok(results[0].reason instanceof OrderCancellationPaymentError);
    assert.equal(results[1].status, "fulfilled"); await inventory(f, 8, 0, 1);
  });

  it("retains reservations during recovery provider I/O and confirms after deadline", async () => {
    const f = await fixture(); const p = await payment(f); await elapsed(f);
    const entered = gate(), release = gate();
    events.push(`recovery:${p.id}:${p.providerReference}:succeeded`);
    const recovery = recoverStripePayment(f.order.id, f.owner.id, { paymentIntents: { retrieve: async () => {
      entered.resolve(); await release.promise;
      return { id: p.providerReference, amount: 2000, amount_received: 2000, currency: "gbp", status: "succeeded", metadata: { orderId: String(f.order.id) } };
    } } } as unknown as Parameters<typeof recoverStripePayment>[2]);
    try { await entered.promise; assert.equal(await expireOrderReservation(f.order.id), null); await assert.rejects(cancelOrder(f.owner.id, f.order.id, "CHANGED_MIND"), OrderCancellationPaymentError); }
    finally { release.resolve(); await recovery; }
    await inventory(f, 8, 0, 1);
  });

  it("expires payment-free orders once and blocks subsequent provider initiation", async () => {
    const f = await fixture(true); await elapsed(f);
    const results = await contend(f.order.id, [() => expireOrderReservation(f.order.id), () => expireOrderReservation(f.order.id)]);
    assert.ok(results.every((r) => r.status === "fulfilled"));
    assert.equal(results.filter((r) => r.status === "fulfilled" && r.value !== null).length, 1);
    let calls = 0;
    const client = { paymentIntents: { create: async () => { calls++; } } } as unknown as StripePaymentClient;
    await assert.rejects(createOrReuseStripePaymentIntent(f.order.id, f.owner.id, client), StripePaymentExpiredError);
    assert.equal(calls, 0); await inventory(f, 10, 0);
  });

  it("does not let lazy checkout expiry resell inventory held by an unresolved payment", async () => {
    const f = await fixture(); await payment(f, "FAILED"); await elapsed(f);
    const other = await user();
    await assert.rejects(createOrder(other.id, { items: [{ productListingId: f.offers[0].id, quantity: 9 }] }), InsufficientAvailableStockError);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, "PENDING");
    assert.equal(await prisma.order.count({ where: { userId: other.id } }), 0);
    await inventory(f, 10, 2);
  });

  it("restores unpaid confirmed multi-item inventory exactly once under contention", async () => {
    const f = await fixture(true); await confirmOrder(f.owner.id, f.order.id);
    const results = await contend(f.order.id, [() => cancelOrder(f.owner.id, f.order.id, "CHANGED_MIND"), () => cancelOrder(f.owner.id, f.order.id, "OTHER")]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1); await inventory(f, 10, 0, 1, 1);
  });

  it("rolls back all cancellation/expiry releases if a later item reservation is missing", async () => {
    for (const operation of ["cancel", "expire"] as const) {
      const f = await fixture(true); await elapsed(f);
      await prisma.productListing.update({ where: { id: f.offers[1].id }, data: { reservedStock: 0 } });
      await assert.rejects(operation === "cancel" ? cancelOrder(f.owner.id, f.order.id, "OTHER") : expireOrderReservation(f.order.id), InsufficientReservedStockError);
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, "PENDING");
      assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.offers[0].id } })).reservedStock, 2);
    }
  });

  it("retains a PayPal attempt during provider I/O and completion without relying on its status", async () => {
    const f = await fixture(); const entered = gate(), release = gate(); const reference = `PP_${randomUUID()}`;
    const initiation = createOrReusePayPalOrder(f.order.id, f.owner.id, { createOrder: async () => { entered.resolve(); await release.promise; return { id: reference }; } });
    try { await entered.promise; await elapsed(f); await assert.rejects(cancelOrder(f.owner.id, f.order.id, "OTHER"), OrderCancellationPaymentError); assert.equal(await expireOrderReservation(f.order.id), null); }
    finally { release.resolve(); await initiation; }
    const id = `PP_evt_${randomUUID()}`; events.push(id);
    const completion = { id, eventType: "PAYMENT.CAPTURE.COMPLETED", paypalOrderId: reference, captureId: `CAP_${randomUUID()}`, amount: "20.00", currency: "GBP" };
    assert.deepEqual(await reconcilePayPalWebhookEvent(completion), { duplicate: false, handled: true });
    const paid = await prisma.payment.findUniqueOrThrow({ where: { orderId: f.order.id } });
    assert.equal(paid.status, "SUCCEEDED"); assert.ok(paid.paidAt);
    assert.equal(paid.providerCaptureReference, completion.captureId);
    assert.deepEqual(await reconcilePayPalWebhookEvent(completion), { duplicate: true, handled: true });
    const replayed = await prisma.payment.findUniqueOrThrow({ where: { id: paid.id } });
    assert.equal(replayed.status, "SUCCEEDED"); assert.equal(replayed.paidAt?.getTime(), paid.paidAt.getTime());
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, "PENDING");
    assert.equal(await expireOrderReservation(f.order.id), null); await assert.rejects(cancelOrder(f.owner.id, f.order.id, "OTHER"), OrderCancellationPaymentError);
    await inventory(f, 10, 2); // Automatic PayPal confirmation is outside #154.
  });

  it("preserves seller cancellation's no-payment boundary and exactly-once release", async () => {
    const f = await fixture(); const admin = await user("ADMIN");
    assert.equal((await cancelHttp(f.order.id, f.owner, true)).status, 403);
    const results = await contend(f.order.id, [() => cancelOrderByAdmin(f.order.id, "OUT_OF_STOCK", admin.id), () => cancelOrder(f.owner.id, f.order.id, "OTHER")]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1); await inventory(f, 10, 0);
  });

  it("records cancelled-order PayPal webhook success durably without resurrecting historical inventory", async () => {
    const f = await fixture(); const p = await payment(f, "PROCESSING", "PAYPAL");
    // Legacy cancelled order: seed only the historical state; current cancellation would reject.
    await prisma.order.update({ where: { id: f.order.id }, data: { status: "CANCELLED", reservationExpiresAt: null } });
    await prisma.productListing.update({ where: { id: f.offers[0].id }, data: { reservedStock: 0 } });
    const id = `PP_evt_${randomUUID()}`; events.push(id);
    const e = { id, eventType: "PAYMENT.CAPTURE.COMPLETED", paypalOrderId: p.providerReference, captureId: `CAP_${randomUUID()}`, amount: "20.00", currency: "GBP" };
    assert.deepEqual(await reconcilePayPalWebhookEvent(e), { duplicate: false, handled: true });
    const paid = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    assert.equal(paid.status, "SUCCEEDED"); assert.ok(paid.paidAt);
    assert.equal(paid.providerCaptureReference, e.captureId);
    assert.deepEqual(await reconcilePayPalWebhookEvent(e), { duplicate: true, handled: true });
    const replayed = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    assert.equal(replayed.status, "SUCCEEDED"); assert.equal(replayed.paidAt?.getTime(), paid.paidAt.getTime());
    const receipt = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: "PAYPAL", providerEventId: id } } });
    assert.match(receipt.processingError!, /cancelled order requires refund\/reconciliation/);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, "CANCELLED"); await inventory(f, 10, 0);
  });

  it("records cancellation that predates PayPal capture completion without rewriting its lifecycle", async () => {
    const f = await fixture(); const p = await payment(f, "PENDING", "PAYPAL");
    const entered = gate(), release = gate(); const captureId = `CAP_${randomUUID()}`; events.push(`capture:${captureId}`);
    const capture = capturePayPalOrder(f.order.id, f.owner.id, { captureOrder: async () => {
      entered.resolve(); await release.promise;
      return { id: p.providerReference, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: captureId, status: "COMPLETED", amount: { value: "20.00", currency_code: "GBP" } }] } }] };
    } });
    try {
      await entered.promise;
      // Simulate historical/out-of-band cancellation; #154 ordinary cancellation cannot do this.
      await prisma.order.update({ where: { id: f.order.id }, data: { status: "CANCELLED", reservationExpiresAt: null } });
      await prisma.productListing.update({ where: { id: f.offers[0].id }, data: { reservedStock: 0 } });
    } finally { release.resolve(); await capture; }
    const receipt = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: "PAYPAL", providerEventId: `capture:${captureId}` } } });
    assert.match(receipt.processingError!, /cancelled order requires refund\/reconciliation/);
    const paid = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    assert.equal(paid.status, "SUCCEEDED"); assert.ok(paid.paidAt);
    assert.equal(paid.providerCaptureReference, captureId);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, "CANCELLED");
    const replayId = `PP_evt_${randomUUID()}`; events.push(replayId);
    assert.deepEqual(await reconcilePayPalWebhookEvent({ id: replayId, eventType: "PAYMENT.CAPTURE.COMPLETED", paypalOrderId: p.providerReference, captureId, amount: "20.00", currency: "GBP" }), { duplicate: false, handled: true });
    const replayed = await prisma.payment.findUniqueOrThrow({ where: { id: p.id } });
    assert.equal(replayed.status, "SUCCEEDED"); assert.equal(replayed.paidAt?.getTime(), paid.paidAt.getTime());
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, "CANCELLED");
    await inventory(f, 10, 0);
  });
});
