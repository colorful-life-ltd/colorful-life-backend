import { dispatchOrder } from "../domain/orders/orderDispatchService.js";
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Server } from "node:http";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { createOrder } from "../domain/orders/orderService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import { recordVerifiedPayment } from "./fixtures/verifiedPayment.js";
import { captureConfirmationTransport } from "../domain/orderConfirmation/delivery.js";
import { runConfirmationBatch } from "../domain/orderConfirmation/worker.js";
import {
  submitReturns,
  returnAction,
  customerReturnCase,
  authorizationSchema,
  submissionSchema,
} from "../domain/orders/returnManagement.js";
const orders: number[] = [],
  listings: number[] = [],
  products: number[] = [],
  users: number[] = [];
let url: string,
  server: Server,
  admin: { id: number; token: string },
  customer: { id: number; token: string },
  other: { id: number; token: string };
async function user(role: "ADMIN" | "CUSTOMER") {
  const u = await prisma.user.create({
    data: {
      email: `return-v1-${randomUUID()}@example.invalid`,
      passwordHash: "synthetic",
      emailVerified: true,
      role,
      addresses: {
        create: {
          recipientName: "Synthetic Customer",
          line1: "1 Test Road",
          city: "Test",
          postcode: "S63 8NS",
          countryCode: "GB",
          isDefaultBilling: true,
        },
      },
    },
  });
  users.push(u.id);
  return {
    id: u.id,
    token: jwt.sign({ id: u.id, role }, config.JWT_SECRET, { expiresIn: "1h" }),
  };
}
async function fixture(dispatched = true) {
  const items = [];
  for (let n = 0; n < 3; n++) {
    const p = await prisma.legoProduct.create({
      data: {
        setNumber: `RMA-${randomUUID()}`,
        title: `Synthetic LEGO ${n}`,
        theme: "TEST",
        ageRecommendation: "8+",
        pieceCount: 100,
        productListings: {
          create: {
            condition: "NEW",
            originalPrice: 20,
            salePrice: 15,
            currentStock: 10,
            active: true,
          },
        },
      },
      include: { productListings: true },
    });
    products.push(p.id);
    listings.push(p.productListings[0].id);
    items.push({ productListingId: p.productListings[0].id, quantity: 3 });
  }
  const o = await createOrder(customer.id, {
    shippingMethod: "STANDARD",
    items,
  });
  orders.push(o.id);
  await recordVerifiedPayment(o.id);
  await confirmOrder(customer.id, o.id);
  if (dispatched)
    await dispatchOrder(o.id, 0, "Royal Mail", "AB123456789GB", admin.id);
  return o;
}
const input = (
  itemId: number,
  quantity = 1,
  reason: "CHANGE_OF_MIND" | "DEFECTIVE" = "CHANGE_OF_MIND",
) =>
  submissionSchema.parse({
    idempotencyKey: randomUUID(),
    lines: [{ orderItemId: itemId, quantity, reason }],
  });
