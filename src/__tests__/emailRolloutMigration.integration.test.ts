import assert from 'node:assert/strict';
import { it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import pg from 'pg';
import { validateTestDatabase } from '../config/testDatabase.js';
it('rollout migration preserves existing routing/source, validates order identity and rolls back atomically', async () => {
  const target = validateTestDatabase(process.env), schema = `email_rollout_${randomUUID().replaceAll('-', '')}`;
  const c = new pg.Client({ connectionString: target.url }), migration = '20261020140000_email_rollout_integrity';
  const sql = (name: string) => readFileSync(`prisma/migrations/${name}/migration.sql`, 'utf8'); await c.connect();
  try {
    await c.query(`CREATE SCHEMA "${schema}"`); await c.query(`SET search_path TO "${schema}"`);
    for (const name of readdirSync('prisma/migrations').filter(n => n !== 'migration_lock.toml' && n < migration).sort()) await c.query(sql(name));
    const user = (await c.query(`INSERT INTO "User"(email,"passwordHash","updatedAt") VALUES($1,'synthetic',now()) RETURNING id`, [`${randomUUID()}@example.test`])).rows[0].id;
    const fields = ['billingRecipientName','billingLine1','billingCity','billingPostcode','billingCountryCode','deliveryRecipientName','deliveryLine1','deliveryCity','deliveryPostcode','deliveryCountryCode'];
    const order = (await c.query(`INSERT INTO "Order"("userId","totalAmount",status,"updatedAt",${fields.map(f => `"${f}"`).join(',')}) VALUES($1,10,'CONFIRMED',now(),${fields.map(() => "'synthetic'").join(',')}) RETURNING id`, [user])).rows[0].id;
    await c.query(`INSERT INTO "OrderConfirmationJob"(id,"orderId","eventKey",source,"updatedAt") VALUES('bad',$1,$2,'{}',now())`, [order, `order:${order}`]);
    await assert.rejects(c.query(sql(migration)), (e: unknown) => (e as { code: string }).code === '23514'); await c.query('ROLLBACK');
    await c.query(`DELETE FROM "OrderConfirmationJob" WHERE id='bad'`);
    await c.query(`INSERT INTO "OrderConfirmationJob"(id,"orderId","eventKey",source,"updatedAt") VALUES('valid',$1,$2,$3,now())`, [order, `order:${order}`, JSON.stringify({ orderId: order })]);
    const before = (await c.query(`SELECT * FROM "OrderConfirmationJob"`)).rows[0];
    const injected = sql(migration).replace(/COMMIT;\s*$/, () => "DO $$ BEGIN RAISE EXCEPTION 'injected rollout failure'; END $$; COMMIT;");
    await assert.rejects(c.query(injected), (e: unknown) => (e as { code: string }).code === 'P0001'); await c.query('ROLLBACK');
    assert.deepEqual((await c.query('SELECT * FROM "OrderConfirmationJob"')).rows[0], before);
    await c.query(sql(migration));
    const { deliveryRoute, backlogApprovedAt, ...after } = (await c.query('SELECT * FROM "OrderConfirmationJob"')).rows[0];
    assert.deepEqual(after, before); assert.equal(deliveryRoute, 'DURABLE'); assert.equal(backlogApprovedAt, null);
    await assert.rejects(c.query(`UPDATE "OrderConfirmationJob" SET "deliveryRoute"='LEGACY' WHERE id='valid'`));
  } finally { await c.query('ROLLBACK'); await c.query(`DROP SCHEMA "${schema}" CASCADE`); await c.end(); }
});
