import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { validateTestDatabase } from "../config/testDatabase.js";
const target=validateTestDatabase(process.env);
const root="prisma/migrations",migration="20261018120000_carrier_tracking_foundation";
const names=readdirSync(root).filter(name=>name!=="migration_lock.toml").sort();
const sql=(name:string)=>readFileSync(`${root}/${name}/migration.sql`,"utf8");
async function isolated(){const c=new pg.Client({connectionString:target.url,options:"-c timezone=UTC"});await c.connect();const schema=`tracking_${randomUUID().replaceAll("-","")}`;await c.query(`CREATE SCHEMA "${schema}"`);await c.query(`SET search_path TO "${schema}"`);return {c,async close(){await c.query('ROLLBACK');await c.query(`DROP SCHEMA "${schema}" CASCADE`);await c.end();}};}
it("clean PostgreSQL migration installs tracking tables, proofs, budgets and indexes",async()=>{
 const s=await isolated();try{
  assert.ok(Number((await s.c.query('SHOW server_version_num')).rows[0].server_version_num)>=120000);
  for(const name of names)await s.c.query(sql(name));
  assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=current_schema() AND table_name IN ('ShipmentTrackingEvent','ShipmentTrackingState','ShipmentTrackingSync','ShipmentTrackingPoll','TrackingCarrierBudget','ShipmentTrackingConflict','ShipmentCarrierEvidence')`)).rows[0].n,7);
  assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM pg_indexes WHERE schemaname=current_schema() AND tablename='ShipmentTrackingEvent'`)).rows[0].n,3);
  assert.equal((await s.c.query('SELECT count(*)::int AS n FROM "ShipmentTrackingEvent"')).rows[0].n,0);
 }finally{await s.close();}
});
it("tracking DDL rollback leaves Phase 1 data and enum intact",async()=>{
 const s=await isolated();try{
  for(const name of names.filter(name=>name<migration))await s.c.query(sql(name));
  const injected=sql(migration).replace(/COMMIT;\s*$/,()=>`DO $$ BEGIN RAISE EXCEPTION 'Injected tracking migration failure'; END $$; COMMIT;`);
  await assert.rejects(s.c.query(injected),(error:unknown)=>(error as {code:string}).code==="P0001");await s.c.query('ROLLBACK');
  assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='ShipmentTrackingEvent'`)).rows[0].n,0);
  assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM pg_enum WHERE enumtypid='"FulfilmentStage"'::regtype`)).rows[0].n,3);
  for(const name of names.filter(name=>name>=migration))await s.c.query(sql(name));
 }finally{await s.close();}
});
it("historical orders, shipments, payment and stock survive with no fabricated tracking evidence",async()=>{
 const s=await isolated();try{
  for(const name of names.filter(name=>name<migration))await s.c.query(sql(name));
  const user=(await s.c.query(`INSERT INTO "User"(email,"passwordHash","updatedAt") VALUES($1,'fixture',now()) RETURNING id`,[`${randomUUID()}@tracking.test`])).rows[0].id;
  const fields=['billingRecipientName','billingLine1','billingCity','billingPostcode','billingCountryCode','deliveryRecipientName','deliveryLine1','deliveryCity','deliveryPostcode','deliveryCountryCode'];
  const order=(await s.c.query(`INSERT INTO "Order"("userId","totalAmount",status,"dispatchedAt","shippingCarrier","trackingNumber","createdAt","updatedAt",${fields.map(f=>`"${f}"`).join(',')}) VALUES($1,20,'DISPATCHED',now(),'Royal Mail','AB123456789GB','2026-01-01',now(),${fields.map(()=>"'fixture'").join(',')}) RETURNING id`,[user])).rows[0].id;
  await s.c.query(`INSERT INTO "Shipment"("orderId",carrier,"carrierName","trackingNumber","dispatchedAt","createdByUserId") VALUES($1,'ROYAL_MAIL','Royal Mail','AB123456789GB',now(),$2)`,[order,user]);
  await s.c.query(`INSERT INTO "Payment"("orderId",provider,status,amount,"providerReference","paidAt","updatedAt") VALUES($1,'MANUAL','SUCCEEDED',20,'fixture-payment',now(),now())`,[order]);
  const product=(await s.c.query(`INSERT INTO "LegoProduct"("setNumber",title,theme,"ageRecommendation","pieceCount","updatedAt") VALUES($1,'Tracking fixture','TRACKING','8+',1,now()) RETURNING id`,[randomUUID()])).rows[0].id;
  const listing=(await s.c.query(`INSERT INTO "ProductListing"("legoProductId",condition,"originalPrice","currentStock","reservedStock","updatedAt") VALUES($1,'NEW',10,7,2,now()) RETURNING id`,[product])).rows[0].id;
  await s.c.query(`INSERT INTO "OrderItem"("orderId","productListingId",quantity,"unitPrice","lineTotal","updatedAt") VALUES($1,$2,2,10,20,now())`,[order,listing]);
  const tables=['Order','Shipment','Payment','ProductListing','OrderItem'];const before=[];
  for(const table of tables)before.push((await s.c.query(`SELECT row_to_json(t) AS data FROM "${table}" t`)).rows);
  for(const name of names.filter(name=>name>=migration))await s.c.query(sql(name));
  for(let i=0;i<tables.length;i++){
   const after=(await s.c.query(`SELECT row_to_json(t) AS data FROM "${tables[i]}" t`)).rows;
   // Issue #180 adds nullable purchase-snapshot columns; never fabricate history.
   const added=tables[i]==="Order"?["confirmationDeliverySnapshot"]:tables[i]==="OrderItem"?["invoiceDescriptionSnapshot","invoiceSetNumberSnapshot"]:[];
   for(const row of after)for(const column of added){assert.equal(row.data[column],null);delete row.data[column];}
   assert.deepEqual(after,before[i]);
  }
  for(const table of ["OrderConfirmationJob","CommercialInvoice"])assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n,0);
  for(const table of ['ShipmentTrackingEvent','ShipmentTrackingState','ShipmentTrackingSync','ShipmentTrackingPoll','TrackingCarrierBudget','ShipmentTrackingConflict','ShipmentCarrierEvidence'])assert.equal((await s.c.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n,0);
 }finally{await s.close();}
});

