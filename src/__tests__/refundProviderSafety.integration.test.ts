import assert from "node:assert/strict";
import { after, afterEach, before, it } from "node:test";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { createOrReuseStripeRefund, setStripeRefundClientForTests, type StripeRefundClient } from "../domain/refunds/stripeRefundService.js";
import { createOrReusePayPalRefund, setPayPalRefundClientForTests, type PayPalRefundClient } from "../domain/refunds/paypalRefundService.js";
import { applyRefundObservation, DefinitiveRefundRejection, RefundIntentError } from "../domain/refunds/refundLifecycleService.js";
import { reconcileExternalRefund } from "../domain/refunds/refundReconciliationService.js";
import { persistRefundWebhookEvidence, processRefundWebhookReceipt, reconcileRefundWebhook, type RefundWebhookEvidence } from "../domain/refunds/refundWebhookService.js";
import { reconcileStripeRefundEvent } from "../domain/payments/stripeReconciliationService.js";
import { processPayPalWebhookReceipt } from "../domain/payments/paypalReconciliationService.js";
import { setPayPalWebhookVerifierForTests } from "../controllers/paypalWebhookController.js";
import { createRefund } from "../domain/refunds/refundService.js";

let server:ReturnType<typeof app.listen>,base:string;
const restores:Array<()=>void>=[];const oldFlag=config.REFUND_RECONCILIATION_ENABLED;
before(async()=>{server=app.listen(0);await new Promise<void>(r=>server.once("listening",r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
afterEach(()=>{restores.splice(0).reverse().forEach(r=>r());config.REFUND_RECONCILIATION_ENABLED=oldFlag;});
after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await prisma.$disconnect();});
async function fixture(provider:"STRIPE"|"PAYPAL"="STRIPE"){
 const user=await prisma.user.create({data:{email:`${randomUUID()}@refund-safety.test`,passwordHash:"fixture",role:"ADMIN",emailVerified:true}});
 const product=await prisma.legoProduct.create({data:{setNumber:randomUUID(),title:"Refund safety fixture",theme:"TEST",ageRecommendation:"8+",pieceCount:1}});
 const stock=await prisma.productListing.create({data:{legoProductId:product.id,condition:"NEW",originalPrice:100,currentStock:7,reservedStock:2}});
 const order=await prisma.order.create({data:{userId:user.id,status:"CONFIRMED",totalAmount:100,
  billingRecipientName:"Fixture",billingLine1:"Fixture",billingCity:"Fixture",billingPostcode:"T1",billingCountryCode:"GB",
  deliveryRecipientName:"Fixture",deliveryLine1:"Fixture",deliveryCity:"Fixture",deliveryPostcode:"T1",deliveryCountryCode:"GB",
  orderItems:{create:{productListingId:stock.id,quantity:1,unitPrice:100,lineTotal:100}}}});
 const payment=await prisma.payment.create({data:{orderId:order.id,provider,providerReference:provider==="STRIPE"?`pi_${randomUUID()}`:`ORDER-${randomUUID()}`,
  ...(provider==="PAYPAL"?{providerCaptureReference:`CAP-${randomUUID()}`}:{ }),amount:100,currency:"GBP",status:"SUCCEEDED",paidAt:new Date()}});
 const token=jwt.sign({id:user.id,role:"ADMIN"},config.JWT_SECRET);
 return {user,order,payment,stock,token};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
function stripe(f:Fixture,client:StripeRefundClient,key=randomUUID(),amount=10,reason?:string){return createOrReuseStripeRefund(f.order.id,f.payment.id,amount,reason,f.user.id,client,undefined,key);}
function paypal(f:Fixture,client:PayPalRefundClient,key=randomUUID(),amount=10,reason?:string){return createOrReusePayPalRefund(f.order.id,f.payment.id,amount,reason,f.user.id,client,undefined,key);}
function stripeResponse(f:Fixture,id=`re_${randomUUID()}`,status="succeeded",amount=1000){return {id,status,amount,currency:"gbp",payment_intent:f.payment.providerReference,metadata:{}} as any;}
function ppResponse(f:Fixture,id=`PP-${randomUUID()}`,status="COMPLETED",amount="10.00",localRefundId?:number){return {id,status,amount:{value:amount,currency_code:"GBP"},
 ...(localRefundId?{custom_id:`cl-refund-${localRefundId}`}:{ }),links:[{rel:"up",href:`${config.PAYPAL_BASE_URL}/v2/payments/captures/${f.payment.providerCaptureReference}`}]};}
async function amounts(f:Fixture){const p=await prisma.payment.findUniqueOrThrow({where:{id:f.payment.id}});return {reserved:p.reservedRefundAmount.toString(),refunded:p.refundedAmount.toString()};}
function stripeEvent(f:Fixture,refundId:number,reference:string,status="succeeded"){return {id:randomUUID(),type:"refund.updated" as const,refundId:reference,paymentIntentId:f.payment.providerReference,amount:1000,currency:"GBP",status,metadata:{local_refund_id:String(refundId),order_id:String(f.order.id)}};}
function ppEvent(f:Fixture,refundId:number,reference:string,status:"PENDING"|"SUCCEEDED"|"FAILED"="SUCCEEDED"):RefundWebhookEvidence{return {version:2,kind:"refund",provider:"PAYPAL",id:randomUUID(),eventType:status==="SUCCEEDED"?"PAYMENT.CAPTURE.REFUNDED":status==="PENDING"?"PAYMENT.REFUND.PENDING":"PAYMENT.REFUND.FAILED",reference,parentReference:f.payment.providerCaptureReference!,amount:"10.00",currency:"GBP",status,localRefundId:String(refundId)};}
async function api(f:Fixture,body:object,key?:string){return fetch(`${base}/orders/${f.order.id}/refunds`,{method:"POST",headers:{Authorization:`Bearer ${f.token}`,"Content-Type":"application/json",...(key?{"Idempotency-Key":key}:{})},body:JSON.stringify(body)});}

it("requires a client key before any new external intent or provider call",async()=>{
 const f=await fixture();let calls=0;restores.push(setStripeRefundClientForTests({createRefund:async()=>{calls++;return stripeResponse(f);}}));
 for(const key of [undefined,"short","bad key "+randomUUID()]){const response=await api(f,{paymentId:f.payment.id,amount:10},key);assert.equal(response.status,400);}
 assert.equal(calls,0);assert.equal(await prisma.refund.count({where:{paymentId:f.payment.id}}),0);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"0"});
});
it("lost successful HTTP response replays the original intent; a new key permits a sequential partial refund",async()=>{
 const f=await fixture();let calls=0;const client:StripeRefundClient={createRefund:async()=>{calls++;return stripeResponse(f);}};
 const key=randomUUID();const first=await stripe(f,client,key);const retry=await stripe(f,client,key);assert.equal(retry.id,first.id);assert.equal(calls,1);
 const next=await stripe(f,client);assert.notEqual(next.id,first.id);assert.equal(calls,2);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"20"});
});
it("client key reuse with different amount, reason, payment or provider is rejected",async()=>{
 const f=await fixture(),other=await fixture("PAYPAL");let calls=0;const c:StripeRefundClient={createRefund:async()=>{calls++;return stripeResponse(f);}};const key=randomUUID();await stripe(f,c,key,10,"note");
 await assert.rejects(stripe(f,c,key,11,"note"),RefundIntentError);await assert.rejects(stripe(f,c,key,10,"different"),RefundIntentError);
 await assert.rejects(paypal(other,{refundCapture:async()=>{throw new Error("must not call");}},key),RefundIntentError);assert.equal(calls,1);
});
it("concurrent same-key submissions make exactly one provider POST",async()=>{
 const f=await fixture(),gate=deferred(),entered=deferred();let calls=0;const key=randomUUID();const c:StripeRefundClient={createRefund:async()=>{calls++;entered.resolve();await gate.promise;return stripeResponse(f);}};
 const first=stripe(f,c,key);await entered.promise;const second=await stripe(f,c,key);assert.equal(second.status,"PROCESSING");gate.resolve();const done=await first;assert.equal(second.id,done.id);assert.equal(calls,1);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
});
it("concurrent independent admins cannot create a second unresolved intent",async()=>{
 const f=await fixture(),gate=deferred(),entered=deferred();let calls=0;const c:StripeRefundClient={createRefund:async()=>{calls++;entered.resolve();await gate.promise;return stripeResponse(f);}};
 const first=stripe(f,c);await entered.promise;
 try{await assert.rejects(stripe(f,c),(e:unknown)=>e instanceof RefundIntentError&&e.code==="REFUND_UNRESOLVED"&&!!e.refundId);}finally{gate.resolve();}
 await first;assert.equal(calls,1);assert.equal(await prisma.refund.count({where:{paymentId:f.payment.id}}),1);
});
it("Stripe response loss preserves identity and blocks every automatic POST replay",async()=>{
 const f=await fixture();let calls=0;const c:StripeRefundClient={createRefund:async()=>{calls++;throw new Error("lost response after payout");}};const key=randomUUID();
 const pending=await stripe(f,c,key);assert.equal(pending.status,"PROCESSING");assert.equal((await stripe(f,c,key)).id,pending.id);
 await assert.rejects(stripe(f,c),RefundIntentError);assert.equal(calls,1);assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
 const event=stripeEvent(f,pending.id,`re_${randomUUID()}`);assert.equal((await reconcileStripeRefundEvent(event)).handled,true);assert.equal((await stripe(f,c,key)).status,"SUCCEEDED");assert.equal(calls,1);
});
it("PayPal response loss can recover from exact verified correlation without a second payout",async()=>{
 const f=await fixture("PAYPAL");let calls=0;const c:PayPalRefundClient={refundCapture:async()=>{calls++;throw new Error("response lost");}};const key=randomUUID();const pending=await paypal(f,c,key);
 await paypal(f,c,key);await assert.rejects(paypal(f,c),RefundIntentError);assert.equal(calls,1);
 const event=ppEvent(f,pending.id,`PP-${randomUUID()}`);await reconcileRefundWebhook(event);await reconcileRefundWebhook(event);
 assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});assert.equal((await paypal(f,c,key)).status,"SUCCEEDED");assert.equal(calls,1);
});
it("Stripe free-text reason is preserved locally and omitted from the provider request",async()=>{
 const f=await fixture();const result=await stripe(f,{createRefund:async(input)=>{assert.equal("reason" in input,false);return stripeResponse(f);}},randomUUID(),10,"  customer service goodwill  ");
 assert.equal(result.reason,"customer service goodwill");assert.equal(result.status,"SUCCEEDED");
});
it("Stripe definitive initial validation rejection releases capacity exactly once",async()=>{
 const f=await fixture();const key=randomUUID();let calls=0;const c:StripeRefundClient={createRefund:async()=>{calls++;throw new Stripe.errors.StripeInvalidRequestError({message:"private",type:"invalid_request_error",code:"parameter_invalid_enum",statusCode:400});}};
 const failed=await stripe(f,c,key);assert.equal(failed.status,"FAILED");await stripe(f,c,key);assert.equal(calls,1);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"0"});assert.ok(failed.providerOutcome);
});
it("unclassified Stripe rejection and idempotency conflicts never release capacity",async()=>{
 for(const error of [new Error("timeout"),new Stripe.errors.StripeInvalidRequestError({message:"conflict",type:"invalid_request_error",code:"idempotency_key_in_use",statusCode:400})]){
  const f=await fixture();const result=await stripe(f,{createRefund:async()=>{throw error;}});assert.equal(result.status,"PROCESSING");assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
 }
});
it("PayPal definitive request rejection releases once, unlike unknown transport errors",async()=>{
 const f=await fixture("PAYPAL");const key=randomUUID();const c:PayPalRefundClient={refundCapture:async()=>{throw new DefinitiveRefundRejection("PAYPAL_INVALID_REQUEST");}};
 assert.equal((await paypal(f,c,key)).status,"FAILED");await paypal(f,c,key);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"0"});
});
it("PayPal pending remains reserved until verified completed or failed evidence",async()=>{
 for(const outcome of ["SUCCEEDED","FAILED"] as const){const f=await fixture("PAYPAL"),reference=`PP-${randomUUID()}`;const pending=await paypal(f,{refundCapture:async()=>ppResponse(f,reference,"PENDING")});
  assert.equal(pending.status,"PROCESSING");assert.equal(pending.providerReference,reference);assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
  const evidence=ppEvent(f,pending.id,reference,outcome);await reconcileRefundWebhook(evidence);await reconcileRefundWebhook({...evidence,id:randomUUID()});
  assert.equal((await prisma.refund.findUniqueOrThrow({where:{id:pending.id}})).status,outcome);assert.deepEqual(await amounts(f),{reserved:"0",refunded:outcome==="SUCCEEDED"?"10":"0"});
 }
});
it("pending notifications cannot regress success; conflicting terminal evidence requires review",async()=>{
 const f=await fixture("PAYPAL"),reference=`PP-${randomUUID()}`;const done=await paypal(f,{refundCapture:async()=>ppResponse(f,reference)});
 await reconcileRefundWebhook(ppEvent(f,done.id,reference,"PENDING"));assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
 await reconcileRefundWebhook(ppEvent(f,done.id,reference,"FAILED"));const current=await prisma.refund.findUniqueOrThrow({where:{id:done.id}});assert.equal(current.status,"SUCCEEDED");assert.equal(current.reviewRequired,true);
 await assert.rejects(paypal(f,{refundCapture:async()=>{throw new Error("must not call");}}),RefundIntentError);
});
it("mismatched PayPal FAILED evidence cannot release reservation",async()=>{
 const f=await fixture("PAYPAL");const result=await paypal(f,{refundCapture:async()=>ppResponse(f,undefined,"FAILED","9.99")});assert.equal(result.status,"PROCESSING");assert.equal(result.reviewRequired,true);assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
});
it("webhook-first Stripe success and a delayed synchronous result account once",async()=>{
 const f=await fixture(),gate=deferred(),entered=deferred();const reference=`re_${randomUUID()}`;const pending=stripe(f,{createRefund:async()=>{entered.resolve();await gate.promise;return stripeResponse(f,reference);}});
 await entered.promise;const local=await prisma.refund.findFirstOrThrow({where:{paymentId:f.payment.id}});await reconcileStripeRefundEvent(stripeEvent(f,local.id,reference));gate.resolve();await pending;assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
});
it("PayPal synchronous completion and independent concurrent webhooks account once",async()=>{
 const f=await fixture("PAYPAL"),gate=deferred(),entered=deferred();const reference=`PP-${randomUUID()}`;const pending=paypal(f,{refundCapture:async()=>{entered.resolve();await gate.promise;return ppResponse(f,reference);}});
 await entered.promise;const local=await prisma.refund.findFirstOrThrow({where:{paymentId:f.payment.id}});const e=ppEvent(f,local.id,reference);
 const hooks=Promise.all([reconcileRefundWebhook(e),reconcileRefundWebhook({...e,id:randomUUID()})]);gate.resolve();await Promise.all([pending,hooks]);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
});
it("a duplicate completion cannot consume another historical refund's reservation",async()=>{
 const f=await fixture();await prisma.payment.update({where:{id:f.payment.id},data:{reservedRefundAmount:20}});
 const make=()=>prisma.refund.create({data:{orderId:f.order.id,paymentId:f.payment.id,amount:10,currency:"GBP",provider:"STRIPE",status:"PROCESSING",providerReference:`pending:${randomUUID()}`,performedByUserId:f.user.id}});
 const a=await make(),b=await make();const obs={provider:"STRIPE" as const,reference:`re_${randomUUID()}`,parentReference:f.payment.providerReference,amount:"10",currency:"GBP",status:"SUCCEEDED" as const};
 await Promise.all([applyRefundObservation(a.id,obs),applyRefundObservation(a.id,obs),reconcileStripeRefundEvent(stripeEvent(f,a.id,obs.reference))]);
 assert.deepEqual(await amounts(f),{reserved:"10",refunded:"10"});assert.equal((await prisma.refund.findUniqueOrThrow({where:{id:b.id}})).status,"PROCESSING");
});
it("unrelated uniqueness/persistence failures are not acknowledged and committed evidence survives",async()=>{
 const f=await fixture("PAYPAL");const pending=await paypal(f,{refundCapture:async()=>{throw new Error("lost");}});const e=ppEvent(f,pending.id,`PP-${randomUUID()}`);
 const saved=await persistRefundWebhookEvidence(e);const failure=Object.assign(new Error("injected persistence failure"),{code:"P2002"});
 const transaction=prisma.$transaction;prisma.$transaction=(()=>Promise.reject(failure)) as typeof prisma.$transaction;
 try{await assert.rejects(processRefundWebhookReceipt(saved.receiptId),error=>error===failure);}finally{prisma.$transaction=transaction;}
 assert.equal((await prisma.paymentWebhookEvent.findUniqueOrThrow({where:{id:saved.receiptId}})).processedAt,null);assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
 await processPayPalWebhookReceipt(saved.receiptId);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
});
it("unknown events survive for replay, and conflicting receipt evidence is rejected",async()=>{
 const f=await fixture("PAYPAL");const e=ppEvent(f,999999999,`PP-${randomUUID()}`);assert.equal((await reconcileRefundWebhook(e)).handled,false);
 const receipt=await prisma.paymentWebhookEvent.findUniqueOrThrow({where:{provider_providerEventId:{provider:"PAYPAL",providerEventId:e.id}}});assert.equal(receipt.processedAt,null);
 await assert.rejects(reconcileRefundWebhook({...e,amount:"11.00"}));assert.deepEqual((await prisma.paymentWebhookEvent.findUniqueOrThrow({where:{id:receipt.id}})).evidence,e);
});
it("early verified receipt can replay after the exact local refund is committed",async()=>{
 const f=await fixture("PAYPAL"),reference=`PP-${randomUUID()}`;const localId=Number((await prisma.$queryRaw<Array<{id:number}>>`SELECT nextval(pg_get_serial_sequence('"Refund"','id'))::int AS id`)[0].id);
 const event=ppEvent(f,localId,reference);await reconcileRefundWebhook(event);
 await prisma.$transaction(async tx=>{await tx.payment.update({where:{id:f.payment.id},data:{reservedRefundAmount:10}});await tx.refund.create({data:{id:localId,orderId:f.order.id,paymentId:f.payment.id,amount:10,currency:"GBP",provider:"PAYPAL",status:"PROCESSING",providerReference:`pending:${randomUUID()}`,performedByUserId:f.user.id}});});
 const receipt=await prisma.paymentWebhookEvent.findUniqueOrThrow({where:{provider_providerEventId:{provider:"PAYPAL",providerEventId:event.id}}});await processPayPalWebhookReceipt(receipt.id);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
});
it("manual GET fallback is disabled by default and never resubmits a legacy refund",async()=>{
 assert.equal(config.REFUND_RECONCILIATION_ENABLED,false);const f=await fixture();let posts=0;
 const pending=await stripe(f,{createRefund:async()=>{posts++;throw new Error("lost");}});
 await assert.rejects(reconcileExternalRefund(f.order.id,pending.id),RefundIntentError);config.REFUND_RECONCILIATION_ENABLED=true;
 const result=await reconcileExternalRefund(f.order.id,pending.id);assert.equal(result.resolutionCode,"MANUAL_REVIEW_REQUIRED");assert.equal(posts,1);assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
});
it("known PayPal pending refund recovers by one manual GET when its webhook is missing",async()=>{
 const f=await fixture("PAYPAL"),reference=`PP-${randomUUID()}`;let posts=0,gets=0;
 const c:PayPalRefundClient={refundCapture:async()=>{posts++;return ppResponse(f,reference,"PENDING");},retrieveRefund:async id=>{gets++;assert.equal(id,reference);return ppResponse(f,reference);}};
 const pending=await paypal(f,c);restores.push(setPayPalRefundClientForTests(c));config.REFUND_RECONCILIATION_ENABLED=true;
 const done=await reconcileExternalRefund(f.order.id,pending.id);assert.equal(done.status,"SUCCEEDED");assert.equal(posts,1);assert.equal(gets,1);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
});
it("manual reconciliation GET attempts are durably capped at eight even concurrently",async()=>{
 const f=await fixture(),reference=`re_${randomUUID()}`;let gets=0;const c:StripeRefundClient={createRefund:async()=>stripeResponse(f,reference,"pending"),retrieveRefund:async()=>{gets++;throw new Error("outage");}};
 const pending=await stripe(f,c);restores.push(setStripeRefundClientForTests(c));config.REFUND_RECONCILIATION_ENABLED=true;
 await Promise.all(Array.from({length:10},()=>reconcileExternalRefund(f.order.id,pending.id)));assert.equal(gets,8);const result=await prisma.refund.findUniqueOrThrow({where:{id:pending.id}});assert.equal(result.reconciliationAttempts,8);assert.equal(result.reviewRequired,true);assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
});
it("a minimal PayPal response is recoverable by validated GET, never a repeated POST",async()=>{
 const f=await fixture("PAYPAL"),reference=`PP-${randomUUID()}`;const pending=await paypal(f,{refundCapture:async()=>({id:reference,status:"PENDING"})});
 config.REFUND_RECONCILIATION_ENABLED=true;restores.push(setPayPalRefundClientForTests({refundCapture:async()=>{throw new Error("must not POST");},retrieveRefund:async()=>ppResponse(f,reference)}));
 const done=await reconcileExternalRefund(f.order.id,pending.id);assert.equal(done.status,"SUCCEEDED");assert.equal(done.reviewRequired,false);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
 const next=await paypal(f,{refundCapture:async()=>ppResponse(f)});assert.equal(next.status,"SUCCEEDED");assert.deepEqual(await amounts(f),{reserved:"0",refunded:"20"});
});
it("manual refunds respect existing reservations and preserve manual-reference replay",async()=>{
 const f=await fixture();await prisma.payment.update({where:{id:f.payment.id},data:{reservedRefundAmount:95}});
 await assert.rejects(createRefund(f.order.id,f.payment.id,10,randomUUID(),undefined,f.user.id));assert.deepEqual(await amounts(f),{reserved:"95",refunded:"0"});
 const manual=await fixture();await prisma.payment.update({where:{id:manual.payment.id},data:{provider:"MANUAL"}});const reference=randomUUID();const first=await createRefund(manual.order.id,manual.payment.id,10,reference,undefined,manual.user.id);const again=await createRefund(manual.order.id,manual.payment.id,10,reference,undefined,manual.user.id);assert.equal(first.refund.id,again.refund.id);assert.deepEqual(await amounts(manual),{reserved:"0",refunded:"10"});
});
it("external refunds do not mutate payment principal, ownership, order, returns or inventory",async()=>{
 const f=await fixture();const before={order:await prisma.order.findUniqueOrThrow({where:{id:f.order.id}}),stock:await prisma.productListing.findUniqueOrThrow({where:{id:f.stock.id}}),items:await prisma.orderItem.findMany({where:{orderId:f.order.id}}),movements:await prisma.inventoryMovement.count({where:{listingId:f.stock.id}})};
 await stripe(f,{createRefund:async()=>stripeResponse(f)});const payment=await prisma.payment.findUniqueOrThrow({where:{id:f.payment.id}});assert.equal(payment.amount.toString(),"100");assert.equal(payment.status,"SUCCEEDED");assert.equal(payment.paidAt?.getTime(),f.payment.paidAt?.getTime());
 assert.deepEqual({order:await prisma.order.findUniqueOrThrow({where:{id:f.order.id}}),stock:await prisma.productListing.findUniqueOrThrow({where:{id:f.stock.id}}),items:await prisma.orderItem.findMany({where:{orderId:f.order.id}}),movements:await prisma.inventoryMovement.count({where:{listingId:f.stock.id}})},before);
});
it("database protects submitted identity, provider binding, terminal proof and recovery counters",async()=>{
 const f=await fixture(),reference=`re_${randomUUID()}`;const result=await stripe(f,{createRefund:async()=>stripeResponse(f,reference)});
 for(const data of [{clientRequestKey:randomUUID()},{amount:11},{reason:"mutate"},{providerReference:`re_${randomUUID()}`},{status:"PROCESSING" as const},{providerPaymentReference:"pi_other"},{submissionStartedAt:new Date(0)},{providerOutcome:{overwrite:true}}])await assert.rejects(prisma.refund.update({where:{id:result.id},data}));
 await prisma.refund.update({where:{id:result.id},data:{reconciliationAttempts:2}});await assert.rejects(prisma.refund.update({where:{id:result.id},data:{reconciliationAttempts:1}}));await assert.rejects(prisma.refund.update({where:{id:result.id},data:{reconciliationAttempts:9}}));
});
it("HTTP ambiguous responses expose refundId, replay safely and report competing-intent conflicts",async()=>{
 const f=await fixture();let calls=0;restores.push(setStripeRefundClientForTests({createRefund:async()=>{calls++;throw new Error("secret body");}}));const key=randomUUID();
 const first=await api(f,{paymentId:f.payment.id,amount:10},key);assert.equal(first.status,202);const body=await first.json();assert.equal(body.status,"PROCESSING");assert.ok(body.refundId);assert.equal(body.resolutionCode,"PROVIDER_OUTCOME_UNKNOWN");assert.ok(!JSON.stringify(body).includes("secret"));
 const replay=await api(f,{paymentId:f.payment.id,amount:10},key);assert.equal((await replay.json()).refundId,body.refundId);
 const conflict=await api(f,{paymentId:f.payment.id,amount:10},randomUUID());assert.equal(conflict.status,409);assert.equal((await conflict.json()).refundId,body.refundId);assert.equal(calls,1);
 const mismatch=await api(f,{paymentId:f.payment.id,amount:11},key);assert.equal(mismatch.status,409);
});
it("legacy unresolved refunds and unknown explicit refundIds never create new provider intents",async()=>{
 const f=await fixture();const legacy=await prisma.refund.create({data:{orderId:f.order.id,paymentId:f.payment.id,amount:10,currency:"GBP",provider:"STRIPE",status:"PROCESSING",providerReference:`pending:${randomUUID()}`,performedByUserId:f.user.id}});
 await prisma.payment.update({where:{id:f.payment.id},data:{reservedRefundAmount:10}});let calls=0;const c:StripeRefundClient={createRefund:async()=>{calls++;return stripeResponse(f);}};
 assert.equal((await createOrReuseStripeRefund(f.order.id,f.payment.id,10,undefined,f.user.id,c,legacy.id)).id,legacy.id);
 await assert.rejects(stripe(f,c),RefundIntentError);await assert.rejects(createOrReuseStripeRefund(f.order.id,f.payment.id,10,undefined,f.user.id,c,999999999),RefundIntentError);assert.equal(calls,0);
});
it("manual reconciliation endpoint enforces auth, ownership and disabled activation",async()=>{
 const f=await fixture();const pending=await stripe(f,{createRefund:async()=>stripeResponse(f,undefined,"pending")});const path=`${base}/orders/${f.order.id}/refunds/${pending.id}/reconcile`;
 assert.equal((await fetch(path,{method:"POST"})).status,401);
 const customer=await prisma.user.create({data:{email:`${randomUUID()}@refund-safety.test`,passwordHash:"fixture",role:"CUSTOMER"}});
 const token=jwt.sign({id:customer.id,role:"CUSTOMER"},config.JWT_SECRET);assert.equal((await fetch(path,{method:"POST",headers:{Authorization:`Bearer ${token}`}})).status,403);
 assert.equal((await fetch(path,{method:"POST",headers:{Authorization:`Bearer ${f.token}`}})).status,503);
 config.REFUND_RECONCILIATION_ENABLED=true;
 assert.equal((await fetch(`${base}/orders/999999999/refunds/${pending.id}/reconcile`,{method:"POST",headers:{Authorization:`Bearer ${f.token}`}})).status,404);
});
it("PayPal refund webhook rejects unverified evidence and completes verified refunds",async()=>{
 const f=await fixture("PAYPAL"),reference=`PP-${randomUUID()}`;const pending=await paypal(f,{refundCapture:async()=>ppResponse(f,reference,"PENDING")});
 const event={id:randomUUID(),event_type:"PAYMENT.CAPTURE.REFUNDED",resource_type:"refund",resource:{...ppResponse(f,reference,"COMPLETED","10.00",pending.id)}};
 let restore=setPayPalWebhookVerifierForTests(async()=>false);let response=await fetch(`${base}/payments/paypal/webhook`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(event)});assert.equal(response.status,400);restore();
 restore=setPayPalWebhookVerifierForTests(async()=>true);restores.push(restore);response=await fetch(`${base}/payments/paypal/webhook`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(event)});assert.equal(response.status,200);assert.equal((await response.json()).handled,true);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
});

