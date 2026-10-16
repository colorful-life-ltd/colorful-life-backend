import assert from "node:assert/strict";
import { before, after, it } from "node:test";
import { randomUUID } from "node:crypto";
import type Stripe from "stripe";
import { prisma } from "../prisma/runtime.js";
import { config } from "../config/index.js";
import { initializePaymentResolution, databaseNow, bindManagedProvider, PaymentAdmissionClosedError, PaymentResolutionUnavailableError, journalManagedRetrieval } from "../domain/payments/paymentResolutionService.js";
import { abandonPaymentReservation, resolvePaymentReservation, runPaymentResolutionSweep, type StripeResolutionClient } from "../domain/payments/stripeResolutionService.js";
import { createOrReuseStripePaymentIntent, type StripePaymentClient } from "../domain/payments/stripePaymentService.js";
import { recoverStripePayment } from "../domain/payments/stripePaymentRecoveryService.js";
import { reconcileStripePaymentEvent } from "../domain/payments/stripeReconciliationService.js";
import { expireOrderReservation } from "../domain/orders/orderExpiryService.js";
import { createPayment } from "../domain/payments/paymentService.js";
import { cancelOrder, cancelOrderByAdmin } from "../domain/orders/orderCancellationService.js";
import { InsufficientAvailableStockError } from "../domain/orders/orderErrors.js";
import { createOrder } from "../domain/orders/orderService.js";
import { createOrReusePayPalOrder } from "../domain/payments/paypalOrderService.js";
import { capturePayPalOrder } from "../domain/payments/paypalCaptureService.js";
import { reconcilePayPalWebhookEvent } from "../domain/payments/paypalReconciliationService.js";
import app from "../app.js";
import jwt from "jsonwebtoken";

