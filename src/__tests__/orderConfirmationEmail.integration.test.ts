import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, it } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import { simpleParser } from 'mailparser';
import { prisma } from '../prisma/runtime.js';
import { config } from '../config/index.js';
import app from '../app.js';
import { setDispatchNotificationSenderForTests } from '../services/emailService.js';
import { dispatchShipment } from '../domain/fulfilment/fulfilmentService.js';
import { recoverOrderConfirmation } from '../domain/orderConfirmation/enqueue.js';
import { initializePaymentResolution, journalNewPayment } from '../domain/payments/paymentResolutionService.js';
import { reconcileStripePaymentEvent } from '../domain/payments/stripeReconciliationService.js';
import { runConfirmationBatch, requeueConfirmation, startOrderConfirmationWorker } from '../domain/orderConfirmation/worker.js';
import { captureConfirmationTransport, DeliveryRejected, type ConfirmationTransport } from '../domain/orderConfirmation/delivery.js';
import { businessFixture, purchaseFixture } from './fixtures/orderConfirmation.fixture.js';

const originalDispatchActivation = config.DISPATCH_CONFIRMATION_EMAIL_ENABLED;
beforeEach(() => { config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = true; });
afterEach(() => { config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = originalDispatchActivation; });

const originalSending = config.ORDER_CONFIRMATION_EMAIL_ENABLED;
const originalStripeKey = config.STRIPE_SECRET_KEY;
const originalSecret = config.STRIPE_WEBHOOK_SECRET;
beforeEach(() => { config.ORDER_CONFIRMATION_EMAIL_ENABLED = false; config.STRIPE_SECRET_KEY = 'sk_test_issue180_synthetic'; config.STRIPE_WEBHOOK_SECRET = 'whsec_issue180_isolated'; });
afterEach(() => { config.ORDER_CONFIRMATION_EMAIL_ENABLED = originalSending; config.STRIPE_SECRET_KEY = originalStripeKey; config.STRIPE_WEBHOOK_SECRET = originalSecret; });
const originalManaged = config.PAYMENT_RESOLUTION_ENABLED;
afterEach(() => { config.PAYMENT_RESOLUTION_ENABLED = originalManaged; });
after(async () => { await prisma.$disconnect(); });
async function fixture(managed = false, options: { delivery?: boolean; description?: boolean; verified?: boolean } = {}) {
  config.PAYMENT_RESOLUTION_ENABLED = managed;
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, firstName: 'Original Buyer', passwordHash: 'synthetic', emailVerified: options.verified ?? true,
    addresses: { create: { recipientName: 'Synthetic Buyer', line1: '1 Fictional Road', city: 'Testville', postcode: 'T1', countryCode: 'GB', isDefaultBilling: true } } } });
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: 'Original product', theme: 'TEST', ageRecommendation: '8+', pieceCount: 10 } });
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: 'NEW', originalPrice: '12.50', currentStock: 5, reservedStock: 2 } });
  const delivery = options.delivery === false ? null : purchaseFixture.delivery;
  const amount = delivery ? '28.99' : '25.00';
  const order = await prisma.$transaction(async tx => {
    const o = await tx.order.create({ data: { userId: user.id, totalAmount: amount, ...(delivery ? { confirmationDeliverySnapshot: delivery } : {}), reservationExpiresAt: new Date(Date.now() + 1800000),
      billingRecipientName: 'Synthetic Buyer', billingLine1: '1 Fictional Road', billingCity: 'Testville', billingPostcode: 'T1', billingCountryCode: 'GB',
      deliveryRecipientName: 'Synthetic Buyer', deliveryLine1: '2 Fictional Road', deliveryCity: 'Testville', deliveryPostcode: 'T2', deliveryCountryCode: 'GB',
      orderItems: { create: { productListingId: listing.id, quantity: 2, unitPrice: '12.50', lineTotal: '25.00', invoiceDescriptionSnapshot: options.description === false ? null : 'Original product', invoiceSetNumberSnapshot: 'TEST-SET' } },
    } });
    await initializePaymentResolution(tx, o); return o;
  });
  const payment = await prisma.$transaction(async tx => {
    const p = await tx.payment.create({ data: { orderId: order.id, provider: 'STRIPE', providerReference: `pi_isolated_${randomUUID()}`, idempotencyKey: `stripe-create-${randomUUID()}`, amount, currency: 'GBP', status: 'PROCESSING' } });
    if (managed) await journalNewPayment(tx, p, 'CREATE');
    return p;
  });
  const attempt = await prisma.paymentAttempt.findFirst({ where: { paymentId: payment.id } });
  const event = { id: `evt_${randomUUID()}`, type: 'payment_intent.succeeded' as const, paymentIntentId: payment.providerReference, amount: delivery ? 2899 : 2500, currency: 'gbp', metadata: { orderId: String(order.id), ...(attempt ? { attemptId: String(attempt.id) } : {}) } };
  return { user, product, listing, order, payment, event };
}
const jobFor = (id: number) => prisma.orderConfirmationJob.findUniqueOrThrow({ where: { eventKey: `order:${id}` } });
async function confirm(f: Awaited<ReturnType<typeof fixture>>) { await reconcileStripePaymentEvent(f.event); return jobFor(f.order.id); }
const execute = (jobId: string, transport: ConfirmationTransport, business: unknown = businessFixture) => runConfirmationBatch({ jobId, transport, business });
async function makeDue(id: string) { await prisma.orderConfirmationJob.update({ where: { id }, data: { nextAttemptAt: new Date(0) } }); }
function deferred() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }

