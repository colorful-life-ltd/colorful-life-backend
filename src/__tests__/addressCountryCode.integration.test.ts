import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type Stripe from 'stripe';
import { simpleParser } from 'mailparser';
import app from '../app.js';
import { prisma } from '../prisma/runtime.js';
import { config } from '../config/index.js';
import { normalizeCountryCode } from '../domain/addresses/countryCode.js';
import { createOrReuseStripePaymentIntent, type StripePaymentClient } from '../domain/payments/stripePaymentService.js';
import { reconcileStripePaymentEvent } from '../domain/payments/stripeReconciliationService.js';
import { purchaseSchema } from '../domain/orderConfirmation/contract.js';
import { runConfirmationBatch } from '../domain/orderConfirmation/worker.js';
import { captureConfirmationTransport } from '../domain/orderConfirmation/delivery.js';
import { businessFixture } from './fixtures/orderConfirmation.fixture.js';

let server: ReturnType<typeof app.listen>, url: string;
const originalManaged = config.PAYMENT_RESOLUTION_ENABLED;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); const address = server.address(); assert.ok(address && typeof address !== 'string'); url = `http://127.0.0.1:${address.port}`; });
after(async () => { config.PAYMENT_RESOLUTION_ENABLED = originalManaged; await new Promise<void>((r, fail) => server.close(e => e ? fail(e) : r())); await prisma.$disconnect(); });

// Exact payload of the storefront's SavedAddresses form: the read-only Country field submits a display name.
const storefrontAddress = { recipientName: 'Synthetic Buyer', line1: '1 Fictional Road', city: 'Testville', postcode: 'T1 1TT', country: 'United Kingdom', line2: null, phone: null };

async function customer(managed = false) {
  config.PAYMENT_RESOLUTION_ENABLED = managed;
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic', emailVerified: true } });
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: 'Country fixture', theme: 'TEST', ageRecommendation: '8+', pieceCount: 1 } });
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: 'NEW', originalPrice: '12.50', currentStock: 10 } });
  return { user, listing, token: jwt.sign({ id: user.id, role: 'CUSTOMER' }, config.JWT_SECRET) };
}
type Customer = Awaited<ReturnType<typeof customer>>;
const request = (c: Customer, method: string, path: string, body?: unknown) => fetch(`${url}${path}`, { method, headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
// The storefront's checkout deliverySnapshot already converts the saved address to "GB".
const checkoutBody = (c: Customer) => ({ shippingMethod: 'STANDARD', items: [{ productListingId: c.listing.id, quantity: 1 }],
  deliveryAddress: { recipientName: 'Synthetic Buyer', line1: '1 Fictional Road', city: 'Testville', postcode: 'T1 1TT', countryCode: 'GB' } });

async function payVerified(c: Customer, orderId: number) {
  let intent!: Stripe.PaymentIntent;
  const client = { paymentIntents: {
    create: async (params: Stripe.PaymentIntentCreateParams) => (intent = { ...params, id: `pi_${randomUUID()}`, client_secret: 'synthetic', status: 'requires_payment_method' } as unknown as Stripe.PaymentIntent),
    retrieve: async () => intent,
  } } as unknown as StripePaymentClient;
  await createOrReuseStripePaymentIntent(orderId, c.user.id, client);
  await reconcileStripePaymentEvent({ id: `evt_${randomUUID()}`, type: 'payment_intent.succeeded', paymentIntentId: intent.id, amount: intent.amount, currency: 'gbp', metadata: intent.metadata as Record<string, string> });
  return prisma.orderConfirmationJob.findUniqueOrThrow({ where: { eventKey: `order:${orderId}` } });
}

it('normalises United Kingdom aliases and ISO codes, and rejects unrecognised countries', () => {
  for (const value of ['United Kingdom', ' united  kingdom ', 'UK', 'uk', 'Great Britain', 'GB', 'gb']) assert.equal(normalizeCountryCode(value), 'GB');
  assert.equal(normalizeCountryCode('us'), 'US'); assert.equal(normalizeCountryCode('IE'), 'IE');
  for (const value of ['Narnia', 'XX', 'England', '', '  ', null, undefined]) assert.equal(normalizeCountryCode(value), null);
});

it('the storefront address shape is stored and returned as an ISO country code', async () => {
  const c = await customer();
  const created = await request(c, 'POST', '/users/me/addresses', storefrontAddress); assert.equal(created.status, 201);
  const body = await created.json(); assert.equal(body.country, 'GB');
  assert.equal((await prisma.address.findUniqueOrThrow({ where: { id: body.id } })).countryCode, 'GB');
  // Editing in the storefront resubmits the display name; it stays normalised.
  const edited = await request(c, 'PATCH', `/users/me/addresses/${body.id}`, { ...storefrontAddress, city: 'Newtown' }); assert.equal(edited.status, 200);
  assert.equal((await edited.json()).country, 'GB');
  const invalid = await request(c, 'PATCH', `/users/me/addresses/${body.id}`, { country: 'Narnia' }); assert.equal(invalid.status, 400);
  assert.equal((await prisma.address.findUniqueOrThrow({ where: { id: body.id } })).countryCode, 'GB');
  assert.equal((await request(c, 'POST', '/users/me/addresses', { ...storefrontAddress, country: 'Narnia' })).status, 400);
});

for (const managed of [false, true]) it(`a storefront-registered customer gets a valid invoice source and captured invoice email (managed=${managed})`, async () => {
  const c = await customer(managed);
  assert.equal((await request(c, 'POST', '/users/me/addresses', storefrontAddress)).status, 201);
  const response = await request(c, 'POST', '/orders', checkoutBody(c)); assert.equal(response.status, 201);
  const order = await response.json();
  assert.equal(order.billingCountryCode, 'GB'); assert.equal(order.deliveryCountryCode, 'GB');
  const job = await payVerified(c, order.id);
  assert.equal(job.state, 'PENDING'); assert.equal(job.lastErrorCode, null);
  assert.equal(purchaseSchema.parse(job.source).billing.countryCode, 'GB');
  const capture = captureConfirmationTransport();
  await runConfirmationBatch({ jobId: job.id, transport: capture.transport, business: businessFixture });
  assert.equal(capture.messages.length, 1); assert.equal((await prisma.orderConfirmationJob.findUniqueOrThrow({ where: { id: job.id } })).state, 'SENT');
  const mail = await simpleParser(capture.messages[0]); assert.equal(mail.attachments.filter(a => a.contentType === 'application/pdf').length, 1);
});

it('addresses saved before normalisation are snapshotted as ISO codes at checkout', async () => {
  const c = await customer();
  // A pre-fix row exactly as the old API stored it.
  await prisma.address.create({ data: { userId: c.user.id, recipientName: 'Synthetic Buyer', line1: '1 Fictional Road', city: 'Testville', postcode: 'T1 1TT', countryCode: 'United Kingdom', isDefault: true, isDefaultBilling: true } });
  const { deliveryAddress: _omitted, ...withoutDelivery } = checkoutBody(c);
  const response = await request(c, 'POST', '/orders', withoutDelivery); assert.equal(response.status, 201);
  const order = await response.json();
  assert.equal(order.billingCountryCode, 'GB'); assert.equal(order.deliveryCountryCode, 'GB');
  assert.equal((await payVerified(c, order.id)).state, 'PENDING');
});

it('an unrecognised saved billing country is rejected before any order or reservation', async () => {
  const c = await customer();
  await prisma.address.create({ data: { userId: c.user.id, recipientName: 'Synthetic Buyer', line1: '1 Fictional Road', city: 'Testville', postcode: 'T1 1TT', countryCode: 'Narnia', isDefault: true, isDefaultBilling: true } });
  const response = await request(c, 'POST', '/orders', checkoutBody(c)); assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'BILLING_ADDRESS_COUNTRY_INVALID');
  assert.equal(await prisma.order.count({ where: { userId: c.user.id } }), 0);
  assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: c.listing.id } })).reservedStock, 0);
});

