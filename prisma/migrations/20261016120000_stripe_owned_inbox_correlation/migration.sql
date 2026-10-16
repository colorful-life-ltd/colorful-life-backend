-- Stripe metadata IDs alone do not identify an order in this environment.
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
        WHERE a."orderId"=NEW."orderId" AND (a.historical OR a.provider <> 'STRIPE' OR a."successEvidenceId" IS NOT NULL
          OR e.provider IS DISTINCT FROM a.provider OR e.normalized->>'providerReference' IS DISTINCT FROM a."providerReference"
          OR e.normalized->>'providerStatus' IS DISTINCT FROM 'canceled'
          OR e.normalized->>'amountReceived' IS DISTINCT FROM '0' OR e.normalized->>'amountCapturable' IS DISTINCT FROM '0'
          OR e.normalized->>'amount' IS DISTINCT FROM a.amount::text OR e.normalized->>'currency' IS DISTINCT FROM a.currency
          OR e.kind IS DISTINCT FROM 'TERMINAL_UNPAID'::"FinancialEvidenceKind" OR e."verifiedAt" IS NULL))
     OR EXISTS(SELECT 1 FROM "PaymentOperation" o JOIN "PaymentAttempt" a ON a.id=o."attemptId"
        LEFT JOIN "FinancialEvidence" e ON e.id=o."evidenceId" WHERE a."orderId"=NEW."orderId" AND (o.historical OR o.state<>'RESULT_RECORDED' OR e.kind NOT IN ('FAILURE','TERMINAL_UNPAID') OR e.id IS NULL)) THEN
     RAISE EXCEPTION 'Unresolved financial coverage' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION payment_runtime_inbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM "Order" WHERE id=NEW."orderId" FOR UPDATE;
 IF EXISTS (
  SELECT 1 FROM "PaymentWebhookEvent" w WHERE
   ((w.provider <> 'STRIPE' AND w.evidence->>'orderId'=NEW."orderId"::text) OR EXISTS(
    SELECT 1 FROM "PaymentAttempt" a WHERE a."orderId"=NEW."orderId" AND a.provider=w.provider
     AND ((w.evidence->>'paymentIntentId'=a."providerReference") OR (w.evidence->>'paypalOrderId'=a."providerReference")
      OR (w.evidence->>'captureId'=a."providerCaptureReference")
      OR w."providerEventId"='recovery:'||a."paymentId"::text||':'||a."providerReference"||':succeeded')))
   AND (w."processedAt" IS NULL OR w."processingError" IS NOT NULL
    OR w."eventType" IN ('payment_intent.succeeded','payment_intent.recovered','PAYMENT.CAPTURE.COMPLETED'))
 ) THEN RAISE EXCEPTION 'Relevant provider inbox evidence prohibits release' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
COMMIT;
