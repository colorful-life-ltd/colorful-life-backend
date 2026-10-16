import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
import { Decimal } from '@prisma/client/runtime/client';
import { simpleParser } from 'mailparser';
import app from '../app.js';
import { prisma } from '../prisma/runtime.js';
import { config } from '../config/index.js';
import { createOrder, OrderIdempotencyMismatchError } from '../domain/orders/orderService.js';
import { getCustomerOrder, listCustomerOrders, getAdminOrder, listAdminOrders } from '../domain/orders/orderReadService.js';
import { createOrReuseStripePaymentIntent, type StripePaymentClient } from '../domain/payments/stripePaymentService.js';
import { recoverStripePayment } from '../domain/payments/stripePaymentRecoveryService.js';
import { reconcileStripePaymentEvent } from '../domain/payments/stripeReconciliationService.js';
import { reserveRefundCapacity, RefundCapacityExceededError } from '../domain/refunds/refundCapacityService.js';
import { createOrReuseStripeRefund } from '../domain/refunds/stripeRefundService.js';
import { dispatchShipment } from '../domain/fulfilment/fulfilmentService.js';
import { resolveShipping } from '../domain/orders/shipping.js';
import { purchaseSchema, NON_VAT_STATEMENT } from '../domain/orderConfirmation/contract.js';
import { runConfirmationBatch, requeueConfirmation } from '../domain/orderConfirmation/worker.js';
import { captureConfirmationTransport, DeliveryRejected } from '../domain/orderConfirmation/delivery.js';
import { businessFixture } from './fixtures/orderConfirmation.fixture.js';

