import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
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
import {
  OrderStatus,
  PaymentProvider,
  PaymentStatus,
  ReturnReason,
  ReturnShippingPayer,
  InventoryMovementType,
} from "../generated/prisma-client/enums.js";

const userIdsForCleanup: number[] = [];
const orderIdsForCleanup: number[] = [];
const paymentIdsForCleanup: number[] = [];
const listingIdsForCleanup: number[] = [];
const legoProductIdsForCleanup: number[] = [];
const returnIdsForCleanup: number[] = [];

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

function signToken(userId: number, role: "ADMIN" | "CUSTOMER") {
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
          recipientName: "Order Return Test User",
          line1: "1 Test Street",
          city: "Testville",
          postcode: "TEST1",
          countryCode: "GB",
          isDefaultBilling: true,
        },
      },
    },
  });
  userIdsForCleanup.push(user.id);
  return { id: user.id, token: signToken(user.id, role) };
}

async function createListing() {
  const product = await prisma.legoProduct.create({
    data: {
      setNumber: `RETURN-HTTP-${randomUUID()}`,
      title: "Order Return HTTP Test Product",
      theme: "TEST",
      ageRecommendation: "8+",
      pieceCount: 100,
      productListings: {
        create: {

          condition: "NEW",
          originalPrice: new Decimal("20.00"),
          salePrice: new Decimal("15.00"),
          currentStock: 5,
          active: true,
        },
      },
    },
    include: { productListings: true },
  });
  const listing = product.productListings[0];
  legoProductIdsForCleanup.push(product.id);
  listingIdsForCleanup.push(listing.id);
  return listing;
}

async function createOrderFixture(customerId: number, quantity = 3) {
  const listing = await createListing();
  const order = await createOrder(customerId, {
    items: [{ productListingId: listing.id, quantity }],
  });
  await confirmOrder(customerId, order.id);
  orderIdsForCleanup.push(order.id);
  return { listing, order, orderItem: order.orderItems[0] };
}

async function postReturn(
  url: string,
  orderId: number | string,
  token: string | undefined,
  body: unknown,
) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${url}/orders/${orderId}/returns`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function authorizeReturn(
  url: string,
  orderId: number | string,
  returnId: number | string,
  token: string | undefined,
) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${url}/orders/${orderId}/returns/${returnId}/authorize`, {
    method: "POST",
    headers,
  });
}

async function receiveReturn(
  url: string,
  orderId: number | string,
  returnId: number | string,
  token: string | undefined,
) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${url}/orders/${orderId}/returns/${returnId}/receive`, {
    method: "POST",
    headers,
  });
}

async function inspectReturn(url: string, orderId: number | string, returnId: number | string, token: string | undefined, body: unknown) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${url}/orders/${orderId}/returns/${returnId}/inspect`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function completeReturn(url: string, orderId: number | string, returnId: number | string, token: string | undefined) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${url}/orders/${orderId}/returns/${returnId}/complete`, { method: "POST", headers });
}

async function cancelReturn(url: string, orderId: number | string, returnId: number | string, token: string | undefined) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${url}/orders/${orderId}/returns/${returnId}/cancel`, { method: "POST", headers });
}

