import assert from "node:assert";
import type { Server } from "node:http";
import { describe, it, before, after, afterEach } from "node:test";
import { prisma } from "../prisma/runtime.js";
import { recordVerifiedPayment } from "./fixtures/verifiedPayment.js";
import { Decimal } from "@prisma/client/runtime/client";
import { createOrder } from "../domain/orders/orderService.js";
import { OrderStatus } from "../generated/prisma-client/enums.js";
import app from "../app.js";
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import { randomUUID } from "node:crypto";

// Arrays that will be used for cleanup; they need to be in module scope so that helper
// functions defined above the `describe` block can push IDs into them.
const userIdsForCleanup: number[] = [];
const orderIdsForCleanup: number[] = [];
const listingIdsForCleanup: number[] = [];
const legoProductIdsForCleanup: number[] = [];

/** Helper to start the Express app on an OS‑assigned port. */
async function startServer(): Promise<{ server: Server; url: string }> {
  const server = app.listen(0);
  return new Promise((resolve, reject) => {
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

/** Record the user ID extracted from a JWT so it can be cleaned up after each test. */
function recordUserIdFromToken(token: string, cleanupArray: number[]) {
  const payload = jwt.verify(token, config.JWT_SECRET) as any;
  cleanupArray.push(payload.id as number);
}

/** Helper to create a product listing and return both LegoProduct and ProductListing IDs */
async function createListing(): Promise<{ legoProductId: number; listingId: number }> {
  const product = await prisma.legoProduct.create({
    data: {
      setNumber: `INT-${randomUUID()}`,
      title: "Test Product",
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
  return { legoProductId: product.id, listingId: product.productListings[0].id };
}

/** Create a signed JWT for a user */
function signToken(userId: number, role: string): string {
  return jwt.sign(
    { id: userId, role },
    config.JWT_SECRET,
    { expiresIn: "1h" },
  );
}

/** Helper to create a default billing address for a user */
async function createDefaultBillingAddress(userId: number): Promise<void> {
  await prisma.address.create({
    data: {
      userId,
      recipientName: "Default",
      line1: "123 Billing St",
      city: "Billingville",
      postcode: "00001",
      countryCode: "US",
      isDefaultBilling: true,
    },
  });
}

/** Helper to create a customer via signup and return token */
async function signupCustomer(
  url: string,
  email: string,
  password: string,
) {
  const res = await fetch(`${url}/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  const body = await res.json();

  if (res.status === 201 && body.token) {
    recordUserIdFromToken(body.token, userIdsForCleanup);
  }

  return { res, body };
}

async function createCustomerWithBillingAddress(url: string) {
  const email = `cust-${randomUUID()}@example.com`;
  const password = "Password1!";
  const { body } = await signupCustomer(url,email, password);
  const token = body.token;
  const payload = jwt.verify(token, config.JWT_SECRET) as { id: number };
  const userId = payload.id;
  await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
  await createDefaultBillingAddress(userId);
  return { token, userId };
}

/** Create an order for the test customer */
async function createTestOrder(customerId: number, listingId: number) {
  const order = await createOrder(customerId, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listingId, quantity: 1 }] });
  orderIdsForCleanup.push(order.id);
  return order;
}

describe("Order Dispatch HTTP Integration", () => {
  let server: Server;
  let url: string;
  let adminToken: string;
  let customerToken: string;
  let customerId: number;
  before(async () => {
    const { server: srv, url: u } = await startServer();
    server = srv;
    url = u;
    // Create an admin user via Prisma
    const admin = await prisma.user.create({
      data: {
        email: `admin-${randomUUID()}@example.com`,
        passwordHash: "hashed",
        emailVerified: true,
        role: "ADMIN",
        addresses: {
          create: {
            recipientName: "Admin User",
            line1: "Admin St 1",
            city: "Adminville",
            postcode: "99999",
            countryCode: "US",
            isDefaultBilling: true,
          },
        },
      },
      include: { addresses: true },
    });
    adminToken = signToken(admin.id, "ADMIN");
    recordUserIdFromToken(adminToken, userIdsForCleanup);
  });

  after(async () => {
    // Delete orders first
    await prisma.order.deleteMany({ where: { id: { in: orderIdsForCleanup } } });
    // Delete inventory movements associated with the test listings
    await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listingIdsForCleanup } } });
    // Then delete product listings, Lego products, users, and close the server
    await prisma.productListing.deleteMany({ where: { id: { in: listingIdsForCleanup } } });
    await prisma.legoProduct.deleteMany({ where: { id: { in: legoProductIdsForCleanup } } });
    await prisma.user.deleteMany({ where: { id: { in: userIdsForCleanup } } });
    await new Promise((resolve) => server.close(resolve));
  });

  afterEach(async () => {
    // No per‑test cleanup needed beyond global after.
  });

  it("ADMIN can dispatch a CONFIRMED order and records shipping metadata", async () => {
    const { token: custToken, userId } = await createCustomerWithBillingAddress(url);
    customerToken = custToken;
    customerId = userId;

    const { listingId, legoProductId } = await createListing();
    listingIdsForCleanup.push(listingId);
    legoProductIdsForCleanup.push(legoProductId);
    const order = await createTestOrder(customerId, listingId);
    // Confirm the order to make it CONFIRMED
    await fetch(`${url}/orders/${order.id}/confirm`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    await recordVerifiedPayment(order.id);
    const dispatchBody = {
      actualShippingCost: 5.99,
      shippingCarrier: "UPS",
      trackingNumber: "TRK123",
    };
    const res = await fetch(`${url}/orders/${order.id}/dispatch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(dispatchBody),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    assert.strictEqual(body.status, OrderStatus.DISPATCHED);
    assert.strictEqual(body.shippingCarrier, dispatchBody.shippingCarrier);
    assert.strictEqual(body.trackingNumber, dispatchBody.trackingNumber);
    assert.ok(body.dispatchedAt, "dispatchedAt should be set");
    // actualShippingCost should not be exposed
    assert.strictEqual((body as any).actualShippingCost, undefined);
    // Verify persistence
    const persisted = await prisma.order.findUnique({ where: { id: order.id } });
    assert.ok(persisted?.actualShippingCost !== undefined);
    assert.strictEqual(persisted?.actualShippingCost?.toString(), new Decimal(dispatchBody.actualShippingCost).toString());
  });

  it("CUSTOMER receives 403 from dispatch endpoint", async () => {
    const { token: custToken, userId } = await createCustomerWithBillingAddress(url);
    customerToken = custToken;
    customerId = userId;

    const { listingId, legoProductId } = await createListing();
    listingIdsForCleanup.push(listingId);
    legoProductIdsForCleanup.push(legoProductId);
    const order = await createTestOrder(customerId, listingId);
    // Confirm the order
    await fetch(`${url}/orders/${order.id}/confirm`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    await recordVerifiedPayment(order.id);
    const res = await fetch(`${url}/orders/${order.id}/dispatch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${customerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ actualShippingCost: 5, shippingCarrier: "UPS" }),
    });
    assert.strictEqual(res.status, 403);
  });

  it("dispatch cannot be called on non-CONFIRMED order", async () => {
    const { token: custToken, userId } = await createCustomerWithBillingAddress(url);
    customerToken = custToken;
    customerId = userId;
    const { listingId, legoProductId } = await createListing();
    listingIdsForCleanup.push(listingId);
    legoProductIdsForCleanup.push(legoProductId);
    const order = await createTestOrder(customerId, listingId);
    // Do NOT confirm, order remains PENDING
    const res = await fetch(`${url}/orders/${order.id}/dispatch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ actualShippingCost: 5, shippingCarrier: "UPS" }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 400, JSON.stringify(body));
  });

  it("invalid orderId returns 400", async () => {
    const res = await fetch(`${url}/orders/abc/dispatch`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ actualShippingCost: 5, shippingCarrier: "UPS" }),
    });
    assert.strictEqual(res.status, 400);
  });

  it("unauthenticated request receives 401", async () => {
    const dispatchBody = {
      actualShippingCost: 5,
      shippingCarrier: "UPS",
    };
    const res = await fetch(`${url}/orders/1/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dispatchBody),
    });
    assert.strictEqual(res.status, 401);
  });

  it("non-existent order returns 404", async () => {
    const dispatchBody = {
      actualShippingCost: 5,
      shippingCarrier: "UPS",
    };
    const res = await fetch(`${url}/orders/999999/dispatch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(dispatchBody),
    });
    assert.strictEqual(res.status, 404);
  });

  it("negative actualShippingCost returns 400", async () => {
    const dispatchBody = {
      actualShippingCost: -5,
      shippingCarrier: "UPS",
    };
        const res = await fetch(`${url}/orders/1/dispatch`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(dispatchBody),
        });
    assert.strictEqual(res.status, 400);
  });

  it("malformed actualShippingCost returns 400", async () => {
    const dispatchBody = {
      actualShippingCost: "abc",
      shippingCarrier: "UPS",
    };
        const res = await fetch(`${url}/orders/1/dispatch`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(dispatchBody),
        });
    assert.strictEqual(res.status, 400);
  });

  it("missing shippingCarrier returns 400", async () => {
    const dispatchBody = {
      actualShippingCost: 5,
    };
        const res = await fetch(`${url}/orders/1/dispatch`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${adminToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(dispatchBody),
        });
    assert.strictEqual(res.status, 400);
  });

  it("blank shippingCarrier returns 400", async () => {
    const dispatchBody = {
      actualShippingCost: 5,
      shippingCarrier: "",
    };
    const res = await fetch(`${url}/orders/1/dispatch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(dispatchBody),
    });
    assert.strictEqual(res.status, 400);
  });

  it("dispatch does not modify stock", async () => {
    const { listingId, legoProductId } = await createListing();
    listingIdsForCleanup.push(listingId);
    legoProductIdsForCleanup.push(legoProductId);
    const { token: custToken, userId } = await createCustomerWithBillingAddress(url);
    customerToken = custToken;
    customerId = userId;
    const order = await createTestOrder(customerId, listingId);
    await fetch(`${url}/orders/${order.id}/confirm`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    await recordVerifiedPayment(order.id);
    const stockBefore = (await prisma.productListing.findUnique({ where: { id: listingId } }))?.currentStock;
    const dispatchBody = {
      actualShippingCost: 5,
      shippingCarrier: "UPS",
    };
    await fetch(`${url}/orders/${order.id}/dispatch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(dispatchBody),
    });
    const stockAfter = (await prisma.productListing.findUnique({ where: { id: listingId } }))?.currentStock;
    assert.strictEqual(stockBefore, stockAfter);
  });

  it("dispatch does not create additional WEBSITE_SALE InventoryMovement", async () => {
    const { listingId, legoProductId } = await createListing();
    listingIdsForCleanup.push(listingId);
    legoProductIdsForCleanup.push(legoProductId);
    const { token: custToken, userId } = await createCustomerWithBillingAddress(url);
    customerToken = custToken;
    customerId = userId;
    const order = await createTestOrder(customerId, listingId);
    await fetch(`${url}/orders/${order.id}/confirm`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    await recordVerifiedPayment(order.id);
    const movementCountBefore = await prisma.inventoryMovement.count({ where: { listingId, type: "WEBSITE_SALE" } });
    const dispatchBody = {
      actualShippingCost: 5,
      shippingCarrier: "UPS",
    };
    await fetch(`${url}/orders/${order.id}/dispatch`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(dispatchBody),
    });
    const movementCountAfter = await prisma.inventoryMovement.count({ where: { listingId, type: "WEBSITE_SALE" } });
    assert.strictEqual(movementCountBefore, movementCountAfter);
  });
});
