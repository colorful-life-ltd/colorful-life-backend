import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { prisma } from '../prisma/runtime.js';
import app from '../app.js';
import { config } from '../config/index.js';
import { providerFinancialHold } from '../domain/payments/providerFinancialGuard.js';

// Stripe is the only payment provider. PayPal application code is removed. The schema follows
// expand/deploy/contract: this release keeps the PAYPAL enum values and review columns so the
// previous image can still run (rollback), and prisma/contract/remove_paypal.sql removes them later.
let server: ReturnType<typeof app.listen>, url = '';
before(async () => { server = app.listen(0); await new Promise<void>(r => server.once('listening', r)); url = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
after(async () => { await new Promise<void>(r => server.close(() => r())); await prisma.$disconnect(); });
const bearer = (id: number, role: string) => ({ Authorization: `Bearer ${jwt.sign({ id, role }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' });
const repository = new URL('../../', import.meta.url).pathname;
const contractSql = () => readFileSync(join(repository, 'prisma/contract/remove_paypal.sql'), 'utf8');
const user = (role: 'ADMIN' | 'CUSTOMER') => prisma.user.create({ data: { email: `${randomUUID()}@paypal-removal.test`, passwordHash: 'synthetic', role, emailVerified: true } });
const address = { billingRecipientName: 'A', billingLine1: '1 Road', billingCity: 'London', billingPostcode: 'SW1A 1AA', billingCountryCode: 'GB',
  deliveryRecipientName: 'A', deliveryLine1: '1 Road', deliveryCity: 'London', deliveryPostcode: 'SW1A 1AA', deliveryCountryCode: 'GB' } as const;
async function withClient<T>(work: (client: pg.Client) => Promise<T>) {
  const client = new pg.Client({ connectionString: config.DATABASE_URL }); await client.connect();
  try { return await work(client); } finally { await client.query('ROLLBACK').catch(() => undefined); await client.end(); }
}

it('every former PayPal route is gone', async () => {
  const admin = await user('ADMIN');
  for (const [method, path] of [['POST', '/payments/paypal/webhook'], ['GET', '/admin/paypal/webhook-reviews?afterId=0'],
    ['POST', '/admin/paypal/webhook-reviews/1/acknowledge'], ['POST', '/orders/1/payments/paypal'], ['POST', '/orders/1/payments/paypal/capture']] as const) {
    const response = await fetch(url + path, { method, headers: bearer(admin.id, 'ADMIN'), ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(response.status, 404, `${method} ${path}`);
  }
  const policy = await fetch(`${url}/admin/payment-security/providers/PAYPAL`, { method: 'POST', headers: bearer(admin.id, 'ADMIN'),
    body: JSON.stringify({ enabled: true, capacity: null, note: 'Attempt to configure a removed provider' }) });
  assert.equal(policy.status, 400);
  const security = await (await fetch(`${url}/admin/payment-security`, { headers: bearer(admin.id, 'ADMIN') })).json();
  assert.deepEqual(security.environmentEnabled, { STRIPE: config.PAYMENT_STRIPE_INITIATION_ENABLED });
});

it('this release changes no schema: everything the previous image reads is kept until the contract migration', async () => {
  const enums = await prisma.$queryRaw<Array<{ type: string; labels: string[] }>>`SELECT t.typname AS type, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
    FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname IN ('PaymentProvider','RefundProvider') GROUP BY t.typname ORDER BY t.typname`;
  assert.deepEqual(enums, [{ type: 'PaymentProvider', labels: ['MANUAL', 'STRIPE', 'PAYPAL'] }, { type: 'RefundProvider', labels: ['MANUAL', 'STRIPE', 'PAYPAL'] }]);
  const [state] = await prisma.$queryRaw<Array<{ triggers: number; reviewColumns: number; policies: number }>>`SELECT
    (SELECT count(*)::int FROM pg_trigger WHERE tgname='paypal_capture_admission') AS triggers,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='PaymentWebhookEvent' AND column_name IN ('reviewDetails','reviewedAt')) AS "reviewColumns",
    (SELECT count(*)::int FROM "PaymentInitiationPolicy" WHERE provider='PAYPAL') AS policies`;
  assert.deepEqual(state, { triggers: 1, reviewColumns: 2, policies: 1 });
  // No migration in prisma/migrations touches PayPal objects; the destructive step lives only in prisma/contract.
  const migrations = readdirSync(join(repository, 'prisma/migrations')).filter(name => name.startsWith('202611'));
  assert.ok(migrations.every(name => !/paypal/i.test(name)), migrations.join(','));
});

it('the prepared contract migration applies cleanly (inside a rolled-back transaction) and leaves no PayPal schema', async () => {
  const body = contractSql().replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
  await withClient(async client => {
    await client.query('BEGIN');
    await client.query(body);
    const enums = (await client.query(`SELECT t.typname AS type, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels FROM pg_enum e
      JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname IN ('PaymentProvider','RefundProvider') GROUP BY t.typname ORDER BY t.typname`)).rows;
    assert.deepEqual(enums, [{ type: 'PaymentProvider', labels: ['MANUAL', 'STRIPE'] }, { type: 'RefundProvider', labels: ['MANUAL', 'STRIPE'] }]);
    const [left] = (await client.query(`SELECT (SELECT count(*)::int FROM pg_proc WHERE prosrc LIKE '%''PAYPAL''%') AS "enumFunctions",
      (SELECT count(*)::int FROM pg_constraint WHERE pg_get_constraintdef(oid) LIKE '%PAYPAL%') AS constraints,
      (SELECT count(*)::int FROM information_schema.columns WHERE table_name='PaymentWebhookEvent' AND column_name IN ('reviewDetails','reviewedAt')) AS "reviewColumns",
      (SELECT count(*)::int FROM "PaymentInitiationPolicy" WHERE provider<>'STRIPE') AS policies`)).rows;
    assert.deepEqual(left, { enumFunctions: 0, constraints: 0, reviewColumns: 0, policies: 0 });
    await client.query('ROLLBACK');
  });
  // Rolled back: the compatibility schema is intact.
  assert.equal((await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_enum WHERE enumlabel='PAYPAL'`)[0].n, 2);
});

