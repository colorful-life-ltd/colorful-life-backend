import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { Decimal } from "@prisma/client/runtime/client";
import { randomUUID } from "node:crypto";
import { prisma } from "../prisma/runtime.js";
import { createOrReuseStripePaymentIntent, StripePaymentExpiredError, StripePaymentOwnershipError } from "../domain/payments/stripePaymentService.js";

const users: number[] = [], orders: number[] = [];
afterEach(async () => { if (orders.length) await prisma.order.deleteMany({ where: { id: { in: orders } } }); if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } }); orders.length = users.length = 0; });
async function order(total = "12.50", expires?: Date) { const u = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, passwordHash: "hash", emailVerified: true } }); users.push(u.id); const o = await prisma.order.create({ data: { userId: u.id, billingRecipientName: "Customer", billingLine1: "1 Main Street", billingCity: "London", billingPostcode: "SW1A 1AA", billingCountryCode: "GB", deliveryRecipientName: "Customer", deliveryLine1: "1 Main Street", deliveryCity: "London", deliveryPostcode: "SW1A 1AA", deliveryCountryCode: "GB", totalAmount: new Decimal(total), reservationExpiresAt: expires } }); orders.push(o.id); return { u, o }; }
function fake(status: string = "requires_payment_method") { let creates = 0; let lastParams: any; return { client: { paymentIntents: { create: async (params: any) => { creates++; lastParams = params; assert.equal(params.amount, 1250); assert.equal(params.currency, "gbp"); assert.match(params.metadata.orderId, /^\d+$/); return { ...lastParams, id: "pi_test", client_secret: "secret_test", status }; }, retrieve: async () => ({ ...lastParams, id: "pi_test", client_secret: "secret_test", status }) } } as any, count: () => creates }; }

describe("Stripe PaymentIntent service", () => {
  it("derives GBP minor units, metadata, and persists a processing Stripe payment", async () => { const f = await order(); const stripe = fake(); const result = await createOrReuseStripePaymentIntent(f.o.id, f.u.id, stripe.client); assert.equal(result.clientSecret, "secret_test"); const payment = await prisma.payment.findUnique({ where: { orderId: f.o.id } }); assert.equal(payment?.provider, "STRIPE"); assert.equal(payment?.status, "PROCESSING"); assert.equal(payment?.providerReference, "pi_test"); assert.match(payment!.idempotencyKey!, /^stripe-create-[0-9a-f-]{36}$/); });
  it("reuses an existing Stripe attempt without creating another provider object", async () => { const f = await order(); const stripe = fake(); const first = await createOrReuseStripePaymentIntent(f.o.id, f.u.id, stripe.client); const second = await createOrReuseStripePaymentIntent(f.o.id, f.u.id, stripe.client); assert.equal(first.providerReference, second.providerReference); assert.equal(stripe.count(), 1); assert.equal(await prisma.payment.count({ where: { orderId: f.o.id } }), 1); });
  it("does not finalize local payment when initiation reports succeeded", async () => { const f = await order(); const stripe = fake("succeeded"); await createOrReuseStripePaymentIntent(f.o.id, f.u.id, stripe.client); const payment = await prisma.payment.findUnique({ where: { orderId: f.o.id } }); assert.equal(payment?.status, "PROCESSING"); assert.equal(payment?.paidAt, null); });
  it("rejects expired orders and other customers", async () => { const f = await order("12.50", new Date(Date.now() - 1000)); await assert.rejects(() => createOrReuseStripePaymentIntent(f.o.id, f.u.id, fake().client), StripePaymentExpiredError); const other = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, passwordHash: "hash" } }); users.push(other.id); await assert.rejects(() => createOrReuseStripePaymentIntent(f.o.id, other.id, fake().client), StripePaymentOwnershipError); });
});

it("does not bind or expose a create response from a colliding foreign environment", async () => {
  const f=await order();const stripe=fake();
  stripe.client.paymentIntents.create=async()=>({id:"pi_foreign",amount:1250,currency:"gbp",metadata:{orderId:String(f.o.id),paymentKey:`stripe-create-${randomUUID()}`},client_secret:"foreign_secret",status:"requires_payment_method"});
  await assert.rejects(createOrReuseStripePaymentIntent(f.o.id,f.u.id,stripe.client));
  const payment=await prisma.payment.findUniqueOrThrow({where:{orderId:f.o.id}});
  assert.match(payment.providerReference,/^pending:stripe-create-/);assert.equal(payment.paidAt,null);
});
it("does not redispatch a legacy predictable pending key or invent a replacement", async () => {
  const f=await order();const key=`order-${f.o.id}-stripe`;
  await prisma.payment.create({data:{orderId:f.o.id,amount:12.50,provider:"STRIPE",providerReference:`pending:${key}`,idempotencyKey:key}});
  const stripe=fake();await assert.rejects(createOrReuseStripePaymentIntent(f.o.id,f.u.id,stripe.client));assert.equal(stripe.count(),0);
  assert.equal((await prisma.payment.findUniqueOrThrow({where:{orderId:f.o.id}})).providerReference,`pending:${key}`);
});

it("a stale provider response cannot bind over a newer locally persisted payment attempt", async () => {
  const f=await order();let started!:()=>void,release!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;});const gate=new Promise<void>(resolve=>{release=resolve;});
  const client={paymentIntents:{create:async(input:unknown)=>{started();await gate;return {...input as object,id:"pi_stale",client_secret:"stale_secret",status:"requires_payment_method"};}}} as any;
  const operation=createOrReuseStripePaymentIntent(f.o.id,f.u.id,client);const rejected=assert.rejects(operation);
  await entered;const key=`stripe-retry-${randomUUID()}`;
  await prisma.payment.update({where:{orderId:f.o.id},data:{idempotencyKey:key,providerReference:`pending:${key}`}});
  release();await rejected;
  assert.equal((await prisma.payment.findUniqueOrThrow({where:{orderId:f.o.id}})).providerReference,`pending:${key}`);
});
