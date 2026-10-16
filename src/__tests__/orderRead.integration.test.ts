import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { createOrder } from "../domain/orders/orderService.js";
import { OrderStatus } from "../generated/prisma-client/enums.js";

const userIds: number[] = [];
const productIds: number[] = [];
const listingIds: number[] = [];
const orderIds: number[] = [];
let server: ReturnType<typeof app.listen>;
let url: string;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  url = `http://localhost:${address.port}`;
});

after(async () => {
  await prisma.$disconnect();
  server.close();
});

afterEach(async () => {
  if (orderIds.length) await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  if (listingIds.length) await prisma.productListing.deleteMany({ where: { id: { in: listingIds } } });
  if (productIds.length) await prisma.legoProduct.deleteMany({ where: { id: { in: productIds } } });
  if (userIds.length) {
    await prisma.address.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  orderIds.length = listingIds.length = productIds.length = userIds.length = 0;
});

async function makeUser(role: "CUSTOMER" | "ADMIN" = "CUSTOMER") {
  const user = await prisma.user.create({
    data: {
      email: `${randomUUID()}@example.com`,
      passwordHash: "secret-hash",
      emailVerified: true,
      role,
      addresses: { create: { recipientName: "Customer", line1: "1 Test Street", city: "Testville", postcode: "T1", countryCode: "GB", isDefaultBilling: true } },
    },
  });
  userIds.push(user.id);
  return { ...user, token: jwt.sign({ id: user.id, role }, config.JWT_SECRET, { expiresIn: "1h" }) };
}

async function makeListing() {
  const product = await prisma.legoProduct.create({ data: { setNumber: `READ-${randomUUID()}`, title: "Read Product", theme: "TEST", ageRecommendation: "8+", pieceCount: 100 } });
  productIds.push(product.id);
  const listing = await prisma.productListing.create({ data: {
        legoProductId: product.id, condition: "NEW", originalPrice: 20, salePrice: 15, currentStock: 4 } });
  listingIds.push(listing.id);
  return listing;
}

async function makeOrder(customerId: number, listingId: number) {
  const order = await createOrder(customerId, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listingId, quantity: 2 }] });
  orderIds.push(order.id);
  return order;
}

