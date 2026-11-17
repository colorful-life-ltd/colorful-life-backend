import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import app from '../app.js';
import { config } from '../config/index.js';
import { prisma } from '../prisma/runtime.js';
import { createOrder } from '../domain/orders/orderService.js';
import { getCustomerPaymentStatus } from '../domain/orders/orderReadService.js';
import { assertCheckoutOpen, PaymentAbuseError } from '../domain/security/paymentAbuse.js';
import { createOrReuseStripePaymentIntent, setStripePaymentClientForTests, StripePaymentNotPayableError } from '../domain/payments/stripePaymentService.js';
import { setStripeRecoveryClientForTests, recoverStripePayment } from '../domain/payments/stripePaymentRecoveryService.js';
import { reconcileStripePaymentEvent } from '../domain/payments/stripeReconciliationService.js';

// Storefront closure: Stripe runtime ON (env switch + key) while the database
// PaymentInitiationPolicy is OFF. Every fixture has positive stock.
const saved = { ...config };
const users: number[] = [], orders: number[] = [], listings: number[] = [], products: number[] = [], events: string[] = [];
let server: Server, url: string;
before(async () => {
  server = app.listen(0); await new Promise<void>(r => server.once('listening', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { server.close(); await prisma.$disconnect(); });
beforeEach(async () => {
  config.PAYMENT_ABUSE_LIMITS_JSON = undefined;
  config.PAYMENT_ABUSE_HMAC_SECRET = 'synthetic-closure-shared-hmac-secret';
  config.PAYMENT_STRIPE_INITIATION_ENABLED = true;
  config.STRIPE_SECRET_KEY = 'sk_test_synthetic';
  config.STRIPE_WEBHOOK_SECRET = 'whsec_closure_test';
  config.PAYMENT_RESOLUTION_ENABLED = false;
  config.PAYMENT_CHALLENGE_ENABLED = false;
  await prisma.$executeRaw`DELETE FROM "AbuseBucket"`;
  await open();
});
afterEach(async () => {
  Object.assign(config, saved);
  await prisma.paymentWebhookEvent.deleteMany({ where: { providerEventId: { in: events.splice(0) } } });
  if (orders.length) await prisma.order.deleteMany({ where: { id: { in: orders.splice(0) } } });
  await prisma.order.deleteMany({ where: { userId: { in: users } } });
  await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listings } } });
  if (listings.length) await prisma.productListing.deleteMany({ where: { id: { in: listings.splice(0) } } });
  if (products.length) await prisma.legoProduct.deleteMany({ where: { id: { in: products.splice(0) } } });
  await prisma.address.deleteMany({ where: { userId: { in: users } } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  await prisma.$executeRaw`DELETE FROM "AbuseBucket"`;
  await open();
});
/** Restores (or recreates) the policy row exactly as the migration seeds it. */
async function open() {
  await prisma.$executeRaw`INSERT INTO "PaymentInitiationPolicy" ("provider", "enabled") VALUES ('STRIPE', true)
    ON CONFLICT ("provider") DO UPDATE SET "enabled"=true, "capacity"=NULL`;
}
/** Same statement as the audited operator updatePolicy path. */
async function close() { await prisma.$executeRaw`UPDATE "PaymentInitiationPolicy" SET "enabled"=false, "updatedAt"=clock_timestamp() WHERE "provider"='STRIPE'`; }
const disabled = (e: unknown) => e instanceof PaymentAbuseError && e.code === 'PAYMENT_INITIATION_DISABLED';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function shop() {
  const u = await prisma.user.create({ data: { email: `${randomUUID()}@closure.test`, passwordHash: 'synthetic', emailVerified: true,
    addresses: { create: { recipientName: 'Buyer', line1: '1 Test St', city: 'London', postcode: 'SW1A 1AA', countryCode: 'GB', isDefaultBilling: true } } } });
  users.push(u.id);
  const product = await prisma.legoProduct.create({ data: { setNumber: 'CLOSURE-'+randomUUID(), title: 'Synthetic product', theme: 'TEST', ageRecommendation: '8+', pieceCount: 10 } }); products.push(product.id);
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: 'NEW', originalPrice: 8.51, currentStock: 10 } }); listings.push(listing.id);
  const input = { shippingMethod: 'STANDARD' as const, items: [{ productListingId: listing.id, quantity: 1 }] };
  return { u, listing, input };
}
async function shopWithOrder() {
  const s = await shop(); const o = await createOrder(s.u.id, s.input); orders.push(o.id); return { ...s, o };
}
async function inventory(listingId: number) {
  const l = await prisma.productListing.findUniqueOrThrow({ where: { id: listingId } });
  return { currentStock: l.currentStock, reservedStock: l.reservedStock, orders: await prisma.orderItem.count({ where: { productListingId: listingId } }) };
}
function stripe() {
  let creates = 0, retrieves = 0, params: any;
  const id = `pi_${randomUUID()}`;
  const client = { paymentIntents: {
    create: async (input: any) => { creates++; params = input; return { ...input, id, status: 'requires_payment_method', client_secret: 'synthetic-secret' }; },
    retrieve: async () => { retrieves++; return { ...params, id, status: 'requires_payment_method', client_secret: 'synthetic-secret' }; },
  } } as any;
  return { client, id, creates: () => creates, retrieves: () => retrieves };
}
function auth(userId: number) { return { Authorization: `Bearer ${jwt.sign({ id: userId, role: 'CUSTOMER' }, config.JWT_SECRET)}` }; }
function payHttp(orderId: number, userId: number) {
  return fetch(`${url}/orders/${orderId}/payments/stripe`, { method: 'POST', headers: { 'Idempotency-Key': randomUUID(), ...auth(userId) } });
}

