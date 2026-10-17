import type { Request } from 'express';
import { z } from 'zod';
import { config } from '../../config/index.js';

export const PAYPAL_WEBHOOK_VERIFICATION_TIMEOUT_MS = 5_000;
export class PayPalWebhookVerificationUnavailableError extends Error {
  constructor() { super('PayPal webhook verification unavailable'); }
}
const environments = {
  'https://api-m.sandbox.paypal.com': ['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com'],
  'https://api.sandbox.paypal.com': ['api-m.sandbox.paypal.com', 'api.sandbox.paypal.com'],
  'https://api-m.paypal.com': ['api-m.paypal.com', 'api.paypal.com'],
  'https://api.paypal.com': ['api-m.paypal.com', 'api.paypal.com'],
} as const;
const headerNames = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'] as const;

function transmissionHeaders(req: Request) {
  const values: Record<string, string> = {};
  for (const name of headerNames) {
    const value = req.headers[name];
    // Node may combine repeated headers into one value. Reject duplicate wire
    // headers as well as arrays and comma-joined values; do not choose a winner.
    const count = (req.rawHeaders ?? []).filter((_, i) => i % 2 === 0 && req.rawHeaders[i].toLowerCase() === name).length;
    if (typeof value !== 'string' || !value || value.length > 500 || count > 1 || /[\s,]/.test(value)) return null;
    values[name] = value;
  }
  if (values['paypal-auth-algo'] !== 'SHA256withRSA'
    || !/^(?!\d+$)[A-Za-z0-9_-]{1,50}$/.test(values['paypal-transmission-id'])
    || !z.string().datetime({ offset: true }).max(100).safeParse(values['paypal-transmission-time']).success) return null;
  const signature = values['paypal-transmission-sig'];
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(signature)
    || Buffer.from(signature, 'base64').toString('base64') !== signature) return null;
  return values;
}

/** Official postback verification. Raw bytes are embedded verbatim in
 * webhook_event, never parsed and reserialized. No provider payload is logged. */
export async function verifyPayPalWebhookWithPayPal(body: Buffer, req: Request): Promise<boolean> {
  const headers = transmissionHeaders(req);
  if (!headers) return false;
  // Reject invalid UTF-8 and non-object JSON locally. Parsed data has no authority
  // and is never passed to reconciliation before PayPal returns SUCCESS.
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    const event: unknown = JSON.parse(text);
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  } catch { return false; }
  const base = config.PAYPAL_BASE_URL.replace(/\/$/, '');
  const hosts = environments[base as keyof typeof environments] as readonly string[] | undefined;
  if (!hosts || !config.PAYPAL_CLIENT_ID || !config.PAYPAL_CLIENT_SECRET
    || !/^[A-Za-z0-9]{1,50}$/.test(config.PAYPAL_WEBHOOK_ID ?? '')) throw new PayPalWebhookVerificationUnavailableError();
  const certificate = /^https:\/\/([^/]+)\/v1\/notifications\/certs\/CERT-[A-Za-z0-9-]+$/.exec(headers['paypal-cert-url']);
  if (!certificate || !hosts.includes(certificate[1])) return false;

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new PayPalWebhookVerificationUnavailableError()); }, PAYPAL_WEBHOOK_VERIFICATION_TIMEOUT_MS);
  });
  const verify = async () => {
    const auth = await fetch(`${base}/v1/oauth2/token`, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Basic ${Buffer.from(`${config.PAYPAL_CLIENT_ID}:${config.PAYPAL_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
    if (controller.signal.aborted || auth.status !== 200) throw new PayPalWebhookVerificationUnavailableError();
    const tokenResult = z.object({ access_token: z.string().min(1).max(8192).regex(/^[\x21-\x7E]+$/) }).safeParse(await auth.json());
    if (controller.signal.aborted || !tokenResult.success) throw new PayPalWebhookVerificationUnavailableError();
    const fields = JSON.stringify({ auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'], transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'], webhook_id: config.PAYPAL_WEBHOOK_ID });
    const requestBody = Buffer.concat([Buffer.from(`${fields.slice(0, -1)},"webhook_event":`), body, Buffer.from('}')]);
    const response = await fetch(`${base}/v1/notifications/verify-webhook-signature`, { method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { Authorization: `Bearer ${tokenResult.data.access_token}`, 'Content-Type': 'application/json' }, body: requestBody });
    if (controller.signal.aborted || response.status !== 200) throw new PayPalWebhookVerificationUnavailableError();
    const result = z.object({ verification_status: z.enum(['SUCCESS', 'FAILURE']) }).safeParse(await response.json());
    if (controller.signal.aborted || !result.success) throw new PayPalWebhookVerificationUnavailableError();
    return result.data.verification_status === 'SUCCESS';
  };
  try { return await Promise.race([verify(), deadline]); }
  catch { throw new PayPalWebhookVerificationUnavailableError(); }
  finally { clearTimeout(timer); controller.abort(); }
}