async function get(token: string | undefined, path: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${url}${path}`, { headers });
}

describe("customer order reads", () => {
  it("lists only the authenticated customer's orders and returns [] when empty", async () => {
    const customer = await makeUser();
    assert.deepStrictEqual(await (await get(customer.token, "/orders")).json(), []);
    const listing = await makeListing();
    const order = await makeOrder(customer.id, listing.id);
    const other = await makeUser();
    const otherListing = await makeListing();
    await makeOrder(other.id, otherListing.id);
    const response = await get(customer.token, "/orders");
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.length, 1);
    assert.strictEqual(body[0].id, order.id);
  });

  it("reads an owned order with safe item, status, and total fields", async () => {
    const customer = await makeUser();
    const listing = await makeListing();
    const order = await makeOrder(customer.id, listing.id);
    const response = await get(customer.token, `/orders/${order.id}`);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.deepStrictEqual({ id: body.id, status: body.status, totalAmount: body.totalAmount, itemQuantity: body.orderItems[0].quantity, unitPrice: body.orderItems[0].unitPrice, lineTotal: body.orderItems[0].lineTotal }, { id: order.id, status: "PENDING", totalAmount: "33.99", itemQuantity: 2, unitPrice: "15", lineTotal: "30" });
    assert.equal(body.payment, null);
    assert.equal(body.reservationExpiresAt, order.reservationExpiresAt?.toISOString());
    for (const prefix of ["billing", "delivery"]) {
      assert.deepEqual(Object.fromEntries(["RecipientName", "Line1", "Line2", "City", "County", "Postcode", "CountryCode", "Phone"].map((field) => [field, body[`${prefix}${field}`]])), {
        RecipientName: "Customer", Line1: "1 Test Street", Line2: null,
        City: "Testville", County: null, Postcode: "T1", CountryCode: "GB", Phone: null,
      });
    }
    assert.strictEqual(body.orderItems[0].productListing.legoProduct.title, "Read Product");
    assert.strictEqual(body.actualShippingCost, undefined);
    assert.strictEqual(body.user, undefined);
    assert.strictEqual(body.passwordHash, undefined);
    assert.strictEqual(body.inventoryMovements, undefined);
    assert.strictEqual(body.inventoryAudits, undefined);
    assert.strictEqual(body.payments, undefined);
    assert.strictEqual(body.refunds, undefined);
    assert.strictEqual(body.returns, undefined);
  });

  it("exposes only authoritative payment status and paidAt to the owner", async () => {
    const owner = await makeUser(); const other = await makeUser(); const listing = await makeListing();
    const order = await makeOrder(owner.id, listing.id);
    await prisma.payment.create({ data: { orderId: order.id, amount: order.totalAmount, provider: "STRIPE", providerReference: "pi_private", status: "PROCESSING", idempotencyKey: randomUUID() } });
    const pending = await (await get(owner.token, `/orders/${order.id}`)).json();
    assert.deepEqual(pending.payment, { status: "PROCESSING", paidAt: null });
    const paidAt = new Date("2026-10-01T12:00:00Z");
    await prisma.payment.update({ where: { orderId: order.id }, data: { status: "SUCCEEDED", paidAt } });
    const paid = await (await get(owner.token, `/orders/${order.id}`)).json();
    assert.deepEqual(paid.payment, { status: "SUCCEEDED", paidAt: paidAt.toISOString() });
    assert.equal(paid.payments, undefined); assert.equal(paid.creationRequestHash, undefined);
    const forbidden = await get(other.token, `/orders/${order.id}`);
    assert.equal(forbidden.status, 404); assert.deepEqual(await forbidden.json(), { error: "Order not found" });
  });

  it("returns dispatch and completion fields but not actual shipping cost", async () => {
    const customer = await makeUser();
    const listing = await makeListing();
    const order = await makeOrder(customer.id, listing.id);
    const dispatchedAt = new Date("2026-09-01T10:00:00.000Z");
    const completedAt = new Date("2026-09-02T10:00:00.000Z");
    await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.COMPLETED, shippingCarrier: "UPS", trackingNumber: "TRACK", dispatchedAt, completedAt, actualShippingCost: 8 } });
    const body = await (await get(customer.token, `/orders/${order.id}`)).json();
    assert.strictEqual(body.status, "COMPLETED");
    assert.strictEqual(body.shippingCarrier, "UPS");
    assert.strictEqual(body.trackingNumber, "TRACK");
    assert.strictEqual(new Date(body.dispatchedAt).toISOString(), dispatchedAt.toISOString());
    assert.strictEqual(new Date(body.completedAt).toISOString(), completedAt.toISOString());
    assert.strictEqual(body.actualShippingCost, undefined);
  });

  it("returns the same 404 for another customer's or missing order", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const listing = await makeListing();
    const order = await makeOrder(owner.id, listing.id);
    assert.strictEqual((await get(other.token, `/orders/${order.id}`)).status, 404);
    assert.strictEqual((await get(other.token, "/orders/2147483647")).status, 404);
  });

  it("rejects malformed and unauthenticated reads", async () => {
    assert.strictEqual((await get(undefined, "/orders")).status, 401);
    assert.strictEqual((await get(undefined, "/orders/1")).status, 401);
    const customer = await makeUser();
    assert.strictEqual((await get(customer.token, "/orders/not-an-id")).status, 400);
  });

});


describe("admin order reads", () => {
  it("lists across customers with deterministic pagination, safe payment projection and fulfilment details", async () => {
    const admin = await makeUser("ADMIN");
    const first = await makeUser(); const second = await makeUser();
    const a = await makeOrder(first.id, (await makeListing()).id);
    const b = await makeOrder(second.id, (await makeListing()).id);
    // Future identical timestamps make these fixtures the first two store-wide rows.
    await prisma.order.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { createdAt: new Date("2100-01-01") } });
    await prisma.payment.create({ data: { orderId: b.id, amount: b.totalAmount, currency: "GBP", status: "PROCESSING", provider: "STRIPE", providerReference: `pi_${randomUUID()}` } });
    const page = await (await get(admin.token, "/admin/orders?pageSize=1")).json();
    assert.equal(page.items.length, 1); assert.equal(page.items[0].id, b.id);
    assert.equal(page.items[0].user.id, second.id); assert.equal(page.items[0].user.email, second.email);
    assert.equal(page.items[0].paymentStatus, "PROCESSING"); assert.equal(page.items[0].currency, "GBP");
    assert.equal(page.pagination.page, 1); assert.equal(page.pagination.pageSize, 1);
    assert.ok(page.pagination.totalItems >= 2);
    const next = await (await get(admin.token, "/admin/orders?page=2&pageSize=1")).json();
    assert.equal(next.items[0].id, a.id); assert.equal(next.items[0].paymentStatus, null); assert.equal(next.items[0].currency, "GBP");
    const detail = await (await get(admin.token, `/admin/orders/${b.id}`)).json();
    assert.equal(detail.deliveryLine1, "1 Test Street"); assert.equal(detail.deliveryRecipientName, "Customer");
    assert.equal(detail.orderItems[0].quantity, 2); assert.equal(detail.orderItems[0].unitPrice, "15");
    assert.equal(detail.orderItems[0].lineTotal, "30"); assert.equal(detail.totalAmount, "33.99");
    assert.equal(detail.actualShippingCost, null);
    assert.deepEqual(detail.payment, { status: "PROCESSING", currency: "GBP", paidAt: null });
    const serialized = JSON.stringify(detail);
    for (const key of ["passwordHash", "providerReference", "idempotencyKey", "clientSecret", "billingLine1", "refunds"]) assert.ok(!serialized.includes(key));
    const paidAt = new Date("2026-10-01T12:00:00Z");
    await prisma.payment.update({ where: { orderId: b.id }, data: { status: "SUCCEEDED", currency: "EUR", paidAt } });
    await prisma.order.update({ where: { id: b.id }, data: { status: "DISPATCHED", actualShippingCost: 5, shippingCarrier: "UPS", trackingNumber: "TRACK", dispatchedAt: paidAt } });
    const shipped = await (await get(admin.token, `/admin/orders/${b.id}`)).json();
    assert.equal(shipped.currency, "EUR"); assert.equal(shipped.paymentStatus, "SUCCEEDED");
    assert.equal(shipped.payment.paidAt, paidAt.toISOString()); assert.equal(shipped.actualShippingCost, "5");
    assert.equal(shipped.shippingCarrier, "UPS"); assert.equal(shipped.trackingNumber, "TRACK");
    assert.equal(shipped.dispatchedAt, paidAt.toISOString());
    const updatedList = await (await get(admin.token, "/admin/orders?pageSize=1")).json();
    assert.equal(updatedList.items[0].currency, "EUR"); assert.equal(updatedList.items[0].paymentStatus, "SUCCEEDED");
    assert.equal((await get(admin.token, `/orders/${b.id}`)).status, 404);
    assert.deepEqual(await (await get(admin.token, "/orders")).json(), []);
  });

  it("enforces database ADMIN authorization and validates bounds and unknown parameters", async () => {
    const customer = await makeUser(); const admin = await makeUser("ADMIN");
    for (const path of ["/admin/orders", "/admin/orders/1"]) {
      assert.equal((await get(undefined, path)).status, 401);
      assert.equal((await get(customer.token, path)).status, 403);
    }
    for (const query of ["page=0", "page=10001", "pageSize=51", "pageSize=-1", "page=1.5", "page=abc", "page=1&page=2", "unknown=1"]) {
      assert.equal((await get(admin.token, `/admin/orders?${query}`)).status, 400, query);
    }
    for (const id of ["abc", "0", "2147483648", "1e2"]) assert.equal((await get(admin.token, `/admin/orders/${id}`)).status, 400);
    assert.equal((await get(admin.token, "/admin/orders/2147483647")).status, 404);
    const empty = await (await get(admin.token, "/admin/orders?page=10000")).json(); assert.deepEqual(empty.items, []);
    await prisma.user.update({ where: { id: admin.id }, data: { role: "CUSTOMER" } });
    assert.equal((await get(admin.token, "/admin/orders")).status, 403);
  });
});
