-- Blank references are not proof. No historical progress or evidence is rewritten.
BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE "ShipmentTrackingEvent" ADD CONSTRAINT tracking_nonblank_delivery_proof CHECK (
 disposition <> 'APPLIED' OR status <> 'DELIVERED'
 OR COALESCE(length(regexp_replace("evidenceReference",'[[:space:]]','','g')),0)>0
);
COMMIT;
