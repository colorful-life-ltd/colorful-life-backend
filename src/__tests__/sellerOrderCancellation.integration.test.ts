import assert from "node:assert";
import type { Server } from "node:http";
import { describe, it, before, after, afterEach } from "node:test";
import { prisma } from "../prisma/runtime.js";
import { Decimal } from "@prisma/client/runtime/client";
import { createOrder } from "../domain/orders/orderService.js";
import { CancellationReason, InventoryMovementType } from "../generated/prisma-client/enums.js";
import app from "../app.js";
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import { randomUUID } from "node:crypto";

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

/** Create a product listing and return both LegoProduct and ProductListing IDs */
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
      countryCode: "GB",
      isDefaultBilling: true,
    },
  });
}

describe("Seller Order Cancellation HTTP Integration", () => {
  let server: Server;
  let url: string;
  const userIdsForCleanup: number[] = [];
  const orderIdsForCleanup: number[] = [];
  const listingIdsForCleanup: number[] = [];
  const legoProductIdsForCleanup: number[] = [];
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
            recipientName: "Admin",
            line1: "Admin St",
            city: "Adminville",
            postcode: "99999",
            countryCode: "GB",
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
    await prisma.order.deleteMany({ where: { id: { in: orderIdsForCleanup } } });
    await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listingIdsForCleanup } } });
    await prisma.productListing.deleteMany({ where: { id: { in: listingIdsForCleanup } } });
    await prisma.legoProduct.deleteMany({ where: { id: { in: legoProductIdsForCleanup } } });
    await prisma.user.deleteMany({ where: { id: { in: userIdsForCleanup } } });
    await new Promise((resolve) => server.close(resolve));
  });

  afterEach(async () => {
    // No per‑test cleanup needed beyond global after.
  });

  /** Helper to create a customer via signup and return token */
  async function signupCustomer(email: string, password: string) {
    const res = await fetch(`${url}/auth/signup`, {
      method: "POST",
      headers: { ...{ "Idempotency-Key": crypto.randomUUID() }, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    if (res.status === 201 && body.token) {
      recordUserIdFromToken(body.token, userIdsForCleanup);
    }
    return { res, body };
  }

  async function createCustomerWithBillingAddress() {
    const email = `cust-${randomUUID()}@example.com`;
    const password = "Password1!";

    const { body } = await signupCustomer(email, password);

    const token = body.token;
    const payload = jwt.verify(token, config.JWT_SECRET) as { id: number };

    const userId = payload.id;
    await prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });

    await createDefaultBillingAddress(userId);

  return {token,userId};
}

  /** Create an order for the test customer */
  async function createTestOrder(customerId: number, listingId: number) {
    const order = await createOrder(customerId, { shippingMethod: "STANDARD" as const, items: [{ productListingId: listingId, quantity: 1 }] });
    orderIdsForCleanup.push(order.id);
    return order;
  }

  it("ADMIN can cancel order via seller endpoint and records metadata", async () => {
    const {token: customerToken,userId: customerId} = await createCustomerWithBillingAddress();

    const { listingId,legoProductId } = await createListing();

    listingIdsForCleanup.push(listingId);
    legoProductIdsForCleanup.push(legoProductId);
    const order = await createTestOrder(customerId, listingId);
    const stockBeforeConfirmation = (await prisma.productListing.findUnique({ where: { id: listingId } }))!.currentStock;
    await prisma.productListing.update({ where: { id: listingId }, data: { currentStock: { decrement: 1 }, reservedStock: { decrement: 1 } } });
    await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });

    const res = await fetch(`${url}/orders/${order.id}/seller-cancel`, {
      method: "POST",
      headers: { ...{ "Idempotency-Key": crypto.randomUUID() },
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: CancellationReason.OUT_OF_STOCK }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(body));
    const cancelledOrder = await prisma.order.findUnique({ where: { id: order.id } });
    assert.strictEqual(cancelledOrder?.status, "CANCELLED");
    assert.strictEqual(cancelledOrder?.cancelledBy, "SELLER");
    assert.strictEqual(cancelledOrder?.cancellationReason, CancellationReason.OUT_OF_STOCK);
    assert.strictEqual((await prisma.productListing.findUnique({ where: { id: listingId } }))!.currentStock, stockBeforeConfirmation);
    assert.strictEqual((await prisma.inventoryMovement.findMany({ where: { listingId, type: InventoryMovementType.ORDER_CANCELLATION_RETURN } })).length, 1);
  });

  it("CUSTOMER receives 403 from seller cancel endpoint", async () => {
    const {token: customerToken,userId: customerId} = await createCustomerWithBillingAddress();

    const { listingId ,legoProductId} = await createListing();
    listingIdsForCleanup.push(listingId);
    legoProductIdsForCleanup.push(legoProductId);
    const order = await createTestOrder(customerId, listingId);
    await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });

    const res = await fetch(`${url}/orders/${order.id}/seller-cancel`, {
      method: "POST",
      headers: { ...{ "Idempotency-Key": crypto.randomUUID() },
        Authorization: `Bearer ${customerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: CancellationReason.OUT_OF_STOCK }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 403, JSON.stringify(body));
    const unchanged = await prisma.order.findUnique({ where: { id: order.id } });
    assert.strictEqual(unchanged?.status, "CONFIRMED");
    assert.strictEqual(unchanged?.cancelledAt, null);
    assert.strictEqual(unchanged?.cancelledBy, null);
    assert.strictEqual(unchanged?.cancellationReason, null);
  });

 it("Unauthenticated request returns 401", async () => {
    const {
      userId: customerId,
    } = await createCustomerWithBillingAddress();

    const { listingId, legoProductId } = await createListing();
    listingIdsForCleanup.push(listingId);
    legoProductIdsForCleanup.push(legoProductId);

    const order = await createTestOrder(customerId, listingId);

    const res = await fetch(`${url}/orders/${order.id}/seller-cancel`, {
      method: "POST",
      headers: { ...{ "Idempotency-Key": crypto.randomUUID() },
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        reason: CancellationReason.OUT_OF_STOCK,
      }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 401, JSON.stringify(body));
  });

  it("Customer-only reason CHANGED_MIND rejected on seller endpoint", async () => {
    const {
      token: customerToken,
      userId: customerId,
    } = await createCustomerWithBillingAddress();
    const { listingId } = await createListing();
    listingIdsForCleanup.push(listingId);
    const order = await createTestOrder(customerId, listingId);
    await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
    const res = await fetch(`${url}/orders/${order.id}/seller-cancel`, {
      method: "POST",
      headers: { ...{ "Idempotency-Key": crypto.randomUUID() },
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: CancellationReason.CHANGED_MIND }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 400, JSON.stringify(body));
  });

  it("Customer cancellation endpoint rejects seller-only reason OUT_OF_STOCK", async () => {
    const {
      token: customerToken,
      userId: customerId,
    } = await createCustomerWithBillingAddress();
    const { listingId } = await createListing();
    listingIdsForCleanup.push(listingId);
    const order = await createTestOrder(customerId, listingId);
    await prisma.order.update({ where: { id: order.id }, data: { status: "CONFIRMED" } });
    const res = await fetch(`${url}/orders/${order.id}/cancel`, {
      method: "POST",
      headers: { ...{ "Idempotency-Key": crypto.randomUUID() },
        Authorization: `Bearer ${customerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: CancellationReason.OUT_OF_STOCK }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 400, JSON.stringify(body));
  });

  it("Invalid orderId returns 400", async () => {
    const res = await fetch(`${url}/orders/abc/seller-cancel`, {
      method: "POST",
      headers: { ...{ "Idempotency-Key": crypto.randomUUID() },
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: CancellationReason.OUT_OF_STOCK }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 400, JSON.stringify(body));
  });

  it("Non-existent order returns 404 for ADMIN", async () => {
    const fakeId = 999999999;
    const res = await fetch(`${url}/orders/${fakeId}/seller-cancel`, {
      method: "POST",
      headers: { ...{ "Idempotency-Key": crypto.randomUUID() },
        Authorization: `Bearer ${adminToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ reason: CancellationReason.OUT_OF_STOCK }),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 404, JSON.stringify(body));
  });
});
