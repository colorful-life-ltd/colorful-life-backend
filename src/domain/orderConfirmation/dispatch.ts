import { config } from '../../config/index.js';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma-client/client.js';
import { businessSchema, deliverySchema, type Business } from './contract.js';
import { trackingLink } from '../fulfilment/carriers.js';
import { legalLines, orderFooterLinks } from './template.js';
import { BRAND, button, dateTimeUtc, detailRows, Images, intro, note, renderBrandedEmail, safeHttpUrl } from '../email/brandEmail.js';

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
export function renderDispatch(value: Dispatch, business: Business, options: { siteUrl?: string | null; includeImages?: boolean } = {}) {
  const p = dispatchSchema.parse(value), b = businessSchema.parse(business), link = trackingLink(p.carrier, p.trackingNumber);
  const trackingUrl = safeHttpUrl(link?.url);
  const images = new Images(options.includeImages ?? true);
  const subject = `Your ${BRAND.name} order #${p.orderId} has been dispatched`;
  const heading = 'Your order has been dispatched!';
  const message = `${p.firstName ? `Great news, ${p.firstName}!` : 'Great news!'} Your order has been dispatched and is on its way to you.`;
  const noTracking = 'Tracking information is not currently available.';
  const enterNumber = 'Enter your tracking number on the carrier’s official page.';
  const delivery = p.delivery ? `${p.delivery.method}: estimated ${p.delivery.minWorkingDays}–${p.delivery.maxWorkingDays} working days after dispatch.` : null;
  const support = `If you have any questions, just reply to this email or write to ${b.replyToEmail}.`;
  const dispatchedAt = dateTimeUtc(p.dispatchedAt);
  const body = intro(message)
    + detailRows(images, [{ icon: 'truck', label: 'Carrier', value: p.carrierName }, { icon: 'box', label: 'Tracking number', value: p.trackingNumber ?? 'Not available yet' },
      { icon: 'calendar', label: 'Dispatched at', value: dispatchedAt }])
    + `<div style="height:18px;line-height:18px;font-size:0;">&nbsp;</div>`
    + (trackingUrl ? button('Track your order', trackingUrl, { wide: true }) + (link && !link.includesTrackingNumber ? note(enterNumber) : '') : (p.trackingNumber ? '' : note(noTracking)))
    + (delivery ? note(delivery) : '') + note(support);
  const footerLinks = orderFooterLinks(b, options.siteUrl);
  const html = renderBrandedEmail({ title: subject, preheader: message, hero: 'dispatch', images, heading, subheading: `Order #${p.orderId}`, body, footerLinks, legalLines: legalLines(b) });
  const text = [heading, `Order #${p.orderId}`, '', message, '', `Carrier: ${p.carrierName}`, p.trackingNumber ? `Tracking number: ${p.trackingNumber}` : noTracking, `Dispatched at: ${dispatchedAt}`,
    ...(trackingUrl ? ['', `Track your order: ${trackingUrl}`, ...(link && !link.includesTrackingNumber ? [enterNumber] : [])] : []),
    ...(delivery ? ['', delivery] : []), '', support, '', ...footerLinks.map(l => `${l.label}: ${l.href.replace(/^mailto:/, '')}`), ...legalLines(b)].join('\n');
  return { subject, text, html };
}