it('the contract migration refuses, changing nothing, while any PayPal record exists', async () => {
  const sql = contractSql();
  const preflight = sql.slice(sql.indexOf('DO $$'), sql.indexOf('END $$;') + 'END $$;'.length);
  await withClient(async client => {
    await client.query('BEGIN');
    await client.query(`INSERT INTO "PaymentWebhookEvent"(provider,"providerEventId","eventType") VALUES ('PAYPAL','synthetic-${randomUUID()}','synthetic')`);
    await client.query(`INSERT INTO "PaymentSecurityEvent"(kind,provider,reason) VALUES ('SYNTHETIC','PAYPAL','synthetic removal guard')`);
    await assert.rejects(client.query(preflight), /PayPal records exist in PaymentWebhookEvent, PaymentSecurityEvent; refusing PayPal removal \(no data changed\)/);
  });
});

it('a residual PayPal payment (e.g. Sandbox before recreation) stays readable but fails closed everywhere', async () => {
  const admin = await user('ADMIN'), customer = await user('CUSTOMER');
  const paid = await prisma.order.create({ data: { userId: customer.id, totalAmount: 20, status: 'CONFIRMED', ...address } });
  const payment = await prisma.payment.create({ data: { orderId: paid.id, amount: 20, provider: 'PAYPAL', status: 'SUCCEEDED', paidAt: new Date(),
    providerReference: `ORDER-${randomUUID()}`, providerCaptureReference: `CAP-${randomUUID()}` } });
  const pending = await prisma.order.create({ data: { userId: customer.id, totalAmount: 20, status: 'PENDING', reservationExpiresAt: new Date(Date.now() + 3_600_000), ...address } });
  await prisma.payment.create({ data: { orderId: pending.id, amount: 20, provider: 'PAYPAL', status: 'PENDING', providerReference: `ORDER-${randomUUID()}` } });
  try {
    // Readable: the Prisma client still knows the deprecated value.
    const read = await fetch(`${url}/orders/${paid.id}`, { headers: bearer(customer.id, 'CUSTOMER') });
    assert.equal(read.status, 200);
    // Never offered a checkout or recovery action.
    const window = (await (await fetch(`${url}/orders/${pending.id}`, { headers: bearer(customer.id, 'CUSTOMER') })).json()).paymentWindow;
    assert.equal(window.provider, 'PAYPAL'); assert.equal(window.reason, 'OTHER_PROVIDER');
    assert.equal(window.initiationEligibility, 'INELIGIBLE'); assert.equal(window.resumeEligibility, 'INELIGIBLE');
    // Not refundable through the API, and nothing is written.
    const refund = await fetch(`${url}/orders/${paid.id}/refunds`, { method: 'POST', headers: { ...bearer(admin.id, 'ADMIN'), 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ paymentId: payment.id, amount: 5, reason: 'Residual provider refund attempt' }) });
    assert.equal(refund.status, 409);
    assert.equal((await refund.json()).error.code, 'PAYMENT_PROVIDER_UNSUPPORTED');
    assert.equal(await prisma.refund.count({ where: { paymentId: payment.id } }), 0);
    // Held for manual review in every financial guard (fulfilment, cancellation, refunds).
    assert.equal(await prisma.$transaction(tx => providerFinancialHold(tx, payment)), 'PAYMENT');
  } finally {
    await prisma.payment.deleteMany({ where: { orderId: { in: [paid.id, pending.id] } } });
    await prisma.order.deleteMany({ where: { id: { in: [paid.id, pending.id] } } });
  }
});

it('no PayPal configuration remains, and no application module references PayPal', () => {
  assert.deepEqual(Object.keys(config).filter(key => /PAYPAL/i.test(key)), []);
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (['__tests__', 'generated'].includes(name) ? [] : files(path)) : path.endsWith('.ts') ? [path] : [];
  });
  // The only exemption: two constant-zero metrics Infra's monitor still expects (see metrics.ts).
  const offenders = files(join(repository, 'src')).filter(path => readFileSync(path, 'utf8').split('\n')
    .some(line => /paypal/i.test(line) && !/PayPalSweepAge|PayPalInboxAge/.test(line)));
  assert.deepEqual(offenders, []);
});
