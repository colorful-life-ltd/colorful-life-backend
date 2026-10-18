import assert from "node:assert";
import { describe, it, before, after, afterEach } from "node:test";
import { prisma } from "../prisma/runtime.js";
import { Decimal } from "@prisma/client/runtime/client";
import app from "../app.js";
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import { randomUUID } from "node:crypto";
import { OrderStatus } from "../generated/prisma-client/enums.js";

/**
 * Helper to start the Express app on an OS‑assigned port.
 */
async function startServer() {
  const server = app.listen(0);
  return new Promise<{ server: any; url: string }>((resolve, reject) => {
    server.once("listening", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to obtain server address"));
        return;
      }
      const url = `http://localhost:${address.port}`;
      resolve({ server, url });
    });
  });
}

/**
 * Create a JWT for a user.  The helper uses the same secret that the
 * application expects.
 */
function signToken(userId: number, role: string): string {
  return jwt.sign({ id: userId, role }, config.JWT_SECRET, { expiresIn: "1h" });
}

/**
 * Create a customer with a default billing address.
 */
async function createCustomerWithBilling(): Promise<{ id: number; token: string }> {
  const user = await prisma.user.create({
    data: {
      email: `${randomUUID()}@example.com`,
      passwordHash: "hashed",
      emailVerified: true,
      role: "CUSTOMER",
      addresses: {
        create: {
          recipientName: "Customer",
          line1: "123 Billing St",
          city: "Billingville",
          postcode: "00001",
          countryCode: "GB",
          isDefaultBilling: true,
        },
      },
    },
    include: { addresses: true },
  });
  return { id: user.id, token: signToken(user.id, "CUSTOMER") };
}

/**
 * Create an admin user.
 */
async function createAdmin(): Promise<{ id: number; token: string }> {
  const user = await prisma.user.create({
    data: {
      email: `${randomUUID()}-admin@example.com`,
      passwordHash: "hashed",
      emailVerified: true,
      role: "ADMIN",
    },
  });
  return { id: user.id, token: signToken(user.id, "ADMIN") };
}

/**
 * Create a product listing with a Lego product.
 */
async function createListing(): Promise<{ listingId: number; legoProductId: number }> {
  const product = await prisma.legoProduct.create({
    data: {
      setNumber: `${randomUUID()}-SET`,
      title: `Test Lego`,
      theme: "TEST",
      ageRecommendation: "8+",
      pieceCount: 100,
      productListings: {
        create: {

          condition: "NEW",
          originalPrice: new Decimal(20),
          salePrice: new Decimal(15),
          currentStock: 10,
          active: true,
        },
      },
    },
    include: { productListings: true },
  });
  return { listingId: product.productListings[0].id, legoProductId: product.id };
}

/**
 * Helper to create an order and bring it to DISPATCHED state.
 */
async function createDispatchedOrder(
  userId: number,
  listingId: number
): Promise<number> {
  // Retrieve the product listing to use its pricing info for unitPrice and lineTotal
  const listing = await prisma.productListing.findUnique({ where: { id: listingId } });
  if (!listing) {
    throw new Error(`Listing ${listingId} not found`);
  }
  const unitPrice = listing.salePrice ?? listing.originalPrice;
  const lineTotal = unitPrice.mul(1);
  const order = await prisma.order.create({
    data: {
      userId,
      billingRecipientName: "Test User",
      billingLine1: "123 Test St",
      billingLine2: undefined,
      billingCity: "Testville",
      billingCounty: undefined,
      billingPostcode: "12345",
      billingCountryCode: "US",
      billingPhone: undefined,
      deliveryRecipientName: "Test User",
      deliveryLine1: "123 Test St",
      deliveryLine2: undefined,
      deliveryCity: "Testville",
      deliveryCounty: undefined,
      deliveryPostcode: "12345",
      deliveryCountryCode: "US",
      deliveryPhone: undefined,
      totalAmount: lineTotal,
      orderItems: {
        create: [{ productListingId: listingId, quantity: 1, unitPrice, lineTotal }],
      },
    },
    include: { orderItems: true },
  });
  // Confirm
  await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CONFIRMED } });
  // Dispatch
  await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.DISPATCHED, actualShippingCost: new Decimal(5), shippingCarrier: "UPS", trackingNumber: "TRACK123", dispatchedAt: new Date() } });
  return order.id;
}

