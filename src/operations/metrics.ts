import { prisma } from '../prisma/runtime.js';
import { sweepAge } from './health.js';
export async function operationalMetrics() {
  // Counts only, never customer/provider identities or evidence. Monitor without replaying writes.
  const [row]=await prisma.$queryRaw<Array<{refunds:number;payments:number;emails:number;inventory:number;paymentAge:number;paypalAge:number;emailAge:number}>>`
    SELECT (SELECT count(*)::int FROM "Refund" WHERE "reviewRequired" OR status='PROCESSING') AS refunds,
    (SELECT count(*)::int FROM "PaymentResolution" WHERE "escalatedAt" IS NOT NULL OR "quarantineReason" IS NOT NULL) AS payments,
    (SELECT count(*)::int FROM "OrderConfirmationJob" WHERE state IN ('UNKNOWN','BLOCKED','FAILED')
      OR (state='PENDING' AND "nextAttemptAt"<clock_timestamp()-interval '10 minutes')) AS emails,
    (SELECT count(*)::int FROM "FbaOutbound" f WHERE shortfall>0 AND NOT EXISTS
      (SELECT 1 FROM "OperationalAudit" a WHERE a.kind='FBA_DISCREPANCY_RESOLVED' AND a."requestKey"='fba-resolved:'||f.id::text)) AS inventory,
    (SELECT COALESCE(max(EXTRACT(epoch FROM clock_timestamp()-"resolutionNextCheckAt")),0)::double precision FROM "PaymentResolution" WHERE "reservationDisposition"='HELD' AND "resolutionNextCheckAt"<clock_timestamp()) AS "paymentAge",
    (SELECT COALESCE(max(EXTRACT(epoch FROM clock_timestamp()-"receivedAt")),0)::double precision FROM "PaymentWebhookEvent" WHERE provider='PAYPAL' AND "processedAt" IS NULL) AS "paypalAge",
    (SELECT COALESCE(max(EXTRACT(epoch FROM clock_timestamp()-"nextAttemptAt")),0)::double precision FROM "OrderConfirmationJob" WHERE state='PENDING' AND "nextAttemptAt"<clock_timestamp()) AS "emailAge"`;
  const values={WorkerHeartbeat:1,PaymentSweepAge:sweepAge('payment'),PayPalSweepAge:sweepAge('paypal'),CartSweepAge:sweepAge('cart'),
    PaymentDueAge:row.paymentAge,PayPalInboxAge:row.paypalAge,EmailDueAge:row.emailAge,RefundBacklog:row.refunds,PaymentReviewBacklog:row.payments,EmailBacklog:row.emails,InventoryDiscrepancies:row.inventory};
  console.log(JSON.stringify({_aws:{Timestamp:Date.now(),CloudWatchMetrics:[{Namespace:'ColorfulLife',Dimensions:[['Environment']],Metrics:Object.keys(values).map(Name=>({Name,Unit:Name.endsWith('Age')?'Seconds':'Count'}))}]},Environment:process.env.DEPLOYMENT_ENVIRONMENT,...values}));
}
