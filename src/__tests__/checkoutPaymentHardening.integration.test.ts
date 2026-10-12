import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { createOrder } from "../domain/orders/orderService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import { OrderCancellationPaymentError } from "../domain/orders/orderCancellationErrors.js";
import { cancelOrder } from "../domain/orders/orderCancellationService.js";
import { expireOrderReservation } from "../domain/orders/orderExpiryService.js";
import { reconcileStripePaymentEvent, type StripePaymentIntentEvent } from "../domain/payments/stripeReconciliationService.js";
import { createOrReuseStripePaymentIntent, StripePaymentAlreadyCompletedError, StripePaymentExpiredError, StripePaymentNotPayableError, type StripePaymentClient } from "../domain/payments/stripePaymentService.js";
import { OrderStatus } from "../generated/prisma-client/enums.js";

const users: number[] = [], products: number[] = [], listings: number[] = [], orders: number[] = [], events: string[] = [];
let server: ReturnType<typeof app.listen>, url: string;
const previousSecret = config.STRIPE_WEBHOOK_SECRET;
before(async () => {
  config.STRIPE_WEBHOOK_SECRET = "whsec_checkout_test";
  server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  url = `http://localhost:${(server.address() as { port: number }).port}`;
});
after(async () => { config.STRIPE_WEBHOOK_SECRET = previousSecret; server.close(); await prisma.$disconnect(); });
afterEach(async () => {
  await prisma.paymentWebhookEvent.deleteMany({ where: { providerEventId: { in: events } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listings } } });
  await prisma.productListing.deleteMany({ where: { id: { in: listings } } });
  await prisma.legoProduct.deleteMany({ where: { id: { in: products } } });
  await prisma.address.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  users.length = products.length = listings.length = orders.length = events.length = 0;
});
async function fixture() {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, passwordHash: "hash", emailVerified: true,
    addresses: { create: { recipientName: "Buyer", line1: "1 Street", city: "London", postcode: "T1", countryCode: "GB", isDefaultBilling: true } } } }); users.push(user.id);
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: "Checkout", theme: "TEST", ageRecommendation: "8+", pieceCount: 10 } }); products.push(product.id);
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: 10, currentStock: 10 } }); listings.push(listing.id);
  const order = await createOrder(user.id, { items: [{ productListingId: listing.id, quantity: 2 }] }); orders.push(order.id);
  const payment = await prisma.payment.create({ data: { orderId: order.id, amount: order.totalAmount, provider: "STRIPE", providerReference: `pi_${randomUUID()}`, status: "PROCESSING", idempotencyKey: `order-${order.id}-stripe` } });
  return { user, listing, order, payment };
}
function event(f: Awaited<ReturnType<typeof fixture>>, type: StripePaymentIntentEvent["type"] = "payment_intent.succeeded") {
  const id = randomUUID(); events.push(id);
  return { id, type, paymentIntentId: f.payment.providerReference, amount: 2000, currency: "gbp", metadata: { orderId: String(f.order.id) } };
}
async function state(f: Awaited<ReturnType<typeof fixture>>) {
  return { order: await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } }), payment: await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } }),
    listing: await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } }), movements: await prisma.inventoryMovement.count({ where: { listingId: f.listing.id, type: "WEBSITE_SALE" } }) };
}
async function assertConfirmed(f: Awaited<ReturnType<typeof fixture>>) {
  const s = await state(f); assert.equal(s.order.status, "CONFIRMED"); assert.equal(s.order.reservationExpiresAt, null);
  assert.equal(s.payment.status, "SUCCEEDED"); assert.ok(s.payment.paidAt);
  assert.equal(s.listing.currentStock, 8); assert.equal(s.listing.reservedStock, 0); assert.equal(s.movements, 1);
  return s;
}

