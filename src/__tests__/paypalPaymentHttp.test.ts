import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Decimal } from "@prisma/client/runtime/client";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { PaymentProvider, PaymentStatus } from "../generated/prisma-client/enums.js";
import { createOrder } from "../domain/orders/orderService.js";
import { cancelOrder } from "../domain/orders/orderCancellationService.js";
import { expireOrderReservation } from "../domain/orders/orderExpiryService.js";
import { setPayPalOrderClientForTests } from "../domain/payments/paypalOrderService.js";
import { setPayPalCaptureClientForTests } from "../domain/payments/paypalCaptureService.js";

let server: Server; let base = ""; let restore: (() => void)[] = []; const users: number[] = [], orders: number[] = [];
before(async () => { server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve)); base = `http://localhost:${(server.address() as { port: number }).port}`; });
after(async () => { await prisma.$disconnect(); server.close(); });
afterEach(async () => { restore.splice(0).forEach((fn) => fn()); if (orders.length) await prisma.order.deleteMany({ where: { id: { in: orders } } }); if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } }); orders.length = users.length = 0; });
async function fixture(verified = true, expired = false) { const u = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, passwordHash: await bcrypt.hash("Abcdef1!", 4), emailVerified: verified } }); users.push(u.id); const o = await prisma.order.create({ data: { userId: u.id, billingRecipientName: "C", billingLine1: "1 Street", billingCity: "London", billingPostcode: "SW1A 1AA", billingCountryCode: "GB", deliveryRecipientName: "C", deliveryLine1: "1 Street", deliveryCity: "London", deliveryPostcode: "SW1A 1AA", deliveryCountryCode: "GB", totalAmount: new Decimal("12.50"), reservationExpiresAt: expired ? new Date(Date.now() - 1000) : new Date(Date.now() + 3600000) } }); orders.push(o.id); return { u, o }; }
function token(id: number, role = "CUSTOMER") { return jwt.sign({ id, role }, config.JWT_SECRET, { expiresIn: "1h" }); }
function headers(id: number) { return { Authorization: `Bearer ${token(id)}`, "Content-Type": "application/json" }; }
function createFake(fail = false) { const calls: any[] = []; restore.push(setPayPalOrderClientForTests({ createOrder: async (input, requestId) => { calls.push({ input, requestId }); if (fail) throw new Error("oauth token/provider secret"); return { id: `PP-${randomUUID()}`, links: [{ rel: "approve", href: "https://paypal.test/approve" }] }; } })); return calls; }
function captureFake(fail = false) { const calls: any[] = []; restore.push(setPayPalCaptureClientForTests({ captureOrder: async (orderId, requestId) => { calls.push({ orderId, requestId }); if (fail) throw new Error("provider credentials"); return { id: orderId, status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: `CAP-${randomUUID()}`, status: "COMPLETED", amount: { value: "12.50", currency_code: "GBP" } }] } }] }; } })); return calls; }
describe("PayPal customer payment HTTP", { concurrency: 1 }, () => {
  for (const configured of [false, true]) {
    for (const managed of [false, true]) {
      it(`rejects repeated direct initiation without mutations (credentials=${configured}, managed=${managed})`, async () => {
        const previous = { id: config.PAYPAL_CLIENT_ID, secret: config.PAYPAL_CLIENT_SECRET, managed: config.PAYMENT_RESOLUTION_ENABLED };
        config.PAYPAL_CLIENT_ID = configured ? "test-client" : undefined;
        config.PAYPAL_CLIENT_SECRET = configured ? "test-secret" : undefined;
        config.PAYMENT_RESOLUTION_ENABLED = managed;
        restore.push(() => { config.PAYPAL_CLIENT_ID = previous.id; config.PAYPAL_CLIENT_SECRET = previous.secret; config.PAYMENT_RESOLUTION_ENABLED = previous.managed; });
        const f = await fixture();
        await prisma.address.create({ data: { userId: f.u.id, recipientName: "Buyer", line1: "1 Test Street", city: "London", postcode: "T1", countryCode: "GB", isDefaultBilling: true } });
        const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: "Disabled PayPal", theme: "TEST", ageRecommendation: "8+", pieceCount: 10 } });
        const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: 10, currentStock: 10 } });
        try {
          const order = await createOrder(f.u.id, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 2 }] });
          orders.push(order.id);
          const snapshot = async () => ({
            order: await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { orderItems: true, payments: true, paymentAttempts: { include: { operations: true } }, paymentResolution: true } }),
            listing: await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } }),
            movements: await prisma.inventoryMovement.findMany({ where: { listingId: listing.id }, orderBy: { id: "asc" } }),
          });
          const before = await snapshot();
          assert.equal(before.listing.reservedStock, 2);
          const calls = createFake();
          for (let attempt = 0; attempt < 3; attempt++) {
            const response = await fetch(`${base}/orders/${order.id}/payments/paypal`, { method: "POST", headers: headers(f.u.id), body: JSON.stringify({ amount: "0.01", currency: "USD", provider: "PAYPAL" }) });
            assert.equal(response.status, 503);
            assert.deepEqual(await response.json(), { error: { code: "PAYPAL_INITIATION_DISABLED", message: "PayPal checkout is currently unavailable" } });
            assert.deepEqual(await snapshot(), before);
          }
          assert.equal(calls.length, 0);
          assert.equal(await prisma.payment.count({ where: { orderId: order.id } }), 0);
          // The generic payment endpoint is ADMIN-only, including PayPal bodies.
          assert.equal((await fetch(`${base}/orders/${order.id}/payments`, { method: "POST", headers: headers(f.u.id), body: JSON.stringify({ provider: "PAYPAL", amount: "20", providerReference: "attack" }) })).status, 403);
          assert.deepEqual(await snapshot(), before);
          // Rejected initiation leaves normal cancellation/expiry able to release stock.
          if (managed) {
            await cancelOrder(f.u.id, order.id, "CHANGED_MIND");
          } else {
            await prisma.order.update({ where: { id: order.id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
            await expireOrderReservation(order.id);
          }
          assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, managed ? "CANCELLED" : "EXPIRED");
          assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: listing.id } })).reservedStock, 0);
        } finally {
          await prisma.order.deleteMany({ where: { id: { in: orders } } });
          await prisma.inventoryMovement.deleteMany({ where: { listingId: listing.id } });
          await prisma.productListing.delete({ where: { id: listing.id } });
          await prisma.legoProduct.delete({ where: { id: product.id } });
          await prisma.address.deleteMany({ where: { userId: f.u.id } });
        }
      });
    }
  }
  it("keeps authentication and verification checks before disabled initiation", async () => {
    const f = await fixture(false);
    assert.equal((await fetch(`${base}/orders/${f.o.id}/payments/paypal`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${base}/orders/${f.o.id}/payments/paypal`, { method: "POST", headers: headers(f.u.id) })).status, 403);
  });
  it("preserves an existing PayPal record and customer order reads on rejected initiation", async () => {
    const f = await fixture();
    const payment = await prisma.payment.create({ data: { orderId: f.o.id, amount: f.o.totalAmount, currency: "GBP", provider: PaymentProvider.PAYPAL, providerReference: `PP-${randomUUID()}`, status: PaymentStatus.PENDING } });
    const response = await fetch(`${base}/orders/${f.o.id}/payments/paypal`, { method: "POST", headers: headers(f.u.id) });
    assert.equal(response.status, 503);
    assert.deepEqual(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }), payment);
    assert.equal((await fetch(`${base}/orders/${f.o.id}`, { headers: headers(f.u.id) })).status, 200);
  });
  it("cannot initiate a payment through capture without an existing payment", async () => {
    const f = await fixture();
    const calls = captureFake();
    const response = await fetch(`${base}/orders/${f.o.id}/payments/paypal/capture`, { method: "POST", headers: headers(f.u.id) });
    assert.equal(response.status, 503);
    assert.equal(calls.length, 0);
    assert.equal(await prisma.payment.count({ where: { orderId: f.o.id } }), 0);
    assert.deepEqual(await prisma.order.findUniqueOrThrow({ where: { id: f.o.id } }), f.o);
  });
  it("rejects capture with existing payment without provider calls or mutations", async () => {
    const f = await fixture();
    const payment = await prisma.payment.create({ data: { orderId: f.o.id, amount: f.o.totalAmount, currency: "GBP", provider: PaymentProvider.PAYPAL, providerReference: `PP-${randomUUID()}`, status: PaymentStatus.PENDING } });
    const calls = captureFake();
    for (const enabled of [false, true]) {
      const previous = config.PAYMENT_PAYPAL_INITIATION_ENABLED;
      config.PAYMENT_PAYPAL_INITIATION_ENABLED = enabled;
      try {
        const response = await fetch(`${base}/orders/${f.o.id}/payments/paypal/capture`, { method: "POST", headers: headers(f.u.id) });
        assert.equal(response.status, 503);
        assert.equal((await response.json()).error.code, "PAYPAL_INITIATION_DISABLED");
        assert.deepEqual(await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }), payment);
        assert.deepEqual(await prisma.order.findUniqueOrThrow({ where: { id: f.o.id } }), f.o);
      } finally { config.PAYMENT_PAYPAL_INITIATION_ENABLED = previous; }
    }
    assert.equal(calls.length, 0);
  });
  it("preserves authentication and verification for capture", async () => {
    const f = await fixture(false);
    assert.equal((await fetch(`${base}/orders/${f.o.id}/payments/paypal/capture`, { method: "POST" })).status, 401);
    assert.equal((await fetch(`${base}/orders/${f.o.id}/payments/paypal/capture`, { method: "POST", headers: headers(f.u.id) })).status, 403);
  });
});