for (const managed of [false, true]) {
  it(`${managed ? 'MANAGED' : 'LEGACY'} verified confirmation creates one task/invoice across duplicate success events`, async () => {
    const f = await fixture(managed), job = await confirm(f), capture = captureConfirmationTransport();
    assert.equal(job.state, 'PENDING'); assert.equal(await prisma.commercialInvoice.count({ where: { orderId: f.order.id } }), 0);
    await execute(job.id, capture.transport);
    await reconcileStripePaymentEvent(f.event); await reconcileStripePaymentEvent({ ...f.event, id: randomUUID() }); await execute(job.id, capture.transport);
    assert.equal(capture.messages.length, 1); assert.equal((await jobFor(f.order.id)).state, 'SENT');
    assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 1); assert.equal(await prisma.commercialInvoice.count({ where: { orderId: f.order.id } }), 1);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'CONFIRMED');
    const stock = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } }); assert.equal(stock.currentStock, 3); assert.equal(stock.reservedStock, 0);
    assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.listing.id, type: 'WEBSITE_SALE' } }), 1);
  });
  it(`${managed ? 'MANAGED' : 'LEGACY'} failures and foreign events create no confirmation task`, async () => {
    const f = await fixture(managed);
    await reconcileStripePaymentEvent({ ...f.event, id: randomUUID(), paymentIntentId: `pi_foreign_${randomUUID()}` });
    await reconcileStripePaymentEvent({ ...f.event, type: 'payment_intent.payment_failed' });
    assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 0);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).reservedStock, 2);
  });
}
for (const status of ['CANCELLED', 'EXPIRED'] as const) it(`late paid ${status} orders create no task`, async () => {
  const f = await fixture(); await prisma.order.update({ where: { id: f.order.id }, data: { status } });
  await reconcileStripePaymentEvent(f.event); assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 0);
});
it('paid but unconfirmed managed inventory exception does not create an email', async () => {
  const f = await fixture(true);
  await prisma.orderItem.updateMany({ where: { orderId: f.order.id }, data: { quantity: 6 } });
  await reconcileStripePaymentEvent(f.event);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'SUCCEEDED');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'PENDING');
  assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 0);
});
for (const [options, diagnostic] of [[{ delivery: false }, 'SHIPPING_NOT_PERSISTED'], [{ description: false }, 'PRODUCT_SNAPSHOT_MISSING'], [{ verified: false }, 'RECIPIENT_UNAVAILABLE']] as const) it(`blocks ${diagnostic} without reversing payment or stock`, async () => {
  const f = await fixture(false, options), job = await confirm(f), capture = captureConfirmationTransport();
  assert.equal(job.state, 'BLOCKED'); assert.equal(job.lastErrorCode, diagnostic); await execute(job.id, capture.transport);
  assert.equal(capture.messages.length, 0); assert.equal(await prisma.commercialInvoice.count({ where: { orderId: f.order.id } }), 0);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'SUCCEEDED');
  assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).currentStock, 3);
});
it('missing business approval blocks issuance and explicit reviewed requeue can use approved configuration', async () => {
  const f = await fixture(), job = await confirm(f), capture = captureConfirmationTransport();
  await execute(job.id, capture.transport, {}); assert.equal((await jobFor(f.order.id)).state, 'BLOCKED');
  assert.equal(await prisma.commercialInvoice.count({ where: { orderId: f.order.id } }), 0);
  await requeueConfirmation(job.id); await execute(job.id, capture.transport); assert.equal(capture.messages.length, 1);
});
it('production delivery is disabled by default and test mode cannot enable SES', async () => {
  const f = await fixture(), job = await confirm(f);
  config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = false;
  assert.equal(config.ORDER_CONFIRMATION_EMAIL_ENABLED, false);
  assert.deepEqual(await runConfirmationBatch({ jobId: job.id }), { processed: 0, disabled: true });
  assert.equal((await jobFor(f.order.id)).attempts, 0);
  const stop = startOrderConfirmationWorker(1); await stop(); assert.equal((await jobFor(f.order.id)).attempts, 0);
});
it('retries definitive throttling without changing the snapshot, invoice number or cached PDF', async () => {
  const f = await fixture(), job = await confirm(f);
  await execute(job.id, { kind: 'capture', async send() { throw new DeliveryRejected(true, 'THROTTLED'); } });
  const first = await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } }); assert.equal((await jobFor(f.order.id)).state, 'RETRY');
  await prisma.legoProduct.update({ where: { id: f.product.id }, data: { title: 'Changed catalogue title' } });
  await prisma.user.update({ where: { id: f.user.id }, data: { firstName: 'Changed customer', email: `${randomUUID()}@example.test` } });
  await prisma.order.update({ where: { id: f.order.id }, data: { deliveryLine1: 'Changed address' } });
  await prisma.productListing.update({ where: { id: f.listing.id }, data: { originalPrice: '99.00' } });
  await makeDue(job.id); const capture = captureConfirmationTransport(); await execute(job.id, capture.transport, { ...businessFixture, registrationNumber: 'CHANGED' });
  const second = await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } });
  assert.deepEqual(second, first); const email = await simpleParser(capture.messages[0]);
  assert.ok(email.text?.includes('Original product')); assert.ok(email.text?.includes('2 Fictional Road')); assert.ok(!email.text?.includes('Changed'));
  assert.equal(email.to && 'value' in email.to ? email.to.value[0].address : null, f.user.email);
});
it('database rejects source, invoice and PDF mutation/deletion', async () => {
  const f = await fixture(), job = await confirm(f); await execute(job.id, captureConfirmationTransport().transport);
  const invoice = await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } });
  await assert.rejects(prisma.orderConfirmationJob.update({ where: { id: job.id }, data: { source: {} } }));
  await assert.rejects(prisma.commercialInvoice.update({ where: { id: invoice.id }, data: { snapshot: {} } }));
  await assert.rejects(prisma.commercialInvoice.update({ where: { id: invoice.id }, data: { pdfBytes: new Uint8Array(Buffer.from('%PDF-changed')), pdfSha256: createHash('sha256').update('changed').digest('hex') } }));
  await assert.rejects(prisma.commercialInvoice.delete({ where: { id: invoice.id } }));
  await assert.rejects(prisma.order.delete({ where: { id: f.order.id } }));
});
it('concurrent workers send and number one invoice only', async () => {
  const f = await fixture(), job = await confirm(f), capture = captureConfirmationTransport();
  await Promise.all(Array.from({ length: 5 }, () => execute(job.id, capture.transport)));
  assert.equal(capture.messages.length, 1); assert.equal(await prisma.commercialInvoice.count({ where: { orderId: f.order.id } }), 1);
});
it('expired preparation leases can be reclaimed without creating another invoice', async () => {
  const f = await fixture(), job = await confirm(f), capture = captureConfirmationTransport();
  await prisma.orderConfirmationJob.update({ where: { id: job.id }, data: { state: 'PROCESSING', claimOwner: 'crashed', claimGeneration: 1, leaseExpiresAt: new Date(0), sendStartedAt: null } });
  await execute(job.id, capture.transport); assert.equal(capture.messages.length, 1); assert.equal((await jobFor(f.order.id)).claimGeneration, 2);
});
it('expired potentially-sent leases become UNKNOWN and a delayed worker cannot overwrite that state', async () => {
  const f = await fixture(), job = await confirm(f), entered = deferred(), gate = deferred(); let sends = 0;
  const task = execute(job.id, { kind: 'capture', async send() { sends++; entered.release(); await gate.promise; return { messageId: 'accepted-but-late' }; } });
  await entered.promise;
  await prisma.orderConfirmationJob.update({ where: { id: job.id }, data: { leaseExpiresAt: new Date(0) } });
  await execute(job.id, captureConfirmationTransport().transport);
  assert.equal((await jobFor(f.order.id)).state, 'UNKNOWN'); gate.release(); await task;
  assert.equal((await jobFor(f.order.id)).state, 'UNKNOWN'); assert.equal(sends, 1);
});
it('lost acknowledgement is not automatically resent and explicit risk acknowledgement is required', async () => {
  const f = await fixture(), job = await confirm(f); let sends = 0;
  await execute(job.id, { kind: 'capture', async send() { sends++; throw new Error('lost acknowledgement with private payload'); } });
  assert.equal((await jobFor(f.order.id)).state, 'UNKNOWN'); assert.equal((await jobFor(f.order.id)).lastErrorCode, 'ACCEPTANCE_UNKNOWN');
  await makeDue(job.id); await execute(job.id, captureConfirmationTransport().transport); assert.equal(sends, 1);
  await assert.rejects(requeueConfirmation(job.id));
  const invoice = await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } });
  await requeueConfirmation(job.id, true); const capture = captureConfirmationTransport(); await execute(job.id, capture.transport);
  assert.equal(capture.messages.length, 1); assert.equal((await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } })).invoiceNumber, invoice.invoiceNumber);
});
it('permanent provider rejection does not reverse a successful payment', async () => {
  const f = await fixture(), job = await confirm(f);
  await execute(job.id, { kind: 'capture', async send() { throw new DeliveryRejected(false, 'PROVIDER_REJECTED'); } });
  assert.equal((await jobFor(f.order.id)).state, 'FAILED'); assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'SUCCEEDED');
});
it('definitive rejection retries stop at the bounded attempt limit', async () => {
  const f = await fixture(), job = await confirm(f); let sends = 0;
  for (let i = 0; i < 10; i++) { await makeDue(job.id); await execute(job.id, { kind: 'capture', async send() { sends++; throw new DeliveryRejected(true, 'THROTTLED'); } }); }
  assert.equal(sends, 8); assert.equal((await jobFor(f.order.id)).state, 'FAILED');
});
for (const status of ['CANCELLED', 'EXPIRED'] as const) it(`suppresses a previously queued order if ${status} before sending`, async () => {
  const f = await fixture(), job = await confirm(f), capture = captureConfirmationTransport();
  await prisma.order.update({ where: { id: f.order.id }, data: { status } });
  await execute(job.id, capture.transport); assert.equal(capture.messages.length, 0); assert.equal((await jobFor(f.order.id)).state, 'SUPPRESSED');
});
it('signed HTTP webhook to captured MIME exercises the actual confirmation pipeline without email infrastructure', async () => {
  const f = await fixture(true), server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  try {
    const payload = JSON.stringify({ id: f.event.id, type: f.event.type, data: { object: { id: f.event.paymentIntentId, amount: f.event.amount, currency: 'gbp', metadata: f.event.metadata } } });
    const signature = new Stripe('sk_test_fake').webhooks.generateTestHeaderString({ payload, secret: config.STRIPE_WEBHOOK_SECRET! });
    const send = (signed = true) => fetch(`${base}/payments/stripe/webhook`, { method: 'POST', headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, 'Content-Type': 'application/json', ...(signed ? { 'stripe-signature': signature } : {}) }, body: payload });
    assert.equal((await send(false)).status, 400); assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 0);
    assert.equal((await send()).status, 200); assert.equal((await send()).status, 200);
    const job = await jobFor(f.order.id), capture = captureConfirmationTransport(); await execute(job.id, capture.transport);
    const email = await simpleParser(capture.messages[0]); assert.equal(email.attachments.filter(a => a.contentType === 'application/pdf').length, 1);
    assert.ok(email.text?.includes('£28.99')); assert.equal((await jobFor(f.order.id)).state, 'SENT');
    const token = jwt.sign({ id: f.user.id, role: 'CUSTOMER' }, config.JWT_SECRET);
    assert.equal((await fetch(`${base}/orders/${f.order.id}`, { headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${token}` } })).status, 200);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});
it('actual HTTP checkout persists shipping and produces a valid confirmation source', async () => {
  const f = await fixture(), server = createServer(app); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/orders`, { method: 'POST', headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${jwt.sign({ id: f.user.id, role: 'CUSTOMER' }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ shippingMethod: "STANDARD" as const, items: [{ productListingId: f.listing.id, quantity: 1 }] }) });
    assert.equal(response.status, 201); const order = await response.json();
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } }); assert.equal(item.invoiceDescriptionSnapshot, 'Original product');
    const payment = await prisma.payment.create({ data: { orderId: order.id, provider: 'STRIPE', providerReference: `pi_${randomUUID()}`, amount: order.totalAmount, status: 'PROCESSING' } });
    await reconcileStripePaymentEvent({ id: randomUUID(), type: 'payment_intent.succeeded', paymentIntentId: payment.providerReference, amount: 1649, currency: 'gbp', metadata: { orderId: String(order.id) } });
    assert.equal((await jobFor(order.id)).state, 'PENDING');
    assert.equal((await jobFor(order.id)).lastErrorCode, null);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

for (const status of ['DISPATCHED', 'COMPLETED'] as const) it(`delivers the invoice with current ${status} wording instead of a stale dispatch promise`, async () => {
  const f = await fixture(), job = await confirm(f), capture = captureConfirmationTransport();
  await prisma.order.update({ where: { id: f.order.id }, data: { status, dispatchedAt: new Date() } });
  await execute(job.id, capture.transport);
  assert.equal(capture.messages.length, 1); assert.equal((await jobFor(f.order.id)).state, 'SENT');
  const mail = await simpleParser(capture.messages[0]); assert.doesNotMatch(mail.text!, /We will email you when your order is dispatched/);
  assert.equal(mail.attachments.filter(a => a.contentType === 'application/pdf').length, 1);
});
it('deleted customer suppression retains an already issued immutable invoice', async () => {
  const f = await fixture(), job = await confirm(f);
  await execute(job.id, { kind: 'capture', async send() { throw new DeliveryRejected(true, 'THROTTLED'); } });
  const invoice = await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } });
  await prisma.user.update({ where: { id: f.user.id }, data: { deletedAt: new Date(), email: `deleted-${randomUUID()}@example.test` } });
  await makeDue(job.id); const capture = captureConfirmationTransport(); await execute(job.id, capture.transport);
  assert.equal(capture.messages.length, 0); assert.equal((await jobFor(f.order.id)).lastErrorCode, 'ACCOUNT_DELETED');
  assert.deepEqual(await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } }), invoice);
});
it('an activation cutoff suppresses pre-activation backlog instead of emailing it', async () => {
  const f = await fixture(), job = await confirm(f), capture = captureConfirmationTransport();
  await runConfirmationBatch({ jobId: job.id, transport: capture.transport, business: businessFixture, activeFrom: new Date() });
  assert.equal(capture.messages.length, 0); assert.equal((await jobFor(f.order.id)).lastErrorCode, 'BEFORE_ACTIVATION_CUTOFF');
});
it('re-observing a historical confirmed payment cannot backfill a new email job', async () => {
  const f = await fixture();
  await prisma.order.update({ where: { id: f.order.id }, data: { status: 'CONFIRMED' } });
  await prisma.payment.update({ where: { id: f.payment.id }, data: { status: 'SUCCEEDED', paidAt: new Date() } });
  await reconcileStripePaymentEvent(f.event);
  assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 0);
});