const previous = config.PAYMENT_RESOLUTION_ENABLED;
let server: ReturnType<typeof app.listen>, base: string;
before(async () => { config.PAYMENT_RESOLUTION_ENABLED = true; server=app.listen(0); await new Promise<void>(r=>server.once("listening",r)); base=`http://127.0.0.1:${(server.address() as {port:number}).port}`; });
after(async () => {config.PAYMENT_RESOLUTION_ENABLED=previous;await new Promise<void>(r=>server.close(()=>r()));await prisma.$disconnect();});
// Keep isolated new fixtures; never delete historical business data or order #16964.
async function fixture(ageMinutes=0, orderId?: number) {
  const u=await prisma.user.create({data:{email:`${randomUUID()}@phase2b.test`,passwordHash:"fixture",emailVerified:true,
    addresses:{create:{recipientName:"Fixture",line1:"Fixture",city:"Fixture",postcode:"T1",countryCode:"GB",isDefaultBilling:true}}}});
  const product=await prisma.legoProduct.create({data:{setNumber:randomUUID(),title:"Resolution fixture",theme:"PHASE2B",ageRecommendation:"8+",pieceCount:1}});
  const listing=await prisma.productListing.create({data:{legoProductId:product.id,condition:"NEW",originalPrice:10,currentStock:2,reservedStock:2}});
  const createdAt=new Date((await prisma.$transaction(databaseNow)).getTime()-ageMinutes*60_000);
  const order=await prisma.$transaction(async tx=>{
    const o=await tx.order.create({data:{...(orderId === undefined ? {} : {id:orderId}),userId:u.id,totalAmount:20,createdAt,reservationExpiresAt:new Date(createdAt.getTime()+30*60_000),
      billingRecipientName:"Fixture",billingLine1:"Fixture",billingCity:"Fixture",billingPostcode:"T1",billingCountryCode:"GB",
      deliveryRecipientName:"Fixture",deliveryLine1:"Fixture",deliveryCity:"Fixture",deliveryPostcode:"T1",deliveryCountryCode:"GB",
      orderItems:{create:{productListingId:listing.id,quantity:2,unitPrice:10,lineTotal:20}}}});
    await initializePaymentResolution(tx,o);return o;
  });
  return {u,listing,order};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function intent(f:Fixture,status:Stripe.PaymentIntent.Status="requires_payment_method"):Stripe.PaymentIntent {
  return {id:`pi_${f.order.id}_${randomUUID()}`,status,amount:2000,amount_received:0,amount_capturable:0,currency:"gbp",metadata:{orderId:String(f.order.id)},client_secret:"fixture-only",last_payment_error:null} as unknown as Stripe.PaymentIntent;
}
async function admitted(f:Fixture,provider="STRIPE" as "STRIPE"|"PAYPAL",unbound=false) {
  const remote=intent(f);const r=await prisma.paymentResolution.findUniqueOrThrow({where:{orderId:f.order.id}});const at=new Date(r.orderCreatedAt.getTime());
  const payment=await prisma.payment.create({data:{orderId:f.order.id,provider,status:"PROCESSING",providerReference:unbound?`pending:order-${f.order.id}-stripe`:remote.id,amount:20,currency:"GBP"}});
  const attempt=await prisma.paymentAttempt.create({data:{orderId:f.order.id,paymentId:payment.id,provider,amount:20,currency:"GBP",providerReference:unbound?null:remote.id,creationKey:randomUUID(),admittedAt:at}});
  for(const type of ["CREATE",provider==="STRIPE"?"CONFIRM":"CAPTURE"] as const){
    const op=await prisma.paymentOperation.create({data:{attemptId:attempt.id,type,operationKey:randomUUID(),requestHash:"a".repeat(64),admittedAt:at,admissionDeadline:r.initialPaymentDeadline}});
    await prisma.paymentOperation.update({where:{id:op.id},data:{state:"POTENTIALLY_DISPATCHED",executionCount:1}});
  }
  return {payment,attempt,remote};
}
function fake(remote:Stripe.PaymentIntent) {
  let current={...remote};let cancellations=0;
  const client={paymentIntents:{retrieve:async()=>current,cancel:async()=>{cancellations++;current={...current,status:"canceled"};return current;}}} as unknown as StripeResolutionClient;
  return {client,count:()=>cancellations,set:(value:Partial<Stripe.PaymentIntent>)=>{current={...current,...value};}};
}
async function state(f:Fixture){return {order:await prisma.order.findUniqueOrThrow({where:{id:f.order.id}}),resolution:await prisma.paymentResolution.findUniqueOrThrow({where:{orderId:f.order.id}}),stock:await prisma.productListing.findUniqueOrThrow({where:{id:f.listing.id}})};}
function deferred(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return {promise,release};}

it("explicit abandonment before initiation releases once, with no fabricated provider evidence",async()=>{
 const f=await fixture();await abandonPaymentReservation(f.order.id,f.u.id);const s=await state(f);
 assert.equal(s.stock.reservedStock,0);assert.equal(s.stock.currentStock,2);assert.equal(s.order.status,"CANCELLED");assert.equal(s.resolution.reservationDisposition,"RELEASED");
 const proof=await prisma.reservationReleaseProof.findUniqueOrThrow({where:{id:s.resolution.releaseProofId!}});assert.equal(proof.type,"NO_PAYMENT");assert.equal(proof.evidenceId,null);
 assert.equal(await prisma.paymentOperation.count({where:{attempt:{orderId:f.order.id}}}),0);assert.equal(await prisma.financialEvidence.count({where:{orderId:f.order.id}}),0);
 await assert.rejects(abandonPaymentReservation(f.order.id,f.u.id));assert.equal((await state(f)).stock.reservedStock,0);
});
it("initial expiry releases a no-payment reservation exactly once",async()=>{
 const f=await fixture(31);assert.ok(await expireOrderReservation(f.order.id));assert.equal(await expireOrderReservation(f.order.id),null);
 assert.equal((await state(f)).order.status,"EXPIRED");assert.equal((await state(f)).stock.reservedStock,0);
});
it("ownership and HTTP authentication guard abandonment",async()=>{
 const f=await fixture();await assert.rejects(abandonPaymentReservation(f.order.id,f.u.id+1));assert.equal((await state(f)).stock.reservedStock,2);
 assert.equal((await fetch(`${base}/orders/${f.order.id}/abandon`,{method:"POST"})).status,401);
 const token=jwt.sign({id:f.u.id,role:"CUSTOMER"},config.JWT_SECRET);assert.equal((await fetch(`${base}/orders/nope/abandon`,{method:"POST",headers:{Authorization:`Bearer ${token}`}})).status,400);
});
it("Stripe initiation journals before I/O and binding, and cannot be redispatched after a lost response",async()=>{
 const f=await fixture();let calls=0;
 const client={paymentIntents:{create:async()=>{calls++;assert.equal(await prisma.paymentOperation.count({where:{attempt:{orderId:f.order.id}}}),2);throw Error("timeout");}}} as unknown as StripePaymentClient;
 await assert.rejects(createOrReuseStripePaymentIntent(f.order.id,f.u.id,client));await assert.rejects(createOrReuseStripePaymentIntent(f.order.id,f.u.id,client),PaymentResolutionUnavailableError);assert.equal(calls,1);assert.equal((await state(f)).stock.reservedStock,2);
});
it("no new payment admission after the initial window",async()=>{
 const f=await fixture(31);await assert.rejects(createOrReuseStripePaymentIntent(f.order.id,f.u.id),PaymentAdmissionClosedError);assert.equal(await prisma.payment.count({where:{orderId:f.order.id}}),0);
});
it("unresolved payment prevents expiry and lazy expiry in another customer's checkout",async()=>{
 const f=await fixture(31);await admitted(f);assert.equal(await expireOrderReservation(f.order.id),null);
 await assert.rejects(createOrder(f.u.id,{ shippingMethod: "STANDARD" as const,items:[{productListingId:f.listing.id,quantity:1}]}));assert.equal((await state(f)).stock.reservedStock,2);
});
it("days-late first verified failure grants exactly 30m and duplicates cannot extend it",async()=>{
 const f=await fixture(3*24*60);const p=await admitted(f);
 const event={id:`event-${randomUUID()}`,type:"payment_intent.payment_failed" as const,paymentIntentId:p.remote.id,amount:2000,currency:"gbp",metadata:p.remote.metadata};
 const before=(await prisma.$transaction(databaseNow)).getTime();await reconcileStripePaymentEvent(event);const r=(await state(f)).resolution;
 assert.ok(r.firstFailureVerifiedAt!.getTime()>=before);assert.equal(r.retryDeadline!.getTime()-r.firstFailureVerifiedAt!.getTime(),30*60_000);
 await reconcileStripePaymentEvent(event);await reconcileStripePaymentEvent({...event,id:`event-${randomUUID()}`});assert.equal((await state(f)).resolution.retryDeadline!.getTime(),r.retryDeadline!.getTime());
 const provider=fake(p.remote);await resolvePaymentReservation(f.order.id,provider.client);assert.equal(provider.count(),0);assert.equal((await state(f)).stock.reservedStock,2);
});
it("retrieved verified failure opens retry before cancellation even after checkout deadline",async()=>{
 const f=await fixture(50);const p=await admitted(f);const provider=fake({...p.remote,last_payment_error:{code:"card_declined"}} as Stripe.PaymentIntent);
 await resolvePaymentReservation(f.order.id,provider.client);assert.equal(provider.count(),0);assert.ok((await state(f)).resolution.retryDeadline);assert.equal((await state(f)).stock.reservedStock,2);
});
it("successful retry consumes reserved and purchased stock exactly once",async()=>{
 const f=await fixture(50);const p=await admitted(f);
 await reconcileStripePaymentEvent({id:randomUUID(),type:"payment_intent.payment_failed",paymentIntentId:p.remote.id,amount:2000,currency:"gbp",metadata:p.remote.metadata});
 const provider={paymentIntents:{retrieve:async()=>p.remote}} as unknown as StripePaymentClient;
 assert.equal((await createOrReuseStripePaymentIntent(f.order.id,f.u.id,provider)).providerReference,p.remote.id);
 const event={id:randomUUID(),type:"payment_intent.succeeded" as const,paymentIntentId:p.remote.id,amount:2000,currency:"gbp",metadata:p.remote.metadata};
 await reconcileStripePaymentEvent(event);const paid=await prisma.payment.findUniqueOrThrow({where:{id:p.payment.id}});
 await reconcileStripePaymentEvent(event);await reconcileStripePaymentEvent({...event,id:randomUUID()});const s=await state(f);
 assert.equal(s.stock.currentStock,0);assert.equal(s.stock.reservedStock,0);assert.equal(s.order.status,"CONFIRMED");assert.equal(s.resolution.reservationDisposition,"CONSUMED");assert.equal((await prisma.payment.findUniqueOrThrow({where:{id:p.payment.id}})).paidAt!.getTime(),paid.paidAt!.getTime());
});
it("verified Stripe cancellation and full coverage release inventory once",async()=>{
 const f=await fixture(31);const p=await admitted(f);const provider=fake(p.remote);await resolvePaymentReservation(f.order.id,provider.client);await resolvePaymentReservation(f.order.id,provider.client);
 const s=await state(f);assert.equal(provider.count(),1);assert.equal(s.stock.reservedStock,0);assert.equal(s.stock.currentStock,2);assert.equal(s.resolution.reservationDisposition,"RELEASED");
 const proof=await prisma.reservationReleaseProof.findUniqueOrThrow({where:{id:s.resolution.releaseProofId!}});assert.equal(proof.type,"PROVIDER_FINALITY");assert.equal(await prisma.paymentOperation.count({where:{attemptId:p.attempt.id,state:{not:"RESULT_RECORDED"}}}),0);
 await assert.rejects(createOrReuseStripePaymentIntent(f.order.id,f.u.id),PaymentAdmissionClosedError);
});
it("cancel timeout retains stock until authenticated retrieval proves canceled",async()=>{
 const f=await fixture(31);const p=await admitted(f);let status:Stripe.PaymentIntent.Status="requires_payment_method";
 const client={paymentIntents:{retrieve:async()=>({...p.remote,status}),cancel:async()=>{status="canceled";throw Error("lost response");}}} as unknown as StripeResolutionClient;
 await resolvePaymentReservation(f.order.id,client);assert.equal((await state(f)).stock.reservedStock,2);assert.equal(await prisma.reservationReleaseProof.count({where:{orderId:f.order.id}}),0);
 await resolvePaymentReservation(f.order.id,client);assert.equal((await state(f)).stock.reservedStock,0);
});
it("processing, authorization awaiting capture, and mismatched identities retain stock",async()=>{
 for(const status of ["processing","requires_capture"] as const){const f=await fixture(31);const p=await admitted(f);const provider=fake({...p.remote,status,amount_capturable:status==="requires_capture"?2000:0});await resolvePaymentReservation(f.order.id,provider.client);assert.equal(provider.count(),0);assert.equal((await state(f)).stock.reservedStock,2);}
 const f=await fixture(31);const p=await admitted(f);const provider=fake({...p.remote,amount:2100});await resolvePaymentReservation(f.order.id,provider.client);assert.equal(provider.count(),0);assert.equal((await state(f)).stock.reservedStock,2);
});
it("independent concurrent resolution calls share a durable PostgreSQL lease",async()=>{
 const f=await fixture(31);const p=await admitted(f);const gate=deferred(),entered=deferred();let cancellations=0;let status:Stripe.PaymentIntent.Status="requires_payment_method";
 const client={paymentIntents:{retrieve:async()=>{entered.release();await gate.promise;return {...p.remote,status};},cancel:async()=>{cancellations++;status="canceled";return {...p.remote,status};}}} as unknown as StripeResolutionClient;
 const first=resolvePaymentReservation(f.order.id,client);await entered.promise;await resolvePaymentReservation(f.order.id,client);gate.release();await first;assert.equal(cancellations,1);assert.equal((await state(f)).stock.reservedStock,0);
});
it("webhook success racing cancellation wins without releasing purchased inventory",async()=>{
 const f=await fixture(31);const p=await admitted(f);const gate=deferred(),entered=deferred();
 const client={paymentIntents:{retrieve:async()=>p.remote,cancel:async()=>{entered.release();await gate.promise;throw Error("already succeeded");}}} as unknown as StripeResolutionClient;
 const resolution=resolvePaymentReservation(f.order.id,client);await entered.promise;
 await reconcileStripePaymentEvent({id:randomUUID(),type:"payment_intent.succeeded",paymentIntentId:p.remote.id,amount:2000,currency:"gbp",metadata:p.remote.metadata});gate.release();await resolution;
 const s=await state(f);assert.equal(s.order.status,"CONFIRMED");assert.equal(s.stock.currentStock,0);assert.equal(s.resolution.reservationDisposition,"CONSUMED");assert.equal(await prisma.reservationReleaseProof.count({where:{orderId:f.order.id}}),0);
});
it("manual success preserves payment and prevents ordinary customer/seller cancellation",async()=>{
 const f=await fixture();await createPayment(f.order.id,{providerReference:randomUUID()});assert.equal((await state(f)).resolution.state,"PAID");
 await assert.rejects(cancelOrder(f.u.id,f.order.id,"CHANGED_MIND"));await assert.rejects(cancelOrderByAdmin(f.order.id,"OUT_OF_STOCK",f.u.id));assert.equal((await state(f)).stock.reservedStock,2);
});
it("PayPal denial opens retry but unknown order finality retains stock and prevents competing capture",async()=>{
 const f=await fixture();const ppId=`PP-${randomUUID()}`;await createOrReusePayPalOrder(f.order.id,f.u.id,{createOrder:async()=>({id:ppId})});
 let calls=0;await assert.rejects(capturePayPalOrder(f.order.id,f.u.id,{captureOrder:async()=>{calls++;throw Error("timeout");}}));
 await reconcilePayPalWebhookEvent({id:randomUUID(),eventType:"PAYMENT.CAPTURE.DENIED",captureId:`CAP-${randomUUID()}`,paypalOrderId:ppId,amount:"20.00",currency:"GBP"});
 assert.ok((await state(f)).resolution.retryDeadline);await assert.rejects(capturePayPalOrder(f.order.id,f.u.id,{captureOrder:async()=>{calls++;throw Error("must not run");}}));assert.equal(calls,1);
 await abandonPaymentReservation(f.order.id,f.u.id);assert.equal((await state(f)).stock.reservedStock,2);assert.equal((await state(f)).resolution.state,"SAFETY_HOLD");
});
it("database refuses a no-payment proof with an uncovered compatibility payment",async()=>{
 const f=await fixture(31);await prisma.payment.create({data:{orderId:f.order.id,provider:"STRIPE",status:"FAILED",providerReference:`pi_${randomUUID()}`,amount:20}});
 await assert.rejects(prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${f.order.id} FOR UPDATE`;await tx.paymentResolution.update({where:{orderId:f.order.id},data:{state:"CLOSED_RESOLVING",paymentAdmissionClosedAt:new Date(),closureReason:"WINDOW_EXPIRED"}});await tx.reservationReleaseProof.create({data:{orderId:f.order.id,type:"NO_PAYMENT",decisionVersion:1,coverage:{attempts:[],operations:[]}}});}),error=>String(error).includes("No-payment proof has financial activity"));
 assert.equal((await state(f)).stock.reservedStock,2);assert.equal((await state(f)).resolution.paymentAdmissionClosedAt,null);
});
it("database refuses missing provider operation coverage and successful evidence release",async()=>{
 const f=await fixture(31);const p=await admitted(f);
 await assert.rejects(prisma.$transaction(async tx=>{await tx.paymentResolution.update({where:{orderId:f.order.id},data:{state:"CLOSED_RESOLVING",paymentAdmissionClosedAt:new Date(),closureReason:"WINDOW_EXPIRED"}});await tx.reservationReleaseProof.create({data:{orderId:f.order.id,type:"NO_PAYMENT",decisionVersion:1,coverage:{attempts:[p.attempt.id],operations:[]}}});}),error=>String(error).includes("Incomplete release coverage"));
 const provider=fake({...p.remote,status:"succeeded",amount_received:2000});await resolvePaymentReservation(f.order.id,provider.client);assert.equal(provider.count(),0);assert.equal((await state(f)).resolution.reservationDisposition,"CONSUMED");
});
it("historical quarantined orders cannot be automatically released or admitted to retry",async()=>{
 const f=await fixture(31);const previous=await prisma.paymentResolution.findUniqueOrThrow({where:{orderId:f.order.id}});await prisma.$transaction(async tx=>{await tx.paymentResolution.delete({where:{orderId:f.order.id}});await tx.paymentResolution.create({data:{orderId:f.order.id,orderCreatedAt:previous.orderCreatedAt,initialPaymentDeadline:previous.initialPaymentDeadline,state:"REVIEW_REQUIRED",historical:true,quarantineReason:"Fixture historical unknown"}});});
 await resolvePaymentReservation(f.order.id);assert.equal(await expireOrderReservation(f.order.id),null);assert.equal((await state(f)).stock.reservedStock,2);await assert.rejects(abandonPaymentReservation(f.order.id,f.u.id));
});
it("permanently abandoned payment does not reopen on a late first failure",async()=>{
 const f=await fixture();const p=await admitted(f);const provider=fake({...p.remote,status:"processing"});await abandonPaymentReservation(f.order.id,f.u.id,provider.client);
 await reconcileStripePaymentEvent({id:randomUUID(),type:"payment_intent.payment_failed",paymentIntentId:p.remote.id,amount:2000,currency:"gbp",metadata:p.remote.metadata});assert.equal((await state(f)).resolution.retryDeadline,null);assert.equal((await state(f)).stock.reservedStock,2);
});

it("failures at minute 5 and 29 receive the same full independent retry duration",async()=>{
 for(const age of [5,29]){const f=await fixture(age);const p=await admitted(f);await reconcileStripePaymentEvent({id:randomUUID(),type:"payment_intent.payment_failed",paymentIntentId:p.remote.id,amount:2000,currency:"gbp",metadata:p.remote.metadata});const r=(await state(f)).resolution;assert.equal(r.retryDeadline!.getTime()-r.firstFailureVerifiedAt!.getTime(),30*60_000);assert.ok(r.retryDeadline!>r.initialPaymentDeadline || age===5);}
});
it("expired retry requires finality, then release, without resetting first-failure history",async()=>{
 const f=await fixture(90);const p=await admitted(f);const verified=new Date((await prisma.$transaction(databaseNow)).getTime()-31*60_000);
 await prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${f.order.id} FOR UPDATE`;
  const op=await tx.paymentOperation.findFirstOrThrow({where:{attemptId:p.attempt.id,type:"CONFIRM"}});
  const evidence=await tx.financialEvidence.create({data:{orderId:f.order.id,provider:"STRIPE",evidenceKey:randomUUID(),kind:"FAILURE",operationId:op.id,verifiedAt:verified,normalized:{providerReference:p.remote.id}}});
  await tx.paymentOperation.update({where:{id:op.id},data:{state:"RESULT_RECORDED",evidenceId:evidence.id}});
  await tx.paymentResolution.update({where:{orderId:f.order.id},data:{state:"RETRY_OPEN",firstFailureVerifiedAt:verified,retryDeadline:new Date(verified.getTime()+30*60_000),firstFailureOperationId:op.id,firstFailureEvidenceId:evidence.id}});
 });
 assert.equal(await expireOrderReservation(f.order.id),null);assert.equal((await state(f)).stock.reservedStock,2);
 const provider=fake(p.remote);await resolvePaymentReservation(f.order.id,provider.client);const s=await state(f);assert.equal(s.stock.reservedStock,0);assert.equal(s.resolution.firstFailureVerifiedAt!.getTime(),verified.getTime());assert.equal(provider.count(),1);
});
it("expired worker lease can be reclaimed and the stale worker is fenced",async()=>{
 const f=await fixture(31);const p=await admitted(f);const entered=deferred(),gate=deferred();let oldCalls=0;
 const slow={paymentIntents:{retrieve:async()=>{entered.release();await gate.promise;return p.remote;},cancel:async()=>{oldCalls++;return {...p.remote,status:"canceled"};}}} as unknown as StripeResolutionClient;
 const first=resolvePaymentReservation(f.order.id,slow);await entered.promise;
 const operation=await prisma.paymentOperation.findFirstOrThrow({where:{attemptId:p.attempt.id,type:"RETRIEVE",claimOwner:{not:null}}});
 await prisma.paymentOperation.update({where:{id:operation.id},data:{leaseExpiresAt:new Date((await prisma.$transaction(databaseNow)).getTime()-1000)}});
 const recovered=fake(p.remote);await resolvePaymentReservation(f.order.id,recovered.client);gate.release();await first;
 assert.equal(oldCalls,0);assert.equal(recovered.count(),1);assert.equal((await state(f)).stock.reservedStock,0);
});
it("abandonment racing provider initiation keeps binding durable but withholds the client secret",async()=>{
 const f=await fixture();const remote=intent(f);const entered=deferred(),gate=deferred();
 const client={paymentIntents:{create:async(input:{metadata:Record<string,string>})=>{entered.release();await gate.promise;return {...remote,metadata:input.metadata};}}} as unknown as StripePaymentClient;
 const create=createOrReuseStripePaymentIntent(f.order.id,f.u.id,client);const rejected=assert.rejects(create,PaymentAdmissionClosedError);await entered.promise;
 await abandonPaymentReservation(f.order.id,f.u.id);gate.release();await rejected;
 assert.equal((await prisma.payment.findUniqueOrThrow({where:{orderId:f.order.id}})).providerReference,remote.id);
 assert.equal((await state(f)).stock.reservedStock,2);const provider=fake(remote);await resolvePaymentReservation(f.order.id,provider.client);assert.equal((await state(f)).stock.reservedStock,0);
});
it("database rejects cross-order release proofs and relevant unresolved provider evidence",async()=>{
 const a=await fixture(31);await expireOrderReservation(a.order.id);const proof=(await state(a)).resolution.releaseProofId!;const b=await fixture(31);
 await assert.rejects(prisma.$transaction(async tx=>{await tx.paymentResolution.update({where:{orderId:b.order.id},data:{state:"CLOSED_RESOLVING",paymentAdmissionClosedAt:await databaseNow(tx),closureReason:"WINDOW_EXPIRED"}});await tx.paymentResolution.update({where:{orderId:b.order.id},data:{state:"RELEASED",reservationDisposition:"RELEASED",releaseProofId:proof}});}),error=>String(error).includes("23514"));
 const p=await admitted(b);
 await prisma.paymentWebhookEvent.create({data:{provider:"STRIPE",providerEventId:randomUUID(),eventType:"payment_intent.succeeded",evidence:{orderId:String(b.order.id),paymentIntentId:p.remote.id}}});
 assert.equal(await expireOrderReservation(b.order.id),null);assert.equal((await state(b)).stock.reservedStock,2);
});
it("PayPal provider lookup recovers late success but preserves paid-but-unconfirmed behavior",async()=>{
 const f=await fixture(31);const p=await admitted(f,"PAYPAL");
 const {resolvePayPalPaymentOutcome}=await import("../domain/payments/paypalResolutionService.js");
 const captureId=`CAP-${randomUUID()}`;
 await resolvePayPalPaymentOutcome(f.order.id,{retrieveOrder:async()=>({id:p.remote.id,status:"COMPLETED",purchase_units:[{payments:{captures:[{id:captureId,status:"COMPLETED",amount:{value:"20.00",currency_code:"GBP"}}]}}]})});
 const payment=await prisma.payment.findUniqueOrThrow({where:{id:p.payment.id}});assert.equal(payment.status,"SUCCEEDED");assert.ok(payment.paidAt);assert.equal(payment.providerCaptureReference,captureId);
 const s=await state(f);assert.equal(s.order.status,"PENDING");assert.equal(s.resolution.state,"PAID");assert.equal(s.stock.currentStock,2);assert.equal(s.stock.reservedStock,2);
});

