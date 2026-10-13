BEGIN;
SET LOCAL lock_timeout='5s';
-- A terminal-unpaid observation is not first payment-failure verification.
-- Keep the immutable primary operation result, while accepting a later verified failure from the same eligible operation.
CREATE OR REPLACE FUNCTION payment_foundation_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ev "FinancialEvidence"; expected_order integer; expected_provider "PaymentProvider"; proof_order integer; op "PaymentOperation"; attempt "PaymentAttempt"; resolution "PaymentResolution"; receipt "PaymentWebhookEvent";
BEGIN
  IF TG_TABLE_NAME = 'PaymentAttempt' THEN
    SELECT "orderId", "provider" INTO expected_order, expected_provider FROM "Payment" WHERE id = NEW."paymentId";
    IF expected_order IS DISTINCT FROM NEW."orderId" OR expected_provider IS DISTINCT FROM NEW.provider THEN
      RAISE EXCEPTION 'Attempt aggregate mismatch' USING ERRCODE = '23514'; END IF;
    IF EXISTS (
      SELECT 1 FROM "FinancialEvidence" e JOIN "PaymentOperation" o ON o.id=e."operationId"
      LEFT JOIN "PaymentWebhookEvent" w ON w.id=e."webhookEventId"
      WHERE o."attemptId"=NEW.id AND (
        (NEW."providerReference" IS NOT NULL AND e.normalized->>'providerReference' IS NOT NULL
          AND e.normalized->>'providerReference' IS DISTINCT FROM NEW."providerReference") OR
        (NEW."providerReference" IS NOT NULL AND w.evidence->>'paypalOrderId' IS NOT NULL
          AND w.evidence->>'paypalOrderId' IS DISTINCT FROM NEW."providerReference") OR
        (NEW."providerCaptureReference" IS NOT NULL AND e.normalized->>'providerCaptureReference' IS NOT NULL
          AND e.normalized->>'providerCaptureReference' IS DISTINCT FROM NEW."providerCaptureReference") OR
        (NEW."providerCaptureReference" IS NOT NULL AND w.evidence->>'captureId' IS NOT NULL
          AND w.evidence->>'captureId' IS DISTINCT FROM NEW."providerCaptureReference") OR
        (e.normalized->>'providerReference' IS NOT NULL AND w.evidence->>'paypalOrderId' IS NOT NULL
          AND e.normalized->>'providerReference' IS DISTINCT FROM w.evidence->>'paypalOrderId') OR
        (e.normalized->>'providerCaptureReference' IS NOT NULL AND w.evidence->>'captureId' IS NOT NULL
          AND e.normalized->>'providerCaptureReference' IS DISTINCT FROM w.evidence->>'captureId')
      )
    ) THEN RAISE EXCEPTION 'Attempt binding conflicts with evidence' USING ERRCODE = '23514'; END IF;
    IF NEW."successEvidenceId" IS NOT NULL THEN
      SELECT * INTO ev FROM "FinancialEvidence" WHERE id = NEW."successEvidenceId";
      SELECT * INTO op FROM "PaymentOperation" WHERE id = ev."operationId";
      IF ev."orderId" IS DISTINCT FROM NEW."orderId" OR ev.provider IS DISTINCT FROM NEW.provider OR ev.kind IS DISTINCT FROM 'SUCCESS'::"FinancialEvidenceKind" OR op."attemptId" IS DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'Invalid success evidence' USING ERRCODE = '23514'; END IF;
    END IF;
    IF NEW."finalityEvidenceId" IS NOT NULL THEN
      SELECT * INTO ev FROM "FinancialEvidence" WHERE id = NEW."finalityEvidenceId";
      SELECT * INTO op FROM "PaymentOperation" WHERE id = ev."operationId";
      IF ev."orderId" IS DISTINCT FROM NEW."orderId" OR ev.provider IS DISTINCT FROM NEW.provider OR ev.kind IS DISTINCT FROM 'TERMINAL_UNPAID'::"FinancialEvidenceKind" OR op."attemptId" IS DISTINCT FROM NEW.id THEN
        RAISE EXCEPTION 'Invalid finality evidence' USING ERRCODE = '23514'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'PaymentOperation' THEN
    IF TG_OP = 'UPDATE' THEN
      IF NEW."claimGeneration" < OLD."claimGeneration" OR NEW."executionCount" < OLD."executionCount" THEN
        RAISE EXCEPTION 'Recovery counters cannot regress' USING ERRCODE = '23514'; END IF;
      IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
        (OLD.state = 'PREPARED' AND NEW.state = 'POTENTIALLY_DISPATCHED') OR
        (OLD.state = 'POTENTIALLY_DISPATCHED' AND NEW.state IN ('UNKNOWN','RESULT_RECORDED')) OR
        (OLD.state = 'UNKNOWN' AND NEW.state = 'RESULT_RECORDED')
      ) THEN RAISE EXCEPTION 'Unsupported operation transition' USING ERRCODE = '23514'; END IF;
    ELSIF (NOT NEW.historical AND NEW.state <> 'PREPARED') OR (NEW.historical AND NEW.state <> 'UNKNOWN') THEN
      RAISE EXCEPTION 'Invalid initial operation state' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO attempt FROM "PaymentAttempt" WHERE id = NEW."attemptId";
    IF TG_OP = 'INSERT' AND NOT NEW.historical AND NEW.type IN ('CREATE','CONFIRM','CAPTURE') THEN
      SELECT * INTO resolution FROM "PaymentResolution" WHERE "orderId" = attempt."orderId";
      IF resolution."orderId" IS NULL OR resolution."paymentAdmissionClosedAt" IS NOT NULL
        OR resolution."reservationDisposition" IS DISTINCT FROM 'HELD'
        OR resolution.state NOT IN ('INITIAL_OPEN','RETRY_OPEN')
        OR attempt.historical OR attempt."admittedAt" IS NULL OR NEW."admittedAt" < attempt."admittedAt"
        OR NEW."admittedAt" < resolution."orderCreatedAt"
        OR NEW."admissionDeadline" IS DISTINCT FROM COALESCE(resolution."retryDeadline",resolution."initialPaymentDeadline") THEN
        RAISE EXCEPTION 'Operation admission is not proven' USING ERRCODE = '23514'; END IF;
    END IF;
    IF NEW."evidenceId" IS NOT NULL THEN
    SELECT "orderId", provider INTO expected_order, expected_provider FROM "PaymentAttempt" WHERE id = NEW."attemptId";
    SELECT * INTO ev FROM "FinancialEvidence" WHERE id = NEW."evidenceId";
    IF ev."orderId" IS DISTINCT FROM expected_order OR ev.provider IS DISTINCT FROM expected_provider
      OR ev."operationId" IS DISTINCT FROM NEW.id
      OR (NEW.state = 'RESULT_RECORDED' AND ev.kind = 'HISTORICAL_UNVERIFIED') THEN
      RAISE EXCEPTION 'Operation evidence mismatch' USING ERRCODE = '23514'; END IF;
  END IF;
  ELSIF TG_TABLE_NAME = 'FinancialEvidence' THEN
    IF NEW."operationId" IS NOT NULL THEN
      SELECT * INTO op FROM "PaymentOperation" WHERE id = NEW."operationId";
      SELECT * INTO attempt FROM "PaymentAttempt" WHERE id = op."attemptId";
      IF attempt."orderId" IS DISTINCT FROM NEW."orderId" OR attempt.provider IS DISTINCT FROM NEW.provider THEN
        RAISE EXCEPTION 'Evidence operation identity mismatch' USING ERRCODE = '23514'; END IF;
      IF (NEW.normalized->>'providerReference' IS NOT NULL AND attempt."providerReference" IS NOT NULL
          AND NEW.normalized->>'providerReference' IS DISTINCT FROM attempt."providerReference") OR
         (NEW.normalized->>'providerCaptureReference' IS NOT NULL AND attempt."providerCaptureReference" IS NOT NULL
          AND NEW.normalized->>'providerCaptureReference' IS DISTINCT FROM attempt."providerCaptureReference") THEN
        RAISE EXCEPTION 'Evidence provider object mismatch' USING ERRCODE = '23514'; END IF;
    END IF;
    IF NEW."webhookEventId" IS NOT NULL THEN
      SELECT * INTO receipt FROM "PaymentWebhookEvent" WHERE id = NEW."webhookEventId";
      IF receipt.provider IS DISTINCT FROM NEW.provider THEN
        RAISE EXCEPTION 'Evidence receipt provider mismatch' USING ERRCODE = '23514'; END IF;
      -- Compare sources independently even before the attempt is bound.
      IF (NEW.normalized->>'providerReference' IS NOT NULL AND receipt.evidence->>'paypalOrderId' IS NOT NULL
          AND NEW.normalized->>'providerReference' IS DISTINCT FROM receipt.evidence->>'paypalOrderId') OR
         (NEW.normalized->>'providerCaptureReference' IS NOT NULL AND receipt.evidence->>'captureId' IS NOT NULL
          AND NEW.normalized->>'providerCaptureReference' IS DISTINCT FROM receipt.evidence->>'captureId') THEN
        RAISE EXCEPTION 'Conflicting evidence identity sources' USING ERRCODE = '23514'; END IF;
      IF NEW."operationId" IS NOT NULL AND (
        (receipt.evidence->>'paypalOrderId' IS NOT NULL AND attempt."providerReference" IS NOT NULL
          AND receipt.evidence->>'paypalOrderId' IS DISTINCT FROM attempt."providerReference") OR
        (receipt.evidence->>'captureId' IS NOT NULL AND attempt."providerCaptureReference" IS NOT NULL
          AND receipt.evidence->>'captureId' IS DISTINCT FROM attempt."providerCaptureReference") OR
        (NEW.normalized->>'providerReference' IS NOT NULL AND attempt."providerReference" IS NOT NULL
          AND NEW.normalized->>'providerReference' IS DISTINCT FROM attempt."providerReference")
      ) THEN RAISE EXCEPTION 'Evidence receipt operation mismatch' USING ERRCODE = '23514'; END IF;
    END IF;
  ELSIF TG_TABLE_NAME = 'ReservationReleaseProof' THEN
    SELECT * INTO ev FROM "FinancialEvidence" WHERE id = NEW."evidenceId";
    IF NEW.type = 'PROVIDER_FINALITY' AND (ev."orderId" IS DISTINCT FROM NEW."orderId" OR ev.kind IS DISTINCT FROM 'TERMINAL_UNPAID'::"FinancialEvidenceKind" OR ev."verifiedAt" IS NULL) THEN
      RAISE EXCEPTION 'Release proof requires verified terminal unpaid evidence' USING ERRCODE = '23514'; END IF;
  ELSIF TG_TABLE_NAME = 'PaymentResolution' THEN
    IF NOT EXISTS (SELECT 1 FROM "Order" WHERE id=NEW."orderId" AND ("createdAt" AT TIME ZONE 'UTC')=NEW."orderCreatedAt") THEN
      RAISE EXCEPTION 'Resolution creation timestamp mismatch' USING ERRCODE = '23514'; END IF;
    IF TG_OP = 'UPDATE' THEN
      IF OLD."reservationDisposition" IS NOT NULL AND NEW."reservationDisposition" IS NULL THEN
        RAISE EXCEPTION 'Reservation disposition cannot become unknown' USING ERRCODE = '23514'; END IF;
      IF OLD."reservationDisposition" IN ('CONSUMED','RELEASED') AND (NEW."reservationDisposition" IS DISTINCT FROM OLD."reservationDisposition" OR NEW."dispositionAt" IS DISTINCT FROM OLD."dispositionAt") THEN
        RAISE EXCEPTION 'Terminal reservation disposition' USING ERRCODE = '23514'; END IF;
      IF OLD."paymentAdmissionClosedAt" IS NOT NULL AND NEW.state IN ('INITIAL_OPEN','INITIAL_WAIT','RETRY_OPEN') THEN
        RAISE EXCEPTION 'Permanent admission closure' USING ERRCODE = '23514'; END IF;
    END IF;
    IF NEW."firstFailureEvidenceId" IS NOT NULL THEN
      IF TG_OP = 'INSERT' OR (to_jsonb(OLD)->'firstFailureVerifiedAt') = 'null'::jsonb THEN
        IF NEW."reservationDisposition" IS DISTINCT FROM 'HELD' OR NEW."paymentAdmissionClosedAt" IS NOT NULL
          OR EXISTS (SELECT 1 FROM "Payment" WHERE "orderId" = NEW."orderId" AND (status = 'SUCCEEDED' OR "paidAt" IS NOT NULL))
          OR EXISTS (SELECT 1 FROM "FinancialEvidence" WHERE "orderId"=NEW."orderId" AND kind='SUCCESS') THEN
          RAISE EXCEPTION 'First failure requires unpaid held open reservation' USING ERRCODE = '23514'; END IF;
      END IF;
      SELECT * INTO op FROM "PaymentOperation" WHERE id = NEW."firstFailureOperationId";
      SELECT * INTO attempt FROM "PaymentAttempt" WHERE id = op."attemptId";
      IF attempt."orderId" IS DISTINCT FROM NEW."orderId" OR attempt.historical OR op.historical
        OR op."admittedAt" IS NULL OR attempt."admittedAt" IS NULL
        OR op.type NOT IN ('CONFIRM','CAPTURE') OR op.state <> 'RESULT_RECORDED'
        OR (op."evidenceId" IS DISTINCT FROM NEW."firstFailureEvidenceId" AND NOT EXISTS (
          SELECT 1 FROM "FinancialEvidence" prior WHERE prior.id=op."evidenceId" AND prior.kind='TERMINAL_UNPAID'
            AND prior."operationId"=op.id))
        OR op."admissionDeadline" IS DISTINCT FROM NEW."initialPaymentDeadline"
        OR op."admittedAt" < NEW."orderCreatedAt" OR op."admittedAt" >= NEW."initialPaymentDeadline"
        OR attempt."admittedAt" > op."admittedAt" THEN
        RAISE EXCEPTION 'First failure requires eligible admitted operation' USING ERRCODE = '23514'; END IF;
      IF (TG_OP = 'INSERT' OR (to_jsonb(OLD)->'firstFailureVerifiedAt') = 'null'::jsonb)
        AND NOT EXISTS (SELECT 1 FROM "Order" WHERE id = NEW."orderId" AND status = 'PENDING') THEN
        RAISE EXCEPTION 'Order ineligible for retry' USING ERRCODE = '23514'; END IF;
      SELECT * INTO ev FROM "FinancialEvidence" WHERE id = NEW."firstFailureEvidenceId";
      IF ev."orderId" IS DISTINCT FROM NEW."orderId" OR ev.kind IS DISTINCT FROM 'FAILURE'::"FinancialEvidenceKind" OR ev."verifiedAt" IS DISTINCT FROM NEW."firstFailureVerifiedAt" OR ev."operationId" IS DISTINCT FROM op.id THEN
        RAISE EXCEPTION 'Retry requires verified failure evidence' USING ERRCODE = '23514'; END IF;
    END IF;
    IF NEW."releaseProofId" IS NOT NULL THEN
      SELECT "orderId" INTO proof_order FROM "ReservationReleaseProof" WHERE id = NEW."releaseProofId";
      IF proof_order IS DISTINCT FROM NEW."orderId" THEN RAISE EXCEPTION 'Release proof order mismatch' USING ERRCODE = '23514'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMIT;
