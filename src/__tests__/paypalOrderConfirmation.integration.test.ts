import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, it } from 'node:test';
import { simpleParser } from 'mailparser';
import { prisma } from '../prisma/runtime.js';
import { config } from '../config/index.js';
import { createOrder } from '../domain/orders/orderService.js';
import { journalNewPayment, journalPayPalCapture } from '../domain/payments/paymentResolutionService.js';
import { capturePayPalOrder, PayPalCaptureProviderError, PayPalCaptureMismatchError } from '../domain/payments/paypalCaptureService.js';
import { reconcilePayPalWebhookEvent } from '../domain/payments/paypalReconciliationService.js';
import { resolvePayPalPaymentOutcome } from '../domain/payments/paypalResolutionService.js';
import { runConfirmationBatch } from '../domain/orderConfirmation/worker.js';
import { captureConfirmationTransport } from '../domain/orderConfirmation/delivery.js';
import { businessFixture } from './fixtures/orderConfirmation.fixture.js';

const originalManaged = config.PAYMENT_RESOLUTION_ENABLED;
afterEach(() => { config.PAYMENT_RESOLUTION_ENABLED = originalManaged; });
after(async () => { await prisma.$disconnect(); });
async function fixture(managed: boolean) {
  config.PAYMENT_RESOLUTION_ENABLED = managed;
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic', emailVerified: true,
    addresses: { create: { recipientName: 'Synthetic Buyer', line1: '1 Fictional Street', city: 'Testville', postcode: 'T1 1TT', countryCode: 'GB', isDefaultBilling: true } } } });
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: 'PayPal synthetic purchase', theme: 'TEST', ageRecommendation: '8+', pieceCount: 10 } });
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: 'NEW', originalPrice: '12.50', currentStock: 5 } });
  const order = await createOrder(user.id, { shippingMethod: 'STANDARD', items: [{ productListingId: listing.id, quantity: 2 }] });
  const payment = await prisma.$transaction(async tx => {
    const p = await tx.payment.create({ data: { orderId: order.id, provider: 'PAYPAL', providerReference: `PP-${randomUUID()}`, amount: order.totalAmount, currency: 'GBP', status: 'PROCESSING' } });
    if (managed) await journalNewPayment(tx, p, 'CREATE');
    return p;
  });
  const captureId = `CAP-${randomUUID()}`;
  const remote = { id: payment.providerReference, status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: captureId, status: 'COMPLETED', amount: { value: order.totalAmount.toFixed(2), currency_code: 'GBP' } }] } }] };
  const event = { id: `WH-${randomUUID()}`, eventType: 'PAYMENT.CAPTURE.COMPLETED', paypalOrderId: payment.providerReference, captureId, amount: order.totalAmount.toFixed(2), currency: 'GBP' };
  return { user, listing, order, payment, captureId, remote, event };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function complete(f: Fixture, path: 'API' | 'WEBHOOK' | 'RESOLUTION') {
  if (path === 'API') return capturePayPalOrder(f.order.id, f.user.id, { captureOrder: async () => f.remote });
  if (config.PAYMENT_RESOLUTION_ENABLED) await prisma.$transaction(tx => journalPayPalCapture(tx, f.payment));
  if (path === 'WEBHOOK') return reconcilePayPalWebhookEvent(f.event);
  await prisma.paymentResolution.update({ where: { orderId: f.order.id }, data: { state: 'CLOSED_RESOLVING', paymentAdmissionClosedAt: new Date(), closureReason: 'CUSTOMER_ABANDONED' } });
  return resolvePayPalPaymentOutcome(f.order.id, { retrieveOrder: async () => f.remote });
}
async function assertConfirmed(f: Fixture, managed: boolean) {
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'CONFIRMED');
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  assert.equal(payment.status, 'SUCCEEDED'); assert.equal(payment.providerCaptureReference, f.captureId); assert.ok(payment.paidAt);
  const stock = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } });
  assert.equal(stock.currentStock, 3); assert.equal(stock.reservedStock, 0);
  assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.listing.id, type: 'WEBSITE_SALE' } }), 1);
  if (managed) {
    const resolution = await prisma.paymentResolution.findUniqueOrThrow({ where: { orderId: f.order.id } });
    assert.equal(resolution.state, 'PAID'); assert.equal(resolution.reservationDisposition, 'CONSUMED');
    assert.equal(await prisma.financialEvidence.count({ where: { orderId: f.order.id, kind: 'SUCCESS', operation: { type: 'CAPTURE' } } }), 1);
  }
}
for (const managed of [false, true]) {
  for (const path of (managed ? ['API', 'WEBHOOK', 'RESOLUTION'] : ['API', 'WEBHOOK']) as Array<'API' | 'WEBHOOK' | 'RESOLUTION'>) {
    it(`${managed ? 'MANAGED' : 'LEGACY'} ${path} shares confirmation, immutable invoice and captured email across replays`, async () => {
      const f = await fixture(managed); await complete(f, path); await assertConfirmed(f, managed);
      const job = await prisma.orderConfirmationJob.findUniqueOrThrow({ where: { eventKey: `order:${f.order.id}` } });
      assert.equal(job.state, 'PENDING');
      const capture = captureConfirmationTransport();
      await runConfirmationBatch({ jobId: job.id, transport: capture.transport, business: businessFixture });
      const first = await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } });
      assert.ok(first.pdfBytes); assert.ok(Buffer.from(first.pdfBytes).subarray(0, 4).equals(Buffer.from('%PDF')));
      await Promise.all([reconcilePayPalWebhookEvent(f.event), reconcilePayPalWebhookEvent({ ...f.event, id: randomUUID() }), capturePayPalOrder(f.order.id, f.user.id, { captureOrder: async () => { assert.fail('replay must not recapture'); } })]);
      await runConfirmationBatch({ jobId: job.id, transport: capture.transport, business: businessFixture });
      await assertConfirmed(f, managed); assert.equal(capture.messages.length, 1);
      assert.deepEqual(await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } }), first);
      assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 1);
      const email = await simpleParser(capture.messages[0]);
      assert.equal(email.attachments.filter(a => a.contentType === 'application/pdf').length, 1);
      assert.match(email.text!, /28\.99/); assert.match(email.text!, /No VAT has been charged/);
    });
  }
  for (const path of ['API', 'WEBHOOK'] as const) {
    it(`${managed ? 'MANAGED' : 'LEGACY'} ${path} retains paid evidence and rolls back partial inventory conversion on stock failure`, async () => {
      const f = await fixture(managed);
      // First listing converts; the second fails, exercising rollback of real writes.
      const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: 'Unavailable synthetic item', theme: 'TEST', ageRecommendation: '8+', pieceCount: 10 } });
      const second = await prisma.productListing.create({ data: { legoProductId: product.id, condition: 'NEW', originalPrice: 0, currentStock: 0 } });
      await prisma.orderItem.create({ data: { orderId: f.order.id, productListingId: second.id, quantity: 1, unitPrice: 0, lineTotal: 0 } });
      await complete(f, path);
      assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'SUCCEEDED');
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'PENDING');
      const stock = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } });
      assert.equal(stock.currentStock, 5); assert.equal(stock.reservedStock, 2);
      assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.listing.id } }), 0);
      assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 0);
      const receipt = await prisma.paymentWebhookEvent.findFirstOrThrow({ where: { providerEventId: path === 'API' ? `capture:${f.captureId}` : f.event.id } });
      assert.match(receipt.processingError!, /financial success retained/); assert.ok(receipt.processedAt);
      if (managed) {
        assert.equal((await prisma.paymentResolution.findUniqueOrThrow({ where: { orderId: f.order.id } })).reservationDisposition, 'HELD');
        assert.equal(await prisma.financialEvidence.count({ where: { orderId: f.order.id, kind: 'SUCCESS', operation: { type: 'CAPTURE' } } }), 1);
      }
    });
  }
}
for (const path of ['API', 'WEBHOOK'] as const) {
  it(`${path} rejects a provider/payment match that disagrees with the authoritative order total`, async () => {
    const f = await fixture(false);
    await prisma.order.update({ where: { id: f.order.id }, data: { totalAmount: '29.99' } });
    if (path === 'API') await assert.rejects(complete(f, path), PayPalCaptureMismatchError);
    else assert.equal((await reconcilePayPalWebhookEvent(f.event)).handled, false);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'PROCESSING');
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'PENDING');
    assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 0);
  });
}
for (const status of ['CANCELLED', 'EXPIRED'] as const) it(`managed late ${status} success retains evidence without fulfilment or sending an invoice`, async () => {
  const f = await fixture(true);
  await prisma.$transaction(async tx => {
    await journalPayPalCapture(tx, f.payment);
    // Model a historical terminal order, not a new release policy.
    await tx.order.update({ where: { id: f.order.id }, data: { status } });
  });
  await reconcilePayPalWebhookEvent(f.event);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'SUCCEEDED');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, status);
  assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 0);
  assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.listing.id } }), 0);
});
for (const invalid of ['parent', 'amount', 'currency', 'capture-status', 'order-status'] as const) it(`API ${invalid} mismatch cannot confirm or enqueue`, async () => {
  const f = await fixture(false), remote = structuredClone(f.remote);
  const capture = remote.purchase_units[0].payments.captures[0];
  if (invalid === 'parent') remote.id = `FOREIGN-${randomUUID()}`;
  if (invalid === 'amount') capture.amount.value = '1.00';
  if (invalid === 'currency') capture.amount.currency_code = 'USD';
  if (invalid === 'capture-status') capture.status = 'PENDING';
  if (invalid === 'order-status') remote.status = 'APPROVED';
  await assert.rejects(capturePayPalOrder(f.order.id, f.user.id, { captureOrder: async () => remote }), invalid === 'capture-status' ? PayPalCaptureProviderError : PayPalCaptureMismatchError);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'PROCESSING');
  assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 0);
  assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).reservedStock, 2);
});
it('early dispatch retains the PayPal invoice obligation with status-aware wording', async () => {
  const f = await fixture(true); await complete(f, 'API');
  await prisma.order.update({ where: { id: f.order.id }, data: { status: 'DISPATCHED' } });
  const job = await prisma.orderConfirmationJob.findUniqueOrThrow({ where: { eventKey: `order:${f.order.id}` } });
  const capture = captureConfirmationTransport();
  await runConfirmationBatch({ jobId: job.id, transport: capture.transport, business: businessFixture });
  assert.equal(capture.messages.length, 1); const email = await simpleParser(capture.messages[0]);
  assert.equal(email.attachments.filter(a => a.contentType === 'application/pdf').length, 1);
  assert.doesNotMatch(email.text!, /dispatch email will follow/i);
});
it('historical incomplete managed coverage retains financial success for manual reconciliation', async () => {
  const f = await fixture(false); config.PAYMENT_RESOLUTION_ENABLED = true;
  await reconcilePayPalWebhookEvent(f.event);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'SUCCEEDED');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'PENDING');
  assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 0);
  assert.match((await prisma.paymentWebhookEvent.findFirstOrThrow({ where: { providerEventId: f.event.id } })).processingError!, /incomplete reservation coverage/);
});
it('already-confirmed historical PayPal re-observation does not backfill an invoice job', async () => {
  const f = await fixture(false);
  await prisma.order.update({ where: { id: f.order.id }, data: { status: 'CONFIRMED' } });
  await reconcilePayPalWebhookEvent(f.event);
  assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 0);
  assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.listing.id } }), 0);
});
