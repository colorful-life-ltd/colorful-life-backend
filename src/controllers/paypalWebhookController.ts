import { paypalRiskEvents, normalizePayPalRiskResource } from '../domain/payments/paypalRiskEvents.js';
import { reconcileRefundWebhook } from "../domain/refunds/refundWebhookService.js";
import { paypalRefundParent } from "../domain/refunds/paypalRefundService.js";
import type { Request, Response } from "express";
import { config } from "../config/index.js";
import { reconcilePayPalWebhookEvent } from "../domain/payments/paypalReconciliationService.js";

type PayPalResource = { custom_id?: string; id?: string; status?: string; amount?: { value?: string; currency_code?: string }; supplementary_data?: { related_ids?: { order_id?: string } }; links?: Array<{ rel?: string; href?: string }> };

const refundWebhookTypes = new Set(["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.REFUND.PENDING", "PAYMENT.REFUND.FAILED"]);

export function buildPayPalRefundDiagnostic(event: { id?: string; event_type?: string; resource_type?: string; resource?: PayPalResource }) {
  if (!event.id || !event.event_type || !refundWebhookTypes.has(event.event_type)) return null;
  const resource = event.resource ?? {};
  const relatedIds = resource.supplementary_data?.related_ids;
  return {
    eventId: event.id,
    eventType: event.event_type,
    ...(event.resource_type ? { resourceType: event.resource_type } : {}),
    ...(resource.id ? { resourceId: resource.id } : {}),
    ...(resource.status ? { resourceStatus: resource.status } : {}),
    ...(resource.amount?.value ? { amountValue: resource.amount.value } : {}),
    ...(resource.amount?.currency_code ? { amountCurrency: resource.amount.currency_code } : {}),
    ...(relatedIds ? { relatedIds: { ...relatedIds } } : {}),
    resourceKeys: Object.keys(resource).sort(),
  };
}

export type PayPalWebhookVerifier = (body: Buffer, req: Request) => Promise<boolean>;

async function verifyPayPalWebhookWithPayPal(body: Buffer, req: Request): Promise<boolean> {
  if (!config.PAYPAL_WEBHOOK_ID || !config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET) return false;
  try {
    const credentials = Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString("base64");
    const auth = await fetch(`${config.PAYPAL_BASE_URL}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
    if (!auth.ok) return false;
    const token = (await auth.json() as { access_token?: string }).access_token;
    if (!token) return false;
    const response = await fetch(`${config.PAYPAL_BASE_URL}/v1/notifications/verify-webhook-signature`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ auth_algo: req.headers["paypal-auth-algo"], cert_url: req.headers["paypal-cert-url"], transmission_id: req.headers["paypal-transmission-id"], transmission_sig: req.headers["paypal-transmission-sig"], transmission_time: req.headers["paypal-transmission-time"], webhook_id: config.PAYPAL_WEBHOOK_ID, webhook_event: JSON.parse(body.toString("utf8")) }) });
    return response.ok && (await response.json() as { verification_status?: string }).verification_status === "SUCCESS";
  } catch { return false; }
}

let webhookVerifier: PayPalWebhookVerifier = verifyPayPalWebhookWithPayPal;

export function setPayPalWebhookVerifierForTests(verifier: PayPalWebhookVerifier): () => void {
  const previous = webhookVerifier;
  webhookVerifier = verifier;
  return () => { webhookVerifier = previous; };
}

export async function paypalWebhookHandler(req: Request, res: Response) {
  if (!Buffer.isBuffer(req.body) || !(await webhookVerifier(req.body, req))) return res.status(400).json({ error: "Invalid webhook" });
  let event: { id?: string; event_type?: string; resource?: PayPalResource };
  try { event = JSON.parse(req.body.toString("utf8")) as typeof event; } catch { return res.status(400).json({ error: "Invalid webhook" }); }
  if (!event || typeof event.id !== "string" || !event.id || event.id.length > 256 || typeof event.event_type !== "string" || !event.event_type || event.event_type.length > 100) return res.status(400).json({ error: "Invalid webhook" });
  if (process.env.NODE_ENV !== "production") {
    const diagnostic = buildPayPalRefundDiagnostic(event);
    if (diagnostic) console.info("PayPal refund webhook diagnostic", diagnostic);
  }
  const resource = event.resource ?? {};
  try {
    if (paypalRiskEvents.includes(event.event_type)) {
      const result = await reconcilePayPalWebhookEvent({ id: event.id, eventType: event.event_type, ...normalizePayPalRiskResource(event.event_type, event.resource) });
      return res.status(200).json(result);
    }
    if(refundWebhookTypes.has(event.event_type)){
      const local=resource.custom_id===undefined?undefined:/^cl-refund-([1-9][0-9]*)$/.exec(resource.custom_id)?.[1]??"invalid";
      const result=await reconcileRefundWebhook({version:2,kind:"refund",provider:"PAYPAL",id:event.id,eventType:event.event_type,
        reference:resource.id,parentReference:paypalRefundParent(resource),localRefundId:local,
        amount:resource.amount?.value,currency:resource.amount?.currency_code,
        status:event.event_type==="PAYMENT.REFUND.PENDING"&&resource.status!=="PENDING"||event.event_type==="PAYMENT.REFUND.FAILED"&&resource.status!=="FAILED"?"UNKNOWN":resource.status==="COMPLETED"?"SUCCEEDED":resource.status==="FAILED"||resource.status==="CANCELLED"?"FAILED":resource.status==="PENDING"?"PENDING":"UNKNOWN"});
      return res.status(200).json(result);
    }
    const result = await reconcilePayPalWebhookEvent({ id: event.id, eventType: event.event_type, captureId: resource.id, paypalOrderId: resource.supplementary_data?.related_ids?.order_id, amount: resource.amount?.value, currency: resource.amount?.currency_code });
    return res.status(200).json(result);
  } catch {
    // Never acknowledge persistence failures. Processing rollback leaves the
    // committed evidence pending for durable replay, including unique conflicts.
    return res.status(500).json({ error: "Webhook processing failed" });
  }
}
