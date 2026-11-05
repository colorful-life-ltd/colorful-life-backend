import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { PaymentProvider, PaymentStatus, RefundProvider } from "../generated/prisma-client/enums.js";
import { prisma } from "../prisma/runtime.js";

describe("payment provider persistence foundation", () => {
  const eventIds: number[] = [];
  after(async () => { if (eventIds.length) await prisma.paymentWebhookEvent.deleteMany({ where: { id: { in: eventIds } } }); });

  it("exposes asynchronous provider and lifecycle enum values", () => {
    // The last value is deprecated and retained only for rollback compatibility (docs/operations/paypal-removal.md).
    assert.deepEqual(Object.values(PaymentProvider).slice(0, 2), ["MANUAL", "STRIPE"]);
    assert.equal(PaymentStatus.PROCESSING, "PROCESSING");
    assert.equal(PaymentStatus.CANCELED, "CANCELED");
    assert.deepEqual(Object.values(RefundProvider).slice(0, 2), ["MANUAL", "STRIPE"]);
  });

  it("deduplicates webhook event IDs per provider", async () => {
    const eventId = `foundation-${randomUUID()}`;
    const first = await prisma.paymentWebhookEvent.create({ data: { provider: PaymentProvider.STRIPE, providerEventId: eventId, eventType: "payment_intent.succeeded" } }); eventIds.push(first.id);
    await assert.rejects(() => prisma.paymentWebhookEvent.create({ data: { provider: PaymentProvider.STRIPE, providerEventId: eventId, eventType: "payment_intent.succeeded" } }));
    const otherProvider = await prisma.paymentWebhookEvent.create({ data: { provider: PaymentProvider.MANUAL, providerEventId: eventId, eventType: "manual.recorded" } }); eventIds.push(otherProvider.id);
  });
});