it("resolution projection is customer-owned and excludes provider identities and proof data",async()=>{
 const f=await fixture();const token=jwt.sign({id:f.u.id,role:"CUSTOMER"},config.JWT_SECRET);
 const response=await fetch(`${base}/orders/${f.order.id}/payment-resolution`,{headers:{Authorization:`Bearer ${token}`}});assert.equal(response.status,200);
 const body=await response.json() as {paymentResolution:Record<string,unknown>};assert.deepEqual(Object.keys(body.paymentResolution).sort(),["state","reservationDisposition","initialPaymentDeadline","firstFailureVerifiedAt","retryDeadline","paymentAdmissionClosedAt"].sort());
 const other=await fixture();const otherToken=jwt.sign({id:other.u.id,role:"CUSTOMER"},config.JWT_SECRET);
 assert.equal((await fetch(`${base}/orders/${f.order.id}/payment-resolution`,{headers:{Authorization:`Bearer ${otherToken}`}})).status,404);
});

it("late failures cannot regress a verified canceled payment or reopen released stock",async()=>{
 const f=await fixture(31);const p=await admitted(f);const provider=fake(p.remote);await resolvePaymentReservation(f.order.id,provider.client);
 await reconcileStripePaymentEvent({id:randomUUID(),type:"payment_intent.payment_failed",paymentIntentId:p.remote.id,amount:2000,currency:"gbp",metadata:p.remote.metadata});
 assert.equal((await prisma.payment.findUniqueOrThrow({where:{id:p.payment.id}})).status,"CANCELED");assert.equal((await state(f)).resolution.retryDeadline,null);assert.equal((await state(f)).stock.reservedStock,0);
});
it("seller cancellation without payment retains its initiator and immediate release proof",async()=>{
 const f=await fixture();const order=await cancelOrderByAdmin(f.order.id,"OUT_OF_STOCK",f.u.id);
 assert.equal(order.cancelledBy,"SELLER");assert.equal(order.cancellationReason,"OUT_OF_STOCK");assert.equal((await state(f)).resolution.closureReason,"SELLER_CANCELLED");assert.equal((await state(f)).stock.reservedStock,0);
});

