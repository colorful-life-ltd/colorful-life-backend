import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, it } from 'node:test';
import type { Server } from 'node:http';
import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import app from '../app.js';
import { config } from '../config/index.js';
import { prisma } from '../prisma/runtime.js';
import { stagingLimits } from '../domain/security/paymentAbuse.js';
import { createRefreshSession } from '../domain/auth/refreshSessionService.js';
import { createOrReusePayPalOrder } from '../domain/payments/paypalOrderService.js';
import { capturePayPalOrder } from '../domain/payments/paypalCaptureService.js';
import { validateAbuseStartup } from '../config/paymentAbuse.js';

const saved = { ...config }, proxy = app.get('trust proxy');
let server: Server, url: string;
const users: number[] = [], orders: number[] = [];
before(async () => { server = app.listen(0); await new Promise<void>(r => server.once('listening', r)); url = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
after(async () => { server.close(); await prisma.$disconnect(); });
beforeEach(async () => {
  config.PAYMENT_ABUSE_HMAC_SECRET = 'synthetic-194-remediation-shared-secret';
  config.PAYMENT_ABUSE_LIMITS_JSON = undefined;
  config.PAYMENT_RESOLUTION_ENABLED = false;
  config.PAYMENT_STRIPE_INITIATION_ENABLED = config.PAYMENT_PAYPAL_INITIATION_ENABLED = true;
  await prisma.$executeRaw`DELETE FROM "AbuseBucket"`;
});
afterEach(async () => {
  Object.assign(config, saved); app.set('trust proxy', proxy);
  if (orders.length) await prisma.order.deleteMany({ where: { id: { in: orders.splice(0) } } });
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users.splice(0) } } });
  await prisma.$executeRaw`DELETE FROM "AbuseBucket"`;
});
async function user() {
  const u = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: await bcrypt.hash('Correct1!Password', 4), emailVerified: true } }); users.push(u.id); return u;
}
function post(path: string, body: object, ip?: string) { return fetch(url+path, { method: 'POST', headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, 'Content-Type': 'application/json', ...(ip ? { 'X-Forwarded-For': ip } : {}) }, body: JSON.stringify(body) }); }
function overrides(value: Partial<typeof stagingLimits>) { config.PAYMENT_ABUSE_LIMITS_JSON = JSON.stringify({ ...stagingLimits, ...value }); }