it('delivery country codes are normalised to upper case and invalid codes are rejected', async () => {
  const c = await customer();
  assert.equal((await request(c, 'POST', '/users/me/addresses', storefrontAddress)).status, 201);
  const body = checkoutBody(c);
  const lower = await request(c, 'POST', '/orders', { ...body, deliveryAddress: { ...body.deliveryAddress, countryCode: 'gb' } }); assert.equal(lower.status, 201);
  assert.equal((await lower.json()).deliveryCountryCode, 'GB');
  const invalid = await request(c, 'POST', '/orders', { ...body, deliveryAddress: { ...body.deliveryAddress, countryCode: 'XX' } }); assert.equal(invalid.status, 400);
  assert.equal(await prisma.order.count({ where: { userId: c.user.id } }), 1);
});

it('historical orders already frozen with a display-name country stay blocked and unmodified', async () => {
  const c = await customer();
  assert.equal((await request(c, 'POST', '/users/me/addresses', storefrontAddress)).status, 201);
  const order = await (await request(c, 'POST', '/orders', checkoutBody(c))).json();
  // Simulate an order created before this fix, before any payment.
  await prisma.order.update({ where: { id: order.id }, data: { billingCountryCode: 'United Kingdom' } });
  const job = await payVerified(c, order.id);
  assert.equal(job.state, 'BLOCKED'); assert.equal(job.lastErrorCode, 'PURCHASE_DATA_INVALID');
  const capture = captureConfirmationTransport();
  await runConfirmationBatch({ jobId: job.id, transport: capture.transport, business: businessFixture });
  assert.equal(capture.messages.length, 0);
  const unchanged = await prisma.orderConfirmationJob.findUniqueOrThrow({ where: { id: job.id } });
  assert.equal(unchanged.state, 'BLOCKED'); assert.deepEqual(unchanged.source, job.source);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).billingCountryCode, 'United Kingdom');
});
