import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { validateTestDatabase } from '../config/testDatabase.js';

it('confirmation migration rolls back cleanly without partially installing jobs, snapshots or sequence', async () => {
  const target = validateTestDatabase(process.env), schema = `email_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: target.url, options: '-c timezone=UTC' });
  const name = '20261020120000_order_confirmation_outbox';
  const sql = (id: string) => readFileSync(`prisma/migrations/${id}/migration.sql`, 'utf8');
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET search_path TO "${schema}"`);
    for (const id of readdirSync('prisma/migrations').filter(n => n !== 'migration_lock.toml' && n < name).sort()) await client.query(sql(id));
    const injected = sql(name).replace(/COMMIT;\s*$/, () => "DO $$ BEGIN RAISE EXCEPTION 'Injected invoice migration failure'; END $$; COMMIT;");
    await assert.rejects(client.query(injected), (error: unknown) => (error as { code: string }).code === 'P0001'); await client.query('ROLLBACK');
    for (const table of ['OrderConfirmationJob', 'CommercialInvoice']) assert.equal((await client.query(`SELECT to_regclass('"${table}"') AS relation`)).rows[0].relation, null);
    assert.equal((await client.query("SELECT to_regclass('commercial_invoice_number_seq') AS relation")).rows[0].relation, null);
    assert.equal((await client.query(`SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema=current_schema() AND column_name IN ('confirmationDeliverySnapshot','invoiceDescriptionSnapshot','invoiceSetNumberSnapshot')`)).rows[0].count, 0);
    await client.query(sql(name));
    assert.equal((await client.query('SELECT count(*)::int AS count FROM "CommercialInvoice"')).rows[0].count, 0);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM "OrderConfirmationJob"')).rows[0].count, 0);
  } finally {
    await client.query('ROLLBACK'); await client.query(`DROP SCHEMA "${schema}" CASCADE`); await client.end();
  }
});