it("conflicting Stripe metadata or PayPal parent link cannot finalize money",async()=>{
 const a=await fixture();const response=stripeResponse(a);response.metadata={local_refund_id:"999999999"};assert.equal((await stripe(a,{createRefund:async()=>response})).reviewRequired,true);assert.deepEqual(await amounts(a),{reserved:"10",refunded:"0"});
 const b=await fixture("PAYPAL");const pp=ppResponse(b);pp.links=[{rel:"up",href:"https://attacker.invalid/v2/payments/captures/CAP"}];assert.equal((await paypal(b,{refundCapture:async()=>pp})).reviewRequired,true);assert.deepEqual(await amounts(b),{reserved:"10",refunded:"0"});
});
it("same-key races on different payments cannot leave extra reservations",async()=>{
 const a=await fixture(),b=await fixture();const key=randomUUID();let posts=0;
 const results=await Promise.allSettled([stripe(a,{createRefund:async()=>{posts++;return stripeResponse(a);}},key),stripe(b,{createRefund:async()=>{posts++;return stripeResponse(b);}},key)]);
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);assert.equal(posts,1);
 const sums=[await amounts(a),await amounts(b)];assert.equal(sums.filter(x=>x.refunded==="10").length,1);assert.equal(sums.filter(x=>x.reserved==="0"&&x.refunded==="0").length,1);
});
it("manual GET timeout remains unresolved and does not release capacity",async()=>{
 const f=await fixture();const c:StripeRefundClient={createRefund:async()=>stripeResponse(f,undefined,"pending"),retrieveRefund:async()=>new Promise(()=>{})};const pending=await stripe(f,c);
 restores.push(setStripeRefundClientForTests(c));config.REFUND_RECONCILIATION_ENABLED=true;const result=await reconcileExternalRefund(f.order.id,pending.id);
 assert.equal(result.status,"PROCESSING");assert.equal(result.resolutionCode,"RECONCILIATION_UNAVAILABLE");assert.equal(result.reconciliationAttempts,1);assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
});

