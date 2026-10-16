import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { Decimal } from "@prisma/client/runtime/client";
import { prisma } from "../prisma/runtime.js";
import { createOrder } from "../domain/orders/orderService.js";
import { createPayment } from "../domain/payments/paymentService.js";
import { createRefund, getOrderRefunds } from "../domain/refunds/refundService.js";
import {
  RefundAmountExceededError,
  RefundInvalidAmountError,
  RefundInvalidProviderReferenceError,
  RefundInvalidReasonError,
  RefundOrderNotFoundError,
  RefundPaymentNotFoundError,
  RefundPaymentNotRefundableError,
  RefundProviderReferenceConflictError,
} from "../domain/refunds/refundErrors.js";
import { PaymentStatus, RefundProvider, RefundStatus } from "../generated/prisma-client/enums.js";

const userIds: number[] = [], productIds: number[] = [], listingIds: number[] = [], orderIds: number[] = [], paymentIds: number[] = [], refundIds: number[] = [];

async function fixture(quantity = 1) {
  const user = await prisma.user.create({ data: { email: `refund-${randomUUID()}@example.com`, passwordHash: "hashed", emailVerified: true, role: "CUSTOMER", addresses: { create: { recipientName: "Refund User", line1: "1 Test Street", city: "Testville", postcode: "TEST1", countryCode: "GB", isDefaultBilling: true } } } });
  userIds.push(user.id);
  const product = await prisma.legoProduct.create({ data: { setNumber: `REFUND-${randomUUID()}`, title: "Refund Product", theme: "TEST", ageRecommendation: "8+", pieceCount: 100, productListings: { create: {
            condition: "NEW", originalPrice: new Decimal("50.00"), salePrice: new Decimal("50.00"), currentStock: 10, active: true } } }, include: { productListings: true } });
  productIds.push(product.id); const listing = product.productListings[0]; listingIds.push(listing.id);
  const order = await createOrder(user.id, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity }] }); orderIds.push(order.id);
  const payment = await createPayment(order.id, { providerReference: `payment-${randomUUID()}` }); paymentIds.push(payment.id);
  return { user, product, listing, order, payment };
}

async function refund(orderId: number, paymentId: number, amount: number | Decimal, reference = `refund-${randomUUID()}`, reason?: string, actor?: number) {
  const result = await createRefund(orderId, paymentId, amount, reference, reason, actor ?? userIds[0]); refundIds.push(result.refund.id); return result;
}

