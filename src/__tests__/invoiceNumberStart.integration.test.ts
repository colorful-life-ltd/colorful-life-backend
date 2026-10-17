import assert from 'node:assert/strict';
import { after, it } from 'node:test';
import { readFileSync } from 'node:fs';
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