it("quarantined historical late success records financial evidence without automatic fulfillment",async()=>{
 const f=await fixture(31);const r=(await state(f)).resolution;
 await prisma.$transaction(async tx=>{await tx.paymentResolution.delete({where:{orderId:f.order.id}});await tx.paymentResolution.create({data:{orderId:f.order.id,orderCreatedAt:r.orderCreatedAt,initialPaymentDeadline:r.initialPaymentDeadline,state:"REVIEW_REQUIRED",historical:true,quarantineReason:"Unknown historical reservation"}});});
 const remote=intent(f);const p=await prisma.payment.create({data:{orderId:f.order.id,provider:"STRIPE",status:"PROCESSING",providerReference:remote.id,amount:20}});
 const event={id:randomUUID(),type:"payment_intent.succeeded" as const,paymentIntentId:remote.id,amount:2000,currency:"gbp",metadata:remote.metadata};
 await reconcileStripePaymentEvent(event);const paid=await prisma.payment.findUniqueOrThrow({where:{id:p.id}});assert.equal(paid.status,"SUCCEEDED");assert.ok(paid.paidAt);
 const s=await state(f);assert.equal(s.order.status,"PENDING");assert.equal(s.stock.currentStock,2);assert.equal(s.stock.reservedStock,2);assert.equal(s.resolution.state,"REVIEW_REQUIRED");
 const receipt=await prisma.paymentWebhookEvent.findUniqueOrThrow({where:{provider_providerEventId:{provider:"STRIPE",providerEventId:event.id}}});assert.match(receipt.processingError!,/historical or incomplete/);assert.ok(receipt.evidence);
});
it("unknown historical admission cannot open a retry window",async()=>{
 const f=await fixture(31);const r=(await state(f)).resolution;
 await prisma.$transaction(async tx=>{await tx.paymentResolution.delete({where:{orderId:f.order.id}});await tx.paymentResolution.create({data:{orderId:f.order.id,orderCreatedAt:r.orderCreatedAt,initialPaymentDeadline:r.initialPaymentDeadline,state:"REVIEW_REQUIRED",historical:true,quarantineReason:"Unknown admission"}});});
 const remote=intent(f);const p=await prisma.payment.create({data:{orderId:f.order.id,provider:"STRIPE",status:"PROCESSING",providerReference:remote.id,amount:20}});
 const a=await prisma.paymentAttempt.create({data:{orderId:f.order.id,paymentId:p.id,provider:"STRIPE",amount:20,currency:"GBP",providerReference:remote.id,historical:true}});
 await prisma.paymentOperation.create({data:{attemptId:a.id,type:"CONFIRM",operationKey:randomUUID(),historical:true,state:"UNKNOWN"}});
 await reconcileStripePaymentEvent({id:randomUUID(),type:"payment_intent.payment_failed",paymentIntentId:remote.id,amount:2000,currency:"gbp",metadata:remote.metadata});assert.equal((await state(f)).resolution.retryDeadline,null);assert.equal((await state(f)).stock.reservedStock,2);
 await assert.rejects(createOrReuseStripePaymentIntent(f.order.id,f.u.id),PaymentResolutionUnavailableError);
});

