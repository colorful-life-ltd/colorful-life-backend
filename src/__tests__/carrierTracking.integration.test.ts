import { chargeTrackingBudget } from "../domain/tracking/trackingBudget.js";
import assert from "node:assert/strict";
import { before, after, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { prisma } from "../prisma/runtime.js";
import { config } from "../config/index.js";
import { databaseNow } from "../domain/payments/paymentResolutionService.js";
import { ingestTrackingObservation } from "../domain/tracking/trackingService.js";
import { TrackingConflictError, TrackingEligibilityError, TrackingProviderError, type TrackingObservation, type CanonicalTrackingEvent } from "../domain/tracking/trackingContract.js";
import { FakeCarrierTrackingAdapter } from "../domain/tracking/fakeCarrierAdapter.js";
import { configureTrackingSync, runTrackingPoll } from "../domain/tracking/trackingPoller.js";
import { getCustomerOrder, listAdminOrders } from "../domain/orders/orderReadService.js";
import { recordVerifiedPayment } from "./fixtures/verifiedPayment.js";
import { dispatchShipment, startPreparing } from "../domain/fulfilment/fulfilmentService.js";

const previous=config.CARRIER_TRACKING_POLLING_ENABLED;
let server:ReturnType<typeof app.listen>,base:string;
before(async()=>{server=app.listen(0);await new Promise<void>(r=>server.once("listening",r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
after(async()=>{config.CARRIER_TRACKING_POLLING_ENABLED=previous;await new Promise<void>(r=>server.close(()=>r()));await prisma.$disconnect();});
async function fixture({preparing=false,historical=false,carrier="ROYAL_MAIL" as "ROYAL_MAIL"|"EVRI"|"DPD"}={}){
 const user=await prisma.user.create({data:{email:`${randomUUID()}@tracking.test`,passwordHash:"fixture",role:"CUSTOMER",emailVerified:true}});
 const admin=await prisma.user.create({data:{email:`${randomUUID()}@tracking.test`,passwordHash:"fixture",role:"ADMIN",emailVerified:true}});
 const product=await prisma.legoProduct.create({data:{setNumber:randomUUID(),title:"Tracking fixture",theme:"TRACKING",ageRecommendation:"8+",pieceCount:1}});
 const listing=await prisma.productListing.create({data:{legoProductId:product.id,condition:"NEW",originalPrice:10,currentStock:5,reservedStock:2}});
 const at=await prisma.$transaction(databaseNow);const tracking=carrier==="ROYAL_MAIL"?"AB123456789GB":carrier==="EVRI"?"1234567890123456":"12345678901234";
 const order=await prisma.order.create({data:{userId:user.id,status:historical?"DISPATCHED":"CONFIRMED",totalAmount:20,
  ...(historical?{shippingCarrier:"Royal Mail",trackingNumber:tracking,dispatchedAt:new Date(at.getTime()-86_400_000)}:{}),
  billingRecipientName:"Fixture",billingLine1:"Fixture",billingCity:"Fixture",billingPostcode:"T1",billingCountryCode:"GB",
  deliveryRecipientName:"Fixture",deliveryLine1:"Fixture",deliveryCity:"Fixture",deliveryPostcode:"T1",deliveryCountryCode:"GB",
  orderItems:{create:{productListingId:listing.id,quantity:2,unitPrice:10,lineTotal:20}}}});
 const payment=await recordVerifiedPayment(order.id);
 if(!historical){if(preparing)await startPreparing(admin.id,order.id);await dispatchShipment(admin.id,order.id,{carrier,carrierName:carrier==="ROYAL_MAIL"?"Royal Mail":carrier==="EVRI"?"Evri":"DPD",trackingNumber:tracking,actualShippingCost:3});}
 const shipment=await prisma.shipment.findFirst({where:{orderId:order.id}});
 const providerIdentity=`fake-${randomUUID()}`;
 const token=jwt.sign({id:user.id,role:"CUSTOMER"},config.JWT_SECRET),adminToken=jwt.sign({id:admin.id,role:"ADMIN"},config.JWT_SECRET);
 return {user,admin,order,payment,listing,shipment,providerIdentity,carrier,tracking,token,adminToken};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function occurrence(f:Fixture,offset=0){return new Date(f.shipment!.dispatchedAt.getTime()+offset);}
function event(at:Date,status:CanonicalTrackingEvent["status"],patch:Partial<CanonicalTrackingEvent>={}):CanonicalTrackingEvent{
 return {providerEventId:randomUUID(),providerStatus:`TEST_${status}`,occurredAt:at,status,exception:status==="EXCEPTION"?"DELAY":null,
  deliveryConfirmed:status==="DELIVERED",deliveryAt:status==="DELIVERED"?at:null,evidenceReference:status==="DELIVERED"?"fixture-confirmation":null,...patch};
}
function observation(f:Fixture,events:CanonicalTrackingEvent[],patch:Partial<TrackingObservation>={}):TrackingObservation{return {carrier:f.carrier,providerIdentity:f.providerIdentity,trackingNumber:f.tracking,source:"TEST_FIXTURE",verified:true,events,...patch};}
async function ingest(f:Fixture,events:CanonicalTrackingEvent[],patch:Partial<TrackingObservation>={}){return ingestTrackingObservation(f.shipment!.id,observation(f,events,patch));}
async function state(f:Fixture){return prisma.shipmentTrackingState.findUniqueOrThrow({where:{shipmentId:f.shipment!.id}});}
async function safeOrder(f:Fixture){return (await getCustomerOrder(f.user.id,f.order.id))!;}
async function snapshot(f:Fixture){return {order:await prisma.order.findUniqueOrThrow({where:{id:f.order.id}}),payment:await prisma.payment.findUniqueOrThrow({where:{id:f.payment.id}}),stock:await prisma.productListing.findUniqueOrThrow({where:{id:f.listing.id}}),refunds:await prisma.refund.findMany({where:{orderId:f.order.id},orderBy:{id:"asc"}}),inventory:await prisma.inventoryMovement.count({where:{listingId:f.listing.id}}),resolution:await prisma.paymentResolution.findUnique({where:{orderId:f.order.id}})};}
function adapter(f:Fixture,responses:ConstructorParameters<typeof FakeCarrierTrackingAdapter>[2],available=true){return new FakeCarrierTrackingAdapter(f.carrier,f.providerIdentity,responses,available);}
async function enabled(f:Fixture,responses:ConstructorParameters<typeof FakeCarrierTrackingAdapter>[2],available=true){const a=adapter(f,responses,available);await configureTrackingSync(f.shipment!.id,a,true);return a;}
async function poll(a:FakeCarrierTrackingAdapter,policy:NonNullable<Parameters<typeof runTrackingPoll>[0]>["policy"]={}){config.CARRIER_TRACKING_POLLING_ENABLED=true;return runTrackingPoll({adapters:new Map([[a.carrier,a]]),policy});}
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>resolve=r);return {promise,resolve};}

it("Dispatch -> In Transit -> Delivered keeps Order/payment/refund/inventory unchanged",async()=>{
 const f=await fixture();const before=await snapshot(f);const at=await occurrence(f);await ingest(f,[event(at,"IN_TRANSIT")]);assert.equal((await safeOrder(f)).fulfilment.stage,"IN_TRANSIT");
 await ingest(f,[event(at,"DELIVERED")]);assert.equal((await safeOrder(f)).fulfilment.stage,"DELIVERED");assert.deepEqual(await snapshot(f),before);
 assert.equal((await state(f)).progress,"DELIVERED");
});
it("Preparing is optional and preserved through tracked dispatch",async()=>{
 const f=await fixture({preparing:true});await ingest(f,[event(await occurrence(f),"DELIVERED")]);assert.ok((await safeOrder(f)).fulfilment.preparingAt);assert.equal((await safeOrder(f)).fulfilment.stage,"DELIVERED");
});
it("invalid, missing and future delivery proof never marks Delivered",async()=>{
 const f=await fixture();const at=await occurrence(f);
 for(const patch of [{deliveryConfirmed:false},{deliveryAt:null},{evidenceReference:null},{deliveryAt:new Date(at.getTime()-1)}])await ingest(f,[event(at,"DELIVERED",patch)]);
 await ingest(f,[event(new Date((await prisma.$transaction(databaseNow)).getTime()+86_400_000),"DELIVERED")]);
 assert.equal((await state(f)).progress,"DISPATCHED");assert.equal((await safeOrder(f)).fulfilment.stage,"DISPATCHED");assert.equal(await prisma.shipmentTrackingEvent.count({where:{shipmentId:f.shipment!.id,disposition:"REJECTED"}}),5);
});
it("unverified evidence cannot advance any progress",async()=>{
 const f=await fixture();await ingest(f,[event(await occurrence(f),"DELIVERED")],{verified:false});assert.equal((await state(f)).progress,"DISPATCHED");
});
it("events before dispatch are retained as rejected evidence",async()=>{
 const f=await fixture();await ingest(f,[event(new Date(f.shipment!.dispatchedAt.getTime()-1000),"DELIVERED")]);assert.equal((await state(f)).progress,"DISPATCHED");
});
it("exceptions are separate from progress and clear only on newer movement",async()=>{
 const f=await fixture();const at=await occurrence(f);await ingest(f,[event(at,"IN_TRANSIT"),event(at,"EXCEPTION")]);assert.equal((await state(f)).exception,"DELAY");
 await ingest(f,[event(at,"IN_TRANSIT")]);assert.equal((await state(f)).exception,"DELAY");
 await ingest(f,[event(at,"DELIVERED")]);assert.equal((await state(f)).exception,null);await ingest(f,[event(at,"EXCEPTION")]);assert.equal((await state(f)).exception,null);
});
it("unknown status is preserved without fabricating progression",async()=>{
 const f=await fixture();await ingest(f,[event(await occurrence(f),"UNKNOWN",{providerStatus:"TEST_NEW_UNDOCUMENTED_CODE"})]);assert.equal((await state(f)).progress,"DISPATCHED");assert.equal((await prisma.shipmentTrackingEvent.findFirstOrThrow({where:{shipmentId:f.shipment!.id}})).disposition,"UNKNOWN");
});
it("same event and independent concurrent deliveries deduplicate across PostgreSQL transactions",async()=>{
 const f=await fixture();const delivery=event(await occurrence(f),"DELIVERED");const results=await Promise.all([ingest(f,[delivery]),ingest(f,[delivery]),ingest(f,[delivery])]);
 assert.equal(results.reduce((sum,r)=>sum+r.applied,0),1);assert.equal(await prisma.shipmentTrackingEvent.count({where:{shipmentId:f.shipment!.id}}),1);assert.equal((await state(f)).version,1);
});
it("out-of-order movement and dispatch cannot regress Delivered",async()=>{
 const f=await fixture();const at=await occurrence(f);await ingest(f,[event(at,"DELIVERED")]);await ingest(f,[event(at,"IN_TRANSIT"),event(at,"DISPATCHED")]);assert.equal((await state(f)).progress,"DELIVERED");
});
it("stale delivery cannot supersede a later scan or delivery exception",async()=>{
 const f=await fixture();const at=await occurrence(f);await new Promise(r=>setTimeout(r,20));const later=new Date(at.getTime()+10);
 await ingest(f,[event(later,"IN_TRANSIT")]);await ingest(f,[event(at,"DELIVERED")]);assert.equal((await state(f)).progress,"IN_TRANSIT");
 const g=await fixture();const first=await occurrence(g);await new Promise(r=>setTimeout(r,20));await ingest(g,[event(new Date(first.getTime()+10),"EXCEPTION")]);await ingest(g,[event(first,"DELIVERED")]);assert.equal((await state(g)).progress,"DISPATCHED");
});
it("genuine conflicts preserve evidence without discarding independent valid events",async()=>{
 const f=await fixture();const e=event(await occurrence(f),"IN_TRANSIT");await ingest(f,[e]);
 const result=await ingest(f,[event(e.occurredAt,"DELIVERED"),{...e,providerStatus:"TEST_CHANGED"}]);
 assert.equal(result.conflicts,1);assert.equal(result.applied,1);assert.equal((await state(f)).progress,"DELIVERED");
 assert.equal(await prisma.shipmentTrackingEvent.count({where:{shipmentId:f.shipment!.id}}),2);
 assert.equal((await ingest(f,[{...e,providerStatus:"TEST_CHANGED"}])).conflicts,1);
 assert.equal(await prisma.shipmentTrackingConflict.count({where:{originalEvent:{shipmentId:f.shipment!.id}}}),1);
});
it("conflicting delivery confirmations do not overwrite established proof",async()=>{
 const f=await fixture();const at=await occurrence(f);await ingest(f,[event(at,"DELIVERED")]);const proof=(await state(f)).deliveredEventId;
 await new Promise(r=>setTimeout(r,20));await ingest(f,[event(new Date(at.getTime()+10),"DELIVERED")]);assert.equal((await state(f)).deliveredEventId,proof);assert.equal(await prisma.shipmentTrackingEvent.count({where:{shipmentId:f.shipment!.id,reason:"DELIVERY_CONFLICT"}}),1);
});
it("all registered shipments need proof before aggregate Delivered",async()=>{
 const f=await fixture();const extra=await prisma.shipment.create({data:{orderId:f.order.id,sequence:2,carrier:f.carrier,carrierName:"Royal Mail",trackingNumber:"CD987654321GB",dispatchedAt:f.shipment!.dispatchedAt,createdByUserId:f.admin.id}});
 await ingest(f,[event(await occurrence(f),"DELIVERED")]);assert.equal((await safeOrder(f)).fulfilment.stage,"IN_TRANSIT");
 await ingestTrackingObservation(extra.id,{...observation(f,[event(await occurrence(f),"DELIVERED")]),trackingNumber:extra.trackingNumber!});assert.equal((await safeOrder(f)).fulfilment.stage,"DELIVERED");
});
it("historical dispatched/completed orders without evidence remain Dispatched",async()=>{
 const f=await fixture({historical:true});assert.equal((await safeOrder(f)).fulfilment.stage,"DISPATCHED");assert.equal((await safeOrder(f)).fulfilment.shipments.length,1);assert.equal(await prisma.shipment.count({where:{orderId:f.order.id}}),0);
 await prisma.order.update({where:{id:f.order.id},data:{status:"COMPLETED",completedAt:await prisma.$transaction(databaseNow)}});assert.equal((await safeOrder(f)).fulfilment.stage,"DISPATCHED");
});
it("shipment identity and never-dispatched orders reject tracking ingestion",async()=>{
 const f=await fixture();await assert.rejects(ingest(f,[event(await occurrence(f),"DELIVERED")],{trackingNumber:"ZZ123456789GB"}),TrackingEligibilityError);
 await prisma.order.update({where:{id:f.order.id},data:{status:"CONFIRMED",dispatchedAt:null}});await assert.rejects(ingest(f,[]),TrackingEligibilityError);
});
it("customer/admin projections enforce ownership and never expose internal evidence",async()=>{
 const f=await fixture();await ingest(f,[event(await occurrence(f),"DELIVERED")]);
 const json=JSON.stringify(await safeOrder(f));assert.ok(!json.includes(f.providerIdentity));assert.ok(!json.includes("fixture-confirmation"));assert.ok(!json.includes("TEST_DELIVERED"));assert.ok(!json.includes("fingerprint"));
 const other=await fixture();const headers={Authorization:`Bearer ${other.token}`};assert.equal((await fetch(`${base}/orders/${f.order.id}`,{headers})).status,404);
 assert.equal((await fetch(`${base}/admin/orders/${f.order.id}`,{headers})).status,403);assert.equal((await fetch(`${base}/orders/${f.order.id}`)).status,401);
 const admin=await fetch(`${base}/admin/orders/${f.order.id}`,{headers:{Authorization:`Bearer ${f.adminToken}`}});assert.equal(admin.status,200);const body=await admin.json();assert.equal(body.fulfilmentStage,"DELIVERED");assert.ok(!JSON.stringify(body).includes("fixture-confirmation"));
 const rank=await prisma.order.count({where:{OR:[{createdAt:{gt:f.order.createdAt}},{createdAt:f.order.createdAt,id:{gt:f.order.id}}]}});
 const list=await listAdminOrders({page:Math.floor(rank/50)+1,pageSize:50});const item=list.items.find(o=>o.id===f.order.id);assert.ok(item);assert.equal(item.fulfilmentStage,"DELIVERED");
});
it("database rejects false Delivered, cross-shipment proof, regression and identity mutation",async()=>{
 const f=await fixture();await assert.rejects(prisma.shipmentTrackingState.create({data:{shipmentId:f.shipment!.id,progress:"DELIVERED"}}));
 await ingest(f,[event(await occurrence(f),"IN_TRANSIT")]);await assert.rejects(prisma.shipmentTrackingState.update({where:{shipmentId:f.shipment!.id},data:{progress:"DISPATCHED"}}),/cannot regress/);
 const g=await fixture();await ingest(g,[event(await occurrence(g),"DELIVERED")]);const proof=await state(g);
 await assert.rejects(prisma.shipmentTrackingState.update({where:{shipmentId:f.shipment!.id},data:{progress:"DELIVERED",deliveredEventId:proof.deliveredEventId,lastEventId:proof.lastEventId,lastEventAt:proof.lastEventAt}}),/evidence mismatch/);
 await assert.rejects(prisma.shipment.update({where:{id:g.shipment!.id},data:{trackingNumber:"CD987654321GB"}}),/immutable/);
 await assert.rejects(prisma.shipmentTrackingEvent.update({where:{id:proof.deliveredEventId!},data:{providerStatus:"CHANGED"}}),/immutable/);
});
it("same provider ID on different shipments is scoped, not a global uniqueness failure",async()=>{
 const f=await fixture(),g=await fixture();const e=event(await occurrence(f),"IN_TRANSIT");await ingest(f,[e]);await ingest(g,[{...e,occurredAt:await occurrence(g)}],{providerIdentity:f.providerIdentity});assert.equal((await state(g)).progress,"IN_TRANSIT");
});
it("API and webhook evidence coalesce the same verified event",async()=>{
 const f=await fixture();const e=event(await occurrence(f),"IN_TRANSIT");await ingest(f,[e],{source:"AUTHENTICATED_API"});assert.equal((await ingest(f,[e],{source:"VERIFIED_WEBHOOK"})).duplicates,1);
});

it("polling disabled makes no requests or journals",async()=>{
 const f=await fixture();const a=await enabled(f,[observation(f,[])]);config.CARRIER_TRACKING_POLLING_ENABLED=false;const result=await runTrackingPoll({adapters:new Map([[a.carrier,a]])});assert.ok(result.disabled);assert.equal(a.calls,0);assert.equal(await prisma.shipmentTrackingPoll.count({where:{shipmentId:f.shipment!.id}}),0);
});
it("no real adapters/credentials available never causes a network call",async()=>{
 config.CARRIER_TRACKING_POLLING_ENABLED=true;assert.equal((await runTrackingPoll()).requests,0);
 const f=await fixture();const a=adapter(f,[],false);await assert.rejects(configureTrackingSync(f.shipment!.id,a,true));
});
it("successful polling journals before I/O, records proof and stops after Delivered",async()=>{
 const f=await fixture();const a=await enabled(f,[async()=>{const sync=await prisma.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:f.shipment!.id}});assert.ok(sync.claimOwner);assert.equal(sync.totalRequests,1);assert.equal(await prisma.shipmentTrackingPoll.count({where:{shipmentId:f.shipment!.id,outcome:"PENDING"}}),1);return observation(f,[event(await occurrence(f),"DELIVERED")]);}]);
 const result=await poll(a);assert.equal(result.successes,1);assert.equal((await state(f)).progress,"DELIVERED");assert.equal((await prisma.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:f.shipment!.id}})).enabled,false);await poll(a);assert.equal(a.calls,1);
});
it("temporary failure backs off and retry succeeds without resetting lifetime requests",async()=>{
 const f=await fixture();const a=await enabled(f,[new TrackingProviderError("TEMPORARY"),observation(f,[event(await occurrence(f),"IN_TRANSIT")])]);await poll(a);let sync=await prisma.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:f.shipment!.id}});assert.equal(sync.consecutiveFailures,1);assert.ok(sync.nextPollAt!>await prisma.$transaction(databaseNow));
 await prisma.shipmentTrackingSync.update({where:{shipmentId:f.shipment!.id},data:{nextPollAt:null}});await poll(a);sync=await prisma.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:f.shipment!.id}});assert.equal(sync.consecutiveFailures,0);assert.equal(sync.totalRequests,2);
});
it("permanent errors stop polling without exposing provider messages",async()=>{
 const f=await fixture();const a=await enabled(f,[new TrackingProviderError("PERMANENT")]);await poll(a);const sync=await prisma.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:f.shipment!.id}});assert.equal(sync.enabled,false);assert.equal(sync.lastErrorCode,"PERMANENT");
});
it("retry exhaustion survives re-enabling and does not create an infinite loop",async()=>{
 const f=await fixture();const a=await enabled(f,[new TrackingProviderError("TEMPORARY"),new TrackingProviderError("TEMPORARY")]);await poll(a,{maxFailures:1});await configureTrackingSync(f.shipment!.id,a,true);await poll(a,{maxFailures:1});assert.equal(a.calls,1);
});
it("timeout fences late adapter results and releases the lease",async()=>{
 const f=await fixture();const gate=deferred();const a=await enabled(f,[async()=>{await gate.promise;return observation(f,[event(await occurrence(f),"DELIVERED")]);}]);const result=await poll(a,{timeoutMs:10});assert.equal(result.failures,1);assert.equal((await prisma.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:f.shipment!.id}})).lastErrorCode,"TIMEOUT");gate.resolve();await new Promise(r=>setTimeout(r,10));assert.equal(await prisma.shipmentTrackingEvent.count({where:{shipmentId:f.shipment!.id}}),0);
});
it("concurrent polling instances cannot double-request the same shipment",async()=>{
 const f=await fixture();const entered=deferred(),gate=deferred();const a=await enabled(f,[async()=>{entered.resolve();await gate.promise;return observation(f,[]);}]);const one=poll(a);await entered.promise;const two=await poll(a);assert.equal(two.requests,0);gate.resolve();await one;assert.equal(a.calls,1);
});
it("durable carrier rate limit is shared across different shipments and instances",async()=>{
 const f=await fixture(),g=await fixture();g.providerIdentity=f.providerIdentity;const a=adapter(f,[observation(f,[]),observation(g,[])]);await configureTrackingSync(f.shipment!.id,a,true);await configureTrackingSync(g.shipment!.id,a,true);
 const result=await poll(a,{perMinute:1});assert.equal(result.requests,1);assert.equal(result.budgetDenied,1);assert.equal(a.calls,1);
});
it("per-run and daily request budgets stop additional calls",async()=>{
 const f=await fixture(),g=await fixture();g.providerIdentity=f.providerIdentity;const a=adapter(f,[observation(f,[]),observation(g,[])]);await configureTrackingSync(f.shipment!.id,a,true);await configureTrackingSync(g.shipment!.id,a,true);
 const first=await poll(a,{maxRequests:1,perDay:1});assert.equal(first.requests,1);const second=await poll(a,{perDay:1});assert.equal(second.requests,0);assert.equal(second.budgetDenied,1);assert.equal(a.calls,1);
});
it("disabling an in-flight poll fences completion and records cancellation",async()=>{
 const f=await fixture();const entered=deferred(),gate=deferred();const a=await enabled(f,[async()=>{entered.resolve();await gate.promise;return observation(f,[event(await occurrence(f),"DELIVERED")]);}]);const pending=poll(a);await entered.promise;await configureTrackingSync(f.shipment!.id,a,false);gate.resolve();const result=await pending;assert.equal(result.staleClaims,1);assert.equal(await prisma.shipmentTrackingEvent.count({where:{shipmentId:f.shipment!.id}}),0);assert.equal((await prisma.shipmentTrackingPoll.findFirstOrThrow({where:{shipmentId:f.shipment!.id}})).outcome,"ABORTED");
});
it("crashed claims are discoverable and fenced after lease recovery",async()=>{
 const f=await fixture();const entered=deferred(),gate=deferred();const a=await enabled(f,[async()=>{entered.resolve();await gate.promise;return observation(f,[event(await occurrence(f),"DELIVERED")]);},observation(f,[event(await occurrence(f),"IN_TRANSIT")])]);
 const old=poll(a);await entered.promise;await prisma.shipmentTrackingSync.update({where:{shipmentId:f.shipment!.id},data:{leaseExpiresAt:new Date((await prisma.$transaction(databaseNow)).getTime()-1000)}});const recovered=await poll(a);assert.equal(recovered.successes,1);gate.resolve();await old;assert.equal((await state(f)).progress,"IN_TRANSIT");assert.equal((await prisma.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:f.shipment!.id}})).totalRequests,2);
});
it("lifetime request exhaustion stops even successful polling",async()=>{
 const f=await fixture();const a=await enabled(f,[observation(f,[]),observation(f,[])]);await poll(a,{maxLifetimeRequests:1});await prisma.shipmentTrackingSync.update({where:{shipmentId:f.shipment!.id},data:{nextPollAt:null}});await poll(a,{maxLifetimeRequests:1});assert.equal(a.calls,1);assert.equal((await prisma.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:f.shipment!.id}})).enabled,false);
});
it("an already aborted invocation does not request the provider",async()=>{
 const f=await fixture();const a=await enabled(f,[observation(f,[])]);const controller=new AbortController();controller.abort();config.CARRIER_TRACKING_POLLING_ENABLED=true;assert.equal((await runTrackingPoll({adapters:new Map([[a.carrier,a]]),signal:controller.signal})).requests,0);assert.equal(a.calls,0);
});
it("invalid adapter evidence stops rather than repeatedly retrying guessed data",async()=>{
 const f=await fixture();const a=await enabled(f,[observation(f,[],{trackingNumber:"ZZ123456789GB"})]);await poll(a);const sync=await prisma.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:f.shipment!.id}});assert.equal(sync.enabled,false);assert.equal(sync.lastErrorCode,"INVALID_EVIDENCE");
});

