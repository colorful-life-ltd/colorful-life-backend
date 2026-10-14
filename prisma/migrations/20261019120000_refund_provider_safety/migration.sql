BEGIN;
SET LOCAL lock_timeout='5s';
ALTER TABLE "Refund"
 ADD COLUMN "clientRequestKey" VARCHAR(128),
 ADD COLUMN "providerPaymentReference" TEXT,
 ADD COLUMN "submissionStartedAt" TIMESTAMPTZ(3),
 ADD COLUMN "resolutionCode" VARCHAR(64),
 ADD COLUMN "reviewRequired" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "providerOutcome" JSONB,
 ADD COLUMN "reviewEvidence" JSONB;
CREATE UNIQUE INDEX "Refund_clientRequestKey_key" ON "Refund"("clientRequestKey");
CREATE INDEX "Refund_paymentId_status_idx" ON "Refund"("paymentId",status);
ALTER TABLE "Refund" ADD CONSTRAINT refund_reconciliation_bounded CHECK ("reconciliationAttempts" BETWEEN 0 AND 8);
ALTER TABLE "Refund" ADD CONSTRAINT refund_managed_identity CHECK (
 "clientRequestKey" IS NULL OR (provider IN ('STRIPE','PAYPAL') AND length("clientRequestKey")>0
 AND "submissionStartedAt" IS NOT NULL AND "providerPaymentReference" IS NOT NULL AND "refundIdempotencyKey" IS NOT NULL));
CREATE FUNCTION refund_provider_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
  OR (OLD.status IN ('SUCCEEDED','FAILED') AND NEW.status<>OLD.status)
  OR (OLD."providerReference" NOT LIKE 'pending:%' AND NEW."providerReference"<>OLD."providerReference")
 ) THEN RAISE EXCEPTION 'Submitted refund identity or terminal state cannot change' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER refund_provider_identity_guard BEFORE UPDATE ON "Refund" FOR EACH ROW EXECUTE FUNCTION refund_provider_identity_guard();
COMMIT;