describe('storefront closure: new orders and reservations', { concurrency: 1 }, () => {
  it('rejects new orders before any order, reservation or abuse budget write', async () => {
    const s = await shop(); const before = await inventory(s.listing.id); await close();
    await assert.rejects(createOrder(s.u.id, s.input), disabled);
    await assert.rejects(createOrder(s.u.id, s.input, randomUUID()), disabled);
    assert.deepEqual(await inventory(s.listing.id), before); assert.equal(before.currentStock, 10);
    assert.equal(await prisma.order.count({ where: { userId: s.u.id } }), 0);
    assert.equal((await prisma.$queryRaw<any[]>`SELECT 1 FROM "AbuseBucket"`).length, 0);
  });
  it('blocks an existing authenticated, verified account on the direct API', async () => {
    const s = await shop(); await close();
    for (let i = 0; i < 3; i++) {
      const response = await fetch(`${url}/orders`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(), ...auth(s.u.id) }, body: JSON.stringify(s.input) });
      assert.equal(response.status, 503); assert.ok(Number(response.headers.get('Retry-After')) > 0);
      assert.equal((await response.json()).error.code, 'PAYMENT_INITIATION_DISABLED');
    }
    assert.equal(await prisma.order.count({ where: { userId: s.u.id } }), 0);
    assert.equal((await inventory(s.listing.id)).reservedStock, 0);
  });
  it('idempotent replay returns only the pre-closure order; it creates nothing and cannot be paid', async () => {
    const s = await shop(); const key = randomUUID();
    const first = await createOrder(s.u.id, s.input, key); orders.push(first.id);
    const before = await inventory(s.listing.id); assert.equal(before.reservedStock, 1);
    await close();
    const replay = await createOrder(s.u.id, s.input, key);
    assert.equal(replay.id, first.id);
    await assert.rejects(createOrder(s.u.id, s.input, randomUUID()), disabled);
    assert.deepEqual(await inventory(s.listing.id), before);
    assert.equal(await prisma.order.count({ where: { userId: s.u.id } }), 1);
    const sdk = stripe();
    await assert.rejects(createOrReuseStripePaymentIntent(first.id, s.u.id, sdk.client), disabled);
    assert.equal(sdk.creates(), 0); assert.equal(await prisma.payment.count({ where: { orderId: first.id } }), 0);
  });
  it('resumes accepting orders once the policy is reopened', async () => {
    const s = await shop(); await close();
    await assert.rejects(createOrder(s.u.id, s.input), disabled);
    await open(); const o = await createOrder(s.u.id, s.input); orders.push(o.id);
    assert.equal((await inventory(s.listing.id)).reservedStock, 1);
  });
});

