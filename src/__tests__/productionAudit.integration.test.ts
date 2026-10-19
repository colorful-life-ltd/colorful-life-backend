import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type Stripe from 'stripe';
import { prisma } from '../prisma/runtime.js';
import app from '../app.js';
import { config } from '../config/index.js';
import { createOrder } from '../domain/orders/orderService.js';
import { confirmOrder } from '../domain/orders/orderConfirmationService.js';
import { startPreparing, dispatchShipment } from '../domain/fulfilment/fulfilmentService.js';
import { reconcileRefundWebhook } from '../domain/refunds/refundWebhookService.js';
import { applyRefundObservation, retainUnresolved } from '../domain/refunds/refundLifecycleService.js';
import { resolveRefundReview } from '../domain/refunds/refundReviewService.js';
import { reconcileExternalRefund } from '../domain/refunds/refundReconciliationService.js';
import { setStripeRefundClientForTests } from '../domain/refunds/stripeRefundService.js';
import { retainStripeDispute } from '../domain/payments/stripeDisputeService.js';
import { recordFbaOutbound } from '../domain/inventory/fbaOutboundService.js';
import { cancelFullyRefundedOrder } from '../domain/orders/paidCancellation.js';
import { createPayment } from '../domain/payments/paymentService.js';
let server: ReturnType<typeof app.listen>, base: string;
before(async () => { server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); base = `http://127.0.0.1:${(server.address() as {
    port: number;
}).port}`; });
after(async () => { await new Promise<void>(r => server.close(() => r())); await prisma.$disconnect(); });
async function fixture(provider: 'STRIPE' | 'PAYPAL' = 'STRIPE', paid = true) {
    const admin = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: 'synthetic', role: 'ADMIN', emailVerified: true } });
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, passwordHash: await bcrypt.hash('Correct1!', 4), emailVerified: true, addresses: { create: { recipientName: 'Synthetic', line1: '1 Test Street', city: 'London', postcode: 'SW1A 1AA', countryCode: 'GB', isDefaultBilling: true } } } });
    const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: 'Synthetic', theme: 'TEST', ageRecommendation: '8+', pieceCount: 1 } });
    const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: 'NEW', originalPrice: 20, currentStock: 10 } });
    const order = await createOrder(user.id, { shippingMethod: 'STANDARD', items: [{ productListingId: listing.id, quantity: 1 }] }, randomUUID());
    const payment = paid ? await prisma.payment.create({ data: { orderId: order.id, provider, providerReference: `provider_${randomUUID()}`, providerCaptureReference: provider === 'PAYPAL' ? `capture_${randomUUID()}` : null, status: 'SUCCEEDED', paidAt: new Date(), amount: order.totalAmount } }) : null;
    if (paid)
        await confirmOrder(admin.id, order.id);
    return { admin, user, listing, order, payment };
}
async function event(f: Awaited<ReturnType<typeof fixture>>, amount: string, status: 'SUCCEEDED' | 'FAILED' | 'PENDING' = 'SUCCEEDED', reference = randomUUID(), id = randomUUID()) {
    return reconcileRefundWebhook({ version: 2, kind: 'refund', id, provider: f.payment!.provider as 'STRIPE' | 'PAYPAL', eventType: 'synthetic.verified-refund', reference, parentReference: f.payment!.provider === 'STRIPE' ? f.payment!.providerReference : f.payment!.providerCaptureReference!, amount, currency: 'GBP', status });
}
for (const provider of ['STRIPE', 'PAYPAL'] as const) {
    it(`${provider}: external full refund prevents fulfilment, accounts once and retains provider-origin identity`, async () => {
        const f = await fixture(provider);
        const reference = randomUUID(), id = randomUUID();
        await event(f, f.order.totalAmount.toString(), 'SUCCEEDED', reference, id);
        await event(f, f.order.totalAmount.toString(), 'SUCCEEDED', reference, id);
        await event(f, f.order.totalAmount.toString(), 'SUCCEEDED', reference);
        await event(f, f.order.totalAmount.toString(), 'PENDING', reference);
        assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } })).refundedAmount.toString(), f.order.totalAmount.toString());
        const rows = await prisma.refund.findMany({ where: { paymentId: f.payment!.id } });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].performedByUserId, null);
        await assert.rejects(startPreparing(f.admin.id, f.order.id), /FULLY_REFUNDED/);
        assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).currentStock, 9);
    });
    it(`${provider}: distinct external partial refunds account exactly and preserve legitimate fulfilment`, async () => {
        const f = await fixture(provider);
        await Promise.all([event(f, '3'), event(f, '4')]);
        const p = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } });
        assert.equal(p.refundedAmount.toString(), '7');
        assert.equal(p.reservedRefundAmount.toString(), '0');
        assert.deepEqual(await startPreparing(f.admin.id, f.order.id), { changed: true });
    });
    it(`${provider}: oversized or incomplete external evidence holds without fabricated accounting`, async () => {
        const f = await fixture(provider);
        await event(f, '100');
        await assert.rejects(startPreparing(f.admin.id, f.order.id), /refund evidence/);
        assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } })).refundedAmount.toString(), '0');
    });
    it(`${provider}: external refund after dispatch never reverses inventory or order`, async () => {
        const f = await fixture(provider);
        await dispatchShipment(f.admin.id, f.order.id, { carrier: 'ROYAL_MAIL', carrierName: 'Royal Mail', trackingNumber: 'AB123456789GB', actualShippingCost: 3 });
        await event(f, f.order.totalAmount.toString());
        assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'DISPATCHED');
        assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).currentStock, 9);
    });
}
it('out-of-order contradictory external finality opens review without reversing accounting', async () => {
    const f = await fixture();
    const ref = randomUUID();
    await event(f, '5', 'FAILED', ref);
    await event(f, '5', 'SUCCEEDED', ref);
    const r = await prisma.refund.findFirstOrThrow({ where: { paymentId: f.payment!.id } });
    assert.equal(r.status, 'FAILED');
    assert.equal(r.reviewRequired, true);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } })).refundedAmount.toString(), '0');
    await assert.rejects(startPreparing(f.admin.id, f.order.id));
});
it('late POST validation conflict after terminal refund survives and journal is immutable', async () => {
    const f = await fixture();
    await event(f, '5');
    const r = await prisma.refund.findFirstOrThrow({ where: { paymentId: f.payment!.id } });
    await retainUnresolved(r.id, 'PROVIDER_EVIDENCE_MISMATCH', true, { issue: 'late-post-identity' });
    const current = await prisma.refund.findUniqueOrThrow({ where: { id: r.id } });
    assert.equal(current.status, 'SUCCEEDED');
    assert.equal(current.reviewRequired, true);
    assert.equal(current.reviewRevision, 1);
    await assert.rejects(prisma.$executeRaw `UPDATE "OperationalAudit" SET kind='ALTERED' WHERE "refundId"=${r.id}`);
});
it('review requires corroborated provider GET, preserves money and reopens revision-safely', async () => {
    const f = await fixture();
    await event(f, '5');
    const r = await prisma.refund.findFirstOrThrow({ where: { paymentId: f.payment!.id } });
    await retainUnresolved(r.id, 'PROVIDER_EVIDENCE_MISMATCH', true, { issue: 'late-incomplete-response' });
    const input = { expectedRevision: 1, reason: 'Provider GET corroborates frozen terminal refund', evidenceReferences: ['provider-record'] }, key = randomUUID();
    await assert.rejects(resolveRefundReview(f.user.id, f.order.id, r.id, input, key), /FORBIDDEN/);
    await assert.rejects(resolveRefundReview(f.admin.id, f.order.id, r.id, input, key), /FINANCIAL_RECONCILIATION_REQUIRED/);
    const original = config.REFUND_RECONCILIATION_ENABLED;
    config.REFUND_RECONCILIATION_ENABLED = true;
    const restore = setStripeRefundClientForTests({ createRefund: async () => { throw new Error('No POST allowed'); }, retrieveRefund: async () => ({ id: r.providerReference, payment_intent: f.payment!.providerReference, amount: 500, currency: 'gbp', status: 'succeeded', metadata: {} }) });
    try {
        await reconcileExternalRefund(f.order.id, r.id);
    }
    finally {
        restore();
        config.REFUND_RECONCILIATION_ENABLED = original;
    }
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } });
    await resolveRefundReview(f.admin.id, f.order.id, r.id, input, key);
    assert.equal((await prisma.refund.findUniqueOrThrow({ where: { id: r.id } })).reviewRequired, false);
    await retainUnresolved(r.id, 'PROVIDER_EVIDENCE_MISMATCH', true, { issue: 'new-conflict' });
    await resolveRefundReview(f.admin.id, f.order.id, r.id, input, key); // old replay cannot clear reopened review
    assert.equal((await prisma.refund.findUniqueOrThrow({ where: { id: r.id } })).reviewRequired, true);
    await assert.rejects(resolveRefundReview(f.admin.id, f.order.id, r.id, input, randomUUID()), /VERSION_CONFLICT/);
    assert.deepEqual(await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } }), before);
});
it('unpaid legacy orders cannot confirm or consume stock', async () => {
    const f = await fixture('STRIPE', false);
    const before = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } });
    await assert.rejects(confirmOrder(f.admin.id, f.order.id));
    assert.deepEqual(await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } }), before);
});
it('FBA duplicate shipment identities serialize across different request keys', async () => {
    const f = await fixture();
    const shipmentReference = randomUUID();
    const body = { productListingId: f.listing.id, shipmentReference, quantity: 2, note: 'Synthetic FBA outbound' };
    const results = await Promise.allSettled([recordFbaOutbound({ ...body, idempotencyKey: randomUUID() }, f.admin.id), recordFbaOutbound({ ...body, idempotencyKey: randomUUID() }, f.admin.id)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).currentStock, 7);
});
it('oversized physical shipment records actual, applied and shortfall without fabricated stock', async () => {
    const f = await fixture();
    const result = await recordFbaOutbound({ productListingId: f.listing.id, shipmentReference: randomUUID(), quantity: 12, note: 'Actual synthetic shipment discrepancy', idempotencyKey: randomUUID() }, f.admin.id);
    assert.equal(result.outbound.quantity, 12);
    assert.equal(result.outbound.appliedQuantity, 9);
    assert.equal(result.outbound.shortfall, 3);
    assert.equal(result.inventory.currentStock, 0);
});
it('fully refunded cancellation restores stock once; no refund or provider mutation occurs', async () => {
    const f = await fixture();
    await assert.rejects(cancelFullyRefundedOrder(f.admin.id, f.order.id, 'Seller cancellation requested', randomUUID()), /FULL_REFUND_REQUIRED/);
    await event(f, f.order.totalAmount.toString());
    const key = randomUUID();
    await cancelFullyRefundedOrder(f.admin.id, f.order.id, 'Seller cancellation requested', key);
    await cancelFullyRefundedOrder(f.admin.id, f.order.id, 'Seller cancellation requested', key);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).currentStock, 10);
    assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.listing.id, type: 'ORDER_CANCELLATION_RETURN' } }), 1);
});
it('dispute evidence blocks fulfilment without mutating money, and delayed closed events never release it', async () => {
    const f = await fixture();
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } });
    const dispute = { id: `dp_${randomUUID()}`, payment_intent: f.payment!.providerReference, status: 'needs_response', amount: 2399, currency: 'gbp' } as Stripe.Dispute;
    await retainStripeDispute(randomUUID(), 'charge.dispute.created', dispute);
    await retainStripeDispute(randomUUID(), 'charge.dispute.closed', { ...dispute, status: 'won' });
    await assert.rejects(startPreparing(f.admin.id, f.order.id), /DISPUTE/);
    assert.deepEqual(await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } }), before);
});
it('manual bank payments require active ADMIN and immutable evidence audit', async () => {
    const f = await fixture('STRIPE', false);
    const input = { providerReference: randomUUID(), reason: 'Verified synthetic bank receipt', evidenceReference: 'synthetic-bank-reference' };
    await assert.rejects(createPayment(f.order.id, input));
    await assert.rejects(createPayment(f.order.id, input, f.user.id), /ADMIN_REQUIRED/);
    await createPayment(f.order.id, input, f.admin.id);
    await createPayment(f.order.id, input, f.admin.id);
    const audit = await prisma.$queryRaw<Array<{
        actorId: number;
    }>> `SELECT "actorId" FROM "OperationalAudit" WHERE "orderId"=${f.order.id} AND kind='MANUAL_PAYMENT_RECORDED'`;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actorId, f.admin.id);
});
it('HTTP enforces reauthentication, password revocation, idempotency and security headers', async () => {
    const f = await fixture('STRIPE', false);
    const token = jwt.sign({ id: f.user.id }, config.JWT_SECRET);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/users/me', { method: 'DELETE', headers })).status, 403);
    assert.equal((await fetch(base + '/orders', { method: 'POST', headers, body: JSON.stringify({ shippingMethod: 'STANDARD', items: [{ productListingId: f.listing.id, quantity: 1 }] }) })).status, 400);
    assert.equal((await fetch(base + '/users/me/password', { method: 'POST', headers, body: JSON.stringify({ currentPassword: 'Wrong1!', newPassword: 'Replacement1!' }) })).status, 403);
    assert.equal((await fetch(base + '/users/me/password', { method: 'POST', headers, body: JSON.stringify({ currentPassword: 'Correct1!', newPassword: 'Replacement1!' }) })).status, 204);
    assert.equal((await fetch(base + '/users/me', { headers })).status, 401);
    const health = await fetch(base + '/ready');
    assert.equal(health.status, 200);
    assert.equal(health.headers.get('x-powered-by'), null);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
});
it('pending external refund holds capacity; definitive failure releases exactly once', async () => {
    const f = await fixture();
    const reference = randomUUID();
    await event(f, '5', 'PENDING', reference);
    await assert.rejects(startPreparing(f.admin.id, f.order.id), /REFUND_IN_PROGRESS/);
    await event(f, '5', 'FAILED', reference);
    await event(f, '5', 'FAILED', reference);
    const p = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } });
    assert.equal(p.reservedRefundAmount.toString(), '0');
    assert.equal(p.refundedAmount.toString(), '0');
    assert.deepEqual(await startPreparing(f.admin.id, f.order.id), { changed: true });
});
it('paid cancellation request fences dispatch before any provider refund', async () => {
    const { requestPaidCancellation } = await import('../domain/orders/paidCancellation.js');
    const f = await fixture();
    const key = randomUUID();
    await requestPaidCancellation(f.admin.id, f.order.id, 'Customer requested seller cancellation', key);
    await requestPaidCancellation(f.admin.id, f.order.id, 'Customer requested seller cancellation', key);
    await assert.rejects(startPreparing(f.admin.id, f.order.id), /CANCELLATION_PENDING/);
    await assert.rejects(dispatchShipment(f.admin.id, f.order.id, { carrier: 'ROYAL_MAIL', carrierName: 'Royal Mail', trackingNumber: 'AB123456789GB', actualShippingCost: 3 }), /CANCELLATION_PENDING/);
    assert.equal(await prisma.refund.count({ where: { paymentId: f.payment!.id } }), 0);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).currentStock, 9);
});
it('verified email replacement requires reauthentication and invalidates old credentials', async () => {
    const f = await fixture();
    const token = jwt.sign({ id: f.user.id }, config.JWT_SECRET);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    assert.equal((await fetch(base + '/users/me/email', { method: 'PATCH', headers, body: JSON.stringify({ email: `${randomUUID()}@example.test`, password: 'Incorrect1!' }) })).status, 403);
    const email = `${randomUUID()}@example.test`;
    assert.equal((await fetch(base + '/users/me/email', { method: 'PATCH', headers, body: JSON.stringify({ email, password: 'Correct1!' }) })).status, 200);
    const changed = await prisma.user.findUniqueOrThrow({ where: { id: f.user.id } });
    assert.equal(changed.email, email);
    assert.equal(changed.emailVerified, false);
    assert.equal((await fetch(base + '/users/me', { headers })).status, 401);
});
it('oversized FBA records a shortage, preserves reservations and blocks new commitments until audited stocktake', async () => {
    const { reconcileStocktake } = await import('../domain/inventory/inventoryAdjustmentService.js');
    const f = await fixture('STRIPE', false);
    const before = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } });
    const result = await recordFbaOutbound({ productListingId: f.listing.id, shipmentReference: randomUUID(), quantity: 12, note: 'Synthetic physical discrepancy', idempotencyKey: randomUUID() }, f.admin.id);
    assert.equal(result.outbound.quantity, 12);
    assert.equal(result.outbound.appliedQuantity, 9);
    assert.equal(result.outbound.shortfall, 3);
    const shortage = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } });
    assert.equal(shortage.currentStock, 1);
    assert.equal(shortage.reservedStock, before.reservedStock);
    await assert.rejects(createOrder(f.user.id, { shippingMethod: 'STANDARD', items: [{ productListingId: f.listing.id, quantity: 1 }] }, randomUUID()), /DISCREPANCY/);
    await assert.rejects(reconcileStocktake({ productListingId: f.listing.id, actualStock: 0, performedByUserId: f.admin.id, reasonNote: 'Inspected physical shortage' }));
    await assert.rejects(reconcileStocktake({ productListingId: f.listing.id, actualStock: 3, performedByUserId: f.admin.id }));
    await reconcileStocktake({ productListingId: f.listing.id, actualStock: 3, performedByUserId: f.admin.id, reasonNote: 'Synthetic warehouse recount finds sufficient units' });
    await createOrder(f.user.id, { shippingMethod: 'STANDARD', items: [{ productListingId: f.listing.id, quantity: 1 }] }, randomUUID());
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } })).reservedStock, 2);
});
it('readiness returns503 on database failure without leaking the exception', async () => {
    const original = prisma.$queryRaw;
    prisma.$queryRaw = (() => Promise.reject(new Error('sensitive-connection-details'))) as typeof prisma.$queryRaw;
    try {
        const response = await fetch(base + '/ready');
        assert.equal(response.status, 503);
        assert.doesNotMatch(await response.text(), /sensitive/);
    }
    finally {
        prisma.$queryRaw = original;
    }
});
it('cart worker shutdown awaits in-flight work and does not launch another sweep', async () => {
    const { startCartReconciliationWorker } = await import('../domain/cart/cartProvenanceService.js');
    const original = prisma.orderCartProvenance.findMany;
    let finish!: (value: never[]) => void, calls = 0;
    prisma.orderCartProvenance.findMany = (() => { calls++; return new Promise<never[]>(r => { finish = r; }); }) as typeof original;
    try {
        const stop = startCartReconciliationWorker(1);
        let drained = false;
        const pending = stop().then(() => { drained = true; });
        await Promise.resolve();
        assert.equal(drained, false);
        finish([]);
        await pending;
        assert.equal(drained, true);
        assert.equal(calls, 1);
    }
    finally {
        prisma.orderCartProvenance.findMany = original;
    }
});
async function reviewedFixture() {
    const f = await fixture();
    await event(f, '5');
    const r = await prisma.refund.findFirstOrThrow({ where: { paymentId: f.payment!.id } });
    await retainUnresolved(r.id, 'PROVIDER_EVIDENCE_MISMATCH', true, { issue: 'review-race' });
    const original = config.REFUND_RECONCILIATION_ENABLED;
    config.REFUND_RECONCILIATION_ENABLED = true;
    const restore = setStripeRefundClientForTests({ createRefund: async () => { throw Error('No POST'); }, retrieveRefund: async () => ({ id: r.providerReference, payment_intent: f.payment!.providerReference, amount: 500, currency: 'gbp', status: 'succeeded', metadata: {} }) });
    try {
        await reconcileExternalRefund(f.order.id, r.id);
    }
    finally {
        restore();
        config.REFUND_RECONCILIATION_ENABLED = original;
    }
    return { f, r, input: { expectedRevision: 1, reason: 'Verified provider GET explains the stale conflict', evidenceReferences: ['provider-read'] } };
}
async function serializedRace(orderId: number, first: () => Promise<unknown>, second: () => Promise<unknown>) {
    let entered!: (pid: number) => void, release!: () => void;
    const ready = new Promise<number>(r => { entered = r; });
    const gate = new Promise<void>(r => { release = r; });
    const holder = prisma.$transaction(async (tx) => {
        await tx.$queryRaw `SELECT id FROM "Order" WHERE id=${orderId} FOR NO KEY UPDATE`;
        const [pid] = await tx.$queryRaw<Array<{
            pid: number;
        }>> `SELECT pg_backend_pid() pid`;
        entered(pid.pid);
        await gate;
    }, { timeout: 15000 });
    const pid = await ready;
    const waiting = async (n: number) => {
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline) {
            const [row] = await prisma.$queryRaw<Array<{
                n: number;
            }>> `WITH RECURSIVE waiters AS (
   SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${pid}=ANY(pg_blocking_pids(pid))
   UNION SELECT a.pid FROM pg_stat_activity a JOIN waiters w ON w.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()) SELECT count(*)::int n FROM waiters`;
            if (row.n >= n)
                return;
            await new Promise<void>(r => setTimeout(r, 10));
        }
        throw Error('Expected database lock contention not observed');
    };
    let a!: Promise<unknown>, b!: Promise<unknown>;
    try {
        a = first();
        await waiting(1);
        b = second();
        await waiting(2);
    }
    finally {
        release();
        await holder;
    }
    return Promise.allSettled([a, b]);
}
for (const conflictFirst of [false, true])
    it(`review resolution and contradictory observation serialize safely (conflictFirst=${conflictFirst})`, async () => {
        const { f, r, input } = await reviewedFixture();
        const resolve = () => resolveRefundReview(f.admin.id, f.order.id, r.id, input, randomUUID());
        const conflict = () => retainUnresolved(r.id, 'PROVIDER_EVIDENCE_MISMATCH', true, { issue: 'fresh-after-review' });
        const results = await serializedRace(f.order.id, conflictFirst ? conflict : resolve, conflictFirst ? resolve : conflict);
        if (conflictFirst)
            assert.equal(results[1].status, 'rejected');
        else
            assert.ok(results.every(v => v.status === 'fulfilled'));
        const current = await prisma.refund.findUniqueOrThrow({ where: { id: r.id } });
        assert.equal(current.reviewRequired, true);
        assert.equal(current.reviewRevision, 2);
        assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } })).refundedAmount.toString(), '5');
    });
