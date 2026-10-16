import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { validateTestDatabase } from '../config/testDatabase.js';
it('dispatch migration rollback and upgrade preserve existing confirmation tasks without historical shipment backfill', async () => {
  const target = validateTestDatabase(process.env), schema = `dispatch_email_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: target.url }), migration = '20261020130000_dispatch_email_outbox';
  const sql = (id: string) => readFileSync(`prisma/migrations/${id}/migration.sql`, 'utf8');
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`); await client.query(`SET search_path TO "${schema}"`);
    for (const name of readdirSync('prisma/migrations').filter(n => n !== 'migration_lock.toml' && n < migration).sort()) await client.query(sql(name));
    const user = (await client.query(`INSERT INTO "User"(email,"passwordHash","updatedAt") VALUES($1,'synthetic',now()) RETURNING id`, [`${randomUUID()}@example.test`])).rows[0].id;
    const addressFields = ['billingRecipientName','billingLine1','billingCity','billingPostcode','billingCountryCode','deliveryRecipientName','deliveryLine1','deliveryCity','deliveryPostcode','deliveryCountryCode'];
    const order = (await client.query(`INSERT INTO "Order"("userId","totalAmount",status,"updatedAt",${addressFields.map(f => `"${f}"`).join(',')}) VALUES($1,10,'DISPATCHED',now(),${addressFields.map(() => "'synthetic'").join(',')}) RETURNING id`, [user])).rows[0].id;
    await client.query(`INSERT INTO "Shipment"("orderId",carrier,"carrierName","dispatchedAt","createdByUserId") VALUES($1,'ROYAL_MAIL','Royal Mail',now(),$2)`, [order, user]);
    await client.query(`INSERT INTO "OrderConfirmationJob"(id,"orderId",source,state,"updatedAt") VALUES('old-job',$1,'{"version":1}','BLOCKED',now())`, [order]);
    const before = (await client.query('SELECT * FROM "OrderConfirmationJob"')).rows[0];
    const injected = sql(migration).replace(/COMMIT;\s*$/, () => "DO $$ BEGIN RAISE EXCEPTION 'Injected dispatch migration failure'; END $$; COMMIT;");
    await assert.rejects(client.query(injected), (error: unknown) => (error as { code: string }).code === 'P0001'); await client.query('ROLLBACK');
    assert.deepEqual((await client.query('SELECT * FROM "OrderConfirmationJob"')).rows[0], before);
    await client.query(sql(migration));
    const { type, eventKey, shipmentId, brandSnapshot, ...preserved } = (await client.query('SELECT * FROM "OrderConfirmationJob"')).rows[0];
    assert.deepEqual(preserved, before); assert.equal(type, 'ORDER_CONFIRMATION'); assert.equal(eventKey, `order:${order}`); assert.equal(shipmentId, null); assert.equal(brandSnapshot, null);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM "OrderConfirmationJob" WHERE type='DISPATCH_CONFIRMATION'`)).rows[0].n, 0);
  } finally { await client.query('ROLLBACK'); await client.query(`DROP SCHEMA "${schema}" CASCADE`); await client.end(); }
});