it("fixture adapters/evidence cannot be used outside the guarded test runtime",async()=>{
 const f=await fixture();const a=adapter(f,[observation(f,[])]);const previous=process.env.NODE_ENV;
 try{process.env.NODE_ENV="production";assert.equal(a.isAvailable(),false);await assert.rejects(ingest(f,[event(await occurrence(f),"DELIVERED")]),TrackingEligibilityError);}
 finally{process.env.NODE_ENV=previous;}
 assert.equal(await prisma.shipmentTrackingEvent.count({where:{shipmentId:f.shipment!.id}}),0);
});
it("equal-timestamp exception/movement ordering is deterministic across requests",async()=>{
 const f=await fixture(),g=await fixture();const at=await occurrence(f),other=await occurrence(g);
 await ingest(f,[event(at,"EXCEPTION")]);await ingest(f,[event(at,"IN_TRANSIT")]);
 await ingest(g,[event(other,"IN_TRANSIT")]);await ingest(g,[event(other,"EXCEPTION")]);
 assert.equal((await state(f)).progress,(await state(g)).progress);assert.equal((await state(f)).exception,(await state(g)).exception);
});
it("provider authentication outage defers without consuming request budget",async()=>{
 const f=await fixture();const a=await enabled(f,[]);const unavailable=adapter(f,[],false);
 const result=await poll(unavailable);assert.equal(result.requests,0);assert.equal(unavailable.calls,0);const sync=await prisma.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:f.shipment!.id}});assert.equal(sync.totalRequests,0);assert.ok(sync.nextPollAt!>await prisma.$transaction(databaseNow));
});
it("aborting an in-flight poll stops work without applying a late delivery",async()=>{
 const f=await fixture();const entered=deferred(),gate=deferred();const a=await enabled(f,[async()=>{entered.resolve();await gate.promise;return observation(f,[event(await occurrence(f),"DELIVERED")]);}]);
 const controller=new AbortController();config.CARRIER_TRACKING_POLLING_ENABLED=true;const run=runTrackingPoll({adapters:new Map([[a.carrier,a]]),signal:controller.signal});await entered.promise;controller.abort();const result=await run;assert.equal(result.failures,1);gate.resolve();await new Promise(r=>setTimeout(r,5));assert.equal(await prisma.shipmentTrackingEvent.count({where:{shipmentId:f.shipment!.id}}),0);assert.equal((await prisma.shipmentTrackingPoll.findFirstOrThrow({where:{shipmentId:f.shipment!.id}})).outcome,"ABORTED");
});
it("tracking does not make a cancelled historical order fulfilled",async()=>{
 const f=await fixture();await prisma.order.update({where:{id:f.order.id},data:{status:"CANCELLED",cancelledAt:await prisma.$transaction(databaseNow),cancelledBy:"SELLER",cancellationReason:"OUT_OF_STOCK"}});
 await ingest(f,[event(await occurrence(f),"DELIVERED")]);assert.equal((await state(f)).progress,"DISPATCHED");assert.equal((await safeOrder(f)).fulfilment.stage,null);
});
it("database forbids recovery-counter regression and completed-journal mutation",async()=>{
 const f=await fixture();const a=await enabled(f,[observation(f,[])]);await poll(a);await assert.rejects(prisma.shipmentTrackingSync.update({where:{shipmentId:f.shipment!.id},data:{totalRequests:0}}),/cannot regress/);
 const record=await prisma.shipmentTrackingPoll.findFirstOrThrow({where:{shipmentId:f.shipment!.id}});await assert.rejects(prisma.shipmentTrackingPoll.update({where:{id:record.id},data:{outcome:"PENDING",completedAt:null}}),/immutable/);
});

