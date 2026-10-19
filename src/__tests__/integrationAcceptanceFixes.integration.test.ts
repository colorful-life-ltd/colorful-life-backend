import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { prisma } from '../prisma/runtime.js';
import app from '../app.js';
import { config } from '../config/index.js';
import { createAdminProductUpdateService } from '../domain/products/adminProductUpdateService.js';
import { getCatalogueProductById } from '../domain/products/productCatalogueService.js';
import { addCartItem } from '../domain/cart/cartService.js';
import { reviewOrder, updatePolicy, PaymentSecurityOperationError } from '../domain/security/paymentSecurityOperations.js';

let server: ReturnType<typeof app.listen>, url = '';
before(async () => { server = app.listen(0); await new Promise<void>(r => server.once('listening', r)); url = `http://127.0.0.1:${(server.address() as { port: number }).port}`; });
after(async () => { await new Promise<void>(r => server.close(() => r())); await prisma.$disconnect(); });
const user = (role: 'ADMIN' | 'CUSTOMER') => prisma.user.create({ data: { email: `${randomUUID()}@acceptance.test`, passwordHash: 'synthetic', role, emailVerified: true } });
const bearer = (u: { id: number; role: string }) => ({ Authorization: `Bearer ${jwt.sign({ id: u.id, role: u.role }, config.JWT_SECRET)}`, 'Content-Type': 'application/json' });
async function product(stock = 5) {
  const p = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: 'Acceptance', theme: 'TEST', ageRecommendation: '8+', pieceCount: 1 } });
  const listing = await prisma.productListing.create({ data: { legoProductId: p.id, condition: 'NEW', originalPrice: 20, currentStock: stock } });
  return { product: p, listing };
}

