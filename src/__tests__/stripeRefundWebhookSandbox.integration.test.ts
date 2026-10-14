import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { Decimal } from "@prisma/client/runtime/client";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { PaymentProvider, PaymentStatus, RefundProvider, RefundStatus } from "../generated/prisma-client/enums.js";
import { createOrReuseStripePaymentIntent, createStripePaymentClient } from "../domain/payments/stripePaymentService.js";
import { createOrReuseStripeRefund } from "../domain/refunds/stripeRefundService.js";

const enabled = process.env.RUN_STRIPE_REFUND_WEBHOOK_E2E_TESTS === "true";
const userIds: number[] = [];
const orderIds: number[] = [];
const paymentIds: number[] = [];
const refundIds: number[] = [];

async function cleanup() {
  if (refundIds.length) await prisma.refund.deleteMany({ where: { id: { in: refundIds } } });
  if (paymentIds.length) await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
  if (orderIds.length) await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  refundIds.length = paymentIds.length = orderIds.length = userIds.length = 0;
}

afterEach(async () => { if (enabled) await cleanup(); });

async function waitForPayment(paymentId: number, paymentIntentId: string, deadline: number) {
  while (Date.now() < deadline) {
    const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
    if (payment?.status === PaymentStatus.SUCCEEDED && payment.paidAt && payment.providerReference === paymentIntentId) return payment;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  throw new Error(JSON.stringify({ paymentStatus: payment?.status ?? null, paidAtPresent: !!payment?.paidAt, providerReferenceMatches: payment?.providerReference === paymentIntentId }));
}

describe("Stripe Sandbox refund webhook E2E", { concurrency: 1 }, () => {
  it("proves a real Stripe refund webhook reaches production reconciliation", { skip: !enabled }, async () => {
    if (!config.STRIPE_SECRET_KEY) throw new Error("Stripe refund webhook E2E requires STRIPE_SECRET_KEY");
    if (!config.STRIPE_WEBHOOK_SECRET) throw new Error("Stripe refund webhook E2E requires STRIPE_WEBHOOK_SECRET");
    if (!config.STRIPE_SECRET_KEY.startsWith("sk_test_")) throw new Error("Stripe refund webhook E2E requires a test-mode Stripe key");

    const user = await prisma.user.create({ data: { email: `stripe-refund-webhook-${randomUUID()}@example.com`, passwordHash: "sandbox-test", emailVerified: true } });
    userIds.push(user.id);
    const order = await prisma.order.create({ data: { userId: user.id, billingRecipientName: "Stripe Refund Sandbox", billingLine1: "1 Test Street", billingCity: "London", billingPostcode: "SW1A 1AA", billingCountryCode: "GB", deliveryRecipientName: "Stripe Refund Sandbox", deliveryLine1: "1 Test Street", deliveryCity: "London", deliveryPostcode: "SW1A 1AA", deliveryCountryCode: "GB", totalAmount: new Decimal("5.00") } });
    orderIds.push(order.id);

    const stripe = createStripePaymentClient();
    const initiated = await createOrReuseStripePaymentIntent(order.id, user.id);
    paymentIds.push(initiated.paymentId);
    assert.match(initiated.providerReference, /^pi_/);
    const baselineEvents = await prisma.paymentWebhookEvent.findMany({ where: { provider: PaymentProvider.STRIPE, eventType: { in: ["refund.created", "refund.updated", "refund.failed"] } }, select: { id: true } });
    const baselineIds = new Set(baselineEvents.map((event) => event.id));
    const intent = await stripe.paymentIntents.retrieve(initiated.providerReference);
    assert.equal(intent.amount, 500);
    assert.equal(intent.currency, "gbp");
    await stripe.paymentIntents.confirm(initiated.providerReference, { payment_method: "pm_card_visa", return_url: "https://example.com/stripe-sandbox-return" });
    await waitForPayment(initiated.paymentId, initiated.providerReference, Date.now() + 90_000);

    const refund = await createOrReuseStripeRefund(order.id, initiated.paymentId, 1, undefined, user.id, undefined, undefined, randomUUID());
    refundIds.push(refund.id);
    assert.equal(refund.provider, RefundProvider.STRIPE);
    assert.match(refund.providerReference, /^re_/);
    assert.equal(refund.status, RefundStatus.SUCCEEDED);
    const paymentAfterRefund = await prisma.payment.findUnique({ where: { id: initiated.paymentId } });
    assert.equal(paymentAfterRefund?.refundedAmount.toString(), "1");
    assert.equal(paymentAfterRefund?.reservedRefundAmount.toString(), "0");

    const deadline = Date.now() + 90_000;
    let newEvents: Array<{ id: number; eventType: string; processedAt: Date | null; processingError: string | null }> = [];
    while (Date.now() < deadline) {
      newEvents = await prisma.paymentWebhookEvent.findMany({ where: { provider: PaymentProvider.STRIPE, eventType: { in: ["refund.created", "refund.updated", "refund.failed"] }, NOT: { id: { in: [...baselineIds] } } }, orderBy: { id: "asc" }, select: { id: true, eventType: true, processedAt: true, processingError: true } });
      if (newEvents.some((event) => event.processedAt !== null && event.processingError === null && event.eventType !== "refund.failed")) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const processed = newEvents.find((event) => event.processedAt !== null && event.processingError === null && event.eventType !== "refund.failed");
    if (!processed) throw new Error(JSON.stringify({ newRefundEvents: newEvents.map((event) => ({ eventType: event.eventType, processedAt: !!event.processedAt, processingError: event.processingError })) }));
    assert.ok(processed.processedAt);
    assert.equal(processed.processingError, null);
    assert.equal((await prisma.refund.findUnique({ where: { id: refund.id } }))?.providerReference, refund.providerReference);
    assert.equal((await prisma.payment.findUnique({ where: { id: initiated.paymentId } }))?.refundedAmount.toString(), "1");
  });
});
