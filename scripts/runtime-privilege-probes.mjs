import assert from 'node:assert/strict';
import pg from 'pg';
import {databaseUrl,databasePoolOptions} from '../src/config/database.ts';
const client=new pg.Client(databasePoolOptions(databaseUrl(process.env),process.env));
try{
 await client.connect();
 const grants=await client.query("SELECT has_database_privilege(current_user,current_database(),'CREATE') AS create,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user");
 assert.ok(Object.values(grants.rows[0]).every(x=>x===false));
 await client.query('SELECT count(*) FROM "User"');
 const denied=['CREATE SCHEMA runtime_must_not_create','TRUNCATE "OperationalAudit"','UPDATE "OperationalAudit" SET kind=kind WHERE false','DELETE FROM "OperationalAudit" WHERE false','DELETE FROM "Order" WHERE false','DELETE FROM "Payment" WHERE false','DELETE FROM "Refund" WHERE false','UPDATE "CommercialInvoice" SET snapshot=snapshot WHERE false','SELECT * FROM _prisma_migrations','SELECT * FROM cl_operations.environment','SELECT * FROM cl_operations.migration_recovery_events','ALTER TABLE "User" DISABLE TRIGGER ALL','UPDATE "FbaShipment" SET note=note WHERE false','DELETE FROM "FbaShipment" WHERE false','DELETE FROM "FbaShipmentSequence" WHERE false','TRUNCATE "FbaShipmentSequence"'];
 for(const query of denied)await assert.rejects(client.query(query),e=>e.code==='42501',query);
 await client.query('UPDATE "CommercialInvoice" SET "pdfBytes"="pdfBytes","pdfSha256"="pdfSha256" WHERE false');
 await client.query('INSERT INTO "AbuseBucket" (key,tokens,"updatedAt","expiresAt") VALUES ($1,1,now(),now())',['synthetic-rehearsal']);
 await client.query('DELETE FROM "AbuseBucket" WHERE key=$1',['synthetic-rehearsal']);
 // FBA shipments: append-only headers; the reference counter is an upsert (SELECT, INSERT, UPDATE). Rolled back.
 await client.query('SELECT count(*) FROM "FbaShipment"');
 await client.query('BEGIN');
 try{
  await client.query(`INSERT INTO "FbaShipmentSequence" (day,"lastValue") VALUES (DATE '1999-01-01',1) ON CONFLICT (day) DO UPDATE SET "lastValue"="FbaShipmentSequence"."lastValue"+1 RETURNING "lastValue"`);
  await client.query(`INSERT INTO "FbaShipmentSequence" (day,"lastValue") VALUES (DATE '1999-01-01',1) ON CONFLICT (day) DO UPDATE SET "lastValue"="FbaShipmentSequence"."lastValue"+1 RETURNING "lastValue"`);
  await client.query(`SELECT has_sequence_privilege(current_user, pg_get_serial_sequence('"FbaShipment"','id'), 'USAGE') AS usage`).then(r=>assert.equal(r.rows[0].usage,true));
 }finally{await client.query('ROLLBACK');}
 await assert.rejects(client.query('SELECT $1::integer',['synthetic-sensitive-bind-marker']),e=>e.code==='22P02');
 await assert.rejects(client.query("SELECT 'synthetic-sensitive-literal-marker'::integer"),e=>e.code==='22P02');
 console.log('Runtime SCRAM authentication, allowed operations and '+denied.length+' negative privilege probes passed');
}finally{await client.end();}
