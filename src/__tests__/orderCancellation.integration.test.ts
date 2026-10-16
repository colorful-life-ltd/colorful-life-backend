import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import jwt from "jsonwebtoken";
import { Decimal } from "@prisma/client/runtime/client";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { InventoryMovementType } from "../generated/prisma-client/enums.js";

import type Stripe from "stripe";
import { cancelOrderByAdmin } from "../domain/orders/orderCancellationService.js";
import { OrderCancellationPaymentError } from "../domain/orders/orderCancellationErrors.js";
import { createOrReuseStripePaymentIntent, StripePaymentNotPayableError } from "../domain/payments/stripePaymentService.js";
import { reconcileStripePaymentEvent } from "../domain/payments/stripeReconciliationService.js";
import { recoverStripePayment } from "../domain/payments/stripePaymentRecoveryService.js";
import { createPayment } from "../domain/payments/paymentService.js";
import { PaymentOrderCancelledError } from "../domain/payments/paymentErrors.js";
import { createOrReusePayPalOrder, PayPalOrderAlreadyCompletedError } from "../domain/payments/paypalOrderService.js";

const receiptIds: string[] = [];
const userIds: number[] = [];
const productIds: number[] = [];
const listingIds: number[] = [];
const orderIds: number[] = [];
let server: Server;
let url: string;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  url = `http://localhost:${address.port}`;
});

afterEach(async () => {
  await prisma.paymentWebhookEvent.deleteMany({ where: { providerEventId: { in: receiptIds.splice(0) } } });
  if (orderIds.length) await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  if (listingIds.length) await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listingIds } } });
  if (listingIds.length) await prisma.productListing.deleteMany({ where: { id: { in: listingIds } } });
  if (productIds.length) await prisma.legoProduct.deleteMany({ where: { id: { in: productIds } } });
  if (userIds.length) {
    await prisma.address.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  orderIds.length = listingIds.length = productIds.length = userIds.length = 0;
});

after(async () => {
  await prisma.$disconnect();
  server.close();
});

async function makeCustomer() {
  const user = await prisma.user.create({
    data: {
      email: `${randomUUID()}@example.com`,
      passwordHash: "test-hash",
      role: "CUSTOMER",
      emailVerified: true,
      addresses: { create: { recipientName: "Customer", line1: "1 Test Street", city: "Testville", postcode: "T1", countryCode: "GB", isDefaultBilling: true } },
    },
  });
  userIds.push(user.id);
  return { id: user.id, token: jwt.sign({ id: user.id, role: "CUSTOMER" }, config.JWT_SECRET, { expiresIn: "1h" }) };
}

async function makeOrder(userId: number, status: "PENDING" | "DISPATCHED" = "PENDING") {
  const product = await prisma.legoProduct.create({
    data: { setNumber: `CANCEL-${randomUUID()}`, title: "Cancellation Product", theme: "TEST", ageRecommendation: "8+", pieceCount: 100 },
  });
  productIds.push(product.id);
  const listing = await prisma.productListing.create({ data: {
        legoProductId: product.id, condition: "NEW", originalPrice: new Decimal(20), currentStock: 4, reservedStock: 1, active: true } });
  listingIds.push(listing.id);
  const order = await prisma.order.create({
    data: {
      userId,
      billingRecipientName: "Customer",
      billingLine1: "1 Test Street",
      billingCity: "Testville",
      billingPostcode: "T1",
      billingCountryCode: "GB",
      deliveryRecipientName: "Customer",
      deliveryLine1: "1 Test Street",
      deliveryCity: "Testville",
      deliveryPostcode: "T1",
      deliveryCountryCode: "GB",
      status,
      totalAmount: 20,
      orderItems: { create: { productListingId: listing.id, quantity: 1, unitPrice: 20, lineTotal: 20 } },
    },
  });
  orderIds.push(order.id);
  return order;
}

