import type Stripe from 'stripe';
import type { Prisma } from '../../generated/prisma-client/client.js';
import { prisma } from '../../prisma/runtime.js';
/** A verified formal dispute exists for this intent. Stripe refuses refunds on disputed payments; inquiries
 * (`warning_*`) can still be resolved by refunding. A receipt without a status is treated as formal. */
export async function hasFormalStripeDispute(tx: Prisma.TransactionClient, paymentIntentId: string) {
    const [row] = await tx.$queryRaw<Array<{ id: number }>> `SELECT id FROM "PaymentWebhookEvent" WHERE provider='STRIPE'
      AND evidence->>'kind'='stripe-dispute' AND evidence->>'paymentIntentId'=${paymentIntentId}
      AND left(COALESCE(evidence->>'status',''),8)<>'warning_' LIMIT 1`;
    return !!row;
}
/** Called only after Stripe signature verification. A dispute never rewrites money. */
export async function retainStripeDispute(eventId: string, eventType: string, dispute: Stripe.Dispute) {
    const paymentIntentId = typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id;
    const evidence = { kind: 'stripe-dispute', version: 1, disputeId: dispute.id, ...(paymentIntentId ? { paymentIntentId } : {}), status: dispute.status,
        amount: dispute.amount, currency: dispute.currency };
    return prisma.$transaction(async (tx) => {
        const payment = paymentIntentId ? await tx.payment.findFirst({ where: { provider: 'STRIPE', providerReference: paymentIntentId } }) : null;
        if (payment) {
            await tx.$queryRaw `SELECT id FROM "Order" WHERE id=${payment.orderId} FOR NO KEY UPDATE`;
            await tx.$queryRaw `SELECT id FROM "Payment" WHERE id=${payment.id} FOR UPDATE`;
        }
        await tx.$executeRaw `INSERT INTO "PaymentWebhookEvent" (provider,"providerEventId","eventType",evidence,"processedAt","processingError")
      VALUES ('STRIPE',${eventId},${eventType},${JSON.stringify(evidence)}::jsonb,clock_timestamp(),'STRIPE_DISPUTE_REVIEW_REQUIRED')
      ON CONFLICT (provider,"providerEventId") DO NOTHING`;
        const saved = await tx.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'STRIPE', providerEventId: eventId } } });
        if (saved.eventType !== eventType || JSON.stringify(saved.evidence) !== JSON.stringify(JSON.parse(JSON.stringify(evidence)))) {
            // JSONB key order is canonicalized by PostgreSQL: compare individual data instead below.
            const old = saved.evidence as Record<string, unknown>;
            if (saved.eventType !== eventType || Object.keys(evidence).some(k => old?.[k] !== evidence[k as keyof typeof evidence]))
                throw new Error('Conflicting verified dispute receipt');
        }
        console.warn(JSON.stringify({ kind: 'PROVIDER_DISPUTE_REVIEW_REQUIRED', provider: 'STRIPE', correlated: !!payment }));
        // Conservative: even a 'won' notification requires an operator to establish
        // all disputes for this payment are closed. Never auto-release a hold.
    });
}