describe("Order completion integration tests", () => {
  const createdOrderIds: number[] = [];
  const createdListingIds: number[] = [];
  const createdLegoProductIds: number[] = [];
  const createdUserIds: number[] = [];
  let server: any;
  let baseUrl: string;

  before(async () => {
    const { server: srv, url } = await startServer();
    server = srv;
    baseUrl = url;
  });

  after(async () => {
    server.close();
  });

  afterEach(async () => {
    if (createdOrderIds.length) {
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
      createdOrderIds.length = 0;
    }
    if (createdListingIds.length) {
      await prisma.productListing.deleteMany({ where: { id: { in: createdListingIds } } });
      createdListingIds.length = 0;
    }
    if (createdLegoProductIds.length) {
      await prisma.legoProduct.deleteMany({ where: { id: { in: createdLegoProductIds } } });
      createdLegoProductIds.length = 0;
    }
    if (createdUserIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
      createdUserIds.length = 0;
    }
  });

  it("ADMIN can complete a DISPATCHED order", async () => {
    const admin = await createAdmin();
    const customer = await createCustomerWithBilling();
    const { listingId, legoProductId } = await createListing();
    createdListingIds.push(listingId);
    createdLegoProductIds.push(legoProductId);
    createdUserIds.push(admin.id, customer.id);
    const orderId = await createDispatchedOrder(customer.id, listingId);
    createdOrderIds.push(orderId);

    const res = await fetch(`${baseUrl}/orders/${orderId}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, OrderStatus.COMPLETED);
    assert.ok(body.completedAt, "completedAt should be set");
  });

  it("non-ADMIN authenticated user gets 403", async () => {
    const admin = await createAdmin();
    const customer = await createCustomerWithBilling();
    const { listingId, legoProductId } = await createListing();
    createdListingIds.push(listingId);
    createdLegoProductIds.push(legoProductId);
    createdUserIds.push(admin.id, customer.id);
    const orderId = await createDispatchedOrder(customer.id, listingId);
    createdOrderIds.push(orderId);

    const res = await fetch(`${baseUrl}/orders/${orderId}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${customer.token}` },
    });
    assert.strictEqual(res.status, 403);
  });

  it("unauthenticated request is rejected", async () => {
    const admin = await createAdmin();
    const customer = await createCustomerWithBilling();
    const { listingId, legoProductId } = await createListing();
    createdListingIds.push(listingId);
    createdLegoProductIds.push(legoProductId);
    createdUserIds.push(admin.id, customer.id);
    const orderId = await createDispatchedOrder(customer.id, listingId);
    createdOrderIds.push(orderId);

    const res = await fetch(`${baseUrl}/orders/${orderId}/complete`, { method: "POST" });
    // Auth middleware returns 401 when token missing
    assert.strictEqual(res.status, 401);
  });

  it("invalid order id returns 400", async () => {
    const admin = await createAdmin();
    createdUserIds.push(admin.id);
    const res = await fetch(`${baseUrl}/orders/abc/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    assert.strictEqual(res.status, 400);
  });

  it("missing order returns 404", async () => {
    const admin = await createAdmin();
    createdUserIds.push(admin.id);
    const res = await fetch(`${baseUrl}/orders/9999999/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    assert.strictEqual(res.status, 404);
  });

  it("non‑DISPATCHED order rejects with 400", async () => {
    const admin = await createAdmin();
    const customer = await createCustomerWithBilling();
    const { listingId, legoProductId } = await createListing();
    createdListingIds.push(listingId);
    createdLegoProductIds.push(legoProductId);
    createdUserIds.push(admin.id, customer.id);
  // Retrieve listing to provide pricing for the order item
  const listing = await prisma.productListing.findUnique({ where: { id: listingId } });
  if (!listing) {
    throw new Error(`Listing ${listingId} not found`);
  }
  const unitPrice = listing.salePrice ?? listing.originalPrice;
  const lineTotal = unitPrice.mul(1);
  const order = await prisma.order.create({
    data: {
      userId: customer.id,

      billingRecipientName: "Test User",
      billingLine1: "123 Test St",
      billingLine2: undefined,
      billingCity: "Testville",
      billingCounty: undefined,
      billingPostcode: "12345",
      billingCountryCode: "US",
      billingPhone: undefined,

      deliveryRecipientName: "Test User",
      deliveryLine1: "123 Test St",
      deliveryLine2: undefined,
      deliveryCity: "Testville",
      deliveryCounty: undefined,
      deliveryPostcode: "12345",
      deliveryCountryCode: "US",
      deliveryPhone: undefined,

      totalAmount: lineTotal,

      orderItems: {
        create: [{
          productListingId: listingId,
          quantity: 1,
          unitPrice,
          lineTotal,
        }],
      },
    },
    include: { orderItems: true },
  });
    createdOrderIds.push(order.id);
    // leave status as PENDING
    const res = await fetch(`${baseUrl}/orders/${order.id}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    assert.strictEqual(res.status, 400);
  });

  it("completing an already COMPLETED order returns 400", async () => {
    const admin = await createAdmin();
    const customer = await createCustomerWithBilling();
    const { listingId, legoProductId } = await createListing();
    createdListingIds.push(listingId);
    createdLegoProductIds.push(legoProductId);
    createdUserIds.push(admin.id, customer.id);
    const orderId = await createDispatchedOrder(customer.id, listingId);
    createdOrderIds.push(orderId);
    // First completion should succeed
    const firstRes = await fetch(`${baseUrl}/orders/${orderId}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    assert.strictEqual(firstRes.status, 200);
    // Second attempt should fail
    const secondRes = await fetch(`${baseUrl}/orders/${orderId}/complete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    assert.strictEqual(secondRes.status, 400);
  });
});