it("early uncorrelated Stripe failure is replayed after binding and preserves the retry opportunity",async()=>{
 const f=await fixture(50);const p=await admitted(f,"STRIPE",true);const event={id:randomUUID(),type:"payment_intent.payment_failed" as const,paymentIntentId:p.remote.id,amount:2000,currency:"gbp"};
 assert.equal((await reconcileStripePaymentEvent(event)).handled,false);
 await prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${f.order.id} FOR UPDATE`;await bindManagedProvider(tx,p.payment.id,p.remote.id);await tx.payment.update({where:{id:p.payment.id},data:{providerReference:p.remote.id}});});
 const provider=fake({...p.remote,status:"canceled"});await resolvePaymentReservation(f.order.id,provider.client);
 const s=await state(f);assert.ok(s.resolution.firstFailureVerifiedAt);assert.equal(s.resolution.retryDeadline!.getTime()-s.resolution.firstFailureVerifiedAt!.getTime(),30*60_000);assert.equal(s.stock.reservedStock,2);assert.equal(s.resolution.paymentAdmissionClosedAt,null);
 const receipt=await prisma.paymentWebhookEvent.findUniqueOrThrow({where:{provider_providerEventId:{provider:"STRIPE",providerEventId:event.id}}});assert.equal(receipt.processingError,null);
 const replacement=intent(f);let metadata:Record<string,string>={};
 const client={paymentIntents:{create:async(input:{metadata:Record<string,string>})=>{metadata=input.metadata;return {...replacement,metadata};}}} as unknown as StripePaymentClient;
 assert.equal((await createOrReuseStripePaymentIntent(f.order.id,f.u.id,client)).providerReference,replacement.id);
 assert.equal(await prisma.paymentAttempt.count({where:{orderId:f.order.id}}),2);
 await reconcileStripePaymentEvent({id:randomUUID(),type:"payment_intent.succeeded",paymentIntentId:replacement.id,amount:2000,currency:"gbp",metadata});
 assert.equal((await state(f)).stock.currentStock,0);assert.equal((await state(f)).resolution.reservationDisposition,"CONSUMED");
});
it("unrecognized or mismatched durable financial evidence blocks otherwise canceled-object release",async()=>{
 const f=await fixture(31);const p=await admitted(f);
 await prisma.paymentWebhookEvent.create({data:{provider:"STRIPE",providerEventId:randomUUID(),eventType:"payment_intent.payment_failed",processedAt:new Date(),processingError:"Unknown provider evidence",evidence:{version:1,paymentIntentId:p.remote.id,amount:999,currency:"gbp"}}});
 const provider=fake({...p.remote,status:"canceled"});await resolvePaymentReservation(f.order.id,provider.client);
 assert.equal((await state(f)).stock.reservedStock,2);assert.equal(await prisma.reservationReleaseProof.count({where:{orderId:f.order.id}}),0);
});

it("verified first failure after terminal-unpaid observation still grants 30m while stock is held",async()=>{
 const f=await fixture(90);const p=await admitted(f);
 await prisma.paymentWebhookEvent.create({data:{provider:"STRIPE",providerEventId:randomUUID(),eventType:"payment_intent.payment_failed",processedAt:new Date(),processingError:"Inconclusive evidence",evidence:{version:1,paymentIntentId:p.remote.id,amount:999,currency:"gbp"}}});
 await resolvePaymentReservation(f.order.id,fake({...p.remote,status:"canceled"}).client);
 const a=await prisma.paymentAttempt.findUniqueOrThrow({where:{id:p.attempt.id}});assert.ok(a.finalityEvidenceId);assert.equal((await state(f)).resolution.retryDeadline,null);
 await reconcileStripePaymentEvent({id:randomUUID(),type:"payment_intent.payment_failed",paymentIntentId:p.remote.id,amount:2000,currency:"gbp",metadata:p.remote.metadata});
 const r=(await state(f)).resolution;assert.ok(r.firstFailureVerifiedAt);assert.equal(r.retryDeadline!.getTime()-r.firstFailureVerifiedAt!.getTime(),30*60_000);assert.equal(r.paymentAdmissionClosedAt,null);assert.equal((await state(f)).stock.reservedStock,2);
 await assert.rejects(createOrReuseStripePaymentIntent(f.order.id,f.u.id),PaymentResolutionUnavailableError);
});

it("managed inventory mismatch retains verified success and durable exception without silent fulfillment",async()=>{
 const f=await fixture();const p=await admitted(f);await prisma.productListing.update({where:{id:f.listing.id},data:{reservedStock:0}});
 const event={id:randomUUID(),type:"payment_intent.succeeded" as const,paymentIntentId:p.remote.id,amount:2000,currency:"gbp",metadata:p.remote.metadata};await reconcileStripePaymentEvent(event);
 const payment=await prisma.payment.findUniqueOrThrow({where:{id:p.payment.id}});assert.equal(payment.status,"SUCCEEDED");assert.ok(payment.paidAt);
 assert.equal((await state(f)).order.status,"PENDING");assert.equal((await state(f)).resolution.state,"PAID");assert.equal((await state(f)).stock.currentStock,2);
 const receipt=await prisma.paymentWebhookEvent.findUniqueOrThrow({where:{provider_providerEventId:{provider:"STRIPE",providerEventId:event.id}}});assert.match(receipt.processingError!,/manual inventory reconciliation/);assert.ok(await prisma.financialEvidence.findFirst({where:{orderId:f.order.id,kind:"SUCCESS"}}));
 await assert.rejects(abandonPaymentReservation(f.order.id,f.u.id));
 await assert.rejects(createOrder(f.u.id,{ shippingMethod: "STANDARD" as const,items:[{productListingId:f.listing.id,quantity:1}]}),InsufficientAvailableStockError);
});

it("release commit rechecks provider inbox evidence arriving after proof creation",async()=>{
 const f=await fixture(31);const p=await admitted(f);
 await assert.rejects(prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${f.order.id} FOR UPDATE`;
  const now=await databaseNow(tx);
  await tx.paymentResolution.update({where:{orderId:f.order.id},data:{state:"CLOSED_RESOLVING",paymentAdmissionClosedAt:now,closureReason:"WINDOW_EXPIRED"}});
  const ops=await tx.paymentOperation.findMany({where:{attemptId:p.attempt.id},orderBy:{id:"asc"}});let finalityId=0;
  for(const op of ops){
   const e=await tx.financialEvidence.create({data:{orderId:f.order.id,provider:"STRIPE",operationId:op.id,evidenceKey:randomUUID(),kind:"TERMINAL_UNPAID",verifiedAt:now,normalized:{providerReference:p.remote.id,providerStatus:"canceled",amountReceived:0,amountCapturable:0,amount:"20.00",currency:"GBP"}}});
   await tx.paymentOperation.update({where:{id:op.id},data:{state:"RESULT_RECORDED",evidenceId:e.id}});finalityId=e.id;
  }
  await tx.paymentAttempt.update({where:{id:p.attempt.id},data:{finalityEvidenceId:finalityId}});
  const proof=await tx.reservationReleaseProof.create({data:{orderId:f.order.id,type:"PROVIDER_FINALITY",evidenceId:finalityId,decisionVersion:1,coverage:{attempts:[p.attempt.id],operations:ops.map(op=>op.id)}}});
  await tx.paymentWebhookEvent.create({data:{provider:"STRIPE",providerEventId:randomUUID(),eventType:"payment_intent.succeeded",evidence:{paymentIntentId:p.remote.id}}});
  await tx.paymentResolution.update({where:{orderId:f.order.id},data:{state:"RELEASED",reservationDisposition:"RELEASED",releaseProofId:proof.id,dispositionAt:now}});
 }),/Relevant provider inbox evidence prohibits release/);
 assert.equal((await state(f)).resolution.reservationDisposition,"HELD");assert.equal((await state(f)).stock.reservedStock,2);
});

