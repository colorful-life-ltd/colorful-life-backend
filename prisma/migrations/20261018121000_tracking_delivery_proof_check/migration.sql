-- PostgreSQL CHECK accepts NULL: require an explicit non-null delivery timestamp.
-- No historical data or progress is rewritten. Existing rejected evidence is retained.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE "ShipmentTrackingEvent" DROP CONSTRAINT tracking_applied_evidence;
ALTER TABLE "ShipmentTrackingEvent" ADD CONSTRAINT tracking_applied_evidence CHECK (
  disposition <> 'APPLIED' OR (verified AND "occurredAt" <= "receivedAt" AND status <> 'UNKNOWN'
    AND (status <> 'DELIVERED' OR ("deliveryConfirmed" AND "deliveryAt" IS NOT NULL
      AND "deliveryAt" = "occurredAt" AND COALESCE(length("evidenceReference"),0) > 0))));
COMMIT;