it('a known email cannot be remotely locked by hostile passwords from many IPs', async () => {
  app.set('trust proxy', 'loopback'); const u = await user(); overrides({ loginNetwork: [2, 900] });
  for (let n = 1; n <= 20; n++) {
    const response = await post('/auth/login', { email: u.email, password: 'Wrong1!Password' }, `192.0.2.${n}`);
    assert.equal(response.status, 401); assert.equal((await response.json()).error.code, 'INVALID_CREDENTIALS');
  }
  const response = await post('/auth/login', { email: u.email, password: 'Correct1!Password' }, '198.51.100.1');
  assert.equal(response.status, 200); assert.ok((await response.json()).refreshToken);
});
it('keeps network brute-force resistance and uses identical missing-account/wrong-password errors', async () => {
  const u = await user(); overrides({ loginNetwork: [2, 900] });
  const wrong = await post('/auth/login', { email: u.email, password: 'Wrong1!Password' });
  const absent = await post('/auth/login', { email: 'missing@example.test', password: 'Wrong1!Password' });
  assert.equal(wrong.status, 401); assert.equal(absent.status, 401); assert.deepEqual(await wrong.json(), await absent.json());
  assert.equal((await post('/auth/login', { email: u.email, password: 'Wrong1!Password' })).status, 429);
});
it('many legitimate sessions behind one IP refresh even when login network admission is exhausted', async () => {
  overrides({ loginNetwork: [1, 900], refreshSession: [2, 900] });
  assert.equal((await post('/auth/login', {})).status, 400); assert.equal((await post('/auth/login', {})).status, 429);
  for (let i = 0; i < 5; i++) {
    const u = await user(), session = await createRefreshSession(u.id);
    assert.equal((await post('/auth/refresh', { refreshToken: session.refreshToken })).status, 200);
  }
});
it('rotation cannot reset the stable session budget, another session is unaffected, and denied tokens remain usable after refill', async () => {
  overrides({ refreshSession: [1, 900] }); const u = await user(), a = await createRefreshSession(u.id), b = await createRefreshSession(u.id);
  const first = await post('/auth/refresh', { refreshToken: a.refreshToken }); assert.equal(first.status, 200); const replacement = (await first.json()).refreshToken;
  const denied = await post('/auth/refresh', { refreshToken: replacement }); assert.equal(denied.status, 429);
  assert.equal((await post('/auth/refresh', { refreshToken: b.refreshToken })).status, 200);
  assert.equal((await post('/auth/refresh', { refreshToken: a.refreshToken })).status, 401);
  await prisma.$executeRaw`UPDATE "AbuseBucket" SET "updatedAt"=clock_timestamp()-interval '1 hour'`;
  assert.equal((await post('/auth/refresh', { refreshToken: replacement })).status, 200);
});
it('invalid refresh tokens cannot spend or create valid-session admission state', async () => {
  const u = await user(), a = await createRefreshSession(u.id);
  for (let n = 0; n < 4; n++) assert.equal((await post('/auth/refresh', { refreshToken: randomUUID().replaceAll('-', '').padEnd(43, 'x') })).status, 401);
  assert.equal((await prisma.$queryRaw<any[]>`SELECT * FROM "AbuseBucket"`).length, 0);
  assert.equal((await post('/auth/refresh', { refreshToken: a.refreshToken })).status, 200);
});
it('concurrent refreshes still rotate once without double-spending session allowance', async () => {
  const u = await user(), a = await createRefreshSession(u.id);
  const results = await Promise.all([post('/auth/refresh', { refreshToken: a.refreshToken }), post('/auth/refresh', { refreshToken: a.refreshToken })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
  assert.equal((await prisma.$queryRaw<any[]>`SELECT * FROM "AbuseBucket"`).length, 1);
});
it('PayPal create and capture are one progressive attempt while operation caps and capture idempotency remain independent', async () => {
  const u = await user(); overrides({ challengeAfter: [1, 900] });
  async function order() {
    const o = await prisma.order.create({ data: { userId: u.id, totalAmount: 12.50, reservationExpiresAt: new Date(Date.now()+1800000), billingRecipientName: 'Test', billingLine1: '1 Test St', billingCity: 'London', billingPostcode: 'T1', billingCountryCode: 'GB', deliveryRecipientName: 'Test', deliveryLine1: '1 Test St', deliveryCity: 'London', deliveryPostcode: 'T1', deliveryCountryCode: 'GB' } }); orders.push(o.id); return o;
  }
  const o = await order(); let creates = 0, captures = 0;
  await createOrReusePayPalOrder(o.id, u.id, { createOrder: async () => { creates++; return { id: 'PP-'+randomUUID() }; } });
  const client = { captureOrder: async (id: string) => { captures++; return { id, status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP-'+randomUUID(), status: 'COMPLETED', amount: { value: '12.50', currency_code: 'GBP' } }] } }] }; } };
  const first = await capturePayPalOrder(o.id, u.id, client); assert.equal((await capturePayPalOrder(o.id, u.id, client)).captureId, first.captureId);
  assert.equal(creates, 1); assert.equal(captures, 1);
  const [count] = await prisma.$queryRaw<any[]>`SELECT count(*)::int AS operations, count(DISTINCT "attemptIdentity")::int AS attempts FROM "PaymentAdmission" WHERE "orderId"=${o.id}`;
  assert.deepEqual(count, { operations: 2, attempts: 1 });
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { orderId: o.id } })).status, 'SUCCEEDED');
  const next = await order();
  await assert.rejects(createOrReusePayPalOrder(next.id, u.id, { createOrder: async () => { throw new Error('Must not call'); } }), (e: any) => e.code === 'CHECKOUT_CHALLENGE_REQUIRED');
  assert.equal(await prisma.payment.count({ where: { orderId: next.id } }), 0);
});
it('new foreign keys match Prisma CASCADE updates and deletes', async () => {
  const rows = await prisma.$queryRaw<any[]>`SELECT conname, confupdtype::text AS confupdtype, confdeltype::text AS confdeltype FROM pg_constraint WHERE conname IN ('PaymentAdmission_orderId_fkey','PaymentFulfilmentReview_orderId_fkey')`;
  assert.equal(rows.length, 2); for (const row of rows) { assert.equal(row.confupdtype, 'c'); assert.equal(row.confdeltype, 'c'); }
});

const valid = { PAYMENT_ABUSE_HMAC_SECRET: 'synthetic-shared-secret-at-least-32-chars', CLIENT_IP_MODE: 'direct' };
for (const [name, value] of Object.entries({ missingSecret: { ...valid, PAYMENT_ABUSE_HMAC_SECRET: undefined }, shortSecret: { ...valid, PAYMENT_ABUSE_HMAC_SECRET: 'secret-do-not-log' }, badLimits: { ...valid, PAYMENT_ABUSE_LIMITS_JSON: '{bad-sensitive' }, unknownLimit: { ...valid, PAYMENT_ABUSE_LIMITS_JSON: '{"loginEmail":[10,900]}' }, missingMode: { ...valid, CLIENT_IP_MODE: undefined }, missingProxy: { ...valid, CLIENT_IP_MODE: 'proxy' }, broadProxy: { ...valid, CLIENT_IP_MODE: 'proxy', TRUSTED_PROXY_CIDRS: '0.0.0.0/0' } })) {
  it(`fails startup safely for ${name}`, () => {
    assert.throws(() => validateAbuseStartup(value, 'production'), (error: any) => !error.message.includes('secret-do-not-log') && !error.message.includes('{bad-sensitive'));
  });
}
it('accepts explicit direct/proxy deployment modes and valid staging overrides', () => {
  validateAbuseStartup(valid, 'production'); validateAbuseStartup({ ...valid, CLIENT_IP_MODE: 'proxy', TRUSTED_PROXY_CIDRS: '10.0.0.0/16', PAYMENT_ABUSE_LIMITS_JSON: '{"provider":[100,900]}' }, 'production');
});
it('actual production config import exits before serving requests on missing abuse configuration without leaking values', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DEPLOYMENT_ENVIRONMENT:'production', STRIPE_SECRET_KEY:'sk_live_synthetic_never_used', JWT_SECRET:'a09e462f543750f8a1774512f9926a3c49265a850924163f8092620956ade87e9', FRONTEND_URL:'https://shop.colorful-life.co.uk',CORS_ALLOWED_ORIGINS:'https://shop.colorful-life.co.uk',SES_FROM_EMAIL:'no-reply@colorful-life.co.uk',PAYMENT_RESOLUTION_ENABLED:'true',PAYPAL_BASE_URL:'https://api-m.paypal.com', DATABASE_URL: 'postgresql://unused@127.0.0.1:1/never_connect', CLIENT_IP_MODE: 'direct' };
  delete env.PAYMENT_ABUSE_HMAC_SECRET; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import("./dist/config/index.js")'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.match(result.stderr, /PAYMENT_ABUSE_HMAC_SECRET/);
});

