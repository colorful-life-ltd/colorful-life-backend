import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { prisma } from "../prisma/runtime.js";
import { createOrReplaceEmailVerificationToken } from "../domain/auth/emailVerificationService.js";
import { createOrReplacePasswordResetToken } from "../domain/auth/passwordResetService.js";
import { deleteCustomerAccount } from "../domain/auth/accountDeletionService.js";
import { AccountDeletionAdminNotAllowedError, AccountDeletionUserNotFoundError } from "../domain/auth/accountDeletionErrors.js";
import { settleCartReconciliation } from "../domain/cart/cartProvenanceService.js";

const ids: number[] = [];
const orderIds: number[] = [];
const listingIds: number[] = [];
const productIds: number[] = [];
afterEach(async () => {
  if (orderIds.length) await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  if (ids.length) await prisma.cartItem.deleteMany({ where: { cart: { userId: { in: ids } } } });
  if (listingIds.length) await prisma.productListing.deleteMany({ where: { id: { in: listingIds } } });
  if (productIds.length) await prisma.legoProduct.deleteMany({ where: { id: { in: productIds } } });
  if (ids.length) await prisma.user.deleteMany({ where: { id: { in: ids } } });
  orderIds.length = listingIds.length = productIds.length = ids.length = 0;
});

async function user(role: "CUSTOMER" | "ADMIN" = "CUSTOMER") {
  const created = await prisma.user.create({
    data: {
      email: `${randomUUID()}@example.com`, passwordHash: await bcrypt.hash("Abcdef1!", 4), role,
      firstName: "Ada", lastName: "Lovelace", phone: "07123456789",
      addresses: { create: { recipientName: "Ada Lovelace", line1: "1 Test Street", city: "Testville", postcode: "T1", countryCode: "GB" } },
    },
  });
  ids.push(created.id); return created;
}

