import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import { config } from '../config/index.js';
import { createOrder } from '../domain/orders/orderService.js';
import { prisma } from '../prisma/runtime.js';
import { abuseContext, admitFinancialOperation, admitOrderCreation, bucket, consume, limits, stagingLimits, PaymentAbuseError } from '../domain/security/paymentAbuse.js';
import { reviewOrder, updatePolicy, pruneSecurityState } from '../domain/security/paymentSecurityOperations.js';
import { createOrReuseStripePaymentIntent, setStripePaymentClientForTests } from '../domain/payments/stripePaymentService.js';
import { capturePayPalOrder } from '../domain/payments/paypalCaptureService.js';
import { assertPaymentVerifiedForFulfilment, dispatchLegacyOrder, dispatchShipment } from '../domain/fulfilment/fulfilmentService.js';

const saved = { ...config };
const users: number[] = [], orders: number[] = [], listings: number[] = [], products: number[] = [];
let server: Server, url: string;
const safeFetch = globalThis.fetch;
before(async () => {
  server = app.listen(0); await new Promise<void>(r => server.once('listening', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => { server.close(); await prisma.$disconnect(); });
beforeEach(async () => {
  config.PAYMENT_ABUSE_LIMITS_JSON = undefined;
  config.PAYMENT_ABUSE_HMAC_SECRET = 'synthetic-issue194-shared-hmac-secret';
  config.PAYMENT_STRIPE_INITIATION_ENABLED = config.PAYMENT_PAYPAL_INITIATION_ENABLED = true;
  config.PAYMENT_RESOLUTION_ENABLED = false;
  config.PAYMENT_CHALLENGE_ENABLED = false;
  await prisma.$executeRaw`DELETE FROM "AbuseBucket"`;
  await prisma.$executeRaw`DELETE FROM "PaymentChallengeUse"`;
  await prisma.$executeRaw`UPDATE "PaymentInitiationPolicy" SET "enabled"=true, "capacity"=NULL`;
});
afterEach(async () => {
  Object.assign(config, saved); globalThis.fetch = safeFetch;
  if (orders.length) await prisma.order.deleteMany({ where: { id: { in: orders.splice(0) } } });
  if (listings.length) await prisma.productListing.deleteMany({ where: { id: { in: listings.splice(0) } } });
  if (products.length) await prisma.legoProduct.deleteMany({ where: { id: { in: products.splice(0) } } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  await prisma.$executeRaw`DELETE FROM "AbuseBucket"`;
  await prisma.$executeRaw`UPDATE "PaymentInitiationPolicy" SET "enabled"=true, "capacity"=NULL`;
});
function configure(overrides: Partial<typeof stagingLimits>) {
  config.PAYMENT_ABUSE_LIMITS_JSON = JSON.stringify({ ...stagingLimits, ...overrides });
}
async function customer(role: 'CUSTOMER' | 'ADMIN' = 'CUSTOMER') {
  const u = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic', emailVerified: true, role } }); users.push(u.id); return u;
}
async function order(userId?: number) {
  const u = userId ? { id: userId } : await customer();
  const o = await prisma.order.create({ data: { userId: u.id, totalAmount: 12.50, reservationExpiresAt: new Date(Date.now() + 1800000),
    billingRecipientName: 'Test', billingLine1: '1 Test St', billingCity: 'London', billingPostcode: 'SW1A 1AA', billingCountryCode: 'GB',
    deliveryRecipientName: 'Test', deliveryLine1: '1 Test St', deliveryCity: 'London', deliveryPostcode: 'SW1A 1AA', deliveryCountryCode: 'GB' } });
  orders.push(o.id); return { u, o };
}
async function catalogue() {
  const u = await customer();
  await prisma.address.create({ data: { userId: u.id, recipientName: 'Test', line1: '1 Test St', city: 'London', postcode: 'SW1A 1AA', countryCode: 'GB', isDefaultBilling: true } });
  const product = await prisma.legoProduct.create({ data: { setNumber: 'ABUSE-'+randomUUID(), title: 'Synthetic product', theme: 'TEST', ageRecommendation: '8+', pieceCount: 10 } }); products.push(product.id);
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: 'NEW', originalPrice: 8.51, currentStock: 10 } }); listings.push(listing.id);
  const input = { shippingMethod: 'STANDARD' as const, items: [{ productListingId: listing.id, quantity: 1 }] };
  return { u, listing, input };
}
async function admit(f: Awaited<ReturnType<typeof order>>, identity: string = randomUUID(), network: string = randomUUID(), provider: 'STRIPE' | 'PAYPAL' = 'STRIPE', challengeVerified = false) {
  return abuseContext.run({ network, challengeVerified }, () => prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${f.o.id} FOR UPDATE`;
    await admitFinancialOperation(tx, provider, f.o.id, f.u.id, identity);
  }));
}
function stripe() {
  let calls = 0, params: any;
  const id = `pi_${randomUUID()}`;
  const client = { paymentIntents: {
    create: async (input: any) => { calls++; params = input; return { ...input, id, status: 'requires_payment_method', client_secret: 'synthetic-secret' }; },
    retrieve: async () => ({ ...params, id, status: 'requires_payment_method', client_secret: 'synthetic-secret' }),
  } } as any;
  return { client, calls: () => calls };
}
function auth(user: { id: number; role?: string }) { return { Authorization: `Bearer ${jwt.sign({ id: user.id, role: user.role ?? 'CUSTOMER' }, config.JWT_SECRET)}` }; }
async function stripeHttp(f: Awaited<ReturnType<typeof order>>, extra: Record<string, string> = {}) {
  return fetch(`${url}/orders/${f.o.id}/payments/stripe`, { method: 'POST', headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, ...auth(f.u), ...extra } });
}

describe('distributed checkout admission', { concurrency: 1 }, () => {
  it('uses documented staging defaults and rejects malformed configuration', () => {
    assert.equal(limits().provider[0], 100); assert.deepEqual(limits().paymentAccount, [5, 900]);
    config.PAYMENT_ABUSE_LIMITS_JSON = '{"provider":[0,900]}'; assert.throws(limits, PaymentAbuseError);
    config.PAYMENT_ABUSE_LIMITS_JSON = '{"typo":[1,1]}'; assert.throws(limits, PaymentAbuseError);
  });
  it('fails closed without a shared HMAC secret', async () => {
    const f = await order(); config.PAYMENT_ABUSE_HMAC_SECRET = undefined;
    await assert.rejects(admit(f), PaymentAbuseError); assert.equal(await prisma.payment.count({ where: { orderId: f.o.id } }), 0);
  });
  it('atomically admits exactly the burst capacity under concurrency', async () => {
    const subject = randomUUID(); const jobs = Array.from({ length: 20 }, () => prisma.$transaction(tx => consume(tx, [{ key: subject, capacity: 4, seconds: 3600 }])));
    const outcomes = await Promise.allSettled(jobs); assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 4);
    assert.equal(outcomes.filter(r => r.status === 'rejected').length, 16);
  });
  it('enforces one shared budget across independent Node processes', async () => {
    const key = randomUUID();
    const code = `import {prisma} from './dist/prisma/runtime.js';import {consume} from './dist/domain/security/paymentAbuse.js';try{await prisma.$transaction(tx=>consume(tx,[{key:process.argv[1],capacity:2,seconds:3600}]));console.log('ADMITTED')}catch{console.log('BLOCKED')}finally{await prisma.$disconnect()}`;
    const results = await Promise.all(Array.from({ length: 6 }, () => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, key], { env: process.env }); let output = '';
      child.stdout.on('data', d => output += d); child.on('error', reject); child.on('close', exit => exit === 0 ? resolve(output) : reject(new Error('Child failed')));
    })));
    assert.equal(results.filter(s => s.includes('ADMITTED')).length, 2); assert.equal(results.filter(s => s.includes('BLOCKED')).length, 4);
  });
  it('serializes financial admission across processes despite different orders and networks', async () => {
    const u = await customer(); const fixtures = await Promise.all(Array.from({ length: 6 }, () => order(u.id)));
    const code = `import {prisma} from './dist/prisma/runtime.js';import {admitFinancialOperation,abuseContext} from './dist/domain/security/paymentAbuse.js';try{await abuseContext.run({network:process.argv[1]},()=>prisma.$transaction(async tx=>{const id=Number(process.argv[2]);await tx.$queryRawUnsafe('SELECT id FROM "Order" WHERE id=$1 FOR UPDATE',id);await admitFinancialOperation(tx,'STRIPE',id,Number(process.argv[3]),process.argv[4])}));console.log('ADMITTED')}catch(e){if(e.code==='CHECKOUT_RATE_LIMITED')console.log('BLOCKED');else{console.error(e);process.exitCode=1}}finally{await prisma.$disconnect()}`;
    const results = await Promise.all(fixtures.map(f => new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code, randomUUID(), String(f.o.id), String(u.id), randomUUID()], {
        env: { ...process.env, PAYMENT_ABUSE_HMAC_SECRET: config.PAYMENT_ABUSE_HMAC_SECRET!, PAYMENT_ABUSE_LIMITS_JSON: JSON.stringify({ ...stagingLimits, paymentAccount: [2, 900], challengeAfter: [100, 900] }) },
      }); let output = '', error = '';
      child.stdout.on('data', d => output += d); child.stderr.on('data', d => error += d); child.on('error', reject);
      child.on('close', exit => exit === 0 ? resolve(output) : reject(new Error(error)));
    })));
    assert.equal(results.filter(s => s.includes('ADMITTED')).length, 2); assert.equal(results.filter(s => s.includes('BLOCKED')).length, 4);
  });
  it('preserves order idempotency at the reservation cap without reserving stock twice', async () => {
    const f = await catalogue(); configure({ activeReservations: [1, 1], orderAccount: [1, 900] }); const key = randomUUID();
    const first = await createOrder(f.u.id, f.input, key); orders.push(first.id);
    const replay = await createOrder(f.u.id, f.input, key); assert.equal(replay.id, first.id);
    await assert.rejects(createOrder(f.u.id, f.input, randomUUID()), PaymentAbuseError);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).reservedStock, 1);
    assert.equal(await prisma.order.count({ where: { userId: f.u.id } }), 1);
  });
  it('serializes concurrent new order keys and leaves rejected stock untouched', async () => {
    const f = await catalogue(); configure({ activeReservations: [1, 1] });
    const results = await Promise.allSettled([createOrder(f.u.id, f.input, randomUUID()), createOrder(f.u.id, f.input, randomUUID())]);
    for (const r of results) if (r.status === 'fulfilled') orders.push(r.value.id);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const listing = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } });
    assert.equal(listing.currentStock, 10); assert.equal(listing.reservedStock, 1);
  });
  it('rolls back all budgets if any dimension rejects', async () => {
    const full = randomUUID(), untouched = randomUUID();
    await prisma.$transaction(tx => consume(tx, [{ key: full, capacity: 1, seconds: 3600 }]));
    await assert.rejects(prisma.$transaction(tx => consume(tx, [{ key: untouched, capacity: 1, seconds: 3600 }, { key: full, capacity: 1, seconds: 3600 }])));
    assert.equal((await prisma.$queryRaw<any[]>`SELECT * FROM "AbuseBucket" WHERE "key"=${untouched}`).length, 0);
  });
  it('refills from database time without permanent global exhaustion', async () => {
    const b = bucket('provider', randomUUID(), 1); await prisma.$transaction(tx => consume(tx, [b]));
    await assert.rejects(prisma.$transaction(tx => consume(tx, [b])));
    await prisma.$executeRaw`UPDATE "AbuseBucket" SET "updatedAt"=clock_timestamp()-interval '1 hour' WHERE "key"=${b.key}`;
    await prisma.$transaction(tx => consume(tx, [b]));
  });
  it('does not reset account limits through new IPs, sessions, orders or providers', async () => {
    configure({ paymentAccount: [2, 900], challengeAfter: [100, 900] });
    const a = await order(), b = await order(a.u.id), c = await order(a.u.id);
    await admit(a); await admit(b, randomUUID(), 'different-ip', 'PAYPAL');
    await assert.rejects(admit(c, randomUUID(), 'third-ip'), (e: unknown) => e instanceof PaymentAbuseError && e.code === 'CHECKOUT_RATE_LIMITED');
  });
  it('does not reset network limits through new accounts', async () => {
    configure({ paymentNetwork: [1, 900] }); const a = await order(), b = await order();
    await admit(a, randomUUID(), 'same-network'); await assert.rejects(admit(b, randomUUID(), 'same-network'), PaymentAbuseError);
  });
  it('enforces independently adjustable provider budgets across identities', async () => {
    const admin = await customer('ADMIN'); await updatePolicy(admin.id, 'STRIPE', true, 1, 'staging global limit');
    await admit(await order()); await assert.rejects(admit(await order()), PaymentAbuseError);
    await admit(await order(), randomUUID(), randomUUID(), 'PAYPAL');
    await updatePolicy(admin.id, 'STRIPE', true, 2, 'adjust staging budget');
    // Raising capacity does not reset spent credit; refill is still based on time.
    const b = bucket('provider', 'STRIPE'); await prisma.$executeRaw`UPDATE "AbuseBucket" SET "updatedAt"=clock_timestamp()-interval '1 hour' WHERE "key"=${b.key}`;
    await admit(await order());
  });
  it('does not charge financial budgets again for an authoritative operation replay', async () => {
    const f = await order(), identity = randomUUID(); configure({ paymentAccount: [1, 900] });
    await admit(f, identity); await admit(f, identity);
    assert.equal((await prisma.$queryRaw<any[]>`SELECT * FROM "PaymentAdmission" WHERE "orderId"=${f.o.id}`).length, 1);
    await assert.rejects(admit(f), PaymentAbuseError);
  });
  it('does not permanently count expired payment-free reservations as active', async () => {
    const f = await order(); configure({ activeReservations: [1, 1] });
    await prisma.order.update({ where: { id: f.o.id }, data: { reservationExpiresAt: new Date(Date.now()-60000) } });
    await prisma.$transaction(tx => admitOrderCreation(tx, f.u.id));
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.o.id } })).status, 'PENDING');
  });
  it('limits new payment-free reservations without deleting or releasing existing orders', async () => {
    const f = await order(); configure({ activeReservations: [1, 1] });
    await assert.rejects(prisma.$transaction(tx => admitOrderCreation(tx, f.u.id)), PaymentAbuseError);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.o.id } })).status, 'PENDING');
  });
});

describe('initiation switches and safe recovery', { concurrency: 1 }, () => {
  for (const managed of [false, true]) it(`blocks Stripe creation before persistence/provider work (managed=${managed})`, async () => {
    const f = await order(); config.PAYMENT_RESOLUTION_ENABLED = managed;
    if (managed) { const { initializePaymentResolution } = await import('../domain/payments/paymentResolutionService.js'); await prisma.$transaction(tx => initializePaymentResolution(tx, f.o)); }
    config.PAYMENT_STRIPE_INITIATION_ENABLED = false; const sdk = stripe();
    await assert.rejects(createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client), (e: unknown) => e instanceof PaymentAbuseError && e.code === 'PAYMENT_INITIATION_DISABLED');
    assert.equal(sdk.calls(), 0); assert.equal(await prisma.payment.count({ where: { orderId: f.o.id } }), 0);
    assert.equal(await prisma.paymentOperation.count({ where: { attempt: { orderId: f.o.id } } }), 0);
  });
  it('blocks a new PayPal capture before journalling and preserves pending stock ownership', async () => {
    const f = await order(); const payment = await prisma.payment.create({ data: { orderId: f.o.id, amount: 12.50, provider: 'PAYPAL', providerReference: 'ORDER-'+randomUUID() } });
    config.PAYMENT_PAYPAL_INITIATION_ENABLED = false; let calls = 0;
    await assert.rejects(capturePayPalOrder(f.o.id, f.u.id, { captureOrder: async () => { calls++; throw new Error('must not call'); } }), PaymentAbuseError);
    assert.equal(calls, 0); assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).captureIdempotencyKey, null);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.o.id } })).status, 'PENDING');
  });
  it('switches providers independently and recovers after re-enabling', async () => {
    const f = await order(); config.PAYMENT_STRIPE_INITIATION_ENABLED = false;
    await admit(await order(), randomUUID(), randomUUID(), 'PAYPAL');
    await assert.rejects(admit(f), PaymentAbuseError); config.PAYMENT_STRIPE_INITIATION_ENABLED = true; await admit(f);
  });
  it('retains bound Stripe checkout retrieval when new initiation is disabled', async () => {
    const f = await order(), sdk = stripe(); const first = await createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client);
    config.PAYMENT_STRIPE_INITIATION_ENABLED = false;
    assert.equal((await createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client)).providerReference, first.providerReference);
    assert.equal(sdk.calls(), 1);
  });
  it('preserves explicit recovery when initiation HTTP work is exhausted and switches are disabled', async () => {
    const f = await order(), sdk = stripe();
    const restore = setStripePaymentClientForTests(sdk.client);
    const { setStripeRecoveryClientForTests } = await import('../domain/payments/stripePaymentRecoveryService.js');
    const recovery = setStripeRecoveryClientForTests(sdk.client);
    try {
      configure({ requestAccount: [1, 900] });
      assert.equal((await stripeHttp(f)).status, 201);
      assert.equal((await stripeHttp(f)).status, 429);
      config.PAYMENT_STRIPE_INITIATION_ENABLED = false;
      const response = await fetch(`${url}/orders/${f.o.id}/payments/stripe/reconcile`, { method: 'POST', headers: auth(f.u) });
      assert.equal(response.status, 200); assert.equal(sdk.calls(), 1);
    } finally { restore(); recovery(); }
  });
  it('retains financial admission after a provider timeout without granting fresh budget', async () => {
    const f = await order(); const sdk = stripe(); sdk.client.paymentIntents.create = async () => { throw new Error('synthetic timeout'); };
    await assert.rejects(createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client));
    assert.equal((await prisma.$queryRaw<any[]>`SELECT * FROM "PaymentAdmission" WHERE "orderId"=${f.o.id}`).length, 1);
    assert.match((await prisma.payment.findUniqueOrThrow({ where: { orderId: f.o.id } })).providerReference, /^pending:/);
  });
  it('processes verified Stripe success and refunds while both initiation switches are disabled', async () => {
    const f = await order(), sdk = stripe(); await createOrReuseStripePaymentIntent(f.o.id, f.u.id, sdk.client);
    config.PAYMENT_STRIPE_INITIATION_ENABLED = config.PAYMENT_PAYPAL_INITIATION_ENABLED = false;
    const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: f.o.id } });
    const { reconcileStripePaymentEvent } = await import('../domain/payments/stripeReconciliationService.js');
    const eventId = 'evt_'+randomUUID();
    try {
      await reconcileStripePaymentEvent({ id: eventId, type: 'payment_intent.succeeded', paymentIntentId: payment.providerReference,
        amount: 1250, currency: 'gbp', metadata: { orderId: String(f.o.id), paymentKey: payment.idempotencyKey! } });
      assert.equal((await prisma.payment.findUniqueOrThrow({ where: { orderId: f.o.id } })).status, 'SUCCEEDED');
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.o.id } })).status, 'CONFIRMED');
      const { createOrReuseStripeRefund, setStripeRefundClientForTests } = await import('../domain/refunds/stripeRefundService.js');
      const restore = setStripeRefundClientForTests({ createRefund: async (input: any) => ({ id: 're_'+randomUUID(), amount: input.amount, currency: 'gbp', status: 'succeeded', payment_intent: payment.providerReference, metadata: input.metadata }) as any });
      try {
        const refund = await createOrReuseStripeRefund(f.o.id, payment.id, 1, undefined, f.u.id, undefined, undefined, randomUUID());
        assert.equal(refund.status, 'SUCCEEDED');
        assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).refundedAmount.toString(), '1');
      } finally { restore(); }
    } finally { await prisma.paymentWebhookEvent.deleteMany({ where: { providerEventId: eventId } }); }
  });
  it('keeps successful PayPal capture retrieval available with initiation disabled', async () => {
    const f = await order();
    await prisma.payment.create({ data: { orderId: f.o.id, amount: 12.50, provider: 'PAYPAL', providerReference: 'ORDER-'+randomUUID(), providerCaptureReference: 'CAP-'+randomUUID(), status: 'SUCCEEDED', paidAt: new Date() } });
    config.PAYMENT_PAYPAL_INITIATION_ENABLED = false;
    const result = await capturePayPalOrder(f.o.id, f.u.id, { captureOrder: async () => { throw new Error('No provider POST allowed'); } });
    assert.ok(result.captureId);
  });
  it('keeps PayPal customer order initiation unconditionally disabled', async () => {
    const f = await order(); const response = await fetch(`${url}/orders/${f.o.id}/payments/paypal`, { method: 'POST', headers: auth(f.u) });
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'PAYPAL_INITIATION_DISABLED');
  });
});

describe('challenge and HTTP boundary', { concurrency: 1 }, () => {
  it('requires verified friction after staging admission threshold without provider work', async () => {
    configure({ challengeAfter: [1, 900] }); const f = await order(), g = await order(f.u.id);
    await admit(f); await assert.rejects(admit(g), (e: unknown) => e instanceof PaymentAbuseError && e.code === 'CHECKOUT_CHALLENGE_REQUIRED');
  });
  it('verifies fresh hostname/action and single-use challenge before elevated admission', async () => {
    configure({ challengeAfter: [1, 900] }); const f = await order(), g = await order(f.u.id); await admit(f);
    config.PAYMENT_CHALLENGE_ENABLED = true; config.TURNSTILE_SECRET_KEY = 'synthetic'; config.TURNSTILE_HOSTNAME = 'shop.example.test';
    let verificationCalls = 0;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input).startsWith('https://challenges.cloudflare.com/')) { verificationCalls++; return Response.json({ success: true, hostname: 'shop.example.test', action: 'checkout', challenge_ts: new Date().toISOString() }); }
      return safeFetch(input, init);
    }) as typeof fetch;
    const sdk = stripe(), restore = setStripePaymentClientForTests(sdk.client);
    try {
      const response = await stripeHttp(g, { 'X-Checkout-Challenge': 'synthetic-single-use' }); assert.equal(response.status, 201);
      const replay = await stripeHttp(g, { 'X-Checkout-Challenge': 'synthetic-single-use' }); assert.equal(replay.status, 403);
      assert.equal(sdk.calls(), 1); assert.equal(verificationCalls, 2);
      assert.equal((await prisma.$queryRaw<any[]>`SELECT * FROM "PaymentFulfilmentReview" WHERE "orderId"=${g.o.id}`).length, 1);
    } finally { restore(); }
  });
  for (const invalid of ['wrong-host', 'wrong-action', 'old', 'rejected', 'network']) it(`fails closed for Turnstile ${invalid}`, async () => {
    const f = await order(); config.PAYMENT_CHALLENGE_ENABLED = true; config.TURNSTILE_SECRET_KEY = 'synthetic'; config.TURNSTILE_HOSTNAME = 'shop.example.test';
    globalThis.fetch = (async (input: any, init?: any) => {
      if (String(input).startsWith('https://challenges.cloudflare.com/')) {
        if (invalid === 'network') throw new Error('synthetic network failure');
        return Response.json({ success: invalid !== 'rejected', hostname: invalid === 'wrong-host' ? 'evil.test' : 'shop.example.test', action: invalid === 'wrong-action' ? 'login' : 'checkout', challenge_ts: new Date(Date.now() - (invalid === 'old' ? 600000 : 0)).toISOString() });
      } return safeFetch(input, init);
    }) as typeof fetch;
    const response = await stripeHttp(f, { 'X-Checkout-Challenge': 'synthetic' }); assert.ok([403, 503].includes(response.status));
    assert.equal(await prisma.payment.count({ where: { orderId: f.o.id } }), 0);
  });
  it('ignores attacker forwarding headers when the socket is not a trusted proxy', async () => {
    configure({ loginNetwork: [1, 3600] });
    const request = (ip: string) => fetch(url+'/auth/login', { method: 'POST', headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, 'Content-Type': 'application/json', 'X-Forwarded-For': ip }, body: '{}' });
    assert.equal((await request('192.0.2.1')).status, 400); assert.equal((await request('192.0.2.2')).status, 429);
  });
  it('returns predictable retry guidance without secrets or identity details', async () => {
    const f = await order(); config.PAYMENT_STRIPE_INITIATION_ENABLED = false;
    const response = await stripeHttp(f); assert.equal(response.status, 503); assert.ok(Number(response.headers.get('Retry-After')) > 0);
    const body = await response.json(); assert.equal(body.error.code, 'PAYMENT_INITIATION_DISABLED'); assert.equal(JSON.stringify(body).includes(config.PAYMENT_ABUSE_HMAC_SECRET!), false);
  });
});

describe('financially independent fulfilment review', { concurrency: 1 }, () => {
  it('blocks both dispatch APIs for a paid held order until audited ADMIN release', async () => {
    const f = await order(), admin = await customer('ADMIN');
    await prisma.order.update({ where: { id: f.o.id }, data: { status: 'CONFIRMED' } });
    await prisma.payment.create({ data: { orderId: f.o.id, amount: 12.50, provider: 'STRIPE', providerReference: 'pi_'+randomUUID(), status: 'SUCCEEDED', paidAt: new Date() } });
    await reviewOrder(admin.id, f.o.id, 'HOLD', 'Investigate synthetic velocity');
    await assert.rejects(prisma.$transaction(tx => assertPaymentVerifiedForFulfilment(tx, f.o.id)), /SECURITY_REVIEW_REQUIRED/);
    await assert.rejects(dispatchShipment(admin.id, f.o.id, { carrier: 'ROYAL_MAIL', carrierName: 'Royal Mail', trackingNumber: null, actualShippingCost: 1 }), /SECURITY_REVIEW_REQUIRED/);
    await assert.rejects(prisma.$transaction(tx => dispatchLegacyOrder(tx, admin.id, f.o.id, { carrier: null, carrierName: 'Test Carrier', trackingNumber: null, actualShippingCost: 1 })), /SECURITY_REVIEW_REQUIRED/);
    await assert.rejects(reviewOrder(f.u.id, f.o.id, 'RELEASE', 'Customer cannot release'));
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { orderId: f.o.id } })).status, 'SUCCEEDED');
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.o.id } })).status, 'CONFIRMED');
    await reviewOrder(admin.id, f.o.id, 'RELEASE', 'Reviewed synthetic payment evidence');
    await prisma.$transaction(tx => assertPaymentVerifiedForFulfilment(tx, f.o.id));
    const audit = await prisma.$queryRaw<any[]>`SELECT * FROM "PaymentSecurityEvent" WHERE "orderId"=${f.o.id} AND "kind"='ADMIN_RELEASE'`;
    assert.equal(audit.length, 1); assert.equal(audit[0].actorId, admin.id);
  });
  it('forbids customer and forged ADMIN claims at the operator endpoint', async () => {
    const u = await customer(); const headers = { Authorization: `Bearer ${jwt.sign({ id: u.id, role: 'ADMIN' }, config.JWT_SECRET)}` };
    assert.equal((await fetch(url+'/admin/payment-security', { headers })).status, 403);
    assert.equal((await fetch(url+'/admin/payment-security')).status, 401);
  });
  it('bounds cleanup to expired security state and preserves live counters', async () => {
    const live = bucket('provider', randomUUID()), expired = bucket('provider', randomUUID());
    await prisma.$transaction(tx => consume(tx, [live, expired]));
    await prisma.$executeRaw`UPDATE "AbuseBucket" SET "expiresAt"=clock_timestamp()-interval '1 hour' WHERE "key"=${expired.key}`;
    assert.equal((await pruneSecurityState()).buckets, 1);
    assert.equal((await prisma.$queryRaw<any[]>`SELECT * FROM "AbuseBucket" WHERE "key"=${live.key}`).length, 1);
  });
});