it("expired provider idempotency protection never permits replaying an old submitted POST",async()=>{
 const f=await fixture(),key=randomUUID();await prisma.payment.update({where:{id:f.payment.id},data:{reservedRefundAmount:10}});
 const old=await prisma.refund.create({data:{orderId:f.order.id,paymentId:f.payment.id,amount:10,currency:"GBP",provider:"STRIPE",status:"PROCESSING",
  providerReference:`pending:${randomUUID()}`,refundIdempotencyKey:randomUUID(),clientRequestKey:key,providerPaymentReference:f.payment.providerReference,
  submissionStartedAt:new Date("2000-01-01T00:00:00Z"),performedByUserId:f.user.id}});
 let posts=0;const c:StripeRefundClient={createRefund:async()=>{posts++;return stripeResponse(f);}};
 assert.equal((await stripe(f,c,key)).id,old.id);await assert.rejects(stripe(f,c),RefundIntentError);assert.equal(posts,0);assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
});
it("submission admission and capacity are committed before external provider I/O",async()=>{
 const f=await fixture(),key=randomUUID();await stripe(f,{createRefund:async(input,options)=>{
  assert.ok(input.metadata&&typeof input.metadata==="object");
  const local=await prisma.refund.findUniqueOrThrow({where:{id:Number(input.metadata.local_refund_id)}});
  assert.equal(local.clientRequestKey,key);assert.ok(local.submissionStartedAt);assert.equal(local.refundIdempotencyKey,options.idempotencyKey);assert.equal(local.providerPaymentReference,f.payment.providerReference);
  assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});return stripeResponse(f);
 }},key);
 assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
});

