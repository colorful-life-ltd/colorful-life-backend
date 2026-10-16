import { Prisma } from "../generated/prisma-client/client.js";
import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { simpleParser } from 'mailparser';
import { config } from '../config/index.js';
import { prisma } from '../prisma/runtime.js';
import { createOrder } from '../domain/orders/orderService.js';
import { confirmOrder } from '../domain/orders/orderConfirmationService.js';
import { dispatchShipment, dispatchLegacyOrder } from '../domain/fulfilment/fulfilmentService.js';
import { enqueueDispatchConfirmation } from '../domain/orderConfirmation/dispatch.js';
import { runConfirmationBatch } from '../domain/orderConfirmation/worker.js';
import { captureConfirmationTransport, DeliveryRejected, classifySesError, type ConfirmationTransport } from '../domain/orderConfirmation/delivery.js';
import { recordVerifiedPayment } from './fixtures/verifiedPayment.js';
import { setDispatchNotificationSenderForTests } from '../services/emailService.js';
import { notifyLegacyDispatch } from '../domain/orderConfirmation/legacyDispatch.js';
import { createEmailReadinessTick, emailEnabled } from '../domain/orderConfirmation/readiness.js';
import { businessFixture } from './fixtures/orderConfirmation.fixture.js';
const originalDispatchActivation = config.DISPATCH_CONFIRMATION_EMAIL_ENABLED;
beforeEach(() => { config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = true; });
afterEach(() => { config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = originalDispatchActivation; });

