BEGIN;
SET LOCAL lock_timeout='5s';
-- Refund identity and terminal state stay immutable, with one audited exception: a Stripe refund first
-- observed SUCCEEDED that a provider reconciliation later confirms FAILED (Stripe documents succeeded ->
-- failed). Only the status may change, and only when this refund's adjustment audit already exists in the
-- same transaction. Amount, currency, ownership, provider, references and providerOutcome never change.
CREATE FUNCTION refund_stripe_failure_after_success_allowed(old_row "Refund", new_row "Refund") RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT old_row.status='SUCCEEDED' AND new_row.status='FAILED' AND old_row.provider='STRIPE' AND new_row.provider='STRIPE'
  AND new_row.amount=old_row.amount AND new_row.currency=old_row.currency
  AND new_row."paymentId"=old_row."paymentId" AND new_row."orderId"=old_row."orderId"
  AND new_row."providerReference"=old_row."providerReference"
  AND new_row."providerOutcome" IS NOT DISTINCT FROM old_row."providerOutcome"
  AND EXISTS (SELECT 1 FROM "OperationalAudit" a WHERE a.kind='REFUND_FAILED_AFTER_SUCCESS' AND a."refundId"=old_row.id
    AND a."requestKey"='refund-failed-after-success:' || old_row.id)
$$;

-- Unchanged from 20261025120000_production_audit except for the audited exception.
CREATE OR REPLACE FUNCTION refund_observed_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD."providerOutcome" IS NOT NULL AND (NEW.status<>OLD.status OR NEW.amount<>OLD.amount OR NEW.currency<>OLD.currency
  OR NEW."paymentId"<>OLD."paymentId" OR NEW."orderId"<>OLD."orderId" OR NEW.provider<>OLD.provider OR NEW."providerReference"<>OLD."providerReference")
  AND NOT refund_stripe_failure_after_success_allowed(OLD, NEW) THEN
 RAISE EXCEPTION 'Observed refund identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

-- Unchanged from 20261019120000_refund_provider_safety except for the audited exception to the terminal-state rule.
CREATE OR REPLACE FUNCTION refund_provider_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."reconciliationAttempts"<OLD."reconciliationAttempts" THEN
  RAISE EXCEPTION 'Refund reconciliation count cannot regress' USING ERRCODE='23514'; END IF;
 IF OLD."providerOutcome" IS NOT NULL AND NEW."providerOutcome" IS DISTINCT FROM OLD."providerOutcome" THEN
  RAISE EXCEPTION 'Terminal refund evidence is immutable' USING ERRCODE='23514'; END IF;
 IF OLD."clientRequestKey" IS NOT NULL AND (
  NEW.id<>OLD.id OR NEW."orderId"<>OLD."orderId" OR NEW."paymentId"<>OLD."paymentId"
  OR NEW.provider<>OLD.provider OR NEW.amount<>OLD.amount OR NEW.currency<>OLD.currency
  OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW."performedByUserId"<>OLD."performedByUserId"
  OR NEW."clientRequestKey" IS DISTINCT FROM OLD."clientRequestKey"
  OR NEW."refundIdempotencyKey" IS DISTINCT FROM OLD."refundIdempotencyKey"
  OR NEW."providerPaymentReference" IS DISTINCT FROM OLD."providerPaymentReference"
  OR NEW."submissionStartedAt" IS DISTINCT FROM OLD."submissionStartedAt"
  OR (OLD.status IN ('SUCCEEDED','FAILED') AND NEW.status<>OLD.status AND NOT refund_stripe_failure_after_success_allowed(OLD, NEW))
  OR (OLD."providerReference" NOT LIKE 'pending:%' AND NEW."providerReference"<>OLD."providerReference")
 ) THEN RAISE EXCEPTION 'Submitted refund identity or terminal state cannot change' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
COMMIT;
