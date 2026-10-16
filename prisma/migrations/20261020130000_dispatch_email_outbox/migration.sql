BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "OrderConfirmationJob" ADD COLUMN type TEXT NOT NULL DEFAULT 'ORDER_CONFIRMATION',
 ADD COLUMN "eventKey" TEXT, ADD COLUMN "shipmentId" INTEGER REFERENCES "Shipment"(id) ON DELETE CASCADE,
 ADD COLUMN "brandSnapshot" JSONB;
UPDATE "OrderConfirmationJob" SET "eventKey"='order:' || "orderId"::text;
ALTER TABLE "OrderConfirmationJob" ALTER COLUMN "eventKey" SET NOT NULL;
ALTER TABLE "OrderConfirmationJob" DROP CONSTRAINT "OrderConfirmationJob_orderId_key";
CREATE UNIQUE INDEX "OrderConfirmationJob_eventKey_key" ON "OrderConfirmationJob"("eventKey");
CREATE UNIQUE INDEX "OrderConfirmationJob_shipmentId_key" ON "OrderConfirmationJob"("shipmentId");
CREATE INDEX "OrderConfirmationJob_orderId_idx" ON "OrderConfirmationJob"("orderId");
CREATE UNIQUE INDEX confirmation_one_per_order ON "OrderConfirmationJob"("orderId") WHERE type='ORDER_CONFIRMATION';
ALTER TABLE "OrderConfirmationJob" ADD CONSTRAINT email_event_identity CHECK (
 (type='ORDER_CONFIRMATION' AND "shipmentId" IS NULL AND "eventKey"='order:' || "orderId"::text)
 OR (type='DISPATCH_CONFIRMATION' AND "shipmentId" IS NOT NULL AND "eventKey"='shipment:' || "shipmentId"::text
 AND (source->>'shipmentId'="shipmentId"::text AND source->>'orderId'="orderId"::text) IS TRUE));
CREATE OR REPLACE FUNCTION confirmation_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW.source IS DISTINCT FROM OLD.source OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW.type IS DISTINCT FROM OLD.type OR NEW."eventKey" IS DISTINCT FROM OLD."eventKey"
    OR NEW."shipmentId" IS DISTINCT FROM OLD."shipmentId"
    OR (OLD."brandSnapshot" IS NOT NULL AND NEW."brandSnapshot" IS DISTINCT FROM OLD."brandSnapshot") THEN
  RAISE EXCEPTION 'Confirmation source is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
COMMIT;
