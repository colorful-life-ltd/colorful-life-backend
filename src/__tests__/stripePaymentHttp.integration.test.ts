import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { Decimal } from "@prisma/client/runtime/client";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { setStripePaymentClientForTests } from "../domain/payments/stripePaymentService.js";
import { PaymentProvider, PaymentStatus } from "../generated/prisma-client/enums.js";

let server: Server; let url = ""; let restore: (() => void) | undefined;
const users: number[] = [], orders: number[] = [];
before(async () => { server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve)); url = `http://localhost:${(server.address() as { port: number }).port}`; });
after(async () => { await prisma.$disconnect(); server.close(); });
afterEach(async () => { restore?.(); restore = undefined; if (orders.length) await prisma.order.deleteMany({ where: { id: { in: orders } } }); if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } }); orders.length = users.length = 0; });
async function fixture(verified = true) { const u = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, passwordHash: await bcrypt.hash("Abcdef1!", 4), emailVerified: verified } }); users.push(u.id); const o = await prisma.order.create({ data: { userId: u.id, billingRecipientName: "C", billingLine1: "1 Street", billingCity: "London", billingPostcode: "SW1A 1AA", billingCountryCode: "GB", deliveryRecipientName: "C", deliveryLine1: "1 Street", deliveryCity: "London", deliveryPostcode: "SW1A 1AA", deliveryCountryCode: "GB", totalAmount: new Decimal("12.50"), reservationExpiresAt: new Date(Date.now() + 3600000) } }); orders.push(o.id); return { u, o }; }
function auth(id: number, role: string) { return jwt.sign({ id, role }, config.JWT_SECRET, { expiresIn: "1h" }); }
function fake(throwError = false) { let calls = 0; let lastParams: any; restore = setStripePaymentClientForTests({ paymentIntents: { create: async (params: any) => { calls++; lastParams = params; if (throwError) throw new Error("provider secret details"); return { ...lastParams, id: "pi_http", client_secret: "cs_http", status: "requires_payment_method" }; }, retrieve: async () => ({ ...lastParams, id: "pi_http", client_secret: "cs_http", status: "requires_payment_method" }) } } as any); return { calls: () => calls, params: () => lastParams }; }
describe("Stripe payment initiation HTTP", { concurrency: 1 }, () => {
  it("requires auth and ignores client amount/currency", async () => { const f = await fixture(); assert.equal((await fetch(`${url}/orders/${f.o.id}/payments/stripe`, { method: "POST" })).status, 401); const fakeClient = fake(); const response = await fetch(`${url}/orders/${f.o.id}/payments/stripe`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${auth(f.u.id, f.u.role)}`, "Content-Type": "application/json" }, body: JSON.stringify({ amount: 999999, currency: "USD" }) }); assert.equal(response.status, 201); assert.deepEqual(await response.json(), { clientSecret: "cs_http" }); assert.equal(fakeClient.params().amount, 1250); assert.equal(fakeClient.params().currency, "gbp"); });
  it("reuses the same local/provider attempt", async () => { const f = await fixture(); const fakeClient = fake(); assert.equal((await fetch(`${url}/orders/${f.o.id}/payments/stripe`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${auth(f.u.id, f.u.role)}` } })).status, 201); assert.equal((await fetch(`${url}/orders/${f.o.id}/payments/stripe`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${auth(f.u.id, f.u.role)}` } })).status, 201); assert.equal(fakeClient.calls(), 1); assert.equal(await prisma.payment.count({ where: { orderId: f.o.id } }), 1); });
  it("maps provider failures safely", async () => { const f = await fixture(); fake(true); const response = await fetch(`${url}/orders/${f.o.id}/payments/stripe`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${auth(f.u.id, f.u.role)}` } }); assert.equal(response.status, 503); const body = await response.text(); assert.equal(body.includes("provider secret details"), false); });
  it("rejects an already successful payment", async () => { const f = await fixture(); await prisma.payment.create({ data: { orderId: f.o.id, amount: f.o.totalAmount, currency: "GBP", provider: PaymentProvider.STRIPE, providerReference: `pi_done-${randomUUID()}`, status: PaymentStatus.SUCCEEDED, paidAt: new Date(), idempotencyKey: `done-${randomUUID()}` } }); const response = await fetch(`${url}/orders/${f.o.id}/payments/stripe`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${auth(f.u.id, f.u.role)}` } }); const body = await response.json(); assert.equal(response.status, 409); assert.equal(body.error.code, "PAYMENT_ALREADY_COMPLETED"); });
  it("returns stable errors for every non-payable order state", async () => {
    const f = await fixture(); const fakeClient = fake();
    for (const status of ["EXPIRED", "CONFIRMED", "DISPATCHED", "COMPLETED", "CANCELLED", "RETURNED"] as const) {
      await prisma.order.update({ where: { id: f.o.id }, data: { status } });
      const response = await fetch(`${url}/orders/${f.o.id}/payments/stripe`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${auth(f.u.id, f.u.role)}` } });
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, status === "EXPIRED" ? "ORDER_EXPIRED" : "ORDER_NOT_PAYABLE");
    }
    assert.equal(fakeClient.calls(), 0);
    assert.equal(await prisma.payment.count({ where: { orderId: f.o.id } }), 0);
  });
  it("blocks unauthenticated, unverified, wrong-owner, expired, and completed requests", async () => { const f = await fixture(false); const unverified = fake(); assert.equal((await fetch(`${url}/orders/${f.o.id}/payments/stripe`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${auth(f.u.id, f.u.role)}` } })).status, 403); assert.equal(unverified.calls(), 0); const other = await fixture(true); assert.equal((await fetch(`${url}/orders/${f.o.id}/payments/stripe`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${auth(other.u.id, other.u.role)}` } })).status, 404); await prisma.order.update({ where: { id: other.o.id }, data: { reservationExpiresAt: new Date(Date.now() - 1) } }); assert.equal((await fetch(`${url}/orders/${other.o.id}/payments/stripe`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${auth(other.u.id, other.u.role)}` } })).status, 409); });
});
