import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { simpleParser } from 'mailparser';
import { emailImagesAvailable, inlineImagesFor, safeHttpUrl, renderBrandedEmail, Images } from '../domain/email/brandEmail.js';
import { composeVerificationEmail, renderVerificationEmail } from '../domain/email/verificationEmail.js';
import { EMAIL_VERIFICATION_TOKEN_LIFETIME_MS } from '../domain/auth/emailVerificationService.js';
import { renderConfirmation } from '../domain/orderConfirmation/template.js';
import { renderDispatch } from '../domain/orderConfirmation/dispatch.js';
import { composeConfirmation, composeDispatch, customerOrderUrl } from '../domain/orderConfirmation/delivery.js';
import { businessSchema, gbp } from '../domain/orderConfirmation/contract.js';
import { generateInvoicePdf } from '../domain/orderConfirmation/pdf.js';
import { businessFixture, dispatchFixture, invoiceFixture, purchaseFixture } from './fixtures/orderConfirmation.fixture.js';

const verifyUrl = 'https://shop.example.test/verify-email?token=abc&next=%22x%22';
const cids = (html: string) => [...html.matchAll(/src="cid:([^"]+)"/g)].map(m => m[1]).sort();
/** Every cid: reference resolves to exactly one attached image, and no unreferenced inline images are sent. */
async function assertInlineImagesResolve(raw: Buffer) {
  const mail = await simpleParser(raw, { keepCidLinks: true });
  const inline = mail.attachments.filter(a => a.cid).map(a => a.cid!).sort();
  assert.ok(typeof mail.html === 'string'); assert.deepEqual([...new Set(cids(mail.html))], inline);
  for (const a of mail.attachments.filter(a => a.cid)) assert.match(a.contentType, /^image\/(png|jpeg)$/);
  return mail;
}