describe("Refund domain service", () => {
  afterEach(async () => {
    if (refundIds.length) { await prisma.refund.deleteMany({ where: { id: { in: refundIds } } }); refundIds.length = 0; }
    if (paymentIds.length) { await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } }); paymentIds.length = 0; }
    if (orderIds.length) { await prisma.order.deleteMany({ where: { id: { in: orderIds } } }); orderIds.length = 0; }
    if (listingIds.length) { await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listingIds } } }); await prisma.productListing.deleteMany({ where: { id: { in: listingIds } } }); listingIds.length = 0; }
    if (productIds.length) { await prisma.legoProduct.deleteMany({ where: { id: { in: productIds } } }); productIds.length = 0; }
    if (userIds.length) { await prisma.user.deleteMany({ where: { id: { in: userIds } } }); userIds.length = 0; }
  });

  it("creates a full refund without unrelated side effects", async () => {
    const f = await fixture();
    const orderBefore = await prisma.order.findUnique({ where: { id: f.order.id } });
    const returnsBefore = await prisma.orderReturn.findMany({ where: { orderItem: { orderId: f.order.id } } });
    const itemBefore = await prisma.orderItem.findFirst({ where: { orderId: f.order.id } });
    const listingBefore = await prisma.productListing.findUnique({ where: { id: f.listing.id } });
    const movementsBefore = await prisma.inventoryMovement.findMany({ where: { listingId: f.listing.id } });
    const paymentBefore = await prisma.payment.findUnique({ where: { id: f.payment.id } });
    const r = await refund(f.order.id, f.payment.id, f.payment.amount, undefined, "Full", f.user.id);
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.refund.orderId, f.order.id);
    assert.strictEqual(r.refund.paymentId, f.payment.id);
    assert.strictEqual(r.refund.currency, paymentBefore?.currency);
    assert.strictEqual(r.refund.provider, RefundProvider.MANUAL);
    assert.strictEqual(r.refund.status, RefundStatus.SUCCEEDED);
    assert.strictEqual(r.refund.performedByUserId, f.user.id);
    const orderAfter = await prisma.order.findUnique({ where: { id: f.order.id } });
    const returnsAfter = await prisma.orderReturn.findMany({ where: { orderItem: { orderId: f.order.id } } });
    const itemAfter = await prisma.orderItem.findFirst({ where: { orderId: f.order.id } });
    const listingAfter = await prisma.productListing.findUnique({ where: { id: f.listing.id } });
    const movementsAfter = await prisma.inventoryMovement.findMany({ where: { listingId: f.listing.id } });
    const paymentAfter = await prisma.payment.findUnique({ where: { id: f.payment.id } });
    assert.strictEqual(orderAfter?.status, orderBefore?.status);
    assert.deepStrictEqual(returnsAfter, returnsBefore);
    assert.strictEqual(itemAfter?.returnedQuantity, itemBefore?.returnedQuantity);
    assert.strictEqual(listingAfter?.currentStock, listingBefore?.currentStock);
    assert.deepStrictEqual(movementsAfter, movementsBefore);
    assert.strictEqual(paymentAfter?.amount.toString(), paymentBefore?.amount.toString());
    assert.strictEqual(paymentAfter?.refundedAmount.toString(), f.payment.amount.toString());
  });
  it("supports partial and multiple refunds", async () => { const f = await fixture(); await refund(f.order.id, f.payment.id, 20); await refund(f.order.id, f.payment.id, 30); assert.strictEqual((await prisma.payment.findUnique({ where: { id: f.payment.id } }))?.refundedAmount.toString(), "50"); });
  it("validates amounts and fields", async () => { const f = await fixture(); for (const amount of [0, -1, 1.001]) await assert.rejects(createRefund(f.order.id, f.payment.id, amount, `x-${randomUUID()}`, undefined, f.user.id), RefundInvalidAmountError); await assert.rejects(createRefund(f.order.id, f.payment.id, 1, "   ", undefined, f.user.id), RefundInvalidProviderReferenceError); await assert.rejects(createRefund(f.order.id, f.payment.id, 1, `x-${randomUUID()}`, "   ", f.user.id), RefundInvalidReasonError); const r = await refund(f.order.id, f.payment.id, 1, undefined, "  note  ", f.user.id); assert.strictEqual(r.refund.reason, "note"); });
  it("rejects missing and mismatched resources", async () => { const a = await fixture(); const b = await fixture(); await assert.rejects(createRefund(999999999, a.payment.id, 1, `x-${randomUUID()}`, undefined, a.user.id), RefundOrderNotFoundError); await assert.rejects(createRefund(a.order.id, 999999999, 1, `x-${randomUUID()}`, undefined, a.user.id), RefundPaymentNotFoundError); await assert.rejects(createRefund(a.order.id, b.payment.id, 1, `x-${randomUUID()}`, undefined, a.user.id), RefundPaymentNotFoundError); });
  it("rejects non-succeeded payments and rolls back over-refunds", async () => {
    const f = await fixture();
    await prisma.payment.update({ where: { id: f.payment.id }, data: { status: PaymentStatus.FAILED } });
    await assert.rejects(createRefund(f.order.id, f.payment.id, 1, `x-${randomUUID()}`, undefined, f.user.id), RefundPaymentNotRefundableError);
    const g = await fixture();
    await refund(g.order.id, g.payment.id, 40);
    const failedReference = `failed-${randomUUID()}`;
    await assert.rejects(createRefund(g.order.id, g.payment.id, g.payment.amount.minus(40).add("0.01"), failedReference, undefined, g.user.id), RefundAmountExceededError);
    const payment = await prisma.payment.findUnique({ where: { id: g.payment.id } });
    assert.strictEqual(payment?.refundedAmount.toString(), "40");
    assert.strictEqual(await prisma.refund.count({ where: { paymentId: g.payment.id } }), 1);
    assert.strictEqual(await prisma.refund.count({ where: { providerReference: failedReference } }), 0);
  });
  it("is idempotent and rejects reference conflicts", async () => { const a = await fixture(); const b = await fixture(); const ref = `same-${randomUUID()}`; const first = await refund(a.order.id, a.payment.id, 10, ref); const replay = await refund(a.order.id, a.payment.id, 10, ref); assert.strictEqual(replay.created, false); assert.strictEqual(replay.refund.id, first.refund.id); await assert.rejects(createRefund(a.order.id, a.payment.id, 11, ref, undefined, a.user.id), RefundProviderReferenceConflictError); await assert.rejects(createRefund(b.order.id, b.payment.id, 10, ref, undefined, b.user.id), RefundProviderReferenceConflictError); });
  it("exposes payment/order mismatch with an existing idempotency reference", async () => { const a = await fixture(); const b = await fixture(); const ref = `mismatch-${randomUUID()}`; await refund(a.order.id, a.payment.id, 5, ref); await assert.rejects(createRefund(b.order.id, a.payment.id, 5, ref, undefined, b.user.id), RefundPaymentNotFoundError); });
  it("handles concurrent identical requests once", async () => { const f = await fixture(); const ref = `race-${randomUUID()}`; const results = await Promise.all([refund(f.order.id, f.payment.id, 10, ref), refund(f.order.id, f.payment.id, 10, ref)]); assert.strictEqual(results.filter((r) => r.created).length, 1); assert.strictEqual(results.filter((r) => !r.created).length, 1); assert.strictEqual(await prisma.refund.count({ where: { providerReference: ref } }), 1); assert.strictEqual((await prisma.payment.findUnique({ where: { id: f.payment.id } }))?.refundedAmount.toString(), "10"); });
  it("prevents concurrent different refunds exceeding payment amount", async () => {
    const f = await fixture();
    const firstReference = `race-a-${randomUUID()}`;
    const secondReference = `race-b-${randomUUID()}`;
    const results = await Promise.allSettled([
      refund(f.order.id, f.payment.id, 30, firstReference, undefined, f.user.id),
      refund(f.order.id, f.payment.id, 30, secondReference, undefined, f.user.id),
    ]);
    assert.strictEqual(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.strictEqual(results.filter((r) => r.status === "rejected" && r.reason instanceof RefundAmountExceededError).length, 1);
    const successful = results.find((r) => r.status === "fulfilled")!;
    const failedReference = results[0].status === "rejected" ? firstReference : secondReference;
    const successfulId = (successful as PromiseFulfilledResult<{ refund: { id: number } }>).value.refund.id;
    const persisted = await prisma.refund.findMany({ where: { providerReference: { in: [firstReference, secondReference] } } });
    const payment = await prisma.payment.findUnique({ where: { id: f.payment.id } });
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0].id, successfulId);
    assert.strictEqual(await prisma.refund.count({ where: { providerReference: failedReference } }), 0);
    assert.strictEqual(persisted.reduce((sum, item) => sum.add(item.amount), new Decimal(0)).toString(), payment!.refundedAmount.toString());
    assert.ok(payment!.refundedAmount.lte(payment!.amount));
  });
  it("lists only order refunds in deterministic order", async () => { const a = await fixture(); const b = await fixture(); const first = await refund(a.order.id, a.payment.id, 5); const second = await refund(a.order.id, a.payment.id, 6); await refund(b.order.id, b.payment.id, 7); const listed = await getOrderRefunds(a.order.id); assert.deepStrictEqual(listed.map((r) => r.id), [first.refund.id, second.refund.id]); assert.ok(listed.every((r) => r.orderId === a.order.id)); await assert.rejects(getOrderRefunds(999999999), RefundOrderNotFoundError); });
});
