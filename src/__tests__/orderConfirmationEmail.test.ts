import assert from 'node:assert/strict';
import { it } from 'node:test';
import { config } from '../config/index.js';
import { readFileSync } from 'node:fs';
import { simpleParser } from 'mailparser';
import { extractText, getDocumentProxy } from 'unpdf';
import { invoiceFixture, purchaseFixture, businessFixture } from './fixtures/orderConfirmation.fixture.js';
import { businessSchema, invoiceSchema, purchaseSchema, NON_VAT_STATEMENT, gbp, invoiceDate } from '../domain/orderConfirmation/contract.js';
import { renderConfirmation } from '../domain/orderConfirmation/template.js';
import { generateInvoicePdf, UnsupportedInvoiceText, InvoiceFontUnavailable, loadInvoiceFont } from '../domain/orderConfirmation/pdf.js';
import { composeConfirmation, sesConfirmationTransport, classifySesError, DeliveryRejected, checkSesReadiness, type SesReadinessClient } from '../domain/orderConfirmation/delivery.js';

it('renders exact branded HTML and matching plain-text snapshots', () => {
  const result = renderConfirmation(invoiceFixture);
  assert.equal(result.subject, 'Thank you for your Build & Bloom order #42');
  for (const kind of ['html', 'text'] as const) assert.equal(result[kind], readFileSync(new URL(`../../src/__tests__/fixtures/order-confirmation.${kind}`, import.meta.url), 'utf8'));
});
it('uses a neutral greeting and omits absent optional address/name fields', () => {
  const rendered = renderConfirmation({ ...invoiceFixture, purchase: { ...purchaseFixture, firstName: null } });
  assert.ok(rendered.text.includes("\nWe've received your payment")); assert.doesNotMatch(rendered.text, /Hello|null/); assert.ok(!rendered.html.includes('undefined'));
});
it('escapes special characters without truncating long descriptions', () => {
  const title = '<script>alert("x")</script> & '.repeat(12);
  const rendered = renderConfirmation({ ...invoiceFixture, purchase: { ...purchaseFixture, firstName: '<b>Buyer & Friend</b>', items: [{ ...purchaseFixture.items[0], description: title }] } });
  assert.ok(!rendered.html.includes('<script>')); assert.ok(rendered.html.includes('&lt;script&gt;')); assert.ok(rendered.html.includes('&amp;'));
  assert.ok(rendered.text.includes(title)); assert.ok(rendered.html.includes('&lt;b&gt;Buyer &amp; Friend&lt;/b&gt;'));
});
it('uses fluid 600px table layout and inline CSS without remote assets or tracking', () => {
  const { html } = renderConfirmation(invoiceFixture);
  assert.match(html, /max-width:600px/); assert.match(html, /width="100%"/); assert.match(html, /name="viewport"/);
  assert.match(html, /src="cid:bb-hero-order-confirmation"/); assert.match(html, /alt="Illustration of a child and her dog reading/);
  assert.doesNotMatch(html, /<script|<link|https?:|background-image|@font-face|<img[^>]+src="(?!cid:)/i);
  // One <style> block, holding only the mobile media query; everything else is inline.
  assert.equal(html.match(/<style>/g)?.length, 1); assert.match(html, /<style>@media only screen and \(max-width:620px\)\{[^<]*\}<\/style>/);
  assert.match(html, /aria-label="Items in your order"/); assert.match(html, /lang="en"/); assert.doesNotMatch(html, /Colorful Life Order|LEGO/i);
});
for (const [method, fee, min, max] of [['Standard Delivery', 399, 2, 4], ['Express Delivery', 799, 1, 2]] as const) it(`renders actual persisted ${method} values`, () => {
  const p = { ...purchaseFixture, totalPence: 2500 + fee, delivery: { ...purchaseFixture.delivery, method, chargePence: fee, minWorkingDays: min, maxWorkingDays: max } };
  const rendered = renderConfirmation({ ...invoiceFixture, purchase: p });
  assert.ok(rendered.text.includes(gbp(fee))); assert.ok(rendered.text.includes(gbp(2500 + fee))); assert.ok(rendered.text.includes(`${min}–${max} working days after dispatch`));
});
for (const change of [{ delivery: null }, { totalPence: 2898 }, { currency: 'USD' }, { clientSecret: 'forbidden' }, { items: [{ ...purchaseFixture.items[0], quantity: 3 }] }]) it(`rejects invalid/inconsistent purchase input: ${Object.keys(change)[0]}`, () => {
  assert.equal(purchaseSchema.safeParse({ ...purchaseFixture, ...change }).success, false);
});
for (const change of [{ approved: false }, { replyToMonitored: false }, { registrationNumber: '' }, { retentionPolicy: '' }, { primaryColor: '#ffffff' }, { logo: { ...businessFixture.logo, base64: 'bm90YW5pbWFnZQ==' } }]) it(`requires approved complete business/brand input: ${Object.keys(change)[0]}`, () => {
  assert.equal(businessSchema.safeParse({ ...businessFixture, ...change }).success, false);
});
it('validates snapshot types strictly and formats GBP/date without tax fields', () => {
  assert.equal(invoiceSchema.safeParse({ ...invoiceFixture, vatNumber: 'forbidden' }).success, false);
  assert.equal(gbp(2899), '£28.99'); assert.equal(invoiceDate('2026-10-16T23:59:00Z'), '16 October 2026');
  const { text } = renderConfirmation(invoiceFixture);
  assert.ok(text.includes(NON_VAT_STATEMENT)); assert.doesNotMatch(text, /VAT (amount|rate|number|registration)|VAT:\s*£|statutory.*lose/i);
  assert.doesNotMatch(text, /warehouse|packed|dispatch has started/i);
});
it('generates a readable non-VAT PDF with actual amounts, addresses and stable identity', async () => {
  const pdf = await generateInvoicePdf(invoiceFixture); assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  try { const { text } = await extractText(doc, { mergePages: true }); assert.match(text, /Commercial invoice/); assert.ok(text.includes('TEST-00000001')); assert.ok(text.includes('Élodie Test')); assert.ok(text.includes('£28.99')); assert.ok(text.includes('£3.99')); assert.ok(text.includes('not VAT registered')); assert.doesNotMatch(text, /VAT:\s*£|VAT registration number/); } finally { await doc.loadingTask.destroy(); }
});
it('paginates long line items without dropping the final total', async () => {
  const items = Array.from({ length: 60 }, (_, n) => ({ ...purchaseFixture.items[0], description: `Product ${n} ${'long description '.repeat(20)}`, quantity: 1, linePence: 1250 }));
  const pdf = await generateInvoicePdf({ ...invoiceFixture, purchase: { ...purchaseFixture, items, subtotalPence: 75000, totalPence: 75399 } });
  const doc = await getDocumentProxy(new Uint8Array(pdf));
  try { assert.ok(doc.numPages > 1); const { text } = await extractText(doc, { mergePages: true }); assert.ok(text.includes('Product 59')); assert.ok(text.includes('£753.99')); } finally { await doc.loadingTask.destroy(); }
});
it('blocks unsupported glyphs rather than silently changing customer information', async () => {
  await assert.rejects(generateInvoicePdf({ ...invoiceFixture, purchase: { ...purchaseFixture, firstName: 'Test', billing: { ...purchaseFixture.billing, recipientName: '測試' } } }), UnsupportedInvoiceText);
});
it('composes real multipart MIME with plain text, HTML, CID logo, Reply-To and PDF bytes', async () => {
  const pdf = await generateInvoicePdf(invoiceFixture), raw = await composeConfirmation(invoiceFixture, pdf);
  const mail = await simpleParser(raw); assert.equal(mail.subject, 'Thank you for your Build & Bloom order #42');
  assert.equal(mail.replyTo?.value[0].address, 'support@example.test'); assert.equal(mail.to && 'value' in mail.to ? mail.to.value[0].address : null, 'buyer@example.test');
  assert.ok(mail.text?.includes(NON_VAT_STATEMENT)); assert.ok(typeof mail.html === 'string' && mail.html.includes('Thank you for your order!'));
  assert.deepEqual(mail.attachments.find(a => a.contentType === 'application/pdf')?.content, pdf); assert.ok(mail.attachments.some(a => a.cid === 'bb-hero-order-confirmation'));
  assert.equal(mail.from?.value[0].name, 'Build & Bloom'); assert.equal(mail.from?.value[0].address, 'orders@example.test');
  assert.match(raw.toString(), /multipart\/mixed/); assert.match(raw.toString(), /multipart\/alternative/); assert.doesNotMatch(raw.toString(), /client_secret|sk_live_|whsec_|stripe-create-/);
});
it('refuses SES delivery during isolated tests even if a caller enables the feature', async () => {
  const previous = config.ORDER_CONFIRMATION_EMAIL_ENABLED;
  config.ORDER_CONFIRMATION_EMAIL_ENABLED = true;
  try { await assert.rejects(sesConfirmationTransport.send(Buffer.from('not sent'))); } finally { config.ORDER_CONFIRMATION_EMAIL_ENABLED = previous; }
});

it('normalizes optional blank address fields without fabricating missing required data', () => {
  const parsed = purchaseSchema.parse({ ...purchaseFixture, firstName: '  ', billing: { ...purchaseFixture.billing, line2: '', county: '  ' } });
  assert.equal(parsed.firstName, null); assert.equal(parsed.billing.line2, null); assert.equal(parsed.billing.county, null);
});
it('distinguishes missing deployment font assets from unsupported customer glyphs', () => {
  assert.throws(() => loadInvoiceFont(new URL('file:///nonexistent-issue180-font.ttf')), InvoiceFontUnavailable);
});
for (const error of [Object.assign(new Error('redacted'), { name: 'CredentialsProviderError' }), Object.assign(new Error('redacted'), { code: 'ECONNREFUSED' }), { cause: { code: 'ENOTFOUND' } }]) it('classifies a proven pre-send failure as safe to retry', () => {
  const classified = classifySesError(error); assert.ok(classified instanceof DeliveryRejected); assert.equal(classified.retryable, true);
});
for (const error of [{ code: 'ECONNRESET' }, { code: 'ETIMEDOUT' }, { name: 'AbortError' }, new Error('unknown')]) it('keeps ambiguous SES acceptance uncertain', () => { assert.equal(classifySesError(error), null); });
it('checks SES readiness using injected local responses only', async () => {
  const commands: string[] = [];
  const client = { config: { credentials: async () => ({ accessKeyId: 'fake', secretAccessKey: 'fake' }) }, async send(command: object) {
    commands.push(command.constructor.name);
    return { Enabled: true, Max24HourSend: 100, SentLast24Hours: 1, MaxSendRate: 1, VerificationAttributes: { 'example.test': { VerificationStatus: 'Success' } } };
  } } as unknown as SesReadinessClient;
  await checkSesReadiness('orders@example.test', client); assert.equal(commands.length, 3);
  await assert.rejects(checkSesReadiness('orders@unverified.test', client));
  await assert.rejects(checkSesReadiness('orders@example.test'));
});

for (const presentation of ['DISPATCHED', 'COMPLETED'] as const) it(`invoice delivery uses accurate ${presentation} wording with the identical immutable PDF`, async () => {
  const pdf = await generateInvoicePdf(invoiceFixture), mail = await simpleParser(await composeConfirmation(invoiceFixture, pdf, presentation));
  assert.doesNotMatch(mail.text!, /We'll send you another email when it's dispatched/);
  assert.equal(mail.subject, 'Your Build & Bloom invoice for order #42');
  assert.deepEqual(mail.attachments.find(a => a.contentType === 'application/pdf')?.content, pdf);
  assert.ok(mail.text?.includes(presentation === 'DISPATCHED' ? 'has been dispatched' : 'is completed'));
});