it('verification email: welcome copy, escaped public link, real token expiry and plain-text fallback', () => {
  const r = renderVerificationEmail({ verificationUrl: verifyUrl, lifetimeMs: EMAIL_VERIFICATION_TOKEN_LIFETIME_MS, siteUrl: 'https://shop.example.test' });
  assert.equal(r.subject, 'Welcome to Build & Bloom – please verify your email');
  assert.match(r.html, /Welcome to Build &amp; Bloom!/); assert.match(r.html, /Verify my email address/);
  assert.ok(r.html.includes('href="https://shop.example.test/verify-email?token=abc&amp;next=%22x%22"'));
  assert.match(r.html, /This link will expire in 24 hours\./); assert.match(r.text, /This link will expire in 24 hours\./);
  assert.ok(r.text.includes(verifyUrl)); assert.doesNotMatch(r.text, /<[a-z]/i);
  assert.doesNotMatch(r.html + r.text, /Colorful Life account|LEGO/i); assert.match(r.text, /Build & Bloom is a store by Colorful Life Ltd\./);
});
it('verification email refuses non-http(s) links instead of rendering them', () => {
  for (const verificationUrl of ['javascript:alert(1)', '/verify-email?token=x', 'data:text/html,x', '']) {
    assert.throws(() => renderVerificationEmail({ verificationUrl, lifetimeMs: EMAIL_VERIFICATION_TOKEN_LIFETIME_MS }));
  }
});
it('verification MIME: brand sender, no Reply-To, multipart text/HTML with resolving inline images', async () => {
  const raw = await composeVerificationEmail({ to: 'new@example.test', from: 'no-reply@example.test', verificationUrl: verifyUrl, lifetimeMs: EMAIL_VERIFICATION_TOKEN_LIFETIME_MS });
  const mail = await assertInlineImagesResolve(raw);
  assert.equal(mail.from?.value[0].name, 'Build & Bloom'); assert.equal(mail.from?.value[0].address, 'no-reply@example.test'); assert.equal(mail.replyTo, undefined);
  assert.ok(mail.text?.includes(verifyUrl)); assert.ok(mail.attachments.some(a => a.cid === 'bb-hero-verification'));
  assert.match(raw.toString(), /multipart\/alternative/); assert.ok(raw.length < 1_000_000);
});
it('order confirmation: items, delivery and totals match the immutable invoice snapshot', () => {
  const items = [{ ...purchaseFixture.items[0], description: 'Harbour Station', quantity: 2, unitPence: 1250, linePence: 2500 }, { ...purchaseFixture.items[0], description: 'City Tram', setNumber: null, quantity: 1, unitPence: 1825, linePence: 1825 }];
  const purchase = { ...purchaseFixture, items, subtotalPence: 4325, totalPence: 4325 + purchaseFixture.delivery.chargePence };
  const r = renderConfirmation({ ...invoiceFixture, purchase }, 'CONFIRMED', { orderUrl: customerOrderUrl(42, 'https://shop.example.test') });
  for (const v of [gbp(2500), gbp(1825), gbp(4325), gbp(purchaseFixture.delivery.chargePence), gbp(purchase.totalPence)]) { assert.ok(r.html.includes(v), v); assert.ok(r.text.includes(v), v); }
  assert.match(r.html, /Qty: 2 &middot; .*£12\.50 each/); assert.match(r.html, /Total paid/); assert.match(r.html, />Order #42</);
  assert.ok(r.html.includes('href="https://shop.example.test/account/orders/42"')); assert.ok(r.text.includes('View your order: https://shop.example.test/account/orders/42'));
  assert.match(r.html, /United Kingdom/); assert.match(r.html, /not VAT registered/); assert.match(r.html, /attached as a PDF/);
});
it('View order button is omitted, never broken, when no valid storefront URL exists', () => {
  for (const orderUrl of [null, undefined, 'javascript:alert(1)', 'not a url']) {
    const r = renderConfirmation(invoiceFixture, 'CONFIRMED', { orderUrl });
    assert.doesNotMatch(r.html, /View your order/); assert.doesNotMatch(r.text, /View your order/);
  }
  assert.equal(customerOrderUrl(7, 'https://shop.example.test/'), 'https://shop.example.test/account/orders/7');
  assert.equal(customerOrderUrl(7, 'https://shop.example.test/base'), 'https://shop.example.test/base/account/orders/7');
  assert.equal(customerOrderUrl(7, 'ftp://shop.example.test'), null); assert.equal(customerOrderUrl(7, 'not a url'), null);
});
it('order confirmation MIME keeps the identical PDF and resolves every inline image', async () => {
  const pdf = await generateInvoicePdf(invoiceFixture), mail = await assertInlineImagesResolve(await composeConfirmation(invoiceFixture, pdf));
  const pdfs = mail.attachments.filter(a => a.contentType === 'application/pdf');
  assert.equal(pdfs.length, 1); assert.deepEqual(pdfs[0].content, pdf); assert.equal(pdfs[0].filename, 'commercial-invoice-TEST-00000001.pdf'); assert.notEqual(pdfs[0].contentDisposition, 'inline');
});
it('dispatch: tracking button only for a trusted carrier URL, details escaped and in UTC', async () => {
  const tracked = renderDispatch(dispatchFixture, businessFixture);
  assert.match(tracked.html, /Track your order/); assert.match(tracked.html, /href="https:\/\/www\.royalmail\.com\//); assert.match(tracked.html, /\(UTC\)/);
  const untracked = renderDispatch({ ...dispatchFixture, carrier: 'OTHER', carrierName: 'A & B <Couriers>', trackingNumber: 'X1"><script>' }, businessFixture);
  assert.doesNotMatch(untracked.html, /Track your order|<script>/); assert.match(untracked.html, /A &amp; B &lt;Couriers&gt;/); assert.match(untracked.html, /X1&quot;&gt;&lt;script&gt;/);
  await assertInlineImagesResolve(await composeDispatch(dispatchFixture, businessFixture));
});
it('footer links accept only http(s) and mailto, and missing assets degrade to text-only emails', () => {
  const html = renderBrandedEmail({ title: 't', preheader: 'p', hero: 'dispatch', images: new Images(false), heading: 'h', body: '',
    footerLinks: [{ label: 'Bad', href: 'javascript:alert(1)' }, { label: 'Shop', href: 'https://shop.example.test/' }, { label: 'Mail', href: 'mailto:support@example.test' }], legalLines: [] });
  assert.doesNotMatch(html, /javascript:|>Bad</); assert.match(html, />Shop</); assert.match(html, /href="mailto:support@example.test"/);
  assert.doesNotMatch(html, /<img/); assert.deepEqual(inlineImagesFor(html), []);
  assert.equal(emailImagesAvailable(new URL('file:///nonexistent-email-assets/')), false); assert.equal(emailImagesAvailable(), true);
  assert.equal(safeHttpUrl('mailto:x@example.test'), null);
});
it('business bundles no longer need logo or colour fields, but present ones are still validated', () => {
  const { logo: _logo, primaryColor: _p, accentColor: _a, ...withoutBrand } = businessFixture;
  assert.equal(businessSchema.safeParse(withoutBrand).success, true);
  assert.equal(businessSchema.safeParse({ ...withoutBrand, primaryColor: '#ffffff' }).success, false);
});
it('ships optimised hero JPEGs while keeping the approved PNG masters unchanged', () => {
  const masters: Record<string, string> = {
    'email-verification-hero': '24846a3f8e531aef1445fd5436e3d92fe0d72d179792096a3aa53c5211420757',
    'email-order-confirmation-hero': 'bac9f393bac8327b00901df5939944af20253350f1f915f4fd37f48bb101dfac',
    'email-dispatch-hero': 'bf98fe7badbc69523736817bf8914dc4d586522ba51b5133db7d718afd5b6167',
  };
  for (const [name, sha] of Object.entries(masters)) {
    assert.equal(createHash('sha256').update(readFileSync(`src/assets/email/${name}.png`)).digest('hex'), sha);
    const jpg = readFileSync(`assets/email/${name}.jpg`); assert.ok(jpg[0] === 0xff && jpg[1] === 0xd8); assert.ok(statSync(`assets/email/${name}.jpg`).size < 300_000);
  }
});
it('account verification Reply-To comes only from an attested monitored support mailbox in the business configuration', async () => {
  const { approvedSupportReplyTo } = await import('../domain/email/supportContact.js');
  assert.equal(approvedSupportReplyTo(JSON.stringify({ replyToEmail: 'support@example.test', replyToMonitored: true, invoicePrefix: '' })), 'support@example.test');
  for (const raw of [undefined, '', 'not json', JSON.stringify({ replyToEmail: 'support@example.test', replyToMonitored: false }), JSON.stringify({ replyToEmail: 'nope', replyToMonitored: true })]) assert.equal(approvedSupportReplyTo(raw), null);
  const withReply = await simpleParser(await composeVerificationEmail({ to: 'new@example.test', from: 'no-reply@example.test', replyTo: 'support@example.test', verificationUrl: verifyUrl, lifetimeMs: EMAIL_VERIFICATION_TOKEN_LIFETIME_MS }));
  assert.equal(withReply.replyTo?.value[0].address, 'support@example.test'); assert.equal(withReply.from?.value[0].address, 'no-reply@example.test');
  const without = await simpleParser(await composeVerificationEmail({ to: 'new@example.test', from: 'no-reply@example.test', replyTo: null, verificationUrl: verifyUrl, lifetimeMs: EMAIL_VERIFICATION_TOKEN_LIFETIME_MS }));
  assert.equal(without.replyTo, undefined);
});
it('order and dispatch "reply to this email" wording names the same mailbox as the Reply-To header', async () => {
  const pdf = await generateInvoicePdf(invoiceFixture);
  for (const raw of [await composeConfirmation(invoiceFixture, pdf), await composeDispatch(dispatchFixture, businessFixture)]) {
    const mail = await simpleParser(raw), reply = mail.replyTo?.value[0].address;
    assert.equal(reply, businessFixture.replyToEmail); assert.ok(mail.text?.includes(`just reply to this email or write to ${reply}.`));
  }
});
it('all three footers carry the configured UK trading disclosures', async () => {
  const { approvedLegalIdentity } = await import('../domain/email/supportContact.js');
  const legal = approvedLegalIdentity(JSON.stringify(businessFixture))!;
  assert.deepEqual(legal, { legalName: 'Colorful Life Ltd', registrationNumber: 'TEST-ONLY-000', registeredAddress: businessFixture.registeredAddress, registeredIn: 'England and Wales' });
  const expected = ['Colorful Life Ltd', 'Registered in England and Wales', 'Company No. TEST-ONLY-000', 'Registered office: Synthetic company fixture, 1 Fictional Road, Testville, TEST'];
  const emails = [renderVerificationEmail({ verificationUrl: verifyUrl, lifetimeMs: EMAIL_VERIFICATION_TOKEN_LIFETIME_MS, legal }), renderConfirmation(invoiceFixture), renderDispatch(dispatchFixture, businessFixture)];
  for (const r of emails) for (const line of expected) { assert.ok(r.text.includes(line), line); assert.ok(r.html.includes(line.replace('&', '&amp;')), line); }
  const unconfigured = renderVerificationEmail({ verificationUrl: verifyUrl, lifetimeMs: EMAIL_VERIFICATION_TOKEN_LIFETIME_MS, legal: approvedLegalIdentity(undefined) });
  assert.doesNotMatch(unconfigured.text, /Company No\.|Registered office/); assert.match(unconfigured.text, /Build & Bloom is a store by Colorful Life Ltd\./);
  for (const raw of ['not json', JSON.stringify({ ...businessFixture, legalName: 'Other Ltd' }), JSON.stringify({ ...businessFixture, registeredAddress: ['one line'] })]) assert.equal(approvedLegalIdentity(raw), null);
});
it('place of registration is optional so frozen pre-#185 invoice snapshots still parse and render', () => {
  const { registeredIn: _r, ...legacy } = businessFixture;
  const r = renderConfirmation({ ...invoiceFixture, business: legacy });
  assert.doesNotMatch(r.text, /Registered in/); assert.match(r.text, /Company No\. TEST-ONLY-000/);
  assert.equal(businessSchema.safeParse({ ...businessFixture, registeredIn: 'multi\nline' }).success, false);
});
it('invoice numbers follow the configured prefix and zero-padded width (e.g. BB-00000001)', async () => {
  const src = readFileSync('src/domain/orderConfirmation/worker.ts', 'utf8');
  assert.match(src, /invoiceNumber: `\$\{parsed\.data\.invoicePrefix\}-\$\{seq\.number\.toString\(\)\.padStart\(parsed\.data\.numberDigits, '0'\)\}`/);
  assert.equal(businessSchema.safeParse({ ...businessFixture, invoicePrefix: 'BB', numberDigits: 8 }).success, true);
  for (const invoicePrefix of ['bb', 'B B', '', 'BB/1']) assert.equal(businessSchema.safeParse({ ...businessFixture, invoicePrefix }).success, false);
  assert.equal(`BB-${1n.toString().padStart(8, '0')}`, 'BB-00000001');
});
it('the invoice sequence starts at the approved 102801 and the migration never moves a live sequence backwards', async () => {
  const sql = readFileSync('prisma/migrations/20261021120000_invoice_number_start/migration.sql', 'utf8');
  assert.match(sql, /IF next_value < 102801 THEN\s+PERFORM setval\('"commercial_invoice_number_seq"'::regclass, 102800, true\);/);
  assert.doesNotMatch(sql, /RESTART|INSERT|UPDATE|DELETE|DROP/i);
  // The conflicting sequence lock is taken before the read, so concurrent nextval() cannot interleave.
  assert.ok(sql.indexOf('ALTER SEQUENCE "commercial_invoice_number_seq" INCREMENT BY 1;') < sql.indexOf('INTO next_value'));
  assert.match(sql, /set_config\('lock_timeout', '10s', true\)/);
  assert.equal(`BB-${102801n.toString().padStart(8, '0')}`, 'BB-00102801');
});
