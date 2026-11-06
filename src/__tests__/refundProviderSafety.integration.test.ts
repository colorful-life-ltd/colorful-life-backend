import assert from "node:assert/strict";
import { after, afterEach, before, it } from "node:test";
import { randomUUID } from "node:crypto";
import Stripe from "stripe";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { databasePoolOptions } from "../config/database.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma-client/client.js";
import { prisma } from "../prisma/runtime.js";
import { createOrReuseStripeRefund, setStripeRefundClientForTests, type StripeRefundClient } from "../domain/refunds/stripeRefundService.js";
import { applyRefundObservation, DefinitiveRefundRejection, RefundIntentError } from "../domain/refunds/refundLifecycleService.js";
import { reconcileExternalRefund } from "../domain/refunds/refundReconciliationService.js";
import { persistRefundWebhookEvidence, processRefundWebhookReceipt, reconcileRefundWebhook, type RefundWebhookEvidence } from "../domain/refunds/refundWebhookService.js";
import { reconcileStripeRefundEvent } from "../domain/payments/stripeReconciliationService.js";
import { createRefund } from "../domain/refunds/refundService.js";

let server:ReturnType<typeof app.listen>,base:string;
const restores:Array<()=>void>=[];const oldFlag=config.REFUND_RECONCILIATION_ENABLED;
before(async()=>{server=app.listen(0);await new Promise<void>(r=>server.once("listening",r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
afterEach(()=>{restores.splice(0).reverse().forEach(r=>r());config.REFUND_RECONCILIATION_ENABLED=oldFlag;});
after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await prisma.$disconnect();});
async function fixture(provider:"STRIPE"="STRIPE"){
 const user=await prisma.user.create({data:{email:`${randomUUID()}@refund-safety.test`,passwordHash:"fixture",role:"ADMIN",emailVerified:true}});
 const product=await prisma.legoProduct.create({data:{setNumber:randomUUID(),title:"Refund safety fixture",theme:"TEST",ageRecommendation:"8+",pieceCount:1}});
 const stock=await prisma.productListing.create({data:{legoProductId:product.id,condition:"NEW",originalPrice:100,currentStock:7,reservedStock:2}});
 const order=await prisma.order.create({data:{userId:user.id,status:"CONFIRMED",totalAmount:100,
  billingRecipientName:"Fixture",billingLine1:"Fixture",billingCity:"Fixture",billingPostcode:"T1",billingCountryCode:"GB",
  deliveryRecipientName:"Fixture",deliveryLine1:"Fixture",deliveryCity:"Fixture",deliveryPostcode:"T1",deliveryCountryCode:"GB",
  orderItems:{create:{productListingId:stock.id,quantity:1,unitPrice:100,lineTotal:100}}}});
 const payment=await prisma.payment.create({data:{orderId:order.id,provider,providerReference:`pi_${randomUUID()}`,amount:100,currency:"GBP",status:"SUCCEEDED",paidAt:new Date()}});
 const token=jwt.sign({id:user.id,role:"ADMIN"},config.JWT_SECRET);
 return {user,order,payment,stock,token};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}
function stripe(f:Fixture,client:StripeRefundClient,key=randomUUID(),amount=10,reason?:string){return createOrReuseStripeRefund(f.order.id,f.payment.id,amount,reason,f.user.id,client,undefined,key);}
function stripeResponse(f:Fixture,id=`re_${randomUUID()}`,status="succeeded",amount=1000){return {id,status,amount,currency:"gbp",payment_intent:f.payment.providerReference,metadata:{}} as any;}
async function amounts(f:Fixture){const p=await prisma.payment.findUniqueOrThrow({where:{id:f.payment.id}});return {reserved:p.reservedRefundAmount.toString(),refunded:p.refundedAmount.toString()};}
function stripeEvent(f:Fixture,refundId:number,reference:string,status="succeeded"){return {id:randomUUID(),type:"refund.updated" as const,refundId:reference,paymentIntentId:f.payment.providerReference,amount:1000,currency:"GBP",status,metadata:{local_refund_id:String(refundId),order_id:String(f.order.id)}};}
// The exact version-2 evidence reconcileStripeRefundEvent derives from a verified Stripe refund event.
function srEvent(f:Fixture,refundId:number,reference:string,status:"PENDING"|"SUCCEEDED"|"FAILED"="SUCCEEDED"):RefundWebhookEvidence{return {version:2,kind:"refund",provider:"STRIPE",id:`evt_${randomUUID()}`,eventType:status==="FAILED"?"refund.failed":"refund.updated",reference,parentReference:f.payment.providerReference,amount:"10.00",currency:"GBP",status,localRefundId:String(refundId),localOrderId:String(f.order.id)};}
async function api(f:Fixture,body:object,key?:string){return fetch(`${base}/orders/${f.order.id}/refunds`,{method:"POST",headers:{Authorization:`Bearer ${f.token}`,"Content-Type":"application/json",...(key?{"Idempotency-Key":key}:{})},body:JSON.stringify(body)});}

it("requires a client key before any new external intent or provider call",async()=>{
 const f=await fixture();let calls=0;restores.push(setStripeRefundClientForTests({createRefund:async()=>{calls++;return stripeResponse(f);}}));
 for(const key of [undefined,"short","bad key "+randomUUID()]){const response=await api(f,{paymentId:f.payment.id,amount:10},key);assert.equal(response.status,400);}
 assert.equal(calls,0);assert.equal(await prisma.refund.count({where:{paymentId:f.payment.id}}),0);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"0"});
});
it("marks an over-capacity Stripe request as definitively not submitted without creating or reserving a refund",async()=>{
 const f=await fixture();let calls=0;restores.push(setStripeRefundClientForTests({createRefund:async()=>{calls++;return stripeResponse(f);}}));
 const key=randomUUID();const response=await api(f,{paymentId:f.payment.id,amount:100.01,reason:"Return amount correction"},key);
 assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:"REFUND_CAPACITY_EXCEEDED",availableRefundAmount:"100.00",refundSubmissionDisposition:"NOT_SUBMITTED",refundRequestKey:key});
 assert.equal(calls,0);assert.equal(await prisma.refund.count({where:{paymentId:f.payment.id}}),0);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"0"});
});
it("read-only refund request status serializes with preparation and returns exact-key evidence",async()=>{
 const f=await fixture();const key=randomUUID();
 const statusUrl=`${base}/orders/${f.order.id}/payments/${f.payment.id}/refund-request-status`;
 const check=()=>fetch(statusUrl,{headers:{Authorization:`Bearer ${f.token}`,"Idempotency-Key":key}});
 const empty=await check();assert.equal(empty.status,200);assert.deepEqual(await empty.json(),{state:"NOT_SUBMITTED",requestKey:key});assert.equal(await prisma.retiredRefundRequestKey.count(),0);
 const saved=await stripe(f,{createRefund:async()=>stripeResponse(f)},key,10,"Return request test");
 const recorded=await check();assert.equal(recorded.status,200);assert.deepEqual(await recorded.json(),{state:"RECORDED",requestKey:key,refund:{refundId:saved.id,status:"SUCCEEDED",amount:"10",currency:"GBP",provider:"STRIPE"}});
 const denied=await fetch(statusUrl,{headers:{"Idempotency-Key":key}});assert.equal(denied.status,401);assert.equal("refundSubmissionDisposition" in await denied.json(),false);
 const unauthenticatedPost=await fetch(`${base}/orders/${f.order.id}/refunds`,{method:"POST",headers:{"Content-Type":"application/json","Idempotency-Key":randomUUID()},body:JSON.stringify({paymentId:f.payment.id,amount:1,reason:"Unauthenticated test"})});
 assert.equal(unauthenticatedPost.status,401);assert.equal("refundSubmissionDisposition" in await unauthenticatedPost.json(),false);
});
it("persists retired keys across independent database clients and blocks later requests",async()=>{
 const f=await fixture(),key=randomUUID();const retirementPath=`${base}/orders/${f.order.id}/payments/${f.payment.id}/refund-request-retirement`;let posts=0;
 const retire=()=>fetch(retirementPath,{method:"POST",headers:{Authorization:`Bearer ${f.token}`,"Idempotency-Key":key,"Content-Type":"application/json"},body:"{}"});
 const first=await retire();assert.equal(first.status,200);assert.deepEqual(await first.json(),{state:"RETIRED",requestKey:key});
 const persisted=await prisma.retiredRefundRequestKey.findUniqueOrThrow({where:{clientRequestKey:key}});assert.equal(persisted.orderId,f.order.id);assert.equal(persisted.paymentId,f.payment.id);
 const independentClient=new PrismaClient({adapter:new PrismaPg(databasePoolOptions(config.DATABASE_URL!,process.env))});
 try{assert.deepEqual(await independentClient.retiredRefundRequestKey.findUniqueOrThrow({where:{clientRequestKey:key},select:{clientRequestKey:true,orderId:true,paymentId:true}}),{clientRequestKey:key,orderId:f.order.id,paymentId:f.payment.id});}
 finally{await independentClient.$disconnect();}
 restores.push(setStripeRefundClientForTests({createRefund:async()=>{posts++;return stripeResponse(f);}}));
 const late=await api(f,{paymentId:f.payment.id,amount:10,reason:"Return request"},key);assert.equal(late.status,409);const body=await late.json();assert.equal(body.error,"REFUND_REQUEST_KEY_RETIRED");assert.equal("refundSubmissionDisposition" in body,false);assert.equal(posts,0);assert.equal(await prisma.refund.count({where:{clientRequestKey:key}}),0);
 const status=await fetch(`${base}/orders/${f.order.id}/payments/${f.payment.id}/refund-request-status`,{headers:{Authorization:`Bearer ${f.token}`,"Idempotency-Key":key}});assert.deepEqual(await status.json(),{state:"RETIRED",requestKey:key});
 const subsequentRequest=await api(f,{paymentId:f.payment.id,amount:10,reason:"Return request"},key);assert.equal(subsequentRequest.status,409);assert.equal(posts,0);
 const corrected=await api(f,{paymentId:f.payment.id,amount:10,reason:"Corrected return request"},randomUUID());assert.equal(corrected.status,201);assert.equal(posts,1);
});
it("serializes simultaneous refund creation and request-key retirement on one global key lock",async()=>{
 const f=await fixture(),key=randomUUID();let posts=0;restores.push(setStripeRefundClientForTests({createRefund:async()=>{posts++;return stripeResponse(f);}}));
 const retirementPath=`${base}/orders/${f.order.id}/payments/${f.payment.id}/refund-request-retirement`;
 const retire=fetch(retirementPath,{method:"POST",headers:{Authorization:`Bearer ${f.token}`,"Idempotency-Key":key,"Content-Type":"application/json"},body:"{}"});
 const submission=api(f,{paymentId:f.payment.id,amount:10,reason:"Concurrent refund request"},key);
 const [retired,response]=await Promise.all([retire,submission]);assert.equal(retired.status,200);const retirement=await retired.json();
 if(retirement.state==="RETIRED"){
   assert.equal(response.status,409);assert.equal((await response.json()).error,"REFUND_REQUEST_KEY_RETIRED");assert.equal(posts,0);assert.equal(await prisma.refund.count({where:{clientRequestKey:key}}),0);
 }else{
   assert.equal(retirement.state,"RECORDED");assert.equal(response.status,201);assert.equal(posts,1);assert.equal(await prisma.retiredRefundRequestKey.count({where:{clientRequestKey:key}}),0);assert.equal(await prisma.refund.count({where:{clientRequestKey:key}}),1);
 }
});
it("marks REFUND_UNRESOLVED safe only for the checked request key and keeps blocker identity separate",async()=>{
 const f=await fixture();const firstKey=randomUUID(),nextKey=randomUUID();let calls=0;
 const client:StripeRefundClient={createRefund:async()=>{calls++;throw new Error("uncertain provider outcome");}};
 await stripe(f,client,firstKey,10,"First request");
 const blocked=await api(f,{paymentId:f.payment.id,amount:10,reason:"Second request"},nextKey);
 const body=await blocked.json();assert.equal(blocked.status,409);assert.equal(body.error,"REFUND_UNRESOLVED");assert.equal(body.refundSubmissionDisposition,"NOT_SUBMITTED");assert.equal(body.refundRequestKey,nextKey);assert.equal(typeof body.blockingRefundId,"number");
 assert.equal("refundId" in body,false);assert.equal("status" in body,false);assert.equal("resolutionCode" in body,false);assert.equal(calls,1);
});
it("lost successful HTTP response replays the original intent; a new key permits a sequential partial refund",async()=>{
 const f=await fixture();let calls=0;const client:StripeRefundClient={createRefund:async()=>{calls++;return stripeResponse(f);}};
 const key=randomUUID();const first=await stripe(f,client,key);const retry=await stripe(f,client,key);assert.equal(retry.id,first.id);assert.equal(calls,1);
 const next=await stripe(f,client);assert.notEqual(next.id,first.id);assert.equal(calls,2);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"20"});
});
it("client key reuse with different amount, reason or payment is rejected",async()=>{
 const f=await fixture(),other=await fixture();let calls=0;const c:StripeRefundClient={createRefund:async()=>{calls++;return stripeResponse(f);}};const key=randomUUID();await stripe(f,c,key,10,"note");
 await assert.rejects(stripe(f,c,key,11,"note"),RefundIntentError);await assert.rejects(stripe(f,c,key,10,"different"),RefundIntentError);
 await assert.rejects(stripe(other,c,key),RefundIntentError);assert.equal(calls,1);
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
it("pending notifications cannot regress success; conflicting terminal evidence requires review",async()=>{
 const f=await fixture(),reference=`re_${randomUUID()}`;const done=await stripe(f,{createRefund:async()=>stripeResponse(f,reference)});
 await reconcileRefundWebhook(srEvent(f,done.id,reference,"PENDING"));assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
 await reconcileRefundWebhook(srEvent(f,done.id,reference,"FAILED"));const current=await prisma.refund.findUniqueOrThrow({where:{id:done.id}});assert.equal(current.status,"SUCCEEDED");assert.equal(current.reviewRequired,true);
 await assert.rejects(stripe(f,{createRefund:async()=>{throw new Error("must not call");}}),RefundIntentError);
});
it("webhook-first Stripe success and a delayed synchronous result account once",async()=>{
 const f=await fixture(),gate=deferred(),entered=deferred();const reference=`re_${randomUUID()}`;const pending=stripe(f,{createRefund:async()=>{entered.resolve();await gate.promise;return stripeResponse(f,reference);}});
 await entered.promise;const local=await prisma.refund.findFirstOrThrow({where:{paymentId:f.payment.id}});await reconcileStripeRefundEvent(stripeEvent(f,local.id,reference));gate.resolve();await pending;assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
});
it("a duplicate completion cannot consume another historical refund's reservation",async()=>{
 const f=await fixture();await prisma.payment.update({where:{id:f.payment.id},data:{reservedRefundAmount:20}});
 const make=()=>prisma.refund.create({data:{orderId:f.order.id,paymentId:f.payment.id,amount:10,currency:"GBP",provider:"STRIPE",status:"PROCESSING",providerReference:`pending:${randomUUID()}`,performedByUserId:f.user.id}});
 const a=await make(),b=await make();const obs={provider:"STRIPE" as const,reference:`re_${randomUUID()}`,parentReference:f.payment.providerReference,amount:"10",currency:"GBP",status:"SUCCEEDED" as const};
 await Promise.all([applyRefundObservation(a.id,obs),applyRefundObservation(a.id,obs),reconcileStripeRefundEvent(stripeEvent(f,a.id,obs.reference))]);
 assert.deepEqual(await amounts(f),{reserved:"10",refunded:"10"});assert.equal((await prisma.refund.findUniqueOrThrow({where:{id:b.id}})).status,"PROCESSING");
});
it("unrelated uniqueness/persistence failures are not acknowledged and committed evidence survives",async()=>{
 const f=await fixture();const pending=await stripe(f,{createRefund:async()=>{throw new Error("lost");}});const e=srEvent(f,pending.id,`re_${randomUUID()}`);
 const saved=await persistRefundWebhookEvidence(e);const failure=Object.assign(new Error("injected persistence failure"),{code:"P2002"});
 const transaction=prisma.$transaction;prisma.$transaction=(()=>Promise.reject(failure)) as typeof prisma.$transaction;
 try{await assert.rejects(processRefundWebhookReceipt(saved.receiptId),error=>error===failure);}finally{prisma.$transaction=transaction;}
 assert.equal((await prisma.paymentWebhookEvent.findUniqueOrThrow({where:{id:saved.receiptId}})).processedAt,null);assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
 await processRefundWebhookReceipt(saved.receiptId);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
});
it("unknown events survive for replay, and conflicting receipt evidence is rejected",async()=>{
 const f=await fixture();const e=srEvent(f,999999999,`re_${randomUUID()}`);assert.equal((await reconcileRefundWebhook(e)).handled,false);
 const receipt=await prisma.paymentWebhookEvent.findUniqueOrThrow({where:{provider_providerEventId:{provider:"STRIPE",providerEventId:e.id}}});assert.equal(receipt.processedAt,null);
 await assert.rejects(reconcileRefundWebhook({...e,amount:"11.00"}));assert.deepEqual((await prisma.paymentWebhookEvent.findUniqueOrThrow({where:{id:receipt.id}})).evidence,e);
});
it("early verified receipt can replay after the exact local refund is committed",async()=>{
 const f=await fixture(),reference=`re_${randomUUID()}`;const localId=Number((await prisma.$queryRaw<Array<{id:number}>>`SELECT nextval(pg_get_serial_sequence('"Refund"','id'))::int AS id`)[0].id);
 const event=srEvent(f,localId,reference);await reconcileRefundWebhook(event);
 await prisma.$transaction(async tx=>{await tx.payment.update({where:{id:f.payment.id},data:{reservedRefundAmount:10}});await tx.refund.create({data:{id:localId,orderId:f.order.id,paymentId:f.payment.id,amount:10,currency:"GBP",provider:"STRIPE",status:"PROCESSING",providerReference:`pending:${randomUUID()}`,performedByUserId:f.user.id}});});
 const receipt=await prisma.paymentWebhookEvent.findUniqueOrThrow({where:{provider_providerEventId:{provider:"STRIPE",providerEventId:event.id}}});await processRefundWebhookReceipt(receipt.id);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
});
it("manual GET fallback is disabled by default and never resubmits a legacy refund",async()=>{
 assert.equal(config.REFUND_RECONCILIATION_ENABLED,false);const f=await fixture();let posts=0;
 const pending=await stripe(f,{createRefund:async()=>{posts++;throw new Error("lost");}});
 await assert.rejects(reconcileExternalRefund(f.order.id,pending.id),RefundIntentError);config.REFUND_RECONCILIATION_ENABLED=true;
 // A lost Stripe response is now located by its metadata; without a provider read it stays unresolved.
 const result=await reconcileExternalRefund(f.order.id,pending.id);assert.equal(result.status,"PROCESSING");assert.equal(result.resolutionCode,"RECONCILIATION_UNAVAILABLE");assert.equal(posts,1);assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
});
it("manual reconciliation GET attempts are durably capped at eight even concurrently",async()=>{
 const f=await fixture(),reference=`re_${randomUUID()}`;let gets=0;const c:StripeRefundClient={createRefund:async()=>stripeResponse(f,reference,"pending"),retrieveRefund:async()=>{gets++;throw new Error("outage");}};
 const pending=await stripe(f,c);restores.push(setStripeRefundClientForTests(c));config.REFUND_RECONCILIATION_ENABLED=true;
 await Promise.all(Array.from({length:10},()=>reconcileExternalRefund(f.order.id,pending.id)));assert.equal(gets,8);const result=await prisma.refund.findUniqueOrThrow({where:{id:pending.id}});assert.equal(result.reconciliationAttempts,8);assert.equal(result.reviewRequired,true);assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
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
 const conflict=await api(f,{paymentId:f.payment.id,amount:10},randomUUID());assert.equal(conflict.status,409);const conflictBody=await conflict.json();assert.equal(conflictBody.blockingRefundId,body.refundId);assert.equal(conflictBody.blockingRefundStatus,"PROCESSING");assert.equal("refundId" in conflictBody,false);assert.equal("status" in conflictBody,false);assert.equal(calls,1);
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

it("conflicting Stripe metadata cannot finalize money",async()=>{
 const a=await fixture();const response=stripeResponse(a);response.metadata={local_refund_id:"999999999"};assert.equal((await stripe(a,{createRefund:async()=>response})).reviewRequired,true);assert.deepEqual(await amounts(a),{reserved:"10",refunded:"0"});
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
it("post-submission capacity failure retains the refund identity and never claims NOT_SUBMITTED",async()=>{
 const f=await fixture(),key=randomUUID();let calls=0;
 restores.push(setStripeRefundClientForTests({createRefund:async()=>{calls++;await prisma.payment.update({where:{id:f.payment.id},data:{amount:5}});return stripeResponse(f);}}));
 const response=await api(f,{paymentId:f.payment.id,amount:10,reason:"Post submission capacity race"},key);assert.equal(response.status,503);
 const body=await response.json();assert.equal(body.error,"REFUND_PERSISTENCE_UNAVAILABLE");assert.equal(body.status,"UNKNOWN");assert.ok(body.refundId);assert.equal("refundSubmissionDisposition" in body,false);assert.equal("refundRequestKey" in body,false);
 const saved=await prisma.refund.findUniqueOrThrow({where:{clientRequestKey:key}});assert.equal(saved.status,"PROCESSING");assert.equal(saved.resolutionCode,"SUBMISSION_STARTED");assert.equal(calls,1);assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
});

it("uncorrelated verified refund evidence for the exact provider parent blocks new payouts",async()=>{
 const f=await fixture();const event=srEvent(f,999999999,`re_${randomUUID()}`);await reconcileRefundWebhook(event);let posts=0;
 await assert.rejects(stripe(f,{createRefund:async()=>{posts++;return stripeResponse(f);}}),(error:unknown)=>error instanceof RefundIntentError&&error.code==="REFUND_PROVIDER_EVIDENCE_UNRESOLVED");
 assert.equal(posts,0);assert.equal(await prisma.refund.count({where:{paymentId:f.payment.id}}),0);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"0"});
});

for(const environment of ["live","sandbox"]){
}
// G1: a Stripe refusal releases reserved capacity only when it is definitive AND a complete lookup corroborates it.
const refusal=(code:string,statusCode=400)=>new Stripe.errors.StripeInvalidRequestError({message:"private",type:"invalid_request_error",code,statusCode});
const listed=(data:any[],has_more=false)=>({data,has_more});
const localRefundId=(input:Stripe.RefundCreateParams)=>String((input.metadata as Record<string,string>).local_refund_id);
function ours(f:Fixture,localId:string,status="succeeded",orderId=String(f.order.id)){return {...stripeResponse(f,`re_${randomUUID()}`,status),metadata:{local_refund_id:localId,order_id:orderId}};}
it("documented Stripe refusals with a complete empty lookup fail once and release capacity",async()=>{
 for(const code of ["refund_disputed_payment","amount_too_large","amount_too_small"]){
  const f=await fixture(),key=randomUUID();let posts=0,lists=0;
  const c:StripeRefundClient={createRefund:async()=>{posts++;throw refusal(code);},listRefunds:async pi=>{lists++;assert.equal(pi,f.payment.providerReference);return listed([ours(f,"999999999")]);}};
  const failed=await stripe(f,c,key);
  assert.equal(failed.status,"FAILED");assert.equal((failed.providerOutcome as any).rejectionCode,code);assert.equal(lists,1);
  assert.equal((await stripe(f,c,key)).id,failed.id);assert.equal(posts,1);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"0"});
 }
});
it("a definitive refusal is never failed on an unavailable, incomplete or malformed lookup",async()=>{
 const lookups:Array<StripeRefundClient["listRefunds"]>=[undefined,async()=>{throw new Error("network");},async()=>listed([],true),async()=>({} as any),async()=>null as any];
 for(const listRefunds of lookups){
  const f=await fixture();const result=await stripe(f,{createRefund:async()=>{throw refusal("refund_disputed_payment");},...(listRefunds?{listRefunds}:{})});
  assert.equal(result.status,"PROCESSING");assert.equal(result.resolutionCode,"PROVIDER_REJECTION_UNCORROBORATED");assert.equal(result.reviewRequired,false);
  assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
 }
});
it("a refusal contradicted by our own provider refund adopts it; a partial correlation requires review",async()=>{
 const f=await fixture();let localId="";
 const adopted=await stripe(f,{createRefund:async input=>{localId=localRefundId(input);throw refusal("amount_too_large");},listRefunds:async()=>listed([ours(f,localId)])});
 assert.equal(adopted.status,"SUCCEEDED");assert.match(adopted.providerReference,/^re_/);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
 const g=await fixture();let gId="";
 const review=await stripe(g,{createRefund:async input=>{gId=localRefundId(input);throw refusal("amount_too_large");},listRefunds:async()=>listed([ours(g,gId,"succeeded","1")])});
 assert.equal(review.status,"PROCESSING");assert.equal(review.reviewRequired,true);assert.equal(review.resolutionCode,"PROVIDER_EVIDENCE_MISMATCH");assert.deepEqual(await amounts(g),{reserved:"10",refunded:"0"});
});
it("ambiguous, retryable and unclassified Stripe outcomes stay unresolved without any lookup",async()=>{
 const errors:Array<[unknown,string]>=[
  [new Stripe.errors.StripeConnectionError({message:"reset",type:"api_error"}),"PROVIDER_OUTCOME_UNKNOWN"],
  [new Stripe.errors.StripeAPIError({message:"server",type:"api_error",statusCode:500}),"PROVIDER_OUTCOME_UNKNOWN"],
  [new Stripe.errors.StripeIdempotencyError({message:"in use",type:"idempotency_error",code:"idempotency_key_in_use",statusCode:409}),"PROVIDER_OUTCOME_UNKNOWN"],
  [new Stripe.errors.StripeRateLimitError({message:"lock",type:"invalid_request_error",code:"lock_timeout",statusCode:429}),"PROVIDER_RETRY_LATER"],
  [refusal("charge_already_refunded"),"PROVIDER_OUTCOME_UNKNOWN"],
  [new Stripe.errors.StripeCardError({message:"card",type:"card_error",code:"refund_disputed_payment",statusCode:402}),"PROVIDER_OUTCOME_UNKNOWN"],
  [new Error("timeout"),"PROVIDER_OUTCOME_UNKNOWN"]];
 for(const [error,code] of errors){
  const f=await fixture();let lists=0;
  const result=await stripe(f,{createRefund:async()=>{throw error;},listRefunds:async()=>{lists++;return listed([]);}});
  assert.equal(result.status,"PROCESSING");assert.equal(result.resolutionCode,code);assert.equal(lists,0);assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
 }
});
it("reconciliation adopts a lost-response Stripe refund by its metadata and never fails it on absence",async()=>{
 const f=await fixture();let posts=0,localId="",found=false;
 const c:StripeRefundClient={createRefund:async input=>{posts++;localId=localRefundId(input);throw new Error("lost");},
  listRefunds:async()=>listed(found?[ours(f,localId)]:[ours(f,"1")])};
 const pending=await stripe(f,c);restores.push(setStripeRefundClientForTests(c));config.REFUND_RECONCILIATION_ENABLED=true;
 const absent=await reconcileExternalRefund(f.order.id,pending.id);
 assert.equal(absent.status,"PROCESSING");assert.equal(absent.resolutionCode,"PROVIDER_REFUND_NOT_FOUND");assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
 found=true;const done=await reconcileExternalRefund(f.order.id,pending.id);
 assert.equal(done.status,"SUCCEEDED");assert.equal(posts,1);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
});
it("reconciliation completes an uncorroborated definitive refusal only with a complete empty lookup",async()=>{
 const f=await fixture();let complete=false;
 const c:StripeRefundClient={createRefund:async()=>{throw refusal("refund_disputed_payment");},listRefunds:async()=>{if(!complete)throw new Error("network");return listed([]);}};
 const pending=await stripe(f,c);assert.equal(pending.resolutionCode,"PROVIDER_REJECTION_UNCORROBORATED");
 restores.push(setStripeRefundClientForTests(c));config.REFUND_RECONCILIATION_ENABLED=true;
 assert.equal((await reconcileExternalRefund(f.order.id,pending.id)).status,"PROCESSING");assert.deepEqual(await amounts(f),{reserved:"10",refunded:"0"});
 complete=true;const failed=await reconcileExternalRefund(f.order.id,pending.id);
 assert.equal(failed.status,"FAILED");assert.equal((failed.providerOutcome as any).rejectionCode,"refund_disputed_payment");assert.deepEqual(await amounts(f),{reserved:"0",refunded:"0"});
});
async function disputeReceipt(f:Fixture,status:string){await prisma.paymentWebhookEvent.create({data:{provider:"STRIPE",providerEventId:`evt_${randomUUID()}`,eventType:"charge.dispute.created",
 processedAt:new Date(),processingError:"STRIPE_DISPUTE_REVIEW_REQUIRED",evidence:{kind:"stripe-dispute",version:1,disputeId:`dp_${randomUUID()}`,paymentIntentId:f.payment.providerReference,status,amount:10000,currency:"gbp"}}});}
it("a formal Stripe dispute refuses new refunds before reserving capacity; inquiries stay refundable",async()=>{
 const f=await fixture();await disputeReceipt(f,"needs_response");let posts=0;
 await assert.rejects(stripe(f,{createRefund:async()=>{posts++;return stripeResponse(f);}}),(e:unknown)=>e instanceof RefundIntentError&&e.code==="PAYMENT_DISPUTED");
 assert.equal(posts,0);assert.equal(await prisma.refund.count({where:{paymentId:f.payment.id}}),0);assert.deepEqual(await amounts(f),{reserved:"0",refunded:"0"});
 const g=await fixture();await disputeReceipt(g,"warning_needs_response");
 assert.equal((await stripe(g,{createRefund:async()=>stripeResponse(g)})).status,"SUCCEEDED");
});
it("concurrent Stripe refund requests with different keys never exceed capacity",async()=>{
 const f=await fixture();const entered=deferred(),gate=deferred();
 const first=stripe(f,{createRefund:async()=>{entered.resolve();await gate.promise;return stripeResponse(f);}},randomUUID(),10);
 await entered.promise;
 await assert.rejects(stripe(f,{createRefund:async()=>stripeResponse(f)},randomUUID(),95),(e:unknown)=>e instanceof RefundIntentError&&e.code==="REFUND_UNRESOLVED");
 gate.resolve();assert.equal((await first).status,"SUCCEEDED");assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
 await assert.rejects(stripe(f,{createRefund:async()=>stripeResponse(f)},randomUUID(),95));
 assert.deepEqual(await amounts(f),{reserved:"0",refunded:"10"});
});