it('concurrent exact review resolution replays append one immutable decision', async () => {
    const { f, r, input } = await reviewedFixture();
    const key = randomUUID();
    const results = await Promise.all([resolveRefundReview(f.admin.id, f.order.id, r.id, input, key), resolveRefundReview(f.admin.id, f.order.id, r.id, input, key)]);
    assert.equal(results[0].auditId, results[1].auditId);
    assert.equal(results.filter(v => v.replayed).length, 1);
    const [row] = await prisma.$queryRaw<Array<{
        n: number;
    }>> `SELECT count(*)::int n FROM "OperationalAudit" WHERE "refundId"=${r.id} AND kind='REFUND_REVIEW_RESOLVED'`;
    assert.equal(row.n, 1);
});
it('a later malformed observation cannot hide an earlier genuine terminal contradiction from review resolution', async () => {
    const f = await fixture();
    const ref = randomUUID();
    await event(f, '5', 'FAILED', ref);
    await event(f, '5', 'SUCCEEDED', ref);
    const r = await prisma.refund.findFirstOrThrow({ where: { paymentId: f.payment!.id } });
    await retainUnresolved(r.id, 'PROVIDER_EVIDENCE_MISMATCH', true, { issue: 'later-malformed-response' });
    const original = config.REFUND_RECONCILIATION_ENABLED;
    config.REFUND_RECONCILIATION_ENABLED = true;
    const restore = setStripeRefundClientForTests({ createRefund: async () => { throw Error('No POST'); }, retrieveRefund: async () => ({ id: ref, payment_intent: f.payment!.providerReference, amount: 500, currency: 'gbp', status: 'failed', metadata: {} }) });
    try {
        await reconcileExternalRefund(f.order.id, r.id);
    }
    finally {
        restore();
        config.REFUND_RECONCILIATION_ENABLED = original;
    }
    const current = await prisma.refund.findUniqueOrThrow({ where: { id: r.id } });
    await assert.rejects(resolveRefundReview(f.admin.id, f.order.id, r.id, { expectedRevision: current.reviewRevision, reason: 'Cannot acknowledge away contradictory financial proof', evidenceReferences: ['provider-read'] }, randomUUID()), /FINANCIAL_RECONCILIATION_REQUIRED/);
    assert.equal((await prisma.refund.findUniqueOrThrow({ where: { id: r.id } })).reviewRequired, true);
});
it('signed Stripe disputes deduplicate concurrent delivery; invalid signatures mutate nothing',async()=>{
 const Stripe=(await import('stripe')).default;const f=await fixture();
 const before=await prisma.payment.findUniqueOrThrow({where:{id:f.payment!.id}});const original=[config.STRIPE_SECRET_KEY,config.STRIPE_WEBHOOK_SECRET];
 config.STRIPE_SECRET_KEY='sk_test_synthetic';config.STRIPE_WEBHOOK_SECRET='whsec_synthetic_audit_only';
 const id=`evt_${randomUUID()}`;const payload=JSON.stringify({id,type:'charge.dispute.created',data:{object:{id:`dp_${randomUUID()}`,payment_intent:f.payment!.providerReference,status:'needs_response',amount:f.order.totalAmount.mul(100).toNumber(),currency:'gbp'}}});
 try{
  const send=(signature:string)=>fetch(base+'/payments/stripe/webhook',{method:'POST',headers:{'Content-Type':'application/json','stripe-signature':signature},body:payload});
  assert.equal((await send('invalid')).status,400);assert.equal(await prisma.paymentWebhookEvent.count({where:{providerEventId:id}}),0);
  assert.deepEqual(await prisma.payment.findUniqueOrThrow({where:{id:f.payment!.id}}),before);
  const signature=Stripe.webhooks.generateTestHeaderString({payload,secret:config.STRIPE_WEBHOOK_SECRET});
  const responses=await Promise.all([send(signature),send(signature),send(signature)]);assert.ok(responses.every(r=>r.status===200));
  assert.equal(await prisma.paymentWebhookEvent.count({where:{providerEventId:id}}),1);await assert.rejects(startPreparing(f.admin.id,f.order.id),/DISPUTE/);
  assert.deepEqual(await prisma.payment.findUniqueOrThrow({where:{id:f.payment!.id}}),before);
 }finally{[config.STRIPE_SECRET_KEY,config.STRIPE_WEBHOOK_SECRET]=original;}
});
it('malformed JSON receives a safe response without reflecting input',async()=>{
 const response=await fetch(base+'/users/me/password',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"secret-canary":'});
 assert.equal(response.status,400);assert.doesNotMatch(await response.text(),/secret-canary|SyntaxError|stack/);
});
it('HTTP rejects unsupported delivery fallback before reservation and keeps public stock available-only',async()=>{
 const f=await fixture('STRIPE',false);await prisma.address.updateMany({where:{userId:f.user.id},data:{countryCode:'US'}});
 const headers={Authorization:`Bearer ${jwt.sign({id:f.user.id},config.JWT_SECRET)}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()};
 const response=await fetch(base+'/orders',{method:'POST',headers,body:JSON.stringify({shippingMethod:'STANDARD',items:[{productListingId:f.listing.id,quantity:1}]})});
 assert.equal(response.status,400);assert.equal((await response.json()).error.code,'DELIVERY_COUNTRY_UNSUPPORTED');
 assert.equal(await prisma.order.count({where:{userId:f.user.id}}),1);assert.equal((await prisma.productListing.findUniqueOrThrow({where:{id:f.listing.id}})).reservedStock,1);
 const detail=await (await fetch(base+`/products/${f.listing.id}`)).json();assert.equal(detail.currentStock,9);assert.equal('reservedStock' in detail,false);
 const allowed=await fetch(base+'/health',{headers:{Origin:'http://localhost:5173'}});assert.equal(allowed.headers.get('access-control-allow-origin'),'http://localhost:5173');
 const denied=await fetch(base+'/health',{headers:{Origin:'https://untrusted.invalid'}});assert.equal(denied.headers.get('access-control-allow-origin'),null);
});
for(const provider of ['STRIPE','PAYPAL'] as const)it(`${provider}: historical provider refund evidence holds the owning order without attributing it to a new attempt`,async()=>{
 const f=await fixture(provider);const oldReference=`old_${randomUUID()}`,oldCapture=`oldcap_${randomUUID()}`;
 await prisma.paymentAttempt.create({data:{orderId:f.order.id,paymentId:f.payment!.id,provider,amount:f.order.totalAmount,currency:'GBP',historical:true,providerReference:oldReference,...(provider==='PAYPAL'?{providerCaptureReference:oldCapture}:{})}});
 await reconcileRefundWebhook({version:2,kind:'refund',provider,id:randomUUID(),eventType:'synthetic.verified-refund',reference:randomUUID(),parentReference:provider==='STRIPE'?oldReference:oldCapture,amount:'5',currency:'GBP',status:'SUCCEEDED'});
 await assert.rejects(startPreparing(f.admin.id,f.order.id),/refund evidence/);
 assert.equal(await prisma.refund.count({where:{paymentId:f.payment!.id}}),0);assert.equal((await prisma.payment.findUniqueOrThrow({where:{id:f.payment!.id}})).refundedAmount.toString(),'0');
});
it('ordinary incomplete refund evidence can be replayed against later immutable provider finality without moving money twice',async()=>{
 const {processRefundWebhookReceipt}=await import('../domain/refunds/refundWebhookService.js');const f=await fixture(),ref=randomUUID(),id=randomUUID();
 await reconcileRefundWebhook({version:2,kind:'refund',provider:'STRIPE',id,eventType:'refund.updated',reference:ref,parentReference:f.payment!.providerReference,status:'UNKNOWN'});
 await event(f,'5','SUCCEEDED',ref);await assert.rejects(startPreparing(f.admin.id,f.order.id),/refund evidence/);
 const receipt=await prisma.paymentWebhookEvent.findUniqueOrThrow({where:{provider_providerEventId:{provider:'STRIPE',providerEventId:id}}});
 assert.deepEqual(await processRefundWebhookReceipt(receipt.id),{handled:true,processed:true});
 assert.deepEqual(await startPreparing(f.admin.id,f.order.id),{changed:true});assert.equal((await prisma.payment.findUniqueOrThrow({where:{id:f.payment!.id}})).refundedAmount.toString(),'5');
 const current=await prisma.paymentWebhookEvent.findUniqueOrThrow({where:{id:receipt.id}});assert.deepEqual(current.evidence,receipt.evidence);assert.equal(current.processingError,null);
});
it('operator replay requires ADMIN, reason and stable identity, and records one immutable audit',async()=>{
 const f=await fixture(),ref=randomUUID(),id=randomUUID();await reconcileRefundWebhook({version:2,kind:'refund',provider:'STRIPE',id,eventType:'refund.updated',reference:ref,parentReference:f.payment!.providerReference,status:'UNKNOWN'});
 await event(f,'5','SUCCEEDED',ref);const receipt=await prisma.paymentWebhookEvent.findUniqueOrThrow({where:{provider_providerEventId:{provider:'STRIPE',providerEventId:id}}});
 const key=randomUUID(),reason='Corroborate the retained incomplete receipt against terminal proof';
 const call=(userId:number,body:object)=>fetch(base+`/admin/refund-reviews/provider-evidence/${receipt.id}/replay`,{method:'POST',headers:{Authorization:`Bearer ${jwt.sign({id:userId},config.JWT_SECRET)}`,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});
 assert.equal((await call(f.user.id,{reason})).status,403);assert.equal((await call(f.admin.id,{})).status,400);
 assert.equal((await call(f.admin.id,{reason})).status,200);assert.equal((await call(f.admin.id,{reason})).status,200);
 assert.equal((await call(f.admin.id,{reason:'Different operator request under the same key'})).status,409);
 const audits=await prisma.operationalAudit.findMany({where:{requestKey:`refund-replay:${key}`}});assert.equal(audits.length,1);assert.equal(audits[0].actorId,f.admin.id);
 assert.equal((await prisma.payment.findUniqueOrThrow({where:{id:f.payment!.id}})).refundedAmount.toString(),'5');
});
it('manual review HTTP contract rejects financial overrides and protects evidence reads',async()=>{
 const {f,r,input}=await reviewedFixture();const headers=(id:number)=>({Authorization:`Bearer ${jwt.sign({id},config.JWT_SECRET)}`,'Content-Type':'application/json','Idempotency-Key':randomUUID()});
 const path=base+`/admin/refund-reviews/${f.order.id}/${r.id}`;
 assert.equal((await fetch(path,{headers:headers(f.user.id)})).status,403);
 assert.equal((await fetch(path+'/resolve',{method:'POST',headers:headers(f.admin.id),body:JSON.stringify({...input,status:'FAILED',amount:0})})).status,400);
 assert.equal((await prisma.refund.findUniqueOrThrow({where:{id:r.id}})).reviewRequired,true);
 assert.equal((await fetch(path+'/resolve',{method:'POST',headers:headers(f.admin.id),body:JSON.stringify(input)})).status,200);
 assert.equal((await prisma.refund.findUniqueOrThrow({where:{id:r.id}})).status,'SUCCEEDED');
});

it('a dispute received after dispatch retains evidence and alerts without reversing money or stock', async () => {
    const f = await fixture();
    await dispatchShipment(f.admin.id, f.order.id, { carrier: 'ROYAL_MAIL', carrierName: 'Royal Mail', trackingNumber: 'AB123456789GB', actualShippingCost: 3 });
    const paymentBefore = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } });
    const listingBefore = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } });
    const original = console.warn;
    const warnings: string[] = [];
    const eventId = randomUUID();
    console.warn = message => { warnings.push(String(message)); };
    try {
        await retainStripeDispute(eventId, 'charge.dispute.updated', {
            id: `dp_${randomUUID()}`, payment_intent: f.payment!.providerReference,
            status: 'under_review', amount: 2399, currency: 'gbp',
        } as Stripe.Dispute);
    } finally { console.warn = original; }
    assert.ok(warnings.some(message => JSON.parse(message).kind === 'PROVIDER_DISPUTE_REVIEW_REQUIRED'));
    const receipt = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: 'STRIPE', providerEventId: eventId } } });
    assert.equal(receipt.processingError, 'STRIPE_DISPUTE_REVIEW_REQUIRED');
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'DISPATCHED');
    assert.deepEqual(await prisma.payment.findUniqueOrThrow({ where: { id: f.payment!.id } }), paymentBefore);
    assert.deepEqual(await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } }), listingBefore);
});

it('paid cancellation refuses dispatched orders even after a finalized full external refund', async () => {
    const { requestPaidCancellation } = await import('../domain/orders/paidCancellation.js');
    const f = await fixture();
    await dispatchShipment(f.admin.id, f.order.id, { carrier: 'ROYAL_MAIL', carrierName: 'Royal Mail', trackingNumber: 'AB123456789GB', actualShippingCost: 3 });
    await event(f, f.order.totalAmount.toString());
    const before = await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } });
    await assert.rejects(requestPaidCancellation(f.admin.id, f.order.id, 'Cancellation arrived after shipment', randomUUID()), /ORDER_NOT_CANCELLABLE/);
    await assert.rejects(cancelFullyRefundedOrder(f.admin.id, f.order.id, 'Cancellation arrived after shipment', randomUUID()), /ORDER_NOT_CANCELLABLE/);
    assert.deepEqual(await prisma.productListing.findUniqueOrThrow({ where: { id: f.listing.id } }), before);
    assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.listing.id, type: 'ORDER_CANCELLATION_RETURN' } }), 0);
});
