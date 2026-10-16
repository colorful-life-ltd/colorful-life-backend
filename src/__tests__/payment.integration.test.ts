import assert from "node:assert";
import type { Server } from "node:http";
import { after, afterEach, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { Decimal } from "@prisma/client/runtime/client";
import app from "../app.js";
import { config } from "../config/index.js";
import { createOrder } from "../domain/orders/orderService.js";
import { prisma } from "../prisma/runtime.js";
import { PaymentProvider } from "../generated/prisma-client/enums.js";

const paymentIds: number[] = [];
const orderIds: number[] = [];
const listingIds: number[] = [];
const legoProductIds: number[] = [];
const userIds: number[] = [];

async function startServer(): Promise<{ server: Server; url: string }> {
  const server = app.listen(0);
  return new Promise((resolve, reject) => {
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to obtain server address"));
        return;
      }
      resolve({ server, url: `http://localhost:${address.port}` });
    });
  });
}

function token(userId: number, role: "ADMIN" | "CUSTOMER") {
  return jwt.sign({ id: userId, role }, config.JWT_SECRET, { expiresIn: "1h" });
}

async function createUser(role: "ADMIN" | "CUSTOMER") {
  const user = await prisma.user.create({
    data: {
      email: `${role.toLowerCase()}-${randomUUID()}@example.com`,
      passwordHash: "hashed",
      emailVerified: true,
      role,
      addresses: {
        create: {
          recipientName: "Payment Test User",
          line1: "1 Test Street",
          city: "Testville",
          postcode: "TEST1",
          countryCode: "GB",
          isDefaultBilling: true,
        },
      },
    },
  });
  userIds.push(user.id);
  return { id: user.id, token: token(user.id, role) };
}

async function createListing() {
  const product = await prisma.legoProduct.create({
    data: {
      setNumber: `PAY-${randomUUID()}`,
      title: "Payment integration listing",
      theme: "TEST",
      ageRecommendation: "8+",
      pieceCount: 100,
      productListings: {
        create: {

          condition: "NEW",
          originalPrice: new Decimal("30.00"),
          salePrice: new Decimal("25.00"),
          currentStock: 7,
          active: true,
        },
      },
    },
    include: { productListings: true },
  });
  const listing = product.productListings[0];
  legoProductIds.push(product.id);
  listingIds.push(listing.id);
  return listing;
}

async function createTestOrder(userId: number, listingId: number) {
  const order = await createOrder(userId, { shippingMethod: "STANDARD" as const,
    items: [{ productListingId: listingId, quantity: 1 }],
  });
  orderIds.push(order.id);
  return order;
}

