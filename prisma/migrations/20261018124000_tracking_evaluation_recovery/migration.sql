BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE "ShipmentCarrierEvidence" (
 id SERIAL PRIMARY KEY,
 "shipmentId" INT NOT NULL REFERENCES "Shipment"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 carrier "ShippingCarrier" NOT NULL,
 "providerIdentity" VARCHAR(80) NOT NULL,
 "providerEventId" VARCHAR(128) NOT NULL,
 "trackingNumber" VARCHAR(100) NOT NULL,
 "occurredAt" TIMESTAMPTZ(3) NOT NULL,
 "providerStatus" VARCHAR(128) NOT NULL,
 "deliveryAt" TIMESTAMPTZ(3),
 "evidenceReference" VARCHAR(128),
 fingerprint VARCHAR(64) NOT NULL,
 "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX tracking_carrier_evidence_key ON "ShipmentCarrierEvidence"("shipmentId","providerIdentity","providerEventId");
-- Preserve prior event rows and their fingerprints exactly. Lazy evidence adoption on re-observation
-- uses the original stable fields; legacy rows remain immutable and auditable.
ALTER TABLE "ShipmentTrackingEvent" ADD COLUMN "evidenceId" INT REFERENCES "ShipmentCarrierEvidence"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 ADD COLUMN "evaluationKey" VARCHAR(64) NOT NULL DEFAULT 'legacy';
DROP INDEX "ShipmentTrackingEvent_shipmentId_providerIdentity_providerE_key";
CREATE UNIQUE INDEX tracking_event_evaluation_key ON "ShipmentTrackingEvent"("shipmentId","providerIdentity","providerEventId","evaluationKey");
ALTER TABLE "ShipmentTrackingEvent" DROP CONSTRAINT tracking_applied_evidence;
ALTER TABLE "ShipmentTrackingEvent" ADD CONSTRAINT tracking_applied_evidence CHECK (
 disposition <> 'APPLIED' OR (verified AND "occurredAt" <= "receivedAt" + interval '5 seconds' AND status <> 'UNKNOWN'
 AND (status <> 'DELIVERED' OR ("deliveryConfirmed" AND "deliveryAt" IS NOT NULL
 AND "deliveryAt"="occurredAt" AND COALESCE(length("evidenceReference"),0)>0))));
CREATE FUNCTION tracking_evaluation_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e "ShipmentCarrierEvidence";
BEGIN
 IF NEW."evidenceId" IS NOT NULL THEN
  SELECT * INTO e FROM "ShipmentCarrierEvidence" WHERE id=NEW."evidenceId";
  IF e."shipmentId" IS DISTINCT FROM NEW."shipmentId" OR e.carrier IS DISTINCT FROM NEW.carrier
   OR e."providerIdentity" IS DISTINCT FROM NEW."providerIdentity" OR e."providerEventId" IS DISTINCT FROM NEW."providerEventId"
   OR e."trackingNumber" IS DISTINCT FROM NEW."trackingNumber" OR e."occurredAt" IS DISTINCT FROM NEW."occurredAt"
   OR e."providerStatus" IS DISTINCT FROM NEW."providerStatus" OR e."deliveryAt" IS DISTINCT FROM NEW."deliveryAt"
   OR e."evidenceReference" IS DISTINCT FROM NEW."evidenceReference" OR e.fingerprint IS DISTINCT FROM NEW.fingerprint THEN
   RAISE EXCEPTION 'Evaluation must match immutable carrier evidence' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tracking_evaluation_evidence_guard BEFORE INSERT ON "ShipmentTrackingEvent" FOR EACH ROW EXECUTE FUNCTION tracking_evaluation_evidence_guard();
CREATE FUNCTION tracking_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Tracking evidence is append-only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER tracking_raw_immutable BEFORE UPDATE ON "ShipmentCarrierEvidence" FOR EACH ROW EXECUTE FUNCTION tracking_append_only();
CREATE TRIGGER tracking_raw_no_delete BEFORE DELETE ON "ShipmentCarrierEvidence" FOR EACH STATEMENT EXECUTE FUNCTION tracking_append_only();
CREATE TRIGGER tracking_raw_no_truncate BEFORE TRUNCATE ON "ShipmentCarrierEvidence" FOR EACH STATEMENT EXECUTE FUNCTION tracking_append_only();
CREATE TRIGGER tracking_event_no_delete BEFORE DELETE ON "ShipmentTrackingEvent" FOR EACH STATEMENT EXECUTE FUNCTION tracking_append_only();
CREATE TRIGGER tracking_event_no_truncate BEFORE TRUNCATE ON "ShipmentTrackingEvent" FOR EACH STATEMENT EXECUTE FUNCTION tracking_append_only();
CREATE TRIGGER tracking_conflict_no_delete BEFORE DELETE ON "ShipmentTrackingConflict" FOR EACH STATEMENT EXECUTE FUNCTION tracking_append_only();
CREATE TRIGGER tracking_conflict_no_truncate BEFORE TRUNCATE ON "ShipmentTrackingConflict" FOR EACH STATEMENT EXECUTE FUNCTION tracking_append_only();
CREATE FUNCTION tracking_budget_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."minuteStartedAt"<OLD."minuteStartedAt" OR NEW."dayStartedAt"<OLD."dayStartedAt"
 OR (NEW."minuteStartedAt"=OLD."minuteStartedAt" AND NEW."minuteRequests"<OLD."minuteRequests")
 OR (NEW."dayStartedAt"=OLD."dayStartedAt" AND NEW."dayRequests"<OLD."dayRequests") THEN
  RAISE EXCEPTION 'Tracking budget cannot move backwards' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tracking_budget_monotonic BEFORE UPDATE ON "TrackingCarrierBudget" FOR EACH ROW EXECUTE FUNCTION tracking_budget_monotonic();
COMMIT;
