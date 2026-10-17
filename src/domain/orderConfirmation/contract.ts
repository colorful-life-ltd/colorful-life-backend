import { z } from 'zod';

export const NON_VAT_STATEMENT = 'Colorful Life Ltd is not VAT registered. No VAT has been charged. This document is a commercial invoice, not a VAT invoice.';
const text = z.string().trim().min(1).max(500).refine(s => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s));
const header = text.refine(s => !/[\r\n]/.test(s));
const pence = z.number().int().min(0).max(999999999999);
const optionalText = z.preprocess(v => typeof v === 'string' && !v.trim() ? null : v, text.nullable());
export const addressSchema = z.object({ recipientName: text, line1: text, line2: optionalText, city: text, county: optionalText, postcode: text, countryCode: z.string().regex(/^[A-Z]{2}$/) }).strict();
// This is a persisted invoice handoff, NOT checkout shipping selection/pricing.
export const deliverySchema = z.object({ method: header, chargePence: pence, minWorkingDays: z.number().int().min(1).max(365), maxWorkingDays: z.number().int().min(1).max(365), estimatesFrom: z.literal('DISPATCH') }).strict().refine(d => d.maxWorkingDays >= d.minWorkingDays);
export const purchaseSchema = z.object({
  version: z.literal(1), orderId: z.number().int().positive(), paymentId: z.number().int().positive(),
  paidAt: z.string().datetime(), currency: z.literal('GBP'),
  recipientEmail: z.string().email().max(254), firstName: optionalText,
  billing: addressSchema, shippingAddress: addressSchema,
  items: z.array(z.object({ description: text, setNumber: text.nullable(), quantity: z.number().int().positive().max(1000000), unitPence: pence, linePence: pence }).strict()).min(1).max(500),
  subtotalPence: pence, totalPence: pence.positive(), delivery: deliverySchema,
}).strict().superRefine((p, ctx) => {
  if (p.items.some(i => i.unitPence * i.quantity !== i.linePence)
    || p.items.reduce((s, i) => s + i.linePence, 0) !== p.subtotalPence
    || p.subtotalPence + p.delivery.chargePence !== p.totalPence) ctx.addIssue({ code: 'custom', message: 'Persisted totals do not reconcile' });
});
function contrastWithWhite(hex: string) {
  const values = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 1.05 / (values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722 + 0.05);
}
export const businessSchema = z.object({
  approved: z.literal(true), legalName: z.literal('Colorful Life Ltd'), registrationNumber: header,
  registeredAddress: z.array(header).min(2).max(8),
  // Place of registration for UK trading disclosures, e.g. "England and Wales". Optional so frozen pre-#185 snapshots still parse.
  registeredIn: header.optional(), fromEmail: z.string().email(), replyToEmail: z.string().email(),
  replyToMonitored: z.literal(true), retentionPolicy: header,
  invoicePrefix: z.string().regex(/^[A-Z0-9-]{1,20}$/), numberDigits: z.number().int().min(1).max(12),
  // Brand identity (Build & Bloom artwork, palette) is versioned in the repository since Issue #185.
  // These legacy fields stay accepted and validated so existing bundles and frozen invoice snapshots parse.
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).refine(c => contrastWithWhite(c) >= 4.5).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  logo: z.object({ mime: z.enum(['image/png', 'image/jpeg']), base64: z.string().min(8).max(180000).regex(/^[A-Za-z0-9+/]+={0,2}$/), alt: header }).strict().optional(),
}).strict().refine(b => {
  if (!b.logo) return true;
  const bytes = Buffer.from(b.logo.base64, 'base64');
  return b.logo.mime === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}, 'Approved logo must match its declared image type');
export const invoiceSchema = z.object({ version: z.literal(1), invoiceNumber: header, issuedAt: z.string().datetime(), purchase: purchaseSchema, business: businessSchema }).strict();
export type Purchase = z.infer<typeof purchaseSchema>;
export type Business = z.infer<typeof businessSchema>;
export type Invoice = z.infer<typeof invoiceSchema>;
export const gbp = (value: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value / 100);
export const invoiceDate = (value: string) => new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(value));
export const addressLines = (a: Purchase['billing']) => [a.recipientName, a.line1, a.line2, a.city, a.county, a.postcode, a.countryCode].filter((s): s is string => !!s);
export const deliveryEstimate = (p: Purchase) => `${p.delivery.minWorkingDays}–${p.delivery.maxWorkingDays} working days after dispatch`;