const original = config.PAYMENT_RESOLUTION_ENABLED;
beforeEach(() => { config.PAYMENT_RESOLUTION_ENABLED = false; }); afterEach(() => { config.PAYMENT_RESOLUTION_ENABLED = original; });
after(() => prisma.$disconnect());
const input = { carrier: 'ROYAL_MAIL' as const, carrierName: 'Royal Mail', trackingNumber: 'AB123456789GB', actualShippingCost: 3.50 };
async function fixture() {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, firstName: 'Synthetic Buyer', passwordHash: 'synthetic', emailVerified: true,
    addresses: { create: { recipientName: 'Synthetic Buyer', line1: '1 Fictional Road', city: 'Testville', postcode: 'T1', countryCode: 'GB', isDefaultBilling: true } } } });
  const admin = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic', role: 'ADMIN', emailVerified: true } });
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: 'Synthetic dispatch item', theme: 'TEST', ageRecommendation: '8+', pieceCount: 10 } });
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: 'NEW', originalPrice: 10, currentStock: 3 } });
  const order = await createOrder(user.id, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 1 }] });
  await recordVerifiedPayment(order.id); await confirmOrder(admin.id, order.id);
  return { user, admin, listing, order };
}
const jobFor = (orderId: number) => prisma.orderConfirmationJob.findFirstOrThrow({ where: { orderId, type: 'DISPATCH_CONFIRMATION' } });
const run = (id: string, transport: ConfirmationTransport, business: unknown = businessFixture) => runConfirmationBatch({ jobId: id, transport, business });
async function due(id: string) { await prisma.orderConfirmationJob.update({ where: { id }, data: { nextAttemptAt: new Date(0) } }); }
it('a committed dispatch captures persisted shipment identity and sends without invoice or shipping fabrication', async () => {
  const f = await fixture();
  // Historical dispatches may have no checkout delivery offer. Do not fabricate estimates.
  await prisma.order.update({ where: { id: f.order.id }, data: { confirmationDeliverySnapshot: Prisma.DbNull } });
  await dispatchShipment(f.admin.id, f.order.id, input);
  const job = await jobFor(f.order.id), shipment = await prisma.shipment.findUniqueOrThrow({ where: { id: job.shipmentId! } }), capture = captureConfirmationTransport();
  assert.equal(job.eventKey, `shipment:${shipment.id}`); assert.equal(job.state, 'PENDING');
  assert.equal((job.source as Record<string, unknown>).dispatchedAt, shipment.dispatchedAt.toISOString());
  await run(job.id, capture.transport); const mail = await simpleParser(capture.messages[0]);
  assert.ok(mail.text?.includes('Royal Mail')); assert.ok(mail.text?.includes('AB123456789GB')); assert.ok(!mail.text?.includes('Estimated'));
  assert.equal(mail.attachments.filter(a => a.contentType === 'application/pdf').length, 0);
  assert.equal(await prisma.commercialInvoice.count({ where: { orderId: f.order.id } }), 0);
  const stock = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } }); assert.equal(stock.currentStock, 2); assert.equal(stock.reservedStock, 0);
});
it('dispatch rollback removes its shipment, audit event and outbox task atomically', async () => {
  const f = await fixture();
  await assert.rejects(prisma.$transaction(async tx => { await dispatchLegacyOrder(tx, f.admin.id, f.order.id, input); throw new Error('injected dispatch rollback'); }), /injected/);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'CONFIRMED');
  assert.equal(await prisma.shipment.count({ where: { orderId: f.order.id } }), 0); assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 0);
  assert.equal(await prisma.orderFulfilmentEvent.count({ where: { orderId: f.order.id } }), 0);
});
it('duplicate and concurrent requests produce one shipment, event, task and delivery', async () => {
  const f = await fixture(); await Promise.all(Array.from({ length: 4 }, () => dispatchShipment(f.admin.id, f.order.id, input)));
  const job = await jobFor(f.order.id), capture = captureConfirmationTransport();
  await prisma.$transaction(tx => enqueueDispatchConfirmation(tx, job.shipmentId!));
  await Promise.all(Array.from({ length: 4 }, () => run(job.id, capture.transport)));
  assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 1);
  assert.equal(await prisma.shipment.count({ where: { orderId: f.order.id } }), 1); assert.equal(await prisma.orderFulfilmentEvent.count({ where: { orderId: f.order.id, action: 'DISPATCHED' } }), 1); assert.equal(capture.messages.length, 1);
  await assert.rejects(dispatchShipment(f.admin.id, f.order.id, { ...input, trackingNumber: 'CD123456789GB' }));
});
it('missing tracking remains deliverable without invented tracking information', async () => {
  const f = await fixture(); await dispatchShipment(f.admin.id, f.order.id, { ...input, trackingNumber: null });
  const job = await jobFor(f.order.id), capture = captureConfirmationTransport(); await run(job.id, capture.transport);
  const mail = await simpleParser(capture.messages[0]); assert.ok(mail.text?.includes('Tracking information is not currently available'));
});
it('dispatch provider rejection retries the same immutable shipment and approved branding without undoing dispatch', async () => {
  const f = await fixture(); await dispatchShipment(f.admin.id, f.order.id, input); const job = await jobFor(f.order.id);
  await run(job.id, { kind: 'capture', async send() { throw new DeliveryRejected(true, 'THROTTLED'); } });
  const first = await jobFor(f.order.id); assert.equal(first.state, 'RETRY'); assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'DISPATCHED');
  await assert.rejects(prisma.orderConfirmationJob.update({ where: { id: job.id }, data: { source: {} } }));
  await assert.rejects(prisma.orderConfirmationJob.update({ where: { id: job.id }, data: { brandSnapshot: {} } }));
  await due(job.id); const capture = captureConfirmationTransport(); await run(job.id, capture.transport, { ...businessFixture, registrationNumber: 'CHANGED' });
  assert.equal(capture.messages.length, 1); assert.deepEqual((await jobFor(f.order.id)).brandSnapshot, first.brandSnapshot);
});
for (const error of [{ name: 'CredentialsProviderError' }, { code: 'ECONNREFUSED' }]) it('proven pre-send failure remains safely retryable in the shared worker', async () => {
  const f = await fixture(); await dispatchShipment(f.admin.id, f.order.id, input); const job = await jobFor(f.order.id);
  await run(job.id, { kind: 'capture', async send() { throw classifySesError(error); } });
  assert.equal((await jobFor(f.order.id)).state, 'RETRY');
});
it('ambiguous dispatch acceptance is UNKNOWN and is not automatically resent', async () => {
  const f = await fixture(); await dispatchShipment(f.admin.id, f.order.id, input); const job = await jobFor(f.order.id); let calls = 0;
  await run(job.id, { kind: 'capture', async send() { calls++; throw new Error('lost acknowledgement'); } });
  await due(job.id); await run(job.id, captureConfirmationTransport().transport);
  assert.equal((await jobFor(f.order.id)).state, 'UNKNOWN'); assert.equal(calls, 1);
});
it('deleted accounts suppress dispatch while retaining prior accounting data', async () => {
  const f = await fixture(); await dispatchShipment(f.admin.id, f.order.id, input); const job = await jobFor(f.order.id);
  await prisma.user.update({ where: { id: f.user.id }, data: { deletedAt: new Date(), email: `${randomUUID()}@example.test` } });
  const capture = captureConfirmationTransport(); await run(job.id, capture.transport);
  assert.equal(capture.messages.length, 0); assert.equal((await jobFor(f.order.id)).lastErrorCode, 'ACCOUNT_DELETED');
});
it('dispatch for an already deleted account creates a suppressed task rather than addressing its old mailbox', async () => {
  const f = await fixture(); await prisma.user.update({ where: { id: f.user.id }, data: { deletedAt: new Date() } });
  await dispatchShipment(f.admin.id, f.order.id, input); const job = await jobFor(f.order.id);
  assert.equal(job.state, 'SUPPRESSED'); assert.equal(job.lastErrorCode, 'ACCOUNT_DELETED');
});
for (const status of ['COMPLETED', 'RETURNED', 'CANCELLED'] as const) it(`suppresses an obsolete dispatch notification after ${status}`, async () => {
  const f = await fixture(); await dispatchShipment(f.admin.id, f.order.id, input); const job = await jobFor(f.order.id);
  await prisma.order.update({ where: { id: f.order.id }, data: { status } }); const capture = captureConfirmationTransport(); await run(job.id, capture.transport);
  assert.equal(capture.messages.length, 0); assert.equal((await jobFor(f.order.id)).lastErrorCode, 'DISPATCH_SUPERSEDED_BY_ORDER_STATE');
});
it('changed persisted tracking data suppresses stale snapshots instead of emailing old tracking', async () => {
  const f = await fixture(); await dispatchShipment(f.admin.id, f.order.id, input); const job = await jobFor(f.order.id);
  await prisma.shipment.update({ where: { id: job.shipmentId! }, data: { trackingNumber: 'CD123456789GB' } });
  const capture = captureConfirmationTransport(); await run(job.id, capture.transport);
  assert.equal(capture.messages.length, 0); assert.equal((await jobFor(f.order.id)).lastErrorCode, 'SHIPMENT_DATA_CHANGED');
});
it('dispatch readiness can block delivery without rolling back committed fulfilment', async () => {
  const f = await fixture(); await dispatchShipment(f.admin.id, f.order.id, input); const job = await jobFor(f.order.id);
  await run(job.id, captureConfirmationTransport().transport, {});
  assert.equal((await jobFor(f.order.id)).state, 'BLOCKED'); assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'DISPATCHED');
});

