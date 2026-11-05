import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import jwt from 'jsonwebtoken';
import { prisma } from '../prisma/runtime.js';
import app from '../app.js';
import { config } from '../config/index.js';
import { paypalRefundClient } from '../domain/refunds/paypalRefundService.js';

// Stripe is the only customer payment provider. These regressions pin that the retired PayPal
// paths cannot be reached or reopened, while historical PayPal records stay readable.
let server: ReturnType<typeof app.listen>, url = '';
before(async () => { server = app.listen(0); await new Promise<void>(r => server.once('listening', r)); url = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
after(async () => { await new Promise<void>(r => server.close(() => r())); await prisma.$disconnect(); });
const user = (role: 'ADMIN' | 'CUSTOMER') => prisma.user.create({ data: { email: `${randomUUID()}@paypal-retirement.test`, passwordHash: 'synthetic', role, emailVerified: true } });
const bearer = (u: { id: number; role: string }) => ({ Authorization: `Bearer ${jwt.sign({ id: u.id, role: u.role }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' });
const address = { billingRecipientName: 'A', billingLine1: '1 Road', billingCity: 'London', billingPostcode: 'SW1A 1AA', billingCountryCode: 'GB',
  deliveryRecipientName: 'A', deliveryLine1: '1 Road', deliveryCity: 'London', deliveryPostcode: 'SW1A 1AA', deliveryCountryCode: 'GB' } as const;

it('no PayPal initiation setting exists, and an environment value for it is ignored', () => {
  assert.equal('PAYMENT_PAYPAL_INITIATION_ENABLED' in config, false);
});

it('an Administrator cannot write a PayPal initiation policy, and Admin always sees PayPal disabled', async () => {
  const admin = await user('ADMIN'), headers = bearer(admin);
  const before = await prisma.paymentInitiationPolicy.findMany({ orderBy: { provider: 'asc' } });
  const refused = await fetch(`${url}/admin/payment-security/providers/PAYPAL`, { method: 'POST', headers,
    body: JSON.stringify({ enabled: true, capacity: null, note: 'Attempt to reopen a retired provider' }) });
  assert.equal(refused.status, 400);
  assert.deepEqual(await prisma.paymentInitiationPolicy.findMany({ orderBy: { provider: 'asc' } }), before);
  const read = await fetch(`${url}/admin/payment-security`, { headers });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).environmentEnabled.PAYPAL, false);
});

it('a historical PayPal payment stays readable but cannot be refunded or paid again', async () => {
  const customer = await user('CUSTOMER'), admin = await user('ADMIN');
  const order = await prisma.order.create({ data: { userId: customer.id, totalAmount: 20, status: 'CONFIRMED', ...address } });
  const payment = await prisma.payment.create({ data: { orderId: order.id, amount: 20, provider: 'PAYPAL', status: 'SUCCEEDED', paidAt: new Date('2026-10-20T12:00:00Z'),
    providerReference: `ORDER-${randomUUID()}`, providerCaptureReference: `CAP-${randomUUID()}` } });
  const snapshot = () => prisma.payment.findUniqueOrThrow({ where: { id: payment.id }, include: { refunds: true } });
  const original = await snapshot();
  // Read paths: the Administrator payment list and the customer's own order both still load.
  const listed = await fetch(`${url}/orders/${order.id}/payments`, { headers: bearer(admin) });
  assert.equal(listed.status, 200);
  assert.ok(JSON.stringify(await listed.json()).includes('PAYPAL'));
  const detail = await fetch(`${url}/orders/${order.id}`, { headers: bearer(customer) });
  assert.equal(detail.status, 200);
  // No new PayPal refund, and no PayPal payment route.
  const refund = await fetch(`${url}/orders/${order.id}/refunds`, { method: 'POST', headers: { ...bearer(admin), 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ paymentId: payment.id, amount: 5, reason: 'Retired provider refund attempt' }) });
  assert.equal(refund.status, 503);
  for (const path of ['paypal', 'paypal/capture']) {
    const response = await fetch(`${url}/orders/${order.id}/payments/${path}`, { method: 'POST', headers: bearer(customer) });
    assert.equal(response.status, 404);
  }
  assert.deepEqual(await snapshot(), original);
});

it('the runtime PayPal refund client can only retrieve, never submit', () => {
  const saved = [config.PAYPAL_CLIENT_ID, config.PAYPAL_CLIENT_SECRET];
  try {
    config.PAYPAL_CLIENT_ID = 'synthetic-historical-client'; config.PAYPAL_CLIENT_SECRET = 'synthetic-historical-secret';
    assert.deepEqual(Object.keys(paypalRefundClient()), ['retrieveRefund']);
  } finally { [config.PAYPAL_CLIENT_ID, config.PAYPAL_CLIENT_SECRET] = saved; }
});

it('retired PayPal admission cannot be opened outside automated tests', () => {
  const moduleUrl = new URL('../domain/security/paymentAbuse.js', import.meta.url).href;
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', DATABASE_URL: 'postgresql://unused@127.0.0.1:1/never_connect',
    JWT_SECRET: 'synthetic-jwt', PAYMENT_ABUSE_HMAC_SECRET: 'synthetic-shared-abuse-secret-at-least-32', CLIENT_IP_MODE: 'direct', PAYMENT_PAYPAL_INITIATION_ENABLED: 'true' };
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m=await import(${JSON.stringify(moduleUrl)});try{m.allowRetiredPayPalAdmissionForTests();process.exit(3)}catch{process.exit(0)}`],
    { env, encoding: 'utf8', timeout: 10_000, cwd: new URL('../../', import.meta.url).pathname });
  assert.equal(child.status, 0, child.stderr);
});

it('no application module imports the retired PayPal fixtures', () => {
  const root = new URL('../', import.meta.url).pathname;
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === '__tests__' || name === 'testing' ? [] : files(path)) : path.endsWith('.js') ? [path] : [];
  });
  const offenders = files(root).filter(path => /fixtures\/retiredPayPal|\/paypalOrderService\.js|\/paypalCaptureService\.js|\/paypalPaymentController\.js|\/paypalSandbox\.js/.test(readFileSync(path, 'utf8')));
  assert.deepEqual(offenders, []);
});

it('a deployed (non-test) process never admits PayPal, even with every legacy flag set', () => {
  const moduleUrl = new URL('../domain/security/paymentAbuse.js', import.meta.url).href;
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', DATABASE_URL: 'postgresql://unused@127.0.0.1:1/never_connect',
    JWT_SECRET: 'synthetic-jwt', PAYMENT_ABUSE_HMAC_SECRET: 'synthetic-shared-abuse-secret-at-least-32', CLIENT_IP_MODE: 'direct', PAYMENT_PAYPAL_INITIATION_ENABLED: 'true' };
  // policy() refuses before its query when the provider is closed, so a stub transaction suffices.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m=await import(${JSON.stringify(moduleUrl)});const tx={$queryRaw:async()=>[{enabled:true,capacity:null}]};
     try{await m.policy(tx,'PAYPAL');process.exit(3)}catch(e){process.exit(e?.code==='PAYMENT_INITIATION_DISABLED'?0:4)}`],
    { env, encoding: 'utf8', timeout: 10_000, cwd: new URL('../../', import.meta.url).pathname });
  assert.equal(child.status, 0, child.stderr);
});
