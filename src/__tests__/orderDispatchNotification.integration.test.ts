import { strict as assert } from "node:assert";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { recordVerifiedPayment } from "./fixtures/verifiedPayment.js";
import { createOrder } from "../domain/orders/orderService.js";
import { OrderStatus } from "../generated/prisma-client/enums.js";
import { setDispatchNotificationSenderForTests, type DispatchNotification } from "../services/emailService.js";

const users: number[] = [];
const products: number[] = [];
const listings: number[] = [];
const orders: number[] = [];
let server: ReturnType<typeof app.listen>;
let url: string;
let restoreSender: (() => void) | undefined;

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
  restoreSender?.();
  restoreSender = undefined;
  if (orders.length) await prisma.order.deleteMany({ where: { id: { in: orders } } });
  if (listings.length) await prisma.productListing.deleteMany({ where: { id: { in: listings } } });
  if (products.length) await prisma.legoProduct.deleteMany({ where: { id: { in: products } } });
  if (users.length) {
    await prisma.address.deleteMany({ where: { userId: { in: users } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  }
  orders.length = listings.length = products.length = users.length = 0;
});

async function makeUser(role: "ADMIN" | "CUSTOMER", email?: string) {
  const created = await prisma.user.create({
    data: {
      email: email ?? `${role.toLowerCase()}-${randomUUID()}@example.com`,
      passwordHash: "test",
      role,
      emailVerified: true,
      addresses: role === "CUSTOMER" ? { create: { recipientName: "Customer", line1: "1 Test Street", city: "Testville", postcode: "T1", countryCode: "GB", isDefaultBilling: true } } : undefined,
    },
  });
  users.push(created.id);
  return { ...created, token: jwt.sign({ id: created.id, role }, config.JWT_SECRET, { expiresIn: "1h" }) };
}

async function makeFixture() {
  const customer = await makeUser("CUSTOMER", `customer-${randomUUID()}@example.com`);
  const admin = await makeUser("ADMIN");
  const product = await prisma.legoProduct.create({ data: { setNumber: randomUUID(), title: "Dispatch notification", theme: "TEST", ageRecommendation: "8+", pieceCount: 10 } });
  products.push(product.id);
  const listing = await prisma.productListing.create({ data: {
        legoProductId: product.id, condition: "NEW", originalPrice: 10, currentStock: 2 } });
  listings.push(listing.id);
  const order = await createOrder(customer.id, { items: [{ productListingId: listing.id, quantity: 1 }] });
  orders.push(order.id);
  await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED } });
  await recordVerifiedPayment(order.id);
  return { customer, admin, listing, order };
}

async function dispatch(token: string, orderId: number, trackingNumber?: string) {
  return fetch(`${url}/orders/${orderId}/dispatch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ actualShippingCost: 5.99, shippingCarrier: "UPS", ...(trackingNumber === undefined ? {} : { trackingNumber }) }),
  });
}

describe("dispatch notification", () => {
  it("sends exactly one notification with customer and dispatch data", async () => {
    const f = await makeFixture();
    const sent: DispatchNotification[] = [];
    restoreSender = setDispatchNotificationSenderForTests(async (notification) => { sent.push(notification); });
    const response = await dispatch(f.admin.token, f.order.id, "TRACK-1");
    assert.strictEqual(response.status, 200);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0]!.customerEmail, f.customer.email);
    assert.strictEqual(sent[0]!.orderId, f.order.id);
    assert.strictEqual(sent[0]!.shippingCarrier, "UPS");
    assert.strictEqual(sent[0]!.trackingNumber, "TRACK-1");
    assert(sent[0]!.dispatchedAt instanceof Date);
    const body = await response.json();
    assert.equal("user" in body, false);
  });

  it("sends a notification when tracking is absent", async () => {
    const f = await makeFixture();
    let notification: DispatchNotification | undefined;
    restoreSender = setDispatchNotificationSenderForTests(async (value) => { notification = value; });
    assert.strictEqual((await dispatch(f.admin.token, f.order.id)).status, 200);
    assert.strictEqual(notification?.customerEmail, f.customer.email);
    assert.strictEqual(notification?.trackingNumber, null);
  });

  it("swallows notifier failure after the order is dispatched", async () => {
    const f = await makeFixture();
    restoreSender = setDispatchNotificationSenderForTests(async () => { throw new Error("SES unavailable"); });
    const response = await dispatch(f.admin.token, f.order.id);
    assert.strictEqual(response.status, 200);
    assert.strictEqual((await prisma.order.findUnique({ where: { id: f.order.id } }))?.status, OrderStatus.DISPATCHED);
  });

  it("does not notify failed or repeated dispatches", async () => {
    const f = await makeFixture();
    const sent: DispatchNotification[] = [];
    restoreSender = setDispatchNotificationSenderForTests(async (notification) => { sent.push(notification); });
    const missing = await dispatch(f.admin.token, 2_147_483_647);
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(sent.length, 0);
    assert.strictEqual((await dispatch(f.admin.token, f.order.id)).status, 200);
    assert.strictEqual((await dispatch(f.admin.token, f.order.id)).status, 400);
    assert.strictEqual(sent.length, 1);
  });

  it("does not notify non-ADMIN or unauthenticated callers", async () => {
    const f = await makeFixture();
    let calls = 0;
    restoreSender = setDispatchNotificationSenderForTests(async () => { calls += 1; });
    assert.strictEqual((await dispatch(f.customer.token, f.order.id)).status, 403);
    assert.strictEqual((await fetch(`${url}/orders/${f.order.id}/dispatch`, { method: "POST", body: JSON.stringify({ actualShippingCost: 1, shippingCarrier: "UPS" }) })).status, 401);
    assert.strictEqual(calls, 0);
  });
});