async function jsonFetch(url: string, path: string, init: RequestInit = {}) {
  return fetch(`${url}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("Payment HTTP integration", () => {
  let server: Server;
  let url: string;
  let admin: { id: number; token: string };
  let customer: { id: number; token: string };

  before(async () => {
    ({ server, url } = await startServer());
    admin = await createUser("ADMIN");
    customer = await createUser("CUSTOMER");
  });

  afterEach(async () => {
    if (paymentIds.length) {
      await prisma.payment.deleteMany({ where: { id: { in: paymentIds } } });
      paymentIds.length = 0;
    }
    if (orderIds.length) {
      await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      orderIds.length = 0;
    }
    if (listingIds.length) {
      await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listingIds } } });
      await prisma.productListing.deleteMany({ where: { id: { in: listingIds } } });
      listingIds.length = 0;
    }
    if (legoProductIds.length) {
      await prisma.legoProduct.deleteMany({ where: { id: { in: legoProductIds } } });
      legoProductIds.length = 0;
    }
  });

  after(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("POST enforces auth, validates input, and reports missing orders", async () => {
    const unauthenticated = await jsonFetch(url, "/orders/1/payments", {
      method: "POST",
      body: JSON.stringify({ providerReference: "unauth" }),
    });
    assert.strictEqual(unauthenticated.status, 401);

    const nonAdmin = await jsonFetch(url, "/orders/1/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${customer.token}` },
      body: JSON.stringify({ providerReference: "non-admin" }),
    });
    assert.strictEqual(nonAdmin.status, 403);

    for (const orderId of ["abc", "0", "-1"]) {
      const response = await jsonFetch(url, `/orders/${orderId}/payments`, {
        method: "POST",
        headers: { Authorization: `Bearer ${admin.token}` },
        body: JSON.stringify({ providerReference: "invalid-order" }),
      });
      assert.strictEqual(response.status, 400);
    }

    for (const body of [{ providerReference: "" }, { providerReference: "   " }, {}]) {
      const response = await jsonFetch(url, "/orders/1/payments", {
        method: "POST",
        headers: { Authorization: `Bearer ${admin.token}` },
        body: JSON.stringify(body),
      });
      assert.strictEqual(response.status, 400);
    }

    const missing = await jsonFetch(url, "/orders/999999999/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ providerReference: `missing-${randomUUID()}` }),
    });
    assert.strictEqual(missing.status, 404);
  });

  it("POST creates an authoritative, idempotent payment without order/inventory changes", async () => {
    const listing = await createListing();
    const order = await createTestOrder(customer.id, listing.id);
    const otherOrder = await createTestOrder(customer.id, listing.id);
    const providerReference = `manual-${randomUUID()}`;
    const statusBefore = order.status;
    const stockBefore = (await prisma.productListing.findUnique({ where: { id: listing.id } }))!.currentStock;
    const movementsBefore = await prisma.inventoryMovement.count({ where: { listingId: listing.id } });

    const firstResponse = await jsonFetch(url, `/orders/${order.id}/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ providerReference }),
    });
    assert.strictEqual(firstResponse.status, 201);
    const first = await firstResponse.json();
    paymentIds.push(first.id);
    assert.strictEqual(first.orderId, order.id);
    assert.strictEqual(String(first.amount), String(order.totalAmount));
    assert.strictEqual(first.currency, "GBP");
    assert.strictEqual(first.provider, PaymentProvider.MANUAL);
    assert.strictEqual(first.status, "SUCCEEDED");
    assert.ok(first.paidAt);

    const secondResponse = await jsonFetch(url, `/orders/${order.id}/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ providerReference }),
    });
    assert.strictEqual(secondResponse.status, 201);
    const second = await secondResponse.json();
    assert.strictEqual(second.id, first.id);

    const matchingPayments = await prisma.payment.findMany({
      where: { provider: PaymentProvider.MANUAL, providerReference },
    });
    assert.strictEqual(matchingPayments.length, 1);

    const conflict = await jsonFetch(url, `/orders/${otherOrder.id}/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ providerReference }),
    });
    assert.strictEqual(conflict.status, 409);

    const orderAfter = await prisma.order.findUnique({ where: { id: order.id } });
    const listingAfter = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const movementsAfter = await prisma.inventoryMovement.count({ where: { listingId: listing.id } });
    assert.strictEqual(orderAfter?.status, statusBefore);
    assert.strictEqual(listingAfter?.currentStock, stockBefore);
    assert.strictEqual(movementsAfter, movementsBefore);
  });

  it("GET enforces auth, validates order ids, scopes results, and returns newest first", async () => {
    const listing = await createListing();
    const order = await createTestOrder(customer.id, listing.id);
    const otherOrder = await createTestOrder(customer.id, listing.id);
    const firstReference = `first-${randomUUID()}`;
    const secondReference = `second-${randomUUID()}`;

    const unauthenticated = await jsonFetch(url, `/orders/${order.id}/payments`);
    assert.strictEqual(unauthenticated.status, 401);

    const nonAdmin = await jsonFetch(url, `/orders/${order.id}/payments`, {
      headers: { Authorization: `Bearer ${customer.token}` },
    });
    assert.strictEqual(nonAdmin.status, 403);

    const invalid = await jsonFetch(url, "/orders/not-an-id/payments", {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    assert.strictEqual(invalid.status, 400);

    const missing = await jsonFetch(url, "/orders/999999999/payments", {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    assert.strictEqual(missing.status, 404);

    const firstResponse = await jsonFetch(url, `/orders/${order.id}/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ providerReference: firstReference }),
    });
    const first = await firstResponse.json();
    paymentIds.push(first.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondResponse = await jsonFetch(url, `/orders/${order.id}/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ providerReference: secondReference }),
    });
    assert.strictEqual(secondResponse.status, 409);

    const otherResponse = await jsonFetch(url, `/orders/${otherOrder.id}/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ providerReference: `other-${randomUUID()}` }),
    });
    const other = await otherResponse.json();
    paymentIds.push(other.id);

    const listedResponse = await jsonFetch(url, `/orders/${order.id}/payments`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    assert.strictEqual(listedResponse.status, 200);
    const listed = await listedResponse.json();
    assert.ok(Array.isArray(listed));
    assert.deepStrictEqual(listed.map((payment: { id: number }) => payment.id), [first.id]);
    assert.ok(listed.every((payment: { orderId: number }) => payment.orderId === order.id));
    assert.ok(!listed.some((payment: { id: number }) => payment.id === other.id));
  });
});