describe('storefront closure: Stripe checkout paths', { concurrency: 1 }, () => {
  it('rejects new PaymentIntent creation without journal writes or provider calls', async () => {
    const f = await shopWithOrder(); await close(); const sdk = stripe();
    await assert.rejects(createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client), disabled);
    assert.equal(sdk.creates() + sdk.retrieves(), 0);
    assert.equal(await prisma.payment.count({ where: { orderId: f.o.id } }), 0);
    assert.equal((await prisma.$queryRaw<any[]>`SELECT 1 FROM "PaymentAdmission" WHERE "orderId"=${f.o.id}`).length, 0);
  });
  it('withholds the client secret of an existing intent and leaves the payment untouched', async () => {
    const f = await shopWithOrder(); const sdk = stripe();
    const first = await createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client); assert.equal(first.clientSecret, 'synthetic-secret');
    const before = await prisma.payment.findUniqueOrThrow({ where: { orderId: f.o.id } });
    await close();
    await assert.rejects(createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client), disabled);
    assert.equal(sdk.creates(), 1); assert.equal(sdk.retrieves(), 0);
    const restore = setStripePaymentClientForTests(sdk.client);
    try {
      for (let i = 0; i < 3; i++) {
        const response = await payHttp(f.o.id, f.u.id); assert.equal(response.status, 503);
        const body = await response.text(); assert.equal(body.includes('synthetic-secret'), false); assert.equal(body.includes('clientSecret'), false);
      }
    } finally { restore(); }
    assert.equal(sdk.retrieves(), 0);
    assert.deepEqual(await prisma.payment.findUniqueOrThrow({ where: { orderId: f.o.id } }), before);
  });
  it('blocks redispatch of a pending creation after a provider timeout', async () => {
    const f = await shopWithOrder(); const failing = stripe();
    failing.client.paymentIntents.create = async () => { throw new Error('synthetic timeout'); };
    await assert.rejects(createOrReuseStripePaymentIntent(f.o.id, f.u.id, failing.client));
    const pending = await prisma.payment.findUniqueOrThrow({ where: { orderId: f.o.id } }); assert.match(pending.providerReference, /^pending:/);
    await close(); const sdk = stripe();
    await assert.rejects(createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client), disabled);
    assert.equal(sdk.creates(), 0);
    assert.deepEqual(await prisma.payment.findUniqueOrThrow({ where: { orderId: f.o.id } }), pending);
  });
  it('blocks a managed verified-unpaid retry and does not advertise it', async () => {
    config.PAYMENT_RESOLUTION_ENABLED = true;
    const f = await shopWithOrder(); const sdk = stripe();
    await createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: f.o.id } });
    const metadata = { orderId: String(f.o.id), paymentKey: payment.idempotencyKey! };
    const attempt = await prisma.paymentAttempt.findFirstOrThrow({ where: { paymentId: payment.id, historical: false } });
    const id = randomUUID(); events.push(id);
    await reconcileStripePaymentEvent({ id, type: 'payment_intent.payment_failed', paymentIntentId: sdk.id, amount: 1250, currency: 'gbp', metadata: { ...metadata, attemptId: String(attempt.id) } });
    const intent = await sdk.client.paymentIntents.retrieve(sdk.id);
    await recoverStripePayment(f.o.id, f.u.id, { paymentIntents: { retrieve: async () => ({ ...intent, status: 'canceled', amount_received: 0, amount_capturable: 0, last_payment_error: null }) } } as any);
    assert.equal((await getCustomerPaymentStatus(f.u.id, f.o.id))!.paymentWindow.state, 'RETRY_AVAILABLE');
    await close();
    const window = (await getCustomerPaymentStatus(f.u.id, f.o.id))!.paymentWindow;
    assert.equal(window.initiationEligibility, 'INELIGIBLE'); assert.notEqual(window.state, 'RETRY_AVAILABLE');
    const retry = stripe();
    await assert.rejects(createOrReuseStripePaymentIntent(f.o.id, f.u.id, retry.client), disabled);
    assert.equal(retry.creates(), 0);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { orderId: f.o.id } })).providerReference, sdk.id);
  });
  it('withholds the secret when closure commits during provider I/O, without cancelling the payment', async () => {
    const f = await shopWithOrder(); const sdk = stripe(); const create = sdk.client.paymentIntents.create;
    sdk.client.paymentIntents.create = async (input: any) => { const intent = await create(input); await close(); return intent; };
    await assert.rejects(createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client), disabled);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: f.o.id } });
    assert.equal(payment.providerReference, sdk.id); assert.equal(payment.status, 'PROCESSING');
  });
  it('keeps ownership checks ahead of closure for direct API requests', async () => {
    const f = await shopWithOrder(); const other = await shop(); await close();
    const response = await payHttp(f.o.id, other.u.id); assert.equal(response.status, 404);
    const missing = await payHttp(2147483000, f.u.id); assert.equal(missing.status, 404);
    assert.equal((await fetch(`${url}/orders/${f.o.id}/payments/stripe`, { method: 'POST' })).status, 401);
  });
});

