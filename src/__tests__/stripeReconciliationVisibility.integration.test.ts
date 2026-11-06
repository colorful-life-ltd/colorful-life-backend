import assert from "node:assert/strict";
import { after, afterEach, before, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { Decimal } from "@prisma/client/runtime/client";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { reconcileStripePaymentEvent } from "../domain/payments/stripeReconciliationService.js";
import { classifyStripeReconciliationError } from "../domain/payments/stripeReconciliationVisibility.js";

const saved = { ...config };
const userIds: number[] = [], orderIds: number[] = [], listingIds: number[] = [], productIds: number[] = [];
let server: Server, url = "";
before(async () => {
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(() => { Object.assign(config, saved); });
after(async () => {
  // Receipts and operational audit are durable evidence; only disposable fixtures are removed.
  await prisma.payment.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => undefined);
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => undefined);
  await prisma.productListing.deleteMany({ where: { id: { in: listingIds } } }).catch(() => undefined);
  await prisma.legoProduct.deleteMany({ where: { id: { in: productIds } } }).catch(() => undefined);
  await new Promise<void>(r => server.close(() => r()));
  await prisma.$disconnect();
});

const user = async (role: "ADMIN" | "CUSTOMER" = "CUSTOMER") => {
  const created = await prisma.user.create({ data: { email: `${randomUUID()}@reconciliation.test`, passwordHash: "fixture", role, emailVerified: true } });
  userIds.push(created.id);
  return { id: created.id, token: jwt.sign({ id: created.id }, config.JWT_SECRET) };
};
// The singleton-Admin index is a production invariant; this suite reuses one Admin when present.
const admin = async () => {
  const existing = await prisma.user.findFirst({ where: { role: "ADMIN", deletedAt: null } });
  return existing ? { id: existing.id, token: jwt.sign({ id: existing.id, credentialVersion: existing.credentialVersion }, config.JWT_SECRET) } : user("ADMIN");
};

/** A PENDING order with a correctly correlated Stripe payment that has not yet succeeded. */
async function stripeOrder() {
  const customer = await user();
  const product = await prisma.legoProduct.create({ data: { setNumber: `R${randomUUID().slice(0, 8)}`, title: "Reconciliation fixture", theme: "Test", ageRecommendation: "18+", pieceCount: 1 } });
  productIds.push(product.id);
  const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: new Decimal(20), currentStock: 4, reservedStock: 1, active: true } });
  listingIds.push(listing.id);
  const order = await prisma.order.create({ data: {
    userId: customer.id, status: "PENDING", totalAmount: 20,
    billingRecipientName: "Customer", billingLine1: "1 Test Street", billingCity: "Testville", billingPostcode: "T1", billingCountryCode: "GB",
    deliveryRecipientName: "Customer", deliveryLine1: "1 Test Street", deliveryCity: "Testville", deliveryPostcode: "T1", deliveryCountryCode: "GB",
    orderItems: { create: { productListingId: listing.id, quantity: 1, unitPrice: 20, lineTotal: 20 } },
  } });
  orderIds.push(order.id);
  const paymentIntentId = `pi_${randomUUID().replace(/-/g, "")}`;
  const payment = await prisma.payment.create({ data: { orderId: order.id, amount: 20, currency: "GBP", provider: "STRIPE", providerReference: paymentIntentId, status: "PROCESSING" } });
  return { order, payment, listing, paymentIntentId };
}
const succeeded = (eventId: string, f: { order: { id: number }; paymentIntentId: string }) => reconcileStripePaymentEvent({
  id: eventId, type: "payment_intent.succeeded", paymentIntentId: f.paymentIntentId, amount: 2000, currency: "gbp", metadata: { orderId: String(f.order.id) },
});
type Entry = Record<string, unknown> & { receiptId: string; orderId: number };
const read = async (token: string) => {
  const response = await fetch(`${url}/admin/payment-security`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  return (await response.json() as { reconciliation: Entry[] }).reconciliation;
};
/** Financial and inventory state that visibility must never change. */
const financialSnapshot = async (orderId: number, listingId: number) => JSON.stringify({
  order: await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true, reservationExpiresAt: true } }),
  payments: await prisma.payment.findMany({ where: { orderId }, select: { status: true, paidAt: true, refundedAmount: true, reservedRefundAmount: true, providerReference: true } }),
  refunds: await prisma.refund.count({ where: { orderId } }),
  operations: await prisma.paymentOperation.count({ where: { attempt: { orderId } } }),
  listing: await prisma.productListing.findUniqueOrThrow({ where: { id: listingId }, select: { currentStock: true, reservedStock: true } }),
});

