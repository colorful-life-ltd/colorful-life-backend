import assert from 'node:assert/strict';
import { after, afterEach, before, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type Stripe from 'stripe';
import app from '../app.js';
import { prisma } from '../prisma/runtime.js';
import { config } from '../config/index.js';
import { databaseNow, initializePaymentResolution } from '../domain/payments/paymentResolutionService.js';
import { setStripePaymentClientForTests, type StripePaymentClient } from '../domain/payments/stripePaymentService.js';
import { reconcileStripePaymentEvent } from '../domain/payments/stripeReconciliationService.js';
import { resolvePaymentReservation, type StripeResolutionClient } from '../domain/payments/stripeResolutionService.js';
import { expireUnledgeredUnpaidReservations } from '../domain/orders/orderExpiryService.js';
import { createOrder } from '../domain/orders/orderService.js';

// Customer-journey coverage for a declined card in managed payment-resolution mode,
// the mode chosen to resolve the legacy "declined order is stuck" defect.
let server: ReturnType<typeof app.listen>, url: string;
const originalManaged = config.PAYMENT_RESOLUTION_ENABLED;
let restoreStripe: (() => void) | undefined;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); const a = server.address(); assert.ok(a && typeof a !== 'string'); url = `http://127.0.0.1:${a.port}`; });
afterEach(() => { restoreStripe?.(); restoreStripe = undefined; config.PAYMENT_RESOLUTION_ENABLED = originalManaged; });
after(async () => { await new Promise<void>((r, fail) => server.close(e => e ? fail(e) : r())); await prisma.$disconnect(); });

