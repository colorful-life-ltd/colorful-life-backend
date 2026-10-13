BEGIN ISOLATION LEVEL REPEATABLE READ;
-- Conservative, replay-safe historical snapshot. No fabricated admission/finality.
INSERT INTO "PaymentResolution" ("orderId","state","orderCreatedAt","initialPaymentDeadline","historical","quarantineReason")
SELECT id, 'REVIEW_REQUIRED', "createdAt" AT TIME ZONE 'UTC', ("createdAt" AT TIME ZONE 'UTC') + interval '30 minutes', true,
  'Historical reservation disposition and admission require verified reconstruction'
FROM "Order" ON CONFLICT ("orderId") DO NOTHING;
INSERT INTO "PaymentAttempt" ("orderId","paymentId",provider,amount,currency,"providerReference","providerCaptureReference","creationKey",historical)
SELECT "orderId",id,provider,amount,currency,CASE WHEN "providerReference" LIKE 'pending:%' THEN NULL ELSE "providerReference" END,
  "providerCaptureReference","idempotencyKey",true FROM "Payment" p
WHERE NOT EXISTS (SELECT 1 FROM "PaymentAttempt" a WHERE a."paymentId"=p.id AND a.historical)
ON CONFLICT ("paymentId") WHERE historical DO NOTHING;
INSERT INTO "FinancialEvidence" ("orderId",provider,"evidenceKey",kind,normalized)
SELECT "orderId",provider,'historical:payment:' || id,'HISTORICAL_UNVERIFIED',
  jsonb_build_object('version',1,'paymentId',id,'localStatus',status,'localPaidAt',"paidAt") FROM "Payment"
ON CONFLICT (provider,"evidenceKey") DO NOTHING;
INSERT INTO "PaymentOperation" ("attemptId",type,"operationKey",historical,state)
SELECT id,'CREATE','historical:attempt:' || id || ':unknown',true,'UNKNOWN' FROM "PaymentAttempt" WHERE historical
ON CONFLICT ("operationKey") DO NOTHING;


COMMIT;
