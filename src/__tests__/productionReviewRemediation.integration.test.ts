import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import type Stripe from 'stripe';
import jwt from 'jsonwebtoken';
import { Client } from 'pg';
import app from '../app.js';
import { prisma } from '../prisma/runtime.js';
import { config } from '../config/index.js';
import { createOrder } from '../domain/orders/orderService.js';
import { createOrReuseStripePaymentIntent, StripePaymentNotPayableError, type StripePaymentClient } from '../domain/payments/stripePaymentService.js';
import { reconcileStripePaymentEvent, reconcileStripeRefundEvent } from '../domain/payments/stripeReconciliationService.js';
import { recoverStripePayment } from '../domain/payments/stripePaymentRecoveryService.js';
import { createOrReusePayPalOrder } from '../domain/payments/paypalOrderService.js';
import { capturePayPalOrder } from '../domain/payments/paypalCaptureService.js';
import { resolvePayPalPaymentOutcome, type PayPalResolutionOrder } from '../domain/payments/paypalResolutionService.js';
import { reconcilePayPalWebhookEvent } from '../domain/payments/paypalReconciliationService.js';
import { normalizePayPalRiskResource } from '../domain/payments/paypalRiskEvents.js';
import { acknowledgePayPalWebhookReview } from '../domain/payments/paypalWebhookReviewService.js';
import { providerFinancialHold } from '../domain/payments/providerFinancialGuard.js';
import { retainStripeDispute } from '../domain/payments/stripeDisputeService.js';
import { startPreparing, dispatchShipment } from '../domain/fulfilment/fulfilmentService.js';
import { requestPaidCancellation, withdrawPaidCancellation } from '../domain/orders/paidCancellation.js';
import { prepareExternalRefund, applyRefundObservation } from '../domain/refunds/refundLifecycleService.js';