it("customers and admins cannot inject Delivered through an HTTP evidence endpoint",async()=>{
 const f=await fixture();const body=JSON.stringify({verified:true,status:"DELIVERED",deliveryConfirmed:true});
 assert.equal((await fetch(`${base}/orders/${f.order.id}/tracking`,{method:"POST",headers:{Authorization:`Bearer ${f.token}`,"Content-Type":"application/json"},body})).status,404);
 assert.equal((await fetch(`${base}/admin/orders/${f.order.id}/fulfilment/delivered`,{method:"POST",headers:{Authorization:`Bearer ${f.adminToken}`,"Content-Type":"application/json"},body})).status,404);
 assert.equal((await safeOrder(f)).fulfilment.stage,"DISPATCHED");assert.equal(await prisma.shipmentTrackingEvent.count({where:{shipmentId:f.shipment!.id}}),0);
});

it("carrier delivery does not alter an in-progress refund or release inventory",async()=>{
 const f=await fixture();await prisma.payment.update({where:{id:f.payment.id},data:{reservedRefundAmount:5}});
 await prisma.refund.create({data:{orderId:f.order.id,paymentId:f.payment.id,amount:5,currency:"GBP",status:"PROCESSING",provider:"MANUAL",providerReference:randomUUID(),performedByUserId:f.admin.id}});
 const before=await snapshot(f);await ingest(f,[event(await occurrence(f),"DELIVERED")]);assert.deepEqual(await snapshot(f),before);
});
it("crashed final request is closed even when lifetime exhaustion prevents a new request",async()=>{
 const f=await fixture();const entered=deferred(),gate=deferred();const a=await enabled(f,[async()=>{entered.resolve();await gate.promise;return observation(f,[]);}]);
 const old=poll(a,{maxLifetimeRequests:1});await entered.promise;
 await prisma.shipmentTrackingSync.update({where:{shipmentId:f.shipment!.id},data:{leaseExpiresAt:new Date((await prisma.$transaction(databaseNow)).getTime()-1000)}});
 await poll(a,{maxLifetimeRequests:1});const record=await prisma.shipmentTrackingPoll.findFirstOrThrow({where:{shipmentId:f.shipment!.id}});assert.equal(record.outcome,"LEASE_EXPIRED");assert.ok(record.completedAt);gate.resolve();await old;assert.equal(a.calls,1);
});
it("PostgreSQL CHECK cannot accept an applied delivery proof with a NULL delivery timestamp",async()=>{
 const f=await fixture();const at=await occurrence(f);const received=await prisma.$transaction(databaseNow);
 await assert.rejects(prisma.shipmentTrackingEvent.create({data:{shipmentId:f.shipment!.id,carrier:f.carrier,providerIdentity:f.providerIdentity,providerEventId:randomUUID(),trackingNumber:f.tracking,occurredAt:at,receivedAt:received,verifiedAt:received,verified:true,source:"TEST_FIXTURE",status:"DELIVERED",providerStatus:"TEST_DELIVERED",deliveryConfirmed:true,deliveryAt:null,evidenceReference:"fixture",fingerprint:"a".repeat(64),disposition:"APPLIED"}}),/tracking_applied_evidence/);
});

