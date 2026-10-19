import { recordVerifiedPayment } from "./fixtures/verifiedPayment.js";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { Decimal } from "@prisma/client/runtime/client";
import { prisma } from "../prisma/runtime.js";
import { createOrder } from "../domain/orders/orderService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import { cancelOrder } from "../domain/orders/orderCancellationService.js";
import { createPayment } from "./helpers/manualPayment.js";
import { expireOrderReservation } from "../domain/orders/orderExpiryService.js";
import { InsufficientReservedStockError } from "../domain/orders/orderCancellationErrors.js";

const userIds: number[] = [];
const productIds: number[] = [];
const listingIds: number[] = [];
const orderIds: number[] = [];
let adminUserId: number;

async function fixture(quantity = 2) {
  const user = await prisma.user.create({ data: {
    email: `expiry-${randomUUID()}@example.com`, passwordHash: "hash", role: "CUSTOMER", emailVerified: true,
    addresses: { create: { recipientName: "Expiry", line1: "1 Test Street", city: "Testville", postcode: "T1", countryCode: "GB", isDefaultBilling: true } },
  } });
  userIds.push(user.id);
  const product = await prisma.legoProduct.create({ data: { setNumber: `EXP-${randomUUID()}`, title: "Expiry", theme: "TEST", ageRecommendation: "8+", pieceCount: 10 } });
  productIds.push(product.id);
  const listing = await prisma.productListing.create({ data: {
        legoProductId: product.id, condition: "NEW", originalPrice: new Decimal(10), currentStock: 5, active: true } });
  listingIds.push(listing.id);
  const order = await createOrder(user.id, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity }] });
  orderIds.push(order.id);
  return { user, listing, order };
}

before(async () => {
  const admin = await prisma.user.create({ data: {
    email: `expiry-admin-${randomUUID()}@example.com`, passwordHash: "hash", role: "ADMIN", emailVerified: true,
  } });
  adminUserId = admin.id;
  userIds.push(admin.id);
});
after(async () => {
  if (orderIds.length) await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  if (listingIds.length) await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listingIds } } });
  if (listingIds.length) await prisma.productListing.deleteMany({ where: { id: { in: listingIds } } });
  if (productIds.length) await prisma.legoProduct.deleteMany({ where: { id: { in: productIds } } });
  if (userIds.length) { await prisma.address.deleteMany({ where: { userId: { in: userIds } } }); await prisma.user.deleteMany({ where: { id: { in: userIds } } }); }
  await prisma.$disconnect();
});