it('payment-security domain refusals are definitive 4xx responses and write nothing', async () => {
  const admin = await user('ADMIN'), headers = bearer(admin);
  const missing = await fetch(`${url}/admin/payment-security/orders/2147483000`, { method: 'POST', headers, body: JSON.stringify({ action: 'RELEASE', note: 'Mistyped order identifier' }) });
  assert.equal(missing.status, 404); assert.deepEqual(await missing.json(), { error: 'ORDER_NOT_FOUND' });
  const customer = await user('CUSTOMER');
  const order = await prisma.order.create({ data: { userId: customer.id, totalAmount: 20, status: 'CONFIRMED',
    billingRecipientName: 'A', billingLine1: '1 Road', billingCity: 'London', billingPostcode: 'SW1A 1AA', billingCountryCode: 'GB',
    deliveryRecipientName: 'A', deliveryLine1: '1 Road', deliveryCity: 'London', deliveryPostcode: 'SW1A 1AA', deliveryCountryCode: 'GB' } });
  const unpaid = await fetch(`${url}/admin/payment-security/orders/${order.id}`, { method: 'POST', headers, body: JSON.stringify({ action: 'RELEASE', note: 'Release without verified payment' }) });
  assert.equal(unpaid.status, 409); assert.deepEqual(await unpaid.json(), { error: 'VERIFIED_PAYMENT_REQUIRED' });
  assert.equal(await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int n FROM "PaymentSecurityEvent" WHERE "orderId"=${order.id}`.then(r => r[0].n), 0);
  // A deleted ADMIN's still-valid token cannot be authenticated, so exercise the domain role check directly.
  await assert.rejects(reviewOrder(customer.id, order.id, 'HOLD', 'Customer cannot place holds'), (e: unknown) => e instanceof PaymentSecurityOperationError && e.status === 403);
  await assert.rejects(updatePolicy(customer.id, 'STRIPE', true, null, 'Customer cannot change policy'), (e: unknown) => e instanceof PaymentSecurityOperationError && e.code === 'ADMIN_REQUIRED');
  const held = await fetch(`${url}/admin/payment-security/orders/${order.id}`, { method: 'POST', headers, body: JSON.stringify({ action: 'HOLD', note: 'Valid hold still succeeds' }) });
  assert.equal(held.status, 200);
});

it('a Discontinued product needs explicit confirmation and a reason to leave Discontinued; publication alone never resets it', async () => {
  const admin = await user('ADMIN'), customer = await user('CUSTOMER'), { product: p, listing } = await product(), update = createAdminProductUpdateService();
  await update.update(p.id, { availabilityState: 'DISCONTINUED', permanentDiscontinuationConfirmed: true, availabilityReason: 'Manufacturer ended production permanently' }, admin.id);
  for (const state of ['STANDARD', 'MORE_ON_THE_WAY'] as const) {
    await assert.rejects(update.update(p.id, { availabilityState: state, restockExpectationConfirmed: true, availabilityReason: 'Routine publication toggle by operator' }, admin.id), /reverse a permanent discontinuation/);
  }
  await assert.rejects(update.update(p.id, { availabilityState: 'STANDARD', discontinuationReversalConfirmed: true }, admin.id), /reason/);
  await assert.rejects(update.update(p.id, { availabilityState: 'STANDARD', discontinuationReversalConfirmed: true, availabilityReason: 'Customer wrongly reversing policy' }, customer.id), /ADMIN/);
  await update.update(p.id, { isPublished: false }); await update.update(p.id, { isPublished: true });
  let page = await getCatalogueProductById(p.id);
  assert.equal(page?.availabilityState, 'DISCONTINUED'); assert.equal(page?.availability, 'DISCONTINUED'); assert.deepEqual(page?.offers, []);
  await assert.rejects(addCartItem(customer.id, listing.id, 1));
  const http = await fetch(`${url}/admin/products/${p.id}`, { method: 'PATCH', headers: bearer(admin), body: JSON.stringify({ availabilityState: 'STANDARD', availabilityReason: 'Routine change without reversal confirmation' }) });
  assert.equal(http.status, 400);
  assert.equal((await getCatalogueProductById(p.id))?.availabilityState, 'DISCONTINUED');
  await update.update(p.id, { availabilityState: 'STANDARD', discontinuationReversalConfirmed: true, availabilityReason: 'Owner approved returning this product to sale' }, admin.id);
  page = await getCatalogueProductById(p.id);
  assert.equal(page?.availability, 'IN_STOCK'); assert.equal(page?.offers.length, 1);
  const audit = await prisma.operationalAudit.findMany({ where: { kind: 'PRODUCT_AVAILABILITY_UPDATED' }, orderBy: { id: 'desc' }, take: 1 });
  assert.deepEqual([(audit[0].details as Record<string, unknown>).previous, (audit[0].details as Record<string, unknown>).discontinuationReversalConfirmed], ['DISCONTINUED', true]);
});

it('More on the Way on a published product leaves publication unchanged', async () => {
  const admin = await user('ADMIN'), { product: p } = await product(0);
  const response = await fetch(`${url}/admin/products/${p.id}`, { method: 'PATCH', headers: bearer(admin), body: JSON.stringify({ availabilityState: 'MORE_ON_THE_WAY', restockExpectationConfirmed: true, availabilityReason: 'Supplier confirmed restock in November' }) });
  assert.equal(response.status, 200);
  const body = await response.json(); assert.equal(body.isPublished, true); assert.equal(body.availabilityState, 'MORE_ON_THE_WAY');
  assert.equal((await getCatalogueProductById(p.id))?.availability, 'MORE_ON_THE_WAY');
});

it('operator intent resolution is ADMIN-only, idempotent per intent key, immutable and visible in order audit history', async () => {
  const admin = await user('ADMIN'), customer = await user('CUSTOMER'), key = randomUUID();
  const order = await prisma.order.create({ data: { userId: customer.id, totalAmount: 20, status: 'CONFIRMED',
    billingRecipientName: 'A', billingLine1: '1 Road', billingCity: 'London', billingPostcode: 'SW1A 1AA', billingCountryCode: 'GB',
    deliveryRecipientName: 'A', deliveryLine1: '1 Road', deliveryCity: 'London', deliveryPostcode: 'SW1A 1AA', deliveryCountryCode: 'GB' } });
  const body = { operation: 'securityReview', decision: 'NOT_APPLIED', note: 'Order audit shows no security event was recorded', orderId: order.id };
  const post = (headers: Record<string, string>, payload: object, idempotencyKey: string = key) => fetch(`${url}/admin/operator-intents/resolutions`, { method: 'POST', headers: { ...headers, 'Idempotency-Key': idempotencyKey }, body: JSON.stringify(payload) });
  assert.equal((await post(bearer(customer), body)).status, 403);
  assert.equal((await post(bearer(admin), { ...body, note: 'short' })).status, 400);
  assert.equal((await post(bearer(admin), { ...body, providerReference: 'x' })).status, 400);
  assert.equal((await post(bearer(admin), body, 'bad key')).status, 400);
  assert.equal((await post(bearer(admin), { ...body, orderId: 2147483000 }, randomUUID())).status, 404);
  const [first, replay] = await Promise.all([post(bearer(admin), body), post(bearer(admin), body)]);
  const results = await Promise.all([first.json(), replay.json()]);
  assert.deepEqual([first.status, replay.status], [201, 201]);
  assert.equal(results[0].auditId, results[1].auditId); assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
  assert.equal((await post(bearer(admin), { ...body, decision: 'APPLIED' })).status, 409);
  const history = await (await fetch(`${url}/admin/orders/${order.id}/audit`, { headers: bearer(admin) })).json() as Array<{ kind: string; actorId: number; details: Record<string, unknown> }>;
  const rows = history.filter(r => r.kind === 'OPERATOR_INTENT_RESOLVED');
  assert.equal(rows.length, 1); assert.equal(rows[0].actorId, admin.id); assert.equal(rows[0].details.decision, 'NOT_APPLIED');
  await assert.rejects(prisma.$executeRaw`UPDATE "OperationalAudit" SET kind='tampered' WHERE "requestKey"=${`operator-intent:${key}`}`);
});
