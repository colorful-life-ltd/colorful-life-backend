import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { request } from 'node:http';
import { after, afterEach, before, beforeEach, it } from 'node:test';
import app from '../app.js';
import { prisma } from '../prisma/runtime.js';
import { config } from '../config/index.js';
import { createOrder } from '../domain/orders/orderService.js';
import { createOrReusePayPalRefund } from '../domain/refunds/paypalRefundService.js';
import { paypalWebhookHandler } from '../controllers/paypalWebhookController.js';
import { PAYPAL_WEBHOOK_VERIFICATION_TIMEOUT_MS } from '../domain/payments/paypalWebhookVerification.js';

const localFetch = globalThis.fetch;
const original = { PAYPAL_CLIENT_ID: config.PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: config.PAYPAL_CLIENT_SECRET, PAYPAL_BASE_URL: config.PAYPAL_BASE_URL, PAYPAL_WEBHOOK_ID: config.PAYPAL_WEBHOOK_ID, PAYMENT_RESOLUTION_ENABLED: config.PAYMENT_RESOLUTION_ENABLED };
const sandbox = 'https://api-m.sandbox.paypal.com';
let server: ReturnType<typeof app.listen>, url: string;
let calls: Array<{ url: string; init?: RequestInit }>;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); url = `http://127.0.0.1:${(server.address() as { port: number }).port}/payments/paypal/webhook`; });
beforeEach(() => {
  Object.assign(config, { PAYPAL_CLIENT_ID: 'synthetic-client', PAYPAL_CLIENT_SECRET: 'synthetic-secret', PAYPAL_BASE_URL: sandbox, PAYPAL_WEBHOOK_ID: 'SYNTHETICWEBHOOK1', PAYMENT_RESOLUTION_ENABLED: false });
  calls = []; provider();
});
afterEach(() => { globalThis.fetch = localFetch; Object.assign(config, original); });
after(async () => { await new Promise<void>(r => server.close(() => r())); await prisma.$disconnect(); });
function headers() { return { 'content-type': 'application/json', 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': `${sandbox}/v1/notifications/certs/CERT-synthetic-123`, 'paypal-transmission-id': `tx-${randomUUID()}`, 'paypal-transmission-sig': Buffer.alloc(256, 1).toString('base64'), 'paypal-transmission-time': '2026-10-17T14:00:00Z' }; }
function provider(verify: unknown = { verification_status: 'SUCCESS' }) {
  globalThis.fetch = async (input, init) => {
    const address = String(input); calls.push({ url: address, init });
    assert.ok([`${config.PAYPAL_BASE_URL}/v1/oauth2/token`, `${config.PAYPAL_BASE_URL}/v1/notifications/verify-webhook-signature`].includes(address));
    assert.equal(init?.redirect, 'error'); assert.ok(init?.signal);
    return new Response(JSON.stringify(address.endsWith('/token') ? { access_token: 'synthetic-token' } : verify), { status: 200 });
  };
}
async function fixture() {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@pp4.test`, passwordHash: 'synthetic', emailVerified: true,
    addresses: { create: { recipientName: 'Synthetic Buyer', line1: '1 Fictional Street', city: 'Testville', postcode: 'T1', countryCode: 'GB', isDefaultBilling: true } } } });
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: 'PP4 synthetic product', theme: 'PP4', ageRecommendation: '8+', pieceCount: 10 } });
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: 'NEW', originalPrice: 10, currentStock: 5 } });
  const order = await createOrder(user.id, { shippingMethod: 'STANDARD', items: [{ productListingId: listing.id, quantity: 2 }] });
  const payment = await prisma.payment.create({ data: { orderId: order.id, provider: 'PAYPAL', providerReference: `PP-${randomUUID()}`, providerCaptureReference: `CAP-${randomUUID()}`, amount: order.totalAmount, currency: 'GBP', status: 'PROCESSING' } });
  const event = { id: randomUUID(), event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { id: payment.providerCaptureReference, status: 'COMPLETED', amount: { value: payment.amount.toFixed(2), currency_code: 'GBP' }, supplementary_data: { related_ids: { order_id: payment.providerReference } } } };
  return { order, payment, listing, event };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function snapshot(f: Fixture) {
  return {
    payment: await prisma.payment.findUnique({ where: { id: f.payment.id } }), order: await prisma.order.findUnique({ where: { id: f.order.id } }),
    listing: await prisma.productListing.findUnique({ where: { id: f.listing.id } }),
    refunds: await prisma.refund.findMany({ where: { paymentId: f.payment.id }, orderBy: { id: 'asc' } }),
    inbox: await prisma.paymentWebhookEvent.findMany({ where: { provider: 'PAYPAL', providerEventId: f.event.id } }),
    counts: await Promise.all([prisma.paymentWebhookEvent.count(), prisma.financialEvidence.count(), prisma.refund.count(), prisma.inventoryMovement.count(), prisma.orderConfirmationJob.count(), prisma.commercialInvoice.count()]),
  };
}
async function rejectWithoutMutation(f: Fixture, options: { headers?: Record<string, string>; body?: string | Buffer; status?: number } = {}) {
  const before = await snapshot(f);
  const body = options.body ?? JSON.stringify(f.event);
  const response = await localFetch(url, { method: 'POST', headers: options.headers ?? headers(), body: typeof body === 'string' ? body : new Uint8Array(body) });
  assert.equal(response.status, options.status ?? 400); assert.deepEqual(await snapshot(f), before);
  return response;
}
it('posts original UTF-8 event bytes verbatim, uses configured webhook ID, then confirms once', async () => {
  const f = await fixture(); const raw = Buffer.from(` {\n "id" : "${f.event.id}", "event_type":"PAYMENT.CAPTURE.COMPLETED", "note":"\\u00a3 £", "number":1.00, "resource":${JSON.stringify(f.event.resource)}\n } `);
  const response = await localFetch(url, { method: 'POST', headers: headers(), body: raw }); assert.equal(response.status, 200);
  assert.equal(calls.length, 2); assert.equal(calls[0].url, `${sandbox}/v1/oauth2/token`);
  const sent = calls[1].init!.body as Buffer; assert.ok(Buffer.isBuffer(sent));
  const prefix = Buffer.from('"webhook_event":'); const at = sent.indexOf(prefix) + prefix.length;
  assert.deepEqual(sent.subarray(at, -1), raw);
  const parsed = JSON.parse(sent.toString()); assert.equal(parsed.webhook_id, config.PAYPAL_WEBHOOK_ID); assert.deepEqual(parsed.webhook_event, JSON.parse(raw.toString()));
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'SUCCEEDED');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'CONFIRMED');
  assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 1);
});
for (const key of ['paypal-auth-algo','paypal-cert-url','paypal-transmission-id','paypal-transmission-sig','paypal-transmission-time']) it(`missing ${key} rejects before provider calls and all persistence`, async () => {
  const f = await fixture(), h: Record<string,string> = headers(); delete h[key]; await rejectWithoutMutation(f, { headers: h }); assert.equal(calls.length, 0);
});
for (const [key, value] of [
  ['paypal-auth-algo','SHA1withRSA'], ['paypal-auth-algo','SHA256withRSA,SHA256withRSA'],
  ['paypal-transmission-id','12345'], ['paypal-transmission-id','x'.repeat(51)], ['paypal-transmission-id','bad id'],
  ['paypal-transmission-sig','not base64'], ['paypal-transmission-sig','A==='], ['paypal-transmission-sig','A'.repeat(504)],
  ['paypal-transmission-time','yesterday'], ['paypal-transmission-time','2026-02-30T00:00:00Z'],
  ['paypal-cert-url','http://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1'],
  ['paypal-cert-url','https://api-m.sandbox.paypal.com.attacker.invalid/v1/notifications/certs/CERT-1'],
  ['paypal-cert-url','https://127.0.0.1/v1/notifications/certs/CERT-1'],
  ['paypal-cert-url','https://api-m.sandbox.paypal.com@attacker.invalid/v1/notifications/certs/CERT-1'],
  ['paypal-cert-url','https://api-m.sandbox.paypal.com:444/v1/notifications/certs/CERT-1'],
  ['paypal-cert-url','https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1?redirect=secret'],
  ['paypal-cert-url','https://api-m.sandbox.paypal.com/v1/notifications/certs/../CERT-1'],
  ['paypal-cert-url','https://api-m.sandbox.paypal.com/v1/notifications/certs/CERT-1#secret'],
  ['paypal-cert-url','https://api-m.paypal.com/v1/notifications/certs/CERT-1'],
]) it(`malformed/untrusted ${key}: ${value} is fail-closed`, async () => {
  const f = await fixture(); await rejectWithoutMutation(f, { headers: { ...headers(), [key]: value } }); assert.equal(calls.length, 0);
});
for (const base of ['https://attacker.invalid', 'http://api-m.sandbox.paypal.com', `${sandbox}/path`, `${sandbox}?query=1`, 'https://user:pass@api-m.sandbox.paypal.com', 'https://api-m.sandbox.paypal.com:444']) it(`untrusted configured API origin ${base} is unavailable without sending credentials`, async () => {
  const f = await fixture(); config.PAYPAL_BASE_URL = base; await rejectWithoutMutation(f, { status: 503 }); assert.equal(calls.length, 0);
});
for (const key of ['PAYPAL_WEBHOOK_ID','PAYPAL_CLIENT_ID','PAYPAL_CLIENT_SECRET'] as const) it(`missing ${key} is unavailable without provider calls`, async () => {
  const f = await fixture(); config[key] = undefined; await rejectWithoutMutation(f, { status: 503 }); assert.equal(calls.length, 0);
});
it('malformed configured webhook ID rejects before credentials leave the API', async () => { const f = await fixture(); config.PAYPAL_WEBHOOK_ID = 'bad webhook'; await rejectWithoutMutation(f, { status: 503 }); assert.equal(calls.length, 0); });
it('a syntactically valid but wrong webhook ID cannot authorize an event', async () => {
  const f = await fixture(); config.PAYPAL_WEBHOOK_ID = 'WRONGWEBHOOK';
  globalThis.fetch = async (_input, init) => new Response(JSON.stringify(typeof init?.body === 'string' ? { access_token: 'synthetic' } : { verification_status: JSON.parse((init?.body as Buffer).toString()).webhook_id === 'SYNTHETICWEBHOOK1' ? 'SUCCESS' : 'FAILURE' }));
  await rejectWithoutMutation(f);
});
for (const host of ['api-m.paypal.com','api.paypal.com','api-m.sandbox.paypal.com','api.sandbox.paypal.com']) it(`official API/certificate environment pairing ${host} verifies without NODE_ENV inference`, async () => {
  const f = await fixture(); config.PAYPAL_BASE_URL = `https://${host}`;
  const response = await localFetch(url, { method: 'POST', headers: { ...headers(), 'paypal-cert-url': `https://${host}/v1/notifications/certs/CERT-synthetic` }, body: JSON.stringify({ ...f.event, event_type: 'CUSTOMER.DISPUTE.CREATED', resource: { dispute_id: 'D', disputed_transactions: [{ seller_transaction_id: f.payment.providerCaptureReference }] } }) });
  assert.equal(response.status, 200); assert.equal(calls.length, 2);
});
it('live API with a sandbox certificate is rejected without a provider request', async () => { const f = await fixture(); config.PAYPAL_BASE_URL = 'https://api-m.paypal.com'; await rejectWithoutMutation(f); assert.equal(calls.length, 0); });
for (const body of ['{bad', 'null', '[]', '42', '"event"', '', Buffer.from([0x7b,0x22,0xc0,0xaf,0x22,0x3a,0x31,0x7d])]) it(`malformed/non-object JSON ${JSON.stringify(body)} never reaches verification or persistence`, async () => {
  const f = await fixture(); await rejectWithoutMutation(f, { body }); assert.equal(calls.length, 0);
});
for (const type of ['text/plain','application/x-www-form-urlencoded','application/json; charset=utf-16']) it(`unsupported ${type} is rejected before provider calls`, async () => { const f = await fixture(); await rejectWithoutMutation(f, { headers: { ...headers(), 'content-type': type }, status: 415 }); assert.equal(calls.length, 0); });
it('compressed JSON is rejected rather than changing the signed bytes', async () => { const f = await fixture(); await rejectWithoutMutation(f, { headers: { ...headers(), 'content-encoding': 'gzip' }, body: gzipSync(JSON.stringify(f.event)), status: 415 }); assert.equal(calls.length, 0); });
it('oversized bodies are rejected with a sanitized response', async () => { const f = await fixture(); await rejectWithoutMutation(f, { body: 'x'.repeat(102401), status: 413 }); assert.equal(calls.length, 0); });
for (const result of [{ verification_status: 'FAILURE' }, { verification_status: 'success' }, {}, null, [], { verification_status: true }]) it(`verification response ${JSON.stringify(result)} never authorizes effects`, async () => {
  const f = await fixture(); provider(result); await rejectWithoutMutation(f, { status: (result as any)?.verification_status === 'FAILURE' ? 400 : 503 });
});
for (const phase of ['auth','verify'] as const) for (const failure of ['401','500','redirect','connection','json'] as const) it(`${phase} ${failure} returns sanitized retryable failure with no mutations`, async () => {
  const f = await fixture(); let n = 0;
  globalThis.fetch = async (_input, init) => {
    n++; assert.equal(init?.redirect, 'error');
    if (phase === 'verify' && n === 1) return new Response('{"access_token":"synthetic"}');
    if (failure === 'connection' || failure === 'redirect') throw Error('synthetic-secret-sensitive-payload');
    return new Response(failure === 'json' ? 'invalid json synthetic-secret' : '{}', { status: failure === '401' ? 401 : failure === '500' ? 500 : 200 });
  };
  const response = await rejectWithoutMutation(f, { status: 503 }); assert.equal((await response.text()).includes('synthetic-secret'), false);
});
for (const auth of [{}, { access_token: 123 }, { access_token: '' }, { access_token: 'bad\r\ntoken' }]) it(`malformed authentication response ${JSON.stringify(auth)} prevents signature postback`, async () => {
  const f = await fixture(); globalThis.fetch = async (input, init) => { calls.push({ url: String(input), init }); return new Response(JSON.stringify(auth)); };
  await rejectWithoutMutation(f, { status: 503 }); assert.equal(calls.length, 1);
});
for (const phase of ['auth-fetch','auth-body','verify-fetch','verify-body'] as const) it(`${phase} timeout bounds the complete handshake and creates no effects`, async t => {
  const f = await fixture(), before = await snapshot(f); let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; }); const never = new Promise<never>(() => {}); let n = 0;
  globalThis.fetch = async (_input, init) => {
    calls.push({ url: String(_input), init }); n++;
    if ((phase.startsWith('auth') && n === 1) || (phase.startsWith('verify') && n === 2)) {
      entered(); if (phase.endsWith('fetch')) return never;
      return { status: 200, json: () => never } as unknown as Response;
    }
    return new Response('{"access_token":"synthetic"}');
  };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const out: { status?: number; body?: unknown } = {};
  const res = { status(code: number) { out.status = code; return this; }, json(body: unknown) { out.body = body; return this; } };
  const pending = paypalWebhookHandler({ body: Buffer.from(JSON.stringify(f.event)), headers: headers(), rawHeaders: [] } as any, res as any);
  await ready; t.mock.timers.tick(PAYPAL_WEBHOOK_VERIFICATION_TIMEOUT_MS); await pending; t.mock.timers.reset();
  assert.equal(out.status, 503); assert.deepEqual(out.body, { error: 'Webhook verification unavailable' });
  assert.ok(calls.every(c => c.init!.signal!.aborted)); assert.deepEqual(await snapshot(f), before);
});
it('duplicate signature headers on the wire cannot be selected or combined into a valid verification', async () => {
  const f = await fixture(), before = await snapshot(f); const h = headers(); const rawHeaders = Object.entries(h).flat(); rawHeaders.push('PayPal-Transmission-Id', 'other-transmission');
  const status = await new Promise<number>((resolve, reject) => { const req = request(url, { method: 'POST', headers: rawHeaders }, res => { res.resume(); resolve(res.statusCode!); }); req.on('error', reject); req.end(JSON.stringify(f.event)); });
  assert.equal(status, 400); assert.equal(calls.length, 0); assert.deepEqual(await snapshot(f), before);
});
it('invalid verification for capture, refund and dispute payloads never creates any verified inbox or financial effect', async () => {
  const f = await fixture(); provider({ verification_status: 'FAILURE' });
  for (const event_type of ['PAYMENT.CAPTURE.COMPLETED','PAYMENT.CAPTURE.REFUNDED','CUSTOMER.DISPUTE.CREATED','CHECKOUT.PAYMENT-APPROVAL.REVERSED']) await rejectWithoutMutation(f, { body: JSON.stringify({ ...f.event, event_type }) });
});
it('verified duplicate, replayed and concurrent deliveries retain one inbox event and one confirmation', async () => {
  const f = await fixture(); const send = () => localFetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(f.event) });
  const responses = await Promise.all(Array.from({ length: 5 }, send)); assert.ok(responses.every(r => r.status === 200)); assert.equal((await send()).status, 200);
  assert.equal(await prisma.paymentWebhookEvent.count({ where: { provider: 'PAYPAL', providerEventId: f.event.id } }), 1);
  assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 1);
  assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.listing.id, type: 'WEBSITE_SALE' } }), 1);
  const stock = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } }); assert.equal(stock.currentStock, 3); assert.equal(stock.reservedStock, 0);
  assert.equal(await prisma.refund.count({ where: { paymentId: f.payment.id } }), 0);
});
it('verification outage retains no inbox work and redelivery succeeds after provider recovery', async () => {
  const f = await fixture(); globalThis.fetch = async () => { throw Error('synthetic outage'); };
  await rejectWithoutMutation(f, { status: 503 }); provider();
  const response = await localFetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(f.event) });
  assert.equal(response.status, 200);
  assert.equal(await prisma.paymentWebhookEvent.count({ where: { provider: 'PAYPAL', providerEventId: f.event.id } }), 1);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'SUCCEEDED');
});
it('verification failures and raw parser errors do not log credentials, signatures or payloads', async t => {
  const entries: unknown[][] = [];
  for (const method of ['info','warn','error','log'] as const) t.mock.method(console, method, (...args: unknown[]) => { entries.push(args); });
  const f = await fixture(); globalThis.fetch = async () => { throw Error('synthetic-secret-sensitive-payload'); };
  await rejectWithoutMutation(f, { status: 503 });
  await rejectWithoutMutation(f, { headers: { ...headers(), 'content-encoding': 'gzip' }, body: gzipSync('sensitive-payload'), status: 415 });
  assert.deepEqual(entries, []);
});