it("surfaces a captured payment whose order could not be reconciled, with sanitized fields only", async () => {
  // Managed mode without a reservation ledger: funds are captured but the order cannot be confirmed.
  config.PAYMENT_RESOLUTION_ENABLED = true;
  const f = await stripeOrder();
  const eventId = `evt_${randomUUID()}`;
  assert.deepEqual(await succeeded(eventId, f), { duplicate: false, handled: true });
  const payment = await prisma.payment.findUniqueOrThrow({ where: { id: f.payment.id } });
  assert.equal(payment.status, "SUCCEEDED");
  assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, "PENDING");

  const entries = (await read((await admin()).token)).filter(e => e.orderId === f.order.id);
  assert.equal(entries.length, 1);
  const [entry] = entries;
  const receipt = await prisma.paymentWebhookEvent.findFirstOrThrow({ where: { provider: "STRIPE", providerEventId: eventId } });
  assert.deepEqual(Object.keys(entry).sort(), ["action", "amount", "currency", "eventType", "kind", "orderId", "orderStatus", "paymentId", "paymentIntentId",
    "paymentStatus", "processedAt", "processingError", "provider", "receiptId", "receivedAt"].sort());
  assert.equal(entry.receiptId, String(receipt.id));
  assert.equal(entry.kind, "RESERVATION_COVERAGE_REVIEW");
  assert.match(String(entry.action), /Check stock before confirming or refunding/);
  assert.equal(entry.paymentStatus, "SUCCEEDED");
  assert.equal(entry.orderStatus, "PENDING");
  assert.equal(entry.paymentIntentId, f.paymentIntentId);
  assert.equal(entry.amount, "20.00");
  assert.equal(entry.currency, "GBP");
  // No raw evidence, metadata, keys or customer details are exposed.
  const body = JSON.stringify(entry);
  for (const hidden of ["evidence", "paymentKey", "metadata", "idempotencyKey", "@reconciliation.test", "Test Street"]) assert.ok(!body.includes(hidden), hidden);
});

it("duplicate webhook delivery stays idempotent and produces one entry", async () => {
  config.PAYMENT_RESOLUTION_ENABLED = true;
  const f = await stripeOrder();
  const eventId = `evt_${randomUUID()}`;
  await succeeded(eventId, f);
  const before = await financialSnapshot(f.order.id, f.listing.id);
  assert.deepEqual(await succeeded(eventId, f), { duplicate: true, handled: true });
  assert.equal(await financialSnapshot(f.order.id, f.listing.id), before);
  assert.equal(await prisma.paymentWebhookEvent.count({ where: { provider: "STRIPE", providerEventId: eventId } }), 1);
  assert.equal((await read((await admin()).token)).filter(e => e.orderId === f.order.id).length, 1);
});

it("refuses unauthenticated, customer and forged-role access", async () => {
  assert.equal((await fetch(`${url}/admin/payment-security`)).status, 401);
  const customer = await user();
  assert.equal((await fetch(`${url}/admin/payment-security`, { headers: { Authorization: `Bearer ${customer.token}` } })).status, 403);
  const forged = jwt.sign({ id: customer.id, role: "ADMIN" }, config.JWT_SECRET);
  assert.equal((await fetch(`${url}/admin/payment-security`, { headers: { Authorization: `Bearer ${forged}` } })).status, 403);
  assert.equal((await fetch(`${url}/admin/payment-security`, { headers: { Authorization: "Bearer not-a-token" } })).status, 401);
});