it('operator recovery explicitly approves missing manual-confirmation tasks without bypassing payment eligibility', async () => {
  const f = await fixture();
  await prisma.order.update({ where: { id: f.order.id }, data: { status: 'CONFIRMED' } });
  await assert.rejects(recoverOrderConfirmation(f.order.id, false), /review/);
  await assert.rejects(recoverOrderConfirmation(f.order.id, true), /eligible/);
  await prisma.payment.update({ where: { id: f.payment.id }, data: { status: 'SUCCEEDED', paidAt: new Date() } });
  const first = await recoverOrderConfirmation(f.order.id, true), second = await recoverOrderConfirmation(f.order.id, true);
  assert.equal(first.jobId, second.jobId); assert.equal(first.state, 'PENDING');
});

it('early dispatch preserves the invoice obligation and sends no stale promise', async () => {
  const f = await fixture(), confirmation = await confirm(f);
  const admin = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic', role: 'ADMIN' } });
  await dispatchShipment(admin.id, f.order.id, { carrier: 'ROYAL_MAIL', carrierName: 'Royal Mail', trackingNumber: 'AB123456789GB', actualShippingCost: 3.50 });
  assert.equal((await jobFor(f.order.id)).state, 'PENDING');
  const dispatch = await prisma.orderConfirmationJob.findFirstOrThrow({ where: { orderId: f.order.id, type: 'DISPATCH_CONFIRMATION' } });
  const capture = captureConfirmationTransport(); await execute(confirmation.id, capture.transport); await execute(dispatch.id, capture.transport);
  assert.equal(capture.messages.length, 2); assert.equal((await simpleParser(capture.messages[0])).attachments.filter(a => a.contentType === 'application/pdf').length, 1);
  assert.equal((await simpleParser(capture.messages[1])).attachments.filter(a => a.contentType === 'application/pdf').length, 0);
});
it('an already delivered confirmation is followed by one dispatch email while retaining the original invoice', async () => {
  const f = await fixture(), confirmation = await confirm(f), capture = captureConfirmationTransport(); await execute(confirmation.id, capture.transport);
  const invoice = await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } });
  const admin = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic', role: 'ADMIN' } });
  await dispatchShipment(admin.id, f.order.id, { carrier: 'ROYAL_MAIL', carrierName: 'Royal Mail', trackingNumber: null, actualShippingCost: 3.50 });
  const dispatch = await prisma.orderConfirmationJob.findFirstOrThrow({ where: { orderId: f.order.id, type: 'DISPATCH_CONFIRMATION' } }); await execute(dispatch.id, capture.transport);
  assert.equal(capture.messages.length, 2); assert.equal((await jobFor(f.order.id)).state, 'SENT');
  assert.deepEqual(await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } }), invoice);
});

