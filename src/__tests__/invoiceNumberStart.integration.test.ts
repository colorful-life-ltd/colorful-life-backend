import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { prisma } from '../prisma/runtime.js';

const migration = readFileSync('prisma/migrations/20261021120000_invoice_number_start/migration.sql', 'utf8');
const state = async () => (await prisma.$queryRaw<Array<{ next: bigint }>>`SELECT CASE WHEN is_called THEN last_value + 1 ELSE last_value END AS next FROM "commercial_invoice_number_seq"`)[0].next;
after(async () => { await prisma.$disconnect(); });

it('after migrations the next invoice number is at least the approved 102801', async () => {
  assert.ok(await state() >= 102801n);
});
it('re-applying the start migration never moves an advanced live sequence backwards', async () => {
  const before = await state();
  await prisma.$executeRawUnsafe(`SELECT setval('"commercial_invoice_number_seq"'::regclass, ${before + 500n}, true)`);
  const advanced = await state();
  await prisma.$executeRawUnsafe(migration);
  assert.equal(await state(), advanced);
  const [allocated] = await prisma.$queryRaw<Array<{ number: bigint }>>`SELECT nextval('commercial_invoice_number_seq') AS number`;
  assert.equal(allocated.number, advanced);
});
it('allocations racing the start migration are serialised: nothing is reused or moved backwards', async () => {
  // Real migration SQL on a temporary sequence, with the read-to-set window widened to force the interleaving.
  const name = `invoice_start_race_${process.pid}_${Date.now()}`;
  const paused = migration.replaceAll('commercial_invoice_number_seq', name).replace(/(INTO next_value FROM "[^"]+";)/, '$1 PERFORM pg_sleep(0.8);');
  assert.match(paused, /PERFORM pg_sleep\(0\.8\)/);
  const next = async () => (await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT nextval('"${name}"'::regclass) AS n`))[0].n;
  await prisma.$executeRawUnsafe(`CREATE SEQUENCE "${name}"`);
  try {
    await prisma.$executeRawUnsafe(`SELECT setval('"${name}"'::regclass, 102795, true)`);
    // PrismaPromise is lazy: .then() starts the migration now, on its own pooled connection.
    const migrating = prisma.$executeRawUnsafe(paused).then(() => undefined);
    await delay(200);
    const started = Date.now(); const during: bigint[] = []; for (let i = 0; i < 6; i++) during.push(await next());
    const waited = Date.now() - started; await migrating;
    assert.ok(waited >= 400, `concurrent nextval() was not blocked by the migration (${waited} ms)`);
    const all = [...during, await next(), await next()];
    assert.ok(during[0] >= 102801n, `allocated ${during[0]} below the approved start while migrating`);
    assert.equal(new Set(all).size, all.length);
    for (let i = 1; i < all.length; i++) assert.ok(all[i] > all[i - 1]);
  } finally { await prisma.$executeRawUnsafe(`DROP SEQUENCE IF EXISTS "${name}"`); }
});
