BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL timezone='UTC';
CREATE TABLE "ReturnCase" (
 id TEXT PRIMARY KEY, "orderId" INTEGER NOT NULL UNIQUE REFERENCES "Order"(id) ON DELETE CASCADE,
 reference TEXT NOT NULL UNIQUE, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE TABLE "ReturnSubmission" (
 id TEXT PRIMARY KEY, "caseId" TEXT NOT NULL REFERENCES "ReturnCase"(id) ON DELETE CASCADE,
 "idempotencyKey" TEXT NOT NULL, "requestHash" TEXT NOT NULL,
 "requestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now(), UNIQUE("caseId","idempotencyKey")
);
ALTER TABLE "OrderReturn" ADD COLUMN "submissionId" TEXT REFERENCES "ReturnSubmission"(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
 ADD COLUMN instructions JSONB, ADD COLUMN "rejectionNote" TEXT, ADD COLUMN "decisionByUserId" INTEGER REFERENCES "User"(id) ON DELETE RESTRICT,
 ADD COLUMN "receivedByUserId" INTEGER REFERENCES "User"(id) ON DELETE RESTRICT, ADD COLUMN "receiptNote" TEXT;
CREATE INDEX "OrderReturn_submissionId_idx" ON "OrderReturn"("submissionId");
-- Preserve every historical line/date/state/counter; create no notifications or inventory movements.
INSERT INTO "ReturnCase" (id,"orderId",reference,"createdAt")
 SELECT 'return-case-'||i."orderId",i."orderId",'BB-R-'||i."orderId",min(r."requestedAt")
 FROM "OrderReturn" r JOIN "OrderItem" i ON i.id=r."orderItemId" GROUP BY i."orderId";
INSERT INTO "ReturnSubmission" (id,"caseId","idempotencyKey","requestHash","requestedAt")
 SELECT 'return-legacy-'||r.id,'return-case-'||i."orderId",'legacy-'||r.id,'LEGACY',r."requestedAt"
 FROM "OrderReturn" r JOIN "OrderItem" i ON i.id=r."orderItemId";
UPDATE "OrderReturn" SET "submissionId"='return-legacy-'||id;
CREATE FUNCTION return_case_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Return case/submission identity is permanent' USING ERRCODE='23514'; END $$;
CREATE TRIGGER return_case_immutable BEFORE UPDATE ON "ReturnCase" FOR EACH ROW EXECUTE FUNCTION return_case_immutable();
CREATE TRIGGER return_submission_immutable BEFORE UPDATE ON "ReturnSubmission" FOR EACH ROW EXECUTE FUNCTION return_case_immutable();
CREATE FUNCTION return_submission_order_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."submissionId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "ReturnSubmission" s JOIN "ReturnCase" c ON c.id=s."caseId" JOIN "OrderItem" i ON i."orderId"=c."orderId"
  WHERE s.id=NEW."submissionId" AND i.id=NEW."orderItemId") THEN
  RAISE EXCEPTION 'Return submission/order mismatch' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD."submissionId" IS NOT NULL AND NEW."submissionId" IS DISTINCT FROM OLD."submissionId" THEN
  RAISE EXCEPTION 'Return submission is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER return_submission_order_guard BEFORE INSERT OR UPDATE ON "OrderReturn" FOR EACH ROW EXECUTE FUNCTION return_submission_order_guard();
-- Rollback compatibility: a previous application image inserts lines without a submission. Attach each one,
-- atomically with its insert, to the order's permanent case (created if absent, exactly like the backfill) and a
-- deterministic per-line legacy submission. Explicit submissions are never touched. No counters, stock or jobs change.
-- Fires before return_submission_order_guard (BEFORE triggers run in name order), which still validates the result.
CREATE FUNCTION return_legacy_attach() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_id integer; case_id text;
BEGIN
 IF NEW."submissionId" IS NOT NULL THEN RETURN NEW; END IF;
 SELECT "orderId" INTO order_id FROM "OrderItem" WHERE id=NEW."orderItemId";
 IF order_id IS NULL THEN RETURN NEW; END IF; -- the orderItemId foreign key rejects the insert
 INSERT INTO "ReturnCase" (id,"orderId",reference,"createdAt")
  VALUES ('return-case-'||order_id,order_id,'BB-R-'||order_id,NEW."requestedAt") ON CONFLICT DO NOTHING;
 SELECT id INTO case_id FROM "ReturnCase" WHERE "orderId"=order_id;
 IF case_id IS NULL THEN
  RAISE EXCEPTION 'Return case for order % is not yet visible; retry', order_id USING ERRCODE='40001'; END IF;
 INSERT INTO "ReturnSubmission" (id,"caseId","idempotencyKey","requestHash","requestedAt")
  VALUES ('return-legacy-'||NEW.id,case_id,'legacy-'||NEW.id,'LEGACY',NEW."requestedAt");
 NEW."submissionId" := 'return-legacy-'||NEW.id;
 RETURN NEW; END $$;
CREATE TRIGGER return_legacy_attach BEFORE INSERT ON "OrderReturn" FOR EACH ROW EXECUTE FUNCTION return_legacy_attach();
ALTER TABLE "OrderConfirmationJob" DROP CONSTRAINT email_event_identity;
ALTER TABLE "OrderConfirmationJob" ADD CONSTRAINT email_event_identity CHECK (
 (type='ORDER_CONFIRMATION' AND "shipmentId" IS NULL AND "eventKey"='order:'||"orderId"::text)
 OR (type='DISPATCH_CONFIRMATION' AND "shipmentId" IS NOT NULL AND "eventKey"='shipment:'||"shipmentId"::text
  AND (source->>'shipmentId'="shipmentId"::text AND source->>'orderId'="orderId"::text) IS TRUE)
 OR (type='RETURN_AUTHORIZATION' AND "shipmentId" IS NULL AND "eventKey"='return:'||(source->>'returnId')
  AND (source->>'orderId'="orderId"::text AND source->>'returnId' IS NOT NULL) IS TRUE)
);
COMMIT;
