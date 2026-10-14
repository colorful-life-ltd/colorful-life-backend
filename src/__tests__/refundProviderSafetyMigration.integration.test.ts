import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync,readFileSync } from "node:fs";
import pg from "pg";
import { validateTestDatabase } from "../config/testDatabase.js";
const target=validateTestDatabase(process.env);
const root="prisma/migrations",migration="20261019120000_refund_provider_safety";
const names=readdirSync(root).filter(n=>n!=="migration_lock.toml").sort();
const sql=(name:string)=>readFileSync(`${root}/${name}/migration.sql`,"utf8");
async function isolated(){const c=new pg.Client({connectionString:target.url,options:"-c timezone=UTC"});await c.connect();const schema=`refund_${randomUUID().replaceAll("-","")}`;await c.query(`CREATE SCHEMA "${schema}"`);await c.query(`SET search_path TO "${schema}"`);return {c,async close(){await c.query('ROLLBACK');await c.query(`DROP SCHEMA "${schema}" CASCADE`);await c.end();}};}
it("refund safety migration applies cleanly with identity constraints and indexes",async()=>{
 const s=await isolated();try{
  for(const name of names)await s.c.query(sql(name));
  assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='Refund' AND column_name IN ('clientRequestKey','providerPaymentReference','submissionStartedAt','resolutionCode','reviewRequired','reconciliationAttempts','providerOutcome','reviewEvidence')`)).rows[0].n,8);
  const indexes=(await s.c.query(`SELECT indexname FROM pg_indexes WHERE schemaname=current_schema() AND tablename='Refund'`)).rows.map(r=>r.indexname);
  assert.ok(indexes.includes('Refund_clientRequestKey_key'));assert.ok(indexes.includes('Refund_paymentId_status_idx'));
 }finally{await s.close();}
});
it("refund safety migration rolls back atomically and preserves historical financial/stock data on upgrade",async()=>{
 const s=await isolated();try{
  for(const name of names.filter(n=>n<migration))await s.c.query(sql(name));
  const user=(await s.c.query(`INSERT INTO "User"(email,"passwordHash","updatedAt") VALUES($1,'fixture',now()) RETURNING id`,[`${randomUUID()}@refund-migration.test`])).rows[0].id;
  const fields=['billingRecipientName','billingLine1','billingCity','billingPostcode','billingCountryCode','deliveryRecipientName','deliveryLine1','deliveryCity','deliveryPostcode','deliveryCountryCode'];
  const order=(await s.c.query(`INSERT INTO "Order"("userId","totalAmount",status,"createdAt","updatedAt",${fields.map(f=>`"${f}"`).join(',')}) VALUES($1,100,'CONFIRMED',now(),now(),${fields.map(()=>"'fixture'").join(',')}) RETURNING id`,[user])).rows[0].id;
  const payment=(await s.c.query(`INSERT INTO "Payment"("orderId",provider,status,amount,currency,"providerReference","paidAt","refundedAmount","reservedRefundAmount","updatedAt") VALUES($1,'STRIPE','SUCCEEDED',100,'GBP','pi_history',now(),20,25,now()) RETURNING id`,[order])).rows[0].id;
  await s.c.query(`INSERT INTO "Refund"("orderId","paymentId",amount,currency,status,provider,"providerReference","performedByUserId","updatedAt") VALUES($1,$2,20,'GBP','SUCCEEDED','MANUAL','historical-manual',$3,now()),($1,$2,25,'GBP','PROCESSING','STRIPE','pending:historical',$3,now())`,[order,payment,user]);
  const product=(await s.c.query(`INSERT INTO "LegoProduct"("setNumber",title,theme,"ageRecommendation","pieceCount","updatedAt") VALUES($1,'Fixture','TEST','8+',1,now()) RETURNING id`,[randomUUID()])).rows[0].id;
  await s.c.query(`INSERT INTO "ProductListing"("legoProductId",condition,"originalPrice","currentStock","reservedStock","updatedAt") VALUES($1,'NEW',100,9,3,now())`,[product]);
  const tables=['Order','Payment','Refund','ProductListing'];const before=[];
  for(const table of tables)before.push((await s.c.query(`SELECT row_to_json(t) AS data FROM "${table}" t ORDER BY id`)).rows);
  const injected=sql(migration).replace(/COMMIT;\s*$/,()=>`DO $$ BEGIN RAISE EXCEPTION 'Injected refund migration failure'; END $$; COMMIT;`);
  await assert.rejects(s.c.query(injected),(e:unknown)=>(e as {code:string}).code==='P0001');await s.c.query('ROLLBACK');
  for(let i=0;i<tables.length;i++)assert.deepEqual((await s.c.query(`SELECT row_to_json(t) AS data FROM "${tables[i]}" t ORDER BY id`)).rows,before[i]);
  await s.c.query(sql(migration));
  for(const i of [0,1,3])assert.deepEqual((await s.c.query(`SELECT row_to_json(t) AS data FROM "${tables[i]}" t ORDER BY id`)).rows,before[i]);
  const upgraded=(await s.c.query('SELECT row_to_json(t) AS data FROM "Refund" t ORDER BY id')).rows;
  for(let i=0;i<upgraded.length;i++){
   const {clientRequestKey,providerPaymentReference,submissionStartedAt,resolutionCode,reviewRequired,reconciliationAttempts,providerOutcome,reviewEvidence,...old}=upgraded[i].data;
   assert.deepEqual({clientRequestKey,providerPaymentReference,submissionStartedAt,resolutionCode,reviewRequired,reconciliationAttempts,providerOutcome,reviewEvidence},
     {clientRequestKey:null,providerPaymentReference:null,submissionStartedAt:null,resolutionCode:null,reviewRequired:false,reconciliationAttempts:0,providerOutcome:null,reviewEvidence:null});
   assert.deepEqual(old,before[2][i].data);
  }
 }finally{await s.close();}
});
