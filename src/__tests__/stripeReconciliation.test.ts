import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { Decimal } from "@prisma/client/runtime/client";
import { prisma } from "../prisma/runtime.js";
import { PaymentProvider, PaymentStatus } from "../generated/prisma-client/enums.js";
import { config } from "../config/index.js";
import { readCustomerPaymentWindows } from "../domain/payments/customerPaymentWindow.js";
import { initializePaymentResolution, checkPaymentAdmission, journalNewPayment } from "../domain/payments/paymentResolutionService.js";
import { reconcileStripePaymentEvent, replayManagedStripeReceipts } from "../domain/payments/stripeReconciliationService.js";

const users: number[] = [], orders: number[] = [], payments: number[] = [];
afterEach(async () => { if (payments.length) await prisma.payment.deleteMany({ where: { id: { in: payments } } }); if (orders.length) await prisma.order.deleteMany({ where: { id: { in: orders } } }); if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } }); users.length = orders.length = payments.length = 0; });
async function fixture(expired = false) { const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, passwordHash: "hash", emailVerified: true } }); users.push(user.id); const order = await prisma.order.create({ data: { userId: user.id, status: expired ? "EXPIRED" : "PENDING", billingRecipientName: "C", billingLine1: "1 Street", billingCity: "London", billingPostcode: "SW1A 1AA", billingCountryCode: "GB", deliveryRecipientName: "C", deliveryLine1: "1 Street", deliveryCity: "London", deliveryPostcode: "SW1A 1AA", deliveryCountryCode: "GB", totalAmount: new Decimal("12.50") } }); orders.push(order.id); const payment = await prisma.payment.create({ data: { orderId: order.id, amount: new Decimal("12.50"), currency: "GBP", provider: PaymentProvider.STRIPE, providerReference: `pi_${randomUUID()}`, status: PaymentStatus.PROCESSING, idempotencyKey: `key-${randomUUID()}` } }); payments.push(payment.id); return { user, order, payment }; }
function event(paymentId: string, id = randomUUID(), type: "payment_intent.succeeded" | "payment_intent.payment_failed" | "payment_intent.canceled" = "payment_intent.succeeded", amount = 1250, currency = "gbp") { return { id, type, paymentIntentId: paymentId, amount, currency }; }

describe("Stripe reconciliation", () => {
  it("marks a matching success final and deduplicates delivery", async () => { const f = await fixture(); const e = event(f.payment.providerReference); assert.deepEqual(await reconcileStripePaymentEvent(e), { duplicate: false, handled: true }); const payment = await prisma.payment.findUnique({ where: { id: f.payment.id } }); assert.equal(payment?.status, "SUCCEEDED"); assert.ok(payment?.paidAt); assert.deepEqual(await reconcileStripePaymentEvent(e), { duplicate: true, handled: true }); });
  it("maps failures/cancellation without regressing success", async () => { const f = await fixture(); await reconcileStripePaymentEvent(event(f.payment.providerReference, randomUUID(), "payment_intent.payment_failed")); assert.equal((await prisma.payment.findUnique({ where: { id: f.payment.id } }))?.status, "FAILED"); const g = await fixture(); await reconcileStripePaymentEvent(event(g.payment.providerReference, randomUUID(), "payment_intent.canceled")); assert.equal((await prisma.payment.findUnique({ where: { id: g.payment.id } }))?.status, "CANCELED"); await reconcileStripePaymentEvent(event(g.payment.providerReference, randomUUID(), "payment_intent.succeeded")); await reconcileStripePaymentEvent(event(g.payment.providerReference, randomUUID(), "payment_intent.payment_failed")); assert.equal((await prisma.payment.findUnique({ where: { id: g.payment.id } }))?.status, "SUCCEEDED"); });
  it("does not finalize mismatched or unknown payments", async () => { const f = await fixture(); await reconcileStripePaymentEvent(event(f.payment.providerReference, randomUUID(), "payment_intent.succeeded", 999)); assert.equal((await prisma.payment.findUnique({ where: { id: f.payment.id } }))?.status, "PROCESSING"); assert.deepEqual(await reconcileStripePaymentEvent(event("pi_unknown")), { duplicate: false, handled: false }); });
  it("keeps expired orders expired while recording late success reconciliation", async () => { const f = await fixture(true); const lateId = randomUUID(); await reconcileStripePaymentEvent(event(f.payment.providerReference, lateId)); const order = await prisma.order.findUnique({ where: { id: f.order.id } }); const payment = await prisma.payment.findUnique({ where: { id: f.payment.id } }); const receipt = await prisma.paymentWebhookEvent.findFirst({ where: { providerEventId: lateId } }); assert.equal(order?.status, "EXPIRED"); assert.equal(payment?.status, "SUCCEEDED"); assert.equal(payment?.paidAt !== null, true); assert.ok(receipt); assert.match(receipt.processingError ?? "", /refund\/reconciliation/); });
});