const managed = config.PAYMENT_RESOLUTION_ENABLED;
beforeEach(() => { config.PAYMENT_RESOLUTION_ENABLED = true; });
afterEach(() => { config.PAYMENT_RESOLUTION_ENABLED = managed; });
let server: ReturnType<typeof app.listen>, base: string;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
after(async () => { await new Promise<void>(r => server.close(() => r())); await prisma.$disconnect(); });
async function fixture() {
  const admin = await prisma.user.create({ data: { email: `${randomUUID()}@review.test`, passwordHash: 'synthetic', role: 'ADMIN', emailVerified: true } });
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@review.test`, passwordHash: 'synthetic', emailVerified: true,
    addresses: { create: { recipientName: 'Synthetic', line1: '1 Test Road', city: 'London', postcode: 'SW1A 1AA', countryCode: 'GB', isDefaultBilling: true } } } });
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: 'Review fixture', theme: 'REVIEW', ageRecommendation: '8+', pieceCount: 1 } });
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: 'NEW', originalPrice: 20, currentStock: 10 } });
  const order = await createOrder(user.id, { shippingMethod: 'STANDARD', items: [{ productListingId: listing.id, quantity: 1 }] }, randomUUID());
  return { admin, user, listing, order };
}
async function hold(orderId: number) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${orderId} FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM "Payment" WHERE "orderId"=${orderId} FOR UPDATE`;
    return providerFinancialHold(tx, await tx.payment.findUniqueOrThrow({ where: { orderId } }));
  });
}
const shipment = { carrier: 'ROYAL_MAIL' as const, carrierName: 'Royal Mail', trackingNumber: 'AB123456789GB', actualShippingCost: 3 };
async function stripeJourney(lateBeforeRetry = false) {
  const f = await fixture();
  const intents: Stripe.PaymentIntent[] = [];
  const client = { paymentIntents: {
    create: async (params: Stripe.PaymentIntentCreateParams) => {
      if (lateBeforeRetry && intents.length === 1) {
        const old = intents[0];
        await reconcileStripePaymentEvent({ id: randomUUID(), type: 'payment_intent.canceled', paymentIntentId: old.id, amount: old.amount, currency: 'gbp', metadata: old.metadata });
      }
      const intent = { ...params, id: `pi_${randomUUID()}`, client_secret: 'synthetic', status: 'requires_payment_method', amount_received: 0, amount_capturable: 0, last_payment_error: null } as unknown as Stripe.PaymentIntent;
      intents.push(intent); return intent;
    }, retrieve: async (id: string) => intents.find(i => i.id === id)!,
  } } as unknown as StripePaymentClient;
  const send = (intent: Stripe.PaymentIntent, type: 'payment_intent.succeeded' | 'payment_intent.payment_failed' | 'payment_intent.canceled', id = randomUUID()) =>
    reconcileStripePaymentEvent({ id, type, paymentIntentId: intent.id, amount: intent.amount, currency: 'gbp', metadata: intent.metadata });
  await createOrReuseStripePaymentIntent(f.order.id, f.user.id, client);
  const old = intents[0];
  old.last_payment_error = { code: 'card_declined' } as Stripe.PaymentIntent.LastPaymentError;
  await send(old, 'payment_intent.payment_failed');
  old.status = 'canceled';
  await assert.rejects(createOrReuseStripePaymentIntent(f.order.id, f.user.id, client), StripePaymentNotPayableError);
  const oldAttempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { provider_providerReference: { provider: 'STRIPE', providerReference: old.id } } });
  assert.ok(oldAttempt.finalityEvidenceId);
  await createOrReuseStripePaymentIntent(f.order.id, f.user.id, client);
  const current = intents[1]; current.status = 'succeeded'; current.amount_received = current.amount;
  await send(current, 'payment_intent.succeeded');
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'CONFIRMED');
  assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).currentStock, 9);
  return { ...f, old, current, oldAttempt, send };
}
async function paypalJourney() {
  const f = await fixture();
  let creates = 0;
  const orders: string[] = [];
  const createClient = { createOrder: async () => { creates++; const id = `PP-${randomUUID()}`; orders.push(id); return { id }; } };
  await createOrReusePayPalOrder(f.order.id, f.user.id, createClient);
  const oldCapture = `CAP-${randomUUID()}`;
  const remote = (id: string, capture: string, status: string): PayPalResolutionOrder => ({ id, status: status === 'COMPLETED' ? 'COMPLETED' : 'APPROVED', intent: 'CAPTURE',
    purchase_units: [{ amount: { value: f.order.totalAmount.toFixed(2), currency_code: 'GBP' }, payments: { captures: [{ id: capture, status, amount: { value: f.order.totalAmount.toFixed(2), currency_code: 'GBP' } }] } }] });
  await assert.rejects(capturePayPalOrder(f.order.id, f.user.id, { captureOrder: async () => remote(orders[0], oldCapture, 'DECLINED') }));
  await resolvePayPalPaymentOutcome(f.order.id, { retrieveOrder: async () => remote(orders[0], oldCapture, 'DECLINED') });
  const oldAttempt = await prisma.paymentAttempt.findUniqueOrThrow({ where: { provider_providerReference: { provider: 'PAYPAL', providerReference: orders[0] } } });
  assert.ok(oldAttempt.finalityEvidenceId);
  await createOrReusePayPalOrder(f.order.id, f.user.id, createClient);
  assert.equal(creates, 2);
  const currentCapture = `CAP-${randomUUID()}`;
  await capturePayPalOrder(f.order.id, f.user.id, { captureOrder: async () => remote(orders[1], currentCapture, 'COMPLETED') });
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'CONFIRMED');
  const decline = (id = randomUUID()) => reconcilePayPalWebhookEvent({ id, eventType: 'PAYMENT.CAPTURE.DECLINED',
    ...normalizePayPalRiskResource('PAYMENT.CAPTURE.DECLINED', { id: oldCapture, status: 'DECLINED', amount: { value: f.order.totalAmount.toFixed(2), currency_code: 'GBP' }, supplementary_data: { related_ids: { order_id: orders[0] } } }) });
  return { ...f, orders, oldCapture, currentCapture, oldAttempt, decline };
}

