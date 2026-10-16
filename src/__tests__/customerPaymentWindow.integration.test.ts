import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, afterEach, before, describe, it } from "node:test";
import jwt from "jsonwebtoken";
import type Stripe from "stripe";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { databaseNow, initializePaymentResolution, PaymentAdmissionClosedError, PaymentResolutionUnavailableError } from "../domain/payments/paymentResolutionService.js";
import { createOrReuseStripePaymentIntent, setStripePaymentClientForTests, type StripePaymentClient } from "../domain/payments/stripePaymentService.js";
import { reconcileStripePaymentEvent } from "../domain/payments/stripeReconciliationService.js";
import { recoverStripePayment } from "../domain/payments/stripePaymentRecoveryService.js";
import { expireOrderReservation } from "../domain/orders/orderExpiryService.js";
import { readCustomerPaymentWindows, PAYMENT_WINDOW_BATCH_SIZE } from "../domain/payments/customerPaymentWindow.js";
import { getCustomerOrder, listCustomerOrders } from "../domain/orders/orderReadService.js";
import type { CustomerPaymentWindow } from "../domain/payments/customerPaymentWindow.js";

let server: ReturnType<typeof app.listen>, base: string;
const originalManaged = config.PAYMENT_RESOLUTION_ENABLED;
const originalStripe = config.STRIPE_SECRET_KEY;
const userIds: number[] = [], orderIds: number[] = [], listingIds: number[] = [], productIds: number[] = [];
before(async () => {
  config.STRIPE_SECRET_KEY = "sk_test_fake";
  server = app.listen(0); await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { config.STRIPE_SECRET_KEY = originalStripe; config.PAYMENT_RESOLUTION_ENABLED = originalManaged; await new Promise<void>(resolve => server.close(() => resolve())); await prisma.$disconnect(); });
afterEach(async () => {
  await prisma.order.deleteMany({ where: { id: { in: orderIds.splice(0) } } });
  await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listingIds } } });
  await prisma.productListing.deleteMany({ where: { id: { in: listingIds.splice(0) } } });
  await prisma.legoProduct.deleteMany({ where: { id: { in: productIds.splice(0) } } });
  await prisma.address.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  config.PAYMENT_RESOLUTION_ENABLED = originalManaged;
});
async function fixture(managed: boolean, ageMinutes = 0) {
  config.PAYMENT_RESOLUTION_ENABLED = managed;
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@window.test`, passwordHash: "fixture", emailVerified: true,
    addresses: { create: { recipientName: "Buyer", line1: "1 Test Street", city: "London", postcode: "T1", countryCode: "GB", isDefaultBilling: true } } } }); userIds.push(user.id);
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: "Payment window", theme: "TEST", ageRecommendation: "8+", pieceCount: 10 } }); productIds.push(product.id);
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: 10, currentStock: 10, reservedStock: 2 } }); listingIds.push(listing.id);
  const createdAt = new Date((await prisma.$transaction(databaseNow)).getTime() - ageMinutes * 60000);
  const order = await prisma.$transaction(async tx => {
    const order = await tx.order.create({ data: { userId: user.id, totalAmount: 20, createdAt, reservationExpiresAt: new Date(createdAt.getTime() + 1800000),
      billingRecipientName: "Buyer", billingLine1: "1 Test Street", billingCity: "London", billingPostcode: "T1", billingCountryCode: "GB",
      deliveryRecipientName: "Buyer", deliveryLine1: "1 Test Street", deliveryCity: "London", deliveryPostcode: "T1", deliveryCountryCode: "GB",
      orderItems: { create: { productListingId: listing.id, quantity: 2, unitPrice: 10, lineTotal: 20 } } } });
    await initializePaymentResolution(tx, order); return order;
  }); orderIds.push(order.id);
  return { user, listing, order };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function headers(f: Fixture) { return { Authorization: `Bearer ${jwt.sign({ id: f.user.id, role: "CUSTOMER" }, config.JWT_SECRET)}`, "Content-Type": "application/json" }; }
async function read(f: Fixture) { return (await getCustomerOrder(f.user.id, f.order.id))!.paymentWindow; }
function stable(w: CustomerPaymentWindow) { const { evaluatedAt: _time, ...rest } = w; return rest; }
function intent(f: Fixture, id = `pi_${randomUUID()}`): Stripe.PaymentIntent {
  return { id, status: "requires_payment_method", client_secret: "test-only", amount: 2000, amount_received: 0, amount_capturable: 0, currency: "gbp", metadata: { orderId: String(f.order.id) }, last_payment_error: null } as unknown as Stripe.PaymentIntent;
}
async function start(f: Fixture) {
  const remote = intent(f);
  const client = { paymentIntents: { create: async (input: { metadata: Record<string, string> }) => ({ ...remote, metadata: input.metadata }), retrieve: async () => remote } } as unknown as StripePaymentClient;
  await createOrReuseStripePaymentIntent(f.order.id, f.user.id, client);
  return { remote, client };
}
async function event(f: Fixture, remote: Stripe.PaymentIntent, type: "payment_intent.succeeded" | "payment_intent.payment_failed") {
  return reconcileStripePaymentEvent({ id: randomUUID(), type, paymentIntentId: remote.id, amount: 2000, currency: "gbp", metadata: remote.metadata });
}
async function admittedInPast(f: Fixture) {
  const r = await prisma.paymentResolution.findUniqueOrThrow({ where: { orderId: f.order.id } });
  const remote = intent(f);
  const payment = await prisma.payment.create({ data: { orderId: f.order.id, provider: "STRIPE", providerReference: remote.id, amount: 20, status: "PROCESSING" } });
  const attempt = await prisma.paymentAttempt.create({ data: { orderId: f.order.id, paymentId: payment.id, provider: "STRIPE", amount: 20, currency: "GBP", providerReference: remote.id, creationKey: randomUUID(), admittedAt: r.orderCreatedAt } });
  for (const type of ["CREATE", "CONFIRM"] as const) {
    const op = await prisma.paymentOperation.create({ data: { attemptId: attempt.id, type, operationKey: randomUUID(), requestHash: "a".repeat(64), admittedAt: r.orderCreatedAt, admissionDeadline: r.initialPaymentDeadline } });
    await prisma.paymentOperation.update({ where: { id: op.id }, data: { state: "POTENTIALLY_DISPATCHED", executionCount: 1 } });
  }
  return { payment, attempt, remote };
}
async function snapshot(f: Fixture) {
  return {
    order: await prisma.order.findUniqueOrThrow({ where: { id: f.order.id }, include: { orderItems: true, payments: true, paymentResolution: true, paymentAttempts: { include: { operations: true } }, financialEvidence: true, reservationReleaseProofs: true } }),
    listing: await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } }),
    movements: await prisma.inventoryMovement.findMany({ where: { listingId: f.listing.id } }),
  };
}

describe("authoritative customer payment windows", { concurrency: 1 }, () => {
  for (const managed of [false, true]) {
    it(`exposes initial eligibility consistently on create, list, detail, status and idempotent replay (managed=${managed})`, async () => {
      const f = await fixture(managed);
      const key = randomUUID();
      const post = () => fetch(`${base}/orders`, { method: "POST", headers: { ...headers(f), "Idempotency-Key": key }, body: JSON.stringify({ shippingMethod: "STANDARD", items: [{ productListingId: f.listing.id, quantity: 1 }] }) });
      const response = await post(); assert.equal(response.status, 201); const created = await response.json(); orderIds.push(created.id);
      assert.equal(created.paymentWindow.state, "INITIAL_PAYMENT"); assert.equal(created.paymentWindow.initiationEligibility, "ELIGIBLE");
      assert.ok(created.reservationExpiresAt); assert.ok(created.orderItems);
      for (const path of [`/orders/${created.id}`, `/orders/${created.id}/payment-resolution`, "/orders"]) {
        const response = await fetch(`${base}${path}`, { headers: headers(f) }); assert.equal(response.status, 200);
        const result = await response.json(); const window = (Array.isArray(result) ? result.find(o => o.id === created.id) : result).paymentWindow;
        assert.deepEqual(stable(window), stable(created.paymentWindow));
        assert.ok(Date.parse(window.evaluatedAt) >= Date.parse(created.paymentWindow.evaluatedAt));
      }
      const replay = await post(); assert.equal(replay.status, 201);
      assert.equal((await replay.json()).id, created.id);
      assert.equal(await prisma.order.count({ where: { userId: f.user.id } }), 2);
    });
    it(`closes an unstarted window without mutating expiry, then normal expiry releases stock (managed=${managed})`, async () => {
      const f = await fixture(managed, 31); const before = await snapshot(f);
      assert.equal((await read(f)).state, "NOT_PAYABLE"); assert.deepEqual(await snapshot(f), before);
      let calls = 0;
      await assert.rejects(createOrReuseStripePaymentIntent(f.order.id, f.user.id, { paymentIntents: { create: async () => { calls++; } } } as unknown as StripePaymentClient));
      assert.equal(calls, 0); await expireOrderReservation(f.order.id);
      assert.equal((await read(f)).state, "NOT_PAYABLE");
      assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).reservedStock, 0);
    });
    it(`preserves processing after reservation deadline and accepts delayed success (managed=${managed})`, async () => {
      const f = await fixture(managed); const { remote } = await start(f);
      await prisma.order.update({ where: { id: f.order.id }, data: { reservationExpiresAt: new Date(Date.now() - 1) } });
      const window = await read(f);
      assert.equal(window.state, managed ? "CHECKOUT_RESUMABLE" : "PROCESSING");
      assert.equal(window.resumeEligibility, managed ? "ELIGIBLE" : "INELIGIBLE");
      assert.equal(window.initiationEligibility, "INELIGIBLE");
      assert.equal(await expireOrderReservation(f.order.id), null);
      await event(f, remote, "payment_intent.succeeded");
      const result = (await getCustomerOrder(f.user.id, f.order.id))!;
      assert.equal(result.paymentWindow.state, "PAID"); assert.equal(result.paymentWindow.paymentOutcome, "SUCCEEDED");
      assert.equal(result.status, "CONFIRMED"); assert.equal(result.payment!.status, "SUCCEEDED");
      const stock = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } });
      assert.equal(stock.reservedStock, 0); assert.equal(stock.currentStock, 8);
    });
    it(`repeated HTTP reads do not alter financial or inventory state (managed=${managed})`, async () => {
      const f = await fixture(managed); await start(f); const before = await snapshot(f);
      for (let i = 0; i < 3; i++) {
        for (const path of [`/orders/${f.order.id}`, `/orders/${f.order.id}/payment-resolution`, "/orders"]) {
          const response = await fetch(`${base}${path}`, { headers: headers(f) }); assert.equal(response.status, 200);
          const body = await response.json(); assert.equal(JSON.stringify(body).includes("pi_"), false);
        }
      }
      assert.deepEqual(await snapshot(f), before);
    });
  }
  for (const managed of [false, true]) {
    it(`existing checkout can resume through authenticated initiation and refresh (managed=${managed})`, async () => {
      const f = await fixture(managed); const { remote } = await start(f);
      let reads = 0;
      const restore = setStripePaymentClientForTests({ paymentIntents: { retrieve: async () => { reads++; return remote; }, create: async () => { throw Error("must reuse existing payment"); } } } as unknown as StripePaymentClient);
      try {
        for (let repeat = 0; repeat < 2; repeat++) {
          const before = await read(f);
          assert.equal(before.state, "CHECKOUT_RESUMABLE"); assert.equal(before.resumeEligibility, "ELIGIBLE");
          const response = await fetch(`${base}/orders/${f.order.id}/payments/stripe`, { method: "POST", headers: headers(f) });
          assert.equal(response.status, 201); assert.deepEqual(await response.json(), { clientSecret: remote.client_secret });
          const refresh = await fetch(`${base}/orders/${f.order.id}`, { headers: headers(f) });
          const body = await refresh.json(); assert.deepEqual(stable(body.paymentWindow), stable(before));
          assert.equal(JSON.stringify(body).includes("test-only"), false); assert.equal(body.clientSecret, undefined);
        }
        assert.equal(reads, 2); assert.equal(await prisma.payment.count({ where: { orderId: f.order.id } }), 1);
        if (managed) assert.ok(await prisma.paymentOperation.count({ where: { attempt: { orderId: f.order.id }, type: "RETRIEVE", state: "UNKNOWN" } }));
      } finally { restore(); }
      if (managed) {
        await prisma.paymentResolution.update({ where: { orderId: f.order.id }, data: { state: "CLOSED_RESOLVING", paymentAdmissionClosedAt: new Date(), closureReason: "CUSTOMER_ABANDONED" } });
      } else {
        await prisma.order.update({ where: { id: f.order.id }, data: { reservationExpiresAt: new Date(Date.now() - 1) } });
      }
      assert.equal((await read(f)).resumeEligibility, "INELIGIBLE");
      const blocked = await fetch(`${base}/orders/${f.order.id}/payments/stripe`, { method: "POST", headers: headers(f) });
      assert.equal(blocked.status, 409);
    });
  }
  it("read-only retrieval in flight or UNKNOWN does not hide resume; financial UNKNOWN still fails closed", async () => {
    const f = await fixture(true); const { remote } = await start(f);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const called = new Promise<void>(resolve => { entered = resolve; });
    const client = { paymentIntents: { retrieve: async () => { entered(); await gate; return remote; } } } as unknown as StripePaymentClient;
    const pending = createOrReuseStripePaymentIntent(f.order.id, f.user.id, client);
    await called;
    try { assert.equal((await read(f)).resumeEligibility, "ELIGIBLE"); }
    finally { release(); }
    assert.equal((await pending).clientSecret, remote.client_secret);
    assert.equal((await read(f)).state, "CHECKOUT_RESUMABLE");
    const confirm = await prisma.paymentOperation.findFirstOrThrow({ where: { attempt: { orderId: f.order.id }, type: "CONFIRM" } });
    await prisma.paymentOperation.update({ where: { id: confirm.id }, data: { state: "UNKNOWN" } });
    const unresolved = await read(f); assert.equal(unresolved.state, "OUTCOME_UNRESOLVED"); assert.equal(unresolved.resumeEligibility, "INELIGIBLE");
  });
  it("late resume responses cannot advertise a closed checkout or override delayed success", async () => {
    for (const outcome of ["closed", "paid"] as const) {
      const f = await fixture(true); const { remote } = await start(f);
      let release!: () => void, entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const called = new Promise<void>(resolve => { entered = resolve; });
      const pending = createOrReuseStripePaymentIntent(f.order.id, f.user.id, { paymentIntents: { retrieve: async () => { entered(); await gate; return remote; } } } as unknown as StripePaymentClient);
      const rejected = assert.rejects(pending);
      await called;
      try {
        if (outcome === "paid") await event(f, remote, "payment_intent.succeeded");
        else await prisma.paymentResolution.update({ where: { orderId: f.order.id }, data: { state: "CLOSED_RESOLVING", paymentAdmissionClosedAt: new Date(), closureReason: "CUSTOMER_ABANDONED" } });
        assert.equal((await read(f)).resumeEligibility, "INELIGIBLE");
      } finally { release(); }
      await rejected;
      const final = await read(f); assert.equal(final.state, outcome === "paid" ? "PAID" : "PROCESSING");
      assert.equal(final.resumeEligibility, "INELIGIBLE");
    }
  });
  for (const managed of [false, true]) {
  it(`batches a multi-order history with fixed queries per 100 owned orders (managed=${managed})`, async () => {
    const f = await fixture(managed); const other = await fixture(managed);
    const rows = await prisma.order.createManyAndReturn({ data: Array.from({ length: 204 }, () => ({
      userId: f.user.id, totalAmount: 20, reservationExpiresAt: new Date(Date.now() + 1800000),
      billingRecipientName: "Buyer", billingLine1: "1 Test Street", billingCity: "London", billingPostcode: "T1", billingCountryCode: "GB",
      deliveryRecipientName: "Buyer", deliveryLine1: "1 Test Street", deliveryCity: "London", deliveryPostcode: "T1", deliveryCountryCode: "GB",
    })) });
    orderIds.push(...rows.map(row => row.id));
    if (managed) await prisma.paymentResolution.createMany({ data: rows.map(row => ({
      orderId: row.id, orderCreatedAt: row.createdAt, initialPaymentDeadline: new Date(row.createdAt.getTime() + 1800000),
      reservationDisposition: "HELD", dispositionAt: new Date(),
    })) });
    const ids = [f.order.id, ...rows.map(row => row.id)];
    let batches = 0, raw = 0;
    await prisma.$transaction(async tx => {
      const observed = new Proxy(tx, { get(target, key) {
        if (key === "order") return new Proxy(target.order, { get(delegate, method) {
          if (method === "findMany") return (args: any) => { batches++; assert.ok(args.where.id.in.length <= PAYMENT_WINDOW_BATCH_SIZE); return delegate.findMany(args); };
          return Reflect.get(delegate, method);
        } });
        if (key === "$queryRaw") return (...args: any[]) => { raw++; return Reflect.apply(target.$queryRaw, target, args); };
        return Reflect.get(target, key);
      } });
      const windows = await readCustomerPaymentWindows(observed, f.user.id, [...ids, other.order.id]);
      assert.equal(windows.size, 205); assert.equal(windows.has(other.order.id), false);
      assert.equal(new Set([...windows.values()].map(w => w.evaluatedAt)).size, 1);
    }, { isolationLevel: "RepeatableRead" });
    assert.equal(batches, 3); assert.equal(raw, 4); // one clock, three inbox batches
    const listed = await listCustomerOrders(f.user.id); assert.equal(listed.length, 205);
    assert.ok(listed.every(o => ids.includes(o.id) && o.paymentWindow.state === "INITIAL_PAYMENT"));
  });
  it(`a creation projection failure rolls back order and stock before an unkeyed retry (managed=${managed})`, async () => {
    const f = await fixture(managed); const before = await snapshot(f);
    const originalTransaction = prisma.$transaction;
    const original = originalTransaction.bind(prisma);
    prisma.$transaction = ((callback: any, options: any) => original(async tx => {
      const failing = new Proxy(tx, { get(target, key) {
        if (key === "$queryRaw") return (...args: any[]) => {
          if (String(args[0]?.sql ?? "").includes("customer payment window inbox")) throw Error("injected read-model failure");
          return Reflect.apply(target.$queryRaw, target, args);
        };
        return Reflect.get(target, key);
      } });
      return callback(failing);
    }, options)) as typeof prisma.$transaction;
    const post = () => fetch(`${base}/orders`, { method: "POST", headers: headers(f), body: JSON.stringify({ shippingMethod: "STANDARD", items: [{ productListingId: f.listing.id, quantity: 1 }] }) });
    try { assert.equal((await post()).status, 500); } finally { prisma.$transaction = originalTransaction; }
    assert.equal(await prisma.order.count({ where: { userId: f.user.id } }), 1);
    assert.deepEqual(await snapshot(f), before);
    const success = await post(); assert.equal(success.status, 201); const result = await success.json(); orderIds.push(result.id);
    assert.equal(result.paymentWindow.state, "INITIAL_PAYMENT");
    assert.equal(await prisma.order.count({ where: { userId: f.user.id } }), 2);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).reservedStock, 3);
  });
  }
  it("a verified managed failure beyond the initial window exposes a conditional retry and fixed deadline", async () => {
    const f = await fixture(true, 40); const p = await admittedInPast(f);
    assert.equal((await read(f)).state, "PROCESSING");
    await event(f, p.remote, "payment_intent.payment_failed");
    const w = await read(f); assert.equal(w.state, "RETRY_REQUIRES_PROVIDER_CHECK");
    assert.equal(w.initiationEligibility, "REQUIRES_PROVIDER_CHECK"); assert.ok(Date.parse(w.retryDeadline!) > Date.now());
    const provider = { paymentIntents: { retrieve: async () => ({ ...p.remote, last_payment_error: { code: "card_declined" } }) } } as unknown as StripePaymentClient;
    await createOrReuseStripePaymentIntent(f.order.id, f.user.id, provider);
    assert.equal((await read(f)).retryDeadline, w.retryDeadline);
    // Failure evidence does not guarantee the next retrieved provider status is payable.
    const processing = { paymentIntents: { retrieve: async () => ({ ...p.remote, status: "processing" }) } } as unknown as StripePaymentClient;
    await assert.rejects(createOrReuseStripePaymentIntent(f.order.id, f.user.id, processing));
    assert.notEqual((await read(f)).initiationEligibility, "ELIGIBLE");
  });
  it("a managed payment past both original deadlines can still be confirmed by delayed verified success", async () => {
    const f = await fixture(true, 40); const p = await admittedInPast(f);
    const before = await read(f);
    assert.equal(before.state, "PROCESSING"); assert.equal(before.initiationEligibility, "INELIGIBLE");
    assert.ok(Date.parse(before.paymentDeadline!) < Date.now());
    await event(f, p.remote, "payment_intent.succeeded");
    assert.equal((await read(f)).state, "PAID");
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, "CONFIRMED");
  });
  it("verified canceled finality permits a replacement retry that initiation accepts", async () => {
    const f = await fixture(true); const { remote } = await start(f);
    await event(f, remote, "payment_intent.payment_failed");
    const canceled = { ...remote, status: "canceled" as const };
    await recoverStripePayment(f.order.id, f.user.id, { paymentIntents: { retrieve: async () => canceled } } as unknown as NonNullable<Parameters<typeof recoverStripePayment>[2]>);
    const w = await read(f); assert.equal(w.state, "RETRY_AVAILABLE"); assert.equal(w.initiationEligibility, "ELIGIBLE");
    const replacement = intent(f);
    await createOrReuseStripePaymentIntent(f.order.id, f.user.id, { paymentIntents: { create: async (input: { metadata: Record<string, string> }) => ({...replacement, metadata:input.metadata}) } } as unknown as StripePaymentClient);
    assert.equal((await read(f)).state, "RETRY_REQUIRES_PROVIDER_CHECK");
  });
  it("expired retry remains unresolved until provider finality without changing the deadline", async () => {
    const f = await fixture(true, 90); const p = await admittedInPast(f);
    const verified = new Date((await prisma.$transaction(databaseNow)).getTime() - 31 * 60000);
    await prisma.$transaction(async tx => {
      const op = await tx.paymentOperation.findFirstOrThrow({ where: { attemptId: p.attempt.id, type: "CONFIRM" } });
      const evidence = await tx.financialEvidence.create({ data: { orderId: f.order.id, provider: "STRIPE", evidenceKey: randomUUID(), kind: "FAILURE", operationId: op.id, verifiedAt: verified, normalized: { providerReference: p.remote.id } } });
      await tx.paymentOperation.update({ where: { id: op.id }, data: { state: "RESULT_RECORDED", evidenceId: evidence.id } });
      await tx.paymentResolution.update({ where: { orderId: f.order.id }, data: { state: "RETRY_OPEN", firstFailureVerifiedAt: verified, retryDeadline: new Date(verified.getTime() + 1800000), firstFailureOperationId: op.id, firstFailureEvidenceId: evidence.id } });
      await tx.payment.update({ where: { id: p.payment.id }, data: { status: "FAILED" } });
    });
    const w = await read(f); assert.equal(w.state, "OUTCOME_UNRESOLVED"); assert.equal(w.reason, "WINDOW_CLOSED");
    assert.equal(w.initiationEligibility, "INELIGIBLE");
    await assert.rejects(createOrReuseStripePaymentIntent(f.order.id, f.user.id), PaymentAdmissionClosedError);
    assert.equal(await expireOrderReservation(f.order.id), null);
    assert.equal((await read(f)).retryDeadline, w.retryDeadline);
  });
  it("an uncertain create and an unresolved provider inbox cannot advertise payment", async () => {
    const f = await fixture(true);
    await assert.rejects(createOrReuseStripePaymentIntent(f.order.id, f.user.id, { paymentIntents: { create: async () => { throw Error("timeout"); } } } as unknown as StripePaymentClient));
    assert.equal((await read(f)).state, "OUTCOME_UNRESOLVED");
    await assert.rejects(createOrReuseStripePaymentIntent(f.order.id, f.user.id), PaymentResolutionUnavailableError);
    const second = await fixture(true); const started = await start(second);
    await prisma.paymentWebhookEvent.create({ data: { provider: "STRIPE", providerEventId: randomUUID(), eventType: "payment_intent.succeeded", evidence: { orderId: String(second.order.id), paymentIntentId: started.remote.id } } });
    assert.equal((await read(second)).state, "OUTCOME_UNRESOLVED");
    await assert.rejects(createOrReuseStripePaymentIntent(second.order.id, second.user.id), PaymentResolutionUnavailableError);
  });
  it("legacy reads recognize unresolved receipts correlated by provider reference without an attempt ledger", async () => {
    const f = await fixture(false); const { remote } = await start(f);
    await prisma.paymentWebhookEvent.create({ data: { provider: "STRIPE", providerEventId: randomUUID(), eventType: "payment_intent.succeeded", evidence: { paymentIntentId: remote.id } } });
    const w = await read(f); assert.equal(w.state, "OUTCOME_UNRESOLVED"); assert.equal(w.initiationEligibility, "INELIGIBLE");
  });
  it("legacy failure has no invented retry guarantee and managed coverage cannot be reconstructed by reads", async () => {
    const f = await fixture(false); const p = await start(f); await event(f, p.remote, "payment_intent.payment_failed");
    assert.equal((await read(f)).state, "OUTCOME_UNRESOLVED"); assert.equal((await read(f)).retryDeadline, null);
    config.PAYMENT_RESOLUTION_ENABLED = true;
    assert.equal((await read(f)).mode, "UNAVAILABLE"); assert.equal((await read(f)).initiationEligibility, "INELIGIBLE");
    assert.equal(await prisma.paymentResolution.count({ where: { orderId: f.order.id } }), 0);
  });
  it("terminal orders remain non-payable; ownership and authentication protect all reads", async () => {
    const f = await fixture(false); const other = await fixture(false);
    for (const status of ["CANCELLED", "EXPIRED"] as const) {
      await prisma.order.update({ where: { id: f.order.id }, data: { status } });
      assert.equal((await read(f)).state, "NOT_PAYABLE");
    }
    for (const path of [`/orders/${f.order.id}`, `/orders/${f.order.id}/payment-resolution`]) {
      assert.equal((await fetch(`${base}${path}`)).status, 401);
      assert.equal((await fetch(`${base}${path}`, { headers: headers(other) })).status, 404);
    }
    const listed = await (await fetch(`${base}/orders`, { headers: headers(other) })).json();
    assert.equal(listed.some((o: { id: number }) => o.id === f.order.id), false);
    assert.equal((await fetch(`${base}/orders`)).status, 401);
  });
});

for (const existing of [false,true]) it(`foreign Stripe metadata cannot block a managed ${existing?"existing":"initial"} checkout`,async()=>{
 const f=await fixture(true);if(existing)await start(f);
 await reconcileStripePaymentEvent({id:randomUUID(),type:"payment_intent.succeeded",paymentIntentId:`pi_foreign_${randomUUID()}`,amount:2000,currency:"gbp",metadata:{orderId:String(f.order.id)}});
 const window=await read(f);assert.equal(window.state,existing?"CHECKOUT_RESUMABLE":"INITIAL_PAYMENT");
 assert.equal(existing?window.resumeEligibility:window.initiationEligibility,"ELIGIBLE");
 if(!existing)await start(f);
});
