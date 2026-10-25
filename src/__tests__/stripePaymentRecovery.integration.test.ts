import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { createOrder } from "../domain/orders/orderService.js";
import { expireOrderReservation } from "../domain/orders/orderExpiryService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import { reconcileStripePaymentEvent } from "../domain/payments/stripeReconciliationService.js";
import { recoverStripePayment, setStripeRecoveryClientForTests, StripeRecoveryMismatchError, StripeRecoveryOrderNotFoundError, StripeRecoveryUnavailableError } from "../domain/payments/stripePaymentRecoveryService.js";
import { StripePaymentProviderError } from "../domain/payments/stripePaymentService.js";

const users: number[] = [], products: number[] = [], listings: number[] = [], orders: number[] = [], eventIds: string[] = [], recoveryEvidenceIds: string[] = [];
let server: ReturnType<typeof app.listen>, url: string;
let restoreClient: (() => void) | undefined;
const previousSecret = config.STRIPE_WEBHOOK_SECRET;
before(async () => {
  config.STRIPE_WEBHOOK_SECRET = "whsec_recovery_test";
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  url = `http://localhost:${(server.address() as { port: number }).port}`;
});
after(async () => { config.STRIPE_WEBHOOK_SECRET = previousSecret; server.close(); await prisma.$disconnect(); });
afterEach(async () => {
  restoreClient?.(); restoreClient = undefined;
  await prisma.paymentWebhookEvent.deleteMany({ where: { providerEventId: { in: [...eventIds, ...recoveryEvidenceIds] } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listings } } });
  await prisma.productListing.deleteMany({ where: { id: { in: listings } } });
  await prisma.legoProduct.deleteMany({ where: { id: { in: products } } });
  await prisma.address.deleteMany({ where: { userId: { in: users } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  users.length = products.length = listings.length = orders.length = eventIds.length = recoveryEvidenceIds.length = 0;
});
async function fixture() {
  const user = await prisma.user.create({ data: { email: `recovery-${randomUUID()}@example.com`, passwordHash: "hash", emailVerified: true,
    addresses: { create: { recipientName: "Recovery Buyer", line1: "1 Test Street", city: "London", postcode: "T1", countryCode: "GB", isDefaultBilling: true } } } }); users.push(user.id);
  const product = await prisma.legoProduct.create({ data: { setNumber: `REC-${randomUUID()}`, title: "Recovery Product", theme: "TEST", ageRecommendation: "8+", pieceCount: 10 } }); products.push(product.id);
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: 10, currentStock: 10 } }); listings.push(listing.id);
  const order = await createOrder(user.id, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 2 }] }); orders.push(order.id);
  const payment = await prisma.payment.create({ data: { orderId: order.id, amount: order.totalAmount, provider: "STRIPE", providerReference: `pi_${randomUUID()}`, status: "PROCESSING", idempotencyKey: `order-${order.id}-stripe` } });
  recoveryEvidenceIds.push(`recovery:${payment.id}:${payment.providerReference}:succeeded`);
  return { user, listing, order, payment };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function provider(f: Fixture, overrides: Partial<Stripe.PaymentIntent> = {}, onRetrieve?: () => Promise<void>) {
  let calls = 0;
  const intent = { id: f.payment.providerReference, amount: f.payment.amount.mul(100).toNumber(), amount_received: f.payment.amount.mul(100).toNumber(), currency: "gbp", metadata: { orderId: String(f.order.id) }, status: "succeeded", client_secret: "must-not-leak", ...overrides } as Stripe.PaymentIntent;
  const client = { paymentIntents: { retrieve: async (reference: string) => {
    calls++; assert.equal(reference, f.payment.providerReference);
    await onRetrieve?.();
    return intent as Stripe.Response<Stripe.PaymentIntent>;
  } } };
  return { client, intent, calls: () => calls };
}
function success(f: Fixture) {
  const id = `evt_${randomUUID()}`; eventIds.push(id);
  return { id, type: "payment_intent.succeeded" as const, paymentIntentId: f.payment.providerReference, amount: f.payment.amount.mul(100).toNumber(), currency: "gbp", metadata: { orderId: String(f.order.id) } };
}
async function state(f: Fixture) {
  return { order: await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } }), payment: await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } }),
    listing: await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } }), movements: await prisma.inventoryMovement.count({ where: { listingId: f.listing.id, type: "WEBSITE_SALE" } }) };
}
async function assertConfirmed(f: Fixture) {
  const s = await state(f);
  assert.equal(s.order.status, "CONFIRMED"); assert.equal(s.order.reservationExpiresAt, null);
  assert.equal(s.payment.status, "SUCCEEDED"); assert.ok(s.payment.paidAt);
  assert.equal(s.listing.currentStock, 8); assert.equal(s.listing.reservedStock, 0); assert.equal(s.movements, 1);
  return s;
}
async function assertUnchanged(f: Fixture) {
  const s = await state(f);
  assert.equal(s.order.status, "PENDING"); assert.equal(s.payment.status, "PROCESSING"); assert.equal(s.payment.paidAt, null);
  assert.equal(s.listing.currentStock, 10); assert.equal(s.listing.reservedStock, 2); assert.equal(s.movements, 0);
  assert.equal(await prisma.paymentWebhookEvent.count({ where: { providerEventId: `recovery:${f.payment.id}:${f.payment.providerReference}:succeeded` } }), 0);
}
function token(f: Fixture) { return jwt.sign({ id: f.user.id, role: f.user.role }, config.JWT_SECRET, { expiresIn: "1h" }); }
function post(orderId: number, accessToken?: string, body?: unknown) {
  return fetch(`${url}/orders/${orderId}/payments/stripe/reconcile`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

describe("Stripe missed-webhook recovery", { concurrency: 1 }, () => {
  it("retrieves the existing intent and returns a safely projected automatically confirmed order", async () => {
    const f = await fixture(); const stripe = provider(f);
    const result = await recoverStripePayment(f.order.id, f.user.id, stripe.client);
    assert.equal(stripe.calls(), 1); await assertConfirmed(f);
    assert.equal(result.status, "CONFIRMED"); assert.equal(result.payment?.status, "SUCCEEDED"); assert.ok(result.payment?.paidAt);
    assert.deepEqual(Object.keys(result.payment!).sort(), ["amount", "currency", "paidAt", "status"]);
    assert.equal(result.payment!.amount.toString(), "23.99"); assert.equal(result.payment!.currency,"GBP");
    assert.equal(result.totalAmount.toString(), "23.99"); assert.equal(result.billingLine1, "1 Test Street");
    assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
    const receipt = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: "STRIPE", providerEventId: `recovery:${f.payment.id}:${f.payment.providerReference}:succeeded` } } });
    assert.equal(receipt.eventType, "payment_intent.recovered"); assert.equal(receipt.processingError, null);
  });

  it("serializes repeated concurrent recovery with one movement and stable paidAt", async () => {
    const f = await fixture(); const stripe = provider(f);
    await Promise.all(Array.from({ length: 4 }, () => recoverStripePayment(f.order.id, f.user.id, stripe.client)));
    const first = await assertConfirmed(f);
    await recoverStripePayment(f.order.id, f.user.id, stripe.client);
    const last = await assertConfirmed(f); assert.equal(last.payment.paidAt?.getTime(), first.payment.paidAt?.getTime());
    assert.equal(await prisma.paymentWebhookEvent.count({ where: { providerEventId: `recovery:${f.payment.id}:${f.payment.providerReference}:succeeded` } }), 1);
  });

  it("races recovery with verified duplicate webhook delivery without double conversion", async () => {
    const f = await fixture(); const stripe = provider(f); const event = success(f);
    const payload = JSON.stringify({ id: event.id, type: event.type, data: { object: stripe.intent } });
    const signature = new Stripe("sk_test_fake").webhooks.generateTestHeaderString({ payload, secret: config.STRIPE_WEBHOOK_SECRET! });
    const webhook = () => fetch(`${url}/payments/stripe/webhook`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, "Content-Type": "application/json", "stripe-signature": signature }, body: payload });
    const [a, b] = await Promise.all([webhook(), webhook(), recoverStripePayment(f.order.id, f.user.id, stripe.client)]);
    assert.equal(a.status, 200); assert.equal(b.status, 200); await assertConfirmed(f);
    assert.deepEqual(await reconcileStripePaymentEvent(event), { duplicate: true, handled: true });
  });

  for (const status of ["processing", "requires_payment_method", "requires_action", "requires_confirmation", "requires_capture", "canceled"] as const) {
    it(`does not confirm or invent a payment outcome when Stripe reports ${status}`, async () => {
      const f = await fixture(); const stripe = provider(f, { status, amount_received: 0 });
      const result = await recoverStripePayment(f.order.id, f.user.id, stripe.client);
      assert.equal(result.status, "PENDING"); assert.equal(result.payment?.status, "PROCESSING"); await assertUnchanged(f);
    });
  }

  for (const [name, overrides] of [
    ["amount", { amount: 2001 }], ["received amount", { amount_received: 1999 }], ["currency", { currency: "usd" }],
    ["order metadata", { metadata: { orderId: "wrong-order" } }], ["missing order metadata", { metadata: {} }],
    ["provider reference", { id: "pi_unrelated" }],
  ] as const) {
    it(`rejects ${name} mismatch without business mutations`, async () => {
      const f = await fixture();
      await assert.rejects(() => recoverStripePayment(f.order.id, f.user.id, provider(f, overrides).client), StripeRecoveryMismatchError);
      await assertUnchanged(f);
    });
  }

  it("validates local order total and currency against the local payment", async () => {
    const f = await fixture();
    await prisma.order.update({ where: { id: f.order.id }, data: { totalAmount: 21 } });
    await assert.rejects(() => recoverStripePayment(f.order.id, f.user.id, provider(f).client), StripeRecoveryMismatchError);
    await prisma.order.update({ where: { id: f.order.id }, data: { totalAmount: f.order.totalAmount } });
    await prisma.payment.update({ where: { id: f.payment.id }, data: { currency: "USD" } });
    await assert.rejects(() => recoverStripePayment(f.order.id, f.user.id, provider(f).client), StripeRecoveryMismatchError);
    await assertUnchanged(f);
  });

  it("rechecks provider identity after retrieval without holding an order lock over the network", async () => {
    const f = await fixture();
    const stripe = provider(f, {}, async () => {
      // This would time out/deadlock if recovery held the order lock while retrieving.
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${f.order.id} FOR UPDATE`;
        await tx.payment.update({ where: { id: f.payment.id }, data: { providerReference: `pi_${randomUUID()}` } });
      });
    });
    await assert.rejects(() => recoverStripePayment(f.order.id, f.user.id, stripe.client), StripeRecoveryMismatchError);
    await assertUnchanged(f);
  });

  it("records late success for EXPIRED/CANCELLED orders without resurrecting inventory", async () => {
    for (const status of ["EXPIRED", "CANCELLED"] as const) {
      const f = await fixture();
      // Seed a historical pre-#154 terminal order; current cancellation/expiry retain active payments.
      await prisma.$transaction(async (tx) => {
        await tx.order.update({ where: { id: f.order.id }, data: { status, reservationExpiresAt: null } });
        await tx.productListing.update({ where: { id: f.listing.id }, data: { reservedStock: 0 } });
      });
      const stripe = provider(f); await recoverStripePayment(f.order.id, f.user.id, stripe.client);
      await recoverStripePayment(f.order.id, f.user.id, stripe.client);
      const s = await state(f);
      assert.equal(s.order.status, status); assert.equal(s.payment.status, "SUCCEEDED"); assert.ok(s.payment.paidAt);
      assert.equal(s.listing.currentStock, 10); assert.equal(s.listing.reservedStock, 0); assert.equal(s.movements, 0);
      const receipt = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: "STRIPE", providerEventId: `recovery:${f.payment.id}:${f.payment.providerReference}:succeeded` } } });
      assert.match(receipt.processingError!, /refund\/reconciliation/);
    }
  });

  it("does not move confirmed or fulfilled/returned orders back into normal checkout", async () => {
    for (const status of ["CONFIRMED", "DISPATCHED", "COMPLETED", "RETURNED"] as const) {
      const f = await fixture(); await prisma.payment.update({where:{id:f.payment.id},data:{status:"SUCCEEDED",paidAt:new Date()}}); await confirmOrder(f.user.id, f.order.id);
      await prisma.order.update({ where: { id: f.order.id }, data: { status } });
      await recoverStripePayment(f.order.id, f.user.id, provider(f).client);
      const s = await state(f); assert.equal(s.order.status, status); assert.equal(s.payment.status, "SUCCEEDED");
      assert.equal(s.listing.currentStock, 8); assert.equal(s.listing.reservedStock, 0); assert.equal(s.movements, 1);
    }
  });

  it("retains an active payment reservation during recovery, then confirms late success", async () => {
    const f = await fixture(); await prisma.order.update({ where: { id: f.order.id }, data: { reservationExpiresAt: new Date(0) } });
    const stripe = provider(f, {}, async () => { assert.equal(await expireOrderReservation(f.order.id), null); });
    await recoverStripePayment(f.order.id, f.user.id, stripe.client);
    await assertConfirmed(f);
  });

  it("can confirm an elapsed but still-reserved PENDING order before expiry wins", async () => {
    const f = await fixture(); await prisma.order.update({ where: { id: f.order.id }, data: { reservationExpiresAt: new Date(0) } });
    await recoverStripePayment(f.order.id, f.user.id, provider(f).client);
    await assertConfirmed(f); assert.equal(await expireOrderReservation(f.order.id), null);
  });

  it("rolls back payment, confirmation and recovery evidence if inventory conversion fails, then retries", async () => {
    const f = await fixture(); await prisma.productListing.update({ where: { id: f.listing.id }, data: { reservedStock: 0 } });
    await assert.rejects(() => recoverStripePayment(f.order.id, f.user.id, provider(f).client));
    const failed = await state(f); assert.equal(failed.order.status, "PENDING"); assert.equal(failed.payment.status, "PROCESSING"); assert.equal(failed.payment.paidAt, null); assert.equal(failed.movements, 0);
    assert.equal(await prisma.paymentWebhookEvent.count({ where: { providerEventId: `recovery:${f.payment.id}:${f.payment.providerReference}:succeeded` } }), 0);
    await prisma.productListing.update({ where: { id: f.listing.id }, data: { reservedStock: 2 } });
    await recoverStripePayment(f.order.id, f.user.id, provider(f).client); await assertConfirmed(f);
  });

  it("cannot regress a webhook success when a stale non-success retrieval finishes later", async () => {
    const f = await fixture();
    const stripe = provider(f, { status: "processing", amount_received: 0 }, async () => { await reconcileStripePaymentEvent(success(f)); });
    const result = await recoverStripePayment(f.order.id, f.user.id, stripe.client);
    assert.equal(result.payment?.status, "SUCCEEDED"); await assertConfirmed(f);
  });

  it("rejects missing, another owner's, non-Stripe and placeholder payments before provider calls", async () => {
    const f = await fixture(); const other = await fixture(); const stripe = provider(f);
    await assert.rejects(() => recoverStripePayment(f.order.id, other.user.id, stripe.client), StripeRecoveryOrderNotFoundError);
    await assert.rejects(() => recoverStripePayment(2147483647, f.user.id, stripe.client), StripeRecoveryOrderNotFoundError);
    await prisma.payment.update({ where: { id: f.payment.id }, data: { providerReference: `pending:order-${f.order.id}-stripe` } });
    await assert.rejects(() => recoverStripePayment(f.order.id, f.user.id, stripe.client), StripeRecoveryUnavailableError);
    await prisma.payment.update({ where: { id: f.payment.id }, data: { provider: "MANUAL" } });
    await assert.rejects(() => recoverStripePayment(f.order.id, f.user.id, stripe.client), StripeRecoveryUnavailableError);
    await prisma.payment.delete({ where: { id: f.payment.id } });
    await assert.rejects(() => recoverStripePayment(f.order.id, f.user.id, stripe.client), StripeRecoveryUnavailableError);
    assert.equal(stripe.calls(), 0);
  });

  it("maps provider failures without changing local state", async () => {
    const f = await fixture(); const stripe = provider(f, {}, async () => { throw new Error("Stripe credentials/details must not escape"); });
    await assert.rejects(() => recoverStripePayment(f.order.id, f.user.id, stripe.client), StripePaymentProviderError); await assertUnchanged(f);
  });

  it("HTTP owner recovery ignores browser intent/success assertions and returns the GET contract", async () => {
    const f = await fixture(); const stripe = provider(f); restoreClient = setStripeRecoveryClientForTests(stripe.client);
    const response = await post(f.order.id, token(f), { paymentIntentId: "pi_browser_chosen", status: "succeeded", amount: 1 });
    assert.equal(response.status, 200); const body = await response.json();
    assert.equal(body.status, "CONFIRMED"); assert.equal(body.payment.status, "SUCCEEDED");
    assert.deepEqual(Object.keys(body.payment).sort(), ["amount", "currency", "paidAt", "status"]); assert.equal(body.reservationExpiresAt, null);
    assert.equal(body.payment.amount,"23.99"); assert.equal(body.payment.currency,"GBP");
    assert.equal(body.payments, undefined); assert.deepEqual(body.refunds, []); assert.equal(body.clientSecret, undefined); // Refunds: additive minimal customer summary; never raw refund rows.
    assert.equal(JSON.stringify(body).includes(f.payment.providerReference), false);
    const read = await fetch(`${url}/orders/${f.order.id}`, { headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${token(f)}` } });
    const refreshed = await read.json();
    assert.ok(Date.parse(refreshed.paymentWindow.evaluatedAt) >= Date.parse(body.paymentWindow.evaluatedAt));
    refreshed.paymentWindow.evaluatedAt = body.paymentWindow.evaluatedAt;
    assert.deepEqual(refreshed, body); assert.equal(stripe.calls(), 1); await assertConfirmed(f);
  });

  it("HTTP non-success stays pending and normal GETs never retrieve Stripe", async () => {
    const f = await fixture(); const stripe = provider(f, { status: "processing", amount_received: 0 }); restoreClient = setStripeRecoveryClientForTests(stripe.client);
    for (let i = 0; i < 3; i++) {
      const read = await fetch(`${url}/orders/${f.order.id}`, { headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${token(f)}` } });
      assert.equal((await read.json()).status, "PENDING");
    }
    assert.equal(stripe.calls(), 0);
    const response = await post(f.order.id, token(f), { status: "succeeded" });
    assert.equal(response.status, 200); assert.equal((await response.json()).payment.status, "PROCESSING"); await assertUnchanged(f);
  });

  it("HTTP enforces authentication, verification, privacy and valid order IDs", async () => {
    const f = await fixture(); const other = await fixture(); const stripe = provider(f); restoreClient = setStripeRecoveryClientForTests(stripe.client);
    assert.equal((await post(f.order.id)).status, 401);
    const forbidden = await post(f.order.id, token(other)); assert.equal(forbidden.status, 404); assert.deepEqual(await forbidden.json(), { error: "Order not found" });
    assert.equal((await post(2147483647, token(f))).status, 404);
    const invalid = await fetch(`${url}/orders/bad/payments/stripe/reconcile`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${token(f)}` } }); assert.equal(invalid.status, 400);
    await prisma.user.update({ where: { id: f.user.id }, data: { emailVerified: false } });
    const unverified = await post(f.order.id, token(f)); assert.equal(unverified.status, 403); assert.equal((await unverified.json()).error.code, "EMAIL_VERIFICATION_REQUIRED");
    assert.equal(stripe.calls(), 0); await assertUnchanged(f);
  });

  it("HTTP returns stable conflict/provider errors and permits retry after an inventory error", async () => {
    const f = await fixture();
    restoreClient = setStripeRecoveryClientForTests(provider(f, { amount: 1 }).client);
    const mismatch = await post(f.order.id, token(f)); assert.equal(mismatch.status, 409); assert.equal((await mismatch.json()).error.code, "STRIPE_RECOVERY_MISMATCH");
    restoreClient(); restoreClient = setStripeRecoveryClientForTests(provider(f, {}, async () => { throw new Error("private provider details"); }).client);
    const unavailable = await post(f.order.id, token(f)); assert.equal(unavailable.status, 503); assert.equal((await unavailable.text()).includes("private provider details"), false);
    restoreClient(); restoreClient = setStripeRecoveryClientForTests(provider(f).client);
    await prisma.productListing.update({ where: { id: f.listing.id }, data: { reservedStock: 0 } });
    const failed = await post(f.order.id, token(f)); assert.equal(failed.status, 500); assert.equal((await failed.json()).error.code, "INTERNAL_SERVER_ERROR");
    await prisma.productListing.update({ where: { id: f.listing.id }, data: { reservedStock: 2 } });
    assert.equal((await post(f.order.id, token(f))).status, 200); await assertConfirmed(f);
    await prisma.payment.update({ where: { id: f.payment.id }, data: { providerReference: "pending:unknown" } });
    const noReference = await post(f.order.id, token(f)); assert.equal(noReference.status, 409); assert.equal((await noReference.json()).error.code, "STRIPE_RECOVERY_UNAVAILABLE");
  });
});