it('Stripe: real decline → verified unpaid GET → new intent → paid retry survives late cancellation and concurrent receipt replay', async () => {
  const f = await stripeJourney(), id = randomUUID();
  await Promise.all([f.send(f.old, 'payment_intent.canceled', id), f.send(f.old, 'payment_intent.canceled', id)]);
  assert.deepEqual(await Promise.all([hold(f.order.id), hold(f.order.id)]), [null, null]);
  await f.send(f.old, 'payment_intent.payment_failed');
  assert.equal(await hold(f.order.id), null);
  const receipt = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'STRIPE', providerEventId: id } } });
  assert.equal(receipt.processingError, 'Unknown Stripe payment'); // Original observation retained.
  const decisions = await prisma.operationalAudit.findMany({ where: { orderId: f.order.id, kind: 'PROVIDER_RECEIPT_FINANCIAL_RESOLVED' } });
  assert.equal(decisions.filter(a => (a.details as { receiptId: number }).receiptId === receipt.id).length, 1);
  assert.equal((decisions[0].details as { evidenceId: number }).evidenceId, f.oldAttempt.finalityEvidenceId);
  await startPreparing(f.admin.id, f.order.id);
  await dispatchShipment(f.admin.id, f.order.id, shipment);
  assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.listing.id, type: 'WEBSITE_SALE' } }), 1);
});
it('Stripe: late success contradicting retired unpaid proof still holds; prior safe audit is no override', async () => {
  const f = await stripeJourney();
  await f.send(f.old, 'payment_intent.canceled'); assert.equal(await hold(f.order.id), null);
  await f.send(f.old, 'payment_intent.succeeded'); assert.equal(await hold(f.order.id), 'PAYMENT');
  await assert.rejects(startPreparing(f.admin.id, f.order.id), /PAYMENT_UNRESOLVED|payment is unresolved/i);
});
it('Stripe: malformed old evidence and actual disputes remain held despite valid retirement proof', async () => {
  const f = await stripeJourney();
  await reconcileStripePaymentEvent({ id: randomUUID(), type: 'payment_intent.canceled', paymentIntentId: f.old.id, amount: 1, currency: 'gbp', metadata: f.old.metadata });
  assert.equal(await hold(f.order.id), 'PAYMENT');
  const other = await stripeJourney();
  await retainStripeDispute(randomUUID(), 'charge.dispute.created', { id: randomUUID(), payment_intent: other.old.id, status: 'needs_response', amount: other.old.amount, currency: 'gbp' } as Stripe.Dispute);
  assert.equal(await hold(other.order.id), 'DISPUTE');
});
it('Stripe: external dashboard refund after paid retry remains accounted once and blocks fulfilment', async () => {
  const f = await stripeJourney(), id = randomUUID(), refundId = `re_${randomUUID()}`;
  await f.send(f.old, 'payment_intent.canceled'); assert.equal(await hold(f.order.id), null);
  const event = { id, type: 'refund.updated' as const, refundId, paymentIntentId: f.current.id, amount: f.current.amount, currency: 'gbp', status: 'succeeded' };
  await reconcileStripeRefundEvent(event); await reconcileStripeRefundEvent(event);
  const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: f.order.id } });
  assert.ok(payment.refundedAmount.eq(payment.amount)); assert.equal(await prisma.refund.count({ where: { paymentId: payment.id } }), 1);
  await assert.rejects(startPreparing(f.admin.id, f.order.id), /FULLY_REFUNDED|fully refunded/i);
});
it('PayPal: real decline → independently verified finality → distinct paid retry resolves earlier decline with immutable proof audit', async () => {
  const f = await paypalJourney(), id = randomUUID();
  await Promise.all([f.decline(id), f.decline(id)]);
  assert.deepEqual(await Promise.all([hold(f.order.id), hold(f.order.id)]), [null, null]);
  await startPreparing(f.admin.id, f.order.id); await dispatchShipment(f.admin.id, f.order.id, shipment);
  const decisions = await prisma.operationalAudit.findMany({ where: { orderId: f.order.id, kind: 'PROVIDER_RECEIPT_FINANCIAL_RESOLVED' } });
  assert.equal(decisions.length, 1); assert.equal((decisions[0].details as { evidenceId: number }).evidenceId, f.oldAttempt.finalityEvidenceId);
});
for (const eventType of ['PAYMENT.CAPTURE.REVERSED', 'CUSTOMER.DISPUTE.CREATED']) it(`PayPal: ${eventType} is not cleared by unpaid proof, reviewedAt or prior decline resolution`, async () => {
  const f = await paypalJourney(); await f.decline(); assert.equal(await hold(f.order.id), null);
  const id = randomUUID();
  await reconcilePayPalWebhookEvent({ id, eventType, paypalOrderId: f.orders[0], captureId: f.oldCapture, resourceStatus: 'REVERSED', amount: f.order.totalAmount.toFixed(2), currency: 'GBP' });
  const receipt = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'PAYPAL', providerEventId: id } } });
  await acknowledgePayPalWebhookReview(receipt.id, f.admin.id);
  assert.equal(await hold(f.order.id), eventType.startsWith('CUSTOMER.') ? 'DISPUTE' : 'REVERSAL');
  await assert.rejects(startPreparing(f.admin.id, f.order.id));
});
it('PayPal: unproven historical decline and mismatched capture stay held after acknowledgement', async () => {
  const f = await paypalJourney();
  const oldOrder = randomUUID(), oldCapture = randomUUID();
  await prisma.paymentAttempt.create({ data: { orderId: f.order.id, paymentId: f.oldAttempt.paymentId, provider: 'PAYPAL', providerReference: oldOrder, providerCaptureReference: oldCapture, amount: f.order.totalAmount, currency: 'GBP', historical: true } });
  const id = randomUUID(); await reconcilePayPalWebhookEvent({ id, eventType: 'PAYMENT.CAPTURE.DECLINED', paypalOrderId: oldOrder, captureId: oldCapture, resourceStatus: 'DECLINED', amount: f.order.totalAmount.toFixed(2), currency: 'GBP' });
  const receipt = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'PAYPAL', providerEventId: id } } });
  await acknowledgePayPalWebhookReview(receipt.id, f.admin.id); assert.equal(await hold(f.order.id), 'PAYMENT');
});

