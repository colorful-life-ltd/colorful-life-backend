-- Additive only. Legacy FbaOutbound rows keep a NULL shipment header; no history is rewritten.
BEGIN;
SET LOCAL lock_timeout='5s';

CREATE TABLE "FbaShipment" (
    "id" SERIAL NOT NULL,
    "reference" VARCHAR(32) NOT NULL,
    "externalReference" VARCHAR(200),
    "note" TEXT,
    "lineFingerprint" VARCHAR(64) NOT NULL,
    "acknowledgedDuplicateShipmentIds" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
    "idempotencyKey" VARCHAR(128) NOT NULL,
    "requestHash" VARCHAR(64) NOT NULL,
    "performedByUserId" INTEGER NOT NULL,
    "lineCount" INTEGER NOT NULL,
    "totalUnits" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FbaShipment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "FbaShipment_reference_check" CHECK ("reference" ~ '^FBA-[0-9]{8}-[0-9]{4,}$'),
    -- Stored normalized so the unique index catches case/spacing variants of the same Amazon shipment ID.
    CONSTRAINT "FbaShipment_external_reference_check" CHECK ("externalReference" IS NULL OR (length("externalReference") > 0 AND "externalReference" = upper("externalReference") AND "externalReference" !~ '[[:space:]]')),
    CONSTRAINT "FbaShipment_fingerprint_check" CHECK ("lineFingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "FbaShipment_acknowledged_check" CHECK (array_position("acknowledgedDuplicateShipmentIds", NULL) IS NULL AND cardinality("acknowledgedDuplicateShipmentIds") <= 20),
    CONSTRAINT "FbaShipment_note_check" CHECK ("note" IS NULL OR (length(btrim("note")) > 0 AND length("note") <= 2000)),
    CONSTRAINT "FbaShipment_key_check" CHECK (length("idempotencyKey") > 0),
    CONSTRAINT "FbaShipment_totals_check" CHECK ("lineCount" > 0 AND "totalUnits" >= "lineCount")
);

CREATE TABLE "FbaShipmentSequence" (
    "day" DATE NOT NULL,
    "lastValue" INTEGER NOT NULL,

    CONSTRAINT "FbaShipmentSequence_pkey" PRIMARY KEY ("day"),
    CONSTRAINT "FbaShipmentSequence_value_check" CHECK ("lastValue" > 0)
);

ALTER TABLE "FbaOutbound" ADD COLUMN "fbaShipmentId" INTEGER;

CREATE UNIQUE INDEX "FbaShipment_reference_key" ON "FbaShipment"("reference");
CREATE UNIQUE INDEX "FbaShipment_idempotencyKey_key" ON "FbaShipment"("idempotencyKey");
-- NULLs stay distinct: shipments without an Amazon ID are unaffected.
CREATE UNIQUE INDEX "FbaShipment_externalReference_key" ON "FbaShipment"("externalReference");
CREATE INDEX "FbaShipment_lineFingerprint_createdAt_idx" ON "FbaShipment"("lineFingerprint", "createdAt");
CREATE INDEX "FbaShipment_createdAt_idx" ON "FbaShipment"("createdAt");
CREATE INDEX "FbaShipment_performedByUserId_idx" ON "FbaShipment"("performedByUserId");
CREATE INDEX "FbaOutbound_fbaShipmentId_idx" ON "FbaOutbound"("fbaShipmentId");

ALTER TABLE "FbaOutbound" ADD CONSTRAINT "FbaOutbound_fbaShipmentId_fkey" FOREIGN KEY ("fbaShipmentId") REFERENCES "FbaShipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FbaShipment" ADD CONSTRAINT "FbaShipment_performedByUserId_fkey" FOREIGN KEY ("performedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A recorded shipment is an audit fact: its reference and contents never change.
CREATE FUNCTION fba_shipment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'FbaShipment % is immutable', OLD.id USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER fba_shipment_immutable BEFORE UPDATE ON "FbaShipment"
 FOR EACH ROW EXECUTE FUNCTION fba_shipment_immutable();

-- A line's shipment header is fixed once set (legacy NULL rows stay NULL).
CREATE FUNCTION fba_outbound_shipment_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."fbaShipmentId" IS DISTINCT FROM OLD."fbaShipmentId" THEN
  RAISE EXCEPTION 'FbaOutbound % shipment header cannot change', OLD.id USING ERRCODE = 'check_violation';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER fba_outbound_shipment_fixed BEFORE UPDATE ON "FbaOutbound"
 FOR EACH ROW EXECUTE FUNCTION fba_outbound_shipment_fixed();

COMMIT;
