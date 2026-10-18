import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { addCartItem, updateCartItem, removeCartItem, clearCart, getCart } from "../domain/cart/cartService.js";
import { lockCustomerCart, reconcilePendingCarts, startCartReconciliationWorker, CartQuantityAllocatedError } from "../domain/cart/cartProvenanceService.js";
import { createOrder, OrderIdempotencyMismatchError } from "../domain/orders/orderService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import { OrderCancellationPaymentError } from "../domain/orders/orderCancellationErrors.js";
import { cancelOrder, cancelOrderByAdmin } from "../domain/orders/orderCancellationService.js";
import { expireOrderReservation } from "../domain/orders/orderExpiryService.js";
import { getCustomerOrder } from "../domain/orders/orderReadService.js";
import { reconcileStripePaymentEvent } from "../domain/payments/stripeReconciliationService.js";
import { createOrReuseStripePaymentIntent, type StripePaymentClient } from "../domain/payments/stripePaymentService.js";
import { readFileSync } from "node:fs";
import { recoverStripePayment } from "../domain/payments/stripePaymentRecoveryService.js";

const users: number[] = [], products: number[] = [], listings: number[] = [], orders: number[] = [], events: string[] = [];
let server: ReturnType<typeof app.listen>, url: string;
before(async () => {
  server = app.listen(0); await new Promise<void>((resolve) => server.once("listening", resolve));
  url = `http://localhost:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await prisma.paymentWebhookEvent.deleteMany({ where: { providerEventId: { in: events } } });
  await prisma.order.deleteMany({ where: { id: { in: orders } } });
  await prisma.cart.deleteMany({ where: { userId: { in: users } } });
  await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listings } } });
  await prisma.productListing.deleteMany({ where: { id: { in: listings } } });
  await prisma.legoProduct.deleteMany({ where: { id: { in: products } } });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  users.length = products.length = listings.length = orders.length = events.length = 0;
});
after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await prisma.$disconnect(); });

async function fixture(stock = 50) {
  const user = await prisma.user.create({ data: { email: `cart-provenance-${randomUUID()}@example.com`, passwordHash: "hash", emailVerified: true,
    addresses: { create: { recipientName: "Buyer", line1: "1 Test", city: "London", postcode: "T1", countryCode: "GB", isDefaultBilling: true } } } }); users.push(user.id);
  const ids: number[] = [];
  for (const name of ["A", "B"]) {
    const product = await prisma.legoProduct.create({ data: { setNumber: `CP-${randomUUID()}`, title: name, theme: "TEST", ageRecommendation: "8+", pieceCount: 1 } }); products.push(product.id);
    const listing = await prisma.productListing.create({ data: { legoProductId: product.id, condition: "NEW", originalPrice: 10, currentStock: stock } }); listings.push(listing.id); ids.push(listing.id);
  }
  return { userId: user.id, a: ids[0], b: ids[1], token: jwt.sign({ id: user.id, role: "CUSTOMER" }, config.JWT_SECRET) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function order(f: Fixture, items = [{ productListingId: f.a, quantity: 1 }], key = randomUUID()) {
  const result = await createOrder(f.userId, { shippingMethod: "STANDARD", items }, key); orders.push(result.id); return result;
}
async function payment(orderId: number) {
  const saved = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  const p = await prisma.payment.create({ data: { orderId, amount: saved.totalAmount, provider: "STRIPE", status: "PROCESSING", providerReference: `pi_test_${randomUUID()}` } });
  events.push(`recovery:${p.id}:${p.providerReference}:succeeded`); return p;
}
function outcome(p: Awaited<ReturnType<typeof payment>>, type: "payment_intent.succeeded" | "payment_intent.payment_failed" | "payment_intent.canceled" = "payment_intent.succeeded") {
  const id = `evt_test_${randomUUID()}`; events.push(id);
  return { id, type, paymentIntentId: p.providerReference, amount: Number(p.amount) * 100, currency: "gbp", metadata: { orderId: String(p.orderId) } };
}
function provider(p: Awaited<ReturnType<typeof payment>>) {
  return { paymentIntents: { retrieve: async () => ({ id: p.providerReference, amount: Number(p.amount) * 100, amount_received: Number(p.amount) * 100,
    currency: "gbp", status: "succeeded", metadata: { orderId: String(p.orderId) } }) as unknown as Stripe.Response<Stripe.PaymentIntent> } };
}
async function quantities(f: Fixture) {
  const rows = await prisma.cartItem.findMany({ where: { cart: { userId: f.userId } } });
  return { a: rows.find((r) => r.productListingId === f.a)?.quantity ?? 0, b: rows.find((r) => r.productListingId === f.b)?.quantity ?? 0 };
}
async function provenance(orderId: number) { return prisma.orderCartProvenance.findUniqueOrThrow({ where: { orderId }, include: { allocations: true } }); }
async function success(orderId: number) {
  const p = await payment(orderId); await reconcileStripePaymentEvent(outcome(p)); return p;
}
async function waitForBlocked(pid: number, expected: number) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
      WITH RECURSIVE blocked AS (
        SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND ${pid} = ANY(pg_blocking_pids(pid))
        UNION SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid)) WHERE a.datname = current_database()
      ) SELECT count(*)::int AS n FROM blocked`;
    if (row.n >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Expected genuine overlapping database transactions queued at lock");
}
async function holdCart(f: Fixture) {
  let release!: () => void, ready!: (pid: number) => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<number>((resolve) => { ready = resolve; });
  const tx = prisma.$transaction(async (db) => {
    await lockCustomerCart(db, f.userId);
    const [row] = await db.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    ready(row.pid); await gate;
  }, { timeout: 10_000 });
  return { pid: await started, release: async () => { release(); await tx; } };
}

describe("durable order cart provenance", { concurrency: 1 }, () => {
  it("keeps pending quantity visible and consumes the purchased allocation once after authoritative success", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f);
    assert.deepEqual(await quantities(f), { a: 1, b: 0 }); assert.equal((await provenance(o.id)).state, "ACTIVE");
    await success(o.id); assert.equal((await provenance(o.id)).state, "CONSUME_PENDING");
    await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 0, b: 0 });
    assert.equal((await provenance(o.id)).state, "CONSUMED"); await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 0, b: 0 });
  });
  it("preserves a later same-listing addition even when only that addition fits available stock", async () => {
    const f = await fixture(2); await addCartItem(f.userId, f.a, 1); const o = await order(f);
    await addCartItem(f.userId, f.a, 1); await success(o.id); await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 1, b: 0 });
  });
  it("preserves later additions of other listings", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f);
    await addCartItem(f.userId, f.b, 1); await success(o.id); await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 0, b: 1 });
  });
  it("allocates and reconciles multiple listings independently", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 2); await addCartItem(f.userId, f.b, 3);
    const o = await order(f, [{ productListingId: f.b, quantity: 2 }, { productListingId: f.a, quantity: 1 }]);
    await addCartItem(f.userId, f.a, 2); await success(o.id); await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 3, b: 1 });
  });
  it("duplicate confirmation cannot queue or consume another cart effect", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f);
    await success(o.id); await reconcilePendingCarts(); await addCartItem(f.userId, f.a, 1);
    await assert.rejects(() => confirmOrder(f.userId, o.id)); await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 1, b: 0 });
  });
  it("duplicate webhook delivery and distinct duplicate success evidence do not consume later intent", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f), p = await payment(o.id), event = outcome(p);
    await reconcileStripePaymentEvent(event); await reconcilePendingCarts(); await addCartItem(f.userId, f.a, 2);
    assert.equal((await reconcileStripePaymentEvent(event)).duplicate, true); await reconcileStripePaymentEvent(outcome(p)); await reconcilePendingCarts();
    assert.deepEqual(await quantities(f), { a: 2, b: 0 });
  });
  it("recovery after webhook and repeated recovery leave later cart quantity untouched", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f); const p = await success(o.id);
    await reconcilePendingCarts(); await addCartItem(f.userId, f.a, 1);
    await recoverStripePayment(o.id, f.userId, provider(p)); await recoverStripePayment(o.id, f.userId, provider(p)); await reconcilePendingCarts();
    assert.deepEqual(await quantities(f), { a: 1, b: 0 });
  });
  it("missed-webhook recovery uses the same consume task", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f), p = await payment(o.id);
    await addCartItem(f.userId, f.a, 1); await recoverStripePayment(o.id, f.userId, provider(p)); await reconcilePendingCarts();
    assert.deepEqual(await quantities(f), { a: 1, b: 0 }); assert.equal((await provenance(o.id)).state, "CONSUMED");
  });
  it("idempotent order creation retries reuse the allocation and mismatches retain their conflict", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const key = randomUUID(), o = await order(f, undefined, key);
    assert.equal((await createOrder(f.userId, { shippingMethod: "STANDARD" as const, items: [{ productListingId: f.a, quantity: 1 }] }, key)).id, o.id);
    assert.equal((await provenance(o.id)).allocations.length, 1);
    await assert.rejects(() => createOrder(f.userId, { shippingMethod: "STANDARD" as const, items: [{ productListingId: f.a, quantity: 2 }] }, key), OrderIdempotencyMismatchError);
    assert.equal((await provenance(o.id)).allocations[0].quantity, 1);
  });
  it("reductions discard unallocated intent first and preserve the remaining allocation", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f);
    await addCartItem(f.userId, f.a, 2); await updateCartItem(f.userId, f.a, 2);
    assert.equal((await provenance(o.id)).allocations[0].visibleQuantity, 1);
    await success(o.id); await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 1, b: 0 });
  });
  it("reductions below allocated quantity detach only the removed portion without editing the Order", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 3); const o = await order(f, [{ productListingId: f.a, quantity: 3 }]);
    await updateCartItem(f.userId, f.a, 1); const a = (await provenance(o.id)).allocations[0];
    assert.equal(a.quantity, 3); assert.equal(a.visibleQuantity, 1); await addCartItem(f.userId, f.a, 2);
    await success(o.id); await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 2, b: 0 });
    assert.equal((await prisma.orderItem.findFirstOrThrow({ where: { orderId: o.id } })).quantity, 3);
  });
  for (const mutation of ["remove", "clear"] as const) {
    it(`${mutation} detaches active provenance; recreated listing is fresh intent`, async () => {
      const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f);
      if (mutation === "remove") await removeCartItem(f.userId, f.a); else await clearCart(f.userId);
      assert.equal((await provenance(o.id)).allocations[0].cartItemId, null);
      assert.equal((await provenance(o.id)).allocations[0].visibleQuantity, 0);
      await addCartItem(f.userId, f.a, 2); await success(o.id); await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 2, b: 0 });
    });
  }
  it("a second pending order cannot claim the same visible allocated quantity", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); await order(f);
    await assert.rejects(() => order(f), CartQuantityAllocatedError);
    assert.equal(await prisma.order.count({ where: { userId: f.userId } }), 1);
    assert.equal((await prisma.productListing.findUniqueOrThrow({ where: { id: f.a } })).reservedStock, 1);
  });
  for (const reverse of [false, true]) {
    it(`additional intent supports two legitimate orders, confirmation order ${reverse ? "reversed" : "forward"}`, async () => {
      const f = await fixture(); await addCartItem(f.userId, f.a, 1); const one = await order(f);
      await addCartItem(f.userId, f.a, 2); const two = await order(f);
      for (const o of reverse ? [two, one] : [one, two]) { await success(o.id); await reconcilePendingCarts(); }
      assert.deepEqual(await quantities(f), { a: 1, b: 0 });
      assert.equal((await provenance(one.id)).state, "CONSUMED"); assert.equal((await provenance(two.id)).state, "CONSUMED");
    });
  }
  it("reducing overlapping allocations detaches oldest provenance first deterministically", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const one = await order(f);
    await addCartItem(f.userId, f.a, 1); const two = await order(f); await updateCartItem(f.userId, f.a, 1);
    assert.equal((await provenance(one.id)).allocations[0].visibleQuantity, 0);
    assert.equal((await provenance(two.id)).allocations[0].visibleQuantity, 1);
    await success(one.id); await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 1, b: 0 });
    await success(two.id); await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 0, b: 0 });
  });
  for (const type of ["payment_intent.payment_failed", "payment_intent.canceled"] as const) {
    it(`${type} does not consume pending allocations`, async () => {
      const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f), p = await payment(o.id);
      await reconcileStripePaymentEvent(outcome(p, type)); await reconcilePendingCarts();
      assert.equal((await provenance(o.id)).state, "ACTIVE"); assert.deepEqual(await quantities(f), { a: 1, b: 0 });
      await assert.rejects(() => order(f), CartQuantityAllocatedError);
    });
  }
  for (const terminal of ["cancel", "admin-cancel", "expire"] as const) {
    it(`${terminal} releases unpaid provenance without removing visible cart intent`, async () => {
      const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f);
      if (terminal === "cancel") await cancelOrder(f.userId, o.id, "CHANGED_MIND");
      else if (terminal === "admin-cancel") await cancelOrderByAdmin(o.id, "OUT_OF_STOCK", f.userId);
      else await expireOrderReservation(o.id, new Date(Date.now() + 3_600_000));
      assert.equal((await provenance(o.id)).state, "RELEASE_PENDING"); await reconcilePendingCarts();
      assert.equal((await provenance(o.id)).state, "RELEASED"); assert.deepEqual(await quantities(f), { a: 1, b: 0 });
      const later = await order(f); assert.equal((await provenance(later.id)).allocations[0].quantity, 1);
    });
  }
  it("expiry of one allocation does not corrupt another order's allocation", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const one = await order(f);
    await addCartItem(f.userId, f.a, 1); const two = await order(f);
    await expireOrderReservation(one.id, new Date(Date.now() + 3_600_000)); await reconcilePendingCarts();
    await success(two.id); await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 1, b: 0 });
  });
  for (const terminal of ["cancel", "expire"] as const) {
    it(`historical late recovery after ${terminal} records payment without resurrecting or consuming released intent`, async () => {
      const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f);
      if (terminal === "cancel") await cancelOrder(f.userId, o.id, "CHANGED_MIND"); else await expireOrderReservation(o.id, new Date(Date.now() + 3_600_000));
      // Inject a historical correlated attempt directly; supported initiation now rejects terminal orders.
      const p = await payment(o.id);
      await recoverStripePayment(o.id, f.userId, provider(p)); await reconcilePendingCarts();
      assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status, "SUCCEEDED");
      assert.equal((await provenance(o.id)).state, "RELEASED"); assert.deepEqual(await quantities(f), { a: 1, b: 0 });
      assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status, terminal === "cancel" ? "CANCELLED" : "EXPIRED");
      const receipt = await prisma.paymentWebhookEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: "STRIPE", providerEventId: `recovery:${p.id}:${p.providerReference}:succeeded` } } });
      assert.match(receipt.processingError!, /refund\/reconciliation/);
    });
  }
  it("legacy/no-provenance order success and recovery never subtract today's cart", async () => {
    const f = await fixture(); const o = await order(f); await addCartItem(f.userId, f.a, 2);
    assert.equal(await prisma.orderCartProvenance.findUnique({ where: { orderId: o.id } }), null);
    const p = await success(o.id); await recoverStripePayment(o.id, f.userId, provider(p)); await reconcilePendingCarts();
    assert.deepEqual(await quantities(f), { a: 2, b: 0 });
  });
  it("normal Order and cart reads never settle pending reconciliation", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f); await success(o.id);
    await getCustomerOrder(f.userId, o.id); await getCart(f.userId);
    assert.equal((await provenance(o.id)).state, "CONSUME_PENDING"); assert.deepEqual(await quantities(f), { a: 1, b: 0 });
  });
  it("cart reconciliation failure cannot roll back paid confirmation and remains retryable with no partial effects", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); await addCartItem(f.userId, f.b, 2);
    const o = await order(f, [{ productListingId: f.a, quantity: 1 }, { productListingId: f.b, quantity: 2 }]);
    // Synthetic inconsistency bypasses supported mutations, testing optional cleanup isolation.
    await prisma.cartItem.updateMany({ where: { cart: { userId: f.userId }, productListingId: f.b }, data: { quantity: 1 } });
    const p = await success(o.id); await reconcilePendingCarts();
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status, "CONFIRMED");
    assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status, "SUCCEEDED");
    assert.equal((await provenance(o.id)).state, "CONSUME_PENDING"); assert.ok((await provenance(o.id)).lastError);
    assert.deepEqual(await quantities(f), { a: 1, b: 1 }); // A's earlier subtraction rolled back too.
    await prisma.cartItem.updateMany({ where: { cart: { userId: f.userId }, productListingId: f.b }, data: { quantity: 2 } });
    await reconcilePendingCarts(); assert.equal((await provenance(o.id)).state, "CONSUMED"); assert.deepEqual(await quantities(f), { a: 0, b: 0 });
  });
  it("financial inventory failure rolls back success and its cart task together", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f), p = await payment(o.id);
    await prisma.productListing.update({ where: { id: f.a }, data: { reservedStock: 0 } });
    await assert.rejects(() => reconcileStripePaymentEvent(outcome(p)));
    assert.equal((await provenance(o.id)).state, "ACTIVE"); assert.equal((await prisma.payment.findUniqueOrThrow({ where: { id: p.id } })).status, "PROCESSING");
    assert.deepEqual(await quantities(f), { a: 1, b: 0 });
  });
  it("HTTP creation exposes stable allocation conflict without weakening ownership or verified email", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); await order(f);
    const response = await fetch(`${url}/orders`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${f.token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify({ shippingMethod: "STANDARD" as const, items: [{ productListingId: f.a, quantity: 1 }] }) });
    assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "CART_QUANTITY_UNAVAILABLE");
    const other = await fixture(); await addCartItem(other.userId, other.a, 1); const otherOrder = await order(other);
    await success(otherOrder.id); await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 1, b: 0 });
  });
  it("settles committed terminal release before a new order allocation without requiring the worker tick", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const one = await order(f);
    await cancelOrder(f.userId, one.id, "CHANGED_MIND"); const two = await order(f);
    assert.equal((await provenance(one.id)).state, "RELEASED"); assert.equal((await provenance(two.id)).state, "ACTIVE");
  });
  it("rejects paid cancellation while still consuming purchased provenance", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f); await success(o.id);
    await assert.rejects(cancelOrder(f.userId, o.id, "CHANGED_MIND"), OrderCancellationPaymentError); await reconcilePendingCarts();
    assert.equal((await provenance(o.id)).state, "CONSUMED"); assert.deepEqual(await quantities(f), { a: 0, b: 0 });
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status, "CONFIRMED");
    const listing = await prisma.productListing.findUniqueOrThrow({ where: { id: f.a } });
    assert.equal(listing.currentStock, 49); assert.equal(listing.reservedStock, 0);
  });

  it("cart projection exposes allocated and unallocated quantities without raw provenance", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); await order(f); await addCartItem(f.userId, f.a, 1);
    const item = (await getCart(f.userId)).items[0];
    assert.equal(item.quantity, 2); assert.equal(item.allocatedQuantity, 1); assert.equal(item.unallocatedQuantity, 1);
    assert.equal("orderAllocations" in item, false);
  });
  it("Stripe initiation observes no authoritative success and cannot consume provenance", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f);
    const intent = { id: `pi_test_${randomUUID()}`, status: "succeeded", client_secret: "test_only" };
    const client = { paymentIntents: { create: async (input: {amount:number; currency:string; metadata:Record<string,string>}) => ({...intent,...input}) } } as unknown as StripePaymentClient;
    await createOrReuseStripePaymentIntent(o.id, f.userId, client); await reconcilePendingCarts();
    assert.equal((await provenance(o.id)).state, "ACTIVE"); assert.deepEqual(await quantities(f), { a: 1, b: 0 });
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status, "PENDING");
  });
  it("the additive migration contains no historical allocation backfill", () => {
    const sql = readFileSync("prisma/migrations/20261007120000_add_order_cart_provenance/migration.sql", "utf8");
    assert.equal(/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\s+(INTO|FROM|TABLE|")/i.test(sql), false);
    assert.match(sql, /UNIQUE INDEX/); assert.match(sql, /ON DELETE SET NULL/); assert.match(sql, /CHECK/);
  });
  it("database allocation constraints reject impossible quantities and duplicate order/listing identities", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f), allocation = (await provenance(o.id)).allocations[0];
    await assert.rejects(() => prisma.orderCartAllocation.update({ where: { id: allocation.id }, data: { visibleQuantity: 2 } }));
    await assert.rejects(() => prisma.orderCartAllocation.create({ data: { orderId: o.id, productListingId: f.a, cartItemId: allocation.cartItemId, quantity: 1, visibleQuantity: 1 } }));
    assert.equal((await provenance(o.id)).allocations[0].visibleQuantity, 1);
  });

  it("DELETE succeeds when settling success consumes the original last quantity", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f); await success(o.id);
    await removeCartItem(f.userId, f.a); assert.deepEqual(await quantities(f), { a: 0, b: 0 }); assert.equal((await provenance(o.id)).state, "CONSUMED");
  });
  it("PATCH creates fresh intent when committed success consumed the original row", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f); await success(o.id);
    await updateCartItem(f.userId, f.a, 2); await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 2, b: 0 });
    assert.equal((await provenance(o.id)).allocations[0].cartItemId, null);
  });

  it("mismatched provenance cannot consume another listing or silently mark work complete", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f); await success(o.id);
    await prisma.orderCartAllocation.updateMany({ where: { orderId: o.id }, data: { productListingId: f.b } });
    await reconcilePendingCarts(); assert.equal((await provenance(o.id)).state, "CONSUME_PENDING");
    assert.match((await provenance(o.id)).lastError!, /identity inconsistency/); assert.deepEqual(await quantities(f), { a: 1, b: 0 });
    await prisma.orderCartAllocation.updateMany({ where: { orderId: o.id }, data: { productListingId: f.a } });
    await reconcilePendingCarts(); assert.equal((await provenance(o.id)).state, "CONSUMED");
  });
  it("startup worker drains durable work left by an earlier confirmation", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f); await success(o.id);
    const stop = startCartReconciliationWorker(20);
    try {
      const deadline = Date.now() + 2_000;
      while ((await provenance(o.id)).state !== "CONSUMED" && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal((await provenance(o.id)).state, "CONSUMED");
    } finally { stop(); }
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(await quantities(f), { a: 0, b: 0 });
  });
  it("one customer's failed task does not prevent another customer's cleanup", async () => {
    const bad = await fixture(); await addCartItem(bad.userId, bad.a, 1); const one = await order(bad); await success(one.id);
    await prisma.cartItem.updateMany({ where: { cart: { userId: bad.userId } }, data: { quantity: 0 } });
    const good = await fixture(); await addCartItem(good.userId, good.a, 1); const two = await order(good); await success(two.id);
    await reconcilePendingCarts(); assert.equal((await provenance(one.id)).state, "CONSUME_PENDING");
    assert.equal((await provenance(two.id)).state, "CONSUMED"); assert.deepEqual(await quantities(good), { a: 0, b: 0 });
  });
  it("opposite multi-listing payload order uses a consistent inventory lock order", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 2); await addCartItem(f.userId, f.b, 2);
    const one = await order(f, [{ productListingId: f.a, quantity: 1 }, { productListingId: f.b, quantity: 1 }]);
    const two = await order(f, [{ productListingId: f.b, quantity: 1 }, { productListingId: f.a, quantity: 1 }]);
    const firstPayment = await payment(one.id), secondPayment = await payment(two.id);
    let release!: () => void, ready!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<number>((resolve) => { ready = resolve; });
    const held = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "ProductListing" WHERE id = ${Math.min(f.a, f.b)} FOR UPDATE`;
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; ready(row.pid); await gate;
    }, { timeout: 10_000 });
    const pid = await started, paths = [reconcileStripePaymentEvent(outcome(firstPayment)), reconcileStripePaymentEvent(outcome(secondPayment))];
    try { await waitForBlocked(pid, 2); } finally { release(); await held; }
    await Promise.all(paths); await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 0, b: 0 });
    assert.equal(await prisma.inventoryMovement.count({ where: { listingId: { in: [f.a, f.b] }, type: "WEBSITE_SALE" } }), 4);
  });

  it("already allocated quantity returns the stable conflict even when the first reservation exhausted stock", async () => {
    const f = await fixture(1); await addCartItem(f.userId, f.a, 1); await order(f);
    await assert.rejects(() => order(f), CartQuantityAllocatedError);
    const response = await fetch(`${url}/orders`, { method: "POST", headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${f.token}`, "Content-Type": "application/json", "Idempotency-Key": randomUUID() }, body: JSON.stringify({ shippingMethod: "STANDARD" as const, items: [{ productListingId: f.a, quantity: 1 }] }) });
    assert.equal(response.status, 409); assert.equal((await response.json()).error.code, "CART_QUANTITY_UNAVAILABLE");
    assert.equal(await prisma.order.count({ where: { userId: f.userId } }), 1);
  });

  it("two concurrent order creations cannot allocate the same intent", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const held = await holdCart(f);
    const attempts = [order(f), order(f)].map((p) => p.then((value) => ({ value }), (error) => ({ error })));
    try { await waitForBlocked(held.pid, 2); } finally { await held.release(); }
    const results = await Promise.all(attempts);
    assert.equal(results.filter((r) => "value" in r).length, 1); assert.ok(results.some((r) => "error" in r && r.error instanceof CartQuantityAllocatedError));
    assert.equal(await prisma.orderCartAllocation.count({ where: { provenance: { cart: { userId: f.userId } } } }), 1);
  });
  it("concurrent idempotent creation shares one Order and one allocation", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const key = randomUUID(), held = await holdCart(f);
    const attempts = [order(f, undefined, key), order(f, undefined, key)];
    try { await waitForBlocked(held.pid, 2); } finally { await held.release(); }
    const [one, two] = await Promise.all(attempts); assert.equal(one.id, two.id); assert.equal((await provenance(one.id)).allocations.length, 1);
  });
  for (const mutation of ["add", "update", "remove", "clear"] as const) {
    it(`${mutation} overlaps authoritative confirmation without financial/cart lock inversion`, async () => {
      const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f); await addCartItem(f.userId, f.a, 1);
      const held = await holdCart(f);
      const operation = mutation === "add" ? addCartItem(f.userId, f.a, 1) : mutation === "update" ? updateCartItem(f.userId, f.a, 2) : mutation === "remove" ? removeCartItem(f.userId, f.a) : clearCart(f.userId);
      try {
        await waitForBlocked(held.pid, 1);
        // Must finish while the cart lock is still held; confirmation never takes it.
        await success(o.id); assert.equal((await provenance(o.id)).state, "CONSUME_PENDING");
      } finally { await held.release(); }
      await operation; await reconcilePendingCarts();
      assert.deepEqual(await quantities(f), { a: mutation === "add" || mutation === "update" ? 2 : 0, b: 0 });
      assert.equal((await provenance(o.id)).state, "CONSUMED");
    });
  }
  it("two reconciliation workers really overlap and commit one cart effect", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f); await success(o.id); await addCartItem(f.userId, f.b, 1);
    // add settles queued work, so queue another synthetic eligible order for the race.
    await addCartItem(f.userId, f.a, 1); const second = await order(f); await success(second.id);
    const held = await holdCart(f), workers = [reconcilePendingCarts(), reconcilePendingCarts()];
    try { await waitForBlocked(held.pid, 2); } finally { await held.release(); }
    await Promise.all(workers); assert.deepEqual(await quantities(f), { a: 0, b: 1 }); assert.equal((await provenance(second.id)).state, "CONSUMED");
  });
  it("webhook and recovery queue once under genuinely overlapping Order locks", async () => {
    const f = await fixture(); await addCartItem(f.userId, f.a, 1); const o = await order(f), p = await payment(o.id);
    let release!: () => void, ready!: (pid: number) => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }); const started = new Promise<number>((resolve) => { ready = resolve; });
    const held = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${o.id} FOR UPDATE`;
      const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`; ready(row.pid); await gate;
    }, { timeout: 10_000 });
    const pid = await started;
    const paths = [reconcileStripePaymentEvent(outcome(p)), recoverStripePayment(o.id, f.userId, provider(p))];
    try { await waitForBlocked(pid, 2); } finally { release(); await held; }
    await Promise.all(paths); await reconcilePendingCarts(); assert.deepEqual(await quantities(f), { a: 0, b: 0 });
    assert.equal(await prisma.inventoryMovement.count({ where: { listingId: f.a, type: "WEBSITE_SALE" } }), 1); assert.equal((await provenance(o.id)).state, "CONSUMED");
  });
});
