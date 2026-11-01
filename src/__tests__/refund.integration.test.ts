import assert from "node:assert";
import type { Server } from "node:http";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { Decimal } from "@prisma/client/runtime/client";
import app from "../app.js";
import { config } from "../config/index.js";
import { createOrder } from "../domain/orders/orderService.js";
import { createPayment } from "./helpers/manualPayment.js";
import { prisma } from "../prisma/runtime.js";
import { PaymentProvider, PaymentStatus } from "../generated/prisma-client/enums.js";
import { setPayPalRefundClientForTests } from "../domain/refunds/paypalRefundService.js";
import { setStripeRefundClientForTests, type StripeRefundClient } from "../domain/refunds/stripeRefundService.js";

const userIds: number[] = [], productIds: number[] = [], listingIds: number[] = [], orderIds: number[] = [], paymentIds: number[] = [], refundIds: number[] = [];
const restorePayPalClients: Array<() => void> = [];
const restoreStripeClients: Array<() => void> = [];
async function startServer(): Promise<{ server: Server; url: string }> { const server = app.listen(0); return new Promise((resolve, reject) => { server.once("listening", () => { const address = server.address(); if (!address || typeof address === "string") return reject(new Error("Failed to obtain server address")); resolve({ server, url: `http://localhost:${address.port}` }); }); }); }
function token(id: number, role: "ADMIN" | "CUSTOMER") { return jwt.sign({ id, role }, config.JWT_SECRET, { expiresIn: "1h" }); }
async function user(role: "ADMIN" | "CUSTOMER") { const value = await prisma.user.create({ data: { email: `${role.toLowerCase()}-refund-${randomUUID()}@example.com`, passwordHash: "hashed", emailVerified: true, role, addresses: { create: { recipientName: "Refund User", line1: "1 Test Street", city: "Testville", postcode: "TEST1", countryCode: "GB", isDefaultBilling: true } } } }); userIds.push(value.id); return { id: value.id, token: token(value.id, role) }; }
async function fixture(customerId: number) { const product = await prisma.legoProduct.create({ data: { setNumber: `REFUND-HTTP-${randomUUID()}`, title: "Refund Product", theme: "TEST", ageRecommendation: "8+", pieceCount: 100, productListings: { create: {
            condition: "NEW", originalPrice: new Decimal("50.00"), salePrice: new Decimal("50.00"), currentStock: 10, active: true } } }, include: { productListings: true } }); productIds.push(product.id); const listing = product.productListings[0]; listingIds.push(listing.id); const order = await createOrder(customerId, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 1 }] }); orderIds.push(order.id); const payment = await createPayment(order.id, { providerReference: `payment-${randomUUID()}` }); paymentIds.push(payment.id); return { listing, order, payment }; }
