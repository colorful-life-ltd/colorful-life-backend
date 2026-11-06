import assert from "node:assert/strict";
import { before, after, beforeEach, afterEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";
import { validateTestDatabase } from "../config/testDatabase.js";

const target = validateTestDatabase(process.env);
const root = "prisma/migrations";
const names = readdirSync(root).filter(n => n !== "migration_lock.toml").sort();
const foundation = "20261013120000_payment_resolution_foundation";
const backfillName = "20261013121000_payment_resolution_historical_backfill";
assert.ok(names.includes(foundation), "Foundation migration must exist");
assert.ok(names.includes(backfillName), "Historical backfill migration must exist");
assert.ok(names.indexOf(foundation) < names.indexOf(backfillName), "Foundation migration must precede historical backfill");
const ddl = readFileSync(`${root}/${foundation}/migration.sql`, "utf8");
const backfill = readFileSync(`${root}/${backfillName}/migration.sql`, "utf8");
const sql = ddl + backfill;
async function sandbox() {
  const c = new pg.Client({ connectionString: target.url }); await c.connect();
  const schema = `foundation_${randomUUID().replaceAll("-", "")}`;
  await c.query(`CREATE SCHEMA "${schema}"`); await c.query(`SET search_path TO "${schema}"`);
  return { c, async close() { await c.query(`DROP SCHEMA "${schema}" CASCADE`); await c.end(); } };
}
async function baseline(c: pg.Client) {
  for (const name of names.filter(n => n < foundation)) await c.query(readFileSync(`${root}/${name}/migration.sql`, "utf8"));
}
async function order(c: pg.Client, status = "PENDING") {
  const u = await c.query(`INSERT INTO "User" (email,"passwordHash","updatedAt") VALUES ($1,'fixture',now()) RETURNING id`, [`${randomUUID()}@example.test`]);
  const fields = ["billingRecipientName","billingLine1","billingCity","billingPostcode","billingCountryCode","deliveryRecipientName","deliveryLine1","deliveryCity","deliveryPostcode","deliveryCountryCode"];
  const r = await c.query(`INSERT INTO "Order" ("userId",status,"totalAmount","updatedAt","createdAt","reservationExpiresAt",${fields.map(f => `"${f}"`).join(',')}) VALUES ($1,$2,10,now(),'2026-01-01 12:00','2026-01-01 12:30',${fields.map(() => "'fixture'").join(',')}) RETURNING *`, [u.rows[0].id, status]);
  return r.rows[0];
}
async function rejects(c: pg.Client, statement: string, values: unknown[] = [], code = "23514", constraint?: string) {
  await c.query("SAVEPOINT invalid");
  try { await assert.rejects(c.query(statement, values), (e: unknown) => (e as { code?: string }).code === code && (!constraint || (e as {constraint?: string}).constraint === constraint)); }
  finally { await c.query("ROLLBACK TO SAVEPOINT invalid"); await c.query("RELEASE SAVEPOINT invalid"); }
}
it("migrates the complete history on an empty isolated PostgreSQL schema", async () => {
  const s = await sandbox(); try { await baseline(s.c); await s.c.query(sql);
    assert.equal((await s.c.query('SELECT count(*)::int AS n FROM "PaymentResolution"')).rows[0].n, 0);
    assert.equal((await s.c.query('SELECT count(*)::int AS n FROM "PaymentAttempt"')).rows[0].n, 0);
  } finally { await s.close(); }
});

it("rolls back failed DDL and failed backfill without changing legacy records", async () => {
  const s=await sandbox();try {
    await baseline(s.c);await order(s.c);
    const previous=(await s.c.query('SELECT row_to_json(o) FROM "Order" o')).rows;
    const injected=`DO $$ BEGIN RAISE EXCEPTION 'Injected migration failure'; END $$;\nCOMMIT;`;
    await assert.rejects(s.c.query(ddl.replace(/COMMIT;\s*$/,injected)));await s.c.query("ROLLBACK");
    assert.equal((await s.c.query(`SELECT to_regclass('"PaymentResolution"') AS value`)).rows[0].value,null);
    assert.deepEqual((await s.c.query('SELECT row_to_json(o) FROM "Order" o')).rows,previous);
    await s.c.query(ddl);
    await assert.rejects(s.c.query(backfill.replace(/COMMIT;\s*$/,injected)));await s.c.query("ROLLBACK");
    assert.equal((await s.c.query('SELECT count(*)::int AS n FROM "PaymentResolution"')).rows[0].n,0);
    assert.deepEqual((await s.c.query('SELECT row_to_json(o) FROM "Order" o')).rows,previous);
    await s.c.query(backfill);assert.equal((await s.c.query('SELECT count(*)::int AS n FROM "PaymentResolution"')).rows[0].n,1);
  } finally {await s.close();}
});

describe("foundation historical backfill and PostgreSQL enforcement", () => {
  let s: Awaited<ReturnType<typeof sandbox>>, c: pg.Client, unpaid: number, paid: number, beforeRows: unknown, beforeStock: unknown, beforePayments: unknown, beforeWebhooks: unknown;
  before(async () => {
    s = await sandbox(); c = s.c; await baseline(c);
    const a = await order(c), b = await order(c, "EXPIRED"), d = await order(c, "CONFIRMED"); unpaid = a.id; paid = d.id;
    for (const [id,status,ref] of [[a.id,"FAILED","pending:old"],[b.id,"CANCELED","old-intent"],[d.id,"SUCCEEDED","paid-intent"]]) {
      await c.query(`INSERT INTO "Payment" ("orderId",amount,currency,provider,"providerReference",status,"paidAt","updatedAt") VALUES ($1,10,'GBP','STRIPE',$2,$3,CASE WHEN $3::"PaymentStatus"='SUCCEEDED' THEN now() ELSE NULL END,now())`, [id,ref,status]);
    }
    const p = await c.query(`INSERT INTO "LegoProduct" ("setNumber",title,theme,"ageRecommendation","pieceCount","updatedAt") VALUES ('foundation','fixture','TEST','8+',10,now()) RETURNING id`);
    await c.query(`INSERT INTO "ProductListing" ("legoProductId",condition,"originalPrice","currentStock","reservedStock","updatedAt") VALUES ($1,'NEW',10,20,2,now())`,[p.rows[0].id]);
    await c.query(`INSERT INTO "PaymentWebhookEvent" (provider,"providerEventId","eventType",evidence) VALUES ('PAYPAL','historical-receipt','PAYMENT.CAPTURE.COMPLETED','{"version":1,"captureId":"old-capture"}')`);
    beforePayments=(await c.query('SELECT row_to_json(p) AS data FROM "Payment" p ORDER BY id')).rows;
    beforeWebhooks=(await c.query('SELECT row_to_json(e) AS data FROM "PaymentWebhookEvent" e ORDER BY id')).rows;
    beforeRows = (await c.query('SELECT row_to_json(o) AS data FROM "Order" o ORDER BY id')).rows;
    beforeStock = (await c.query('SELECT row_to_json(p) AS data FROM "ProductListing" p ORDER BY id')).rows;
    await c.query(sql);
  });
  after(async () => { if (s) await s.close(); });
  beforeEach(async () => { await c.query("BEGIN"); });
  afterEach(async () => { await c.query("ROLLBACK"); });
  async function eligible(kind: "FAILURE" | "SUCCESS" | "TERMINAL_UNPAID" = "FAILURE", provider: "STRIPE" = "STRIPE") {
    const o=await order(c);
    const p=await c.query(`INSERT INTO "Payment" ("orderId",amount,currency,provider,"providerReference",status,"updatedAt") VALUES ($1,10,'GBP','${provider}',$2,'FAILED',now()) RETURNING id`,[o.id,`pi_${randomUUID()}`]);
    await c.query(`INSERT INTO "PaymentResolution" ("orderId","orderCreatedAt","initialPaymentDeadline","reservationDisposition","dispositionAt") VALUES ($1,'2026-01-01 12:00+00','2026-01-01 12:30+00','HELD','2026-01-01 12:00+00')`,[o.id]);
    const a=await c.query(`INSERT INTO "PaymentAttempt" ("orderId","paymentId",provider,amount,currency,"creationKey","admittedAt") VALUES ($1,$2,'${provider}',10,'GBP',$3,'2026-01-01 12:10+00') RETURNING id`,[o.id,p.rows[0].id,randomUUID()]);
    const op=await c.query(`INSERT INTO "PaymentOperation" ("attemptId",type,"operationKey","requestHash","admittedAt","admissionDeadline") VALUES ($1,'CONFIRM',$2,$3,'2026-01-01 12:10+00','2026-01-01 12:30+00') RETURNING id`,[a.rows[0].id,randomUUID(),'a'.repeat(64)]);
    await c.query(`UPDATE "PaymentOperation" SET state='POTENTIALLY_DISPATCHED' WHERE id=$1`,[op.rows[0].id]);
    const ev=await c.query(`INSERT INTO "FinancialEvidence" ("orderId",provider,"evidenceKey",kind,normalized,"verifiedAt","operationId") VALUES ($1,'${provider}',$2,$3,'{}','2026-01-05 12:00+00',$4) RETURNING id`,[o.id,randomUUID(),kind,op.rows[0].id]);
    await c.query(`UPDATE "PaymentOperation" SET state='RESULT_RECORDED',"evidenceId"=$2 WHERE id=$1`,[op.rows[0].id,ev.rows[0].id]);
    return {orderId:o.id,attemptId:a.rows[0].id,opId:op.rows[0].id,evidenceId:ev.rows[0].id};
  }
  const openFailure=`UPDATE "PaymentResolution" SET "firstFailureVerifiedAt"='2026-01-05 12:00+00',"retryDeadline"='2026-01-05 12:30+00',"firstFailureEvidenceId"=$2,"firstFailureOperationId"=$3,state='RETRY_OPEN' WHERE "orderId"=$1`;
  it("quarantines history without inventing admission, failure, retry or finality", async () => {
    const resolutions=(await c.query('SELECT * FROM "PaymentResolution"')).rows;assert.equal(resolutions.length,3);
    for(const r of resolutions){assert.equal(r.state,"REVIEW_REQUIRED");assert.equal(r.reservationDisposition,null);assert.equal(r.firstFailureVerifiedAt,null);assert.equal(r.firstFailureOperationId,null);assert.equal(r.retryDeadline,null);assert.ok(r.quarantineReason);}
    for(const a of (await c.query('SELECT * FROM "PaymentAttempt"')).rows){assert.equal(a.admittedAt,null);assert.equal(a.finalityEvidenceId,null);}
    const ops=(await c.query('SELECT * FROM "PaymentOperation"')).rows;assert.equal(ops.length,3);for(const op of ops){assert.equal(op.state,"UNKNOWN");assert.equal(op.admittedAt,null);}
    for(const e of (await c.query('SELECT * FROM "FinancialEvidence"')).rows){assert.equal(e.kind,"HISTORICAL_UNVERIFIED");assert.equal(e.verifiedAt,null);}
  });
  it("replaying backfill preserves identities even for NULL placeholder keys", async () => {
    const previous=(await c.query('SELECT row_to_json(a) AS data FROM "PaymentAttempt" a ORDER BY id')).rows;
    await c.query(backfill.replace(/^BEGIN[^;]*;/,'').replace(/COMMIT;\s*$/,''));
    assert.deepEqual((await c.query('SELECT row_to_json(a) AS data FROM "PaymentAttempt" a ORDER BY id')).rows,previous);
    assert.equal((await c.query('SELECT count(*)::int AS n FROM "PaymentOperation"')).rows[0].n,3);
  });
  it("preserves complete Order, Payment, stock and webhook evidence", async () => {
    for(const [table,expected] of [["Order",beforeRows],["ProductListing",beforeStock],["Payment",beforePayments],["PaymentWebhookEvent",beforeWebhooks]] as const)
      assert.deepEqual((await c.query(`SELECT row_to_json(t) AS data FROM "${table}" t ORDER BY id`)).rows,expected);
  });
  it("rejects RELEASED on INSERT and UPDATE, including missing coverage", async () => {
    const o=await order(c); // existing binary: Payment exists without foundation coverage
    await c.query(`INSERT INTO "Payment" ("orderId",amount,currency,provider,"providerReference",status,"updatedAt") VALUES ($1,10,'GBP','STRIPE','uncovered-payment','PROCESSING',now())`,[o.id]);
    await rejects(c,`INSERT INTO "PaymentResolution" ("orderId",state,"orderCreatedAt","initialPaymentDeadline","reservationDisposition","dispositionAt","paymentAdmissionClosedAt","closureReason") VALUES ($1,'RELEASED','2026-01-01 12:00+00','2026-01-01 12:30+00','RELEASED',now(),now(),'test')`,[o.id],"23514","phase2a_no_release");
    await rejects(c,`UPDATE "PaymentResolution" SET "reservationDisposition"='RELEASED',"dispositionAt"=now(),state='RELEASED',"paymentAdmissionClosedAt"=now(),"closureReason"='test' WHERE "orderId"=$1`,[unpaid],"23514","phase2a_no_release");
    await rejects(c,`UPDATE "PaymentResolution" SET state='RELEASED' WHERE "orderId"=$1`,[unpaid],"23514","phase2a_no_release");
  });
  it("rejects release even with recorded financial success and a structurally valid proof", async () => {
    const f=await eligible("SUCCESS");
    const ev=await c.query(`INSERT INTO "FinancialEvidence" ("orderId",provider,"evidenceKey",kind,normalized,"verifiedAt","operationId") VALUES ($1,'STRIPE',$2,'TERMINAL_UNPAID','{}',now(),$3) RETURNING id`,[f.orderId,randomUUID(),f.opId]);
    const proof=await c.query(`INSERT INTO "ReservationReleaseProof" ("orderId","evidenceId","decisionVersion",coverage) VALUES ($1,$2,1,'{}') RETURNING id`,[f.orderId,ev.rows[0].id]);
    await rejects(c,`UPDATE "PaymentResolution" SET state='RELEASED',"reservationDisposition"='RELEASED',"dispositionAt"=now(),"releaseProofId"=$2,"paymentAdmissionClosedAt"=now(),"closureReason"='test' WHERE "orderId"=$1`,[f.orderId,proof.rows[0].id],"23514","phase2a_no_release");
  });
  it("accepts eligible days-late failure with exactly thirty minutes and immutable deadlines", async () => {
    const f=await eligible();await c.query(openFailure,[f.orderId,f.evidenceId,f.opId]);
    const r=(await c.query('SELECT * FROM "PaymentResolution" WHERE "orderId"=$1',[f.orderId])).rows[0];assert.equal(r.retryDeadline-r.firstFailureVerifiedAt,1800000);
    await rejects(c,`UPDATE "PaymentResolution" SET "retryDeadline"="retryDeadline"+interval '1 minute' WHERE "orderId"=$1`,[f.orderId]);
    await rejects(c,`UPDATE "PaymentResolution" SET "firstFailureVerifiedAt"=NULL,"retryDeadline"=NULL,"firstFailureEvidenceId"=NULL,"firstFailureOperationId"=NULL WHERE "orderId"=$1`,[f.orderId]);
    await rejects(c,`UPDATE "PaymentResolution" SET "initialPaymentDeadline"="initialPaymentDeadline"+interval '1 minute' WHERE "orderId"=$1`,[f.orderId]);
  });
  it("rejects historical UNKNOWN admission and out-of-window new admission", async () => {
    const op=(await c.query(`SELECT op.id FROM "PaymentOperation" op JOIN "PaymentAttempt" a ON a.id=op."attemptId" WHERE a."orderId"=$1`,[unpaid])).rows[0];
    const ev=await c.query(`INSERT INTO "FinancialEvidence" ("orderId",provider,"evidenceKey",kind,normalized,"verifiedAt","operationId") VALUES ($1,'STRIPE','historical-failure','FAILURE','{}','2026-01-05 12:00+00',$2) RETURNING id`,[unpaid,op.id]);
    await c.query(`UPDATE "PaymentResolution" SET "reservationDisposition"='HELD',"dispositionAt"=now() WHERE "orderId"=$1`,[unpaid]);
    await c.query(`UPDATE "PaymentOperation" SET state='RESULT_RECORDED',"evidenceId"=$2 WHERE id=$1`,[op.id,ev.rows[0].id]);
    await rejects(c,openFailure,[unpaid,ev.rows[0].id,op.id]);
    const f=await eligible();await rejects(c,`INSERT INTO "PaymentOperation" ("attemptId",type,"operationKey","requestHash","admittedAt","admissionDeadline") VALUES ($1,'CONFIRM','too-late',$2,'2026-01-01 12:30+00','2026-01-01 12:30+00')`,[f.attemptId,'b'.repeat(64)]);
  });
  it("actually tests permanent closure, paid and terminal order eligibility", async () => {
    const f=await eligible();await c.query(`UPDATE "PaymentResolution" SET state='CLOSED_RESOLVING',"paymentAdmissionClosedAt"=now(),"closureReason"='EXPLICIT_ABANDONMENT' WHERE "orderId"=$1`,[f.orderId]);
    await rejects(c,openFailure,[f.orderId,f.evidenceId,f.opId]);
    await rejects(c,`UPDATE "PaymentResolution" SET "paymentAdmissionClosedAt"=NULL,"closureReason"=NULL WHERE "orderId"=$1`,[f.orderId]);
    for(const status of ["CANCELLED","EXPIRED"]){const x=await eligible();await c.query(`UPDATE "Order" SET status=$2 WHERE id=$1`,[x.orderId,status]);await rejects(c,openFailure,[x.orderId,x.evidenceId,x.opId]);}
    const p=await eligible();await c.query(`UPDATE "Payment" SET status='SUCCEEDED',"paidAt"=now() WHERE "orderId"=$1`,[p.orderId]);await rejects(c,openFailure,[p.orderId,p.evidenceId,p.opId]);
  });
  it("does not open first retry when durable success precedes aggregate projection", async () => {
    const f=await eligible();await c.query(`INSERT INTO "FinancialEvidence" ("orderId",provider,"evidenceKey",kind,normalized,"verifiedAt","operationId") VALUES ($1,'STRIPE','late-success','SUCCESS','{}',now(),$2)`,[f.orderId,f.opId]);
    await rejects(c,openFailure,[f.orderId,f.evidenceId,f.opId]);
  });
  it("rejects cross-provider receipts on insertion and later binding", async () => {
    const f=await eligible();const wh=(await c.query(`SELECT id FROM "PaymentWebhookEvent" WHERE "providerEventId"='historical-receipt'`)).rows[0];
    await rejects(c,`INSERT INTO "FinancialEvidence" ("orderId",provider,"evidenceKey",kind,normalized,"verifiedAt","operationId","webhookEventId") VALUES ($1,'STRIPE','bad-source','FAILURE','{}',now(),$2,$3)`,[f.orderId,f.opId,wh.id]);
    await rejects(c,`UPDATE "FinancialEvidence" SET "webhookEventId"=$2 WHERE id=$1`,[f.evidenceId,wh.id]);
  });
  it("rejects cross-order operation evidence and primary identity mutation", async () => {
    const f=await eligible(),g=await eligible();await rejects(c,`UPDATE "PaymentOperation" SET "evidenceId"=$2 WHERE id=$1`,[f.opId,g.evidenceId]);
    await rejects(c,`UPDATE "PaymentOperation" SET id=id+1000 WHERE id=$1`,[f.opId]);
    await rejects(c,`UPDATE "PaymentAttempt" SET id=id+1000 WHERE id=$1`,[f.attemptId]);
    await rejects(c,`UPDATE "PaymentOperation" SET "operationKey"='changed' WHERE id=$1`,[f.opId]);
  });
  it("rejects counter regression and unsafe operation state regression", async () => {
    const f=await eligible();await c.query(`UPDATE "PaymentOperation" SET "claimGeneration"=5,"executionCount"=3 WHERE id=$1`,[f.opId]);
    await rejects(c,`UPDATE "PaymentOperation" SET "claimGeneration"=4 WHERE id=$1`,[f.opId]);
    await rejects(c,`UPDATE "PaymentOperation" SET "executionCount"=2 WHERE id=$1`,[f.opId]);
    for(const state of ["PREPARED","UNKNOWN","POTENTIALLY_DISPATCHED"])await rejects(c,`UPDATE "PaymentOperation" SET state=$2 WHERE id=$1`,[f.opId,state]);
  });
  it("enforces same-provider receipt identity when provider evidence is available", async () => {
    const f=await eligible();
    await c.query(`UPDATE "PaymentAttempt" SET "providerReference"='expected-object' WHERE id=$1`,[f.attemptId]);
    const wh=await c.query(`INSERT INTO "PaymentWebhookEvent" (provider,"providerEventId","eventType",evidence) VALUES ('STRIPE','wrong-object','payment_intent.payment_failed','{}') RETURNING id`);
    await rejects(c,`INSERT INTO "FinancialEvidence" ("orderId",provider,"evidenceKey",kind,normalized,"verifiedAt","operationId","webhookEventId") VALUES ($1,'STRIPE','wrong-identity','FAILURE','{"providerReference":"other-object"}',now(),$2,$3)`,[f.orderId,f.opId,wh.rows[0].id]);
  });
  it("rejects binding provider identity that conflicts with previously recorded evidence", async () => {
    const f=await eligible();
    await c.query(`INSERT INTO "FinancialEvidence" ("orderId",provider,"evidenceKey",kind,normalized,"verifiedAt","operationId") VALUES ($1,'STRIPE','binding-evidence','FAILURE','{"providerReference":"pi_expected"}',now(),$2)`,[f.orderId,f.opId]);
    await rejects(c,`UPDATE "PaymentAttempt" SET "providerReference"='pi_wrong' WHERE id=$1`,[f.attemptId]);
    await c.query(`UPDATE "PaymentAttempt" SET "providerReference"='pi_expected' WHERE id=$1`,[f.attemptId]);
  });
  it("production-style non-owner role cannot delete/reinsert or truncate audit history", async () => {
    const f=await eligible();const role=`foundation_runtime_${randomUUID().replaceAll("-","")}`;
    const schema=(await c.query('SELECT current_schema() AS name')).rows[0].name;
    await c.query(`CREATE ROLE "${role}" NOLOGIN`);
    // PostgreSQL 16 does not give a non-superuser creator SET membership automatically.
    // This synthetic membership is rolled back with the test; production grants are unchanged.
    await c.query(`GRANT "${role}" TO CURRENT_USER WITH SET TRUE`);
    await c.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
    await c.query(`GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
    await c.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`);
    await c.query(`SET LOCAL ROLE "${role}"`);
    try {
      await c.query(`UPDATE "PaymentOperation" SET "claimGeneration"=1 WHERE id=$1`,[f.opId]);
      for(const table of ["PaymentResolution","PaymentAttempt","PaymentOperation","FinancialEvidence","ReservationReleaseProof","Order","Payment","PaymentWebhookEvent"]){
        await rejects(c,`DELETE FROM "${table}"`,[],"42501");
        await rejects(c,`TRUNCATE "${table}" CASCADE`,[],"42501");
      }
    } finally {await c.query("RESET ROLE");} // enclosing rollback removes the test role
  });
  it("enforces unique identities and paired retry fields", async () => {
    const f=await eligible();await rejects(c,`INSERT INTO "PaymentResolution" SELECT * FROM "PaymentResolution" WHERE "orderId"=$1`,[f.orderId],"23505");
    await rejects(c,`INSERT INTO "PaymentOperation" ("attemptId",type,"operationKey","requestHash","admittedAt","admissionDeadline") SELECT "attemptId",type,"operationKey","requestHash","admittedAt","admissionDeadline" FROM "PaymentOperation" WHERE id=$1`,[f.opId],"23505");
    await rejects(c,`UPDATE "PaymentResolution" SET "firstFailureVerifiedAt"=now() WHERE "orderId"=$1`,[f.orderId]);
  });
});