it("remediation rollback and upgrade preserve legacy tracking evaluations and applied history",async()=>{
 const s=await isolated();const remediation="20261018124000_tracking_evaluation_recovery";
 try{
  for(const name of names.filter(name=>name<remediation))await s.c.query(sql(name));
  const user=(await s.c.query(`INSERT INTO "User"(email,"passwordHash","updatedAt") VALUES($1,'fixture',now()) RETURNING id`,[`${randomUUID()}@tracking.test`])).rows[0].id;
  const fields=['billingRecipientName','billingLine1','billingCity','billingPostcode','billingCountryCode','deliveryRecipientName','deliveryLine1','deliveryCity','deliveryPostcode','deliveryCountryCode'];
  const order=(await s.c.query(`INSERT INTO "Order"("userId","totalAmount",status,"dispatchedAt","createdAt","updatedAt",${fields.map(f=>`"${f}"`).join(',')}) VALUES($1,20,'DISPATCHED',now(),now(),now(),${fields.map(()=>"'fixture'").join(',')}) RETURNING id`,[user])).rows[0].id;
  const shipment=(await s.c.query(`INSERT INTO "Shipment"("orderId",carrier,"carrierName","trackingNumber","dispatchedAt","createdByUserId") VALUES($1,'ROYAL_MAIL','Royal Mail','AB123456789GB',now(),$2) RETURNING id`,[order,user])).rows[0].id;
  await s.c.query(`INSERT INTO "ShipmentTrackingEvent"("shipmentId",carrier,"providerIdentity","providerEventId","trackingNumber","occurredAt",source,verified,status,"providerStatus",fingerprint,disposition)
    VALUES($1,'ROYAL_MAIL','fixture','legacy-event','AB123456789GB',now(),'TEST_FIXTURE',false,'UNKNOWN','UNMAPPED',repeat('a',64),'UNKNOWN')`,[shipment]);
  const before=(await s.c.query('SELECT row_to_json(t) AS data FROM "ShipmentTrackingEvent" t')).rows[0].data;
  const injected=sql(remediation).replace(/COMMIT;\s*$/,()=>`DO $$ BEGIN RAISE EXCEPTION 'Injected remediation failure'; END $$; COMMIT;`);
  await assert.rejects(s.c.query(injected),(error:unknown)=>(error as {code:string}).code==="P0001");await s.c.query('ROLLBACK');
  assert.equal((await s.c.query(`SELECT to_regclass('"ShipmentCarrierEvidence"') IS NULL AS absent`)).rows[0].absent,true);
  assert.deepEqual((await s.c.query('SELECT row_to_json(t) AS data FROM "ShipmentTrackingEvent" t')).rows[0].data,before);
  await s.c.query(sql(remediation));
  const after=(await s.c.query('SELECT row_to_json(t) AS data FROM "ShipmentTrackingEvent" t')).rows[0].data;
  const {evidenceId,evaluationKey,...preserved}=after;assert.equal(evidenceId,null);assert.equal(evaluationKey,'legacy');assert.deepEqual(preserved,before);
  assert.equal((await s.c.query('SELECT count(*)::int AS n FROM "ShipmentCarrierEvidence"')).rows[0].n,0);
 }finally{await s.close();}
});