it('retains stable invoice bytes through SES rejection, early dispatch, retry and duplicate events', async () => {
  const f = await fixture(), job = await confirm(f);
  await execute(job.id, { kind: 'capture', async send() { throw new DeliveryRejected(true, 'CONNECTION_NOT_ESTABLISHED'); } });
  const original = await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } });
  const admin = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic', role: 'ADMIN' } });
  await dispatchShipment(admin.id, f.order.id, { carrier: 'ROYAL_MAIL', carrierName: 'Royal Mail', trackingNumber: null, actualShippingCost: 3.50 });
  await makeDue(job.id); const capture = captureConfirmationTransport(); await execute(job.id, capture.transport);
  await execute(job.id, capture.transport); await reconcileStripePaymentEvent({ ...f.event, id: randomUUID() });
  assert.equal(capture.messages.length, 1); const mail = await simpleParser(capture.messages[0]); assert.match(mail.text!, /has been dispatched/); assert.doesNotMatch(mail.text!, /We will email/);
  assert.deepEqual(mail.attachments.find(a => a.contentType === 'application/pdf')?.content, Buffer.from(original.pdfBytes!));
  assert.deepEqual(await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } }), original);
});
it('unknown invoice acceptance after early dispatch requires explicit review and reuses the same PDF', async () => {
  const f = await fixture(), job = await confirm(f);
  await execute(job.id, { kind: 'capture', async send() { throw new Error('unknown acceptance'); } });
  const original = await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: f.order.id } });
  await prisma.order.update({ where: { id: f.order.id }, data: { status: 'DISPATCHED', dispatchedAt: new Date() } });
  const capture = captureConfirmationTransport(); await execute(job.id, capture.transport); assert.equal(capture.messages.length, 0);
  await assert.rejects(requeueConfirmation(job.id)); await requeueConfirmation(job.id, true); await execute(job.id, capture.transport);
  assert.equal(capture.messages.length, 1); assert.deepEqual((await simpleParser(capture.messages[0])).attachments.find(a => a.contentType === 'application/pdf')?.content, Buffer.from(original.pdfBytes!));
});
it('invoice backlog is retained for explicit per-job review without moving the global cutoff', async () => {
  const f = await fixture(), job = await confirm(f), capture = captureConfirmationTransport(), cutoff = new Date();
  await runConfirmationBatch({ jobId: job.id, transport: capture.transport, business: businessFixture, activeFrom: cutoff });
  assert.equal((await jobFor(f.order.id)).state, 'BLOCKED'); await requeueConfirmation(job.id, false, true);
  await runConfirmationBatch({ jobId: job.id, transport: capture.transport, business: businessFixture, activeFrom: cutoff });
  assert.equal(capture.messages.length, 1); assert.ok((await jobFor(f.order.id)).backlogApprovedAt);
  await assert.rejects(prisma.orderConfirmationJob.update({ where: { id: job.id }, data: { backlogApprovedAt: null } }));
});
it('database rejects missing or mismatched confirmation source order IDs on insertion', async () => {
  const f = await fixture();
  for (const source of [{}, { orderId: f.order.id + 999 }]) await assert.rejects(prisma.orderConfirmationJob.create({ data: { orderId: f.order.id, eventKey: `order:${f.order.id}`, source } }));
  assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 0); await confirm(f);
});

