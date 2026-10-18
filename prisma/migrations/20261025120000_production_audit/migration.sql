BEGIN;
SET LOCAL lock_timeout='5s';
-- No financial history is rewritten. Ambiguous duplicate FBA history blocks rollout.
ALTER TABLE "FbaOutbound" ADD COLUMN "productListingId" INTEGER,
 ADD COLUMN "actualQuantity" INTEGER, ADD COLUMN "appliedQuantity" INTEGER, ADD COLUMN shortfall INTEGER;
UPDATE "FbaOutbound" f SET "actualQuantity"=-m."quantityChange","appliedQuantity"=-m."quantityChange",shortfall=0 FROM "InventoryMovement" m WHERE m.id=f."movementId";
ALTER TABLE "FbaOutbound" ALTER COLUMN "actualQuantity" SET NOT NULL, ALTER COLUMN "appliedQuantity" SET NOT NULL, ALTER COLUMN shortfall SET NOT NULL;
ALTER TABLE "FbaOutbound" ADD CONSTRAINT fba_actual_quantity CHECK ("actualQuantity">0 AND "appliedQuantity">=0 AND shortfall>=0 AND "actualQuantity"="appliedQuantity"+shortfall);
UPDATE "FbaOutbound" f SET "productListingId"=m."listingId" FROM "InventoryMovement" m WHERE m.id=f."movementId";
ALTER TABLE "FbaOutbound" ALTER COLUMN "productListingId" SET NOT NULL;
ALTER TABLE "FbaOutbound" ADD CONSTRAINT "FbaOutbound_productListingId_fkey" FOREIGN KEY ("productListingId") REFERENCES "ProductListing"(id) ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "FbaOutbound_shipment_listing_key" ON "FbaOutbound" ("shipmentReference","productListingId");
ALTER TABLE "Refund" ALTER COLUMN "performedByUserId" DROP NOT NULL;
ALTER TABLE "Refund" ADD COLUMN "reviewRevision" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "OperationalAudit" (
 id BIGSERIAL PRIMARY KEY, kind TEXT NOT NULL, "actorId" INTEGER,
 "orderId" INTEGER,
 "refundId" INTEGER,
 revision INTEGER, "requestKey" TEXT UNIQUE, "requestHash" TEXT, details JSONB NOT NULL,
 "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "OperationalAudit_refund_id" ON "OperationalAudit"("refundId",id);
CREATE FUNCTION operational_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'Operational audit records are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER operational_audit_immutable BEFORE UPDATE OR DELETE ON "OperationalAudit" FOR EACH ROW EXECUTE FUNCTION operational_audit_immutable();
CREATE FUNCTION refund_review_revision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW."reviewRequired" AND (NOT OLD."reviewRequired" OR NEW."reviewEvidence" IS DISTINCT FROM OLD."reviewEvidence") THEN
  NEW."reviewRevision"=OLD."reviewRevision"+1;
  INSERT INTO "OperationalAudit" (kind,"orderId","refundId",revision,details) VALUES (
   CASE WHEN NOT OLD."reviewRequired" AND OLD."reviewRevision">0 THEN 'REFUND_REVIEW_REOPENED' ELSE 'REFUND_REVIEW_OPENED' END,
   NEW."orderId",NEW.id,NEW."reviewRevision",jsonb_build_object('resolutionCode',NEW."resolutionCode",'evidence',NEW."reviewEvidence",'previousRevision',OLD."reviewRevision"));
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER refund_review_revision BEFORE UPDATE ON "Refund" FOR EACH ROW EXECUTE FUNCTION refund_review_revision();
CREATE FUNCTION refund_observed_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD."providerOutcome" IS NOT NULL AND (NEW.status<>OLD.status OR NEW.amount<>OLD.amount OR NEW.currency<>OLD.currency
  OR NEW."paymentId"<>OLD."paymentId" OR NEW."orderId"<>OLD."orderId" OR NEW.provider<>OLD.provider OR NEW."providerReference"<>OLD."providerReference") THEN
 RAISE EXCEPTION 'Observed refund identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER refund_observed_identity_immutable BEFORE UPDATE ON "Refund" FOR EACH ROW EXECUTE FUNCTION refund_observed_identity_immutable();
COMMIT;
