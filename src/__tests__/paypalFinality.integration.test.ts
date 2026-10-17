import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, beforeEach, it } from 'node:test';
import { config } from '../config/index.js';
import { prisma } from '../prisma/runtime.js';
import { initializePaymentResolution, databaseNow, PaymentResolutionUnavailableError, PaymentAdmissionClosedError } from '../domain/payments/paymentResolutionService.js';
import { capturePayPalOrder, PayPalCaptureProviderError, PayPalFundingDeclinedError } from '../domain/payments/paypalCaptureService.js';
import { createOrReusePayPalOrder } from '../domain/payments/paypalOrderService.js';
import { resolvePayPalPaymentOutcome, setPayPalResolutionClientForTests, type PayPalResolutionOrder } from '../domain/payments/paypalResolutionService.js';
import { reconcilePayPalWebhookEvent } from '../domain/payments/paypalReconciliationService.js';
import { classifyPayPalCapture } from '../domain/payments/paypalFinality.js';
import { abandonPaymentReservation } from '../domain/payments/stripeResolutionService.js';
import { expireOrderReservation } from '../domain/orders/orderExpiryService.js';
import { cancelOrder } from '../domain/orders/orderCancellationService.js';
import { OrderCancellationPaymentError } from '../domain/orders/orderCancellationErrors.js';
import { runConfirmationBatch } from '../domain/orderConfirmation/worker.js';
import { captureConfirmationTransport } from '../domain/orderConfirmation/delivery.js';
import { businessFixture } from './fixtures/orderConfirmation.fixture.js';