it('invalid signatures cannot finalize an existing pending refund or consume its reserved capacity', async () => {
  const f = await fixture();
  assert.equal((await localFetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(f.event) })).status, 200);
  const reference = `REF-${randomUUID()}`;
  const refund = await createOrReusePayPalRefund(f.order.id, f.payment.id, 10, undefined, f.order.userId,
    { refundCapture: async () => ({ id: reference, status: 'PENDING', amount: { value: '10.00', currency_code: 'GBP' } }) }, undefined, randomUUID());
  assert.equal(refund.status, 'PROCESSING');
  provider({ verification_status: 'FAILURE' });
  await rejectWithoutMutation(f, { body: JSON.stringify({ id: randomUUID(), event_type: 'PAYMENT.CAPTURE.REFUNDED', resource: {
    id: reference, status: 'COMPLETED', custom_id: `cl-refund-${refund.id}`, amount: { value: '10.00', currency_code: 'GBP' },
    links: [{ rel: 'up', href: `${sandbox}/v2/payments/captures/${f.payment.providerCaptureReference}` }],
  } }) });
  assert.equal((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status, 'PROCESSING');
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  assert.equal(payment.reservedRefundAmount.toFixed(2), '10.00'); assert.equal(payment.refundedAmount.toFixed(2), '0.00');
});
