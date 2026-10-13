BEGIN;
-- CreateEnum
CREATE TYPE "ReservationDisposition" AS ENUM ('HELD', 'CONSUMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "PaymentResolutionState" AS ENUM ('INITIAL_OPEN', 'INITIAL_WAIT', 'RETRY_OPEN', 'CLOSED_RESOLVING', 'SAFETY_HOLD', 'PAID', 'RELEASED', 'REVIEW_REQUIRED');

-- CreateEnum
CREATE TYPE "PaymentOperationType" AS ENUM ('CREATE', 'CONFIRM', 'CAPTURE', 'TERMINATE', 'RETRIEVE');

-- CreateEnum
CREATE TYPE "PaymentOperationState" AS ENUM ('PREPARED', 'POTENTIALLY_DISPATCHED', 'RESULT_RECORDED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "FinancialEvidenceKind" AS ENUM ('HISTORICAL_UNVERIFIED', 'FAILURE', 'SUCCESS', 'TERMINAL_UNPAID');

-- CreateTable
CREATE TABLE "PaymentAttempt" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "paymentId" INTEGER NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "providerReference" TEXT,
    "providerCaptureReference" TEXT,
    "creationKey" TEXT,
    "admittedAt" TIMESTAMPTZ(3),
    "historical" BOOLEAN NOT NULL DEFAULT false,
    "successEvidenceId" INTEGER,
    "finalityEvidenceId" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentOperation" (
    "id" SERIAL NOT NULL,
    "attemptId" INTEGER NOT NULL,
    "type" "PaymentOperationType" NOT NULL,
    "operationKey" VARCHAR(128) NOT NULL,
    "requestHash" VARCHAR(64),
    "admittedAt" TIMESTAMPTZ(3),
    "historical" BOOLEAN NOT NULL DEFAULT false,
    "state" "PaymentOperationState" NOT NULL DEFAULT 'PREPARED',
    "evidenceId" INTEGER,
    "admissionDeadline" TIMESTAMPTZ(3),
    "claimOwner" VARCHAR(128),
    "claimGeneration" INTEGER NOT NULL DEFAULT 0,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "executionCount" INTEGER NOT NULL DEFAULT 0,
    "nextCheckAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(100),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentOperation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialEvidence" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "provider" "PaymentProvider" NOT NULL,
    "evidenceKey" VARCHAR(256) NOT NULL,
    "kind" "FinancialEvidenceKind" NOT NULL,
    "normalized" JSONB NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3),
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "webhookEventId" INTEGER,
    "operationId" INTEGER,

    CONSTRAINT "FinancialEvidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReservationReleaseProof" (
    "id" SERIAL NOT NULL,
    "orderId" INTEGER NOT NULL,
    "evidenceId" INTEGER NOT NULL,
    "decisionVersion" INTEGER NOT NULL,
    "coverage" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservationReleaseProof_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentResolution" (
    "orderId" INTEGER NOT NULL,
    "state" "PaymentResolutionState" NOT NULL DEFAULT 'INITIAL_OPEN',
    "orderCreatedAt" TIMESTAMPTZ(3) NOT NULL,
    "initialPaymentDeadline" TIMESTAMPTZ(3) NOT NULL,
    "firstFailureVerifiedAt" TIMESTAMPTZ(3),
    "retryDeadline" TIMESTAMPTZ(3),
    "firstFailureOperationId" INTEGER,
    "firstFailureEvidenceId" INTEGER,
    "paymentAdmissionClosedAt" TIMESTAMPTZ(3),
    "closureReason" VARCHAR(100),
    "reservationDisposition" "ReservationDisposition",
    "dispositionAt" TIMESTAMPTZ(3),
    "releaseProofId" INTEGER,
    "resolutionNextCheckAt" TIMESTAMPTZ(3),
    "escalatedAt" TIMESTAMPTZ(3),
    "quarantineReason" VARCHAR(200),
    "historical" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "PaymentResolution_pkey" PRIMARY KEY ("orderId")
);

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_creationKey_key" ON "PaymentAttempt"("creationKey");

-- CreateIndex
CREATE INDEX "PaymentAttempt_orderId_id_idx" ON "PaymentAttempt"("orderId", "id");

-- CreateIndex
CREATE INDEX "PaymentAttempt_paymentId_idx" ON "PaymentAttempt"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_provider_providerReference_key" ON "PaymentAttempt"("provider", "providerReference");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentAttempt_provider_providerCaptureReference_key" ON "PaymentAttempt"("provider", "providerCaptureReference");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentOperation_operationKey_key" ON "PaymentOperation"("operationKey");

-- CreateIndex
CREATE INDEX "PaymentOperation_state_nextCheckAt_id_idx" ON "PaymentOperation"("state", "nextCheckAt", "id");

-- CreateIndex
CREATE INDEX "PaymentOperation_attemptId_id_idx" ON "PaymentOperation"("attemptId", "id");

-- CreateIndex
CREATE INDEX "FinancialEvidence_orderId_id_idx" ON "FinancialEvidence"("orderId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "FinancialEvidence_provider_evidenceKey_key" ON "FinancialEvidence"("provider", "evidenceKey");

-- CreateIndex
CREATE INDEX "ReservationReleaseProof_orderId_id_idx" ON "ReservationReleaseProof"("orderId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentResolution_releaseProofId_key" ON "PaymentResolution"("releaseProofId");

-- CreateIndex
CREATE INDEX "PaymentResolution_state_resolutionNextCheckAt_orderId_idx" ON "PaymentResolution"("state", "resolutionNextCheckAt", "orderId");

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_successEvidenceId_fkey" FOREIGN KEY ("successEvidenceId") REFERENCES "FinancialEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "PaymentAttempt_finalityEvidenceId_fkey" FOREIGN KEY ("finalityEvidenceId") REFERENCES "FinancialEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOperation" ADD CONSTRAINT "PaymentOperation_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "PaymentAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentOperation" ADD CONSTRAINT "PaymentOperation_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "FinancialEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialEvidence" ADD CONSTRAINT "FinancialEvidence_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialEvidence" ADD CONSTRAINT "FinancialEvidence_webhookEventId_fkey" FOREIGN KEY ("webhookEventId") REFERENCES "PaymentWebhookEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialEvidence" ADD CONSTRAINT "FinancialEvidence_operationId_fkey" FOREIGN KEY ("operationId") REFERENCES "PaymentOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationReleaseProof" ADD CONSTRAINT "ReservationReleaseProof_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReservationReleaseProof" ADD CONSTRAINT "ReservationReleaseProof_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "FinancialEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentResolution" ADD CONSTRAINT "PaymentResolution_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentResolution" ADD CONSTRAINT "PaymentResolution_firstFailureOperationId_fkey" FOREIGN KEY ("firstFailureOperationId") REFERENCES "PaymentOperation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentResolution" ADD CONSTRAINT "PaymentResolution_firstFailureEvidenceId_fkey" FOREIGN KEY ("firstFailureEvidenceId") REFERENCES "FinancialEvidence"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentResolution" ADD CONSTRAINT "PaymentResolution_releaseProofId_fkey" FOREIGN KEY ("releaseProofId") REFERENCES "ReservationReleaseProof"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Preserve one historical snapshot per aggregate even for NULL placeholder identities.
CREATE UNIQUE INDEX "PaymentAttempt_historical_payment_key" ON "PaymentAttempt" ("paymentId") WHERE historical;

-- Foundation only: these checks never change existing Order, Payment or stock.
ALTER TABLE "PaymentResolution" ADD CONSTRAINT "resolution_deadlines" CHECK (
  "initialPaymentDeadline" = "orderCreatedAt" + interval '30 minutes'
  AND (("firstFailureVerifiedAt" IS NULL AND "retryDeadline" IS NULL AND "firstFailureEvidenceId" IS NULL AND "firstFailureOperationId" IS NULL)
    OR ("firstFailureVerifiedAt" IS NOT NULL AND "retryDeadline" IS NOT NULL AND "firstFailureEvidenceId" IS NOT NULL AND "firstFailureOperationId" IS NOT NULL
      AND "retryDeadline" = "firstFailureVerifiedAt" + interval '30 minutes'))
  AND (("paymentAdmissionClosedAt" IS NULL AND "closureReason" IS NULL)
    OR ("paymentAdmissionClosedAt" IS NOT NULL AND "closureReason" IS NOT NULL AND length("closureReason") > 0))
);
-- Unconditional Phase 2A gate. Phase 2B needs independent review before replacement.
ALTER TABLE "PaymentResolution" ADD CONSTRAINT "phase2a_no_release" CHECK (
  "reservationDisposition" IS DISTINCT FROM 'RELEASED' AND "state" <> 'RELEASED'
);
ALTER TABLE "PaymentResolution" ADD CONSTRAINT "resolution_disposition" CHECK (
  (("reservationDisposition" IS NULL AND "dispositionAt" IS NULL AND "state" = 'REVIEW_REQUIRED' AND "quarantineReason" IS NOT NULL)
    OR ("reservationDisposition" IS NOT NULL AND "dispositionAt" IS NOT NULL))
  AND ("reservationDisposition" IS DISTINCT FROM 'RELEASED' OR
    ("releaseProofId" IS NOT NULL AND "paymentAdmissionClosedAt" IS NOT NULL AND "state" = 'RELEASED'))
  AND ("state" <> 'RELEASED' OR "reservationDisposition" = 'RELEASED')
  AND ("state" <> 'RETRY_OPEN' OR ("retryDeadline" IS NOT NULL AND "paymentAdmissionClosedAt" IS NULL AND "reservationDisposition" = 'HELD'))
  AND ("reservationDisposition" IS DISTINCT FROM 'CONSUMED' OR "state" = 'PAID')
  AND ("state" NOT IN ('INITIAL_OPEN','INITIAL_WAIT','RETRY_OPEN') OR "paymentAdmissionClosedAt" IS NULL)
);
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "attempt_admission" CHECK (
  ("historical" AND "admittedAt" IS NULL) OR (NOT "historical" AND "admittedAt" IS NOT NULL AND "creationKey" IS NOT NULL)
);
ALTER TABLE "PaymentAttempt" ADD CONSTRAINT "attempt_amount" CHECK ("amount" > 0 AND "currency" ~ '^[A-Z]{3}$');
ALTER TABLE "PaymentOperation" ADD CONSTRAINT "operation_metadata" CHECK (
  (("historical" AND "admittedAt" IS NULL AND "requestHash" IS NULL AND "admissionDeadline" IS NULL) OR
    (NOT "historical" AND "admittedAt" IS NOT NULL AND "requestHash" IS NOT NULL AND "requestHash" ~ '^[0-9a-f]{64}$'))
  AND ("historical" OR "type" NOT IN ('CREATE','CONFIRM','CAPTURE') OR ("admissionDeadline" IS NOT NULL AND "admittedAt" < "admissionDeadline"))
  AND "claimGeneration" >= 0 AND "executionCount" >= 0
  AND (("claimOwner" IS NULL AND "leaseExpiresAt" IS NULL) OR ("claimOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL))
  AND ("state" <> 'RESULT_RECORDED' OR "evidenceId" IS NOT NULL)
);
ALTER TABLE "FinancialEvidence" ADD CONSTRAINT "evidence_verified" CHECK (
  jsonb_typeof("normalized") = 'object'
  AND (("kind" = 'HISTORICAL_UNVERIFIED' AND "verifiedAt" IS NULL) OR ("kind" <> 'HISTORICAL_UNVERIFIED' AND "verifiedAt" IS NOT NULL AND "operationId" IS NOT NULL))
);
ALTER TABLE "ReservationReleaseProof" ADD CONSTRAINT "proof_version" CHECK ("decisionVersion" > 0 AND jsonb_typeof("coverage") = 'object');

-- Write-once nullable identity bindings; immutable timestamps are not resettable.
CREATE FUNCTION payment_foundation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE field text; before_value jsonb; after_value jsonb;
BEGIN
  FOREACH field IN ARRAY TG_ARGV LOOP
    before_value := to_jsonb(OLD)->field; after_value := to_jsonb(NEW)->field;
    IF before_value <> 'null'::jsonb AND before_value IS DISTINCT FROM after_value THEN
      RAISE EXCEPTION 'Immutable payment foundation field: %', field USING ERRCODE = '23514';
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER resolution_immutable BEFORE UPDATE ON "PaymentResolution" FOR EACH ROW EXECUTE FUNCTION payment_foundation_immutable(
  'orderId','orderCreatedAt','initialPaymentDeadline','firstFailureVerifiedAt','retryDeadline','firstFailureEvidenceId','firstFailureOperationId','paymentAdmissionClosedAt','closureReason','releaseProofId','historical');
CREATE TRIGGER attempt_immutable BEFORE UPDATE ON "PaymentAttempt" FOR EACH ROW EXECUTE FUNCTION payment_foundation_immutable(
  'id','orderId','paymentId','provider','amount','currency','providerReference','providerCaptureReference','creationKey','admittedAt','historical','createdAt','successEvidenceId','finalityEvidenceId');
CREATE TRIGGER operation_immutable BEFORE UPDATE ON "PaymentOperation" FOR EACH ROW EXECUTE FUNCTION payment_foundation_immutable(
  'id','attemptId','type','operationKey','requestHash','admittedAt','admissionDeadline','historical','createdAt','evidenceId');
CREATE TRIGGER evidence_immutable BEFORE UPDATE ON "FinancialEvidence" FOR EACH ROW EXECUTE FUNCTION payment_foundation_immutable(
  'id','orderId','provider','evidenceKey','kind','normalized','verifiedAt','receivedAt','webhookEventId','operationId');
CREATE TRIGGER proof_immutable BEFORE UPDATE ON "ReservationReleaseProof" FOR EACH ROW EXECUTE FUNCTION payment_foundation_immutable(
  'id','orderId','evidenceId','decisionVersion','coverage','createdAt');

CREATE FUNCTION payment_foundation_validate() RETURNS trigger LANGUAGE plpgsql AS $$
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
    IF ev."orderId" IS DISTINCT FROM NEW."orderId" OR ev.kind IS DISTINCT FROM 'TERMINAL_UNPAID'::"FinancialEvidenceKind" OR ev."verifiedAt" IS NULL THEN
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
        OR op."evidenceId" IS DISTINCT FROM NEW."firstFailureEvidenceId"
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
CREATE TRIGGER attempt_validate BEFORE INSERT OR UPDATE ON "PaymentAttempt" FOR EACH ROW EXECUTE FUNCTION payment_foundation_validate();
CREATE TRIGGER operation_validate BEFORE INSERT OR UPDATE ON "PaymentOperation" FOR EACH ROW EXECUTE FUNCTION payment_foundation_validate();
CREATE TRIGGER evidence_validate BEFORE INSERT OR UPDATE ON "FinancialEvidence" FOR EACH ROW EXECUTE FUNCTION payment_foundation_validate();
CREATE TRIGGER proof_validate BEFORE INSERT OR UPDATE ON "ReservationReleaseProof" FOR EACH ROW EXECUTE FUNCTION payment_foundation_validate();
CREATE TRIGGER resolution_validate BEFORE INSERT OR UPDATE ON "PaymentResolution" FOR EACH ROW EXECUTE FUNCTION payment_foundation_validate();


COMMIT;
