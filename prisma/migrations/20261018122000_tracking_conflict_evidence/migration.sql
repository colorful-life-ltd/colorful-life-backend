BEGIN;
SET LOCAL lock_timeout='5s';
CREATE TABLE "ShipmentTrackingConflict" (
 id SERIAL PRIMARY KEY,
 "originalEventId" INT NOT NULL REFERENCES "ShipmentTrackingEvent"(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 fingerprint VARCHAR(64) NOT NULL,
 source "TrackingEvidenceSource" NOT NULL,
 verified BOOLEAN NOT NULL,
 normalized JSONB NOT NULL,
 "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT tracking_conflict_test_database CHECK (source <> 'TEST_FIXTURE' OR current_database()='colorful_life_test')
);
CREATE UNIQUE INDEX "ShipmentTrackingConflict_originalEventId_fingerprint_key" ON "ShipmentTrackingConflict"("originalEventId",fingerprint);
CREATE FUNCTION tracking_conflict_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Tracking conflict evidence is immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER tracking_conflict_immutable BEFORE UPDATE ON "ShipmentTrackingConflict" FOR EACH ROW EXECUTE FUNCTION tracking_conflict_immutable();
COMMIT;
