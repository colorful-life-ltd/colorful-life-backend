import { config } from '../../config/index.js';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma-client/client.js';
import { businessSchema, deliverySchema, invoiceDate, type Business } from './contract.js';
import { trackingLink } from '../fulfilment/carriers.js';
import { escapeHtml as e } from './template.js';

const value = z.string().trim().min(1).max(500).refine(s => !/[\u0000-\u001f\u007f]/.test(s));
const optional = z.preprocess(v => typeof v === 'string' && !v.trim() ? null : v, value.nullable());
export const dispatchSchema = z.object({
  version: z.literal(1), orderId: z.number().int().positive(), shipmentId: z.number().int().positive(), sequence: z.number().int().positive(),
  scope: z.literal('FULL_ORDER'), recipientEmail: z.string().email().max(254), firstName: optional,
  dispatchedAt: z.string().datetime(), carrier: z.enum(['ROYAL_MAIL', 'EVRI', 'DPD', 'OTHER']).nullable(),
  carrierName: value, trackingNumber: optional, delivery: deliverySchema.nullable(),
}).strict();
export type Dispatch = z.infer<typeof dispatchSchema>;

/** Called only for the newly persisted dispatch, inside its fulfilment transaction. */
export async function enqueueDispatchConfirmation(tx: Prisma.TransactionClient, shipmentId: number) {
  const shipment = await tx.shipment.findUniqueOrThrow({ where: { id: shipmentId }, include: {
    order: { include: { user: { select: { email: true, firstName: true, emailVerified: true, deletedAt: true } } } },
    events: { where: { action: 'DISPATCHED' } },
  } });
  const order = shipment.order, user = order.user;
  if (!shipment.events.length || order.status !== 'DISPATCHED' || order.cancelledAt || !order.dispatchedAt) throw new Error('Dispatch email requires a recorded dispatch');
  const durable = config.DISPATCH_CONFIRMATION_EMAIL_ENABLED;
  const source = { version: 1, orderId: order.id, shipmentId: shipment.id, sequence: shipment.sequence, scope: 'FULL_ORDER',
    recipientEmail: (user.emailVerified || !durable) && !user.deletedAt ? user.email : null, firstName: user.firstName,
    dispatchedAt: shipment.dispatchedAt.toISOString(), carrier: shipment.carrier, carrierName: shipment.carrierName,
    trackingNumber: shipment.trackingNumber, delivery: durable ? order.confirmationDeliverySnapshot : null,
  };
  const valid = dispatchSchema.safeParse(source).success;
  await tx.orderConfirmationJob.upsert({ where: { eventKey: `shipment:${shipment.id}` }, create: {
    orderId: order.id, type: 'DISPATCH_CONFIRMATION', deliveryRoute: durable ? 'DURABLE' : 'LEGACY', eventKey: `shipment:${shipment.id}`, shipmentId: shipment.id,
    source: source as Prisma.InputJsonValue, state: user.deletedAt ? 'SUPPRESSED' : valid ? 'PENDING' : 'BLOCKED',
    lastErrorCode: user.deletedAt ? 'ACCOUNT_DELETED' : valid ? null : !source.recipientEmail ? 'RECIPIENT_UNAVAILABLE' : 'DISPATCH_DATA_INVALID',
  }, update: {} });

}
export function renderDispatch(value: Dispatch, business: Business) {
  const p = dispatchSchema.parse(value), b = businessSchema.parse(business), link = trackingLink(p.carrier, p.trackingNumber);
  const greeting = p.firstName ? `Hello ${p.firstName},` : 'Hello,';
  const subject = `Your Colorful Life Order #${p.orderId} Has Been Dispatched!`;
  const tracking = p.trackingNumber ? `Tracking number: ${p.trackingNumber}` : 'Your order has been dispatched. Tracking information is not currently available.';
  const delivery = p.delivery ? `Delivery service: ${p.delivery.method}\nEstimated delivery: ${p.delivery.minWorkingDays}–${p.delivery.maxWorkingDays} working days after dispatch` : null;
  const support = `If you have any questions, please reply to ${b.replyToEmail}.`;
  const text = [b.legalName, '', greeting, `Your order #${p.orderId} has been dispatched.`, `Dispatch date: ${invoiceDate(p.dispatchedAt)}`, `Carrier: ${p.carrierName}`, tracking,
    ...(link ? [`Tracking page: ${link.url}`, ...(!link.includesTrackingNumber ? ['Enter your tracking number on the carrier’s official page.'] : [])] : []),
    ...(delivery ? [delivery] : []), '', support, '', b.legalName, ...b.registeredAddress, `Company registration number: ${b.registrationNumber}`, `Customer support: ${b.replyToEmail}`].join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(subject)}</title></head><body style="margin:0;padding:0;background-color:#f5f5f4;color:#1f2937;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:16px 8px;"><!--[if mso]><table role="presentation" width="600"><tr><td><![endif]--><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;table-layout:fixed;background-color:#ffffff;border-top:6px solid ${b.accentColor};"><tr><td style="padding:24px;background-color:${b.primaryColor};color:#ffffff;"><img src="cid:colorful-life-logo" width="120" alt="${e(b.logo.alt)}" style="display:block;max-width:120px;height:auto;border:0;"><h1 style="font-size:24px;line-height:1.3;margin:16px 0 0;">Your order has been dispatched</h1><p>Order #${p.orderId}</p></td></tr><tr><td style="padding:24px;overflow-wrap:anywhere;word-break:break-word;"><p>${e(greeting)}</p><p>Your order #${p.orderId} has been dispatched.</p><p>Dispatch date: ${e(invoiceDate(p.dispatchedAt))}<br>Carrier: ${e(p.carrierName)}</p><p>${e(tracking)}</p>${link ? `<p><a href="${e(link.url)}" style="color:#1f2937;">Open the official carrier tracking page</a>${link.includesTrackingNumber ? '' : '<br>Enter your tracking number on the carrier’s official page.'}</p>` : ''}${delivery ? `<p>${e(delivery).replaceAll('\n', '<br>')}</p>` : ''}<p>${e(support)}</p></td></tr><tr><td style="padding:24px;border-top:1px solid #d1d5db;font-size:14px;overflow-wrap:anywhere;word-break:break-word;">${e(b.legalName)}<br>${b.registeredAddress.map(e).join('<br>')}<br>Company registration number: ${e(b.registrationNumber)}<br>Customer support: <a href="mailto:${e(b.replyToEmail)}" style="color:#1f2937;">${e(b.replyToEmail)}</a></td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
  return { subject, text, html };
}
