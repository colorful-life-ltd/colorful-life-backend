-- Additive durable webhook inbox. Historical receipts have no evidence backfill.
ALTER TABLE "PaymentWebhookEvent" ADD COLUMN "evidence" JSONB;
CREATE INDEX "PaymentWebhookEvent_provider_processedAt_id_idx"
  ON "PaymentWebhookEvent"("provider", "processedAt", "id");