describe("Order Return HTTP Integration", () => {
  let server: Server;
  let url: string;
  let admin: { id: number; token: string };

  before(async () => {
    ({ server, url } = await startServer());
    admin = await createUser("ADMIN");
  });

  async function createInspectedHttpReturn(customerId: number, quantity = 1, restockQuantity = 1) {
    const fixture = await createOrderFixture(customerId, quantity + 1);
    const requested = await (await postReturn(url, fixture.order.id, admin.token, { orderItemId: fixture.orderItem.id, quantity, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER })).json();
    returnIdsForCleanup.push(requested.id);
    await authorizeReturn(url, fixture.order.id, requested.id, admin.token);
    await receiveReturn(url, fixture.order.id, requested.id, admin.token);
    await inspectReturn(url, fixture.order.id, requested.id, admin.token, { condition: "AS_NEW", restockQuantity });
    return { ...fixture, returnId: requested.id };
  }

  afterEach(async () => {
    if (returnIdsForCleanup.length) {
      await prisma.orderReturn.deleteMany({ where: { id: { in: returnIdsForCleanup } } });
      returnIdsForCleanup.length = 0;
    }
    if (paymentIdsForCleanup.length) {
      await prisma.payment.deleteMany({ where: { id: { in: paymentIdsForCleanup } } });
      paymentIdsForCleanup.length = 0;
    }
    if (orderIdsForCleanup.length) {
      await prisma.order.deleteMany({ where: { id: { in: orderIdsForCleanup } } });
      orderIdsForCleanup.length = 0;
    }
    if (listingIdsForCleanup.length) {
      await prisma.inventoryMovement.deleteMany({ where: { listingId: { in: listingIdsForCleanup } } });
      await prisma.productListing.deleteMany({ where: { id: { in: listingIdsForCleanup } } });
      listingIdsForCleanup.length = 0;
    }
    if (legoProductIdsForCleanup.length) {
      await prisma.legoProduct.deleteMany({ where: { id: { in: legoProductIdsForCleanup } } });
      legoProductIdsForCleanup.length = 0;
    }
    if (userIdsForCleanup.length > 1) {
      await prisma.user.deleteMany({ where: { id: { in: userIdsForCleanup.filter((id) => id !== admin.id) } } });
      userIdsForCleanup.length = 0;
      userIdsForCleanup.push(admin.id);
    }
  });

  after(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [admin.id] } } });
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("ADMIN creates a REQUESTED return without side effects", async () => {
    const customer = await createUser("CUSTOMER");
    const { listing, order, orderItem } = await createOrderFixture(customer.id);
    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        amount: order.totalAmount,
        currency: "GBP",
        provider: PaymentProvider.MANUAL,
        providerReference: `return-http-${randomUUID()}`,
        status: PaymentStatus.SUCCEEDED,
        paidAt: new Date(),
      },
    });
    paymentIdsForCleanup.push(payment.id);
    const itemBefore = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingBefore = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderBefore = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentsBefore = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsBefore = await prisma.inventoryMovement.findMany({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    const response = await postReturn(url, order.id, admin.token, {
      orderItemId: orderItem.id,
      quantity: 2,
      reason: ReturnReason.DAMAGED,
      reasonNote: "Packaging was damaged",
      shippingPayer: ReturnShippingPayer.SELLER,
      returnShippingCost: 4.5,
    });
    const body = await response.json();
    assert.strictEqual(response.status, 201, JSON.stringify(body));
    returnIdsForCleanup.push(body.id);
    assert.strictEqual(body.status, "REQUESTED");
    assert.strictEqual(body.orderItemId, orderItem.id);
    assert.strictEqual(body.quantity, 2);
    assert.strictEqual(body.reason, ReturnReason.DAMAGED);
    assert.strictEqual(body.reasonNote, "Packaging was damaged");
    assert.strictEqual(body.shippingPayer, ReturnShippingPayer.SELLER);
    assert.strictEqual(String(body.returnShippingCost), "4.5");
    assert.strictEqual(body.restockQuantity, 0);
    assert.strictEqual(body.performedByUserId, admin.id);
    assert.ok(body.requestedAt);
    assert.strictEqual(body.receivedAt, null);
    assert.strictEqual(body.inspectedAt, null);
    assert.strictEqual(body.completedAt, null);
    const itemAfter = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingAfter = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderAfter = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentsAfter = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsAfter = await prisma.inventoryMovement.findMany({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    assert.strictEqual(itemAfter?.returnedQuantity, itemBefore?.returnedQuantity);
    assert.strictEqual(listingAfter?.currentStock, listingBefore?.currentStock);
    assert.strictEqual(orderAfter?.status, orderBefore?.status);
    assert.deepStrictEqual(paymentsAfter, paymentsBefore);
    assert.deepStrictEqual(movementsAfter, movementsBefore);
  });

  it("persists omitted optional fields as null", async () => {
    const customer = await createUser("CUSTOMER");
    const { order, orderItem } = await createOrderFixture(customer.id);
    const response = await postReturn(url, order.id, admin.token, { orderItemId: orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER });
    const body = await response.json();
    assert.strictEqual(response.status, 201, JSON.stringify(body));
    returnIdsForCleanup.push(body.id);
    assert.strictEqual(body.reasonNote, null);
    assert.strictEqual(body.returnShippingCost, null);
  });

  it("rejects invalid request bodies with 400", async () => {
    const customer = await createUser("CUSTOMER");
    const { order, orderItem } = await createOrderFixture(customer.id);
    const cases = [
      { orderItemId: orderItem.id, quantity: 1, reason: ReturnReason.OTHER },
      { orderItemId: orderItem.id, quantity: 1, reason: "INVALID_REASON", shippingPayer: ReturnShippingPayer.CUSTOMER },
      { orderItemId: orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: "INVALID_PAYER" },
      { orderItemId: orderItem.id, quantity: 0, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER },
      { orderItemId: orderItem.id, quantity: -1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER },
      { orderItemId: orderItem.id, quantity: orderItem.quantity + 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER },
      { orderItemId: orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER, returnShippingCost: -1 },
    ];
    for (const body of cases) {
      const response = await postReturn(url, order.id, admin.token, body);
      assert.strictEqual(response.status, 400);
    }
  });

  it("returns 404 for a missing order", async () => {
    const customer = await createUser("CUSTOMER");
    const { orderItem } = await createOrderFixture(customer.id);
    const response = await postReturn(url, 999999999, admin.token, { orderItemId: orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER });
    assert.strictEqual(response.status, 404);
  });

  it("returns 404 when the order item belongs to another order", async () => {
    const firstCustomer = await createUser("CUSTOMER");
    const secondCustomer = await createUser("CUSTOMER");
    const first = await createOrderFixture(firstCustomer.id);
    const second = await createOrderFixture(secondCustomer.id);
    const response = await postReturn(url, first.order.id, admin.token, { orderItemId: second.orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER });
    assert.strictEqual(response.status, 404);
  });

  it("rejects unauthenticated requests with 401", async () => {
    const customer = await createUser("CUSTOMER");
    const { order, orderItem } = await createOrderFixture(customer.id);
    const response = await postReturn(url, order.id, undefined, { orderItemId: orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER });
    assert.strictEqual(response.status, 401);
  });

  it("rejects authenticated CUSTOMER requests with 403", async () => {
    const customer = await createUser("CUSTOMER");
    const { order, orderItem } = await createOrderFixture(customer.id);
    const response = await postReturn(url, order.id, customer.token, { orderItemId: orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER });
    assert.strictEqual(response.status, 403);
  });

  it("ADMIN authorizes a REQUESTED return without business side effects", async () => {
    const customer = await createUser("CUSTOMER");
    const { listing, order, orderItem } = await createOrderFixture(customer.id);
    const requestedResponse = await postReturn(url, order.id, admin.token, {
      orderItemId: orderItem.id,
      quantity: 2,
      reason: ReturnReason.DAMAGED,
      reasonNote: "Damaged packaging",
      shippingPayer: ReturnShippingPayer.SELLER,
      returnShippingCost: 4.5,
    });
    const requested = await requestedResponse.json();
    assert.strictEqual(requestedResponse.status, 201, JSON.stringify(requested));
    returnIdsForCleanup.push(requested.id);

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        amount: order.totalAmount,
        currency: "GBP",
        provider: PaymentProvider.MANUAL,
        providerReference: `authorize-http-${randomUUID()}`,
        status: PaymentStatus.SUCCEEDED,
        paidAt: new Date(),
      },
    });
    paymentIdsForCleanup.push(payment.id);

    const itemBefore = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingBefore = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderBefore = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentsBefore = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsBefore = await prisma.inventoryMovement.findMany({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });

    const response = await authorizeReturn(url, order.id, requested.id, admin.token);
    const body = await response.json();
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    assert.strictEqual(body.status, "AUTHORIZED");
    assert.ok(body.authorizedAt);
    assert.strictEqual(body.performedByUserId, requested.performedByUserId);
    assert.strictEqual(body.quantity, requested.quantity);
    assert.strictEqual(body.restockQuantity, requested.restockQuantity);
    assert.strictEqual(body.receivedAt, null);
    assert.strictEqual(body.inspectedAt, null);
    assert.strictEqual(body.completedAt, null);

    const itemAfter = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingAfter = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderAfter = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentsAfter = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsAfter = await prisma.inventoryMovement.findMany({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    assert.strictEqual(itemAfter?.returnedQuantity, itemBefore?.returnedQuantity);
    assert.strictEqual(listingAfter?.currentStock, listingBefore?.currentStock);
    assert.strictEqual(orderAfter?.status, orderBefore?.status);
    assert.deepStrictEqual(paymentsAfter, paymentsBefore);
    assert.deepStrictEqual(movementsAfter, movementsBefore);
  });

  it("returns 409 when authorizing an already AUTHORIZED return", async () => {
    const customer = await createUser("CUSTOMER");
    const { order, orderItem } = await createOrderFixture(customer.id);
    const requestedResponse = await postReturn(url, order.id, admin.token, {
      orderItemId: orderItem.id,
      quantity: 1,
      reason: ReturnReason.OTHER,
      shippingPayer: ReturnShippingPayer.CUSTOMER,
    });
    const requested = await requestedResponse.json();
    returnIdsForCleanup.push(requested.id);
    assert.strictEqual((await authorizeReturn(url, order.id, requested.id, admin.token)).status, 200);
    assert.strictEqual((await authorizeReturn(url, order.id, requested.id, admin.token)).status, 409);
  });

  it("returns 404 for missing order, missing return, and wrong-order return", async () => {
    const firstCustomer = await createUser("CUSTOMER");
    const secondCustomer = await createUser("CUSTOMER");
    const first = await createOrderFixture(firstCustomer.id);
    const second = await createOrderFixture(secondCustomer.id);
    const firstResponse = await postReturn(url, first.order.id, admin.token, { orderItemId: first.orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER });
    const firstReturn = await firstResponse.json();
    returnIdsForCleanup.push(firstReturn.id);
    assert.strictEqual((await authorizeReturn(url, 999999999, firstReturn.id, admin.token)).status, 404);
    assert.strictEqual((await authorizeReturn(url, first.order.id, 999999999, admin.token)).status, 404);
    const secondResponse = await postReturn(url, second.order.id, admin.token, { orderItemId: second.orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER });
    const secondReturn = await secondResponse.json();
    returnIdsForCleanup.push(secondReturn.id);
    assert.strictEqual((await authorizeReturn(url, first.order.id, secondReturn.id, admin.token)).status, 404);
  });

  it("returns 400 for invalid orderId and returnId route parameters", async () => {
    assert.strictEqual((await authorizeReturn(url, "not-an-id", 1, admin.token)).status, 400);
    assert.strictEqual((await authorizeReturn(url, 0, 1, admin.token)).status, 400);
    assert.strictEqual((await authorizeReturn(url, 1, "not-a-return-id", admin.token)).status, 400);
    assert.strictEqual((await authorizeReturn(url, 1, 0, admin.token)).status, 400);
  });

  it("returns 401 for unauthenticated authorization requests", async () => {
    const customer = await createUser("CUSTOMER");
    const { order, orderItem } = await createOrderFixture(customer.id);
    const requestedResponse = await postReturn(url, order.id, admin.token, { orderItemId: orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER });
    const requested = await requestedResponse.json();
    returnIdsForCleanup.push(requested.id);
    assert.strictEqual((await authorizeReturn(url, order.id, requested.id, undefined)).status, 401);
  });

  it("returns 403 for authenticated CUSTOMER authorization requests", async () => {
    const customer = await createUser("CUSTOMER");
    const { order, orderItem } = await createOrderFixture(customer.id);
    const requestedResponse = await postReturn(url, order.id, admin.token, { orderItemId: orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER });
    const requested = await requestedResponse.json();
    returnIdsForCleanup.push(requested.id);
    assert.strictEqual((await authorizeReturn(url, order.id, requested.id, customer.token)).status, 403);
  });

  it("ADMIN receives an AUTHORIZED return without business side effects", async () => {
    const customer = await createUser("CUSTOMER");
    const { listing, order, orderItem } = await createOrderFixture(customer.id);
    const requestedResponse = await postReturn(url, order.id, admin.token, {
      orderItemId: orderItem.id,
      quantity: 2,
      reason: ReturnReason.DAMAGED,
      reasonNote: "Damaged packaging",
      shippingPayer: ReturnShippingPayer.SELLER,
      returnShippingCost: 4.5,
    });
    const requested = await requestedResponse.json();
    assert.strictEqual(requestedResponse.status, 201, JSON.stringify(requested));
    returnIdsForCleanup.push(requested.id);

    const authorizedResponse = await authorizeReturn(url, order.id, requested.id, admin.token);
    const authorized = await authorizedResponse.json();
    assert.strictEqual(authorizedResponse.status, 200, JSON.stringify(authorized));

    const payment = await prisma.payment.create({
      data: {
        orderId: order.id,
        amount: order.totalAmount,
        currency: "GBP",
        provider: PaymentProvider.MANUAL,
        providerReference: `receive-http-${randomUUID()}`,
        status: PaymentStatus.SUCCEEDED,
        paidAt: new Date(),
      },
    });
    paymentIdsForCleanup.push(payment.id);

    const itemBefore = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingBefore = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderBefore = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentsBefore = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsBefore = await prisma.inventoryMovement.findMany({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });

    const response = await receiveReturn(url, order.id, requested.id, admin.token);
    const body = await response.json();
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    assert.strictEqual(body.status, "RECEIVED");
    assert.ok(body.receivedAt);
    assert.strictEqual(body.authorizedAt, authorized.authorizedAt);
    assert.strictEqual(body.requestedAt, requested.requestedAt);
    assert.strictEqual(body.performedByUserId, requested.performedByUserId);
    assert.strictEqual(body.quantity, requested.quantity);
    assert.strictEqual(body.restockQuantity, requested.restockQuantity);
    assert.strictEqual(body.inspectedAt, null);
    assert.strictEqual(body.completedAt, null);

    const itemAfter = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingAfter = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderAfter = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentsAfter = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsAfter = await prisma.inventoryMovement.findMany({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    assert.strictEqual(itemAfter?.returnedQuantity, itemBefore?.returnedQuantity);
    assert.strictEqual(listingAfter?.currentStock, listingBefore?.currentStock);
    assert.strictEqual(orderAfter?.status, orderBefore?.status);
    assert.deepStrictEqual(paymentsAfter, paymentsBefore);
    assert.deepStrictEqual(movementsAfter, movementsBefore);
  });

  it("returns 409 for REQUESTED and already RECEIVED returns", async () => {
    const customer = await createUser("CUSTOMER");
    const { order, orderItem } = await createOrderFixture(customer.id);
    const requestedResponse = await postReturn(url, order.id, admin.token, { orderItemId: orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER });
    const requested = await requestedResponse.json();
    returnIdsForCleanup.push(requested.id);
    assert.strictEqual((await receiveReturn(url, order.id, requested.id, admin.token)).status, 409);
    await authorizeReturn(url, order.id, requested.id, admin.token);
    assert.strictEqual((await receiveReturn(url, order.id, requested.id, admin.token)).status, 200);
    assert.strictEqual((await receiveReturn(url, order.id, requested.id, admin.token)).status, 409);
  });

  it("returns 404 for missing order, missing return, and wrong-order return", async () => {
    const firstCustomer = await createUser("CUSTOMER");
    const secondCustomer = await createUser("CUSTOMER");
    const first = await createOrderFixture(firstCustomer.id);
    const second = await createOrderFixture(secondCustomer.id);
    const firstResponse = await postReturn(url, first.order.id, admin.token, { orderItemId: first.orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER });
    const firstReturn = await firstResponse.json();
    returnIdsForCleanup.push(firstReturn.id);
    await authorizeReturn(url, first.order.id, firstReturn.id, admin.token);
    assert.strictEqual((await receiveReturn(url, 999999999, firstReturn.id, admin.token)).status, 404);
    assert.strictEqual((await receiveReturn(url, first.order.id, 999999999, admin.token)).status, 404);
    const secondResponse = await postReturn(url, second.order.id, admin.token, { orderItemId: second.orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER });
    const secondReturn = await secondResponse.json();
    returnIdsForCleanup.push(secondReturn.id);
    await authorizeReturn(url, second.order.id, secondReturn.id, admin.token);
    assert.strictEqual((await receiveReturn(url, first.order.id, secondReturn.id, admin.token)).status, 404);
  });

  it("returns 400 for invalid route parameters", async () => {
    assert.strictEqual((await receiveReturn(url, "not-an-id", 1, admin.token)).status, 400);
    assert.strictEqual((await receiveReturn(url, 0, 1, admin.token)).status, 400);
    assert.strictEqual((await receiveReturn(url, 1, "not-a-return-id", admin.token)).status, 400);
    assert.strictEqual((await receiveReturn(url, 1, 0, admin.token)).status, 400);
  });

  it("returns 401 when unauthenticated and 403 for CUSTOMER users", async () => {
    const customer = await createUser("CUSTOMER");
    const { order, orderItem } = await createOrderFixture(customer.id);
    const requestedResponse = await postReturn(url, order.id, admin.token, { orderItemId: orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER });
    const requested = await requestedResponse.json();
    returnIdsForCleanup.push(requested.id);
    await authorizeReturn(url, order.id, requested.id, admin.token);
    assert.strictEqual((await receiveReturn(url, order.id, requested.id, undefined)).status, 401);
    assert.strictEqual((await receiveReturn(url, order.id, requested.id, customer.token)).status, 403);
  });
  it("ADMIN inspects a RECEIVED return and has no business side effects", async () => {
    const customer = await createUser("CUSTOMER");
    const { listing, order, orderItem } = await createOrderFixture(customer.id);
    const created = await (await postReturn(url, order.id, admin.token, { orderItemId: orderItem.id, quantity: 2, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER })).json();
    returnIdsForCleanup.push(created.id);
    await authorizeReturn(url, order.id, created.id, admin.token);
    const received = await (await receiveReturn(url, order.id, created.id, admin.token)).json();
    const itemBefore = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingBefore = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderBefore = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentsBefore = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsBefore = await prisma.inventoryMovement.findMany({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    const response = await inspectReturn(url, order.id, created.id, admin.token, { condition: "AS_NEW", restockQuantity: 1, inspectionNote: "  Looks as new  " });
    const body = await response.json();
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    assert.strictEqual(body.status, "INSPECTED");
    assert.strictEqual(body.condition, "AS_NEW");
    assert.strictEqual(body.restockQuantity, 1);
    assert.strictEqual(body.inspectionNote, "Looks as new");
    assert.ok(body.inspectedAt);
    assert.strictEqual(body.inspectedByUserId, admin.id);
    assert.strictEqual(body.requestedAt, created.requestedAt);
    assert.strictEqual(body.authorizedAt, received.authorizedAt);
    assert.strictEqual(body.receivedAt, received.receivedAt);
    assert.strictEqual(body.quantity, created.quantity);
    assert.strictEqual(body.performedByUserId, created.performedByUserId);
    assert.strictEqual(body.completedAt, null);
    const itemAfter = await prisma.orderItem.findUnique({ where: { id: orderItem.id } });
    const listingAfter = await prisma.productListing.findUnique({ where: { id: listing.id } });
    const orderAfter = await prisma.order.findUnique({ where: { id: order.id } });
    const paymentsAfter = await prisma.payment.findMany({ where: { orderId: order.id } });
    const movementsAfter = await prisma.inventoryMovement.findMany({ where: { listingId: listing.id, type: InventoryMovementType.ORDER_RETURN } });
    assert.strictEqual(itemAfter?.returnedQuantity, itemBefore?.returnedQuantity);
    assert.strictEqual(listingAfter?.currentStock, listingBefore?.currentStock);
    assert.strictEqual(orderAfter?.status, orderBefore?.status);
    assert.deepStrictEqual(paymentsAfter, paymentsBefore);
    assert.deepStrictEqual(movementsAfter, movementsBefore);
  });

  it("rejects invalid inspection input and client-controlled inspector", async () => {
    const customer = await createUser("CUSTOMER");
    const { order, orderItem } = await createOrderFixture(customer.id);
    const created = await (await postReturn(url, order.id, admin.token, { orderItemId: orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER })).json();
    returnIdsForCleanup.push(created.id);
    await authorizeReturn(url, order.id, created.id, admin.token);
    await receiveReturn(url, order.id, created.id, admin.token);
    for (const body of [{ condition: "INVALID", restockQuantity: 0 }, { condition: "AS_NEW", restockQuantity: -1 }, { condition: "AS_NEW", restockQuantity: 1.5 }, { condition: "AS_NEW", restockQuantity: 2 }, { condition: "AS_NEW", restockQuantity: 0, inspectedByUserId: customer.id }]) {
      assert.strictEqual((await inspectReturn(url, order.id, created.id, admin.token, body)).status, 400);
    }
  });

  it("enforces non-AS_NEW restock and lifecycle conflicts", async () => {
    const customer = await createUser("CUSTOMER");
    const makeReceived = async () => { const f = await createOrderFixture(customer.id); const r = await (await postReturn(url, f.order.id, admin.token, { orderItemId: f.orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER })).json(); returnIdsForCleanup.push(r.id); await authorizeReturn(url, f.order.id, r.id, admin.token); await receiveReturn(url, f.order.id, r.id, admin.token); return { ...f, id: r.id }; };
    for (const condition of ["OPENED_COMPLETE", "DAMAGED"]) { const f = await makeReceived(); assert.strictEqual((await inspectReturn(url, f.order.id, f.id, admin.token, { condition, restockQuantity: 1 })).status, 400); }
    const f = await makeReceived(); assert.strictEqual((await inspectReturn(url, f.order.id, f.id, admin.token, { condition: "DAMAGED", restockQuantity: 0 })).status, 200);
    const requested = await createOrderFixture(customer.id); const r = await (await postReturn(url, requested.order.id, admin.token, { orderItemId: requested.orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER })).json(); returnIdsForCleanup.push(r.id); assert.strictEqual((await inspectReturn(url, requested.order.id, r.id, admin.token, { condition: "AS_NEW", restockQuantity: 0 })).status, 409);
  });

  it("returns 404 for missing or wrong-order resources and 400 for invalid params", async () => {
    const customer = await createUser("CUSTOMER"); const first = await createOrderFixture(customer.id); const second = await createOrderFixture(customer.id);
    const r = await (await postReturn(url, first.order.id, admin.token, { orderItemId: first.orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER })).json(); returnIdsForCleanup.push(r.id); await authorizeReturn(url, first.order.id, r.id, admin.token); await receiveReturn(url, first.order.id, r.id, admin.token);
    const body = { condition: "AS_NEW", restockQuantity: 0 }; assert.strictEqual((await inspectReturn(url, 999999999, r.id, admin.token, body)).status, 404); assert.strictEqual((await inspectReturn(url, first.order.id, 999999999, admin.token, body)).status, 404); assert.strictEqual((await inspectReturn(url, "bad", 1, admin.token, body)).status, 400); assert.strictEqual((await inspectReturn(url, first.order.id, "bad", admin.token, body)).status, 400);
    const r2 = await (await postReturn(url, second.order.id, admin.token, { orderItemId: second.orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER })).json(); returnIdsForCleanup.push(r2.id); await authorizeReturn(url, second.order.id, r2.id, admin.token); await receiveReturn(url, second.order.id, r2.id, admin.token); assert.strictEqual((await inspectReturn(url, first.order.id, r2.id, admin.token, body)).status, 404);
  });

  it("returns 401 unauthenticated and 403 for CUSTOMER", async () => {
    const customer = await createUser("CUSTOMER"); const f = await createOrderFixture(customer.id); const r = await (await postReturn(url, f.order.id, admin.token, { orderItemId: f.orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER })).json(); returnIdsForCleanup.push(r.id); await authorizeReturn(url, f.order.id, r.id, admin.token); await receiveReturn(url, f.order.id, r.id, admin.token); const body = { condition: "AS_NEW", restockQuantity: 0 }; assert.strictEqual((await inspectReturn(url, f.order.id, r.id, undefined, body)).status, 401); assert.strictEqual((await inspectReturn(url, f.order.id, r.id, customer.token, body)).status, 403);
  });

  it("ADMIN completes an INSPECTED return with correct side effects", async () => {
    const customer = await createUser("CUSTOMER");
    const fixture = await createInspectedHttpReturn(customer.id, 2, 1);
    const itemBefore = await prisma.orderItem.findUnique({ where: { id: fixture.orderItem.id } });
    const listingBefore = await prisma.productListing.findUnique({ where: { id: fixture.listing.id } });
    const response = await completeReturn(url, fixture.order.id, fixture.returnId, admin.token);
    const body = await response.json();
    assert.strictEqual(response.status, 200, JSON.stringify(body));
    assert.strictEqual(body.status, "COMPLETED"); assert.ok(body.completedAt); assert.strictEqual(body.quantity, 2); assert.strictEqual(body.restockQuantity, 1); assert.strictEqual(body.condition, "AS_NEW"); assert.strictEqual(body.performedByUserId, admin.id); assert.strictEqual(body.inspectedByUserId, admin.id);
    const itemAfter = await prisma.orderItem.findUnique({ where: { id: fixture.orderItem.id } }); const listingAfter = await prisma.productListing.findUnique({ where: { id: fixture.listing.id } }); const movements = await prisma.inventoryMovement.findMany({ where: { listingId: fixture.listing.id, type: InventoryMovementType.ORDER_RETURN } });
    assert.strictEqual(itemAfter?.returnedQuantity, (itemBefore?.returnedQuantity ?? 0) + 2); assert.strictEqual(listingAfter?.currentStock, (listingBefore?.currentStock ?? 0) + 1); assert.strictEqual(movements.length, 1); assert.strictEqual(movements[0].quantityChange, 1);
  });

  it("completes zero-restock returns without stock or movement changes", async () => {
    const customer = await createUser("CUSTOMER"); const fixture = await createInspectedHttpReturn(customer.id, 2, 0); const before = await prisma.productListing.findUnique({ where: { id: fixture.listing.id } }); const count = await prisma.inventoryMovement.count({ where: { listingId: fixture.listing.id, type: InventoryMovementType.ORDER_RETURN } });
    assert.strictEqual((await completeReturn(url, fixture.order.id, fixture.returnId, admin.token)).status, 200); const item = await prisma.orderItem.findUnique({ where: { id: fixture.orderItem.id } }); const after = await prisma.productListing.findUnique({ where: { id: fixture.listing.id } }); assert.strictEqual(item?.returnedQuantity, 2); assert.strictEqual(after?.currentStock, before?.currentStock); assert.strictEqual(await prisma.inventoryMovement.count({ where: { listingId: fixture.listing.id, type: InventoryMovementType.ORDER_RETURN } }), count);
  });

  it("returns 409 for invalid lifecycle and cumulative completion", async () => {
    const customer = await createUser("CUSTOMER"); const fixture = await createOrderFixture(customer.id); const r = await (await postReturn(url, fixture.order.id, admin.token, { orderItemId: fixture.orderItem.id, quantity: 1, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER })).json(); returnIdsForCleanup.push(r.id); assert.strictEqual((await completeReturn(url, fixture.order.id, r.id, admin.token)).status, 409); await authorizeReturn(url, fixture.order.id, r.id, admin.token); assert.strictEqual((await completeReturn(url, fixture.order.id, r.id, admin.token)).status, 409); await receiveReturn(url, fixture.order.id, r.id, admin.token); assert.strictEqual((await completeReturn(url, fixture.order.id, r.id, admin.token)).status, 409);
    const shared = await createOrderFixture(customer.id, 3);
    const first = await (await postReturn(url, shared.order.id, admin.token, { orderItemId: shared.orderItem.id, quantity: 2, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER })).json(); returnIdsForCleanup.push(first.id); assert.strictEqual((await postReturn(url, shared.order.id, admin.token, { orderItemId: shared.orderItem.id, quantity: 2, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER })).status, 400); assert.strictEqual((await prisma.orderItem.findUnique({ where: { id: shared.orderItem.id } }))?.reservedReturnQuantity, 2);
  });

  it("rejects overlapping requests and releases cancelled reservations", async () => {
    const customer = await createUser("CUSTOMER");
    const fixture = await createOrderFixture(customer.id, 3);
    const body = { orderItemId: fixture.orderItem.id, quantity: 2, reason: ReturnReason.OTHER, shippingPayer: ReturnShippingPayer.CUSTOMER };
    const firstResponse = await postReturn(url, fixture.order.id, admin.token, body);
    const first = await firstResponse.json();
    returnIdsForCleanup.push(first.id);
    assert.strictEqual(firstResponse.status, 201);
    assert.strictEqual((await postReturn(url, fixture.order.id, admin.token, body)).status, 400);
    assert.strictEqual((await cancelReturn(url, fixture.order.id, first.id, undefined)).status, 401);
    const authCustomer = await createUser("CUSTOMER");
    assert.strictEqual((await cancelReturn(url, fixture.order.id, first.id, authCustomer.token)).status, 403);
    assert.strictEqual((await cancelReturn(url, fixture.order.id, first.id, admin.token)).status, 200);
    assert.strictEqual((await postReturn(url, fixture.order.id, admin.token, { ...body, quantity: 3 })).status, 201);
  });

  it("returns 404 for missing or wrong-order resources and 400 for invalid params", async () => {
    const customer = await createUser("CUSTOMER"); const first = await createInspectedHttpReturn(customer.id); const second = await createInspectedHttpReturn(customer.id); assert.strictEqual((await completeReturn(url, 999999999, first.returnId, admin.token)).status, 404); assert.strictEqual((await completeReturn(url, first.order.id, 999999999, admin.token)).status, 404); assert.strictEqual((await completeReturn(url, first.order.id, second.returnId, admin.token)).status, 404); assert.strictEqual((await completeReturn(url, "bad", 1, admin.token)).status, 400); assert.strictEqual((await completeReturn(url, first.order.id, "bad", admin.token)).status, 400);
  });

  it("returns 401 unauthenticated and 403 for CUSTOMER completion", async () => {
    const customer = await createUser("CUSTOMER"); const fixture = await createInspectedHttpReturn(customer.id); assert.strictEqual((await completeReturn(url, fixture.order.id, fixture.returnId, undefined)).status, 401); assert.strictEqual((await completeReturn(url, fixture.order.id, fixture.returnId, customer.token)).status, 403);
  });
});
