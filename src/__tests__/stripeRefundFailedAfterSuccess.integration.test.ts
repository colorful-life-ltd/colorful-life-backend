// G2: a Stripe refund recorded SUCCEEDED that Stripe later reports FAILED. Stage 1 (signed refund.failed
// webhook) only records the conflict; stage 2 (explicit provider reconciliation) corrects the accounting once.
import assert from "node:assert/strict";
import { after, afterEach, it } from "node:test";
import { randomUUID } from "node:crypto";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { createOrReuseStripeRefund, setStripeRefundClientForTests, type StripeRefundClient, type StripeRefundResponse } from "../domain/refunds/stripeRefundService.js";
import { createOrReusePayPalRefund, type PayPalRefundClient } from "../domain/refunds/paypalRefundService.js";
import { applyRefundObservation, RefundIntentError } from "../domain/refunds/refundLifecycleService.js";
import { reconcileExternalRefund } from "../domain/refunds/refundReconciliationService.js";
import { resolveRefundReview } from "../domain/refunds/refundReviewService.js";
import { reconcileStripeRefundEvent } from "../domain/payments/stripeReconciliationService.js";
import { cancelFullyRefundedOrder, requestPaidCancellation } from "../domain/orders/paidCancellation.js";
import { fulfilmentEligibility, startPreparing } from "../domain/fulfilment/fulfilmentService.js";

const restores: Array<() => void> = []; const oldFlag = config.REFUND_RECONCILIATION_ENABLED;
afterEach(() => { restores.splice(0).reverse().forEach(r => r()); config.REFUND_RECONCILIATION_ENABLED = oldFlag; });
after(async () => { await prisma.$disconnect(); });

