import assert from "node:assert/strict";
import { it } from "node:test";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { validateTestDatabase } from "../config/testDatabase.js";
const target=validateTestDatabase(process.env);
const root="prisma/migrations",first="20261015120000_payment_resolution_runtime",second="20261015121000_payment_resolution_runtime_scheduling";
const names=readdirSync(root).filter(x=>x!=="migration_lock.toml").sort();
const sql=(name:string)=>readFileSync(`${root}/${name}/migration.sql`,"utf8");
async function isolated(){const c=new pg.Client({connectionString:target.url,options:"-c timezone=UTC"});await c.connect();const schema=`runtime_migration_${randomUUID().replaceAll("-","")}`;await c.query(`CREATE SCHEMA "${schema}"`);await c.query(`SET search_path TO "${schema}"`);return {c,async close(){await c.query('ROLLBACK');await c.query(`DROP SCHEMA "${schema}" CASCADE`);await c.end();}};}
it("migrates the complete history including all runtime migrations on an empty PostgreSQL schema",async()=>{
 const s=await isolated();try{for(const name of names)await s.c.query(sql(name));
  assert.equal((await s.c.query(`SELECT is_nullable FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='ReservationReleaseProof' AND column_name='evidenceId'`)).rows[0].is_nullable,"YES");
  assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname=current_schema() AND indexname='PaymentResolution_runtime_due_idx'`)).rows[0].n,1);
  assert.equal((await s.c.query('SELECT count(*)::int AS n FROM "FinancialEvidence"')).rows[0].n,0);
 }finally{await s.close();}
});
it("runtime DDL failure rolls back proof changes and retains the Phase 2A prohibition",async()=>{
 const s=await isolated();try{for(const name of names.filter(n=>n<first))await s.c.query(sql(name));
  const previous=(await s.c.query("SELECT pg_get_functiondef('payment_foundation_validate()'::regprocedure) AS definition")).rows[0].definition;
  const injected=sql(first).replace(/COMMIT;\s*$/,()=>`DO $$ BEGIN RAISE EXCEPTION 'Injected runtime migration failure'; END $$; COMMIT;`);
  await assert.rejects(s.c.query(injected),(error:unknown)=>(error as {code:string}).code==="P0001");await s.c.query('ROLLBACK');
  assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid='"PaymentResolution"'::regclass AND conname='phase2a_no_release'`)).rows[0].n,1);
  assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='ReservationReleaseProof' AND column_name='type'`)).rows[0].n,0);
  assert.equal((await s.c.query("SELECT pg_get_functiondef('payment_foundation_validate()'::regprocedure) AS definition")).rows[0].definition,previous);
  for(const name of names.filter(n=>n>=first))await s.c.query(sql(name));
 }finally{await s.close();}
});
it("runtime upgrade preserves historical financial rows and quarantine without inventing finality",async()=>{
 const s=await isolated();try{for(const name of names.filter(n=>n<first))await s.c.query(sql(name));
  const user=(await s.c.query(`INSERT INTO "User"(email,"passwordHash","updatedAt") VALUES($1,'fixture',now()) RETURNING id`,[`${randomUUID()}@fixture.test`])).rows[0].id;
  const fields=['billingRecipientName','billingLine1','billingCity','billingPostcode','billingCountryCode','deliveryRecipientName','deliveryLine1','deliveryCity','deliveryPostcode','deliveryCountryCode'];
  const order=(await s.c.query(`INSERT INTO "Order"("userId","totalAmount","createdAt","updatedAt",${fields.map(f=>`"${f}"`).join(',')}) VALUES($1,20,'2026-01-01',now(),${fields.map(()=>"'fixture'").join(',')}) RETURNING id`,[user])).rows[0].id;
  await s.c.query(`INSERT INTO "Payment"("orderId",provider,status,amount,"providerReference","updatedAt") VALUES($1,'STRIPE','FAILED',20,'pending:fixture',now())`,[order]);
  await s.c.query(sql('20261013121000_payment_resolution_historical_backfill'));
  const rowsBefore=(await s.c.query('SELECT row_to_json(p) AS data FROM "Payment" p')).rows;
  const orderBefore=(await s.c.query('SELECT row_to_json(o) AS data FROM "Order" o')).rows;
  for(const name of names.filter(n=>n>=first))await s.c.query(sql(name));
  assert.deepEqual((await s.c.query('SELECT row_to_json(p) AS data FROM "Payment" p')).rows,rowsBefore);
  // Later migrations may add Order columns; every pre-existing value must be unchanged.
  const orderAfter=(await s.c.query('SELECT row_to_json(o) AS data FROM "Order" o')).rows;
  assert.deepEqual(orderAfter.map((row,i)=>({data:Object.fromEntries(Object.keys(orderBefore[i].data).map(k=>[k,row.data[k]]))})),orderBefore);
  const r=(await s.c.query('SELECT * FROM "PaymentResolution" WHERE "orderId"=$1',[order])).rows[0];
  assert.equal(r.state,'REVIEW_REQUIRED');assert.equal(r.historical,true);assert.equal(r.reservationDisposition,null);assert.equal(r.retryDeadline,null);
  assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM "FinancialEvidence" WHERE kind<>'HISTORICAL_UNVERIFIED'`)).rows[0].n,0);
 }finally{await s.close();}
});