it('expired preparation claims can recover dispatch without duplicate delivery', async () => {
  const f = await fixture(); await dispatchShipment(f.admin.id, f.order.id, input); const job = await jobFor(f.order.id);
  await prisma.orderConfirmationJob.update({ where: { id: job.id }, data: { state: 'PROCESSING', claimOwner: 'crashed', claimGeneration: 1, leaseExpiresAt: new Date(0), sendStartedAt: null } });
  const capture = captureConfirmationTransport(); await run(job.id, capture.transport); await run(job.id, capture.transport);
  assert.equal(capture.messages.length, 1); assert.equal((await jobFor(f.order.id)).claimGeneration, 2);
});
it('expired possibly-sent dispatch claims are quarantined instead of resent', async () => {
  const f = await fixture(); await dispatchShipment(f.admin.id, f.order.id, input); const job = await jobFor(f.order.id);
  await prisma.orderConfirmationJob.update({ where: { id: job.id }, data: { state: 'PROCESSING', claimOwner: 'crashed', claimGeneration: 1, leaseExpiresAt: new Date(0), sendStartedAt: new Date() } });
  const capture = captureConfirmationTransport(); await run(job.id, capture.transport);
  assert.equal(capture.messages.length, 0); assert.equal((await jobFor(f.order.id)).state, 'UNKNOWN');
});

