-- Remove PayPal: Stripe is the only payment provider.
-- FAIL-CLOSED: this migration never deletes payment, refund, webhook or evidence data.
-- It aborts (and changes nothing) unless the database contains zero PayPal records.
-- Owner evidence required before applying to any persistent database: see
-- docs/operations/paypal-removal.md (Production SELECT-only check; Sandbox recreation).
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE found text[] := ARRAY[]::text[];
BEGIN
  IF EXISTS (SELECT 1 FROM "Payment" WHERE provider::text='PAYPAL') THEN found := array_append(found, 'Payment'); END IF;
  IF EXISTS (SELECT 1 FROM "Refund" WHERE provider::text='PAYPAL') THEN found := array_append(found, 'Refund'); END IF;
  IF EXISTS (SELECT 1 FROM "PaymentAttempt" WHERE provider::text='PAYPAL') THEN found := array_append(found, 'PaymentAttempt'); END IF;
  IF EXISTS (SELECT 1 FROM "FinancialEvidence" WHERE provider::text='PAYPAL') THEN found := array_append(found, 'FinancialEvidence'); END IF;
  IF EXISTS (SELECT 1 FROM "PaymentWebhookEvent" WHERE provider::text='PAYPAL') THEN found := array_append(found, 'PaymentWebhookEvent'); END IF;
  IF EXISTS (SELECT 1 FROM "PaymentWebhookEvent" WHERE "reviewDetails" IS NOT NULL OR "reviewedAt" IS NOT NULL) THEN found := array_append(found, 'PaymentWebhookEvent.review'); END IF;
  IF EXISTS (SELECT 1 FROM "PaymentAdmission" WHERE provider='PAYPAL') THEN found := array_append(found, 'PaymentAdmission'); END IF;
  IF EXISTS (SELECT 1 FROM "PaymentSecurityEvent" WHERE provider='PAYPAL') THEN found := array_append(found, 'PaymentSecurityEvent'); END IF;
  IF cardinality(found) > 0 THEN
    RAISE EXCEPTION 'PayPal records exist in %; refusing PayPal removal (no data changed)', array_to_string(found, ', ')
      USING ERRCODE = '23514';
  END IF;
END $$;

-- PayPal-only capture fence.
DROP TRIGGER paypal_capture_admission ON "PaymentOperation";
DROP FUNCTION paypal_capture_admission_guard();

-- Release guard: identical to the live definition except the PayPal predicates.
CREATE OR REPLACE FUNCTION public.payment_runtime_release_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE r "PaymentResolution"; p "ReservationReleaseProof"; current_order "Order"; expected_attempts jsonb; expected_operations jsonb;
BEGIN
 PERFORM id FROM "Order" WHERE id=NEW."orderId" FOR UPDATE;
 SELECT * INTO r FROM "PaymentResolution" WHERE "orderId"=NEW."orderId";
 SELECT * INTO current_order FROM "Order" WHERE id=NEW."orderId";
 IF TG_TABLE_NAME='ReservationReleaseProof' THEN p:=NEW;
 ELSIF NEW."reservationDisposition" IS DISTINCT FROM 'RELEASED' THEN RETURN NEW;
 ELSE SELECT * INTO p FROM "ReservationReleaseProof" WHERE id=NEW."releaseProofId"; r:=NEW;
 END IF;
 IF p.id IS NULL OR p."orderId" IS DISTINCT FROM NEW."orderId" OR r."orderId" IS NULL OR r.historical
   OR r."reservationDisposition" IS NULL OR r.state='REVIEW_REQUIRED' OR r."quarantineReason" IS NOT NULL
   OR r."paymentAdmissionClosedAt" IS NULL OR r."closureReason" IS NULL
   OR current_order.status NOT IN ('PENDING','EXPIRED','CANCELLED')
   OR EXISTS(SELECT 1 FROM "Payment" WHERE "orderId"=NEW."orderId" AND (status='SUCCEEDED' OR "paidAt" IS NOT NULL))
   OR EXISTS(SELECT 1 FROM "FinancialEvidence" WHERE "orderId"=NEW."orderId" AND kind='SUCCESS') THEN
   RAISE EXCEPTION 'Release requires closed unpaid nonhistorical order' USING ERRCODE='23514';
 END IF;
 IF r."closureReason" NOT IN ('CUSTOMER_ABANDONED','SELLER_CANCELLED') AND clock_timestamp()<COALESCE(r."retryDeadline",r."initialPaymentDeadline") THEN
   RAISE EXCEPTION 'Release window has not expired' USING ERRCODE='23514'; END IF;
 SELECT COALESCE(jsonb_agg(id ORDER BY id),'[]'::jsonb) INTO expected_attempts FROM "PaymentAttempt" WHERE "orderId"=NEW."orderId";
 SELECT COALESCE(jsonb_agg(o.id ORDER BY o.id),'[]'::jsonb) INTO expected_operations FROM "PaymentOperation" o JOIN "PaymentAttempt" a ON a.id=o."attemptId" WHERE a."orderId"=NEW."orderId";
 IF p.coverage->'attempts' IS DISTINCT FROM expected_attempts OR p.coverage->'operations' IS DISTINCT FROM expected_operations THEN
   RAISE EXCEPTION 'Incomplete release coverage' USING ERRCODE='23514'; END IF;
 IF p.type='NO_PAYMENT' THEN
   IF EXISTS(SELECT 1 FROM "Payment" WHERE "orderId"=NEW."orderId") OR expected_attempts<>'[]'::jsonb OR expected_operations<>'[]'::jsonb
     OR EXISTS(SELECT 1 FROM "FinancialEvidence" WHERE "orderId"=NEW."orderId")
     OR EXISTS(SELECT 1 FROM "PaymentWebhookEvent" WHERE provider <> 'STRIPE' AND evidence->>'orderId'=NEW."orderId"::text) THEN
     RAISE EXCEPTION 'No-payment proof has financial activity' USING ERRCODE='23514'; END IF;
 ELSE
   IF expected_attempts='[]'::jsonb OR EXISTS(SELECT 1 FROM "Payment" pay WHERE pay."orderId"=NEW."orderId" AND NOT EXISTS(SELECT 1 FROM "PaymentAttempt" a WHERE a."paymentId"=pay.id))
     OR EXISTS(SELECT 1 FROM "PaymentAttempt" a LEFT JOIN "FinancialEvidence" e ON e.id=a."finalityEvidenceId"
        WHERE a."orderId"=NEW."orderId" AND (a.historical OR a.provider <> 'STRIPE' OR a."successEvidenceId" IS NOT NULL
          OR e.provider IS DISTINCT FROM a.provider OR e.normalized->>'providerReference' IS DISTINCT FROM a."providerReference"
          -- Preserve all existing Stripe finality checks verbatim.
          OR (a.provider='STRIPE' AND (e.normalized->>'providerStatus' IS DISTINCT FROM 'canceled'
            OR e.normalized->>'amountReceived' IS DISTINCT FROM '0' OR e.normalized->>'amountCapturable' IS DISTINCT FROM '0'))
          OR e.normalized->>'amount' IS DISTINCT FROM a.amount::text OR e.normalized->>'currency' IS DISTINCT FROM a.currency
          OR e.kind IS DISTINCT FROM 'TERMINAL_UNPAID'::"FinancialEvidenceKind" OR e."verifiedAt" IS NULL))
     OR EXISTS(SELECT 1 FROM "PaymentOperation" o JOIN "PaymentAttempt" a ON a.id=o."attemptId"
        LEFT JOIN "FinancialEvidence" e ON e.id=o."evidenceId" WHERE a."orderId"=NEW."orderId" AND (o.historical OR o.state<>'RESULT_RECORDED' OR e.kind NOT IN ('FAILURE','TERMINAL_UNPAID') OR e.id IS NULL)) THEN
     RAISE EXCEPTION 'Unresolved financial coverage' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $function$;