async function canceledDuringFailure(f:Fixture) {
 const p=await admitted(f);let status:Stripe.PaymentIntent.Status="requires_payment_method";
 const client={paymentIntents:{retrieve:async()=>({...p.remote,status}),cancel:async()=>{
  await reconcileStripePaymentEvent({id:randomUUID(),type:"payment_intent.payment_failed",paymentIntentId:p.remote.id,amount:2000,currency:"gbp",metadata:p.remote.metadata});
  status="canceled";return {...p.remote,status};}}} as unknown as StripeResolutionClient;
 await resolvePaymentReservation(f.order.id,client);return {...p,client};
}
it("owner reconciliation finalizes canceled reads without blocking an open retry",async()=>{
 const f=await fixture(31);const p=await canceledDuringFailure(f);const before=(await state(f)).resolution.retryDeadline!;
 await recoverStripePayment(f.order.id,f.u.id,p.client);await recoverStripePayment(f.order.id,f.u.id,p.client);
 assert.equal(await prisma.paymentOperation.count({where:{attemptId:p.attempt.id,state:{not:"RESULT_RECORDED"}}}),0);
 assert.equal((await state(f)).resolution.retryDeadline!.getTime(),before.getTime());
 const remote=intent(f);const client={paymentIntents:{create:async(input:{metadata:Record<string,string>})=>({...remote,metadata:input.metadata})}} as unknown as StripePaymentClient;
 assert.equal((await createOrReuseStripePaymentIntent(f.order.id,f.u.id,client)).providerReference,remote.id);
 assert.equal(await prisma.paymentAttempt.count({where:{orderId:f.order.id}}),2);assert.equal((await state(f)).stock.reservedStock,2);
});
it("a crashed owner read is recovered despite existing finality and an open retry",async()=>{
 const f=await fixture(31);const p=await canceledDuringFailure(f);const original=await prisma.paymentAttempt.findUniqueOrThrow({where:{id:p.attempt.id}});
 const read=await prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${f.order.id} FOR UPDATE`;return journalManagedRetrieval(tx,await tx.payment.findUniqueOrThrow({where:{id:p.payment.id}}));});
 await prisma.paymentOperation.update({where:{id:read!.id},data:{state:"UNKNOWN",claimOwner:"crashed-instance",leaseExpiresAt:new Date((await prisma.$transaction(databaseNow)).getTime()-1000)}});
 await resolvePaymentReservation(f.order.id,p.client);
 assert.equal((await prisma.paymentOperation.findUniqueOrThrow({where:{id:read!.id}})).state,"RESULT_RECORDED");
 assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({where:{id:p.attempt.id}})).finalityEvidenceId,original.finalityEvidenceId);
 assert.equal((await state(f)).stock.reservedStock,2);assert.equal((await state(f)).resolution.reservationDisposition,"HELD");
});
it("overdue incomplete coverage yields the next worker batch to releasable reservations",async()=>{
 // Negative fixture-only IDs put this isolated cohort ahead of prior retained test rows with NULL due time.
 const [minimum]=await prisma.$queryRaw<Array<{id:number}>>`SELECT COALESCE(MIN(id),0)::int AS id FROM "Order"`;
 const seed=Math.min(-1_000_000,minimum.id)-26;const blocked:Fixture[]=[];
 for(let i=0;i<25;i++){
  const f=await fixture(31,seed+i);const p=await admitted(f);
  await recoverStripePayment(f.order.id,f.u.id,fake({...p.remote,status:"canceled"}).client);
  await prisma.paymentAttempt.create({data:{orderId:f.order.id,paymentId:p.payment.id,provider:"STRIPE",amount:20,currency:"GBP",historical:true}});
  blocked.push(f);
 }
 const ready=await fixture(31,seed+25);const visits:number[]=[];
 const resolve=async(id:number)=>{visits.push(id);if(blocked.some(f=>f.order.id===id)||id===ready.order.id)await resolvePaymentReservation(id);};
 await runPaymentResolutionSweep(resolve);assert.equal(visits.length,25);assert.ok(!visits.includes(ready.order.id));
 for(const f of blocked){assert.ok((await state(f)).resolution.resolutionNextCheckAt!>await prisma.$transaction(databaseNow));assert.equal((await state(f)).stock.reservedStock,2);}
 visits.length=0;await runPaymentResolutionSweep(resolve);assert.ok(visits.includes(ready.order.id));assert.equal((await state(ready)).stock.reservedStock,0);
});
it("verified failure binds a lost initiation identity and leaves retry usable",async()=>{
 const f=await fixture();const remote=intent(f);let creates=0;
 await assert.rejects(createOrReuseStripePaymentIntent(f.order.id,f.u.id,{paymentIntents:{create:async()=>{creates++;throw Error("lost response");}}} as unknown as StripePaymentClient));
 const a=await prisma.paymentAttempt.findFirstOrThrow({where:{orderId:f.order.id}});
 await reconcileStripePaymentEvent({id:randomUUID(),type:"payment_intent.payment_failed",paymentIntentId:remote.id,amount:2000,currency:"gbp",metadata:{orderId:String(f.order.id),attemptId:String(a.id),paymentKey:a.creationKey!}});
 const payment=await prisma.payment.findUniqueOrThrow({where:{orderId:f.order.id}});assert.equal(payment.providerReference,remote.id);
 assert.equal((await prisma.paymentAttempt.findUniqueOrThrow({where:{id:a.id}})).providerReference,remote.id);
 const r=(await state(f)).resolution;assert.equal(r.retryDeadline!.getTime()-r.firstFailureVerifiedAt!.getTime(),30*60_000);
 const client={paymentIntents:{retrieve:async()=>remote}} as unknown as StripePaymentClient;
 assert.equal((await createOrReuseStripePaymentIntent(f.order.id,f.u.id,client)).providerReference,remote.id);assert.equal(creates,1);
 assert.equal((await state(f)).stock.reservedStock,2);assert.equal((await state(f)).resolution.retryDeadline!.getTime(),r.retryDeadline!.getTime());
});
it("manual-payment endpoint maps closed and unresolved admission to HTTP 409",async()=>{
 const f=await fixture(31);await prisma.user.update({where:{id:f.u.id},data:{role:"ADMIN"}});
 const token=jwt.sign({id:f.u.id,role:"ADMIN"},config.JWT_SECRET);const headers={Authorization:`Bearer ${token}`,"Content-Type":"application/json"};
 assert.equal((await fetch(`${base}/orders/${f.order.id}/payments`,{method:"POST",headers,body:JSON.stringify({providerReference:randomUUID()})})).status,409);
 const other=await fixture();const pending=await admitted(other);await prisma.paymentWebhookEvent.create({data:{provider:"STRIPE",providerEventId:randomUUID(),eventType:"payment_intent.succeeded",evidence:{orderId:String(other.order.id),paymentIntentId:pending.remote.id}}});
 assert.equal((await fetch(`${base}/orders/${other.order.id}/payments`,{method:"POST",headers,body:JSON.stringify({providerReference:randomUUID()})})).status,409);
 assert.equal(await prisma.payment.count({where:{orderId:{in:[f.order.id,other.order.id]}}}),1);
});

it("foreign metadata-only Stripe success cannot block a MANAGED no-payment release",async()=>{
 const f=await fixture(31);
 await reconcileStripePaymentEvent({id:randomUUID(),type:"payment_intent.succeeded",paymentIntentId:`pi_foreign_${randomUUID()}`,amount:2000,currency:"gbp",metadata:{orderId:String(f.order.id)}});
 assert.ok(await expireOrderReservation(f.order.id));
 assert.equal((await state(f)).resolution.reservationDisposition,"RELEASED");
 assert.equal((await state(f)).stock.reservedStock,0);
});
