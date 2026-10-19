import { strict as assert } from "node:assert";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { recordVerifiedPayment } from "./fixtures/verifiedPayment.js";
import { createOrder } from "../domain/orders/orderService.js";
import { OrderStatus } from "../generated/prisma-client/enums.js";

const originalDispatchActivation = config.DISPATCH_CONFIRMATION_EMAIL_ENABLED;
beforeEach(() => { config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = true; });
afterEach(() => { config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = originalDispatchActivation; });

const users: number[] = [];
const products: number[] = [];
const listings: number[] = [];
const orders: number[] = [];
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
  const order = await createOrder(customer.id, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listing.id, quantity: 1 }] });
  orders.push(order.id);
  await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED } });
  await recordVerifiedPayment(order.id);
  return { customer, admin, listing, order };
}

async function dispatch(token: string, orderId: number, trackingNumber?: string) {
  return fetch(`${url}/orders/${orderId}/dispatch`, {
    method: "POST",
    headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ actualShippingCost: 5.99, shippingCarrier: "UPS", ...(trackingNumber === undefined ? {} : { trackingNumber }) }),
  });
}

describe("durable dispatch notification", () => {
  const jobs = (orderId: number) => prisma.orderConfirmationJob.findMany({ where: { orderId, type: 'DISPATCH_CONFIRMATION' } });
  it("queues exactly one notification with committed customer and dispatch data", async () => {
    const f = await makeFixture();
    const response = await dispatch(f.admin.token, f.order.id, 'TRACK-1'); assert.equal(response.status, 200);
    const queued = await jobs(f.order.id); assert.equal(queued.length, 1);
    const source = queued[0].source as Record<string, unknown>;
    assert.deepEqual([source.recipientEmail, source.orderId, source.carrierName, source.trackingNumber], [f.customer.email, f.order.id, 'UPS', 'TRACK-1']);
    assert.equal(queued[0].state, 'PENDING'); assert.equal(queued[0].attempts, 0);
    assert.equal('user' in await response.json(), false);
  });
  it("queues honest missing tracking information", async () => {
    const f = await makeFixture(); assert.equal((await dispatch(f.admin.token, f.order.id)).status, 200);
    assert.equal(((await jobs(f.order.id))[0].source as Record<string, unknown>).trackingNumber, null);
  });
  it("dispatch commits while outbound delivery is disabled and performs no email I/O", async () => {
    const f = await makeFixture(); assert.equal((await dispatch(f.admin.token, f.order.id)).status, 200);
    assert.equal((await prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status, 'DISPATCHED');
    assert.equal((await jobs(f.order.id))[0].attempts, 0);
  });
  it("does not duplicate or queue failed dispatches", async () => {
    const f = await makeFixture(); assert.equal((await dispatch(f.admin.token, 2147483647)).status, 404);
    assert.equal((await jobs(f.order.id)).length, 0);
    assert.equal((await dispatch(f.admin.token, f.order.id)).status, 200);
    assert.equal((await dispatch(f.admin.token, f.order.id)).status, 400);
    assert.equal((await jobs(f.order.id)).length, 1);
  });
  it("queues nothing for non-ADMIN or unauthenticated callers", async () => {
    const f = await makeFixture(); assert.equal((await dispatch(f.customer.token, f.order.id)).status, 403);
    assert.equal((await fetch(`${url}/orders/${f.order.id}/dispatch`, { method: 'POST', headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, 'Content-Type': 'application/json' }, body: JSON.stringify({ actualShippingCost: 1, shippingCarrier: 'UPS' }) })).status, 401);
    assert.equal((await jobs(f.order.id)).length, 0);
  });
});