it("blank delivery evidence is rejected by canonical validation and PostgreSQL",async()=>{
 const f=await fixture();const at=await occurrence(f);const received=await prisma.$transaction(databaseNow);
 await assert.rejects(ingest(f,[event(at,"DELIVERED",{evidenceReference:"   "})]));
 await assert.rejects(prisma.shipmentTrackingEvent.create({data:{shipmentId:f.shipment!.id,carrier:f.carrier,providerIdentity:f.providerIdentity,providerEventId:randomUUID(),trackingNumber:f.tracking,occurredAt:at,receivedAt:received,verifiedAt:received,verified:true,source:"TEST_FIXTURE",status:"DELIVERED",providerStatus:"TEST_DELIVERED",deliveryConfirmed:true,deliveryAt:at,evidenceReference:"   ",fingerprint:"a".repeat(64),disposition:"APPLIED"}}),/tracking_nonblank_delivery_proof/);
 assert.equal(await prisma.shipmentTrackingEvent.count({where:{shipmentId:f.shipment!.id}}),0);
});

it("conflicting same-time delivery references are preserved without overwriting the verified delivery",async()=>{
 const f=await fixture();const at=await occurrence(f);await ingest(f,[event(at,"DELIVERED")]);const proof=(await state(f)).deliveredEventId;
 await ingest(f,[event(at,"DELIVERED",{evidenceReference:"different-confirmation"})]);assert.equal((await state(f)).deliveredEventId,proof);assert.equal(await prisma.shipmentTrackingEvent.count({where:{shipmentId:f.shipment!.id,reason:"DELIVERY_CONFLICT"}}),1);
});
it("Evri and DPD use the same canonical lifecycle without guessed live contracts",async()=>{
 for(const carrier of ["EVRI","DPD"] as const){const f=await fixture({carrier});await ingest(f,[event(await occurrence(f),"IN_TRANSIT"),event(await occurrence(f),"DELIVERED")]);assert.equal((await safeOrder(f)).fulfilment.stage,"DELIVERED");}
});
it("provider rate-limit failures back off within the finite retry policy",async()=>{
 const f=await fixture();const a=await enabled(f,[new TrackingProviderError("RATE_LIMITED")]);await poll(a);const sync=await prisma.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:f.shipment!.id}});assert.equal(sync.lastErrorCode,"RATE_LIMITED");assert.ok(sync.nextPollAt!>await prisma.$transaction(databaseNow));assert.equal(sync.consecutiveFailures,1);
});

