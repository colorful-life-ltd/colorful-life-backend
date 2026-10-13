BEGIN;
SET LOCAL lock_timeout='5s';
CREATE FUNCTION payment_runtime_inbox_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM "Order" WHERE id=NEW."orderId" FOR UPDATE;
 IF EXISTS (
  SELECT 1 FROM "PaymentWebhookEvent" w WHERE
   (w.evidence->>'orderId'=NEW."orderId"::text OR EXISTS(
    SELECT 1 FROM "PaymentAttempt" a WHERE a."orderId"=NEW."orderId" AND a.provider=w.provider
     AND ((w.evidence->>'paymentIntentId'=a."providerReference") OR (w.evidence->>'paypalOrderId'=a."providerReference")
      OR (w.evidence->>'captureId'=a."providerCaptureReference")
      OR w."providerEventId"='recovery:'||a."paymentId"::text||':'||a."providerReference"||':succeeded')))
   AND (w."processedAt" IS NULL OR w."processingError" IS NOT NULL
    OR w."eventType" IN ('payment_intent.succeeded','payment_intent.recovered','PAYMENT.CAPTURE.COMPLETED'))
 ) THEN RAISE EXCEPTION 'Relevant provider inbox evidence prohibits release' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER proof_runtime_inbox_guard BEFORE INSERT OR UPDATE ON "ReservationReleaseProof" FOR EACH ROW EXECUTE FUNCTION payment_runtime_inbox_guard();
COMMIT;
