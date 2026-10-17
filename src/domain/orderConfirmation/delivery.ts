import { SESClient, SendRawEmailCommand, GetSendQuotaCommand, GetIdentityVerificationAttributesCommand, GetAccountSendingEnabledCommand } from '@aws-sdk/client-ses';
import nodemailer from 'nodemailer';
import { config } from '../../config/index.js';
import { invoiceSchema, type Invoice } from './contract.js';
import { renderDispatch, type Dispatch } from './dispatch.js';
import { businessSchema, type Business } from './contract.js';
import { renderConfirmation, type InvoicePresentation } from './template.js';
import { BRAND, emailImagesAvailable, inlineImagesFor } from '../email/brandEmail.js';

/** Only explicit rejection responses are safe for automatic redelivery. */
export class DeliveryRejected extends Error {
  constructor(public readonly retryable: boolean, public readonly diagnostic: 'THROTTLED' | 'PROVIDER_REJECTED' | 'CREDENTIALS_UNAVAILABLE' | 'CONNECTION_NOT_ESTABLISHED') { super(diagnostic); }
}
export type ConfirmationTransport = { kind: 'capture' | 'ses'; send(message: Buffer): Promise<{ messageId: string }> };
/** Storefront order page for the View Order button; null when FRONTEND_URL is not an absolute http(s) URL. */
export function customerOrderUrl(orderId: number, base = config.FRONTEND_URL) {
  try { const url = new URL(`account/orders/${orderId}`, base.endsWith('/') ? base : `${base}/`); return ['http:', 'https:'].includes(url.protocol) ? url.href : null; } catch { return null; }
}
export async function composeConfirmation(value: Invoice, pdf: Buffer, presentation: InvoicePresentation = 'CONFIRMED'): Promise<Buffer> {
  const invoice = invoiceSchema.parse(value), b = invoice.business;
  if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-')) || pdf.length > 3_000_000) throw new Error('Invalid PDF attachment');
  const rendered = renderConfirmation(invoice, presentation, { orderUrl: customerOrderUrl(invoice.purchase.orderId), siteUrl: config.FRONTEND_URL, includeImages: emailImagesAvailable() });
  return composeEmail(invoice.purchase.recipientEmail, b, rendered, [{ filename: `commercial-invoice-${invoice.invoiceNumber}.pdf`, content: pdf, contentType: 'application/pdf' }]);
}
export async function composeDispatch(value: Dispatch, business: Business) {
  const b = businessSchema.parse(business), rendered = renderDispatch(value, b, { siteUrl: config.FRONTEND_URL, includeImages: emailImagesAvailable() });
  return composeEmail(value.recipientEmail, b, rendered, []);
}
/** Customer-facing sender name is the brand; address and Reply-To come from the approved bundle. */
async function composeEmail(to: string, b: Business, rendered: { subject: string; text: string; html: string }, attachments: Array<{ filename: string; content: Buffer; contentType: string }>) {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const result = await composer.sendMail({ from: { name: BRAND.name, address: b.fromEmail }, to, replyTo: b.replyToEmail,
    subject: rendered.subject, text: rendered.text, html: rendered.html, disableFileAccess: true, disableUrlAccess: true,
    attachments: [...attachments, ...inlineImagesFor(rendered.html)],
  });
  if (!Buffer.isBuffer(result.message)) throw new Error('MIME composition did not return bytes');
  const message = Buffer.from(result.message);
  if (message.length > 9_000_000) throw new Error('Message exceeds SES budget');
  return message;
}
/** Only errors proving no HTTP request reached SES permit automatic resend. */
export function classifySesError(error: unknown): DeliveryRejected | null {
  const seen = new Set<unknown>(); let value = error;
  while (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value); const e = value as { name?: string; code?: string; cause?: unknown };
    if (['CredentialsProviderError', 'CredentialsError'].includes(e.name ?? '')) return new DeliveryRejected(true, 'CREDENTIALS_UNAVAILABLE');
    if (['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(e.code ?? '')) return new DeliveryRejected(true, 'CONNECTION_NOT_ESTABLISHED');
    if (['Throttling', 'ThrottlingException', 'TooManyRequestsException'].includes(e.name ?? '')) return new DeliveryRejected(true, 'THROTTLED');
    if (['MessageRejected', 'MailFromDomainNotVerifiedException', 'ConfigurationSetDoesNotExistException', 'AccountSendingPausedException', 'InvalidClientTokenId', 'SignatureDoesNotMatch', 'AccessDeniedException'].includes(e.name ?? '')) return new DeliveryRejected(false, 'PROVIDER_REJECTED');
    value = e.cause;
  }
  // Timeouts, resets, aborts and unclassified errors may follow successful acceptance.
  return null;
}
export type SesReadinessClient = Pick<SESClient, 'send' | 'config'>;
export async function checkSesReadiness(fromEmail: string, injected?: SesReadinessClient, signal = AbortSignal.timeout(10_000)) {
  if (process.env.NODE_ENV === 'test' && !injected) throw new Error('Real SES disabled in tests');
  const client = injected ?? new SESClient({ region: config.AWS_REGION, maxAttempts: 1 });
  try {
    const credentials = await client.config.credentials();
    if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new Error('Missing credentials');
    const options = { abortSignal: signal };
    const account = await client.send(new GetAccountSendingEnabledCommand({}), options);
    const quota = await client.send(new GetSendQuotaCommand({}), options);
    const identities = [fromEmail, fromEmail.split('@')[1]];
    const verified = await client.send(new GetIdentityVerificationAttributesCommand({ Identities: identities }), options);
    if (!account.Enabled || !(quota.Max24HourSend && quota.MaxSendRate && (quota.SentLast24Hours ?? 0) < quota.Max24HourSend)
      || !identities.some(i => verified.VerificationAttributes?.[i]?.VerificationStatus === 'Success')) throw new Error('SES not ready');
  } catch { throw new Error('SES readiness failed: verify credentials, permissions, region, sending identity and quota'); }
  finally { if (!injected) (client as SESClient).destroy(); }
}
export const sesConfirmationTransport: ConfirmationTransport = {
  kind: 'ses',
  async send(message) {
    if (!(config.ORDER_CONFIRMATION_EMAIL_ENABLED || config.DISPATCH_CONFIRMATION_EMAIL_ENABLED) || process.env.NODE_ENV === 'test') throw new DeliveryRejected(false, 'PROVIDER_REJECTED');
    const client = new SESClient({ region: config.AWS_REGION, maxAttempts: 1 });
    try {
      const result = await client.send(new SendRawEmailCommand({ RawMessage: { Data: message } }), { abortSignal: AbortSignal.timeout(10_000) });
      if (!result.MessageId) throw new Error('Provider acceptance unknown');
      return { messageId: result.MessageId };
    } catch (error) { throw classifySesError(error) ?? new Error('Provider acceptance unknown'); }
    finally { client.destroy(); }
  },
};
export function captureConfirmationTransport() {
  const messages: Buffer[] = [];
  const transport: ConfirmationTransport = { kind: 'capture', async send(message) { messages.push(Buffer.from(message)); return { messageId: `capture-${messages.length}` }; } };
  return { transport, messages };
}