it('signed payment webhook remains available through SES outage, then early-dispatch invoice is delivered on readiness recovery', async () => {
  const { createEmailReadinessTick } = await import('../domain/orderConfirmation/readiness.js');
  const f = await fixture(true), server = createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let available = false, now = 0; const warnings: string[] = [], capture = captureConfirmationTransport();
  const tick = createEmailReadinessTick({ enabled: () => true, now: () => now,
    probe: async () => { if (!available) throw new Error('private SES credential error'); },
    run: async () => { const job = await jobFor(f.order.id); await execute(job.id, capture.transport); }, warn: s => warnings.push(s) });
  try {
    await tick();
    const payload = JSON.stringify({ id: f.event.id, type: f.event.type, data: { object: { id: f.event.paymentIntentId, amount: f.event.amount, currency: 'gbp', metadata: f.event.metadata } } });
    const signature = new Stripe('sk_test_issue180_synthetic').webhooks.generateTestHeaderString({ payload, secret: config.STRIPE_WEBHOOK_SECRET! });
    const response = await fetch(`http://127.0.0.1:${address.port}/payments/stripe/webhook`, { method: 'POST', headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, 'Content-Type': 'application/json', 'stripe-signature': signature }, body: payload });
    assert.equal(response.status, 200); const job = await jobFor(f.order.id); assert.equal(job.attempts, 0);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'CONFIRMED');
    const admin = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic', role: 'ADMIN' } });
    await dispatchShipment(admin.id, f.order.id, { carrier: 'ROYAL_MAIL', carrierName: 'Royal Mail', trackingNumber: null, actualShippingCost: 3.50 });
    assert.equal((await jobFor(f.order.id)).state, 'PENDING'); available = true; now = 30_000; await tick(); await tick();
    assert.equal(capture.messages.length, 1); const mail = await simpleParser(capture.messages[0]); assert.match(mail.text!, /has been dispatched/); assert.doesNotMatch(mail.text!, /We will email/);
    assert.equal(mail.attachments.filter(a => a.contentType === 'application/pdf').length, 1); assert.equal((await jobFor(f.order.id)).state, 'SENT');
    assert.doesNotMatch(warnings.join(''), /private SES credential error/);
  } finally { await new Promise<void>(r => server.close(() => r())); }
});
it('operator can recover an earlier stale-suppressed invoice without creating a second job', async () => {
  const f = await fixture(), job = await confirm(f);
  await prisma.order.update({ where: { id: f.order.id }, data: { status: 'DISPATCHED', dispatchedAt: new Date() } });
  await prisma.orderConfirmationJob.update({ where: { id: job.id }, data: { state: 'SUPPRESSED', lastErrorCode: 'CONFIRMATION_SUPERSEDED_BY_DISPATCH' } });
  await requeueConfirmation(job.id); const capture = captureConfirmationTransport(); await execute(job.id, capture.transport);
  assert.equal(capture.messages.length, 1); assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id, type: 'ORDER_CONFIRMATION' } }), 1);
});

