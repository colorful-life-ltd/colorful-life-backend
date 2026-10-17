import { deliveryEstimate, gbp, invoiceDate, invoiceSchema, NON_VAT_STATEMENT, type Invoice, type Purchase } from './contract.js';
import { BRAND, button, countryName, Images, legalDisclosure, infoCards, intro, note, orderSummary, renderBrandedEmail, safeHttpUrl, shortDate } from '../email/brandEmail.js';
export { escapeHtml } from '../email/brandEmail.js';
/** Pure, provider-independent rendering. No remote images, script, CSS or fonts. */
export type InvoicePresentation = 'CONFIRMED' | 'DISPATCHED' | 'COMPLETED';
export type ConfirmationRenderOptions = { orderUrl?: string | null; siteUrl?: string | null; includeImages?: boolean };
const customerAddress = (a: Purchase['shippingAddress']) => [a.recipientName, a.line1, a.line2, a.city, a.county, a.postcode, countryName(a.countryCode)].filter((s): s is string => !!s);
/** Legal identity shared by order emails: customer-facing brand plus the approved company details. */
export const legalLines = (b: Invoice['business']) => legalDisclosure(b);
/** Footer links for order emails: the shop (when configured) and the monitored support mailbox. */
export const orderFooterLinks = (b: Invoice['business'], siteUrl?: string | null) => [
  ...(safeHttpUrl(siteUrl) ? [{ label: 'Visit our shop', href: safeHttpUrl(siteUrl)! }] : []), { label: 'Contact us', href: `mailto:${b.replyToEmail}` }];

export function renderConfirmation(value: Invoice, presentation: InvoicePresentation = 'CONFIRMED', options: ConfirmationRenderOptions = {}) {
  if (!['CONFIRMED', 'DISPATCHED', 'COMPLETED'].includes(presentation)) throw new Error('Unsupported invoice presentation');
  const s = invoiceSchema.parse(value), p = s.purchase, b = s.business;
  const images = new Images(options.includeImages ?? true);
  const confirmed = presentation === 'CONFIRMED';
  const subject = confirmed ? `Thank you for your ${BRAND.name} order #${p.orderId}` : `Your ${BRAND.name} invoice for order #${p.orderId}`;
  const heading = confirmed ? 'Thank you for your order!' : 'Your commercial invoice';
  const status = presentation === 'DISPATCHED' ? 'Your order has been dispatched.' : 'Your order is completed.';
  const greet = (rest: string) => p.firstName ? `Hello ${p.firstName}, ${rest}` : rest[0].toUpperCase() + rest.slice(1);
  const message = confirmed
    ? greet(`we've received your payment and your order is now being prepared. We'll send you another email when it's dispatched.`)
    : greet(`your payment was successful. ${status} Your commercial invoice is attached.`);
  const nextTitle = 'What happens next?';
  const next = confirmed
    ? `We'll prepare your order and send a dispatch email with tracking details. ${p.delivery.method}: estimated ${deliveryEstimate(p)}.`
    : `${status} Keep the attached invoice for your records.`;
  const help = `If you have any questions, just reply to this email or write to ${b.replyToEmail}.`;
  const correction = `If any details are incorrect, please reply promptly to ${b.replyToEmail}.`;
  const invoiceNote = `Your non-VAT commercial invoice ${s.invoiceNumber}, dated ${invoiceDate(s.issuedAt)}, is attached as a PDF.`;
  const orderUrl = safeHttpUrl(options.orderUrl);
  const address = customerAddress(p.shippingAddress);
  const items = p.items.map(i => ({ description: i.description, detail: [i.setNumber, i.quantity > 1 ? `${gbp(i.unitPence)} each` : null].filter(Boolean).join(' · ') || null, quantity: i.quantity, amount: gbp(i.linePence) }));
  const totals = [{ label: 'Items total', value: gbp(p.subtotalPence) }, { label: p.delivery.method, value: gbp(p.delivery.chargePence) }];
  const body = intro(message)
    + button('View your order', orderUrl)
    + `<div style="height:8px;line-height:8px;font-size:0;">&nbsp;</div>`
    + orderSummary({ orderLabel: `Order #${p.orderId}`, dateLabel: shortDate(p.paidAt), items, totals, total: { label: 'Total paid', value: gbp(p.totalPence) }, deliverTo: address.join(', ') })
    + `<div style="height:14px;line-height:14px;font-size:0;">&nbsp;</div>`
    + infoCards(images, [{ icon: 'truck', title: nextTitle, body: next }, { icon: 'envelope', title: 'Need help?', body: help }])
    + `<div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>`
    + note(invoiceNote) + note(NON_VAT_STATEMENT) + note(correction);
  const footerLinks = orderFooterLinks(b, options.siteUrl);
  const html = renderBrandedEmail({ title: subject, preheader: `Order #${p.orderId} · Total paid ${gbp(p.totalPence)}.`, hero: 'order-confirmation', images,
    heading, subheading: `Order #${p.orderId}`, body, footerLinks, legalLines: legalLines(b) });
  const lines = p.items.map(i => `${i.description}${i.setNumber ? ` (${i.setNumber})` : ''} | Qty: ${i.quantity} | ${gbp(i.unitPence)} each | ${gbp(i.linePence)}`);
  const text = [heading, `Order #${p.orderId}`, '', message, ...(orderUrl ? ['', `View your order: ${orderUrl}`] : []), '',
    `Order summary (paid ${shortDate(p.paidAt)})`, ...lines, '', `Items total: ${gbp(p.subtotalPence)}`, `${p.delivery.method}: ${gbp(p.delivery.chargePence)}`, `Total paid: ${gbp(p.totalPence)} GBP`, '',
    'Delivering to:', ...address, '', `${nextTitle} ${next}`, `Need help? ${help}`, '', invoiceNote, NON_VAT_STATEMENT, correction, '',
    ...footerLinks.map(l => `${l.label}: ${l.href.replace(/^mailto:/, '')}`), ...legalLines(b)].join('\n');
  return { subject, text, html };
}