let server: ReturnType<typeof app.listen>, url: string;
const originalManaged = config.PAYMENT_RESOLUTION_ENABLED, originalDispatch = config.DISPATCH_CONFIRMATION_EMAIL_ENABLED;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); const address = server.address(); assert.ok(address && typeof address !== 'string'); url = `http://127.0.0.1:${address.port}`; });
after(async () => { config.PAYMENT_RESOLUTION_ENABLED = originalManaged; config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = originalDispatch; await new Promise<void>((r, fail) => server.close(e => e ? fail(e) : r())); await prisma.$disconnect(); });
// Synthetic fixtures retained only in the disposable database (issued invoices are immutable).
async function fixture(managed = false) {
  config.PAYMENT_RESOLUTION_ENABLED = managed;
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic', emailVerified: true,
    addresses: { create: { recipientName: 'Synthetic Buyer', line1: '1 Fictional Road', city: 'Testville', postcode: 'T1', countryCode: 'GB', isDefaultBilling: true } } } });
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: 'Shipping fixture', theme: 'TEST', ageRecommendation: '8+', pieceCount: 1 } });
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: 'NEW', originalPrice: '12.50', currentStock: 10 } });
  return { user, listing, input: { shippingMethod: 'STANDARD' as const, items: [{ productListingId: listing.id, quantity: 2 }] }, token: jwt.sign({ id: user.id, role: 'CUSTOMER' }, config.JWT_SECRET) };
}
function provider() {
  let intent: Stripe.PaymentIntent; let creates = 0, reads = 0;
  const client = { paymentIntents: {
    create: async (params: Stripe.PaymentIntentCreateParams) => { creates++; intent = { ...params, id: `pi_${randomUUID()}`, client_secret: 'synthetic-not-persisted', status: 'requires_payment_method', amount_received: 0, amount_capturable: 0, last_payment_error: null } as Stripe.PaymentIntent; return intent; },
    retrieve: async () => { reads++; return intent; },
  } } as unknown as StripePaymentClient;
  return { client, get intent() { return intent; }, setIntent(value: Partial<Stripe.PaymentIntent>) { intent = { ...intent, ...value }; }, counts: () => ({ creates, reads }) };
}
async function post(f: Awaited<ReturnType<typeof fixture>>, body: unknown, key?: string) {
  return fetch(`${url}/orders`, { method: 'POST', headers: { Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
}
it('public options endpoint exposes approved offers without requiring authentication', async () => {
  const response = await fetch(`${url}/orders/shipping-options`); assert.equal(response.status, 200);
  const body = await response.json(); assert.deepEqual(body, { currency: 'GBP', methods: [{ code: 'STANDARD', ...resolveShipping('STANDARD') }, { code: 'EXPRESS', ...resolveShipping('EXPRESS') }] });
});
it('invalid methods and financial tampering reject before database or reservation changes', async () => {
  const f = await fixture(); const baseline = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } });
  const { shippingMethod, ...missing } = f.input;
  for (const body of [missing, { ...f.input, shippingMethod: 'FREE' }, ...['chargePence', 'shippingCharge', 'totalAmount', 'actualShippingCost', 'confirmationDeliverySnapshot'].map(key => ({ ...f.input, [key]: 0 }))]) {
    assert.equal((await post(f, body)).status, 400);
  }
  await assert.rejects(createOrder(f.user.id, { ...f.input, shippingMethod: undefined } as never));
  assert.equal(await prisma.order.count({ where: { userId: f.user.id } }), 0);
  assert.equal(await prisma.payment.count({ where: { order: { userId: f.user.id } } }), 0);
  assert.deepEqual(await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } }), baseline);
});
it('concurrent identical requests create one order/reservation and changed method conflicts', async () => {
  const f = await fixture(), key = randomUUID();
  const responses = await Promise.all(Array.from({ length: 4 }, () => post(f, f.input, key)));
  assert.ok(responses.every(r => r.status === 201)); const bodies = await Promise.all(responses.map(r => r.json()));
  assert.equal(new Set(bodies.map(b => b.id)).size, 1); assert.equal(bodies[0].totalAmount, '28.99');
  assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).reservedStock, 2);
  assert.equal((await post(f, { ...f.input, shippingMethod: 'EXPRESS' }, key)).status, 409);
  await assert.rejects(createOrder(f.user.id, { ...f.input, shippingMethod: 'EXPRESS' }, key), OrderIdempotencyMismatchError);
  await prisma.productListing.update({ where: { id: f.listing.id }, data: { originalPrice: '99.00' } });
  const replay = await (await post(f, f.input, key)).json(); assert.equal(replay.id, bodies[0].id); assert.equal(replay.totalAmount, '28.99');
});
for (const managed of [false, true]) for (const code of ['STANDARD', 'EXPRESS'] as const) it(`${managed ? 'MANAGED' : 'LEGACY'} ${code}: checkout, resume, recovery, invoice and admin refund preserve totals`, async () => {
  const f = await fixture(managed), p = provider(), input = { ...f.input, shippingMethod: code };
  const key = randomUUID();
  const response = await post(f, input, key); assert.equal(response.status, 201); const body = await response.json();
  assert.equal('actualShippingCost' in body, false);
  assert.equal('confirmationDeliverySnapshot' in body, false);
  assert.ok(body.financials); assert.ok(body.paymentWindow);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: body.id } });
  const offer = resolveShipping(code), amount = 2500 + offer.chargePence;
  assert.deepEqual(order.confirmationDeliverySnapshot, offer); assert.equal(order.totalAmount.mul(100).toNumber(), amount); assert.equal(order.actualShippingCost, null);
  for (const view of [await getCustomerOrder(f.user.id, order.id), (await listCustomerOrders(f.user.id))[0], await getAdminOrder(order.id), (await listAdminOrders({ page: 1, pageSize: 50 })).items.find(o => o.id === order.id)]) {
    assert.ok(view); assert.deepEqual(view.financials, { merchandiseSubtotal: '25.00', shipping: { code, ...offer }, totalAmount: order.totalAmount.toFixed(2), currency: 'GBP' });
  }
  assert.equal('actualShippingCost' in (await getCustomerOrder(f.user.id, order.id))!, false);
  const other = await fixture(managed); assert.equal(await getCustomerOrder(other.user.id, order.id), null);
  await createOrReuseStripePaymentIntent(order.id, f.user.id, p.client);
  assert.equal(p.intent.amount, amount);
  await createOrReuseStripePaymentIntent(order.id, f.user.id, p.client); assert.equal(p.counts().creates, 1);
  const evt = { id: randomUUID(), type: 'payment_intent.succeeded' as const, paymentIntentId: p.intent.id, amount, currency: 'gbp', metadata: p.intent.metadata };
  // An actual failure may reuse this intent, without adding another delivery charge.
  await reconcileStripePaymentEvent({ ...evt, id: randomUUID(), type: 'payment_intent.payment_failed' });
  p.setIntent({ last_payment_error: { code: 'card_declined' } as Stripe.PaymentIntent.LastPaymentError });
  await createOrReuseStripePaymentIntent(order.id, f.user.id, p.client); assert.equal(p.counts().creates, 1);
  p.setIntent({ status: 'succeeded', amount_received: amount });
  if (code === 'STANDARD') await recoverStripePayment(order.id, f.user.id, p.client);
  else {
    const oldKey = config.STRIPE_SECRET_KEY, oldSecret = config.STRIPE_WEBHOOK_SECRET;
    config.STRIPE_SECRET_KEY = 'sk_test_issue182_synthetic'; config.STRIPE_WEBHOOK_SECRET = 'whsec_issue182_synthetic';
    try {
      const payload = JSON.stringify({ id: evt.id, type: evt.type, data: { object: p.intent } });
      const signature = new Stripe('sk_test_issue182_synthetic').webhooks.generateTestHeaderString({ payload, secret: config.STRIPE_WEBHOOK_SECRET });
      const delivered = await fetch(`${url}/payments/stripe/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': signature }, body: payload });
      assert.equal(delivered.status, 200);
    } finally { config.STRIPE_SECRET_KEY = oldKey; config.STRIPE_WEBHOOK_SECRET = oldSecret; }
  }
  await reconcileStripePaymentEvent(evt); await reconcileStripePaymentEvent(evt);
  const payment = await prisma.payment.findUniqueOrThrow({ where: { orderId: order.id } }); assert.equal(payment.status, 'SUCCEEDED'); assert.ok(payment.amount.equals(order.totalAmount));
  const stock = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } }); assert.equal(stock.currentStock, 8); assert.equal(stock.reservedStock, 0);
  const job = await prisma.orderConfirmationJob.findUniqueOrThrow({ where: { eventKey: `order:${order.id}` } }); assert.equal(job.state, 'PENDING');
  const source = purchaseSchema.parse(job.source); assert.equal(source.subtotalPence, 2500); assert.equal(source.totalPence, amount); assert.deepEqual(source.delivery, offer);
  // Issue the PDF, simulate a safe SES rejection, then dispatch before eventual delivery.
  await runConfirmationBatch({ jobId: job.id, business: businessFixture, transport: { kind: 'capture', async send() { throw new DeliveryRejected(false, 'PROVIDER_REJECTED'); } } });
  const invoice = await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: order.id } }); assert.ok(invoice.pdfBytes); const hash = createHash('sha256').update(invoice.pdfBytes).digest('hex');
  config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = true;
  const admin = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic', role: 'ADMIN', emailVerified: true } });
  await dispatchShipment(admin.id, order.id, { carrier: 'ROYAL_MAIL', carrierName: 'Royal Mail', trackingNumber: null, actualShippingCost: 2.00 });
  const replay = await (await post(f, input, key)).json();
  assert.equal(replay.id, order.id); assert.equal('actualShippingCost' in replay, false);
  assert.equal('confirmationDeliverySnapshot' in replay, false);
  assert.ok(replay.paymentWindow);
  assert.deepEqual(replay.financials, body.financials);
  assert.equal((await getAdminOrder(order.id))?.actualShippingCost?.toFixed(2), '2.00');
  await requeueConfirmation(job.id); const capture = captureConfirmationTransport();
  await runConfirmationBatch({ jobId: job.id, business: businessFixture, transport: capture.transport });
  assert.equal(capture.messages.length, 1); const mail = await simpleParser(capture.messages[0]);
  assert.ok(mail.text?.includes(NON_VAT_STATEMENT)); assert.ok(!mail.text?.includes('We will email you when your order is dispatched'));
  const attachment = mail.attachments.find(a => a.contentType === 'application/pdf'); assert.ok(attachment); assert.equal(createHash('sha256').update(attachment.content).digest('hex'), hash);
  await runConfirmationBatch({ jobId: job.id, business: businessFixture, transport: capture.transport }); assert.equal(capture.messages.length, 1);
  const unchanged = await prisma.commercialInvoice.findUniqueOrThrow({ where: { orderId: order.id } }); assert.deepEqual(unchanged.snapshot, invoice.snapshot); assert.equal(unchanged.pdfSha256, hash);
  await assert.rejects(reserveRefundCapacity(payment.id, payment.amount.add('0.01')), RefundCapacityExceededError);
  const refundClient = { async createRefund(params: Stripe.RefundCreateParams) { assert.equal(params.amount, amount); return { id: `re_${randomUUID()}`, payment_intent: payment.providerReference, amount, currency: 'gbp', status: 'succeeded', metadata: params.metadata }; }, async retrieveRefund() { throw new Error('Unexpected retrieval'); } };
  const refund = await createOrReuseStripeRefund(order.id, payment.id, payment.amount, 'Admin full refund including shipping', admin.id, refundClient as never, undefined, randomUUID());
  assert.equal(refund.status, 'SUCCEEDED'); assert.ok((await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } })).refundedAmount.equals(payment.amount));
});
it('historical orders stay unpriced and readable with unknown shipping', async () => {
  const f = await fixture(); const order = await createOrder(f.user.id, f.input);
  // Simulate a pre-shipping row, before any payment/job; never rewrite an invoice source.
  await prisma.order.update({ where: { id: order.id }, data: { confirmationDeliverySnapshot: (await import('../generated/prisma-client/client.js')).Prisma.DbNull, totalAmount: new Decimal(25) } });
  const view = await getCustomerOrder(f.user.id, order.id); assert.equal(view?.financials.shipping, null); assert.equal(view?.totalAmount.toString(), '25');
  assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: order.id } }), 0);
});

for (const managed of [false, true]) it(`shipping amount mismatch cannot confirm or consume inventory (managed=${managed})`, async () => {
  const f = await fixture(managed), p = provider(), order = await createOrder(f.user.id, f.input);
  await createOrReuseStripePaymentIntent(order.id, f.user.id, p.client);
  const mismatch = { id: randomUUID(), type: 'payment_intent.succeeded' as const, paymentIntentId: p.intent.id, amount: 2500, currency: 'gbp', metadata: p.intent.metadata };
  assert.equal((await reconcileStripePaymentEvent(mismatch)).handled, false);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, 'PENDING');
  assert.equal((await prisma.payment.findUniqueOrThrow({ where: { orderId: order.id } })).status, 'PROCESSING');
  assert.equal(await prisma.orderConfirmationJob.count({ where: { orderId: order.id } }), 0);
  const stock = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } }); assert.equal(stock.currentStock, 10); assert.equal(stock.reservedStock, 2);
});
