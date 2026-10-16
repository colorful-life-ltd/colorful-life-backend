import assert from 'node:assert/strict';
import { it } from 'node:test';
import { readFileSync } from 'node:fs';
import { simpleParser } from 'mailparser';
import { businessFixture, dispatchFixture } from './fixtures/orderConfirmation.fixture.js';
import { renderDispatch, dispatchSchema } from '../domain/orderConfirmation/dispatch.js';
import { composeDispatch } from '../domain/orderConfirmation/delivery.js';
it('renders exact branded dispatch HTML and plain-text snapshots', () => {
  const rendered = renderDispatch(dispatchFixture, businessFixture);
  for (const kind of ['html', 'text'] as const) assert.equal(rendered[kind], readFileSync(`src/__tests__/fixtures/dispatch-confirmation.${kind}`, 'utf8'));
  assert.equal(rendered.subject, 'Your Colorful Life Order #42 Has Been Dispatched!');
  assert.match(rendered.html, /max-width:600px/); assert.match(rendered.html, /lang="en"/); assert.match(rendered.html, /cid:colorful-life-logo/);
  assert.doesNotMatch(rendered.html, /<script|<style|<link|background-image|@font-face|<img[^>]+https?:/);
});
it('missing optional tracking and service is honest and adds no invented estimates or PDF claim', () => {
  const rendered = renderDispatch({ ...dispatchFixture, firstName: null, trackingNumber: null, delivery: null }, businessFixture);
  assert.match(rendered.text, /Hello,\n/); assert.match(rendered.text, /Tracking information is not currently available/);
  assert.doesNotMatch(rendered.text, /Tracking page:|Estimated|Standard|£|invoice|attached/i);
});
it('escapes names, carriers and tracking without arbitrary tracking links', () => {
  const rendered = renderDispatch({ ...dispatchFixture, firstName: '<b>Buyer & Friend</b>', carrier: 'OTHER', carrierName: '<script>Carrier</script>', trackingNumber: 'https://evil.test/<img>' }, businessFixture);
  assert.match(rendered.html, /&lt;b&gt;Buyer &amp; Friend&lt;\/b&gt;/); assert.doesNotMatch(rendered.html, /<script>|href="https:\/\/evil/);
  assert.match(rendered.text, /Carrier: <script>Carrier<\/script>/);
});
it('builds tracking links exclusively through existing trusted carrier policy', () => {
  const rendered = renderDispatch(dispatchFixture, businessFixture); assert.match(rendered.text, /https:\/\/www.royalmail.com\/track-your-item/);
  const invalid = renderDispatch({ ...dispatchFixture, trackingNumber: 'unverified-legacy-number' }, businessFixture); assert.doesNotMatch(invalid.text, /Tracking page:/);
  const evri = renderDispatch({ ...dispatchFixture, carrier: 'EVRI', carrierName: 'Evri', trackingNumber: '1234567890123456' }, businessFixture);
  assert.match(evri.text, /Enter your tracking number on the carrier’s official page/);
});
it('rejects invented partial shipment claims without supported item-level data', () => {
  assert.equal(dispatchSchema.safeParse({ ...dispatchFixture, scope: 'PARTIAL' }).success, false);
  assert.equal(dispatchSchema.safeParse({ ...dispatchFixture, trackingUrl: 'https://evil.test' }).success, false);
});
it('preserves long carrier text without unsafe markup or disappearing content', () => {
  const name = 'Synthetic carrier & '.repeat(20), rendered = renderDispatch({ ...dispatchFixture, carrier: null, carrierName: name }, businessFixture);
  assert.ok(rendered.text.includes(name.trim())); assert.match(rendered.html, /overflow-wrap:anywhere/);
});
it('dispatch MIME has HTML, plain text, CID logo and monitored Reply-To but no PDF', async () => {
  const raw = await composeDispatch(dispatchFixture, businessFixture), mail = await simpleParser(raw);
  assert.equal(mail.replyTo?.value[0].address, 'support@example.test'); assert.ok(mail.text?.includes('Royal Mail')); assert.ok(typeof mail.html === 'string');
  assert.equal(mail.attachments.length, 1); assert.equal(mail.attachments[0].cid, 'colorful-life-logo');
  assert.equal(mail.attachments.filter(a => a.contentType === 'application/pdf').length, 0);
  assert.doesNotMatch(raw.toString(), /client_secret|sk_live_|whsec_|commercial-invoice|Content-Type: application\/pdf/);
});