async function customer(stock = 5) {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic', emailVerified: true,
    addresses: { create: { recipientName: 'Synthetic Buyer', line1: '1 Fictional Road', city: 'Testville', postcode: 'T1 1TT', countryCode: 'GB', isDefault: true, isDefaultBilling: true } } } });
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: 'Decline fixture', theme: 'TEST', ageRecommendation: '8+', pieceCount: 1 } });
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: 'NEW', originalPrice: '12.50', currentStock: stock } });
  return { user, listing, token: jwt.sign({ id: user.id, role: 'CUSTOMER' }, config.JWT_SECRET) };
}
type Customer = Awaited<ReturnType<typeof customer>>;
const http = (c: Customer, method: string, path: string, body?: unknown) => fetch(`${url}${path}`, { method, headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
const windowOf = async (c: Customer, id: number) => (await (await http(c, 'GET', `/orders/${id}`)).json()).paymentWindow;
const stock = (c: Customer) => prisma.productListing.findUniqueOrThrow({ where: { id: c.listing.id } });

/** Stripe test double: a single PaymentIntent whose provider-side status the test controls. */
function stripe() {
  let intent!: Stripe.PaymentIntent; let creates = 0; let cancels = 0;
  const client = { paymentIntents: {
    create: async (params: Stripe.PaymentIntentCreateParams) => { creates++; intent = { ...params, id: `pi_${randomUUID()}`, client_secret: 'synthetic', status: 'requires_payment_method', amount_received: 0, amount_capturable: 0, last_payment_error: null } as unknown as Stripe.PaymentIntent; return intent; },
    retrieve: async () => intent,
    cancel: async () => { cancels++; intent = { ...intent, status: 'canceled' }; return intent; },
  } };
  return { payment: client as unknown as StripePaymentClient, resolution: client as unknown as StripeResolutionClient,
    get intent() { return intent; }, set(value: Partial<Stripe.PaymentIntent>) { intent = { ...intent, ...value }; }, counts: () => ({ creates, cancels }) };
}
const event = (s: ReturnType<typeof stripe>, type: 'payment_intent.succeeded' | 'payment_intent.payment_failed') =>
  reconcileStripePaymentEvent({ id: `evt_${randomUUID()}`, type, paymentIntentId: s.intent.id, amount: s.intent.amount, currency: 'gbp', metadata: s.intent.metadata as Record<string, string> });
const declined = { status: 'requires_payment_method' as const, last_payment_error: { code: 'card_declined' } as Stripe.PaymentIntent.LastPaymentError };

async function managedOrder(c: Customer) {
  config.PAYMENT_RESOLUTION_ENABLED = true;
  const response = await http(c, 'POST', '/orders', { shippingMethod: 'STANDARD', items: [{ productListingId: c.listing.id, quantity: 1 }] });
  assert.equal(response.status, 201); return (await response.json()) as { id: number; totalAmount: string };
}

it('decline, then retry on the same PaymentIntent, then success confirms once', async () => {
  const c = await customer(), s = stripe(); restoreStripe = setStripePaymentClientForTests(s.payment);
  const order = await managedOrder(c);
  assert.equal((await http(c, 'POST', `/orders/${order.id}/payments/stripe`)).status, 201);
  s.set(declined); await event(s, 'payment_intent.payment_failed');
  const afterDecline = await windowOf(c, order.id);
  assert.equal(afterDecline.mode, 'MANAGED'); assert.equal(afterDecline.state, 'RETRY_REQUIRES_PROVIDER_CHECK');
  assert.equal(afterDecline.resumeEligibility, 'REQUIRES_PROVIDER_CHECK'); assert.ok(afterDecline.retryDeadline);
  // The customer retries: the backend re-reads Stripe and reuses the same intent.
  const retry = await http(c, 'POST', `/orders/${order.id}/payments/stripe`); assert.equal(retry.status, 201);
  assert.deepEqual(await retry.json(), { clientSecret: 'synthetic' }); assert.equal(s.counts().creates, 1);
  s.set({ status: 'succeeded', amount_received: s.intent.amount, last_payment_error: null }); await event(s, 'payment_intent.succeeded');
  const paid = await windowOf(c, order.id); assert.equal(paid.state, 'PAID');
  const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
  assert.equal(row.status, 'CONFIRMED'); assert.equal(row.payments.length, 1); assert.equal(row.payments[0].status, 'SUCCEEDED');
  const listing = await stock(c); assert.equal(listing.currentStock, 4); assert.equal(listing.reservedStock, 0);
  assert.equal(await prisma.inventoryMovement.count({ where: { listingId: c.listing.id, type: 'WEBSITE_SALE' } }), 1);
  assert.equal((await prisma.orderConfirmationJob.findUniqueOrThrow({ where: { eventKey: `order:${order.id}` } })).state, 'PENDING');
});

it('a repeated decline keeps the same retry deadline and the order stays retryable', async () => {
  const c = await customer(), s = stripe(); restoreStripe = setStripePaymentClientForTests(s.payment);
  const order = await managedOrder(c);
  await http(c, 'POST', `/orders/${order.id}/payments/stripe`);
  s.set(declined); await event(s, 'payment_intent.payment_failed');
  const first = await windowOf(c, order.id);
  assert.equal((await http(c, 'POST', `/orders/${order.id}/payments/stripe`)).status, 201);
  await event(s, 'payment_intent.payment_failed');
  const second = await windowOf(c, order.id);
  assert.equal(second.state, 'RETRY_REQUIRES_PROVIDER_CHECK'); assert.equal(second.retryDeadline, first.retryDeadline);
  assert.equal((await http(c, 'POST', `/orders/${order.id}/payments/stripe`)).status, 201);
  assert.equal(s.counts().creates, 1); assert.equal((await stock(c)).reservedStock, 1);
});

/** Managed order whose decline was verified 31 minutes ago, so its retry window has elapsed. */
async function elapsedDecline() {
  config.PAYMENT_RESOLUTION_ENABLED = true;
  const c = await customer(); const s = stripe();
  await prisma.productListing.update({ where: { id: c.listing.id }, data: { reservedStock: 1 } });
  const now = await prisma.$transaction(databaseNow); const createdAt = new Date(now.getTime() - 90 * 60_000);
  const order = await prisma.$transaction(async tx => {
    const o = await tx.order.create({ data: { userId: c.user.id, totalAmount: '16.49', createdAt, reservationExpiresAt: new Date(createdAt.getTime() + 30 * 60_000),
      billingRecipientName: 'B', billingLine1: 'L', billingCity: 'C', billingPostcode: 'P', billingCountryCode: 'GB',
      deliveryRecipientName: 'B', deliveryLine1: 'L', deliveryCity: 'C', deliveryPostcode: 'P', deliveryCountryCode: 'GB',
      orderItems: { create: { productListingId: c.listing.id, quantity: 1, unitPrice: '12.50', lineTotal: '12.50' } } } });
    await initializePaymentResolution(tx, o); return o;
  });
  const r = await prisma.paymentResolution.findUniqueOrThrow({ where: { orderId: order.id } });
  await s.payment.paymentIntents.create({ amount: 1649, currency: 'gbp', metadata: { orderId: String(order.id) } });
  s.set(declined);
  const payment = await prisma.payment.create({ data: { orderId: order.id, provider: 'STRIPE', providerReference: s.intent.id, amount: '16.49', status: 'FAILED' } });
  const attempt = await prisma.paymentAttempt.create({ data: { orderId: order.id, paymentId: payment.id, provider: 'STRIPE', amount: '16.49', currency: 'GBP', providerReference: s.intent.id, creationKey: randomUUID(), admittedAt: r.orderCreatedAt } });
  const verified = new Date(now.getTime() - 31 * 60_000);
  await prisma.$transaction(async tx => {
    const ops = [];
    for (const type of ['CREATE', 'CONFIRM'] as const) {
      const op = await tx.paymentOperation.create({ data: { attemptId: attempt.id, type, operationKey: randomUUID(), requestHash: 'a'.repeat(64), admittedAt: r.orderCreatedAt, admissionDeadline: r.initialPaymentDeadline } });
      ops.push(await tx.paymentOperation.update({ where: { id: op.id }, data: { state: 'POTENTIALLY_DISPATCHED', executionCount: 1 } }));
    }
    const confirm = ops[1];
    const evidence = await tx.financialEvidence.create({ data: { orderId: order.id, provider: 'STRIPE', evidenceKey: randomUUID(), kind: 'FAILURE', operationId: confirm.id, verifiedAt: verified, normalized: { providerReference: s.intent.id } } });
    await tx.paymentOperation.update({ where: { id: confirm.id }, data: { state: 'RESULT_RECORDED', evidenceId: evidence.id } });
    await tx.paymentResolution.update({ where: { orderId: order.id }, data: { state: 'RETRY_OPEN', firstFailureVerifiedAt: verified, retryDeadline: new Date(verified.getTime() + 30 * 60_000), firstFailureOperationId: confirm.id, firstFailureEvidenceId: evidence.id } });
  });
  return { c, s, order };
}

it('an abandoned decline is cancelled at Stripe and its stock released once; a late success never re-takes stock', async () => {
  const { c, s, order } = await elapsedDecline();
  assert.equal((await windowOf(c, order.id)).initiationEligibility, 'INELIGIBLE');
  await resolvePaymentReservation(order.id, s.resolution); await resolvePaymentReservation(order.id, s.resolution);
  assert.equal(s.counts().cancels, 1);
  const released = await stock(c); assert.equal(released.reservedStock, 0); assert.equal(released.currentStock, 5);
  const resolution = await prisma.paymentResolution.findUniqueOrThrow({ where: { orderId: order.id } });
  assert.equal(resolution.reservationDisposition, 'RELEASED');
  assert.equal((await windowOf(c, order.id)).state, 'NOT_PAYABLE');
  // A cancelled PaymentIntent cannot succeed; even a forged late success must not re-reserve or confirm.
  await event(s, 'payment_intent.succeeded');
  const after = await stock(c); assert.equal(after.reservedStock, 0); assert.equal(after.currentStock, 5);
  assert.notEqual((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, 'CONFIRMED');
});

it('a success webhook racing the resolution sweep confirms without any cancellation or release', async () => {
  const { c, s, order } = await elapsedDecline();
  // The customer completed payment on the same intent just before the sweep.
  s.set({ status: 'succeeded', amount_received: s.intent.amount, last_payment_error: null });
  await Promise.all([event(s, 'payment_intent.succeeded'), resolvePaymentReservation(order.id, s.resolution)]);
  await resolvePaymentReservation(order.id, s.resolution);
  assert.equal(s.counts().cancels, 0);
  const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
  assert.equal(row.payments[0].status, 'SUCCEEDED');
  const listing = await stock(c);
  const consumed = listing.currentStock === 4 && listing.reservedStock === 0, held = listing.currentStock === 5 && listing.reservedStock === 1;
  assert.ok(consumed || held, 'stock is either consumed once or still held, never released');
  assert.equal(await prisma.inventoryMovement.count({ where: { listingId: c.listing.id, type: 'WEBSITE_SALE' } }), row.status === 'CONFIRMED' ? 1 : 0);
  assert.notEqual((await prisma.paymentResolution.findUniqueOrThrow({ where: { orderId: order.id } })).reservationDisposition, 'RELEASED');
});

it('at cutover, payment-free orders created before managed mode expire within the sweep; paid attempts are retained', async () => {
  config.PAYMENT_RESOLUTION_ENABLED = false;
  const unpaid = await customer(), withPayment = await customer();
  const a = await createOrder(unpaid.user.id, { shippingMethod: 'STANDARD', items: [{ productListingId: unpaid.listing.id, quantity: 1 }] });
  const b = await createOrder(withPayment.user.id, { shippingMethod: 'STANDARD', items: [{ productListingId: withPayment.listing.id, quantity: 1 }] });
  await prisma.payment.create({ data: { orderId: b.id, provider: 'STRIPE', providerReference: `pi_${randomUUID()}`, amount: b.totalAmount, status: 'FAILED' } });
  assert.equal(await prisma.paymentResolution.count({ where: { orderId: { in: [a.id, b.id] } } }), 0);
  config.PAYMENT_RESOLUTION_ENABLED = true;
  const asOf = new Date(Date.now() + 31 * 60_000);
  // The shared test database may hold older unpaid fixtures; sweep past the default batch size.
  assert.ok(await expireUnledgeredUnpaidReservations(asOf, 100_000) >= 1);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: a.id } })).status, 'EXPIRED');
  assert.equal((await stock(unpaid)).reservedStock, 0);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: b.id } })).status, 'PENDING');
  assert.equal((await stock(withPayment)).reservedStock, 1);
  assert.equal(await prisma.paymentResolution.count({ where: { orderId: { in: [a.id, b.id] } } }), 0, 'no ledger is reconstructed');
});