// Same account/signing context, different application database: numeric IDs can collide.
for (const managed of [false, true]) {
  it(`does not adopt a foreign intent for a ${managed ? "MANAGED" : "LEGACY"} pending payment`, async () => {
    const f = await fixture();
    const key = `stripe-create-${randomUUID()}`;
    await prisma.payment.update({where:{id:f.payment.id},data:{providerReference:`pending:${key}`,idempotencyKey:key}});
    if (managed) await prisma.$transaction(async tx => {
      const previous = config.PAYMENT_RESOLUTION_ENABLED;
      config.PAYMENT_RESOLUTION_ENABLED = true;
      try { await initializePaymentResolution(tx, f.order); } finally { config.PAYMENT_RESOLUTION_ENABLED = previous; }
      await journalNewPayment(tx,await tx.payment.findUniqueOrThrow({where:{id:f.payment.id}}),"CREATE");
    });
    const attempt = await prisma.paymentAttempt.findFirst({where:{paymentId:f.payment.id}});
    const foreign = {...event(`pi_foreign_${randomUUID()}`),metadata:{orderId:String(f.order.id),...(attempt?{attemptId:String(attempt.id)}:{})}};
    assert.deepEqual(await reconcileStripePaymentEvent(foreign),{duplicate:false,handled:false});
    assert.equal((await prisma.payment.findUniqueOrThrow({where:{id:f.payment.id}})).providerReference,`pending:${key}`);
    assert.equal((await prisma.payment.findUniqueOrThrow({where:{id:f.payment.id}})).status,"PROCESSING");
    if (managed) await prisma.$transaction(tx => checkPaymentAdmission(tx,f.order.id));
    const window = await prisma.$transaction(tx => readCustomerPaymentWindows(tx,f.user.id,[f.order.id]));
    assert.notEqual(window.get(f.order.id)?.reason,"ADMISSION_UNAVAILABLE");
  });
}

for (const managed of [false, true]) {
  for (const variant of ["valid", "wrong-key", "wrong-attempt", "amount", "currency"] as const) {
    if (!managed && variant === "wrong-attempt") continue;
    it(`${managed ? "MANAGED" : "LEGACY"} early webhook ${variant} validates persisted ownership and finances`, async () => {
      const f = await fixture(); const key=`stripe-create-${randomUUID()}`;
      await prisma.payment.update({where:{id:f.payment.id},data:{providerReference:`pending:${key}`,idempotencyKey:key}});
      if (managed) {
        // Immutable financial ledgers stay in this disposable test database.
        payments.splice(payments.indexOf(f.payment.id),1);orders.splice(orders.indexOf(f.order.id),1);users.splice(users.indexOf(f.user.id),1);
        const previous=config.PAYMENT_RESOLUTION_ENABLED;config.PAYMENT_RESOLUTION_ENABLED=true;
        try {await prisma.$transaction(tx=>initializePaymentResolution(tx,f.order));}finally{config.PAYMENT_RESOLUTION_ENABLED=previous;}
        await prisma.$transaction(async tx=>journalNewPayment(tx,await tx.payment.findUniqueOrThrow({where:{id:f.payment.id}}),"CREATE"));
      }
      const attempt=await prisma.paymentAttempt.findFirst({where:{paymentId:f.payment.id}});
      const e={...event(`pi_${randomUUID()}`),metadata:{orderId:String(f.order.id),paymentKey:variant==="wrong-key"?`stripe-create-${randomUUID()}`:key,...(attempt?{attemptId:String(variant==="wrong-attempt"?attempt.id+1:attempt.id)}:{})},
        amount:variant==="amount"?1200:1250,currency:variant==="currency"?"usd":"gbp"};
      assert.equal((await reconcileStripePaymentEvent(e)).handled,variant==="valid");
      const payment=await prisma.payment.findUniqueOrThrow({where:{id:f.payment.id}});
      assert.equal(payment.status,variant==="valid"?"SUCCEEDED":"PROCESSING");
      assert.equal(payment.providerReference,variant==="valid"?e.paymentIntentId:`pending:${key}`);
      if(variant==="valid") assert.equal((await reconcileStripePaymentEvent(e)).duplicate,true);
    });
  }
}
it("a foreign event completes without waiting for the metadata-matching order lock", async () => {
  const f=await fixture();let processing:ReturnType<typeof reconcileStripePaymentEvent>|undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const result=await prisma.$transaction(async tx=>{
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${f.order.id} FOR UPDATE`;
    processing=reconcileStripePaymentEvent({...event(`pi_foreign_${randomUUID()}`),metadata:{orderId:String(f.order.id)}});
    try{return await Promise.race([processing,new Promise<"blocked"> (resolve=>{timer=setTimeout(()=>resolve("blocked"),1500);})]);}finally{clearTimeout(timer);}
  });
  await processing;
  assert.deepEqual(result,{duplicate:false,handled:false});
});

it("receipt replay retains a mismatched creation key and cannot bypass ownership validation",async()=>{
 const f=await fixture();const key=`stripe-create-${randomUUID()}`;
 await prisma.payment.update({where:{id:f.payment.id},data:{idempotencyKey:key}});
 const rejected={...event(f.payment.providerReference),metadata:{orderId:String(f.order.id),paymentKey:`stripe-create-${randomUUID()}`}};
 assert.equal((await reconcileStripePaymentEvent(rejected)).handled,false);
 await prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${f.order.id} FOR UPDATE`;await replayManagedStripeReceipts(tx,f.order.id,f.payment.providerReference);});
 assert.equal((await prisma.payment.findUniqueOrThrow({where:{id:f.payment.id}})).status,"PROCESSING");
});
