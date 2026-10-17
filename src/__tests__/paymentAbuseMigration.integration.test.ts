import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';
import { config } from '../config/index.js';

const migration = await readFile('prisma/migrations/20261024120000_payment_abuse_controls/migration.sql', 'utf8');
async function fixture() {
  const schema = `abuse_${randomUUID().replaceAll('-', '')}`;
  const client = new Client({ connectionString: config.DATABASE_URL }); await client.connect();
  await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET search_path TO "${schema}"`);
  await client.query('CREATE TABLE "Order" (id INTEGER PRIMARY KEY)');
  return { client, schema, async cleanup() { await client.query('ROLLBACK'); await client.query(`DROP SCHEMA "${schema}" CASCADE`); await client.end(); } };
}
it('creates default operational policies and all control tables atomically', async () => {
  const f = await fixture(); try {
    await f.client.query(migration);
    assert.equal((await f.client.query('SELECT * FROM "PaymentInitiationPolicy" WHERE enabled')).rowCount, 2);
    const tables = await f.client.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1', [f.schema]);
    assert.equal(tables.rowCount, 7); // six new tables and the Order fixture
  } finally { await f.cleanup(); }
});
it('rolls back partial DDL on failure and permits a clean SQL retry', async () => {
  const f = await fixture(); try {
    await assert.rejects(f.client.query(migration.replace('COMMIT;', `INSERT INTO "PaymentInitiationPolicy" (provider) VALUES ('INVALID'); COMMIT;`)));
    await f.client.query('ROLLBACK');
    assert.equal((await f.client.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1', [f.schema])).rowCount, 1);
    await f.client.query(migration); assert.equal((await f.client.query('SELECT * FROM "PaymentInitiationPolicy"')).rowCount, 2);
  } finally { await f.cleanup(); }
});
it('fails safely on an Order lock timeout without partial schema, then succeeds after lock release', async () => {
  const f = await fixture(), blocker = new Client({ connectionString: config.DATABASE_URL }); await blocker.connect();
  try {
    await blocker.query('BEGIN'); await blocker.query(`LOCK TABLE "${f.schema}"."Order" IN ACCESS EXCLUSIVE MODE`);
    await assert.rejects(f.client.query(migration.replace("lock_timeout = '5s'", "lock_timeout = '20ms'")), (error: any) => error.code === '55P03');
    await f.client.query('ROLLBACK');
    assert.equal((await f.client.query('SELECT table_name FROM information_schema.tables WHERE table_schema=$1', [f.schema])).rowCount, 1);
    await blocker.query('ROLLBACK'); await f.client.query(migration);
  } finally { await blocker.query('ROLLBACK'); await blocker.end(); await f.cleanup(); }
});

it('requires a complete audit note for a released hold at the database boundary', async () => {
  const f = await fixture(); try {
    await f.client.query(migration); await f.client.query('INSERT INTO "Order" (id) VALUES (1)');
    await assert.rejects(f.client.query(`INSERT INTO "PaymentFulfilmentReview" ("orderId", reason, "releasedAt", "releasedBy") VALUES (1, 'TEST', now(), 1)`), (error: any) => error.code === '23514');
    await f.client.query(`INSERT INTO "PaymentFulfilmentReview" ("orderId", reason, "releasedAt", "releasedBy", "releaseNote") VALUES (1, 'TEST', now(), 1, 'Reviewed synthetic evidence')`);
  } finally { await f.cleanup(); }
});