it("lists only unresolved, correlated receipts", async () => {
  config.PAYMENT_RESOLUTION_ENABLED = true;
  const token = (await admin()).token;
  // Unresolved, then resolved by an operator's recorded financial resolution.
  const resolved = await stripeOrder();
  await succeeded(`evt_${randomUUID()}`, resolved);
  const [entry] = (await read(token)).filter(e => e.orderId === resolved.order.id);
  assert.ok(entry);
  await prisma.$executeRaw`INSERT INTO "OperationalAudit" (kind, "orderId", details)
    VALUES ('PROVIDER_RECEIPT_FINANCIAL_RESOLVED', ${resolved.order.id}, ${JSON.stringify({ receiptId: entry.receiptId, paymentId: String(resolved.payment.id) })}::jsonb)`;
  assert.equal((await read(token)).filter(e => e.orderId === resolved.order.id).length, 0);

  // Resolved by a later successful replay: the receipt's error is cleared.
  const replayed = await stripeOrder();
  const replayEvent = `evt_${randomUUID()}`;
  await succeeded(replayEvent, replayed);
  assert.equal((await read(token)).filter(e => e.orderId === replayed.order.id).length, 1);
  await prisma.paymentWebhookEvent.updateMany({ where: { provider: "STRIPE", providerEventId: replayEvent }, data: { processingError: null } });
  assert.equal((await read(token)).filter(e => e.orderId === replayed.order.id).length, 0);

  // A clean successful reconciliation is never listed.
  config.PAYMENT_RESOLUTION_ENABLED = false;
  const clean = await stripeOrder();
  await succeeded(`evt_${randomUUID()}`, clean);
  assert.equal((await prisma.paymentWebhookEvent.findFirstOrThrow({ where: { evidence: { path: ["paymentIntentId"], equals: clean.paymentIntentId } } })).processingError, null);
  assert.equal((await read(token)).filter(e => e.orderId === clean.order.id).length, 0);

  // An uncorrelated receipt (no local payment, e.g. another environment) is retained but not listed.
  const foreign = `pi_${randomUUID().replace(/-/g, "")}`;
  await reconcileStripePaymentEvent({ id: `evt_${randomUUID()}`, type: "payment_intent.succeeded", paymentIntentId: foreign, amount: 2000, currency: "gbp", metadata: {} });
  assert.equal((await prisma.paymentWebhookEvent.findFirstOrThrow({ where: { evidence: { path: ["paymentIntentId"], equals: foreign } } })).processingError, "Unknown Stripe payment");
  assert.equal((await read(token)).filter(e => e.paymentIntentId === foreign).length, 0);
});

it("surfaces a dispute on a local Stripe payment for review without changing its payment", async () => {
  const f = await stripeOrder();
  await prisma.payment.update({ where: { id: f.payment.id }, data: { status: "SUCCEEDED", paidAt: new Date() } });
  const { retainStripeDispute } = await import("../domain/payments/stripeDisputeService.js");
  const before = await financialSnapshot(f.order.id, f.listing.id);
  await retainStripeDispute(`evt_${randomUUID()}`, "charge.dispute.created", { id: `dp_${randomUUID()}`, payment_intent: f.paymentIntentId, status: "needs_response",
    amount: 2000, currency: "gbp", reason: "fraudulent", created: Math.floor(Date.now() / 1000) } as never);
  const [entry] = (await read((await admin()).token)).filter(e => e.orderId === f.order.id);
  assert.equal(entry?.kind, "DISPUTE_REVIEW_REQUIRED");
  assert.equal(entry?.eventType, "charge.dispute.created");
  assert.equal(await financialSnapshot(f.order.id, f.listing.id), before);
});

it("reading reconciliation visibility performs no financial or inventory action", async () => {
  config.PAYMENT_RESOLUTION_ENABLED = true;
  const f = await stripeOrder();
  await succeeded(`evt_${randomUUID()}`, f);
  const before = await financialSnapshot(f.order.id, f.listing.id);
  const receipts = JSON.stringify(await prisma.paymentWebhookEvent.findMany({ where: { evidence: { path: ["paymentIntentId"], equals: f.paymentIntentId } } }));
  const token = (await admin()).token;
  for (let i = 0; i < 3; i++) await read(token);
  assert.equal(await financialSnapshot(f.order.id, f.listing.id), before);
  assert.equal(JSON.stringify(await prisma.paymentWebhookEvent.findMany({ where: { evidence: { path: ["paymentIntentId"], equals: f.paymentIntentId } } })), receipts);
});

it("classifies every reconciliation diagnostic the Stripe path records", () => {
  assert.equal(classifyStripeReconciliationError("Captured payment requires manual inventory reconciliation; financial success retained"), "INVENTORY_RECONCILIATION_REQUIRED");
  assert.equal(classifyStripeReconciliationError("Captured payment with historical or incomplete reservation coverage requires manual reconciliation"), "RESERVATION_COVERAGE_REVIEW");
  for (const status of ["expired", "cancelled", "returned"])
    assert.equal(classifyStripeReconciliationError(`Captured payment for ${status} order requires refund/reconciliation`), "CAPTURED_ON_TERMINAL_ORDER");
  for (const mismatch of ["Stripe payment amount or currency mismatch", "Stripe attempt correlation mismatch", "Stripe payment reference mismatch"])
    assert.equal(classifyStripeReconciliationError(mismatch), "CORRELATION_MISMATCH");
  assert.equal(classifyStripeReconciliationError("STRIPE_DISPUTE_REVIEW_REQUIRED"), "DISPUTE_REVIEW_REQUIRED");
  assert.equal(classifyStripeReconciliationError("Something new"), "REVIEW_REQUIRED");
});
