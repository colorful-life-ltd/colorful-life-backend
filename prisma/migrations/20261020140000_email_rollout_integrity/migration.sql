BEGIN;
SET LOCAL lock_timeout = '5s';
-- Preserve earlier migrations and existing job routing; no email/backfill is triggered.
ALTER TABLE "OrderConfirmationJob" ADD COLUMN "deliveryRoute" TEXT NOT NULL DEFAULT 'DURABLE',
 ADD COLUMN "backlogApprovedAt" TIMESTAMPTZ(3);
ALTER TABLE "OrderConfirmationJob" ADD CONSTRAINT email_delivery_route CHECK
 ("deliveryRoute" IN ('DURABLE','LEGACY') AND (type='DISPATCH_CONFIRMATION' OR "deliveryRoute"='DURABLE'));
ALTER TABLE "OrderConfirmationJob" ADD CONSTRAINT confirmation_source_order_identity CHECK
 ((type<>'ORDER_CONFIRMATION' OR source->>'orderId'="orderId"::text) IS TRUE);
CREATE OR REPLACE FUNCTION confirmation_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW."orderId" IS DISTINCT FROM OLD."orderId"
    OR NEW.source IS DISTINCT FROM OLD.source OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    OR NEW.type IS DISTINCT FROM OLD.type OR NEW."eventKey" IS DISTINCT FROM OLD."eventKey"
    OR NEW."shipmentId" IS DISTINCT FROM OLD."shipmentId" OR NEW."deliveryRoute" IS DISTINCT FROM OLD."deliveryRoute"
    OR (OLD."backlogApprovedAt" IS NOT NULL AND NEW."backlogApprovedAt" IS DISTINCT FROM OLD."backlogApprovedAt")
    OR (OLD."brandSnapshot" IS NOT NULL AND NEW."brandSnapshot" IS DISTINCT FROM OLD."brandSnapshot") THEN
  RAISE EXCEPTION 'Confirmation source is immutable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
COMMIT;