it("a post-submission persistence failure returns stable identity and UNKNOWN without replaying the payout",async()=>{
 const f=await fixture(),key=randomUUID();let calls=0;const transaction=prisma.$transaction;
 restores.push(setStripeRefundClientForTests({createRefund:async()=>{calls++;prisma.$transaction=(()=>Promise.reject(new Error("injected commit path outage"))) as typeof prisma.$transaction;return stripeResponse(f);}}));
 let response:Response;
 try{response=await api(f,{paymentId:f.payment.id,amount:10},key);}finally{prisma.$transaction=transaction;}
 assert.equal(response.status,503);const body=await response.json();assert.ok(body.refundId);assert.equal(body.status,"UNKNOWN");assert.equal(body.resolutionCode,"RECONCILIATION_REQUIRED");
 assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});const replay=await api(f,{paymentId:f.payment.id,amount:10},key);assert.equal(replay.status,202);assert.equal((await replay.json()).refundId,body.refundId);assert.equal(calls,1);
});

it("uncorrelated verified refund evidence for the exact provider parent blocks new payouts",async()=>{
 const f=await fixture("PAYPAL");const event=ppEvent(f,999999999,`PP-${randomUUID()}`);await reconcileRefundWebhook(event);let posts=0;
 await assert.rejects(paypal(f,{refundCapture:async()=>{posts++;return ppResponse(f);}}),(error:unknown)=>error instanceof RefundIntentError&&error.code==="REFUND_PROVIDER_EVIDENCE_UNRESOLVED");
 assert.equal(posts,0);assert.equal(await prisma.refund.count({where:{paymentId:f.payment.id}}),0);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"0"});
});

