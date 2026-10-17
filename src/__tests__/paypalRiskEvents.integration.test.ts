import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, afterEach, before, beforeEach, it } from 'node:test';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import { config } from '../config/index.js';
import { prisma } from '../prisma/runtime.js';
import { createOrder } from '../domain/orders/orderService.js';
import { reconcilePayPalWebhookEvent } from '../domain/payments/paypalReconciliationService.js';
import { normalizePayPalRiskResource, paypalRiskEvents } from '../domain/payments/paypalRiskEvents.js';
import { setPayPalWebhookVerifierForTests } from '../controllers/paypalWebhookController.js';
import { resolvePayPalPaymentOutcome } from '../domain/payments/paypalResolutionService.js';
import { expireOrderReservation } from '../domain/orders/orderExpiryService.js';

let server: ReturnType<typeof app.listen>, base: string;
const originalMode = config.PAYMENT_RESOLUTION_ENABLED;
let restoreVerifier: (() => void) | undefined;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
beforeEach(() => { config.PAYMENT_RESOLUTION_ENABLED = false; restoreVerifier = setPayPalWebhookVerifierForTests(async () => true); });
afterEach(() => { restoreVerifier?.(); config.PAYMENT_RESOLUTION_ENABLED = originalMode; });
after(async () => { await new Promise<void>(r => server.close(() => r())); await prisma.$disconnect(); });
async function fixture(managed = false, captureBinding: 'BOTH' | 'PAYMENT_ONLY' | 'ATTEMPT_ONLY' | 'UNBOUND' = 'BOTH') {
  config.PAYMENT_RESOLUTION_ENABLED = managed;
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@pp3.test`, passwordHash: 'synthetic', emailVerified: true,
    addresses: { create: { recipientName: 'Synthetic Buyer', line1: '1 Fictional Street', city: 'Testville', postcode: 'T1', countryCode: 'GB', isDefaultBilling: true } } } });
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: 'PP3 synthetic product', theme: 'PP3', ageRecommendation: '8+', pieceCount: 10 } });
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: 'NEW', originalPrice: 10, currentStock: 5 } });
  const order = await createOrder(user.id, { shippingMethod: 'STANDARD', items: [{ productListingId: listing.id, quantity: 2 }] });
  const captureId = `CAP-${randomUUID()}`;
  const payment = await prisma.payment.create({ data: { orderId: order.id, provider: 'PAYPAL', providerReference: `PP-${randomUUID()}`, providerCaptureReference: captureBinding === 'ATTEMPT_ONLY' || captureBinding === 'UNBOUND' ? null : captureId, amount: order.totalAmount, currency: 'GBP', status: 'PROCESSING' } });
  if (managed) {
    const attempt = await prisma.paymentAttempt.create({ data: { orderId: order.id, paymentId: payment.id, provider: 'PAYPAL', providerReference: payment.providerReference, providerCaptureReference: captureBinding === 'PAYMENT_ONLY' || captureBinding === 'UNBOUND' ? null : captureId, amount: payment.amount, currency: 'GBP', creationKey: randomUUID(), admittedAt: new Date() } });
    for (const type of ['CREATE', 'CAPTURE'] as const) {
      const operation = await prisma.paymentOperation.create({ data: { attemptId: attempt.id, type, operationKey: randomUUID(), requestHash: 'a'.repeat(64), admittedAt: new Date(), admissionDeadline: (await prisma.paymentResolution.findUniqueOrThrow({ where: { orderId: order.id } })).initialPaymentDeadline } });
      await prisma.paymentOperation.update({ where: { id: operation.id }, data: { state: 'POTENTIALLY_DISPATCHED', executionCount: 1 } });
    }
  }
  return { user, listing, order, payment, captureId };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function resource(f: Fixture, type: string) {
  if (type.startsWith('CUSTOMER.DISPUTE.')) return { dispute_id: `DISPUTE-${f.payment.id}`, status: type.endsWith('RESOLVED') ? 'RESOLVED' : 'OPEN', update_time: '2026-10-17T12:00:00Z', disputed_transactions: [{ seller_transaction_id: f.captureId }], dispute_outcome: { outcome_code: 'RESOLVED_BUYER_FAVOUR' } };
  if (type === 'CHECKOUT.PAYMENT-APPROVAL.REVERSED') return { order_id: f.payment.providerReference, purchase_units: [{ custom_id: 'untrusted' }] };
  return { id: f.captureId, status: type.endsWith('DECLINED') ? 'DECLINED' : 'REVERSED', amount: { value: f.payment.amount.toFixed(2), currency_code: 'GBP' }, supplementary_data: { related_ids: { order_id: f.payment.providerReference } } };
}
async function post(type: string, body: unknown, id: string = randomUUID()) {
  const response = await fetch(`${base}/payments/paypal/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, event_type: type, resource: body }) });
  assert.equal(response.status, 200); return prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'PAYPAL', providerEventId: id } } });
}
async function unchanged(f: Fixture, paid = false) {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } });
  const listing = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } });
  assert.equal(order.status, paid ? 'CONFIRMED' : 'PENDING');
  assert.equal(listing.currentStock, paid ? 3 : 5); assert.equal(listing.reservedStock, paid ? 0 : 2);
  assert.equal(await prisma.refund.count({ where: { paymentId: f.payment.id } }), 0);
  assert.equal(await prisma.reservationReleaseProof.count({ where: { orderId: f.order.id } }), 0);
  assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), paid ? 1 : 0);
}
async function success(f: Fixture) { await reconcilePayPalWebhookEvent({ id: randomUUID(), eventType: 'PAYMENT.CAPTURE.COMPLETED', captureId: f.captureId, paypalOrderId: f.payment.providerReference, amount: f.payment.amount.toFixed(2), currency: 'GBP' }); }
for (const type of paypalRiskEvents) it(`${type}: verified HTTP receipt correlates provider identifiers without inventory/refund effects`, async () => {
  const f = await fixture(); const receipt = await post(type, resource(f, type));
  assert.ok(receipt.processedAt); assert.equal((receipt.reviewDetails as any).correlations[0].orderId, f.order.id);
  assert.equal((receipt.reviewDetails as any).correlations[0].customerId, f.user.id);
  await unchanged(f);
  assert.equal(await prisma.financialEvidence.count({ where: { orderId: f.order.id, kind: 'TERMINAL_UNPAID' } }), 0);
});
for (const managed of [false, true]) it(`mode ${managed ? 'MANAGED' : 'LEGACY'}: delayed disputes, reversals and declines preserve success and one confirmation`, async () => {
  const f = await fixture(managed); await success(f);
  const paidAt = (await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).paidAt;
  for (const type of [...paypalRiskEvents].reverse()) await post(type, resource(f, type));
  await unchanged(f, true); const p = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  assert.equal(p.status, 'SUCCEEDED'); assert.deepEqual(p.paidAt, paidAt);
});
it('duplicates and distinct notifications for one dispute have no duplicate financial or inventory effects', async () => {
  const f = await fixture(true), id = randomUUID(), type = 'CUSTOMER.DISPUTE.CREATED', body = resource(f, type);
  await Promise.all(Array.from({ length: 6 }, () => post(type, body, id)));
  assert.equal(await prisma.paymentWebhookEvent.count({ where: { providerEventId: id } }), 1);
  await Promise.all(Array.from({ length: 4 }, () => post(type, body)));
  assert.equal(await prisma.financialEvidence.count({ where: { orderId: f.order.id } }), 0); await unchanged(f);
});
it('resolved then older created/updated events remain separate observations and never clear an operator review', async () => {
  const f = await fixture(); const resolved = await post('CUSTOMER.DISPUTE.RESOLVED', resource(f, 'CUSTOMER.DISPUTE.RESOLVED'));
  for (const type of ['CUSTOMER.DISPUTE.CREATED', 'CUSTOMER.DISPUTE.UPDATED']) await post(type, { ...resource(f, type), update_time: '2026-10-16T12:00:00Z' });
  assert.deepEqual((await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: resolved.id } })).evidence, resolved.evidence);
  assert.equal((await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: resolved.id } })).reviewedAt, null); await unchanged(f);
});
it('invalid signatures cause no durable receipt or review', async () => {
  restoreVerifier?.(); restoreVerifier = setPayPalWebhookVerifierForTests(async () => false);
  const id = randomUUID(); const response = await fetch(`${base}/payments/paypal/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, event_type: 'CUSTOMER.DISPUTE.CREATED', resource: {} }) });
  assert.equal(response.status, 400); assert.equal(await prisma.paymentWebhookEvent.count({ where: { providerEventId: id } }), 0);
});
for (const body of [null, [], 'malformed', { id: 42, disputed_transactions: {} }, { id: 'DISPUTE', disputed_transactions: [{ buyer_transaction_id: 'buyer-only' }] }]) it(`malformed dispute ${JSON.stringify(body)} remains auditable without financial effects`, async () => {
  const f = await fixture(); const receipt = await post('CUSTOMER.DISPUTE.CREATED', body);
  assert.equal((receipt.reviewDetails as any).reason, 'MALFORMED_RESOURCE'); assert.ok((receipt.evidence as any).invalidFields.length); await unchanged(f);
});
it('custom metadata and buyer IDs cannot assign ownership; unknown seller IDs require review', async () => {
  const f = await fixture(); const r = await post('CUSTOMER.DISPUTE.CREATED', { dispute_id: 'UNKNOWN-DISPUTE', custom_id: String(f.order.id), disputed_transactions: [{ seller_transaction_id: 'UNBOUND', buyer_transaction_id: f.captureId }], email: 'must-not-persist@example.com' });
  assert.deepEqual((r.reviewDetails as any).correlations, []); assert.equal((r.reviewDetails as any).reason, 'UNCORRELATED_PROVIDER_IDENTIFIERS');
  assert.ok(!JSON.stringify(r.evidence).includes('must-not-persist')); assert.ok(!JSON.stringify(r.evidence).includes('custom_id')); await unchanged(f);
});
it('conflicting bound capture and order identifiers cannot signal decline against either order', async () => {
  const f = await fixture(), other = await fixture(); const body = resource(f, 'PAYMENT.CAPTURE.DECLINED');
  const r = await post('PAYMENT.CAPTURE.DECLINED', { ...body, supplementary_data: { related_ids: { order_id: other.payment.providerReference } } });
  assert.deepEqual((r.reviewDetails as any).correlations, []); assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'PROCESSING'); await unchanged(f); await unchanged(other);
});
for (const change of [{ status: 'COMPLETED' }, { amount: { value: '1.00', currency_code: 'GBP' } }, { amount: { value: '23.99', currency_code: 'USD' } }, { status: undefined }]) it(`decline event name alone or inconsistent financial payload is not failure proof: ${JSON.stringify(change)}`, async () => {
  const f = await fixture(true); await post('PAYMENT.CAPTURE.DECLINED', { ...resource(f, 'PAYMENT.CAPTURE.DECLINED'), ...change });
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'PROCESSING');
  assert.equal(await prisma.financialEvidence.count({ where: { orderId: f.order.id, kind: 'FAILURE' } }), 0); await unchanged(f);
});
it('a multi-transaction dispute correlates all bound seller transactions without guessing unknown ones', async () => {
  const f = await fixture(), g = await fixture(); const receipt = await post('CUSTOMER.DISPUTE.CREATED', { dispute_id: 'MULTI', disputed_transactions: [{ seller_transaction_id: f.captureId }, { seller_transaction_id: g.captureId }, { seller_transaction_id: 'UNBOUND' }] });
  assert.deepEqual((receipt.reviewDetails as any).correlations.map((c: any) => c.orderId).sort((a: number,b: number) => a-b), [f.order.id,g.order.id].sort((a,b)=>a-b));
  assert.deepEqual((receipt.reviewDetails as any).unmatchedCaptureIds, ['UNBOUND']); await unchanged(f); await unchanged(g);
});
it('prior-attempt dispute correlates through durable attempt binding without overwriting the current payment identity', async () => {
  const f = await fixture(true); const newReference = `PP-${randomUUID()}`;
  await prisma.payment.update({ where: { id: f.payment.id }, data: { providerReference: newReference, providerCaptureReference: null } });
  const r = await post('CUSTOMER.DISPUTE.UPDATED', resource(f, 'CUSTOMER.DISPUTE.UPDATED'));
  assert.equal((r.reviewDetails as any).correlations[0].orderId, f.order.id);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).providerReference, newReference); await unchanged(f);
});
it('webhook, expiry and provider-resolution race preserves verified success and exactly one stock conversion', async () => {
  const f = await fixture(true);
  await Promise.all([post('PAYMENT.CAPTURE.REVERSED', resource(f, 'PAYMENT.CAPTURE.REVERSED')), post('CUSTOMER.DISPUTE.CREATED', resource(f, 'CUSTOMER.DISPUTE.CREATED')), success(f), expireOrderReservation(f.order.id), resolvePayPalPaymentOutcome(f.order.id, { retrieveOrder: async () => { throw Error('synthetic unavailable provider'); } })]);
  await unchanged(f, true); assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.listing.id, type: 'WEBSITE_SALE' } }), 1);
});
it('admin review requires authentication and ADMIN; concurrent acknowledgement is idempotent and never grants financial authority', async () => {
  const f = await fixture(true), receipt = await post('PAYMENT.CAPTURE.REVERSED', resource(f, 'PAYMENT.CAPTURE.REVERSED'));
  const admin = await prisma.user.create({ data: { email: `${randomUUID()}@pp3.test`, passwordHash: 'synthetic', role: 'ADMIN', emailVerified: true } });
  const token = (u: typeof f.user) => jwt.sign({ id: u.id, role: u.role }, config.JWT_SECRET);
  const url = `${base}/admin/paypal/webhook-reviews`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${token(f.user)}` } })).status, 403);
  const headers = { Authorization: `Bearer ${token(admin)}`, 'Content-Type': 'application/json' };
  const list = await fetch(`${url}?afterId=${receipt.id-1}`, { headers }); assert.equal(list.status, 200); assert.ok((await list.json() as any).reviews.some((r: any) => r.id === receipt.id));
  const acknowledged = await Promise.all(Array.from({ length: 4 }, () => fetch(`${url}/${receipt.id}/acknowledge`, { method: 'POST', headers, body: '{}' })));
  assert.ok(acknowledged.every(r => r.status === 200));
  const r = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: receipt.id } }); assert.ok(r.reviewedAt); assert.equal((r.reviewDetails as any).acknowledgedByUserId, admin.id);
  await post('PAYMENT.CAPTURE.REVERSED', resource(f, 'PAYMENT.CAPTURE.REVERSED'), receipt.providerEventId);
  assert.deepEqual((await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: receipt.id } })).reviewedAt, r.reviewedAt);
  await unchanged(f); assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'PROCESSING');
});
it('normalization limits oversized fields, rejects malformed times and never stores raw provider text or URLs', () => {
  const normalized = normalizePayPalRiskResource('CUSTOMER.DISPUTE.CREATED', { dispute_id: 'D', status: 'x'.repeat(300), update_time: 'yesterday', disputed_transactions: [{ seller_transaction_id: 'CAP' }], links: [{ href: 'https://secret.invalid' }], reason: 'free text' });
  assert.deepEqual(normalized.invalidFields, ['status','update_time']); assert.ok(!JSON.stringify(normalized).includes('secret')); assert.ok(!JSON.stringify(normalized).includes('free text'));
});
it('a valid managed DECLINED signal queues read-only resolution but cannot authorize terminal finality or stock release', async () => {
  const f = await fixture(true); await post('PAYMENT.CAPTURE.DECLINED', resource(f, 'PAYMENT.CAPTURE.DECLINED'));
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'FAILED');
  assert.equal(await prisma.financialEvidence.count({ where: { orderId: f.order.id, kind: 'FAILURE' } }), 1);
  assert.equal(await prisma.financialEvidence.count({ where: { orderId: f.order.id, kind: 'TERMINAL_UNPAID' } }), 0);
  await resolvePayPalPaymentOutcome(f.order.id, { retrieveOrder: async () => ({ id: f.payment.providerReference, status: 'APPROVED', purchase_units: [{ payments: { captures: [{ id: f.captureId, status: 'PENDING', amount: { value: '23.99', currency_code: 'GBP' } }] } }] }) });
  await unchanged(f); await success(f); await unchanged(f, true);
});
it('an in-flight provider decline loses to verified success despite concurrent reversal and dispute delivery', async () => {
  const f = await fixture(true);
  await prisma.paymentResolution.update({ where: { orderId: f.order.id }, data: { state: 'CLOSED_RESOLVING', paymentAdmissionClosedAt: new Date(), closureReason: 'CUSTOMER_ABANDONED' } });
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(r => { entered = r; }), proceed = new Promise<void>(r => { release = r; });
  const resolution = resolvePayPalPaymentOutcome(f.order.id, { retrieveOrder: async () => { entered(); await proceed; return { id: f.payment.providerReference, status: 'APPROVED', purchase_units: [{ payments: { captures: [{ id: f.captureId, status: 'DECLINED', amount: { value: '23.99', currency_code: 'GBP' } }] } }] }; } });
  try {
    await waiting;
    await Promise.all([post('PAYMENT.CAPTURE.REVERSED', resource(f, 'PAYMENT.CAPTURE.REVERSED')), post('CUSTOMER.DISPUTE.RESOLVED', resource(f, 'CUSTOMER.DISPUTE.RESOLVED')), success(f)]);
  } finally { release(); await resolution; }
  await unchanged(f, true); assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'SUCCEEDED');
});
it('conflicting content for an existing event ID cannot replace immutable provider evidence or review', async () => {
  const f = await fixture(); const first = await post('CUSTOMER.DISPUTE.CREATED', resource(f, 'CUSTOMER.DISPUTE.CREATED'));
  const response = await fetch(`${base}/payments/paypal/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: first.providerEventId, event_type: first.eventType, resource: { ...resource(f, first.eventType), status: 'RESOLVED' } }) });
  assert.equal(response.status, 500); const current = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { id: first.id } });
  assert.deepEqual(current.evidence, first.evidence); assert.deepEqual(current.reviewDetails, first.reviewDetails); await unchanged(f);
});
it('review endpoints reject malformed filters and acknowledgement bodies and never alter unknown receipts', async () => {
  const admin = await prisma.user.create({ data: { email: `${randomUUID()}@pp3.test`, passwordHash: 'synthetic', role: 'ADMIN' } });
  const headers = { Authorization: `Bearer ${jwt.sign({ id: admin.id }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' };
  const url = `${base}/admin/paypal/webhook-reviews`;
  assert.equal((await fetch(`${url}?afterId=-1`, { headers })).status, 400);
  assert.equal((await fetch(`${url}?customerId=1`, { headers })).status, 400);
  assert.equal((await fetch(`${url}/1/acknowledge`, { method: 'POST', headers, body: '{"releaseStock":true}' })).status, 400);
  assert.equal((await fetch(`${url}/2147483647/acknowledge`, { method: 'POST', headers, body: '{}' })).status, 404);
});
for (const status of ['DISPATCHED', 'COMPLETED'] as const) it(`${status} paid orders retain payment, fulfilment, inventory and confirmation after all risk events`, async () => {
  const f = await fixture(true); await success(f);
  await prisma.order.update({ where: { id: f.order.id }, data: { status } });
  for (const type of paypalRiskEvents) await post(type, resource(f, type));
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, status);
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } })).status, 'SUCCEEDED');
  const stock = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } });
  assert.equal(stock.currentStock, 3); assert.equal(stock.reservedStock, 0);
  assert.equal(await prisma.refund.count({ where: { paymentId: f.payment.id } }), 0);
  assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: f.order.id } }), 1);
});