async function request(url: string, path: string, tokenValue: string | undefined, method = "GET", body?: unknown) { const headers: Record<string, string> = {}; if (tokenValue) headers.Authorization = `Bearer ${tokenValue}`; if (body !== undefined) headers["Content-Type"] = "application/json"; headers["Idempotency-Key"]=randomUUID(); return fetch(`${url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }); }

describe("Refund HTTP integration", () => {
  let server: Server; let url: string; let admin: { id: number; token: string }; let customer: { id: number; token: string };
  before(async () => { ({ server, url } = await startServer()); admin = await user("ADMIN"); customer = await user("CUSTOMER"); });
  afterEach(async () => { restorePayPalClients.splice(0).forEach((restore) => restore()); if (refundIds.length) { await prisma.refund.deleteMany({ where: { id: { in: refundIds } } }); refundIds.length = 0; } if (paymentIds.length) { await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } }); paymentIds.length = 0; } if (orderIds.length) { await prisma.order.deleteMany({ where: { id: { in: orderIds } } }); orderIds.length = 0; } if (listingIds.length) { await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listingIds } } }); await prisma.productListing.deleteMany({ where: { id: { in: listingIds } } }); listingIds.length = 0; } if (productIds.length) { await prisma.legoProduct.deleteMany({ where: { id: { in: productIds } } }); productIds.length = 0; } });
  after(async () => { restorePayPalClients.splice(0).forEach((restore) => restore()); await prisma.user.deleteMany({ where: { id: { in: userIds } } }); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); });

  it("enforces POST auth, validation, and missing resources", async () => { assert.strictEqual((await request(url, "/orders/1/refunds", undefined, "POST", {})).status, 401); assert.strictEqual((await request(url, "/orders/1/refunds", customer.token, "POST", {})).status, 403); for (const id of ["bad", "0", "-1"]) assert.strictEqual((await request(url, `/orders/${id}/refunds`, admin.token, "POST", { paymentId: 1, amount: 1, providerReference: "x" })).status, 400); for (const body of [{}, { paymentId: 1, amount: 0, providerReference: "x" }, { paymentId: 1, amount: 1, providerReference: "   " }, { paymentId: 1, amount: 1, providerReference: "x", currency: "USD" }, { paymentId: 1, amount: 1, providerReference: "x", performedByUserId: 999 }]) assert.strictEqual((await request(url, "/orders/1/refunds", admin.token, "POST", body)).status, 400); assert.strictEqual((await request(url, "/orders/999999999/refunds", admin.token, "POST", { paymentId: 1, amount: 1, providerReference: randomUUID() })).status, 404); });
  it("creates a Refund with server-derived fields", async () => { const c = await fixture(customer.id); const response = await request(url, `/orders/${c.order.id}/refunds`, admin.token, "POST", { paymentId: c.payment.id, amount: 12.5, providerReference: randomUUID(), reason: "  Customer request  " }); const body = await response.json(); assert.strictEqual(response.status, 201, JSON.stringify(body)); refundIds.push(body.id); assert.strictEqual(body.orderId, c.order.id); assert.strictEqual(body.paymentId, c.payment.id); assert.strictEqual(body.currency, c.payment.currency); assert.strictEqual(body.provider, "MANUAL"); assert.strictEqual(body.status, "SUCCEEDED"); assert.strictEqual(body.reason, "Customer request"); assert.strictEqual(body.performedByUserId, admin.id); });
  it("supports replay and reference conflicts", async () => { const c = await fixture(customer.id); const ref = randomUUID(); const first = await (await request(url, `/orders/${c.order.id}/refunds`, admin.token, "POST", { paymentId: c.payment.id, amount: 10, providerReference: ref })).json(); refundIds.push(first.id); const replay = await (await request(url, `/orders/${c.order.id}/refunds`, admin.token, "POST", { paymentId: c.payment.id, amount: 10, providerReference: ref })).json(); assert.strictEqual(replay.id, first.id); assert.strictEqual((await request(url, `/orders/${c.order.id}/refunds`, admin.token, "POST", { paymentId: c.payment.id, amount: 11, providerReference: ref })).status, 409); });
  it("maps payment ownership, state, and over-refund failures", async () => { const c = await fixture(customer.id); const other = await fixture(customer.id); assert.strictEqual((await request(url, `/orders/${c.order.id}/refunds`, admin.token, "POST", { paymentId: 999999999, amount: 1, providerReference: randomUUID() })).status, 404); assert.strictEqual((await request(url, `/orders/${c.order.id}/refunds`, admin.token, "POST", { paymentId: other.payment.id, amount: 1, providerReference: randomUUID() })).status, 404); await prisma.payment.update({ where: { id: c.payment.id }, data: { status: "FAILED" } }); assert.strictEqual((await request(url, `/orders/${c.order.id}/refunds`, admin.token, "POST", { paymentId: c.payment.id, amount: 1, providerReference: randomUUID() })).status, 409); const over = await fixture(customer.id); const partial = await (await request(url, `/orders/${over.order.id}/refunds`, admin.token, "POST", { paymentId: over.payment.id, amount: 40, providerReference: randomUUID() })).json(); refundIds.push(partial.id); assert.strictEqual((await request(url, `/orders/${over.order.id}/refunds`, admin.token, "POST", { paymentId: over.payment.id, amount: over.payment.amount.minus(40).add("0.01").toNumber(), providerReference: randomUUID() })).status, 409); });
  it("GET enforces auth, scopes results, and orders deterministically", async () => { const c = await fixture(customer.id); const other = await fixture(customer.id); const first = await (await request(url, `/orders/${c.order.id}/refunds`, admin.token, "POST", { paymentId: c.payment.id, amount: 5, providerReference: randomUUID() })).json(); const second = await (await request(url, `/orders/${c.order.id}/refunds`, admin.token, "POST", { paymentId: c.payment.id, amount: 6, providerReference: randomUUID() })).json(); const foreign = await (await request(url, `/orders/${other.order.id}/refunds`, admin.token, "POST", { paymentId: other.payment.id, amount: 7, providerReference: randomUUID() })).json(); refundIds.push(first.id, second.id, foreign.id); assert.strictEqual((await request(url, `/orders/${c.order.id}/refunds`, undefined)).status, 401); assert.strictEqual((await request(url, `/orders/${c.order.id}/refunds`, customer.token)).status, 403); assert.strictEqual((await request(url, "/orders/bad/refunds", admin.token)).status, 400); assert.strictEqual((await request(url, "/orders/999999999/refunds", admin.token)).status, 404); const listed = await (await request(url, `/orders/${c.order.id}/refunds`, admin.token)).json(); assert.deepStrictEqual(listed.map((r: { id: number }) => r.id), [first.id, second.id]); assert.ok(listed.every((r: { orderId: number }) => r.orderId === c.order.id)); });

  it("rejects new PayPal refunds before provider submission or financial mutations", async () => {
    const c = await fixture(customer.id);
    const captureId = `CAP-${randomUUID()}`;
    await prisma.payment.update({ where: { id: c.payment.id }, data: { provider: PaymentProvider.PAYPAL, providerCaptureReference: captureId, status: PaymentStatus.SUCCEEDED, paidAt: new Date() } });
    const calls: Array<{ captureId: string; requestId: string; amount: string; currency: string }> = [];
    restorePayPalClients.push(setPayPalRefundClientForTests({ refundCapture: async (receivedCaptureId, requestId, amount, currency) => { calls.push({ captureId: receivedCaptureId, requestId, amount, currency }); return { id: `PAYPAL-REFUND-${randomUUID()}`, status: "COMPLETED", amount: { value: amount, currency_code: currency } }; } }));
    const response = await request(url, `/orders/${c.order.id}/refunds`, admin.token, "POST", { paymentId: c.payment.id, amount: 10, currency: "USD", captureId: "ATTACK", providerCaptureReference: "ATTACK", refundIdempotencyKey: "ATTACK" });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(calls.length, 0);
    const before = await prisma.payment.findUniqueOrThrow({ where: { id: c.payment.id } });
    const responseDisabled = await request(url, `/orders/${c.order.id}/refunds`, admin.token, "POST", { paymentId: c.payment.id, amount: 10 });
    assert.equal(responseDisabled.status, 503);
    assert.equal((await responseDisabled.json()).error.code, "PAYPAL_INITIATION_DISABLED");
    assert.equal(calls.length, 0);
    assert.deepEqual(await prisma.payment.findUniqueOrThrow({ where: { id: c.payment.id } }), before);
    assert.equal(await prisma.refund.count({ where: { orderId: c.order.id } }), 0);

  });
  it("routes Stripe refunds from persisted provider identity with a sanitized response", async () => {
    const c = await fixture(customer.id);
    const paymentIntent = `pi_${randomUUID()}`;
    await prisma.payment.update({ where: { id: c.payment.id }, data: { provider: PaymentProvider.STRIPE, providerReference: paymentIntent, status: PaymentStatus.SUCCEEDED, paidAt: new Date() } });
    const calls: Array<{ input: any; options: any }> = [];
    const restore = setStripeRefundClientForTests({ createRefund: async (input, options) => { calls.push({ input, options }); return { id: `re_${randomUUID()}`, amount: 1000, currency: "gbp", status: "succeeded", payment_intent: paymentIntent, metadata: input.metadata ?? {} } as any; } });
    try {
      const response = await request(url, `/orders/${c.order.id}/refunds`, admin.token, "POST", { paymentId: c.payment.id, amount: 10, provider: "PAYPAL", currency: "USD", paymentIntentId: "pi_attacker", stripeRefundId: "re_attacker", idempotencyKey: "attacker" });
      assert.equal(response.status, 400);
      assert.equal(calls.length, 0);
      const success = await request(url, `/orders/${c.order.id}/refunds`, admin.token, "POST", { paymentId: c.payment.id, amount: 10 });
      const body = await success.json();
      assert.equal(success.status, 201);
      refundIds.push(body.refundId);
      assert.deepEqual(Object.keys(body).sort(), ["amount", "currency", "provider", "refundId", "status"]);
      assert.equal(calls[0].input.payment_intent, paymentIntent);
      assert.equal(calls[0].input.amount, 1000);
      assert.deepEqual(calls[0].input.metadata, { local_refund_id: String(body.refundId), order_id: String(c.order.id) });
      assert.equal("providerReference" in body, false);
      assert.equal("refundIdempotencyKey" in body, false);
    } finally { restore(); }
  });
});