it("configured provider/account identity cannot be crossed by otherwise verified evidence",async()=>{
 const f=await fixture();await enabled(f,[]);await assert.rejects(ingest(f,[event(await occurrence(f),"DELIVERED")],{providerIdentity:"another-provider-account"}),TrackingEligibilityError);assert.equal(await prisma.shipmentTrackingEvent.count({where:{shipmentId:f.shipment!.id}}),0);
});

it("F1 UNKNOWN remapping and an independent delivery both apply without stopping polling",async()=>{
 const f=await fixture();const unknown=event(await occurrence(f),"UNKNOWN");await ingest(f,[unknown]);
 const a=await enabled(f,[observation(f,[{...unknown,status:"IN_TRANSIT"},event(unknown.occurredAt,"DELIVERED")])]);
 const result=await poll(a);assert.equal(result.successes,1);assert.equal(result.conflicts,0);
 assert.equal((await state(f)).progress,"DELIVERED");
 const sync=await prisma.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:f.shipment!.id}});
 assert.equal(sync.lastErrorCode,null);assert.equal(sync.stoppedReason,"DELIVERED");
 const history=await prisma.shipmentTrackingEvent.findMany({where:{shipmentId:f.shipment!.id,providerEventId:unknown.providerEventId},orderBy:{id:"asc"}});
 assert.deepEqual(history.map(e=>e.status),["UNKNOWN","IN_TRANSIT"]);assert.equal(history[0].fingerprint,history[1].fingerprint);
 assert.equal(await prisma.shipmentCarrierEvidence.count({where:{shipmentId:f.shipment!.id}}),2);
});
it("F1 verification upgrade is appended once and never downgrades applied proof",async()=>{
 const f=await fixture();const e=event(await occurrence(f),"DELIVERED");await ingest(f,[e],{verified:false});
 const result=await Promise.all([ingest(f,[e]),ingest(f,[e])]);assert.equal(result.reduce((n,r)=>n+r.applied,0),1);
 await ingest(f,[e],{verified:false});assert.equal((await state(f)).progress,"DELIVERED");
 const rows=await prisma.shipmentTrackingEvent.findMany({where:{shipmentId:f.shipment!.id},orderBy:{id:"asc"}});
 assert.deepEqual(rows.map(r=>r.verified),[false,true]);assert.equal(rows[0].disposition,"REJECTED");assert.equal(rows[1].disposition,"APPLIED");
});
it("F1 a mixed conflicting poll keeps polling and commits its valid movement",async()=>{
 const f=await fixture();const original=event(await occurrence(f),"UNKNOWN");await ingest(f,[original]);
 const a=await enabled(f,[observation(f,[{...original,providerStatus:"CONFLICT"},event(original.occurredAt,"IN_TRANSIT")])]);
 const result=await poll(a);assert.equal(result.conflicts,1);assert.equal(result.failures,0);assert.equal((await state(f)).progress,"IN_TRANSIT");
 const sync=await prisma.shipmentTrackingSync.findUniqueOrThrow({where:{shipmentId:f.shipment!.id}});assert.equal(sync.enabled,true);assert.equal(sync.lastErrorCode,"EVIDENCE_CONFLICT");
 assert.equal((await prisma.shipmentTrackingPoll.findFirstOrThrow({where:{shipmentId:f.shipment!.id}})).outcome,"PARTIAL_SUCCESS");
});
it("F2 two-second future delivery is accepted within the five-second tolerance",async()=>{
 const f=await fixture();const at=new Date((await prisma.$transaction(databaseNow)).getTime()+2000);
 assert.equal((await ingest(f,[event(at,"DELIVERED")])).applied,1);assert.equal((await state(f)).progress,"DELIVERED");
});
it("F2 previously future-rejected evidence can be re-evaluated without rewriting history",async()=>{
 const f=await fixture();const at=await occurrence(f);const e=event(at,"DELIVERED");
 // Deterministic historical receipt: ten seconds before its event, now the same event is due.
 const oldReceived=new Date(at.getTime()-10000);
 const old=await prisma.shipmentTrackingEvent.create({data:{shipmentId:f.shipment!.id,carrier:f.carrier,providerIdentity:f.providerIdentity,
  ...e,trackingNumber:f.tracking,receivedAt:oldReceived,verifiedAt:oldReceived,verified:true,source:"TEST_FIXTURE",
  fingerprint:"a".repeat(64),disposition:"REJECTED",reason:"FUTURE_EVENT"}});
 assert.equal((await ingest(f,[e])).applied,1);assert.equal((await state(f)).progress,"DELIVERED");
 assert.deepEqual(await prisma.shipmentTrackingEvent.findUniqueOrThrow({where:{id:old.id}}),old);
 assert.equal((await ingest(f,[e])).duplicates,1);
 assert.equal(await prisma.shipmentTrackingEvent.count({where:{shipmentId:f.shipment!.id}}),2);
});
it("F2 SQL enforces the exact clock-skew boundary and rejects excessive future proof",async()=>{
 const f=await fixture();const at=new Date((await prisma.$transaction(databaseNow)).getTime()+20000);
 const fields={shipmentId:f.shipment!.id,carrier:f.carrier,providerIdentity:f.providerIdentity,trackingNumber:f.tracking,
  occurredAt:at,verifiedAt:new Date(at.getTime()-5000),receivedAt:new Date(at.getTime()-5000),verified:true,source:"TEST_FIXTURE" as const,
  status:"DELIVERED" as const,providerStatus:"TEST_DELIVERED",deliveryConfirmed:true,deliveryAt:at,evidenceReference:"proof",fingerprint:"a".repeat(64),disposition:"APPLIED" as const};
 await prisma.shipmentTrackingEvent.create({data:{...fields,providerEventId:randomUUID()}});
 await assert.rejects(prisma.shipmentTrackingEvent.create({data:{...fields,providerEventId:randomUUID(),verifiedAt:new Date(at.getTime()-5001),receivedAt:new Date(at.getTime()-5001)}}),/tracking_applied_evidence/);
 const g=await fixture();assert.equal((await ingest(g,[event(at,"DELIVERED")])).applied,0);assert.equal((await state(g)).progress,"DISPATCHED");
});
it("F3 budget clock is sampled after a lock wait across a simulated minute boundary",async()=>{
 const key={carrier:"ROYAL_MAIL" as const,providerIdentity:randomUUID()};
 const before=new Date("2040-01-01T00:00:59Z"),after=new Date("2040-01-01T00:01:01Z");
 await prisma.trackingCarrierBudget.create({data:{...key,minuteStartedAt:new Date("2040-01-01T00:00:00Z"),dayStartedAt:new Date("2040-01-01T00:00:00Z")}});
 const held=deferred(),release=deferred(),ready=deferred();let pid=0,clockCalls=0;
 const first=prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT carrier FROM "TrackingCarrierBudget" WHERE "providerIdentity"=${key.providerIdentity} FOR UPDATE`;
  await tx.trackingCarrierBudget.update({where:{carrier_providerIdentity:key},data:{minuteStartedAt:new Date("2040-01-01T00:01:00Z"),minuteRequests:1,dayRequests:1}});
  held.resolve();await release.promise;
 },{timeout:10000});
 await held.promise;
 const waiting=prisma.$transaction(async tx=>{
  const [row]=await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;pid=row.pid;ready.resolve();
  return chargeTrackingBudget(tx,key,{perMinute:1,perDay:10},async lockedTx=>{
   // This query and logical clock advance occur only AFTER the row lock is acquired.
   await lockedTx.$queryRaw`SELECT 1`;clockCalls++;return after;
  });
 },{timeout:10000});
 await ready.promise;
 try {
  const deadline=Date.now()+3000;let blocked=false;
  while(Date.now()<deadline){const [r]=await prisma.$queryRaw<Array<{blocked:boolean}>>`SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=${pid}`;if(r?.blocked){blocked=true;break;}await new Promise(r=>setTimeout(r,5));}
  assert.ok(blocked,"second transaction must genuinely wait on PostgreSQL");assert.equal(clockCalls,0,"no budget time may be sampled before acquiring the lock");
 }finally{release.resolve();}
 await first;assert.equal((await waiting).denied,true);
 assert.equal((await prisma.$transaction(tx=>chargeTrackingBudget(tx,key,{perMinute:1,perDay:10},async()=>before))).denied,true);
 const budget=await prisma.trackingCarrierBudget.findUniqueOrThrow({where:{carrier_providerIdentity:key}});
 assert.equal(budget.minuteStartedAt.toISOString(),"2040-01-01T00:01:00.000Z");assert.equal(budget.minuteRequests,1);assert.equal(budget.dayRequests,1);
 await assert.rejects(prisma.trackingCarrierBudget.update({where:{carrier_providerIdentity:key},data:{minuteStartedAt:new Date("2040-01-01T00:00:00Z")}}),/cannot move backwards/);
});
it("F5 evidence rejects DELETE and TRUNCATE, including CASCADE",async()=>{
 const f=await fixture();const e=event(await occurrence(f),"UNKNOWN");await ingest(f,[e]);await ingest(f,[{...e,providerStatus:"CONFLICT"}]);
 for(const table of ["ShipmentCarrierEvidence","ShipmentTrackingEvent","ShipmentTrackingConflict"]){
  await assert.rejects(prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE false`),/append-only/);
  await assert.rejects(prisma.$executeRawUnsafe(`TRUNCATE TABLE "${table}" CASCADE`),/append-only/);
 }
 assert.equal(await prisma.shipmentTrackingEvent.count({where:{shipmentId:f.shipment!.id}}),1);
});