describe("account deletion domain", () => {
  it("tombstones the account and erases account-side data", async () => {
    const created = await user();
    const verification = await createOrReplaceEmailVerificationToken(created.id);
    const reset = await createOrReplacePasswordResetToken(created.id);
    await prisma.refreshSession.create({ data: { userId: created.id, refreshTokenHash: randomUUID(), expiresAt: new Date(Date.now() + 86400000) } });
    const deletedAt = new Date("2026-01-01T00:00:00.000Z");
    await deleteCustomerAccount(created.id, deletedAt);
    const result = await prisma.user.findUnique({ where: { id: created.id } });
    assert.ok(result); assert.equal(result.id, created.id); assert.equal(result.deletedAt?.getTime(), deletedAt.getTime());
    assert.notEqual(result.email, created.email); assert.match(result.email, /^deleted-\d+-[a-f0-9]+@deleted\.invalid$/); assert.equal(result.email.includes(created.email), false);
    assert.equal(result.firstName, null); assert.equal(result.lastName, null); assert.equal(result.phone, null); assert.notEqual(result.passwordHash, created.passwordHash);
    assert.equal(await prisma.address.count({ where: { userId: created.id } }), 0);
    assert.equal(await prisma.emailVerificationToken.count({ where: { userId: created.id } }), 0);
    assert.equal(await prisma.passwordResetToken.count({ where: { userId: created.id } }), 0);
    assert.equal(await prisma.refreshSession.count({ where: { userId: created.id } }), 0);
    assert.ok(verification.rawToken); assert.ok(reset.rawToken);
  });

  it("releases the original email and is idempotent", async () => {
    const created = await user(); const original = created.email; await deleteCustomerAccount(created.id);
    const replacement = await prisma.user.create({ data: { email: original, passwordHash: "not-a-bcrypt-hash" } }); ids.push(replacement.id);
    await deleteCustomerAccount(created.id); const tombstone = await prisma.user.findUnique({ where: { id: created.id } });
    assert.equal(tombstone?.email, (await prisma.user.findUnique({ where: { id: created.id } }))?.email); assert.notEqual(replacement.id, created.id);
  });

  it("preserves historical orders, items, and snapshots", async () => {
    const created = await user();
    const product = await prisma.legoProduct.create({ data: { setNumber: `DEL-${randomUUID()}`, title: "Historical", description: "History", theme: "TEST", ageRecommendation: "8+", pieceCount: 10 } });
    productIds.push(product.id);
    const listing = await prisma.productListing.create({ data: {
        legoProductId: product.id, condition: "NEW", originalPrice: 20, currentStock: 1 } });
    listingIds.push(listing.id);
    const order = await prisma.order.create({ data: {
      userId: created.id, billingRecipientName: "Historical Customer", billingLine1: "1 Old Street", billingCity: "Oldtown", billingPostcode: "O1", billingCountryCode: "GB",
      deliveryRecipientName: "Historical Customer", deliveryLine1: "1 Old Street", deliveryCity: "Oldtown", deliveryPostcode: "O1", deliveryCountryCode: "GB", totalAmount: 20,
      orderItems: { create: { productListingId: listing.id, quantity: 1, unitPrice: 20, lineTotal: 20 } },
    }, include: { orderItems: true } });
    orderIds.push(order.id);
    const cart = await prisma.cart.create({ data: { userId: created.id } });
    const cartItem = await prisma.cartItem.create({ data: { cartId: cart.id, productListingId: listing.id, quantity: 1 } });
    await prisma.orderCartProvenance.create({ data: { orderId: order.id, cartId: cart.id, state: 'CONSUME_PENDING',
      allocations: { create: { cartItemId: cartItem.id, productListingId: listing.id, quantity: 1, visibleQuantity: 1 } } } });
    const payment = await prisma.payment.create({ data: { orderId: order.id, amount: 20, provider: 'MANUAL', providerReference: randomUUID(), status: 'SUCCEEDED' } });
    const refund = await prisma.refund.create({ data: { orderId: order.id, paymentId: payment.id, amount: 1, currency: 'GBP', provider: 'MANUAL', providerReference: randomUUID() } });
    const invoiceNumber = randomUUID();
    const invoice = await prisma.commercialInvoice.create({ data: { orderId: order.id, invoiceNumber,
      snapshot: { version: 1, invoiceNumber, purchase: { orderId: order.id, recipientEmail: created.email } } } });
    // Issued invoices are protected even from fixture cleanup. Keep this synthetic
    // financial graph in the disposable test DB, as the invoice suites do; never
    // disable the retention trigger or cascade-delete its dependencies.
    orderIds.splice(orderIds.indexOf(order.id), 1);
    listingIds.splice(listingIds.indexOf(listing.id), 1);
    productIds.splice(productIds.indexOf(product.id), 1);
    ids.splice(ids.indexOf(created.id), 1);
    await deleteCustomerAccount(created.id);
    await deleteCustomerAccount(created.id);
    const preserved = await prisma.order.findUnique({ where: { id: order.id }, include: { orderItems: true } });
    assert.ok(preserved); assert.equal(preserved.userId, created.id); assert.equal(preserved.status, order.status); assert.equal(preserved.billingLine1, "1 Old Street"); assert.equal(preserved.deliveryPostcode, "O1"); assert.equal(preserved.orderItems.length, 1); assert.equal(preserved.orderItems[0].id, order.orderItems[0].id);
    assert.equal(await prisma.cartItem.count({ where: { cartId: cart.id } }), 0);
    const allocation = await prisma.orderCartAllocation.findFirstOrThrow({ where: { orderId: order.id } });
    assert.equal(allocation.cartItemId, null);
    assert.equal(allocation.quantity, 1);
    await prisma.$transaction(tx => settleCartReconciliation(tx, created.id));
    assert.equal(await prisma.cartItem.count({ where: { cartId: cart.id } }), 0);
    assert.equal((await prisma.orderCartProvenance.findUniqueOrThrow({ where: { orderId: order.id } })).state, 'CONSUMED');
    assert.deepEqual(await prisma.payment.findUnique({ where: { id: payment.id } }), payment);
    assert.deepEqual(await prisma.refund.findUnique({ where: { id: refund.id } }), refund);
    assert.deepEqual(await prisma.commercialInvoice.findUnique({ where: { id: invoice.id } }), invoice);
    const audits = await prisma.operationalAudit.count({ where: { actorId: created.id, kind: 'ACCOUNT_DELETED' } });
    assert.equal(audits, 1);
  });

  it("rejects Admin and missing Users", async () => {
    const admin = await user("ADMIN"); await assert.rejects(() => deleteCustomerAccount(admin.id), AccountDeletionAdminNotAllowedError);
    const missing = await user(); await prisma.user.delete({ where: { id: missing.id } }); ids.splice(ids.indexOf(missing.id), 1);
    await assert.rejects(() => deleteCustomerAccount(missing.id), AccountDeletionUserNotFoundError);
  });
});