for(const environment of ["live","sandbox"]){
 it(`official ${environment} PayPal aliases finalize POST, verified webhook and GET exactly once`,async()=>{
  const previous=config.PAYPAL_BASE_URL;restores.push(()=>{config.PAYPAL_BASE_URL=previous;});
  const suffix=environment==="sandbox"?"sandbox.paypal.com":"paypal.com";
  config.PAYPAL_BASE_URL=`https://api-m.${suffix}`;config.REFUND_RECONCILIATION_ENABLED=true;
  const f=await fixture("PAYPAL"),gate=deferred(),entered=deferred();let localId=0;
  const reference=`PP-${randomUUID()}`;
  const response=()=>({...ppResponse(f,reference,"COMPLETED","10.00",localId),links:[{rel:"up",href:`https://api.${suffix}/v2/payments/captures/${f.payment.providerCaptureReference}`,method:"GET"}]});
  const client:PayPalRefundClient={refundCapture:async(_capture,_key,_amount,_currency,id)=>{localId=id!;entered.resolve();await gate.promise;return response();},retrieveRefund:async()=>response()};
  restores.push(setPayPalRefundClientForTests(client));restores.push(setPayPalWebhookVerifierForTests(async()=>true));
  const pending=paypal(f,client);await entered.promise;
  const event={id:randomUUID(),event_type:"PAYMENT.CAPTURE.REFUNDED",resource:response()};
  const webhook=()=>fetch(`${base}/payments/paypal/webhook`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(event)});
  // Bind the same provider ID while POST remains in flight, then race GET and webhook completion.
  await applyRefundObservation(localId,{provider:"PAYPAL",reference,parentReference:f.payment.providerCaptureReference!,amount:"10.00",currency:"GBP",status:"PENDING"});
  const [http,recovered]=await Promise.all([webhook(),reconcileExternalRefund(f.order.id,localId)]);
  assert.equal(http.status,200);assert.equal((await http.json()).handled,true);assert.equal(recovered.status,"SUCCEEDED");
  gate.resolve();assert.equal((await pending).status,"SUCCEEDED");assert.equal((await webhook()).status,200);
  assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
  // Also prove the authenticated POST alone accepts the alias (not merely a terminal short circuit).
  const g=await fixture("PAYPAL");const direct=await paypal(g,{refundCapture:async()=>({...ppResponse(g),links:[{rel:"up",href:`https://api.${suffix}/v2/payments/captures/${g.payment.providerCaptureReference}`} ]})});
  assert.equal(direct.status,"SUCCEEDED");assert.deepEqual(await amounts(g),{reserved:"0",refunded:"10"});
 });
}
it("incomplete authenticated PayPal POST retains a validated ID for GET recovery",async()=>{
 const f=await fixture("PAYPAL"),reference=`PP-${randomUUID()}`;config.REFUND_RECONCILIATION_ENABLED=true;
 const client:PayPalRefundClient={refundCapture:async()=>({id:reference,status:"COMPLETED"}),retrieveRefund:async()=>ppResponse(f,reference)};
 restores.push(setPayPalRefundClientForTests(client));const pending=await paypal(f,client);
 assert.equal(pending.status,"PROCESSING");assert.deepEqual(pending.reviewEvidence,{reference});
 assert.equal((await reconcileExternalRefund(f.order.id,pending.id)).status,"SUCCEEDED");assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
});
it("incomplete PayPal POST cannot retain contradictory or malformed identities",async()=>{
 for(const bad of ["capture","custom","host","id"]){
  const f=await fixture("PAYPAL");const response:any={id:`PP-${randomUUID()}`,status:"COMPLETED"};
  if(bad==="capture")response.links=[{rel:"up",href:`${config.PAYPAL_BASE_URL}/v2/payments/captures/WRONG`}];
  if(bad==="host")response.links=[{rel:"up",href:"https://attacker.invalid/v2/payments/captures/WRONG"}];
  if(bad==="custom")response.custom_id="cl-refund-0";
  if(bad==="id")response.id="invalid / identity";
  const pending=await paypal(f,{refundCapture:async()=>response});assert.equal(pending.status,"PROCESSING");
  assert.equal((pending.reviewEvidence as any)?.reference,undefined);assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
 }
});
it("delayed incomplete POST cannot replace the refund identity bound by a concurrent webhook",async()=>{
 const f=await fixture("PAYPAL"),gate=deferred(),entered=deferred();let localId=0;const reference=`PP-${randomUUID()}`;
 const running=paypal(f,{refundCapture:async(_c,_k,_a,_u,id)=>{localId=id!;entered.resolve();await gate.promise;return {id:`PP-${randomUUID()}`};}});
 await entered.promise;await reconcileRefundWebhook(ppEvent(f,localId,reference,"PENDING"));gate.resolve();
 const pending=await running;assert.equal(pending.providerReference,reference);assert.equal(pending.reviewRequired,true);
 assert.equal((pending.reviewEvidence as any)?.reference,undefined);assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
});