describe('storefront closure: concurrency and fail-closed', { concurrency: 1 }, () => {
  it('closure waits for an in-flight admission; later admissions are rejected', async () => {
    const s = await shop(); let release!: () => void, admitted!: () => void;
    const gate = new Promise<void>(r => { release = r; }), entered = new Promise<void>(r => { admitted = r; });
    const inflight = prisma.$transaction(async tx => { await assertCheckoutOpen(tx); admitted(); await gate; }, { timeout: 20000 });
    await entered;
    let closed = false; const closure = close().then(() => { closed = true; });
    await sleep(300); assert.equal(closed, false, 'operator closure must wait for admitted work');
    release(); await inflight; await closure; assert.equal(closed, true);
    await assert.rejects(createOrder(s.u.id, s.input), disabled);
    assert.equal(await prisma.order.count({ where: { userId: s.u.id } }), 0);
  });
  it('an admission racing an uncommitted closure blocks, then observes the closure', async () => {
    const s = await shop(); const f = await shopWithOrder(); const sdk = stripe();
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>(r => { release = r; }), held = new Promise<void>(r => { locked = r; });
    const closing = prisma.$transaction(async tx => {
      await tx.$executeRaw`UPDATE "PaymentInitiationPolicy" SET "enabled"=false, "updatedAt"=clock_timestamp() WHERE "provider"='STRIPE'`;
      locked(); await gate;
    }, { timeout: 20000 });
    await held;
    let settled = 0;
    const attempts = Promise.allSettled([createOrder(s.u.id, s.input), createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client)].map(p => p.finally(() => settled++)));
    await sleep(300); assert.equal(settled, 0, 'admissions must wait for the closure lock');
    release(); await closing;
    const outcomes = await attempts;
    assert.ok(outcomes.every(o => o.status === 'rejected' && disabled(o.reason)));
    assert.equal(await prisma.order.count({ where: { userId: s.u.id } }), 0);
    assert.equal((await inventory(s.listing.id)).reservedStock, 0);
    assert.equal(sdk.creates(), 0); assert.equal(await prisma.payment.count({ where: { orderId: f.o.id } }), 0);
  });
  it('fails closed when the policy row is missing', async () => {
    const f = await shopWithOrder(); const s = await shop(); const sdk = stripe();
    await prisma.$executeRaw`DELETE FROM "PaymentInitiationPolicy" WHERE "provider"='STRIPE'`;
    await assert.rejects(createOrder(s.u.id, s.input), disabled);
    await assert.rejects(createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client), disabled);
    assert.equal(sdk.creates(), 0); assert.equal(await prisma.order.count({ where: { userId: s.u.id } }), 0);
    assert.equal((await getCustomerPaymentStatus(f.u.id, f.o.id))!.paymentWindow.initiationEligibility, 'INELIGIBLE');
  });
  it('fails closed when the policy cannot be read', async () => {
    const broken = { $queryRaw: async () => { throw new Error('synthetic database outage'); } } as any;
    await assert.rejects(assertCheckoutOpen(broken), (e: unknown) => e instanceof PaymentAbuseError && e.code === 'CHECKOUT_PROTECTION_UNAVAILABLE' && e.status === 503);
  });
});

