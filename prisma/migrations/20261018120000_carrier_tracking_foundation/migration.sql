-- Issue #167: additive, no historical backfill or financial/stock mutation. PostgreSQL 12+.
BEGIN;
SET LOCAL lock_timeout='5s';
-- CreateEnum
CREATE TYPE "TrackingStatus" AS ENUM ('UNKNOWN', 'DISPATCHED', 'IN_TRANSIT', 'DELIVERED', 'EXCEPTION');

-- CreateEnum
CREATE TYPE "TrackingEvidenceSource" AS ENUM ('AUTHENTICATED_API', 'VERIFIED_WEBHOOK', 'TEST_FIXTURE');

-- CreateEnum
CREATE TYPE "TrackingEventDisposition" AS ENUM ('APPLIED', 'STALE', 'REJECTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TrackingException" AS ENUM ('DELIVERY_ATTEMPT_FAILED', 'ADDRESS_ISSUE', 'DELAY', 'DAMAGED', 'RETURN_TO_SENDER', 'UNKNOWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "FulfilmentStage" ADD VALUE 'IN_TRANSIT';
ALTER TYPE "FulfilmentStage" ADD VALUE 'DELIVERED';

-- CreateTable
CREATE TABLE "ShipmentTrackingEvent" (
    "id" SERIAL NOT NULL,
    "shipmentId" INTEGER NOT NULL,
    "carrier" "ShippingCarrier" NOT NULL,
    "providerIdentity" VARCHAR(80) NOT NULL,
    "providerEventId" VARCHAR(128) NOT NULL,
    "trackingNumber" VARCHAR(100) NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifiedAt" TIMESTAMPTZ(3),
    "source" "TrackingEvidenceSource" NOT NULL,
    "verified" BOOLEAN NOT NULL,
    "status" "TrackingStatus" NOT NULL,
    "exception" "TrackingException",
    "providerStatus" VARCHAR(128) NOT NULL,
    "deliveryConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "deliveryAt" TIMESTAMPTZ(3),
    "evidenceReference" VARCHAR(128),
    "fingerprint" VARCHAR(64) NOT NULL,
    "disposition" "TrackingEventDisposition" NOT NULL,
    "reason" VARCHAR(40),

    CONSTRAINT "ShipmentTrackingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShipmentTrackingState" (
    "shipmentId" INTEGER NOT NULL,
    "progress" "TrackingStatus" NOT NULL DEFAULT 'DISPATCHED',
    "lastEventAt" TIMESTAMPTZ(3),
    "lastEventId" INTEGER,
    "deliveredEventId" INTEGER,
    "exception" "TrackingException",
    "exceptionAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ShipmentTrackingState_pkey" PRIMARY KEY ("shipmentId")
);

-- CreateTable
CREATE TABLE "ShipmentTrackingSync" (
    "shipmentId" INTEGER NOT NULL,
    "providerIdentity" VARCHAR(80) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "nextPollAt" TIMESTAMPTZ(3),
    "lastPollAt" TIMESTAMPTZ(3),
    "lastSuccessAt" TIMESTAMPTZ(3),
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "totalRequests" INTEGER NOT NULL DEFAULT 0,
    "claimOwner" VARCHAR(36),
    "claimGeneration" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(40),
    "stoppedReason" VARCHAR(40),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ShipmentTrackingSync_pkey" PRIMARY KEY ("shipmentId")
);

-- CreateTable
CREATE TABLE "TrackingCarrierBudget" (
    "carrier" "ShippingCarrier" NOT NULL,
    "providerIdentity" VARCHAR(80) NOT NULL,
    "minuteStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "minuteRequests" INTEGER NOT NULL DEFAULT 0,
    "dayStartedAt" TIMESTAMPTZ(3) NOT NULL,
    "dayRequests" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TrackingCarrierBudget_pkey" PRIMARY KEY ("carrier","providerIdentity")
);

-- CreateTable
CREATE TABLE "ShipmentTrackingPoll" (
    "id" SERIAL NOT NULL,
    "shipmentId" INTEGER NOT NULL,
    "providerIdentity" VARCHAR(80) NOT NULL,
    "generation" INTEGER NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "outcome" VARCHAR(40) NOT NULL,

    CONSTRAINT "ShipmentTrackingPoll_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShipmentTrackingEvent_shipmentId_occurredAt_id_idx" ON "ShipmentTrackingEvent"("shipmentId", "occurredAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentTrackingEvent_shipmentId_providerIdentity_providerE_key" ON "ShipmentTrackingEvent"("shipmentId", "providerIdentity", "providerEventId");

-- CreateIndex
CREATE INDEX "ShipmentTrackingSync_enabled_nextPollAt_shipmentId_idx" ON "ShipmentTrackingSync"("enabled", "nextPollAt", "shipmentId");

-- CreateIndex
CREATE INDEX "ShipmentTrackingPoll_shipmentId_id_idx" ON "ShipmentTrackingPoll"("shipmentId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ShipmentTrackingPoll_shipmentId_generation_key" ON "ShipmentTrackingPoll"("shipmentId", "generation");

-- AddForeignKey
ALTER TABLE "ShipmentTrackingEvent" ADD CONSTRAINT "ShipmentTrackingEvent_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentTrackingState" ADD CONSTRAINT "ShipmentTrackingState_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentTrackingState" ADD CONSTRAINT "ShipmentTrackingState_lastEventId_fkey" FOREIGN KEY ("lastEventId") REFERENCES "ShipmentTrackingEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentTrackingState" ADD CONSTRAINT "ShipmentTrackingState_deliveredEventId_fkey" FOREIGN KEY ("deliveredEventId") REFERENCES "ShipmentTrackingEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentTrackingSync" ADD CONSTRAINT "ShipmentTrackingSync_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShipmentTrackingPoll" ADD CONSTRAINT "ShipmentTrackingPoll_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "Shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ShipmentTrackingEvent" ADD CONSTRAINT tracking_verified_time CHECK (
  verified = ("verifiedAt" IS NOT NULL) AND (NOT verified OR "verifiedAt" <= "receivedAt"));
ALTER TABLE "ShipmentTrackingEvent" ADD CONSTRAINT tracking_test_database CHECK (
  source <> 'TEST_FIXTURE' OR current_database() = 'colorful_life_test');
ALTER TABLE "ShipmentTrackingEvent" ADD CONSTRAINT tracking_applied_evidence CHECK (
  disposition <> 'APPLIED' OR (verified AND "occurredAt" <= "receivedAt" AND status <> 'UNKNOWN'
    AND (status <> 'DELIVERED' OR ("deliveryConfirmed" AND "deliveryAt" = "occurredAt" AND COALESCE(length("evidenceReference"),0) > 0))));
ALTER TABLE "ShipmentTrackingState" ADD CONSTRAINT tracking_progress CHECK (
  progress IN ('DISPATCHED','IN_TRANSIT','DELIVERED') AND version >= 0
  AND ((progress = 'DELIVERED') = ("deliveredEventId" IS NOT NULL)));
ALTER TABLE "ShipmentTrackingSync" ADD CONSTRAINT tracking_sync_counts CHECK (
  "consecutiveFailures" >= 0 AND "totalRequests" >= 0 AND "claimGeneration" >= 0
  AND (("claimOwner" IS NULL) = ("leaseExpiresAt" IS NULL)));
ALTER TABLE "TrackingCarrierBudget" ADD CONSTRAINT tracking_budget_counts CHECK ("minuteRequests" >= 0 AND "dayRequests" >= 0);
ALTER TABLE "ShipmentTrackingPoll" ADD CONSTRAINT tracking_poll_generation CHECK (generation > 0);
CREATE FUNCTION tracking_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s "Shipment";
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'Tracking evidence is immutable' USING ERRCODE='23514'; END IF;
 SELECT * INTO s FROM "Shipment" WHERE id=NEW."shipmentId";
 IF s.carrier IS DISTINCT FROM NEW.carrier OR s."trackingNumber" IS NULL
   OR upper(regexp_replace(s."trackingNumber",'[[:space:]-]','','g')) IS DISTINCT FROM NEW."trackingNumber" THEN
   RAISE EXCEPTION 'Tracking shipment identity mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.disposition='APPLIED' AND NEW."occurredAt" < s."dispatchedAt" THEN
   RAISE EXCEPTION 'Tracking evidence predates dispatch' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tracking_event_guard BEFORE INSERT OR UPDATE ON "ShipmentTrackingEvent" FOR EACH ROW EXECUTE FUNCTION tracking_event_guard();
CREATE FUNCTION tracking_state_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e "ShipmentTrackingEvent"; o "Order"; s "Shipment"; old_rank int; new_rank int;
BEGIN
 SELECT * INTO s FROM "Shipment" WHERE id=NEW."shipmentId";
 SELECT * INTO o FROM "Order" WHERE id=s."orderId";
 IF TG_OP='UPDATE' THEN
  old_rank:=CASE OLD.progress WHEN 'DISPATCHED' THEN 0 WHEN 'IN_TRANSIT' THEN 1 ELSE 2 END;
  new_rank:=CASE NEW.progress WHEN 'DISPATCHED' THEN 0 WHEN 'IN_TRANSIT' THEN 1 ELSE 2 END;
  IF NEW."shipmentId"<>OLD."shipmentId" OR new_rank<old_rank OR NEW.version<OLD.version
    OR (OLD."lastEventAt" IS NOT NULL AND (NEW."lastEventAt" IS NULL OR NEW."lastEventAt"<OLD."lastEventAt"))
    OR (OLD."deliveredEventId" IS NOT NULL AND NEW."deliveredEventId" IS DISTINCT FROM OLD."deliveredEventId") THEN
    RAISE EXCEPTION 'Tracking progress cannot regress' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW."lastEventId" IS NOT NULL THEN
  SELECT * INTO e FROM "ShipmentTrackingEvent" WHERE id=NEW."lastEventId";
  IF e."shipmentId" IS DISTINCT FROM NEW."shipmentId" OR e.disposition IS DISTINCT FROM 'APPLIED'
    OR NOT e.verified OR e."occurredAt" IS DISTINCT FROM NEW."lastEventAt" THEN
    RAISE EXCEPTION 'Tracking state evidence mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.progress IN ('IN_TRANSIT','DELIVERED') THEN
  IF o."dispatchedAt" IS NULL OR o.status NOT IN ('DISPATCHED','COMPLETED','RETURNED')
    OR NEW."lastEventId" IS NULL OR e.status IS DISTINCT FROM NEW.progress THEN
    RAISE EXCEPTION 'Tracking progress requires carrier evidence' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.progress='DELIVERED' THEN
  IF NEW."lastEventId" IS DISTINCT FROM NEW."deliveredEventId" OR NOT e."deliveryConfirmed"
    OR e."deliveryAt" IS DISTINCT FROM e."occurredAt" OR COALESCE(length(e."evidenceReference"),0)=0 THEN
    RAISE EXCEPTION 'Delivered requires verified confirmation' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tracking_state_guard BEFORE INSERT OR UPDATE ON "ShipmentTrackingState" FOR EACH ROW EXECUTE FUNCTION tracking_state_guard();
CREATE FUNCTION tracking_shipment_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM "ShipmentTrackingEvent" WHERE "shipmentId"=OLD.id)
   OR EXISTS(SELECT 1 FROM "ShipmentTrackingSync" WHERE "shipmentId"=OLD.id) THEN
  IF NEW.id<>OLD.id OR NEW."orderId"<>OLD."orderId" OR NEW.carrier IS DISTINCT FROM OLD.carrier
    OR NEW."trackingNumber" IS DISTINCT FROM OLD."trackingNumber" OR NEW."dispatchedAt" IS DISTINCT FROM OLD."dispatchedAt" THEN
    RAISE EXCEPTION 'Tracked shipment identity is immutable' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tracking_shipment_identity_guard BEFORE UPDATE ON "Shipment" FOR EACH ROW EXECUTE FUNCTION tracking_shipment_identity_guard();

CREATE FUNCTION tracking_sync_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."shipmentId"<>OLD."shipmentId" OR NEW."providerIdentity"<>OLD."providerIdentity"
   OR NEW."totalRequests"<OLD."totalRequests" OR NEW."claimGeneration"<OLD."claimGeneration" THEN
   RAISE EXCEPTION 'Tracking sync identity/counters cannot regress' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tracking_sync_guard BEFORE UPDATE ON "ShipmentTrackingSync" FOR EACH ROW EXECUTE FUNCTION tracking_sync_guard();
CREATE FUNCTION tracking_poll_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW."shipmentId"<>OLD."shipmentId" OR NEW."providerIdentity"<>OLD."providerIdentity"
   OR NEW.generation<>OLD.generation OR NEW."startedAt"<>OLD."startedAt"
   OR (OLD."completedAt" IS NOT NULL AND (NEW."completedAt" IS DISTINCT FROM OLD."completedAt" OR NEW.outcome<>OLD.outcome)) THEN
   RAISE EXCEPTION 'Tracking poll journal is immutable after completion' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER tracking_poll_guard BEFORE UPDATE ON "ShipmentTrackingPoll" FOR EACH ROW EXECUTE FUNCTION tracking_poll_guard();
COMMIT;