const reason = 'Withdraw mistaken cancellation before any refund';
it('withdrawal is ADMIN-only, reasoned, idempotent, immutable and scoped to the exact cancellation generation', async () => {
  const f = await stripeJourney(), requestKey = randomUUID();
  const request = await requestPaidCancellation(f.admin.id, f.order.id, 'Customer requested cancellation for review', requestKey);
  const key = randomUUID();
  await assert.rejects(withdrawPaidCancellation(f.user.id, f.order.id, request.requestId, reason, key), /FORBIDDEN/);
  await assert.rejects(withdrawPaidCancellation(f.admin.id, f.order.id, request.requestId, 'short', key), /INVALID_CANCELLATION/);
  const results = await Promise.all([withdrawPaidCancellation(f.admin.id, f.order.id, request.requestId, reason, key), withdrawPaidCancellation(f.admin.id, f.order.id, request.requestId, reason, key)]);
  assert.equal(results.filter(r => !r.replayed).length, 1);
  const replay = await requestPaidCancellation(f.admin.id, f.order.id, 'Customer requested cancellation for review', requestKey);
  assert.equal(replay.active, false);
  const next = await requestPaidCancellation(f.admin.id, f.order.id, 'A distinct later cancellation requested', randomUUID());
  assert.notEqual(next.requestId, request.requestId);
  await withdrawPaidCancellation(f.admin.id, f.order.id, request.requestId, reason, key); // Must not clear next generation.
  await assert.rejects(startPreparing(f.admin.id, f.order.id), /CANCELLATION_PENDING/);
  await assert.rejects(withdrawPaidCancellation(f.admin.id, f.order.id, next.requestId, reason, key), /IDEMPOTENCY_CONFLICT/);
  await withdrawPaidCancellation(f.admin.id, f.order.id, next.requestId, reason, randomUUID());
  await startPreparing(f.admin.id, f.order.id); await dispatchShipment(f.admin.id, f.order.id, shipment);
  await assert.rejects(withdrawPaidCancellation(f.admin.id, f.order.id, next.requestId, reason, randomUUID()));
  assert.equal(await prisma.operationalAudit.count({ where: { orderId: f.order.id, kind: 'PAID_CANCELLATION_WITHDRAWN' } }), 2);
  await assert.rejects(prisma.operationalAudit.deleteMany({ where: { orderId: f.order.id, kind: 'PAID_CANCELLATION_WITHDRAWN' } }));
});
it('HTTP withdrawal enforces ADMIN, stable request identity, reason and key', async () => {
  const f = await stripeJourney(); const request = await requestPaidCancellation(f.admin.id, f.order.id, 'Customer cancellation request pending review', randomUUID());
  const call = (actor: number, body: object, key?: string) => fetch(`${base}/admin/orders/${f.order.id}/withdraw-paid-cancellation`, {
    method: 'POST', headers: { Authorization: `Bearer ${jwt.sign({ id: actor }, config.JWT_SECRET)}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
  assert.equal((await call(f.user.id, { requestId: request.requestId, reason }, randomUUID())).status, 403);
  assert.equal((await call(f.admin.id, { reason }, randomUUID())).status, 400);
  assert.equal((await call(f.admin.id, { requestId: request.requestId, reason })).status, 400);
  const key = randomUUID(); assert.equal((await call(f.admin.id, { requestId: request.requestId, reason }, key)).status, 200);
  assert.equal((await call(f.admin.id, { requestId: request.requestId, reason }, key)).status, 200);
  await startPreparing(f.admin.id, f.order.id);
});
async function initiateRefund(f: Awaited<ReturnType<typeof stripeJourney>>) {
  return prepareExternalRefund({ actor: f.admin.id, orderId: f.order.id, paymentId: f.oldAttempt.paymentId, amount: 5, reason: 'Synthetic refund intent', provider: 'STRIPE', clientRequestKey: randomUUID() });
}
it('withdrawal refuses initiated refunds even after definitive failure and leaves the cancellation fence intact', async () => {
  const f = await stripeJourney(); const request = await requestPaidCancellation(f.admin.id, f.order.id, 'Cancellation pending customer refund', randomUUID());
  const prepared = await initiateRefund(f);
  await assert.rejects(withdrawPaidCancellation(f.admin.id, f.order.id, request.requestId, reason, randomUUID()), /REFUND_ALREADY_INITIATED/);
  await applyRefundObservation(prepared.refund.id, { provider: 'STRIPE', reference: randomUUID(), parentReference: f.current.id, amount: '5', currency: 'GBP', status: 'FAILED' });
  await assert.rejects(withdrawPaidCancellation(f.admin.id, f.order.id, request.requestId, reason, randomUUID()), /REFUND_ALREADY_INITIATED/);
  await assert.rejects(startPreparing(f.admin.id, f.order.id), /CANCELLATION_PENDING/);
});
it('concurrent withdrawal/refund initiation cannot erase a financial hold or release stock', async () => {
  const f = await stripeJourney(); const request = await requestPaidCancellation(f.admin.id, f.order.id, 'Cancellation before a concurrent refund request', randomUUID());
  const before = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } });
  const results = await Promise.allSettled([withdrawPaidCancellation(f.admin.id, f.order.id, request.requestId, reason, randomUUID()), initiateRefund(f)]);
  assert.equal(results[1].status, 'fulfilled');
  await assert.rejects(withdrawPaidCancellation(f.admin.id, f.order.id, request.requestId, reason, randomUUID()));
  await assert.rejects(dispatchShipment(f.admin.id, f.order.id, shipment));
  assert.deepEqual(await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } }), before);
});
it('dispatch cannot pass the cancellation fence while withdrawal races it; after valid withdrawal stock stays consumed once', async () => {
  const f = await stripeJourney(); const request = await requestPaidCancellation(f.admin.id, f.order.id, 'Cancellation before a concurrent dispatch', randomUUID());
  const results = await Promise.allSettled([dispatchShipment(f.admin.id, f.order.id, shipment), withdrawPaidCancellation(f.admin.id, f.order.id, request.requestId, reason, randomUUID())]);
  assert.equal(results[1].status, 'fulfilled');
  if (results[0].status === 'rejected') await dispatchShipment(f.admin.id, f.order.id, shipment);
  assert.equal(await prisma.shipment.count({ where: { orderId: f.order.id } }), 1);
  assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.listing.id, type: 'WEBSITE_SALE' } }), 1);
  assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).currentStock, 9);
});

it('Stripe: a late retired-intent cancellation arriving DURING retry creation is explained by verified finality, without clearing the receipt', async () => {
  const f = await stripeJourney(true);
  assert.equal(await hold(f.order.id), null);
  await startPreparing(f.admin.id, f.order.id);
  const receipt = await prisma.paymentWebhookEvent.findFirstOrThrow({ where: { eventType: 'payment_intent.canceled', evidence: { path: ['paymentIntentId'], equals: f.old.id } } });
  assert.equal(receipt.processingError, 'Unknown Stripe payment'); // Retained even though independently explained at admission.
});
it('Stripe: unproven historical attempt flags never substitute for terminal-unpaid proof', async () => {
  const f = await stripeJourney(); const ref = `pi_${randomUUID()}`;
  await prisma.paymentAttempt.create({ data: { orderId: f.order.id, paymentId: f.oldAttempt.paymentId, provider: 'STRIPE', providerReference: ref, amount: f.order.totalAmount, currency: 'GBP', historical: true } });
  await reconcileStripePaymentEvent({ id: randomUUID(), type: 'payment_intent.canceled', paymentIntentId: ref, amount: f.current.amount, currency: 'gbp' });
  assert.equal(await hold(f.order.id), 'PAYMENT');
});
it('PayPal: a mismatched capture or financial amount cannot inherit a different retired attempt proof', async () => {
  for (const mismatch of ['capture', 'amount']) {
    const f = await paypalJourney();
    await reconcilePayPalWebhookEvent({ id: randomUUID(), eventType: 'PAYMENT.CAPTURE.DECLINED', paypalOrderId: f.orders[0],
      captureId: mismatch === 'capture' ? f.currentCapture : f.oldCapture, resourceStatus: 'DECLINED',
      amount: mismatch === 'amount' ? '0.01' : f.order.totalAmount.toFixed(2), currency: 'GBP' });
    assert.equal(await hold(f.order.id), 'PAYMENT');
  }
});
it('withdrawal cannot clear a dispute or unresolved externally observed refund', async () => {
  for (const risk of ['dispute', 'refund']) {
    const f = await stripeJourney(); const request = await requestPaidCancellation(f.admin.id, f.order.id, 'Pending cancellation with financial evidence', randomUUID());
    if (risk === 'dispute') await retainStripeDispute(randomUUID(), 'charge.dispute.created', { id: randomUUID(), payment_intent: f.current.id, status: 'needs_response', amount: f.current.amount, currency: 'gbp' } as Stripe.Dispute);
    else await reconcileStripeRefundEvent({ id: randomUUID(), type: 'refund.updated', refundId: randomUUID(), paymentIntentId: f.current.id, amount: f.current.amount + 1, currency: 'gbp', status: 'succeeded' });
    await assert.rejects(withdrawPaidCancellation(f.admin.id, f.order.id, request.requestId, reason, randomUUID()), /PAYMENT_PROVIDER_EVIDENCE_UNRESOLVED/);
    assert.equal(await prisma.operationalAudit.count({ where: { orderId: f.order.id, kind: 'PAID_CANCELLATION_WITHDRAWN' } }), 0);
  }
});

/** Queue real service transactions behind a separate database row lock, then
 * verify both serialization directions rather than relying on scheduler luck. */
async function orderedRace<T, U>(orderId: number, first: () => Promise<T>, second: () => Promise<U>) {
  const blocker = new Client({ connectionString: config.DATABASE_URL }); await blocker.connect();
  const pending: Promise<unknown>[] = [];
  try {
    await blocker.query('BEGIN'); await blocker.query('SELECT id FROM "Order" WHERE id=$1 FOR UPDATE', [orderId]);
    const waitFor = async (count: number) => {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await blocker.query(`SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database()
          AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0`);
        if (result.rows[0].n >= count) return;
        await new Promise(r => setTimeout(r, 10));
      }
      assert.fail('service transaction did not queue behind the database row lock');
    };
    const a = first(); pending.push(a); void a.catch(() => {}); await waitFor(1);
    const b = second(); pending.push(b); void b.catch(() => {}); await waitFor(2);
    await blocker.query('COMMIT');
    return await Promise.allSettled([a, b]);
  } finally { await blocker.query('ROLLBACK'); await blocker.end(); await Promise.allSettled(pending); }
}
for (const refundFirst of [true, false]) it(`withdrawal/refund lock ordering is safe with refundFirst=${refundFirst}`, async () => {
  const f = await stripeJourney(); const request = await requestPaidCancellation(f.admin.id, f.order.id, 'Cancellation before an ordered refund race', randomUUID());
  const withdraw = () => withdrawPaidCancellation(f.admin.id, f.order.id, request.requestId, reason, randomUUID());
  const results = refundFirst ? await orderedRace(f.order.id, () => initiateRefund(f), withdraw) : await orderedRace(f.order.id, withdraw, () => initiateRefund(f));
  if (refundFirst) { assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); }
  else { assert.ok(results.every(r => r.status === 'fulfilled')); } // Independent refund may begin AFTER a committed withdrawal.
  await assert.rejects(dispatchShipment(f.admin.id, f.order.id, shipment));
  assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).currentStock, 9);
});
for (const dispatchFirst of [true, false]) it(`withdrawal/dispatch lock ordering is safe with dispatchFirst=${dispatchFirst}`, async () => {
  const f = await stripeJourney(); const request = await requestPaidCancellation(f.admin.id, f.order.id, 'Cancellation before an ordered dispatch race', randomUUID());
  const withdraw = () => withdrawPaidCancellation(f.admin.id, f.order.id, request.requestId, reason, randomUUID());
  const dispatch = () => dispatchShipment(f.admin.id, f.order.id, shipment);
  const results = dispatchFirst ? await orderedRace(f.order.id, dispatch, withdraw) : await orderedRace(f.order.id, withdraw, dispatch);
  if (dispatchFirst) { assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled'); }
  else assert.ok(results.every(r => r.status === 'fulfilled'));
});

it('Stripe: a same-intent nonterminal decline followed by verified success remains fulfillable', async () => {
  const f = await fixture(); let intent!: Stripe.PaymentIntent;
  const client = { paymentIntents: { create: async (params: Stripe.PaymentIntentCreateParams) => {
    intent = { ...params, id: `pi_${randomUUID()}`, status: 'requires_payment_method', client_secret: 'synthetic', amount_received: 0, amount_capturable: 0 } as unknown as Stripe.PaymentIntent; return intent;
  } } } as unknown as StripePaymentClient;
  await createOrReuseStripePaymentIntent(f.order.id, f.user.id, client);
  const send = (type: 'payment_intent.payment_failed' | 'payment_intent.succeeded') => reconcileStripePaymentEvent({ id: randomUUID(), type, paymentIntentId: intent.id, amount: intent.amount, currency: 'gbp', metadata: intent.metadata });
  await send('payment_intent.payment_failed'); await send('payment_intent.succeeded');
  await send('payment_intent.payment_failed'); // Delayed delivery cannot undo immutable success on the same identity.
  assert.equal(await hold(f.order.id), null); await startPreparing(f.admin.id, f.order.id);
});
it('PayPal: a decline contradicting the current successful capture remains financial uncertainty after acknowledgement', async () => {
  const f = await paypalJourney(); const id = randomUUID();
  await reconcilePayPalWebhookEvent({ id, eventType: 'PAYMENT.CAPTURE.DECLINED', paypalOrderId: f.orders[1], captureId: f.currentCapture,
    resourceStatus: 'DECLINED', amount: f.order.totalAmount.toFixed(2), currency: 'GBP' });
  const receipt = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'PAYPAL', providerEventId: id } } });
  await acknowledgePayPalWebhookReview(receipt.id, f.admin.id);
  assert.equal(await hold(f.order.id), 'PAYMENT'); await assert.rejects(startPreparing(f.admin.id, f.order.id));
});

for (const recovery of [true, false]) it(`legacy Stripe decline → ${recovery ? 'verified GET recovery' : 'verified webhook'} success has receipt-backed proof without inventing managed attempts`, async () => {
  config.PAYMENT_RESOLUTION_ENABLED = false;
  const f = await fixture(); let intent!: Stripe.PaymentIntent;
  const client = { paymentIntents: {
    create: async (params: Stripe.PaymentIntentCreateParams) => {
      intent = { ...params, id: `pi_${randomUUID()}`, status: 'requires_payment_method', client_secret: 'synthetic', amount_received: 0, amount_capturable: 0 } as unknown as Stripe.PaymentIntent; return intent;
    }, retrieve: async () => intent,
  } } as unknown as StripePaymentClient;
  await createOrReuseStripePaymentIntent(f.order.id, f.user.id, client);
  const event = (type: 'payment_intent.payment_failed' | 'payment_intent.succeeded') => reconcileStripePaymentEvent({ id: randomUUID(), type, paymentIntentId: intent.id, amount: intent.amount, currency: 'gbp', metadata: intent.metadata });
  await event('payment_intent.payment_failed');
  intent.status = 'succeeded'; intent.amount_received = intent.amount;
  if (recovery) await recoverStripePayment(f.order.id, f.user.id, client);
  else await event('payment_intent.succeeded');
  await event('payment_intent.payment_failed'); // Delayed nonterminal notification, same paid identity.
  assert.equal(await prisma.paymentAttempt.count({ where: { orderId: f.order.id } }), 0);
  assert.equal(await prisma.financialEvidence.count({ where: { orderId: f.order.id } }), 0);
  assert.equal(await hold(f.order.id), null);
  const audits = await prisma.operationalAudit.findMany({ where: { orderId: f.order.id, kind: 'PROVIDER_RECEIPT_FINANCIAL_RESOLVED' } });
  assert.ok(audits.length > 0); assert.ok(audits.every(a => (a.details as { source: string }).source === 'verified-success-receipt'));
  await startPreparing(f.admin.id, f.order.id); await dispatchShipment(f.admin.id, f.order.id, shipment);
  await reconcileStripePaymentEvent({ id: randomUUID(), type: 'payment_intent.canceled', paymentIntentId: intent.id, amount: intent.amount, currency: 'gbp', metadata: intent.metadata });
  assert.equal(await hold(f.order.id), 'PAYMENT'); // Success never explains a contradictory TERMINAL cancellation.
});
