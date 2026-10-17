-- Additive inbox review metadata; existing evidence and financial guards unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
ALTER TABLE "PaymentWebhookEvent" ADD COLUMN "reviewDetails" JSONB,
  ADD COLUMN "reviewedAt" TIMESTAMPTZ(3);
CREATE INDEX "PaymentWebhookEvent_provider_reviewedAt_id_idx"
  ON "PaymentWebhookEvent"("provider", "reviewedAt", "id");
COMMIT;