describe('storefront closure preserves financial processing', { concurrency: 1 }, () => {
  it('signed webhooks still confirm a pre-closure payment, which is never shown as cancelled', async () => {
    const f = await shopWithOrder(); const sdk = stripe();
    await createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: f.o.id } });
    await close();
    const pending = (await getCustomerPaymentStatus(f.u.id, f.o.id))!.paymentWindow;
    assert.equal(pending.state, 'PROCESSING'); assert.equal(pending.paymentOutcome, 'PENDING');
    assert.equal(pending.resumeEligibility, 'INELIGIBLE'); assert.equal(pending.initiationEligibility, 'INELIGIBLE');
    const id = 'evt_'+randomUUID(); events.push(id);
    const payload = JSON.stringify({ id, type: 'payment_intent.succeeded', data: { object: { id: sdk.id, amount: 1250, currency: 'gbp', metadata: { orderId: String(f.o.id), paymentKey: payment.idempotencyKey } } } });
    const signature = new Stripe('sk_test_fake').webhooks.generateTestHeaderString({ payload, secret: config.STRIPE_WEBHOOK_SECRET! });
    const post = (sig: string) => fetch(`${url}/payments/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': sig }, body: payload });
    assert.equal((await post('invalid')).status, 400);
    assert.equal((await post(signature)).status, 200);
    const paid = await prisma.payment.findUniqueOrThrow({ where: { orderId: f.o.id } });
    assert.equal(paid.status, 'SUCCEEDED'); assert.ok(paid.paidAt);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.o.id } })).status, 'CONFIRMED');
    const window = (await getCustomerPaymentStatus(f.u.id, f.o.id))!.paymentWindow;
    assert.equal(window.state, 'PAID'); assert.equal(window.paymentOutcome, 'SUCCEEDED');
    // A completed order keeps its pre-existing 409 answer, never the closure 503.
    await assert.rejects(createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client), StripePaymentNotPayableError);
    const restore = setStripePaymentClientForTests(sdk.client);
    try {
      const response = await payHttp(f.o.id, f.u.id); assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, 'ORDER_NOT_PAYABLE');
    } finally { restore(); }
    assert.equal((await post(signature)).status, 200);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { orderId: f.o.id } })).paidAt?.getTime(), paid.paidAt?.getTime());
  });
  it('explicit customer reconciliation still runs while closed', async () => {
    const f = await shopWithOrder(); const sdk = stripe();
    await createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client);
    await close();
    const restore = setStripeRecoveryClientForTests(sdk.client);
    try {
      const response = await fetch(`${url}/orders/${f.o.id}/payments/stripe/reconcile`, { method: 'POST', headers: auth(f.u.id) });
      assert.equal(response.status, 200); assert.equal(sdk.creates(), 1);
    } finally { restore(); }
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { orderId: f.o.id } })).status, 'PROCESSING');
  });
});