async function fixture(provider: "STRIPE" | "PAYPAL" = "STRIPE") {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@failed-after-success.test`, passwordHash: "fixture", role: "ADMIN", emailVerified: true } });
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: "Failed refund fixture", theme: "TEST", ageRecommendation: "8+", pieceCount: 1 } });
  const stock = await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: 100, currentStock: 5, reservedStock: 0 } });
  const order = await prisma.order.create({ data: { userId: user.id, status: "CONFIRMED", totalAmount: 100,
    billingRecipientName: "Fixture", billingLine1: "Fixture", billingCity: "Fixture", billingPostcode: "T1", billingCountryCode: "GB",
    deliveryRecipientName: "Fixture", deliveryLine1: "Fixture", deliveryCity: "Fixture", deliveryPostcode: "T1", deliveryCountryCode: "GB",
    orderItems: { create: { productListingId: stock.id, quantity: 1, unitPrice: 100, lineTotal: 100 } } } });
  const payment = await prisma.payment.create({ data: { orderId: order.id, provider, providerReference: provider === "STRIPE" ? `pi_${randomUUID()}` : `ORDER-${randomUUID()}`,
    ...(provider === "PAYPAL" ? { providerCaptureReference: `CAP-${randomUUID()}` } : {}), amount: 100, currency: "GBP", status: "SUCCEEDED", paidAt: new Date() } });
  return { user, order, payment, stock };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type Refund = Awaited<ReturnType<typeof createOrReuseStripeRefund>>;

const remote = (f: Fixture, refund: Refund, status: string, amount = Number(refund.amount) * 100): StripeRefundResponse =>
  ({ id: refund.providerReference, amount, currency: "gbp", status, payment_intent: f.payment.providerReference,
    metadata: { local_refund_id: String(refund.id), order_id: String(f.order.id) } }) as StripeRefundResponse;
async function refunded(f: Fixture, amount: number) {
  const client: StripeRefundClient = { createRefund: async (input) => ({ id: `re_${randomUUID()}`, amount: amount * 100, currency: "gbp", status: "succeeded",
    payment_intent: f.payment.providerReference, metadata: input.metadata as Record<string, string> }) as StripeRefundResponse };
  const refund = await createOrReuseStripeRefund(f.order.id, f.payment.id, amount, undefined, f.user.id, client, undefined, randomUUID());
  assert.equal(refund.status, "SUCCEEDED");
  return refund;
}
/** The verified-webhook entry point the controller calls after Stripe signature verification. */
function webhook(f: Fixture, refund: Refund, status = "failed", id = `evt_${randomUUID()}`, type: "refund.failed" | "refund.updated" = status === "failed" ? "refund.failed" : "refund.updated") {
  return reconcileStripeRefundEvent({ id, type, refundId: refund.providerReference, paymentIntentId: f.payment.providerReference, amount: Number(refund.amount) * 100,
    currency: "gbp", status, metadata: { local_refund_id: String(refund.id), order_id: String(f.order.id) } });
}
function providerSays(f: Fixture, refund: Refund, status = "failed", amount?: number) {
  let reads = 0;
  restores.push(setStripeRefundClientForTests({ createRefund: async () => { throw new Error("no new refunds in reconciliation"); },
    retrieveRefund: async (id) => { reads++; assert.equal(id, refund.providerReference); return remote(f, refund, status, amount); } }));
  config.REFUND_RECONCILIATION_ENABLED = true;
  return { reads: () => reads };
}
const reconcile = (f: Fixture, refund: Refund) => reconcileExternalRefund(f.order.id, refund.id);
const state = (refund: Refund) => prisma.refund.findUniqueOrThrow({ where: { id: refund.id } });
async function amounts(f: Fixture) { const p = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } }); return { refunded: p.refundedAmount.toFixed(2), reserved: p.reservedRefundAmount.toFixed(2) }; }
const adjustments = (refund: Refund) => prisma.operationalAudit.count({ where: { refundId: refund.id, kind: "REFUND_FAILED_AFTER_SUCCESS" } });
const resolve = async (f: Fixture, refund: Refund, expectedRevision?: number) => resolveRefundReview(f.user.id, f.order.id, refund.id,
  { expectedRevision: expectedRevision ?? (await state(refund)).reviewRevision, reason: "Customer contacted; alternative refund arranged", evidenceReferences: ["ticket-123"] }, randomUUID());

it("a signed refund.failed webhook alone records the conflict and moves no money", async () => {
  const f = await fixture(); const refund = await refunded(f, 10);
  await webhook(f, refund);
  const current = await state(refund);
  assert.equal(current.status, "SUCCEEDED"); assert.equal(current.reviewRequired, true); assert.equal(current.resolutionCode, "TERMINAL_EVIDENCE_CONFLICT");
  assert.deepEqual(await amounts(f), { refunded: "10.00", reserved: "0.00" }); assert.equal(await adjustments(refund), 0);
  assert.deepEqual(await fulfilmentEligibility(f.order.id), { eligible: false, reason: "REFUND_REVIEW_REQUIRED" });
  await assert.rejects(createOrReuseStripeRefund(f.order.id, f.payment.id, 5, undefined, f.user.id, { createRefund: async () => { throw new Error("must not be called"); } }, undefined, randomUUID()),
    (e: unknown) => e instanceof RefundIntentError && e.code === "REFUND_UNRESOLVED");
});

it("reconciliation confirms the failure and corrects a partial refund exactly once, keeping review open", async () => {
  const f = await fixture(); const refund = await refunded(f, 10);
  await webhook(f, refund); const read = providerSays(f, refund);
  const failed = await reconcile(f, refund);
  assert.equal(failed.status, "FAILED"); assert.equal(failed.resolutionCode, "REFUND_FAILED_AFTER_SUCCESS"); assert.equal(failed.reviewRequired, true);
  assert.deepEqual(await amounts(f), { refunded: "0.00", reserved: "0.00" }); assert.equal(await adjustments(refund), 1);
  const audit = await prisma.operationalAudit.findFirstOrThrow({ where: { refundId: refund.id, kind: "REFUND_FAILED_AFTER_SUCCESS" } });
  assert.equal(audit.revision, failed.reviewRevision); assert.equal((audit.details as any).amount, "10.00"); assert.ok((audit.details as any).priorOutcome);
  await reconcile(f, refund); await webhook(f, refund);
  assert.deepEqual(await amounts(f), { refunded: "0.00", reserved: "0.00" }); assert.equal(await adjustments(refund), 1); assert.equal(read.reads(), 2);
  assert.deepEqual(await fulfilmentEligibility(f.order.id), { eligible: false, reason: "REFUND_REVIEW_REQUIRED" });
});

it("with multiple refunds only the failed one is reversed", async () => {
  const f = await fixture(); const kept = await refunded(f, 10); const failing = await refunded(f, 5);
  assert.deepEqual(await amounts(f), { refunded: "15.00", reserved: "0.00" });
  await webhook(f, failing); providerSays(f, failing); await reconcile(f, failing);
  assert.deepEqual(await amounts(f), { refunded: "10.00", reserved: "0.00" });
  const other = await state(kept); assert.equal(other.status, "SUCCEEDED"); assert.equal(other.reviewRequired, false);
});

it("duplicate and out-of-order webhooks never adjust twice or flip a failure back", async () => {
  const f = await fixture(); const refund = await refunded(f, 10); const eventId = `evt_${randomUUID()}`;
  assert.equal((await webhook(f, refund, "failed", eventId)).duplicate, false);
  assert.equal((await webhook(f, refund, "failed", eventId)).duplicate, true);
  await webhook(f, refund); // A second delivery of the same fact under a new event id.
  assert.deepEqual(await amounts(f), { refunded: "10.00", reserved: "0.00" });
  providerSays(f, refund); await reconcile(f, refund);
  await webhook(f, refund, "succeeded"); // Late refund.updated(succeeded) after the confirmed failure.
  const current = await state(refund);
  assert.equal(current.status, "FAILED"); assert.equal(current.reviewRequired, true); assert.equal(current.resolutionCode, "TERMINAL_EVIDENCE_CONFLICT");
  assert.deepEqual(await amounts(f), { refunded: "0.00", reserved: "0.00" }); assert.equal(await adjustments(refund), 1);
  // Contradictory evidence after the adjustment cannot be acknowledged away.
  await assert.rejects(resolve(f, refund), (e: unknown) => e instanceof RefundIntentError && e.code === "REFUND_FINANCIAL_RECONCILIATION_REQUIRED");
});

it("concurrent reconciliations adjust exactly once", async () => {
  const f = await fixture(); const refund = await refunded(f, 10);
  await webhook(f, refund); providerSays(f, refund);
  const results = await Promise.allSettled([reconcile(f, refund), reconcile(f, refund), reconcile(f, refund)]);
  assert.ok(results.every(r => r.status === "fulfilled"));
  assert.deepEqual(await amounts(f), { refunded: "0.00", reserved: "0.00" }); assert.equal(await adjustments(refund), 1);
  assert.equal((await state(refund)).status, "FAILED");
});

it("a mismatching provider read, or a read without a webhook conflict, moves no money", async () => {
  const f = await fixture(); const refund = await refunded(f, 10);
  await webhook(f, refund); providerSays(f, refund, "failed", 999); await reconcile(f, refund);
  let current = await state(refund);
  assert.equal(current.status, "SUCCEEDED"); assert.equal(current.resolutionCode, "PROVIDER_EVIDENCE_MISMATCH");
  providerSays(f, refund); await reconcile(f, refund); // A later correct read: the stage-1 conflict was superseded.
  current = await state(refund); assert.equal(current.status, "SUCCEEDED"); assert.deepEqual(await amounts(f), { refunded: "10.00", reserved: "0.00" });
  const g = await fixture(); const quiet = await refunded(g, 10);
  const observed = await applyRefundObservation(quiet.id, { provider: "STRIPE", reference: quiet.providerReference, parentReference: g.payment.providerReference,
    amount: "10.00", currency: "gbp", status: "FAILED", source: "GET" });
  assert.equal(observed.status, "SUCCEEDED"); assert.equal(observed.resolutionCode, "TERMINAL_EVIDENCE_CONFLICT"); assert.equal(observed.reviewRequired, true);
  assert.deepEqual(await amounts(g), { refunded: "10.00", reserved: "0.00" }); assert.equal(await adjustments(quiet), 0);
});

it("an already-cancelled, restocked order stays cancelled and undispatchable through reconciliation and resolution", async () => {
  const f = await fixture();
  await requestPaidCancellation(f.user.id, f.order.id, "Customer requested cancellation", randomUUID());
  const refund = await refunded(f, 100); const cancelKey = randomUUID();
  await cancelFullyRefundedOrder(f.user.id, f.order.id, "Customer requested cancellation", cancelKey);
  const stockAfterCancel = (await prisma.productListing.findUniqueOrThrow({ where: { id: f.stock.id } })).currentStock;
  const movements = await prisma.inventoryMovement.count({ where: { listingId: f.stock.id } });
  await webhook(f, refund); providerSays(f, refund);
  const failed = await reconcile(f, refund);
  assert.equal(failed.status, "FAILED"); assert.equal(failed.resolutionCode, "REFUND_FAILED_AFTER_CANCELLATION");
  const audit = await prisma.operationalAudit.findFirstOrThrow({ where: { refundId: refund.id, kind: "REFUND_FAILED_AFTER_SUCCESS" } });
  assert.equal((audit.details as any).paidOrderCancelled, true); assert.equal((audit.details as any).cancellationRestocks.length, 1);
  await resolve(f, refund);
  const order = await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } });
  assert.equal(order.status, "CANCELLED"); assert.equal((await state(refund)).reviewRequired, false);
  assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.stock.id } })).currentStock, stockAfterCancel);
  assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.stock.id } }), movements);
  assert.deepEqual(await fulfilmentEligibility(f.order.id), { eligible: false, reason: "ORDER_NOT_CONFIRMED" });
  await assert.rejects(startPreparing(f.user.id, f.order.id));
  assert.deepEqual(await cancelFullyRefundedOrder(f.user.id, f.order.id, "Customer requested cancellation", cancelKey), { cancelled: true, replayed: true });
  // The customer can now be made whole with a new refund; the order and stock stay untouched.
  await refunded(f, 100);
  assert.deepEqual(await amounts(f), { refunded: "100.00", reserved: "0.00" });
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, "CANCELLED");
});

it("a fenced order awaiting cancellation stays undispatchable after the failure is resolved", async () => {
  const f = await fixture();
  await requestPaidCancellation(f.user.id, f.order.id, "Customer requested cancellation", randomUUID());
  const refund = await refunded(f, 100);
  await webhook(f, refund); providerSays(f, refund); await reconcile(f, refund);
  assert.equal((await state(refund)).resolutionCode, "REFUND_FAILED_AFTER_SUCCESS");
  await resolve(f, refund);
  assert.deepEqual(await fulfilmentEligibility(f.order.id), { eligible: false, reason: "CANCELLATION_PENDING" });
});

it("review resolution requires the adjustment's own revision and never touches the order", async () => {
  const f = await fixture(); const refund = await refunded(f, 10);
  await webhook(f, refund); providerSays(f, refund); await reconcile(f, refund);
  const current = await state(refund);
  await assert.rejects(resolve(f, refund, current.reviewRevision - 1), (e: unknown) => e instanceof RefundIntentError && e.code === "REVIEW_VERSION_CONFLICT");
  assert.deepEqual(await fulfilmentEligibility(f.order.id), { eligible: false, reason: "REFUND_REVIEW_REQUIRED" });
  await resolve(f, refund, current.reviewRevision);
  assert.equal((await state(refund)).reviewRequired, false);
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, "CONFIRMED");
  // A paid, unrefunded, unfenced order follows normal eligibility once an operator has resolved the review.
  assert.deepEqual(await fulfilmentEligibility(f.order.id), { eligible: true, reason: null });
});

it("the database allows the status change only for an audited Stripe failure-after-success", async () => {
  const f = await fixture(); const refund = await refunded(f, 10);
  await assert.rejects(prisma.refund.update({ where: { id: refund.id }, data: { status: "FAILED" } }), /immutable/);
  await prisma.$executeRaw`INSERT INTO "OperationalAudit" (kind,"orderId","refundId","requestKey",details) VALUES ('REFUND_FAILED_AFTER_SUCCESS',${f.order.id},${refund.id},${`refund-failed-after-success:${refund.id}`},'{}'::jsonb)`;
  await assert.rejects(prisma.refund.update({ where: { id: refund.id }, data: { status: "FAILED", amount: 9 } }), /immutable/);
  await assert.rejects(prisma.refund.update({ where: { id: refund.id }, data: { status: "PROCESSING" } }), /immutable/);
  const g = await fixture("PAYPAL"); const reference = `PP-${randomUUID()}`;
  const pp = await createOrReusePayPalRefund(g.order.id, g.payment.id, 10, undefined, g.user.id, { refundCapture: async () => paypalCompleted(g, reference) }, undefined, randomUUID());
  await prisma.$executeRaw`INSERT INTO "OperationalAudit" (kind,"orderId","refundId","requestKey",details) VALUES ('REFUND_FAILED_AFTER_SUCCESS',${g.order.id},${pp.id},${`refund-failed-after-success:${pp.id}`},'{}'::jsonb)`;
  await assert.rejects(prisma.refund.update({ where: { id: pp.id }, data: { status: "FAILED" } }), /immutable/);
});

function paypalCompleted(f: Fixture, id: string) {
  return { id, status: "COMPLETED", amount: { value: "10.00", currency_code: "GBP" },
    links: [{ rel: "up", href: `${config.PAYPAL_BASE_URL}/v2/payments/captures/${f.payment.providerCaptureReference}` }] } as Awaited<ReturnType<PayPalRefundClient["refundCapture"]>>;
}

it("PayPal refunds keep today's behaviour: a later FAILED read is a conflict and never moves money", async () => {
  const f = await fixture("PAYPAL"); const reference = `PP-${randomUUID()}`;
  const refund = await createOrReusePayPalRefund(f.order.id, f.payment.id, 10, undefined, f.user.id, { refundCapture: async () => paypalCompleted(f, reference) }, undefined, randomUUID());
  assert.equal(refund.status, "SUCCEEDED");
  for (const source of ["WEBHOOK", "GET"] as const) {
    const observed = await applyRefundObservation(refund.id, { provider: "PAYPAL", reference, parentReference: f.payment.providerCaptureReference!, amount: "10.00", currency: "GBP", status: "FAILED", source });
    assert.equal(observed.status, "SUCCEEDED"); assert.equal(observed.resolutionCode, "TERMINAL_EVIDENCE_CONFLICT"); assert.equal(observed.reviewRequired, true);
  }
  assert.deepEqual(await amounts(f), { refunded: "10.00", reserved: "0.00" });
  assert.equal(await prisma.operationalAudit.count({ where: { refundId: refund.id, kind: "REFUND_FAILED_AFTER_SUCCESS" } }), 0);
});
