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

// Stripe is the only payment provider. PayPal code, routes, configuration and schema values are
// removed; these regressions pin that end state.
let server: ReturnType<typeof app.listen>, url = '';
before(async () => { server = app.listen(0); await new Promise<void>(r => server.once('listening', r)); url = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
after(async () => { await new Promise<void>(r => server.close(() => r())); await prisma.$disconnect(); });
const bearer = (id: number, role: string) => ({ Authorization: `Bearer ${jwt.sign({ id, role }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' });
const repository = new URL('../../', import.meta.url).pathname;

it('every former PayPal route is gone', async () => {
  const admin = await prisma.user.create({ data: { email: `${randomUUID()}@paypal-removal.test`, passwordHash: 'synthetic', role: 'ADMIN', emailVerified: true } });
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

it('the database has no PayPal provider values, guards, review columns or policy', async () => {
  const enums = await prisma.$queryRaw<Array<{ type: string; labels: string[] }>>`SELECT t.typname AS type, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
    FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid WHERE t.typname IN ('PaymentProvider','RefundProvider') GROUP BY t.typname ORDER BY t.typname`;
  assert.deepEqual(enums, [{ type: 'PaymentProvider', labels: ['MANUAL', 'STRIPE'] }, { type: 'RefundProvider', labels: ['MANUAL', 'STRIPE'] }]);
  const [objects] = await prisma.$queryRaw<Array<{ triggers: number; enumFunctions: number; constraints: number; reviewColumns: number }>>`SELECT
    (SELECT count(*)::int FROM pg_trigger WHERE tgname='paypal_capture_admission') AS triggers,
    (SELECT count(*)::int FROM pg_proc WHERE prosrc LIKE '%''PAYPAL''%') AS "enumFunctions",
    (SELECT count(*)::int FROM pg_constraint WHERE pg_get_constraintdef(oid) LIKE '%PAYPAL%') AS constraints,
    (SELECT count(*)::int FROM information_schema.columns WHERE table_name='PaymentWebhookEvent' AND column_name IN ('reviewDetails','reviewedAt')) AS "reviewColumns"`;
  assert.deepEqual(objects, { triggers: 0, enumFunctions: 0, constraints: 0, reviewColumns: 0 });
  assert.deepEqual(await prisma.$queryRaw`SELECT provider FROM "PaymentInitiationPolicy" ORDER BY provider`, [{ provider: 'STRIPE' }]);
  await assert.rejects(prisma.$executeRaw`INSERT INTO "PaymentWebhookEvent"(provider,"providerEventId","eventType") VALUES ('PAYPAL','x','y')`);
  await assert.rejects(prisma.$executeRaw`INSERT INTO "PaymentInitiationPolicy"(provider) VALUES ('PAYPAL')`);
});

it('the removal migration refuses, changing nothing, while any PayPal record exists', async () => {
  const sql = readFileSync(join(repository, 'prisma/migrations/20261106120000_remove_paypal/migration.sql'), 'utf8');
  // The review columns no longer exist after migration, so drop only that one check line.
  const preflight = sql.slice(sql.indexOf('DO $$'), sql.indexOf('END $$;') + 'END $$;'.length)
    .split('\n').filter(line => !line.includes('"reviewDetails"')).join('\n');
  assert.ok(preflight.includes('RAISE EXCEPTION'));
  const client = new pg.Client({ connectionString: config.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO "PaymentSecurityEvent"(kind,provider,reason) VALUES ('SYNTHETIC','PAYPAL','synthetic removal guard')`);
    await assert.rejects(client.query(preflight), /PayPal records exist in PaymentSecurityEvent; refusing PayPal removal \(no data changed\)/);
  } finally { await client.query('ROLLBACK').catch(() => undefined); await client.end(); }
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