for (const scenario of ['UNBOUND', 'PAYMENT_ONLY', 'NO_ATTEMPT', 'HISTORICAL_ONLY', 'OLD_CAPTURE', 'SUPERSEDED_ATTEMPT', 'CONFLICTING_PAYMENT_CAPTURE'] as const) it(`DECLINED ${scenario}: Order correlation cannot replace current-attempt Capture binding`, async () => {
  const managed = scenario !== 'NO_ATTEMPT' && scenario !== 'HISTORICAL_ONLY';
  const f = await fixture(managed, scenario === 'UNBOUND' || scenario === 'PAYMENT_ONLY' ? scenario : scenario === 'CONFLICTING_PAYMENT_CAPTURE' ? 'ATTEMPT_ONLY' : 'BOTH');
  if (scenario === 'HISTORICAL_ONLY') await prisma.paymentAttempt.create({ data: {
    orderId: f.order.id, paymentId: f.payment.id, provider: 'PAYPAL', historical: true,
    providerReference: f.payment.providerReference, providerCaptureReference: f.captureId,
    amount: f.payment.amount, currency: 'GBP',
  } });
  if (scenario === 'OLD_CAPTURE' || scenario === 'SUPERSEDED_ATTEMPT') {
    const reference = scenario === 'OLD_CAPTURE' ? `PP-${randomUUID()}` : null;
    await prisma.paymentAttempt.create({ data: { orderId: f.order.id, paymentId: f.payment.id, provider: 'PAYPAL',
      providerReference: reference, amount: f.payment.amount, currency: 'GBP', creationKey: randomUUID(), admittedAt: new Date() } });
    if (reference) await prisma.payment.update({ where: { id: f.payment.id }, data: { providerReference: reference, providerCaptureReference: null } });
  }
  if (scenario === 'CONFLICTING_PAYMENT_CAPTURE') await prisma.payment.update({ where: { id: f.payment.id }, data: { providerCaptureReference: `OTHER-${randomUUID()}` } });
  const before = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  const resolutionBefore = await prisma.paymentResolution.findUnique({ where: { orderId: f.order.id } });
  const attemptsBefore = await prisma.paymentAttempt.findMany({ where: { paymentId: f.payment.id }, include: { operations: true }, orderBy: { id: 'asc' } });
  const receipt = await post('PAYMENT.CAPTURE.DECLINED', { ...resource(f, 'PAYMENT.CAPTURE.DECLINED'), supplementary_data: { related_ids: { order_id: before.providerReference } } });
  assert.ok(receipt.reviewDetails); assert.ok(receipt.processedAt);
  assert.equal((receipt.evidence as any).captureId, f.captureId);
  assert.deepEqual(await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } }), before);
  assert.deepEqual(await prisma.paymentResolution.findUnique({ where: { orderId: f.order.id } }), resolutionBefore);
  assert.deepEqual(await prisma.paymentAttempt.findMany({ where: { paymentId: f.payment.id }, include: { operations: true }, orderBy: { id: 'asc' } }), attemptsBefore);
  assert.equal(await prisma.financialEvidence.count({ where: { orderId: f.order.id } }), 0);
  await unchanged(f);
});
it('DECLINED with exact current-attempt Capture binding remains valid when the Payment capture summary is not yet set', async () => {
  const f = await fixture(true, 'ATTEMPT_ONLY');
  await post('PAYMENT.CAPTURE.DECLINED', resource(f, 'PAYMENT.CAPTURE.DECLINED'));
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  assert.equal(payment.status, 'FAILED'); assert.equal(payment.providerCaptureReference, null);
  assert.equal(await prisma.financialEvidence.count({ where: { orderId: f.order.id, kind: 'FAILURE' } }), 1);
  assert.equal(await prisma.financialEvidence.count({ where: { orderId: f.order.id, kind: 'TERMINAL_UNPAID' } }), 0);
  await unchanged(f);
});