const authorization = authorizationSchema.parse({
  shippingPayer: "SELLER",
  postageInstructions: "Contact support to arrange prepaid postage.",
  rightsReviewed: true,
});
async function http(path: string, token?: string, body?: unknown) {
  return fetch(url + path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}
describe("Return management V1", () => {
  before(async () => {
    admin = await user("ADMIN");
    customer = await user("CUSTOMER");
    other = await user("CUSTOMER");
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    url = `http://127.0.0.1:${address.port}`;
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await prisma.orderReturn.deleteMany({
      where: { orderItem: { orderId: { in: orders } } },
    });
    await prisma.payment.deleteMany({ where: { orderId: { in: orders } } });
    await prisma.order.deleteMany({ where: { id: { in: orders } } });
    await prisma.inventoryMovement.deleteMany({
      where: { listingId: { in: listings } },
    });
    await prisma.productListing.deleteMany({ where: { id: { in: listings } } });
    await prisma.legoProduct.deleteMany({ where: { id: { in: products } } });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  it("rejects customer and admin pre-dispatch admission without case/reservation/refund writes", async () => {
    const o = await fixture(false),
      body = input(o.orderItems[0].id);
    assert.equal(
      (await http(`/orders/${o.id}/return-requests`, customer.token, body))
        .status,
      409,
    );
    assert.equal(
      (await http(`/admin/returns/${o.id}/requests`, admin.token, body)).status,
      409,
    );
    assert.equal(
      await prisma.returnCase.count({ where: { orderId: o.id } }),
      0,
    );
    assert.equal(
      (
        await prisma.orderItem.findUniqueOrThrow({
          where: { id: o.orderItems[0].id },
        })
      ).reservedReturnQuantity,
      0,
    );
    assert.equal(await prisma.refund.count({ where: { orderId: o.id } }), 0);
    assert.ok(
      (await customerReturnCase(o.id, customer.id)).items.every(
        (i) => i.remainingQuantity === 0,
      ),
    );
  });
  it("leaves the existing public shipping catalogue unauthenticated", async () => {
    const response = await http("/orders/shipping-options");
    assert.equal(response.status, 200);
  });
  it("keeps one permanent reference across submissions and rejects payload/key reuse", async () => {
    const o = await fixture(),
      a = input(o.orderItems[0].id);
    const first = await submitReturns(o.id, customer.id, a);
    const retry = await submitReturns(o.id, customer.id, a);
    assert.equal(retry.submissions.length, 1);
    const second = await submitReturns(
      o.id,
      customer.id,
      input(o.orderItems[1].id),
    );
    assert.equal(first.reference, second.reference);
    assert.equal(second.submissions.length, 2);
    assert.equal(
      await prisma.returnCase.count({ where: { orderId: o.id } }),
      1,
    );
    await assert.rejects(
      submitReturns(o.id, customer.id, {
        ...a,
        lines: [{ ...a.lines[0], quantity: 2 }],
      }),
      /IDEMPOTENCY_KEY_REUSED/,
    );
    assert.equal(
      (
        await prisma.orderItem.findUniqueOrThrow({
          where: { id: o.orderItems[0].id },
        })
      ).reservedReturnQuantity,
      1,
    );
  });
  it("serializes parallel requests and rolls an entire invalid submission back", async () => {
    const o = await fixture(),
      a = input(o.orderItems[0].id, 2);
    const results = await Promise.allSettled([
      submitReturns(o.id, customer.id, a),
      submitReturns(o.id, customer.id, input(o.orderItems[0].id, 2)),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(
      await prisma.returnCase.count({ where: { orderId: o.id } }),
      1,
    );
    await assert.rejects(
      submitReturns(o.id, customer.id, {
        idempotencyKey: randomUUID(),
        lines: [
          {
            orderItemId: o.orderItems[1].id,
            quantity: 1,
            reason: "CHANGE_OF_MIND",
          },
          {
            orderItemId: o.orderItems[2].id,
            quantity: 4,
            reason: "CHANGE_OF_MIND",
          },
        ],
      }),
    );
    assert.equal(
      (
        await prisma.orderItem.findUniqueOrThrow({
          where: { id: o.orderItems[1].id },
        })
      ).reservedReturnQuantity,
      0,
    );
    assert.equal(
      (await customerReturnCase(o.id, customer.id)).submissions.length,
      1,
    );
  });
  it("enforces customer ownership, ADMIN mutations, strict input and queue filtering", async () => {
    const o = await fixture();
    assert.equal((await http(`/orders/${o.id}/return-case`)).status, 401);
    assert.equal(
      (await http(`/orders/${o.id}/return-case`, other.token)).status,
      404,
    );
    assert.equal(
      (
        await http(
          `/orders/${o.id}/return-requests`,
          other.token,
          input(o.orderItems[0].id),
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await http(`/orders/${o.id}/return-requests`, customer.token, {
          ...input(o.orderItems[0].id),
          shippingPayer: "CUSTOMER",
        })
      ).status,
      400,
    );
    const r = await http(
      `/orders/${o.id}/return-requests`,
      customer.token,
      input(o.orderItems[0].id),
    );
    assert.equal(r.status, 201);
    const body = await r.json(),
      line = body.submissions[0].lines[0];
    assert.equal(line.shippingPayer, null);
    assert.equal(
      (
        await http(
          `/admin/returns/${o.id}/lines/${line.id}/authorize`,
          customer.token,
          authorization,
        )
      ).status,
      403,
    );
    const q = await http(
      "/admin/returns?status=REQUESTED&pageSize=2",
      admin.token,
    );
    assert.equal(q.status, 200);
    assert.ok((await q.json()).cases.length <= 2);
    assert.equal(
      (await http("/admin/returns?pageSize=101", admin.token)).status,
      400,
    );
    const view = await customerReturnCase(o.id, customer.id);
    assert.ok(!("customer" in view));
    assert.ok(!("receivedByUserId" in view.submissions[0].lines[0]));
  });
  it("authorizes independently, records physical receipt, inspects/restocks once and never refunds", async () => {
    const o = await fixture();
    let c = await submitReturns(
      o.id,
      customer.id,
      input(o.orderItems[0].id, 1, "DEFECTIVE"),
    );
    c = await submitReturns(o.id, customer.id, input(o.orderItems[1].id));
    const a = c.submissions[0].lines[0],
      b = c.submissions[1].lines[0],
      stock = await prisma.productListing.findUniqueOrThrow({
        where: { id: o.orderItems[0].productListingId },
      });
    await assert.rejects(
      returnAction(o.id, a.id, admin.id, "authorize", {
        ...authorization,
        shippingPayer: "CUSTOMER",
      }),
      /SELLER_POSTAGE_REQUIRED/,
    );
    await returnAction(o.id, a.id, admin.id, "authorize", authorization);
    await returnAction(o.id, a.id, admin.id, "authorize", authorization);
    assert.equal(
      await prisma.orderConfirmationJob.count({
        where: { eventKey: `return:${a.id}` },
      }),
      1,
    );
    await returnAction(o.id, b.id, admin.id, "reject", {
      ground: "OUTSIDE_CANCELLATION_PERIOD",
      note: "Delivery and notice dates checked; outside the applicable cancellation period.",
      rightsReviewed: true,
    });
    assert.equal(
      (
        await prisma.orderItem.findUniqueOrThrow({
          where: { id: o.orderItems[1].id },
        })
      ).reservedReturnQuantity,
      0,
    );
    const receivedAt = new Date(Date.now() - 1).toISOString();
    await returnAction(o.id, a.id, admin.id, "receive", {
      receivedAt,
      note: "Parcel checked into the stock room",
    });
    const line = await prisma.orderReturn.findUniqueOrThrow({
      where: { id: a.id },
    });
    assert.equal(line.receivedByUserId, admin.id);
    assert.equal(line.receiptNote, "Parcel checked into the stock room");
    assert.equal(line.receivedAt?.toISOString(), receivedAt);
    assert.equal(
      (
        await prisma.productListing.findUniqueOrThrow({
          where: { id: stock.id },
        })
      ).currentStock,
      stock.currentStock,
    );
    assert.equal(await prisma.refund.count({ where: { orderId: o.id } }), 0);
    await returnAction(o.id, a.id, admin.id, "inspect", {
      condition: "AS_NEW",
      restockQuantity: 1,
      inspectionNote: "Unopened replacement returned",
    });
    await returnAction(o.id, a.id, admin.id, "complete", {});
    await returnAction(o.id, a.id, admin.id, "complete", {});
    assert.equal(
      (
        await prisma.productListing.findUniqueOrThrow({
          where: { id: stock.id },
        })
      ).currentStock,
      stock.currentStock + 1,
    );
    assert.equal(
      await prisma.inventoryMovement.count({
        where: { listingId: stock.id, type: "ORDER_RETURN" },
      }),
      1,
    );
    assert.equal(await prisma.refund.count({ where: { orderId: o.id } }), 0);
    assert.equal(
      await prisma.operationalAudit.count({
        where: { orderId: o.id, kind: "RETURN_RECEIVE" },
      }),
      1,
    );
    assert.equal(
      (await customerReturnCase(o.id, customer.id)).submissions[1].lines[0]
        .status,
      "REJECTED",
    );
  });
  it("enables only new return notifications without claiming historical confirmation or dispatch jobs", async () => {
    const { businessFixture } = await import('./fixtures/orderConfirmation.fixture.js');
    const o = await fixture();
    const c = await submitReturns(o.id, customer.id, input(o.orderItems[0].id));
    const line = c.submissions[0].lines[0];
    await returnAction(o.id, line.id, admin.id, 'authorize', authorization);
    const job = await prisma.orderConfirmationJob.findUniqueOrThrow({ where: { eventKey: `return:${line.id}` } });
    const before = await prisma.orderConfirmationJob.findMany({ where: { type: { in: ['ORDER_CONFIRMATION','DISPATCH_CONFIRMATION'] } }, orderBy: { id:'asc' } });
    assert.ok(before.length, 'fixture must include unrelated durable jobs');
    const saved = { nodeEnv: process.env.NODE_ENV, order: config.ORDER_CONFIRMATION_EMAIL_ENABLED,
      dispatch: config.DISPATCH_CONFIRMATION_EMAIL_ENABLED, returns: config.RETURN_AUTHORIZATION_EMAIL_ENABLED,
      cutoff: config.RETURN_AUTHORIZATION_EMAIL_ACTIVE_FROM, business: config.ORDER_CONFIRMATION_BUSINESS_JSON };
    const capture = captureConfirmationTransport();
    try {
      process.env.NODE_ENV = 'development';
      config.ORDER_CONFIRMATION_EMAIL_ENABLED = false;
      config.DISPATCH_CONFIRMATION_EMAIL_ENABLED = false;
      config.RETURN_AUTHORIZATION_EMAIL_ENABLED = true;
      config.RETURN_AUTHORIZATION_EMAIL_ACTIVE_FROM = new Date(job.createdAt.getTime()-1000).toISOString();
      config.ORDER_CONFIRMATION_BUSINESS_JSON = JSON.stringify(businessFixture);
      // Injected in-memory transport exercises production channel filtering; never calls SES.
      const result = await runConfirmationBatch({ transport: { kind:'ses', send:capture.transport.send }, jobId:job.id });
      assert.equal(result.processed,1); assert.equal(capture.messages.length,1);
      await runConfirmationBatch({ transport: { kind:'ses', send:capture.transport.send }, jobId:job.id });
      assert.equal(capture.messages.length,1, 'sent return job is not replayed');
      assert.deepEqual(await prisma.orderConfirmationJob.findMany({ where: { type: { in: ['ORDER_CONFIRMATION','DISPATCH_CONFIRMATION'] } }, orderBy: { id:'asc' } }), before);
      assert.equal((await customerReturnCase(o.id,customer.id)).submissions[0].lines[0].status,'AUTHORIZED');
    } finally {
      process.env.NODE_ENV=saved.nodeEnv; config.ORDER_CONFIRMATION_EMAIL_ENABLED=saved.order;
      config.DISPATCH_CONFIRMATION_EMAIL_ENABLED=saved.dispatch; config.RETURN_AUTHORIZATION_EMAIL_ENABLED=saved.returns;
      config.RETURN_AUTHORIZATION_EMAIL_ACTIVE_FROM=saved.cutoff; config.ORDER_CONFIRMATION_BUSINESS_JSON=saved.business;
    }
  });
  it("uses the durable outbox and identical authorised account/email instructions", async () => {
    const o = await fixture(),
      c = await submitReturns(o.id, customer.id, input(o.orderItems[0].id));
    const line = c.submissions[0].lines[0];
    await returnAction(o.id, line.id, admin.id, "authorize", authorization);
    const job = await prisma.orderConfirmationJob.findUniqueOrThrow({
      where: { eventKey: `return:${line.id}` },
    });
    const capture = captureConfirmationTransport();
    const business = {
      legalName: "Colorful Life Ltd",
      registrationNumber: "08097729",
      registeredAddress: ["3 Hawthorne Drive", "S63 8NS"],
      fromEmail: "noreply@example.invalid",
      replyToEmail: "support@example.invalid",
      invoicePrefix: "CL",
      numberDigits: 6,
      approved: true,
      replyToMonitored: true,
      retentionPolicy: "Owner-approved retention schedule",
    };
    const result = await runConfirmationBatch({
      transport: capture.transport,
      business,
      jobId: job.id,
      types: ["RETURN_AUTHORIZATION"],
    });
    assert.equal(result.processed, 1);
    assert.equal(
      (
        await prisma.orderConfirmationJob.findUniqueOrThrow({
          where: { id: job.id },
        })
      ).state,
      "SENT",
    );
    assert.equal(capture.messages.length, 1);
    const { simpleParser } = await import("mailparser");
    const email = await simpleParser(capture.messages[0]);
    assert.ok(email.text?.includes(authorization.instructions));
    assert.ok(email.text?.includes(authorization.postageInstructions));
    assert.ok(email.text?.includes("S63 8NS"));
    assert.ok(email.text?.includes(c.reference!));
    const account = await customerReturnCase(o.id, customer.id);
    assert.deepEqual(
      account.submissions[0].lines[0].instructions,
      (job.source as Record<string, unknown>).instructions
        ? {
            address: (job.source as Record<string, unknown>).address,
            instructions: authorization.instructions,
            postageInstructions: authorization.postageInstructions,
            shippingPayer: "SELLER",
            reference: c.reference,
          }
        : null,
    );
  });
  it("cancels outstanding authorisations once, suppresses unsent mail and preserves fault claims", async () => {
    const o = await fixture(),
      c = await submitReturns(
        o.id,
        customer.id,
        input(o.orderItems[0].id, 1, "DEFECTIVE"),
      );
    const line = c.submissions[0].lines[0];
    await assert.rejects(
      returnAction(o.id, line.id, admin.id, "reject", {
        ground: "OUTSIDE_CANCELLATION_PERIOD",
        note: "Cannot use cancellation age alone for a fault claim",
        rightsReviewed: true,
      }),
      /FAULT_CLAIM_REQUIRES_INDEPENDENT_REVIEW/,
    );
    await returnAction(o.id, line.id, admin.id, "authorize", authorization);
    await Promise.all([
      returnAction(
        o.id,
        line.id,
        customer.id,
        "cancel",
        { note: "No longer returning" },
        true,
      ),
      returnAction(
        o.id,
        line.id,
        customer.id,
        "cancel",
        { note: "No longer returning" },
        true,
      ),
    ]);
    assert.equal(
      (
        await prisma.orderItem.findUniqueOrThrow({
          where: { id: o.orderItems[0].id },
        })
      ).reservedReturnQuantity,
      0,
    );
    const job = await prisma.orderConfirmationJob.findUniqueOrThrow({
      where: { eventKey: `return:${line.id}` },
    });
    const capture = captureConfirmationTransport();
    await runConfirmationBatch({
      transport: capture.transport,
      jobId: job.id,
      types: ["RETURN_AUTHORIZATION"],
    });
    assert.equal(capture.messages.length, 0);
    assert.equal(
      (
        await prisma.orderConfirmationJob.findUniqueOrThrow({
          where: { id: job.id },
        })
      ).state,
      "SUPPRESSED",
    );
  });
});