describe("Order expiry domain service", () => {
  it("expires an unpaid order and releases reservation without movement", async () => {
    const f = await fixture();
    const expiredAt = new Date(Date.now() - 1000);
    await prisma.order.update({ where: { id: f.order.id }, data: { reservationExpiresAt: expiredAt } });
    const before = await prisma.productListing.findUnique({ where: { id: f.listing.id } });
    const result = await expireOrderReservation(f.order.id, new Date());
    const order = await prisma.order.findUnique({ where: { id: f.order.id } });
    const listing = await prisma.productListing.findUnique({ where: { id: f.listing.id } });
    assert.strictEqual(result?.status, "EXPIRED");
    assert.strictEqual(order?.reservationExpiresAt, null);
    assert.strictEqual(listing?.reservedStock, 0);
    assert.strictEqual(listing?.currentStock, before?.currentStock);
    assert.strictEqual(await prisma.inventoryMovement.count({ where: { listingId: f.listing.id } }), 0);
  });

  it("skips unexpired and paid pending orders", async () => {
    const early = await fixture();
    await prisma.order.update({ where: { id: early.order.id }, data: { reservationExpiresAt: new Date(Date.now() + 60_000) } });
    assert.strictEqual(await expireOrderReservation(early.order.id), null);
    const paid = await fixture();
    await createPayment(paid.order.id, { providerReference: `expiry-paid-${randomUUID()}` });
    await prisma.order.update({ where: { id: paid.order.id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    assert.strictEqual(await expireOrderReservation(paid.order.id), null);
    assert.strictEqual((await prisma.order.findUnique({ where: { id: paid.order.id } }))?.status, "PENDING");
  });

  it("does not expire terminal orders and repeated expiry is a no-op", async () => {
    const confirmed = await fixture(1);
    await prisma.order.update({ where: { id: confirmed.order.id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
  await recordVerifiedPayment(confirmed.order.id);
    await confirmOrder(adminUserId, confirmed.order.id);
    assert.strictEqual(await expireOrderReservation(confirmed.order.id), null);
    const expired = await fixture(1);
    await prisma.order.update({ where: { id: expired.order.id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    await expireOrderReservation(expired.order.id);
    assert.strictEqual(await expireOrderReservation(expired.order.id), null);
  });

  it("rolls back state and earlier releases when a reservation is inconsistent", async () => {
    const f = await fixture(1);
    const second = await fixture(1);
    const multi = await prisma.order.update({ where: { id: f.order.id }, data: { reservationExpiresAt: new Date(Date.now() - 1000), orderItems: { create: { productListingId: second.listing.id, quantity: 1, unitPrice: 10, lineTotal: 10 } } }, include: { orderItems: true } });
    orderIds.push(multi.id);
    await prisma.productListing.update({ where: { id: second.listing.id }, data: { reservedStock: 0 } });
    await assert.rejects(() => expireOrderReservation(f.order.id), InsufficientReservedStockError);
    const order = await prisma.order.findUnique({ where: { id: f.order.id } });
    assert.strictEqual(order?.status, "PENDING");
    assert.strictEqual((await prisma.productListing.findUnique({ where: { id: f.listing.id } }))?.reservedStock, 1);
  });

  it("racing expiry with cancellation or confirmation yields one consistent outcome", async () => {
    const cancelFixture = await fixture(1);
    await prisma.order.update({ where: { id: cancelFixture.order.id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    await Promise.allSettled([expireOrderReservation(cancelFixture.order.id), cancelOrder(cancelFixture.user.id, cancelFixture.order.id, "CHANGED_MIND")]);
    const cancelled = await prisma.order.findUnique({ where: { id: cancelFixture.order.id } });
    assert.ok(cancelled?.status === "CANCELLED" || cancelled?.status === "EXPIRED");
    assert.strictEqual((await prisma.productListing.findUnique({ where: { id: cancelFixture.listing.id } }))?.reservedStock, 0);
    const confirmFixture = await fixture(1);
    await prisma.order.update({ where: { id: confirmFixture.order.id }, data: { reservationExpiresAt: new Date(Date.now() - 1000) } });
    await Promise.allSettled([expireOrderReservation(confirmFixture.order.id), confirmOrder(adminUserId, confirmFixture.order.id)]);
    const final = await prisma.order.findUnique({ where: { id: confirmFixture.order.id } });
    const listing = await prisma.productListing.findUnique({ where: { id: confirmFixture.listing.id } });
    assert.ok(final?.status === "CONFIRMED" || final?.status === "EXPIRED");
    assert.ok((listing?.reservedStock ?? 0) >= 0 && (listing?.reservedStock ?? 0) <= (listing?.currentStock ?? 0));
  });

  it("serializes an expiry race with a new payment", async () => {
    const f = await fixture(1);
    await prisma.order.update({
      where: { id: f.order.id },
      data: { reservationExpiresAt: new Date(Date.now() - 1000) },
    });

    const results = await Promise.allSettled([
      expireOrderReservation(f.order.id),
      createPayment(f.order.id, { providerReference: `expiry-race-${randomUUID()}` }),
    ]);
    const order = await prisma.order.findUnique({ where: { id: f.order.id } });
    const payments = await prisma.payment.count({ where: { orderId: f.order.id, status: "SUCCEEDED" } });
    const listing = await prisma.productListing.findUnique({ where: { id: f.listing.id } });

    assert.ok(results.some((result) => result.status === "fulfilled"));
    assert.ok(order?.status === "EXPIRED" || order?.status === "PENDING");
    assert.ok(!(order?.status === "EXPIRED" && payments > 0));
    assert.ok((listing?.reservedStock ?? 0) >= 0);
    assert.ok((listing?.currentStock ?? 0) >= 0);
    assert.ok((listing?.reservedStock ?? 0) <= (listing?.currentStock ?? 0));
  });
});
