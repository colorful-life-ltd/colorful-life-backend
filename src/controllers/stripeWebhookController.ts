import {logOperationalError} from "../utils/operationalLog.js";
import { retainStripeDispute } from "../domain/payments/stripeDisputeService.js";
import type { Request, Response } from "express";
import Stripe from "stripe";
import { config } from "../config/index.js";
import { reconcileStripePaymentEvent, reconcileStripeRefundEvent } from "../domain/payments/stripeReconciliationService.js";

export async function stripeWebhookHandler(req: Request, res: Response) {
  if (!config.STRIPE_WEBHOOK_SECRET || !Buffer.isBuffer(req.body)) return res.status(400).json({ error: "Invalid webhook" });
  let event: Stripe.Event;
  try { event = new Stripe(config.STRIPE_SECRET_KEY ?? "").webhooks.constructEvent(req.body, req.headers["stripe-signature"] as string, config.STRIPE_WEBHOOK_SECRET); }
  catch { return res.status(400).json({ error: "Invalid webhook" }); }
  try {
    if(['charge.dispute.created','charge.dispute.updated','charge.dispute.closed','charge.dispute.funds_withdrawn','charge.dispute.funds_reinstated'].includes(event.type)) {
      await retainStripeDispute(event.id,event.type,event.data.object as Stripe.Dispute);return res.sendStatus(200);
    }
    if (["refund.created", "refund.updated", "refund.failed"].includes(event.type)) {
      const refund = event.data.object as Stripe.Refund;
      const paymentIntent = typeof refund.payment_intent === "string" ? refund.payment_intent : refund.payment_intent?.id;
      await reconcileStripeRefundEvent({ id: event.id, type: event.type as "refund.created" | "refund.updated" | "refund.failed", refundId: refund.id, paymentIntentId: typeof paymentIntent === "string" ? paymentIntent : undefined, amount: refund.amount, currency: refund.currency ?? "", status: refund.status ?? "", metadata: refund.metadata ?? undefined });
      return res.sendStatus(200);
    }
    if (!["payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.canceled"].includes(event.type)) return res.sendStatus(200);
    const intent = event.data.object as Stripe.PaymentIntent;
    await reconcileStripePaymentEvent({ id: event.id, type: event.type as "payment_intent.succeeded" | "payment_intent.payment_failed" | "payment_intent.canceled", paymentIntentId: intent.id, amount: intent.amount, currency: intent.currency, metadata: intent.metadata });
    return res.sendStatus(200);
  } catch (error) {
    logOperationalError("Stripe webhook reconciliation failed; durable evidence retained when persisted", error);
    // Express 4 does not forward rejected async handlers automatically.
    // Tell Stripe to redeliver; the failed reconciliation transaction rolled back.
    return res.status(500).json({ error: "Webhook reconciliation failed" });
  }
}