it('legacy dispatch before durable activation preserves the independent invoice delivery obligation', async () => {
  config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = false; let legacyCalls = 0;
  const restore = setDispatchNotificationSenderForTests(async () => { legacyCalls++; });
  try {
    const f = await fixture(), invoiceJob = await confirm(f);
    const admin = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic', role: 'ADMIN' } });
    await dispatchShipment(admin.id, f.order.id, { carrier: 'ROYAL_MAIL', carrierName: 'Royal Mail', trackingNumber: null, actualShippingCost: 3.50 });
    assert.equal(legacyCalls, 1); assert.equal((await jobFor(f.order.id)).state, 'PENDING');
    const capture = captureConfirmationTransport(); await execute(invoiceJob.id, capture.transport); await execute(invoiceJob.id, capture.transport);
    assert.equal(capture.messages.length, 1); assert.equal((await simpleParser(capture.messages[0])).attachments.filter(a => a.contentType === 'application/pdf').length, 1);
    assert.match((await simpleParser(capture.messages[0])).text!, /has been dispatched/);
  } finally { restore(); }
});

for (const [futureOrder, futureDispatch] of [[false, false], [true, false], [false, true], [true, true]]) it(`cutoff readiness isolates workers and retains queued jobs (order future=${futureOrder}, dispatch future=${futureDispatch})`, async () => {
  const { approvedEmailConfiguration, assertEmailStartupReady, createEmailReadinessTick, emailEnabled } = await import('../domain/orderConfirmation/readiness.js');
  const { emailConfigurationLoadedAt } = await import('../config/index.js');
  const saved = [config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM, config.DISPATCH_CONFIRMATION_EMAIL_ACTIVE_FROM, config.ORDER_CONFIRMATION_BUSINESS_JSON];
  const savedOrderFlag = config.ORDER_CONFIRMATION_EMAIL_ENABLED;
  const f = await fixture(), orderJob = await confirm(f);
  const admin = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic', role: 'ADMIN' } });
  await dispatchShipment(admin.id, f.order.id, { carrier: 'ROYAL_MAIL', carrierName: 'Royal Mail', trackingNumber: null, actualShippingCost: 3.50 });
  const dispatchJob = await prisma.orderConfirmationJob.findFirstOrThrow({ where: { orderId: f.order.id, type: 'DISPATCH_CONFIRMATION' } });
  const past = new Date(emailConfigurationLoadedAt - 1000).toISOString(), future = new Date(emailConfigurationLoadedAt + 3_600_000).toISOString();
  const server = createServer(app); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  let now = 0; const warnings: string[] = [], capture = captureConfirmationTransport(), providerChecks = [0, 0];
  try {
    config.ORDER_CONFIRMATION_EMAIL_ENABLED = true; config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = true;
    config.ORDER_CONFIRMATION_BUSINESS_JSON = JSON.stringify(businessFixture);
    config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM = futureOrder ? future : past;
    config.DISPATCH_CONFIRMATION_EMAIL_ACTIVE_FROM = futureDispatch ? future : past;
    await assertEmailStartupReady();
    const ticks = (['ORDER_CONFIRMATION', 'DISPATCH_CONFIRMATION'] as const).map((type, i) => createEmailReadinessTick({
      enabled: () => emailEnabled(type), now: () => now, warn: s => warnings.push(s),
      probe: async () => { approvedEmailConfiguration(type); providerChecks[i]++; },
      run: () => runConfirmationBatch({ jobId: i ? dispatchJob.id : orderJob.id, transport: capture.transport, business: businessFixture, types: [type] }),
    }));
    await Promise.all(ticks.map(tick => tick()));
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status, 200);
    assert.equal(capture.messages.length, Number(!futureOrder) + Number(!futureDispatch));
    for (const [i, invalid] of [futureOrder, futureDispatch].entries()) {
      const before = i ? dispatchJob : orderJob;
      const after = await prisma.orderConfirmationJob.findUniqueOrThrow({ where: { id: before.id } });
      if (invalid) assert.deepEqual(after, before, 'paused jobs must remain entirely unclaimed and unchanged');
      else assert.equal(after.state, 'SENT');
      assert.equal(providerChecks[i], invalid ? 0 : 1);
    }
    if (futureOrder) assert.ok(warnings.some(s => s.includes('ORDER_CONFIRMATION') && s.includes('restart')));
    if (futureDispatch) assert.ok(warnings.some(s => s.includes('DISPATCH_CONFIRMATION') && s.includes('restart')));
    assert.ok(warnings.every(s => !s.includes(future) && !s.includes('example.test')));
    // A real process requires a corrected configuration + restart. Test-only mutation
    // models the corrected snapshot and proves readiness must run before recovery.
    config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM = past; config.DISPATCH_CONFIRMATION_EMAIL_ACTIVE_FROM = past;
    now = 30_000; await Promise.all(ticks.map(tick => tick())); await Promise.all(ticks.map(tick => tick()));
    assert.equal(capture.messages.length, 2); assert.equal((await jobFor(f.order.id)).state, 'SENT');
    assert.equal((await prisma.orderConfirmationJob.findUniqueOrThrow({ where: { id: dispatchJob.id } })).state, 'SENT');
  } finally {
    [config.ORDER_CONFIRMATION_EMAIL_ACTIVE_FROM, config.DISPATCH_CONFIRMATION_EMAIL_ACTIVE_FROM, config.ORDER_CONFIRMATION_BUSINESS_JSON] = saved;
    config.ORDER_CONFIRMATION_EMAIL_ENABLED = savedOrderFlag;
    await new Promise<void>(r => server.close(() => r()));
  }
});