-- Provider constraints and the PayPal initiation policy (configuration, not financial data).
ALTER TABLE "Refund" DROP CONSTRAINT refund_managed_identity;
DELETE FROM "PaymentInitiationPolicy" WHERE provider='PAYPAL';
ALTER TABLE "PaymentInitiationPolicy" DROP CONSTRAINT "PaymentInitiationPolicy_provider_check",
  ADD CONSTRAINT "PaymentInitiationPolicy_provider_check" CHECK (provider = 'STRIPE');
ALTER TABLE "PaymentAdmission" DROP CONSTRAINT "PaymentAdmission_provider_check",
  ADD CONSTRAINT "PaymentAdmission_provider_check" CHECK (provider = 'STRIPE');

-- PayPal-only webhook review metadata (verified empty by the preflight).
DROP INDEX "PaymentWebhookEvent_provider_reviewedAt_id_idx";
ALTER TABLE "PaymentWebhookEvent" DROP COLUMN "reviewDetails", DROP COLUMN "reviewedAt";

-- Enum values cannot be dropped in place: recreate both types without PAYPAL.
ALTER TYPE "PaymentProvider" RENAME TO "PaymentProvider_old";
CREATE TYPE "PaymentProvider" AS ENUM ('MANUAL', 'STRIPE');
ALTER TABLE "Payment" ALTER COLUMN provider DROP DEFAULT,
  ALTER COLUMN provider TYPE "PaymentProvider" USING provider::text::"PaymentProvider",
  ALTER COLUMN provider SET DEFAULT 'MANUAL';
ALTER TABLE "PaymentWebhookEvent" ALTER COLUMN provider TYPE "PaymentProvider" USING provider::text::"PaymentProvider";
ALTER TABLE "PaymentAttempt" ALTER COLUMN provider TYPE "PaymentProvider" USING provider::text::"PaymentProvider";
ALTER TABLE "FinancialEvidence" ALTER COLUMN provider TYPE "PaymentProvider" USING provider::text::"PaymentProvider";
DROP TYPE "PaymentProvider_old";

ALTER TYPE "RefundProvider" RENAME TO "RefundProvider_old";
CREATE TYPE "RefundProvider" AS ENUM ('MANUAL', 'STRIPE');
ALTER TABLE "Refund" ALTER COLUMN provider DROP DEFAULT,
  ALTER COLUMN provider TYPE "RefundProvider" USING provider::text::"RefundProvider",
  ALTER COLUMN provider SET DEFAULT 'MANUAL';
DROP TYPE "RefundProvider_old";

ALTER TABLE "Refund" ADD CONSTRAINT refund_managed_identity CHECK (("clientRequestKey" IS NULL) OR ((provider = 'STRIPE'::"RefundProvider")
  AND (length(("clientRequestKey")::text) > 0) AND ("submissionStartedAt" IS NOT NULL)
  AND ("providerPaymentReference" IS NOT NULL) AND ("refundIdempotencyKey" IS NOT NULL)));
COMMIT;
