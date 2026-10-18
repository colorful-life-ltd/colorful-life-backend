import type {Payment,Prisma} from '../../generated/prisma-client/client.js';
/** Only locally bound provider IDs, including historical attempts. Metadata cannot claim ownership. */
export async function providerFinancialHold(tx:Prisma.TransactionClient,payment:Payment):Promise<'REFUND'|'DISPUTE'|'PAYMENT'|null>{
 if(payment.provider==='MANUAL')return null;
 const [refund]=await tx.$queryRaw<Array<{id:number}>>`SELECT e.id FROM "PaymentWebhookEvent" e
 WHERE e.provider=${payment.provider}::"PaymentProvider" AND e.evidence->>'kind'='refund'
 AND (e.evidence->>'parentReference'=${payment.provider==='STRIPE'?payment.providerReference:payment.providerCaptureReference}
  OR EXISTS(SELECT 1 FROM "PaymentAttempt" a WHERE a."paymentId"=${payment.id} AND a.provider=e.provider
   AND e.evidence->>'parentReference'=CASE WHEN e.provider='STRIPE' THEN a."providerReference" ELSE a."providerCaptureReference" END))
 AND (e."processedAt" IS NULL OR e."processingError" IN ('REFUND_UNCORRELATED','REFUND_CORRELATION_MISMATCH','REFUND_EVIDENCE_INCOMPLETE')) LIMIT 1`;
 if(refund)return 'REFUND';
 if(payment.provider==='STRIPE'){
  const [risk]=await tx.$queryRaw<Array<{kind:string}>>`SELECT CASE WHEN e.evidence->>'kind'='stripe-dispute' THEN 'DISPUTE' ELSE 'PAYMENT' END kind
   FROM "PaymentWebhookEvent" e WHERE e.provider='STRIPE' AND e."processingError" IS NOT NULL
   AND (e.evidence->>'kind'='stripe-dispute' OR e."eventType" IN ('payment_intent.succeeded','payment_intent.payment_failed','payment_intent.canceled'))
   AND (e.evidence->>'paymentIntentId'=${payment.providerReference} OR EXISTS(SELECT 1 FROM "PaymentAttempt" a WHERE a."paymentId"=${payment.id} AND a.provider='STRIPE' AND a."providerReference"=e.evidence->>'paymentIntentId')) LIMIT 1`;
  if(risk)return risk.kind as 'DISPUTE'|'PAYMENT';
 }else{
  const [risk]=await tx.$queryRaw<Array<{id:number}>>`SELECT id FROM "PaymentWebhookEvent" WHERE provider='PAYPAL'
   AND "reviewDetails"->'correlations' @> ${JSON.stringify([{orderId:payment.orderId,paymentId:payment.id}])}::jsonb LIMIT 1`;
  if(risk)return 'DISPUTE'; // Operational acknowledgement is never financial clearance.
 }
 return null;
}