describe("checkout payment hardening", () => {
  it("confirms once across concurrent success/failure/cancellation and ADMIN confirmation", async () => {
    const f = await fixture(); const success = event(f);
    const processing = await Promise.allSettled([reconcileStripePaymentEvent(success), reconcileStripePaymentEvent(event(f)), reconcileStripePaymentEvent(event(f, "payment_intent.payment_failed")), reconcileStripePaymentEvent(event(f, "payment_intent.canceled")), confirmOrder(f.user.id, f.order.id)]);
    assert.ok(processing.slice(0, 4).every((r) => r.status === "fulfilled"));
    const first = await assertConfirmed(f);
    assert.deepEqual(await reconcileStripePaymentEvent(success), { duplicate: true, handled: true });
    await assert.rejects(() => confirmOrder(f.user.id, f.order.id));
    await reconcileStripePaymentEvent(event(f));
    const final = await assertConfirmed(f); assert.equal(final.payment.paidAt?.getTime(), first.payment.paidAt?.getTime());
  });

  it("verified duplicate webhooks confirm once; an invalid signature cannot confirm", async () => {
    const f = await fixture(); const e = event(f);
    const payload = JSON.stringify({ id: e.id, type: e.type, data: { object: { id: e.paymentIntentId, amount: e.amount, currency: e.currency, metadata: e.metadata } } });
    const stripe = new Stripe("sk_test_fake");
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: config.STRIPE_WEBHOOK_SECRET! });
    const post = (sig: string) => fetch(`${url}/payments/stripe/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": sig }, body: payload });
    assert.equal((await post("invalid")).status, 400); assert.equal((await state(f)).order.status, "PENDING");
    await prisma.productListing.update({ where: { id: f.listing.id }, data: { reservedStock: 0 } });
    assert.equal((await post(signature)).status, 500);
    assert.equal((await state(f)).payment.status, "PROCESSING");
    assert.equal(await prisma.paymentWebhookEvent.count({ where: { providerEventId: e.id } }), 0);
    await prisma.productListing.update({ where: { id: f.listing.id }, data: { reservedStock: 2 } });
    const responses = await Promise.all([post(signature), post(signature)]); assert.ok(responses.every((r) => r.status === 200));
    await assertConfirmed(f);
  });

  it("rolls back success and receipt on inventory failure, allowing the same event to recover", async () => {
    const f = await fixture(); const e = event(f);
    await prisma.productListing.update({ where: { id: f.listing.id }, data: { reservedStock: 0 } });
    await assert.rejects(() => reconcileStripePaymentEvent(e));
    const failed = await state(f); assert.equal(failed.payment.status, "PROCESSING"); assert.equal(failed.payment.paidAt, null); assert.equal(failed.order.status, "PENDING"); assert.equal(failed.movements, 0);
    assert.equal(await prisma.paymentWebhookEvent.count({ where: { providerEventId: e.id } }), 0);
    await prisma.productListing.update({ where: { id: f.listing.id }, data: { reservedStock: 2 } });
    await reconcileStripePaymentEvent(e); await assertConfirmed(f);
  });

  it("records late-payment exceptions for historical expired and cancelled orders", async () => {
    for (const terminal of ["EXPIRED", "CANCELLED"] as const) {
      const f = await fixture();
      // Historical state from before #154; ordinary transitions now reject an existing payment.
      await prisma.$transaction(async (tx) => {
        await tx.order.update({ where: { id: f.order.id }, data: { status: terminal, reservationExpiresAt: null } });
        await tx.productListing.update({ where: { id: f.listing.id }, data: { reservedStock: 0 } });
      });
      const e = event(f); await reconcileStripePaymentEvent(e); const s = await state(f);
      assert.equal(s.order.status, terminal); assert.equal(s.payment.status, "SUCCEEDED"); assert.ok(s.payment.paidAt);
      assert.equal(s.listing.currentStock, 10); assert.equal(s.listing.reservedStock, 0); assert.equal(s.movements, 0);
      const receipt = await prisma.paymentWebhookEvent.findFirstOrThrow({ where: { providerEventId: e.id } }); assert.match(receipt.processingError!, /refund\/reconciliation/);
    }
  });

  it("records success without normally confirming other non-PENDING states", async () => {
    for (const terminal of ["CONFIRMED", "DISPATCHED", "COMPLETED", "RETURNED"] as const) {
      const f = await fixture();
      await confirmOrder(f.user.id, f.order.id);
      await prisma.order.update({ where: { id: f.order.id }, data: { status: terminal } });
      await reconcileStripePaymentEvent(event(f)); const s = await state(f);
      assert.equal(s.order.status, terminal); assert.equal(s.payment.status, "SUCCEEDED");
      assert.equal(s.listing.currentStock, 8); assert.equal(s.listing.reservedStock, 0); assert.equal(s.movements, 1);
    }
  });

  it("serializes expiry against success, with no resurrection or double inventory release", async () => {
    const f = await fixture(); await prisma.order.update({ where: { id: f.order.id }, data: { reservationExpiresAt: new Date(0) } });
    await Promise.all([expireOrderReservation(f.order.id), reconcileStripePaymentEvent(event(f))]);
    const s = await state(f); assert.equal(s.payment.status, "SUCCEEDED"); assert.equal(s.listing.reservedStock, 0);
    assert.equal(s.order.status, "CONFIRMED");
    assert.equal(s.listing.currentStock, 8); assert.equal(s.movements, 1);
    assert.equal(await expireOrderReservation(f.order.id, new Date(Date.now() + 3600000)), null);
  });

  it("serializes cancellation against success using current inventory state", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([cancelOrder(f.user.id, f.order.id, "CHANGED_MIND"), reconcileStripePaymentEvent(event(f))]);
    assert.equal(results[0].status, "rejected");
    if (results[0].status === "rejected") assert.ok(results[0].reason instanceof OrderCancellationPaymentError);
    assert.equal(results[1].status, "fulfilled");
    await assertConfirmed(f);
    assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.listing.id, type: "ORDER_CANCELLATION_RETURN" } }), 0);
  });

  it("success winning before expiry prevents subsequent expiry", async () => {
    const f = await fixture(); await reconcileStripePaymentEvent(event(f));
    assert.equal(await expireOrderReservation(f.order.id, new Date(Date.now() + 3600000)), null); await assertConfirmed(f);
  });

  it("does not regress success when initiation retrieval finishes after reconciliation", async () => {
    const f = await fixture();
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; }); const gate = new Promise<void>((resolve) => { release = resolve; });
    let creates = 0;
    const client = { paymentIntents: { create: async () => { creates++; throw new Error("Unexpected create"); }, retrieve: async () => { started(); await gate; return { id: f.payment.providerReference, client_secret: "secret", status: "processing" }; } } } as unknown as StripePaymentClient;
    const initiation = createOrReuseStripePaymentIntent(f.order.id, f.user.id, client);
    const rejected = assert.rejects(initiation, StripePaymentAlreadyCompletedError);
    await entered; await reconcileStripePaymentEvent(event(f)); const first = await assertConfirmed(f); release(); await rejected;
    const final = await assertConfirmed(f); assert.equal(final.payment.paidAt?.getTime(), first.payment.paidAt?.getTime()); assert.equal(creates, 0);
  });

  it("correlates success received before initiation persists its provider reference", async () => {
    const f = await fixture(); await prisma.payment.update({ where: { id: f.payment.id }, data: { providerReference: `pending:order-${f.order.id}-stripe` } });
    await reconcileStripePaymentEvent(event(f)); const s = await assertConfirmed(f); assert.equal(s.payment.providerReference, f.payment.providerReference);
  });

  it("rejects every non-payable status and already-paid pending orders without provider calls", async () => {
    const f = await fixture(); let calls = 0;
    const client = { paymentIntents: { create: async () => { calls++; }, retrieve: async () => { calls++; } } } as unknown as StripePaymentClient;
    for (const status of [OrderStatus.EXPIRED, OrderStatus.CONFIRMED, OrderStatus.DISPATCHED, OrderStatus.COMPLETED, OrderStatus.CANCELLED, OrderStatus.RETURNED]) {
      await prisma.order.update({ where: { id: f.order.id }, data: { status } });
      await assert.rejects(() => createOrReuseStripePaymentIntent(f.order.id, f.user.id, client), status === "EXPIRED" ? StripePaymentExpiredError : StripePaymentNotPayableError);
    }
    await prisma.order.update({ where: { id: f.order.id }, data: { status: "PENDING" } });
    const paidAt = new Date(); await prisma.payment.update({ where: { id: f.payment.id }, data: { status: "SUCCEEDED", paidAt } });
    await assert.rejects(() => createOrReuseStripePaymentIntent(f.order.id, f.user.id, client), StripePaymentAlreadyCompletedError);
    assert.equal(calls, 0); assert.equal((await state(f)).payment.paidAt?.getTime(), paidAt.getTime());
  });

  it("rejects amount, currency and order-correlation mismatches without confirming", async () => {
    const f = await fixture();
    for (const overrides of [{ amount: 1 }, { currency: "usd" }, { metadata: { orderId: "999999" } }]) {
      assert.deepEqual(await reconcileStripePaymentEvent({ ...event(f), ...overrides }), { duplicate: false, handled: false });
    }
    const s = await state(f); assert.equal(s.order.status, "PENDING"); assert.equal(s.payment.status, "PROCESSING"); assert.equal(s.movements, 0); assert.equal(s.listing.reservedStock, 2);
  });
});