for (const [name, override, expected] of [
  ['malformed limits', { PAYMENT_ABUSE_LIMITS_JSON: '{sensitive-invalid-input' }, 'PAYMENT_ABUSE_LIMITS_JSON'],
  ['missing proxy mode', { CLIENT_IP_MODE: undefined }, 'CLIENT_IP_MODE'],
  ['proxy without trusted ranges', { CLIENT_IP_MODE: 'proxy', TRUSTED_PROXY_CIDRS: undefined }, 'TRUSTED_PROXY_CIDRS'],
] as const) it(`production import fails fast for ${name} with sanitized output`, () => {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DEPLOYMENT_ENVIRONMENT:'production', STRIPE_SECRET_KEY:'sk_live_synthetic_never_used', JWT_SECRET:'a09e462f543750f8a1774512f9926a3c49265a850924163f8092620956ade87e9', FRONTEND_URL:'https://shop.colorful-life.co.uk',CORS_ALLOWED_ORIGINS:'https://shop.colorful-life.co.uk',SES_FROM_EMAIL:'no-reply@colorful-life.co.uk',PAYMENT_RESOLUTION_ENABLED:'true',PAYPAL_BASE_URL:'https://api-m.paypal.com', DATABASE_URL: 'postgresql://unused@127.0.0.1:1/never_connect', CLIENT_IP_MODE: 'direct', ...override };
  delete env.NODE_TEST_CONTEXT;
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', 'await import("./dist/config/index.js")'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1); assert.ok(result.stderr.includes(expected)); assert.ok(!result.stderr.includes('sensitive-invalid-input'));
});
it('production imports default both provider switches off and only explicit flags enable them', () => {
  for (const enable of [false, true]) {
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'production', DEPLOYMENT_ENVIRONMENT:'production', STRIPE_SECRET_KEY:'sk_live_synthetic_never_used', JWT_SECRET:'a09e462f543750f8a1774512f9926a3c49265a850924163f8092620956ade87e9', FRONTEND_URL:'https://shop.colorful-life.co.uk',CORS_ALLOWED_ORIGINS:'https://shop.colorful-life.co.uk',SES_FROM_EMAIL:'no-reply@colorful-life.co.uk',PAYMENT_RESOLUTION_ENABLED:'true',PAYPAL_BASE_URL:'https://api-m.paypal.com', DATABASE_URL: 'postgresql://unused@127.0.0.1:1/never_connect', CLIENT_IP_MODE: 'direct' };
    delete env.NODE_TEST_CONTEXT; delete env.PAYMENT_STRIPE_INITIATION_ENABLED; delete env.PAYMENT_PAYPAL_INITIATION_ENABLED;
    if (enable) { env.STRIPE_SECRET_KEY='sk_live_synthetic_never_used';env.STRIPE_WEBHOOK_SECRET='whsec_synthetic_never_used';env.PAYPAL_CLIENT_ID='synthetic-never-used'; env.PAYMENT_STRIPE_INITIATION_ENABLED = 'true'; env.PAYMENT_PAYPAL_INITIATION_ENABLED = 'true'; }
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `const {config}=await import('./dist/config/index.js');if(config.PAYMENT_STRIPE_INITIATION_ENABLED!==${enable}||config.PAYMENT_PAYPAL_INITIATION_ENABLED!==${enable})process.exit(2)`], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});
