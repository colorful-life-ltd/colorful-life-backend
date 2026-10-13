BEGIN;
SET LOCAL lock_timeout='5s';
-- Proof creation is not sufficient: recheck inbox evidence at the disposition write too.
-- Use the same Order-first function, including direct SQL INSERT/UPDATE paths.
CREATE TRIGGER resolution_runtime_inbox_guard BEFORE INSERT OR UPDATE ON "PaymentResolution"
FOR EACH ROW WHEN (NEW."reservationDisposition" = 'RELEASED')
EXECUTE FUNCTION payment_runtime_inbox_guard();
COMMIT;