function cancel(orderId: number, token: string | undefined, reason = "CHANGED_MIND") {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${url}/orders/${orderId}/cancel`, { method: "POST", headers, body: JSON.stringify({ reason }) });
}

describe("customer order cancellation HTTP integration", () => {
  it("allows an authenticated customer to cancel their own PENDING order", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id);
    const response = await cancel(order.id, customer.token);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.id, order.id);
    assert.strictEqual(body.status, "CANCELLED");
    assert.strictEqual(body.cancelledBy, "CUSTOMER");
    assert.strictEqual(body.cancellationReason, "CHANGED_MIND");
    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    assert.strictEqual(persisted?.status, "CANCELLED");
  });

  it("returns 404 for another customer's order and 401 without authentication", async () => {
    const owner = await makeCustomer();
    const other = await makeCustomer();
    const order = await makeOrder(owner.id);
    assert.strictEqual((await cancel(order.id, other.token)).status, 404);
    assert.strictEqual((await cancel(order.id, undefined)).status, 401);
    assert.strictEqual((await prisma.order.findUnique({ where: { id: order.id } }))?.status, "PENDING");
  });

  it("restores stock and records a movement when a customer cancels a CONFIRMED order", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id);
    const listingId = (await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } })).productListingId;
    const before = (await prisma.productListing.findUnique({ where: { id: listingId } }))!.currentStock;
    await prisma.productListing.update({ where: { id: listingId }, data: { currentStock: { decrement: 1 }, reservedStock: { decrement: 1 } } });
    await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
    const response = await cancel(order.id, customer.token);
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await prisma.productListing.findUnique({ where: { id: listingId } }))!.currentStock, before);
    const movements = await prisma.inventoryMovement.findMany({ where: { listingId, type: InventoryMovementType.ORDER_CANCELLATION_RETURN } });
    assert.strictEqual(movements.length, 1);
    assert.strictEqual(movements[0].quantityChange, 1);
    assert.strictEqual(movements[0].performedByUserId, customer.id);
  });

  it("rejects cancellation of a non-cancellable order", async () => {
    const customer = await makeCustomer();
    const order = await makeOrder(customer.id, "DISPATCHED");
    const response = await cancel(order.id, customer.token);
    assert.strictEqual(response.status, 400);
    assert.strictEqual((await prisma.order.findUnique({ where: { id: order.id } }))?.status, "DISPATCHED");
  });

  it("keeps the ADMIN seller-cancellation route separate", async () => {
    const admin = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, passwordHash: "test-hash", role: "ADMIN" } });
    userIds.push(admin.id);
    const order = await makeOrder(admin.id);
    const response = await fetch(`${url}/orders/${order.id}/seller-cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${jwt.sign({ id: admin.id, role: "ADMIN" }, config.JWT_SECRET, { expiresIn: "1h" })}`, "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "OUT_OF_STOCK" }),
    });
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await response.json()).cancelledBy, "SELLER");
  });
});


function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}
async function makeAdmin() {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, passwordHash: "test", role: "ADMIN" } });
  userIds.push(user.id);
  return { id: user.id, token: jwt.sign({ id: user.id }, config.JWT_SECRET) };
}
async function sellerCancel(orderId: number, token?: string, reason = "OUT_OF_STOCK") {
  return fetch(`${url}/orders/${orderId}/seller-cancel`, { method: "POST", headers: {
    "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }, body: JSON.stringify({ reason }) });
}
async function stock(orderId: number) {
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId } });
  return prisma.productListing.findUniqueOrThrow({ where: { id: item.productListingId } });
}
function outcome(orderId: number, intentId: string, type: "payment_intent.succeeded" | "payment_intent.payment_failed" | "payment_intent.canceled" = "payment_intent.succeeded") {
  const id = `evt_${randomUUID()}`; receiptIds.push(id);
  return { id, type, paymentIntentId: intentId, amount: 2000, currency: "gbp", metadata: { orderId: String(orderId) } };
}

describe("payment-safe seller cancellation", () => {
  it("rejects all existing payment states, including retryable failures and unresolved placeholders", async () => {
    const admin = await makeAdmin(); const owner = await makeCustomer();
    for (const status of ["SUCCEEDED", "PENDING", "PROCESSING", "FAILED", "CANCELED"] as const) {
      const order = await makeOrder(owner.id);
      await prisma.payment.create({ data: { orderId: order.id, amount: 20, status, provider: "STRIPE", providerReference: status === "PROCESSING" ? `pending:order-${order.id}-stripe` : `pi_${randomUUID()}`, paidAt: status === "SUCCEEDED" ? new Date() : null } });
      const response = await sellerCancel(order.id, admin.token);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error.code, status === "SUCCEEDED" ? "ORDER_ALREADY_PAID" : "ORDER_PAYMENT_UNRESOLVED");
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, "PENDING");
      assert.equal((await stock(order.id)).reservedStock, 1);
      if (status === "SUCCEEDED") {
        await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
        assert.equal((await sellerCancel(order.id, admin.token)).status, 409);
      }
    }
  });

  it("validates authorization, reasons, missing orders and repeated cancellations", async () => {
    const admin = await makeAdmin(); const owner = await makeCustomer(); const order = await makeOrder(owner.id);
    assert.equal((await sellerCancel(order.id)).status, 401);
    assert.equal((await sellerCancel(order.id, owner.token)).status, 403);
    assert.equal((await sellerCancel(order.id, admin.token, "CHANGED_MIND")).status, 400);
    assert.equal((await sellerCancel(2147483647, admin.token)).status, 404);
    assert.equal((await sellerCancel(order.id, admin.token)).status, 200);
    assert.equal((await sellerCancel(order.id, admin.token)).status, 400);
    assert.equal((await stock(order.id)).reservedStock, 0); assert.equal((await stock(order.id)).currentStock, 4);
  });

  it("blocks cancellation while Stripe initiation is paused at the provider boundary", async () => {
    const owner = await makeCustomer(); const admin = await makeAdmin(); const order = await makeOrder(owner.id);
    const entered = gate(); const release = gate(); const intentId = `pi_${randomUUID()}`;
    const client = { paymentIntents: { create: async (input: {amount:number; currency:string; metadata:Record<string,string>}) => { entered.resolve(); await release.promise; return { ...input, id: intentId, status: "requires_payment_method", client_secret: "test-secret" }; } } } as unknown as Pick<Stripe, "paymentIntents">;
    const initiation = createOrReuseStripePaymentIntent(order.id, owner.id, client);
    try {
      await entered.promise;
      assert.equal((await sellerCancel(order.id, admin.token)).status, 409);
      assert.equal((await stock(order.id)).reservedStock, 1);
    } finally { release.resolve(); await initiation; }
    const event = outcome(order.id, intentId);
    await reconcileStripePaymentEvent(event); await reconcileStripePaymentEvent(event);
    await reconcileStripePaymentEvent(outcome(order.id, intentId, "payment_intent.payment_failed"));
    assert.equal((await sellerCancel(order.id, admin.token)).status, 409);
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { orderId: order.id } })).status, "SUCCEEDED");
    assert.equal((await stock(order.id)).reservedStock, 0); assert.equal((await stock(order.id)).currentStock, 3);
  });

  it("serializes competing cancellation and Stripe initiation under the order lock", async () => {
    const owner = await makeCustomer(); const admin = await makeAdmin(); const order = await makeOrder(owner.id);
    const locked = gate(); const release = gate(); let calls = 0;
    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
      locked.resolve(); await release.promise;
    });
    await locked.promise;
    const client = { paymentIntents: { create: async (input: {amount:number; currency:string; metadata:Record<string,string>}) => { calls++; return { ...input, id: `pi_${randomUUID()}`, status: "requires_payment_method", client_secret: "test" }; } } } as unknown as Pick<Stripe, "paymentIntents">;
    const resultsPromise = Promise.allSettled([
      cancelOrderByAdmin(order.id, "OUT_OF_STOCK", admin.id),
      createOrReuseStripePaymentIntent(order.id, owner.id, client),
    ]);
    release.resolve(); await blocker;
    const results = await resultsPromise;
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const final = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    if (final.status === "CANCELLED") {
      assert.equal(calls, 0); assert.equal(await prisma.payment.count({ where: { orderId: order.id } }), 0);
      assert.equal((await stock(order.id)).reservedStock, 0);
    } else {
      assert.equal(final.status, "PENDING"); assert.equal(calls, 1); assert.equal((await stock(order.id)).reservedStock, 1);
    }
  });

  it("prevents every supported initiation path after cancellation wins", async () => {
    const owner = await makeCustomer(); const admin = await makeAdmin(); const order = await makeOrder(owner.id);
    await cancelOrderByAdmin(order.id, "OUT_OF_STOCK", admin.id);
    await assert.rejects(createOrReuseStripePaymentIntent(order.id, owner.id), StripePaymentNotPayableError);
    await assert.rejects(createPayment(order.id, { providerReference: randomUUID() }), PaymentOrderCancelledError);
    await assert.rejects(createOrReusePayPalOrder(order.id, owner.id), PayPalOrderAlreadyCompletedError);
    const result = await reconcileStripePaymentEvent(outcome(order.id, "pi_unknown"));
    assert.equal(result.handled, false);
    assert.equal(await prisma.payment.count({ where: { orderId: order.id } }), 0);
    assert.equal((await stock(order.id)).reservedStock, 0);
  });

  it("rejects cancellation during recovery and concurrent verified webhook processing", async () => {
    const owner = await makeCustomer(); const admin = await makeAdmin(); const order = await makeOrder(owner.id);
    const intentId = `pi_${randomUUID()}`;
    await prisma.payment.create({ data: { orderId: order.id, amount: 20, provider: "STRIPE", providerReference: intentId, status: "FAILED" } });
    const entered = gate(); const release = gate();
    const recovery = recoverStripePayment(order.id, owner.id, { paymentIntents: { retrieve: async () => {
      entered.resolve(); await release.promise;
      return { id: intentId, amount: 2000, amount_received: 2000, currency: "gbp", status: "succeeded", metadata: { orderId: String(order.id) } };
    } } } as unknown as Parameters<typeof recoverStripePayment>[2]);
    receiptIds.push(`recovery:${(await prisma.payment.findUniqueOrThrow({ where: { orderId: order.id } })).id}:${intentId}:succeeded`);
    try {
      await entered.promise;
      await assert.rejects(cancelOrderByAdmin(order.id, "OUT_OF_STOCK", admin.id), OrderCancellationPaymentError);
      const results = await Promise.allSettled([
        reconcileStripePaymentEvent(outcome(order.id, intentId)),
        cancelOrderByAdmin(order.id, "OUT_OF_STOCK", admin.id),
      ]);
      assert.equal(results[0].status, "fulfilled"); assert.equal(results[1].status, "rejected");
    } finally { release.resolve(); await recovery; }
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status, "CONFIRMED");
    assert.equal((await stock(order.id)).currentStock, 3); assert.equal((await stock(order.id)).reservedStock, 0);
  });

  it("restores unpaid confirmed inventory once and rolls back missing reservations", async () => {
    const owner = await makeCustomer(); const admin = await makeAdmin(); const order = await makeOrder(owner.id);
    const listing = await stock(order.id);
    await prisma.productListing.update({ where: { id: listing.id }, data: { reservedStock: 0, currentStock: 3 } });
    await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
    const results = await Promise.allSettled([cancelOrderByAdmin(order.id, "OUT_OF_STOCK", admin.id), cancelOrderByAdmin(order.id, "OUT_OF_STOCK", admin.id)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal((await stock(order.id)).currentStock, 4);
    assert.equal(await prisma.inventoryMovement.count({ where: { listingId: listing.id, type: "ORDER_CANCELLATION_RETURN" } }), 1);
    const pending = await makeOrder(owner.id); const pendingListing = await stock(pending.id);
    await prisma.productListing.update({ where: { id: pendingListing.id }, data: { reservedStock: 0 } });
    await assert.rejects(cancelOrderByAdmin(pending.id, "OUT_OF_STOCK", admin.id));
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: pending.id } })).status, "PENDING");
  });
});
