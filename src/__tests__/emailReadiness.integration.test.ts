import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { prisma } from '../prisma/runtime.js';
import { assertEmailSchemaReady, approvedEmailConfiguration } from '../domain/orderConfirmation/readiness.js';
import { config } from '../config/index.js';
import { businessFixture } from './fixtures/orderConfirmation.fixture.js';
after(() => prisma.$disconnect());
it('requires complete email schema even while outbound delivery is disabled', async () => {
  await assertEmailSchemaReady();
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.$executeRawUnsafe('SET LOCAL search_path TO pg_catalog');
    await assertEmailSchemaReady(tx);
  }), /schema not ready/);
});
it('requires explicit activation cutoff and approved configuration', () => {
  const saved = [config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM, config.ORDER_CONFIRMATION_BUSINESS_JSON];
  try {
    config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM = undefined; config.ORDER_CONFIRMATION_BUSINESS_JSON = JSON.stringify(businessFixture);
    assert.throws(approvedEmailConfiguration, /cutoff/);
    config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM = '2026-10-16T00:00:00Z'; assert.equal(approvedEmailConfiguration().legalName, 'Colorful Life Ltd');
    config.ORDER_CONFIRMATION_BUSINESS_JSON = '{}'; assert.throws(approvedEmailConfiguration, /configuration/);
  } finally { [config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM, config.ORDER_CONFIRMATION_BUSINESS_JSON] = saved; }
});

it('SES unavailable at startup does not fail schema startup or API health, and readiness recovery is automatic', async () => {
  const { assertEmailStartupReady, createEmailReadinessTick } = await import('../domain/orderConfirmation/readiness.js');
  const { default: app } = await import('../app.js');
  await assertEmailStartupReady();
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let now = 0, available = false, runs = 0, probes = 0; const warnings: string[] = [];
  const tick = createEmailReadinessTick({ enabled: () => true, now: () => now, probe: async () => { probes++; if (!available) throw new Error('private provider details'); }, run: async () => { runs++; }, warn: s => warnings.push(s) });
  try {
    await tick(); assert.equal(runs, 0); assert.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status, 200);
    assert.doesNotMatch(warnings.join(''), /private provider details/);
    available = true; await tick(); assert.equal(probes, 1); now = 30_000; await tick(); assert.equal(runs, 1); assert.equal(probes, 2);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
it('readiness timeout pauses work without discarding jobs and can subsequently recover', async () => {
  const { createEmailReadinessTick } = await import('../domain/orderConfirmation/readiness.js');
  let now = 0, available = false, runs = 0;
  const tick = createEmailReadinessTick({ enabled: () => true, now: () => now, timeoutMs: 5, probe: () => available ? Promise.resolve() : new Promise(() => {}), run: async () => { runs++; }, warn: () => {} });
  await tick(); assert.equal(runs, 0); available = true; now = 30_000; await tick(); assert.equal(runs, 1);
});
it('rejects future-dated activation cutoffs independently for both email types', async () => {
  const { activationCutoff } = await import('../domain/orderConfirmation/readiness.js');
  const saved = [config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM, config.DISPATCH_CONFIRMATION_EMAIL_ACTIVE_FROM];
  try {
    config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM = new Date(Date.now() + 60_000).toISOString(); config.DISPATCH_CONFIRMATION_EMAIL_ACTIVE_FROM = config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM;
    for (const type of ['ORDER_CONFIRMATION', 'DISPATCH_CONFIRMATION'] as const) assert.throws(() => activationCutoff(type), /future/);
  } finally { [config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM, config.DISPATCH_CONFIRMATION_EMAIL_ACTIVE_FROM] = saved; }
});

it('future and malformed cutoff values load without terminating configuration or automatically maturing', async t => {
  const { spawnSync } = await import('node:child_process');
  const { emailConfigurationLoadedAt } = await import('../config/index.js');
  const { activationCutoff } = await import('../domain/orderConfirmation/readiness.js');
  const future = new Date(emailConfigurationLoadedAt + 3_600_000).toISOString();
  for (const value of [future, 'invalid-cutoff']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./dist/config/index.js'); console.log('configuration-loaded')"], {
      cwd: process.cwd(), env: { ...process.env, ORDER_CONFIRMATION_EMAIL_ENABLED: 'true', DISPATCH_CONFIRMATION_EMAIL_ENABLED: 'true', ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM: value, DISPATCH_CONFIRMATION_EMAIL_ACTIVE_FROM: value }, encoding: 'utf8',
    });
    assert.equal(child.status, 0, 'invalid email cutoffs must not terminate global configuration');
    assert.match(child.stdout, /configuration-loaded/);
  }
  const saved = config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM;
  try {
    config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM = future;
    t.mock.method(Date, 'now', () => emailConfigurationLoadedAt + 7_200_000);
    assert.throws(() => activationCutoff('ORDER_CONFIRMATION'), /future-dated at configuration load/);
  } finally { config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM = saved; }
});