const previous = config.PAYMENT_RESOLUTION_ENABLED;
beforeEach(() => { config.PAYMENT_RESOLUTION_ENABLED = true; });
afterEach(() => { config.PAYMENT_RESOLUTION_ENABLED = previous; });
after(async () => { await prisma.$disconnect(); });
function gate() { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; }
async function fixture(age = 0, dispatched = false, unbound = false) {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@pp2.test`, passwordHash: 'synthetic', emailVerified: true } });
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: 'Synthetic PP2 purchase', theme: 'PP2', ageRecommendation: '8+', pieceCount: 10 } });
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: 'NEW', originalPrice: 10, currentStock: 5, reservedStock: 2 } });
  const at = new Date((await prisma.$transaction(databaseNow)).getTime() - age * 60_000);
  const order = await prisma.$transaction(async tx => {
    const o = await tx.order.create({ data: { userId: user.id, totalAmount: '23.99', createdAt: at, reservationExpiresAt: new Date(at.getTime()+1800000),
      billingRecipientName: 'Synthetic Buyer', billingLine1: '1 Fictional Street', billingCity: 'Testville', billingPostcode: 'T1', billingCountryCode: 'GB',
      deliveryRecipientName: 'Synthetic Buyer', deliveryLine1: '1 Fictional Street', deliveryCity: 'Testville', deliveryPostcode: 'T1', deliveryCountryCode: 'GB',
      confirmationDeliverySnapshot: { method: 'Standard Delivery', chargePence: 399, minWorkingDays: 3, maxWorkingDays: 5, estimatesFrom: 'DISPATCH' },
      orderItems: { create: { productListingId: listing.id, quantity: 2, unitPrice: 10, lineTotal: 20, invoiceDescriptionSnapshot: 'Synthetic PP2 purchase' } } } });
    await initializePaymentResolution(tx, o); return o;
  });
  const key = randomUUID(), reference = unbound ? `pending:${key}` : `PP-${randomUUID()}`;
  const payment = await prisma.payment.create({ data: { orderId: order.id, provider: 'PAYPAL', amount: order.totalAmount, currency: 'GBP', providerReference: reference, idempotencyKey: key, status: 'PROCESSING' } });
  const attempt = await prisma.paymentAttempt.create({ data: { orderId: order.id, paymentId: payment.id, provider: 'PAYPAL', amount: order.totalAmount, currency: 'GBP', providerReference: unbound ? null : reference, creationKey: key, admittedAt: at } });
  const resolution = await prisma.paymentResolution.findUniqueOrThrow({ where: { orderId: order.id } });
  for (const type of dispatched ? ['CREATE', 'CAPTURE'] as const : ['CREATE'] as const) {
    const operation = await prisma.paymentOperation.create({ data: { attemptId: attempt.id, type, operationKey: randomUUID(), requestHash: 'a'.repeat(64), admittedAt: at, admissionDeadline: resolution.initialPaymentDeadline } });
    await prisma.paymentOperation.update({ where: { id: operation.id }, data: { state: 'POTENTIALLY_DISPATCHED', executionCount: 1 } });
    if (type === 'CAPTURE') await prisma.payment.update({ where: { id: payment.id }, data: { captureIdempotencyKey: operation.operationKey } });
  }
  return { user, listing, order, payment, attempt, captureId: `CAP-${randomUUID()}` };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function remote(f: Fixture, status = 'COMPLETED'): PayPalResolutionOrder {
  return { id: f.payment.providerReference, intent: 'CAPTURE', status: status === 'COMPLETED' ? 'COMPLETED' : 'APPROVED', purchase_units: [{ amount: { value: '23.99', currency_code: 'GBP' }, payments: { captures: [{ id: f.captureId, status, amount: { value: '23.99', currency_code: 'GBP' } }] } }] };
}
const provider = (value: PayPalResolutionOrder) => ({ retrieveOrder: async () => value });
const event = (f: Fixture, eventType = 'PAYMENT.CAPTURE.COMPLETED') => ({ id: randomUUID(), eventType, paypalOrderId: f.payment.providerReference, captureId: f.captureId, amount: '23.99', currency: 'GBP' });
async function stock(f: Fixture, reserved: number, current = 5, sales = 0) {
  const s = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } }); assert.equal(s.reservedStock, reserved); assert.equal(s.currentStock, current);
  assert.equal(await prisma.inventoryMovement.count({ where: { listingId: s.id, type: 'WEBSITE_SALE' } }), sales);
}
async function close(f: Fixture) {
  await prisma.paymentResolution.update({ where: { orderId: f.order.id }, data: { state: 'CLOSED_RESOLVING', paymentAdmissionClosedAt: await prisma.$transaction(databaseNow), closureReason: 'CUSTOMER_ABANDONED' } });
}
async function assertReleased(f: Fixture, status = 'EXPIRED') {
  await stock(f, 0);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, status);
  assert.equal((await prisma.paymentResolution.findUniqueOrThrow({ where: { orderId: f.order.id } })).reservationDisposition, 'RELEASED');
  assert.equal(await prisma.reservationReleaseProof.count({ where: { orderId: f.order.id } }), 1);
  assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 0);
}
it('classifies only completed, pending and explicit declined captures; unsupported statuses stay UNKNOWN', () => {
  for (const [s, expected] of [['COMPLETED','COMPLETED'], ['PENDING','PENDING'], ['DECLINED','DEFINITIVELY_DECLINED'], ['DENIED','UNKNOWN'], ['FAILED','UNKNOWN'], ['APPROVED','UNKNOWN']]) assert.equal(classifyPayPalCapture(s), expected);
});
it('abandoned bound order with no capture closes admission and releases exactly once without provider I/O', async () => {
  const f = await fixture(31); const p = { retrieveOrder: async () => { assert.fail('no capture requires no provider call'); } };
  await Promise.all(Array.from({ length: 5 }, () => resolvePayPalPaymentOutcome(f.order.id, p)));
  await assertReleased(f);
  const evidence = await prisma.financialEvidence.findFirstOrThrow({ where: { orderId: f.order.id, kind: 'TERMINAL_UNPAID' } });
  assert.equal((evidence.normalized as { outcome: string }).outcome, 'NOT_DISPATCHED');
  await assert.rejects(capturePayPalOrder(f.order.id, f.user.id, { captureOrder: async () => { assert.fail('closed capture'); } }));
});
it('customer abandonment establishes no-dispatch finality before cancellation and release', async () => {
  const f = await fixture(); const restore = setPayPalResolutionClientForTests({ retrieveOrder: async () => { assert.fail('unexpected provider query'); } });
  try { await abandonPaymentReservation(f.order.id, f.user.id); await assertReleased(f, 'CANCELLED'); } finally { restore(); }
});
it('an unbound create response is incomplete coverage, never presumed financially final', async () => {
  const f = await fixture(31, false, true);
  await resolvePayPalPaymentOutcome(f.order.id, { retrieveOrder: async () => { assert.fail('cannot retrieve a pending identity'); } });
  await stock(f, 2); assert.equal(await prisma.reservationReleaseProof.count({ where: { orderId: f.order.id } }), 0);
});
for (const status of ['PENDING','DENIED','FAILED','MYSTERY','EMPTY','TIMEOUT'] as const) it(`${status} after dispatched capture retains stock and permanently closes elapsed admission`, async () => {
  const f = await fixture(31, true), value = remote(f, status);
  if (status === 'EMPTY') value.purchase_units = [{ amount: { value: '23.99', currency_code: 'GBP' } }];
  await resolvePayPalPaymentOutcome(f.order.id, { retrieveOrder: async () => { if (status === 'TIMEOUT') throw Error('synthetic timeout'); return value; } });
  await stock(f, 2); assert.equal(await expireOrderReservation(f.order.id), null);
  assert.equal(await prisma.reservationReleaseProof.count({ where: { orderId: f.order.id } }), 0);
  assert.ok((await prisma.paymentResolution.findUniqueOrThrow({ where: { orderId: f.order.id } })).paymentAdmissionClosedAt);
  await assert.rejects(capturePayPalOrder(f.order.id, f.user.id, { captureOrder: async () => { assert.fail('capture after closure'); } }), PaymentAdmissionClosedError);
});
it('expired definite decline obtains terminal evidence for every permission and releases once', async () => {
  const f = await fixture(31, true); const p = provider(remote(f, 'DECLINED'));
  await Promise.all([resolvePayPalPaymentOutcome(f.order.id, p), resolvePayPalPaymentOutcome(f.order.id, p), expireOrderReservation(f.order.id)]);
  await resolvePayPalPaymentOutcome(f.order.id, p); await assertReleased(f);
  assert.equal(await prisma.paymentOperation.count({ where: { attemptId: f.attempt.id, state: { not: 'RESULT_RECORDED' } } }), 0);
  assert.ok((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).finalityEvidenceId);
});
it('definitive decline requires a fresh provider check, then a distinct order, attempt and capture key for retry', async () => {
  const f = await fixture(); let calls = 0;
  await assert.rejects(capturePayPalOrder(f.order.id, f.user.id, { captureOrder: async () => { calls++; return remote(f, 'DECLINED'); } }), PayPalCaptureProviderError);
  await assert.rejects(capturePayPalOrder(f.order.id, f.user.id, { captureOrder: async () => { calls++; return remote(f); } }), PaymentResolutionUnavailableError);
  assert.equal(calls, 1); await stock(f, 2);
  const before = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  await resolvePayPalPaymentOutcome(f.order.id, provider(remote(f, 'DECLINED')));
  const r = await prisma.paymentResolution.findUniqueOrThrow({ where: { orderId: f.order.id } }); assert.ok(r.retryDeadline); assert.equal(r.retryDeadline!.getTime()-r.firstFailureVerifiedAt!.getTime(), 1800000);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'CANCELED');
  const nextId = `PP-${randomUUID()}`; let creates = 0;
  await createOrReusePayPalOrder(f.order.id, f.user.id, { createOrder: async (_input, key) => { creates++; assert.notEqual(key, f.payment.idempotencyKey); return { id: nextId }; } });
  assert.equal(creates, 1); assert.equal(await prisma.paymentAttempt.count({ where: { orderId: f.order.id } }), 2);
  const result = remote(f); result.id = nextId; result.purchase_units![0].payments!.captures![0].id = `CAP-${randomUUID()}`;
  await capturePayPalOrder(f.order.id, f.user.id, { captureOrder: async (_id, key) => { assert.notEqual(key, before.captureIdempotencyKey); return result; } });
  await stock(f, 0, 3, 1); assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'CONFIRMED');
  const job = await prisma.orderConfirmationJob.findUniqueOrThrow({ where: { eventKey: `order:${f.order.id}` } }); const capture = captureConfirmationTransport();
  await runConfirmationBatch({ jobId: job.id, transport: capture.transport, business: businessFixture }); assert.equal(capture.messages.length, 1);
  assert.equal(await prisma.commercialInvoice.count({ where: { orderId: f.order.id } }), 1);
});
it('HTTP funding rejection is distinct from timeout; exact approved empty GET plus durable rejection allows retirement', async () => {
  const f = await fixture();
  await assert.rejects(capturePayPalOrder(f.order.id, f.user.id, { captureOrder: async () => { throw new PayPalFundingDeclinedError('synthetic funding decline'); } }), PayPalFundingDeclinedError);
  const value = remote(f); value.status = 'APPROVED'; value.purchase_units![0].payments = undefined;
  await resolvePayPalPaymentOutcome(f.order.id, provider(value));
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'CANCELED'); await stock(f, 2);
  assert.ok((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).finalityEvidenceId);
});
it('capture vs abandonment/expiry retains stock until delayed COMPLETED confirms through PP-1', async () => {
  const f = await fixture(), entered = gate(), release = gate();
  const capture = capturePayPalOrder(f.order.id, f.user.id, { captureOrder: async () => { entered.release(); await release.promise; return remote(f); } });
  await entered.promise;
  const empty = remote(f); empty.purchase_units![0].payments = undefined;
  const restore = setPayPalResolutionClientForTests(provider(empty));
  try {
    await abandonPaymentReservation(f.order.id, f.user.id);
    await assert.rejects(cancelOrder(f.user.id, f.order.id, 'CHANGED_MIND'), OrderCancellationPaymentError);
    assert.equal(await expireOrderReservation(f.order.id), null); await stock(f, 2);
  } finally { restore(); release.release(); await capture; }
  await stock(f, 0, 3, 1); assert.equal(await prisma.reservationReleaseProof.count({ where: { orderId: f.order.id } }), 0);
});
it('UNKNOWN can resolve to COMPLETED after admission closure without releasing paid stock', async () => {
  const f = await fixture(31, true);
  await resolvePayPalPaymentOutcome(f.order.id, { retrieveOrder: async () => { throw Error('synthetic timeout'); } });
  await stock(f, 2); await resolvePayPalPaymentOutcome(f.order.id, provider(remote(f)));
  await resolvePayPalPaymentOutcome(f.order.id, provider(remote(f))); await stock(f, 0, 3, 1);
  assert.equal(await prisma.reservationReleaseProof.count({ where: { orderId: f.order.id } }), 0);
});
it('concurrent workers use one active read lease and a success webhook fences stale decline/release', async () => {
  const f = await fixture(31, true), entered = gate(), release = gate(); let reads = 0;
  const first = resolvePayPalPaymentOutcome(f.order.id, { retrieveOrder: async () => { reads++; entered.release(); await release.promise; return remote(f, 'DECLINED'); } });
  try {
    await entered.promise; await resolvePayPalPaymentOutcome(f.order.id, { retrieveOrder: async () => { reads++; return remote(f, 'DECLINED'); } });
    assert.equal(reads, 1); await reconcilePayPalWebhookEvent(event(f)); assert.equal(await expireOrderReservation(f.order.id), null);
  } finally { release.release(); await first; }
  await stock(f, 0, 3, 1); assert.equal(await prisma.reservationReleaseProof.count({ where: { orderId: f.order.id } }), 0);
});
for (const invalid of ['amount','currency','identity','multiple'] as const) it(`provider ${invalid} mismatch cannot establish finality`, async () => {
  const f = await fixture(31, true), value = remote(f, 'DECLINED'); const cap = value.purchase_units![0].payments!.captures![0];
  if (invalid === 'amount') cap.amount.value = '1.00'; if (invalid === 'currency') cap.amount.currency_code = 'USD';
  if (invalid === 'identity') value.id = 'FOREIGN'; if (invalid === 'multiple') value.purchase_units![0].payments!.captures!.push({ ...cap, id: randomUUID() });
  await resolvePayPalPaymentOutcome(f.order.id, provider(value)); await stock(f, 2);
  assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).finalityEvidenceId, null);
});
it('a processed pending webhook contradicts no-dispatch proof even without a local CAPTURE journal', async () => {
  const f = await fixture(31); await reconcilePayPalWebhookEvent(event(f, 'PAYMENT.CAPTURE.PENDING'));
  await resolvePayPalPaymentOutcome(f.order.id, provider(remote(f, 'PENDING'))); await stock(f, 2);
  assert.equal(await prisma.financialEvidence.count({ where: { orderId: f.order.id, kind: 'TERMINAL_UNPAID' } }), 0);
});
it('unknown outcome cannot become unpaid merely by advancing the window or deleting response data', async () => {
  const f = await fixture(31, true); await resolvePayPalPaymentOutcome(f.order.id, provider({ id: f.payment.providerReference, status: 'VOIDED' }));
  await stock(f, 2); assert.equal(await prisma.reservationReleaseProof.count({ where: { orderId: f.order.id } }), 0);
});
it('stale read lease cannot authorize release after takeover observes PENDING', async () => {
  const f = await fixture(31, true), entered = gate(), release = gate();
  const first = resolvePayPalPaymentOutcome(f.order.id, { retrieveOrder: async () => { entered.release(); await release.promise; return remote(f, 'DECLINED'); } });
  try {
    await entered.promise;
    await prisma.paymentOperation.updateMany({ where: { attemptId: f.attempt.id, type: 'RETRIEVE' }, data: { leaseExpiresAt: new Date(0) } });
    await resolvePayPalPaymentOutcome(f.order.id, provider(remote(f, 'PENDING')));
  } finally { release.release(); await first; }
  await stock(f, 2); assert.equal(await prisma.reservationReleaseProof.count({ where: { orderId: f.order.id } }), 0);
  const op = await prisma.paymentOperation.findFirstOrThrow({ where: { attemptId: f.attempt.id, type: 'RETRIEVE' } }); assert.equal(op.claimGeneration, 2);
  await resolvePayPalPaymentOutcome(f.order.id, provider(remote(f))); await stock(f, 0, 3, 1);
});
it('concurrent fresh retry requests cannot duplicate provider order creation', async () => {
  const f = await fixture(), entered = gate(), release = gate();
  await assert.rejects(capturePayPalOrder(f.order.id, f.user.id, { captureOrder: async () => remote(f, 'DECLINED') }));
  await resolvePayPalPaymentOutcome(f.order.id, provider(remote(f, 'DECLINED')));
  let calls = 0;
  const p = { createOrder: async () => { calls++; entered.release(); await release.promise; return { id: `PP-${randomUUID()}` }; } };
  const first = createOrReusePayPalOrder(f.order.id, f.user.id, p);
  try { await entered.promise; await assert.rejects(createOrReusePayPalOrder(f.order.id, f.user.id, p), PaymentResolutionUnavailableError); }
  finally { release.release(); await first; }
  assert.equal(calls, 1); assert.equal(await prisma.paymentAttempt.count({ where: { orderId: f.order.id } }), 2); await stock(f, 2);
});
for (const kind of ['NOT_DISPATCHED', 'DEFINITIVELY_DECLINED'] as const) it(`database rejects forged ${kind} release coverage for a dispatched capture without verified retrieval`, async () => {
  const f = await fixture(31, true);
  await assert.rejects(prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${f.order.id} FOR UPDATE`;
    const operations = await tx.paymentOperation.findMany({ where: { attemptId: f.attempt.id } }); let id = 0;
    for (const op of operations) {
      const ev = await tx.financialEvidence.create({ data: { orderId: f.order.id, provider: 'PAYPAL', operationId: op.id, evidenceKey: randomUUID(), kind: 'TERMINAL_UNPAID', verifiedAt: await databaseNow(tx),
        normalized: { providerReference: f.payment.providerReference, providerCaptureReference: f.captureId, amount: '23.99', currency: 'GBP', outcome: kind } } });
      id = ev.id; await tx.paymentOperation.update({ where: { id: op.id }, data: { state: 'RESULT_RECORDED', evidenceId: id } });
    }
    await tx.paymentAttempt.update({ where: { id: f.attempt.id }, data: { finalityEvidenceId: id, providerCaptureReference: f.captureId } });
    await tx.paymentResolution.update({ where: { orderId: f.order.id }, data: { state: 'CLOSED_RESOLVING', paymentAdmissionClosedAt: await databaseNow(tx), closureReason: 'WINDOW_EXPIRED' } });
    const { releaseManagedReservation } = await import('../domain/payments/paymentResolutionService.js');
    await releaseManagedReservation(tx, f.order.id);
  }), error => String(error).includes('23514'));
  await stock(f, 2); assert.equal(await prisma.reservationReleaseProof.count({ where: { orderId: f.order.id } }), 0);
});
it('database rejects a second capture permission for the same PayPal attempt', async () => {
  const f = await fixture(0, true), r = await prisma.paymentResolution.findUniqueOrThrow({ where: { orderId: f.order.id } });
  await assert.rejects(prisma.paymentOperation.create({ data: { attemptId: f.attempt.id, type: 'CAPTURE', operationKey: randomUUID(), requestHash: 'b'.repeat(64), admittedAt: new Date(), admissionDeadline: r.initialPaymentDeadline } }), error => String(error).includes('23514'));
  assert.equal(await prisma.paymentOperation.count({ where: { attemptId: f.attempt.id, type: 'CAPTURE' } }), 1);
});
it('expired retry deadline permanently fences another order or capture, then releases verified unpaid stock', async () => {
  const f = await fixture(61, true), op = await prisma.paymentOperation.findFirstOrThrow({ where: { attemptId: f.attempt.id, type: 'CAPTURE' } });
  const verifiedAt = new Date((await prisma.$transaction(databaseNow)).getTime()-31*60_000);
  const failure = await prisma.financialEvidence.create({ data: { orderId: f.order.id, provider: 'PAYPAL', operationId: op.id, evidenceKey: randomUUID(), kind: 'FAILURE', verifiedAt,
    normalized: { providerReference: f.payment.providerReference, amount: '23.99', currency: 'GBP' } } });
  await prisma.paymentOperation.update({ where: { id: op.id }, data: { state: 'RESULT_RECORDED', evidenceId: failure.id } });
  await prisma.paymentResolution.update({ where: { orderId: f.order.id }, data: { state: 'RETRY_OPEN', firstFailureVerifiedAt: verifiedAt, retryDeadline: new Date(verifiedAt.getTime()+1800000), firstFailureEvidenceId: failure.id, firstFailureOperationId: op.id } });
  await assert.rejects(createOrReusePayPalOrder(f.order.id, f.user.id, { createOrder: async () => { assert.fail('expired retry'); } }), PaymentAdmissionClosedError);
  await resolvePayPalPaymentOutcome(f.order.id, provider(remote(f, 'DECLINED'))); await assertReleased(f);
});
for (const status of [422,500] as const) it(`real capture adapter classifies HTTP ${status} funding body without making an external request`, async t => {
  const originalFetch = globalThis.fetch;
  const originalPayPal = { PAYPAL_CLIENT_ID: config.PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET: config.PAYPAL_CLIENT_SECRET, PAYPAL_BASE_URL: config.PAYPAL_BASE_URL };
  t.after(() => { globalThis.fetch = originalFetch; Object.assign(config, originalPayPal); });
  Object.assign(config, { PAYPAL_CLIENT_ID: 'pp2-synthetic-client', PAYPAL_CLIENT_SECRET: 'pp2-synthetic-secret', PAYPAL_BASE_URL: 'https://paypal-pp2.invalid' });
  const f = await fixture(); let calls = 0;
  globalThis.fetch = async (input) => {
    calls++; const url = String(input);
    assert.ok(url.startsWith('https://paypal-pp2.invalid/'));
    return url.includes('/oauth2/token') ? new Response(JSON.stringify({ access_token: 'synthetic-token' }), { status: 200 })
      : new Response(JSON.stringify({ details: [{ issue: 'INSTRUMENT_DECLINED' }] }), { status });
  };
  await assert.rejects(capturePayPalOrder(f.order.id, f.user.id), status === 422 ? PayPalFundingDeclinedError : PayPalCaptureProviderError);
  assert.equal(calls, 2);
  assert.equal(await prisma.financialEvidence.count({ where: { orderId: f.order.id, normalized: { path: ['declineCode'], equals: 'INSTRUMENT_DECLINED' } } }), status === 422 ? 1 : 0);
  await stock(f, 2);
});
it('stock release rollback retains verified finality for a later safe local retry', async () => {
  const f = await fixture(31, true);
  await prisma.productListing.update({ where: { id: f.listing.id }, data: { reservedStock: 1 } });
  await resolvePayPalPaymentOutcome(f.order.id, provider(remote(f, 'DECLINED')));
  assert.ok((await prisma.paymentAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).finalityEvidenceId);
  assert.equal(await prisma.reservationReleaseProof.count({ where: { orderId: f.order.id } }), 0); await stock(f, 1);
  await prisma.productListing.update({ where: { id: f.listing.id }, data: { reservedStock: 2 } });
  await resolvePayPalPaymentOutcome(f.order.id, { retrieveOrder: async () => { assert.fail('finality is already durable'); } });
  await assertReleased(f);
});
it('a capture binding without matching journal is incomplete coverage, not no-dispatch authority', async () => {
  const f = await fixture(31);
  await prisma.payment.update({ where: { id: f.payment.id }, data: { providerCaptureReference: f.captureId } });
  await resolvePayPalPaymentOutcome(f.order.id, provider(remote(f, 'PENDING'))); await stock(f, 2);
  assert.equal(await prisma.financialEvidence.count({ where: { orderId: f.order.id, kind: 'TERMINAL_UNPAID' } }), 0);
});
it('database capture admission rereads closure after a real Order-lock wait', { timeout: 15000 }, async () => {
  const f = await fixture(), entered = gate(), release = gate(); let holderPid = 0;
  const r = await prisma.paymentResolution.findUniqueOrThrow({ where: { orderId: f.order.id } });
  const holder = prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${f.order.id} FOR UPDATE`;
    const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; holderPid = row.pid;
    entered.release(); await release.promise;
    await tx.paymentResolution.update({ where: { orderId: f.order.id }, data: { state: 'CLOSED_RESOLVING', paymentAdmissionClosedAt: await databaseNow(tx), closureReason: 'CUSTOMER_ABANDONED' } });
  }, { timeout: 10000 });
  await entered.promise;
  const rejected = assert.rejects(prisma.paymentOperation.create({ data: { attemptId: f.attempt.id, type: 'CAPTURE', operationKey: randomUUID(), requestHash: 'c'.repeat(64), admittedAt: new Date(), admissionDeadline: r.initialPaymentDeadline } }), error => String(error).includes('23514'));
  try {
    const deadline = Date.now()+5000;
    while (true) {
      const [row] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${holderPid} = ANY(pg_blocking_pids(pid))) AS blocked`;
      if (row.blocked) break;
      assert.ok(Date.now() < deadline, 'capture insert never reached a real lock wait');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  } finally { release.release(); await holder; }
  await rejected;
  assert.equal(await prisma.paymentOperation.count({ where: { attemptId: f.attempt.id, type: 'CAPTURE' } }), 0);
  await resolvePayPalPaymentOutcome(f.order.id, { retrieveOrder: async () => { assert.fail('no permission dispatched'); } });
  await assertReleased(f, 'CANCELLED');
});
it('unbound capture is rejected before a permission insert, preserving the existing provider-unavailable response', async () => {
  const f = await fixture(0, false, true);
  await assert.rejects(capturePayPalOrder(f.order.id, f.user.id, { captureOrder: async () => { assert.fail('unbound capture'); } }), PayPalCaptureProviderError);
  assert.equal(await prisma.paymentOperation.count({ where: { attemptId: f.attempt.id, type: 'CAPTURE' } }), 0); await stock(f, 2);
});
it('local CANCELED alone never authorizes capture or proves inventory can be released', async () => {
  const f = await fixture(); await prisma.payment.update({ where: { id: f.payment.id }, data: { status: 'CANCELED' } });
  await assert.rejects(capturePayPalOrder(f.order.id, f.user.id, { captureOrder: async () => { assert.fail('canceled capture'); } }), PaymentResolutionUnavailableError);
  assert.equal(await prisma.paymentOperation.count({ where: { attemptId: f.attempt.id, type: 'CAPTURE' } }), 0); await stock(f, 2);
});
