-- PP-2: extend finality only for complete, closed, nonhistorical PayPal ledgers.
-- Stripe predicates, coverage, success and inbox guards are preserved.
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE OR REPLACE FUNCTION payment_runtime_release_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
        WHERE a."orderId"=NEW."orderId" AND (a.historical OR a.provider NOT IN ('STRIPE','PAYPAL') OR a."successEvidenceId" IS NOT NULL
          OR e.provider IS DISTINCT FROM a.provider OR e.normalized->>'providerReference' IS DISTINCT FROM a."providerReference"
          -- Preserve all existing Stripe finality checks verbatim.
          OR (a.provider='STRIPE' AND (e.normalized->>'providerStatus' IS DISTINCT FROM 'canceled'
            OR e.normalized->>'amountReceived' IS DISTINCT FROM '0' OR e.normalized->>'amountCapturable' IS DISTINCT FROM '0'))
          OR (a.provider='PAYPAL' AND NOT COALESCE((
            (e.normalized->>'outcome'='NOT_DISPATCHED' AND a."providerReference" IS NOT NULL AND a."providerCaptureReference" IS NULL
              AND NOT EXISTS (SELECT 1 FROM "PaymentWebhookEvent" w WHERE w.provider='PAYPAL' AND w."eventType" LIKE 'PAYMENT.CAPTURE.%' AND w.evidence->>'paypalOrderId'=a."providerReference")
              AND NOT EXISTS (SELECT 1 FROM "PaymentOperation" cap WHERE cap."attemptId"=a.id AND cap.type NOT IN ('CREATE','RETRIEVE'))
              AND NOT EXISTS (SELECT 1 FROM "Payment" pay WHERE pay.id=a."paymentId" AND (pay."captureIdempotencyKey" IS NOT NULL OR pay."providerCaptureReference" IS NOT NULL)))
            OR (e.normalized->>'outcome'='DEFINITIVELY_DECLINED'
              AND ((length(e.normalized->>'providerCaptureReference')>0
                AND e.normalized->>'providerCaptureReference'=a."providerCaptureReference")
                OR (e.normalized->>'declineCode'='INSTRUMENT_DECLINED' AND EXISTS (
                  SELECT 1 FROM "FinancialEvidence" f JOIN "PaymentOperation" co ON co.id=f."operationId"
                  WHERE co."attemptId"=a.id AND co.type='CAPTURE' AND f.provider='PAYPAL' AND f.kind='FAILURE'
                    AND f.normalized->>'declineCode'='INSTRUMENT_DECLINED')))
              AND (SELECT count(*) FROM "PaymentOperation" cap WHERE cap."attemptId"=a.id AND cap.type='CAPTURE')=1
              AND EXISTS (SELECT 1 FROM "PaymentOperation" rd WHERE rd."attemptId"=a.id AND rd.type='RETRIEVE'
                AND rd.id::text=e.normalized->>'retrievalId' AND rd.state='RESULT_RECORDED'))
          ), false))
          OR e.normalized->>'amount' IS DISTINCT FROM a.amount::text OR e.normalized->>'currency' IS DISTINCT FROM a.currency
          OR e.kind IS DISTINCT FROM 'TERMINAL_UNPAID'::"FinancialEvidenceKind" OR e."verifiedAt" IS NULL))
     OR EXISTS(SELECT 1 FROM "PaymentOperation" o JOIN "PaymentAttempt" a ON a.id=o."attemptId"
        LEFT JOIN "FinancialEvidence" e ON e.id=o."evidenceId" WHERE a."orderId"=NEW."orderId" AND (o.historical OR o.state<>'RESULT_RECORDED' OR e.kind NOT IN ('FAILURE','TERMINAL_UNPAID') OR e.id IS NULL)) THEN
     RAISE EXCEPTION 'Unresolved financial coverage' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
-- Fence capture permissions under the same Order lock, including stale writers.
CREATE FUNCTION paypal_capture_admission_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a "PaymentAttempt"; p "Payment"; r "PaymentResolution";
BEGIN
  SELECT * INTO a FROM "PaymentAttempt" WHERE id=NEW."attemptId";
  IF a.provider <> 'PAYPAL' OR NEW.type <> 'CAPTURE' OR NEW.historical THEN RETURN NEW; END IF;
  PERFORM id FROM "Order" WHERE id=a."orderId" FOR UPDATE;
  SELECT * INTO a FROM "PaymentAttempt" WHERE id=NEW."attemptId";
  SELECT * INTO p FROM "Payment" WHERE id=a."paymentId";
  SELECT * INTO r FROM "PaymentResolution" WHERE "orderId"=a."orderId";
  IF r."orderId" IS NULL OR r."paymentAdmissionClosedAt" IS NOT NULL OR r."reservationDisposition" IS DISTINCT FROM 'HELD'
    OR r.state NOT IN ('INITIAL_OPEN','RETRY_OPEN') OR a."finalityEvidenceId" IS NOT NULL OR a."successEvidenceId" IS NOT NULL
    OR p.provider <> 'PAYPAL' OR p."providerReference" IS DISTINCT FROM a."providerReference"
    OR p.status IN ('SUCCEEDED','CANCELED') OR p."paidAt" IS NOT NULL
    OR EXISTS(SELECT 1 FROM "PaymentOperation" o WHERE o."attemptId"=a.id AND o.type='CAPTURE') THEN
    RAISE EXCEPTION 'PayPal capture permission is retired or already dispatched' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER paypal_capture_admission BEFORE INSERT ON "PaymentOperation" FOR EACH ROW EXECUTE FUNCTION paypal_capture_admission_guard();
COMMIT;