it('preserves legacy dispatch before activation, durable delivery after activation, and safe configuration rollback', async () => {
  const sent: number[] = [], restore = setDispatchNotificationSenderForTests(async n => { sent.push(n.orderId); });
  try {
    config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = false;
    const first = await fixture(); await dispatchShipment(first.admin.id, first.order.id, input);
    const legacy = await jobFor(first.order.id); assert.equal(legacy.deliveryRoute, 'LEGACY'); assert.equal(legacy.state, 'SENT');
    assert.deepEqual(sent, [first.order.id]);
    config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = true;
    const second = await fixture(); await dispatchShipment(second.admin.id, second.order.id, input);
    const durable = await jobFor(second.order.id); assert.equal(durable.deliveryRoute, 'DURABLE'); assert.equal(durable.state, 'PENDING');
    await notifyLegacyDispatch(second.order.id); assert.deepEqual(sent, [first.order.id]);
    config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = false;
    const capture = captureConfirmationTransport();
    const tick = createEmailReadinessTick({ enabled: () => emailEnabled('DISPATCH_CONFIRMATION'), probe: async () => {}, run: () => run(durable.id, capture.transport) });
    await tick(); assert.equal(capture.messages.length, 0); assert.equal((await jobFor(second.order.id)).state, 'PENDING');
    const third = await fixture(); await dispatchShipment(third.admin.id, third.order.id, input);
    assert.equal((await jobFor(third.order.id)).deliveryRoute, 'LEGACY'); assert.deepEqual(sent, [first.order.id, third.order.id]);
    config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = true; await tick(); await tick();
    await run(legacy.id, capture.transport); await notifyLegacyDispatch(first.order.id);
    assert.equal(capture.messages.length, 1); assert.deepEqual(sent, [first.order.id, third.order.id]);
    await assert.rejects(prisma.orderConfirmationJob.update({ where: { id: durable.id }, data: { deliveryRoute: 'LEGACY' } }));
  } finally { restore(); }
});
it('concurrent legacy dispatch requests and repeated handoffs produce one best-effort attempt', async () => {
  config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = false;
  let calls = 0; const restore = setDispatchNotificationSenderForTests(async () => { calls++; });
  try {
    const f = await fixture(); await Promise.all(Array.from({ length: 3 }, () => dispatchShipment(f.admin.id, f.order.id, input)));
    await Promise.all(Array.from({ length: 3 }, () => notifyLegacyDispatch(f.order.id)));
    assert.equal(calls, 1); assert.equal((await jobFor(f.order.id)).attempts, 1);
  } finally { restore(); }
});
it('legacy acceptance uncertainty never falls back into durable delivery on activation', async () => {
  config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = false;
  const restore = setDispatchNotificationSenderForTests(async () => { throw new Error('acceptance uncertain'); });
  try {
    const f = await fixture(); await dispatchShipment(f.admin.id, f.order.id, input); const job = await jobFor(f.order.id);
    assert.equal(job.state, 'UNKNOWN'); config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = true;
    const capture = captureConfirmationTransport(); await run(job.id, capture.transport); assert.equal(capture.messages.length, 0);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'DISPATCHED');
  } finally { restore(); }
});
it('dispatch recipient remains the verified snapshot after an email change, unless the account is deleted', async () => {
  const f = await fixture(); await dispatchShipment(f.admin.id, f.order.id, input); const job = await jobFor(f.order.id);
  await prisma.user.update({ where: { id: f.user.id }, data: { email: `${randomUUID()}@example.test`, emailVerified: false } });
  const capture = captureConfirmationTransport(); await run(job.id, capture.transport);
  const mail = await simpleParser(capture.messages[0]); assert.equal(mail.to && 'value' in mail.to ? mail.to.value[0].address : null, f.user.email);
});

it('legacy post-commit handoff uses its recorded recipient, and deletion still suppresses it', async () => {
  config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = false;
  const sent: string[] = [], restore = setDispatchNotificationSenderForTests(async n => { sent.push(n.customerEmail); });
  try {
    for (const deleted of [false, true]) {
      const f = await fixture(); await prisma.$transaction(tx => dispatchLegacyOrder(tx, f.admin.id, f.order.id, input));
      await prisma.user.update({ where: { id: f.user.id }, data: { email: `${randomUUID()}@example.test`, ...(deleted ? { deletedAt: new Date() } : {}) } });
      await notifyLegacyDispatch(f.order.id);
      assert.equal((await jobFor(f.order.id)).state, deleted ? 'SUPPRESSED' : 'SENT');
      if (!deleted) assert.deepEqual(sent, [f.user.email]);
    }
    assert.equal(sent.length, 1);
  } finally { restore(); }
});
it('independent flags allow order email activation without migrating dispatch routing', async () => {
  const previous = config.ORDER_CONFIRMATION_EMAIL_ENABLED, restore = setDispatchNotificationSenderForTests(async () => {});
  try {
    config.ORDER_CONFIRMATION_EMAIL_ENABLED = true; config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = false;
    const f = await fixture(); await dispatchShipment(f.admin.id, f.order.id, input);
    assert.equal((await jobFor(f.order.id)).deliveryRoute, 'LEGACY'); assert.equal(emailEnabled('ORDER_CONFIRMATION'), true);
    config.ORDER_CONFIRMATION_EMAIL_ENABLED = false; config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = true;
    assert.equal(emailEnabled('DISPATCH_CONFIRMATION'), true); assert.equal(emailEnabled('ORDER_CONFIRMATION'), false);
  } finally { config.ORDER_CONFIRMATION_EMAIL_ENABLED = previous; restore(); }
});
