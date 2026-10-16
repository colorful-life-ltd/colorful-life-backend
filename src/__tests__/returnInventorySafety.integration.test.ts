import assert from "node:assert/strict";
import { after, afterEach, before, it } from "node:test";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import app from "../app.js";
import { config } from "../config/index.js";
import { prisma } from "../prisma/runtime.js";
import { createOrder } from "../domain/orders/orderService.js";
import { confirmOrder } from "../domain/orders/orderConfirmationService.js";
import { cancelOrder, cancelOrderByAdmin } from "../domain/orders/orderCancellationService.js";
import { expireOrderReservation } from "../domain/orders/orderExpiryService.js";
import { attemptManagedRelease } from "../domain/payments/paymentResolutionService.js";
import { authorizeOrderReturn, cancelOrderReturn, completeOrderReturn, inspectOrderReturn, receiveOrderReturn, requestOrderReturn } from "../domain/orders/orderReturnService.js";
import { OrderCancellationReturnConflictError, OrderReturnEligibilityError } from "../domain/orders/returnInventorySafety.js";

let server:ReturnType<typeof app.listen>,base:string;
const resolutionEnabled=config.PAYMENT_RESOLUTION_ENABLED;
before(async()=>{server=app.listen(0);await new Promise<void>(r=>server.once("listening",r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;});
afterEach(()=>{config.PAYMENT_RESOLUTION_ENABLED=resolutionEnabled;});
after(async()=>{await new Promise<void>(r=>server.close(()=>r()));await prisma.$disconnect();});
async function fixture(confirmed=true,paid=false,used=false){
 const user=await prisma.user.create({data:{email:`${randomUUID()}@return-safety.test`,passwordHash:"fixture",emailVerified:true,role:"ADMIN",addresses:{create:{recipientName:"Fixture",line1:"Fixture",city:"Fixture",postcode:"T1",countryCode:"GB",isDefaultBilling:true}}}});
 const product=await prisma.legoProduct.create({data:{setNumber:randomUUID(),title:"Return safety",theme:"TEST",ageRecommendation:"8+",pieceCount:1}});
 const listing=await prisma.productListing.create({data:{legoProductId:product.id,condition:used?"USED_LIKE_NEW":"NEW",originalPrice:10,currentStock:used?1:10,...(used?{usedLifecycle:"AVAILABLE",damageDescription:"Fixture wear",usedConditionPhotos:{create:{url:"https://example.test/fixture.jpg",publicId:randomUUID(),sortOrder:0}}}:{})}});
 const order=await createOrder(user.id,{ shippingMethod: "STANDARD" as const,items:[{productListingId:listing.id,quantity:used?1:3}]});
 if(paid)await prisma.payment.create({data:{orderId:order.id,provider:"MANUAL",providerReference:randomUUID(),status:"SUCCEEDED",paidAt:new Date(),amount:order.totalAmount,currency:"GBP"}});
 if(confirmed)await confirmOrder(user.id,order.id);
 return {user,listing,order,item:order.orderItems[0]};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function request(f:Fixture,quantity=1){return requestOrderReturn(f.order.id,f.item.id,quantity,"OTHER",undefined,"CUSTOMER",undefined,f.user.id);}
async function inspected(f:Fixture,quantity=1,restock=quantity){const r=await request(f,quantity);await authorizeOrderReturn(f.order.id,r.id);await receiveOrderReturn(f.order.id,r.id);await inspectOrderReturn(f.order.id,r.id,"AS_NEW",restock,undefined,f.user.id);return r;}
async function snapshot(f:Fixture){return {listing:await prisma.productListing.findUniqueOrThrow({where:{id:f.listing.id}}),item:await prisma.orderItem.findUniqueOrThrow({where:{id:f.item.id}}),movements:await prisma.inventoryMovement.findMany({where:{listingId:f.listing.id},orderBy:{id:"asc"}}),payment:await prisma.payment.findUnique({where:{orderId:f.order.id}})};}
async function assertNoMutation(f:Fixture,work:()=>Promise<unknown>){const before=await snapshot(f);await assert.rejects(work,OrderReturnEligibilityError);assert.deepEqual(await snapshot(f),before);}
function token(f:Fixture,role="ADMIN"){return jwt.sign({id:f.user.id,role},config.JWT_SECRET);}
async function http(f:Fixture,path:string,body:object,auth=token(f)){return fetch(`${base}/orders/${f.order.id}/${path}`,{method:"POST",headers:{"Content-Type":"application/json",...(auth?{Authorization:`Bearer ${auth}`}:{})},body:JSON.stringify(body)});}
function requestBody(f:Fixture){return {orderItemId:f.item.id,quantity:1,reason:"OTHER",shippingPayer:"CUSTOMER"};}

for(const paid of [false,true])it(`PENDING ${paid?"paid-but-unconfirmed":"unpaid"} cannot reserve or restock returns`,async()=>{
 const f=await fixture(false,paid);await assertNoMutation(f,()=>request(f));
 // Historical invalid return already admitted before this patch must also fail closed.
 await prisma.orderItem.update({where:{id:f.item.id},data:{reservedReturnQuantity:1}});
 const r=await prisma.orderReturn.create({data:{orderItemId:f.item.id,quantity:1,restockQuantity:1,condition:"AS_NEW",reason:"OTHER",status:"INSPECTED",performedByUserId:f.user.id}});
 await assertNoMutation(f,()=>completeOrderReturn(f.order.id,r.id,f.user.id));
});
for(const status of ["CANCELLED","EXPIRED"] as const)it(`${status} rejects admission and historical completion`,async()=>{
 const f=await fixture(),r=await inspected(f);await prisma.order.update({where:{id:f.order.id},data:{status}});
 await assertNoMutation(f,()=>request(f));await assertNoMutation(f,()=>completeOrderReturn(f.order.id,r.id,f.user.id));
});
for(const status of ["CONFIRMED","DISPATCHED","COMPLETED","RETURNED"] as const)it(`${status} with genuine paid sale allows physical return without payment mutation`,async()=>{
 const f=await fixture(true,true);await prisma.order.update({where:{id:f.order.id},data:{status}});const before=await snapshot(f),r=await inspected(f);
 await completeOrderReturn(f.order.id,r.id,f.user.id);const after=await snapshot(f);assert.equal(after.listing.currentStock,8);assert.equal(after.listing.reservedStock,0);
 assert.deepEqual(after.payment,before.payment);assert.equal(after.movements.filter(m=>m.type==="WEBSITE_SALE").length,1);assert.equal(after.movements.filter(m=>m.type==="ORDER_RETURN").length,1);
});
for(const bad of ["missing","wrong-order","wrong-listing","substring","positive","wrong-quantity","duplicate","reversal"]){
 it(`rejects ${bad} deduction evidence at admission and completion`,async()=>{
  const f=await fixture(),r=await inspected(f);const sale=await prisma.inventoryMovement.findFirstOrThrow({where:{listingId:f.listing.id,type:"WEBSITE_SALE"}});
  if(bad==="missing")await prisma.inventoryMovement.delete({where:{id:sale.id}});
  if(bad==="wrong-order")await prisma.inventoryMovement.update({where:{id:sale.id},data:{note:`Order ${f.order.id+1000000} sale`}});
  if(bad==="substring")await prisma.inventoryMovement.update({where:{id:sale.id},data:{note:`prefix Order ${f.order.id} sale suffix`}});
  if(bad==="wrong-listing"){const other=await fixture();await prisma.inventoryMovement.update({where:{id:sale.id},data:{listingId:other.listing.id}});}
  if(bad==="positive"||bad==="wrong-quantity")await prisma.inventoryMovement.update({where:{id:sale.id},data:{quantityChange:bad==="positive"?3:-2}});
  if(bad==="duplicate"||bad==="reversal")await prisma.inventoryMovement.create({data:{listingId:f.listing.id,quantityChange:bad==="duplicate"?-3:3,type:bad==="duplicate"?"WEBSITE_SALE":"ORDER_CANCELLATION_RETURN",note:bad==="duplicate"?`Order ${f.order.id} sale`:`Order ${f.order.id} cancellation return`,performedByUserId:f.user.id}});
  await assertNoMutation(f,()=>request(f));await assertNoMutation(f,()=>completeOrderReturn(f.order.id,r.id,f.user.id));
 });
}
it("partial returns and concurrent completion never exceed deducted stock",async()=>{
 const f=await fixture();const a=await inspected(f,1),b=await inspected(f,2,1);
 await assert.rejects(request(f));const before=await snapshot(f);
 const results=await Promise.allSettled([completeOrderReturn(f.order.id,a.id,f.user.id),completeOrderReturn(f.order.id,a.id,f.user.id),completeOrderReturn(f.order.id,b.id,f.user.id)]);
 assert.equal(results.filter(r=>r.status==="fulfilled").length,2);await assert.rejects(completeOrderReturn(f.order.id,a.id,f.user.id));
 const after=await snapshot(f);assert.equal(after.listing.currentStock,before.listing.currentStock+2);assert.equal(after.item.returnedQuantity,3);assert.equal(after.item.reservedReturnQuantity,0);assert.equal(after.movements.filter(m=>m.type==="ORDER_RETURN").length,2);await assert.rejects(request(f));
});
for(const seller of [false,true]){
 const cancel=(f:Fixture)=>seller?cancelOrderByAdmin(f.order.id,"OUT_OF_STOCK",f.user.id):cancelOrder(f.user.id,f.order.id,"CHANGED_MIND");
 it(`${seller?"seller":"customer"} cancellation first prevents returns and double restoration`,async()=>{const f=await fixture();await cancel(f);const after=await snapshot(f);assert.equal(after.listing.currentStock,10);assert.equal(after.movements.filter(m=>m.type==="ORDER_CANCELLATION_RETURN").length,1);await assertNoMutation(f,()=>request(f));});
 it(`${seller?"seller":"customer"} cancellation conflicts with active and completed returns`,async()=>{const f=await fixture(),r=await inspected(f);await assert.rejects(cancel(f),OrderCancellationReturnConflictError);await completeOrderReturn(f.order.id,r.id,f.user.id);const before=await snapshot(f);await assert.rejects(cancel(f),OrderCancellationReturnConflictError);assert.deepEqual(await snapshot(f),before);});
}
it("cancelling a REQUESTED return frees quantity exactly once and permits ordinary cancellation",async()=>{
 const f=await fixture(),r=await request(f,3);await cancelOrderReturn(f.order.id,r.id);await assert.rejects(cancelOrderReturn(f.order.id,r.id));assert.equal((await snapshot(f)).item.reservedReturnQuantity,0);
 await cancelOrder(f.user.id,f.order.id,"CHANGED_MIND");assert.equal((await snapshot(f)).listing.currentStock,10);
});
it("legacy expiry and lazy checkout expiry retain inventory with historical active returns",async()=>{
 const f=await fixture(false);await prisma.order.update({where:{id:f.order.id},data:{reservationExpiresAt:new Date(0)}});
 await prisma.orderReturn.create({data:{orderItemId:f.item.id,quantity:1,reason:"OTHER",performedByUserId:f.user.id}});const before=await snapshot(f);
 assert.equal(await expireOrderReservation(f.order.id),null);assert.deepEqual(await snapshot(f),before);
 const next=await createOrder(f.user.id,{ shippingMethod: "STANDARD" as const,items:[{productListingId:f.listing.id,quantity:1}]});
 assert.equal((await prisma.order.findUniqueOrThrow({where:{id:f.order.id}})).status,"PENDING");assert.equal((await snapshot(f)).listing.reservedStock,4);assert.ok(next.id);
});
it("managed release is blocked by historical return activity even without return counters",async()=>{
 config.PAYMENT_RESOLUTION_ENABLED=true;const f=await fixture(false);await prisma.orderReturn.create({data:{orderItemId:f.item.id,quantity:1,reason:"OTHER",performedByUserId:f.user.id}});const before=await snapshot(f);
 const released=await prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${f.order.id} FOR UPDATE`;return attemptManagedRelease(tx,f.order.id,true);});
 assert.equal(released,false);assert.deepEqual(await snapshot(f),before);assert.equal((await prisma.paymentResolution.findUniqueOrThrow({where:{orderId:f.order.id}})).reservationDisposition,"HELD");
});
it("Used offers retain zero-restock restriction",async()=>{
 const f=await fixture(true,false,true),r=await request(f);await authorizeOrderReturn(f.order.id,r.id);await receiveOrderReturn(f.order.id,r.id);
 await assert.rejects(inspectOrderReturn(f.order.id,r.id,"AS_NEW",1,undefined,f.user.id));await inspectOrderReturn(f.order.id,r.id,"AS_NEW",0,undefined,f.user.id);await completeOrderReturn(f.order.id,r.id,f.user.id);
 const after=await snapshot(f);assert.equal(after.listing.currentStock,0);assert.equal(after.listing.usedLifecycle,"SOLD");assert.equal(after.movements.filter(m=>m.type==="ORDER_RETURN").length,0);
});
it("HTTP admission and completion enforce ADMIN and report eligibility conflicts",async()=>{
 const f=await fixture(false);const customer=await prisma.user.create({data:{email:`${randomUUID()}@return-safety.test`,passwordHash:"fixture",role:"CUSTOMER",emailVerified:true}});const customerToken=jwt.sign({id:customer.id,role:"CUSTOMER"},config.JWT_SECRET);
 assert.equal((await http(f,"returns",requestBody(f),"")).status,401);assert.equal((await http(f,"returns",requestBody(f),customerToken)).status,403);
 const response=await http(f,"returns",requestBody(f));assert.equal(response.status,409);assert.equal((await response.json()).error.code,"ORDER_RETURN_INELIGIBLE");
 const g=await fixture(),r=await inspected(g);assert.equal((await http(g,`returns/${r.id}/complete`,{},customerToken)).status,403);
 await prisma.order.update({where:{id:g.order.id},data:{status:"CANCELLED"}});assert.equal((await http(g,`returns/${r.id}/complete`,{})).status,409);
 const h=await fixture();await request(h);const conflict=await http(h,"seller-cancel",{reason:"OUT_OF_STOCK"});assert.equal(conflict.status,409);assert.equal((await conflict.json()).error.code,"ORDER_RETURN_CONFLICT");
});

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};}
/** Queue real independent transactions behind a real Order lock; observe PostgreSQL waits, never guess with a sleep. */
async function raceInOrder(f:Fixture,first:()=>Promise<unknown>,second:()=>Promise<unknown>){
 const locked=deferred(),release=deferred();let owner=0;
 const blocker=prisma.$transaction(async tx=>{await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${f.order.id} FOR UPDATE`;const [row]=await tx.$queryRaw<Array<{pid:number}>>`SELECT pg_backend_pid() AS pid`;owner=row.pid;locked.resolve();await release.promise;},{timeout:15000});
 await locked.promise;const operations:Array<Promise<PromiseSettledResult<unknown>>>=[];
 const launch=(work:()=>Promise<unknown>)=>{const result=work().then(value=>({status:"fulfilled" as const,value}),reason=>({status:"rejected" as const,reason}));operations.push(result);};
 async function waitFor(count:number){const deadline=Date.now()+8000;while(Date.now()<deadline){
  const [row]=await prisma.$queryRaw<Array<{n:number}>>`WITH RECURSIVE waiting(pid) AS (
    SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND ${owner}=ANY(pg_blocking_pids(pid))
    UNION SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid=ANY(pg_blocking_pids(a.pid)) WHERE a.datname=current_database()
  ) SELECT count(*)::int AS n FROM waiting`;
  if(row.n>=count)return;await new Promise<void>(r=>setTimeout(r,10));
 }throw new Error("Expected PostgreSQL lock wait was not observed");}
 try{launch(first);await waitFor(1);launch(second);await waitFor(2);}finally{release.resolve();await blocker;}
 return Promise.all(operations);
}
for(const seller of [false,true])for(const returnFirst of [false,true])it(`real Order lock serializes ${seller?"seller":"customer"} cancellation/admission with ${returnFirst?"return":"cancellation"} queued first`,async()=>{
 const f=await fixture();const cancel=()=>seller?cancelOrderByAdmin(f.order.id,"OUT_OF_STOCK",f.user.id):cancelOrder(f.user.id,f.order.id,"CHANGED_MIND");
 const result=await raceInOrder(f,returnFirst?()=>request(f):cancel,returnFirst?cancel:()=>request(f));
 assert.equal(result[0].status,"fulfilled");assert.equal(result[1].status,"rejected");
 assert.ok(result[1].status==="rejected"&&result[1].reason instanceof (returnFirst?OrderCancellationReturnConflictError:OrderReturnEligibilityError));
 const after=await snapshot(f);assert.equal(after.listing.currentStock,returnFirst?7:10);assert.equal(after.item.reservedReturnQuantity,returnFirst?1:0);
 assert.equal(after.movements.filter(m=>m.type==="ORDER_CANCELLATION_RETURN").length,returnFirst?0:1);assert.equal(after.movements.filter(m=>m.type==="ORDER_RETURN").length,0);
});
for(const completionFirst of [false,true])it(`completion/cancellation race with ${completionFirst?"completion":"cancellation"} queued first never restores twice`,async()=>{
 const f=await fixture(),r=await inspected(f);const complete=()=>completeOrderReturn(f.order.id,r.id,f.user.id),cancel=()=>cancelOrderByAdmin(f.order.id,"OUT_OF_STOCK",f.user.id);
 const results=await raceInOrder(f,completionFirst?complete:cancel,completionFirst?cancel:complete);
 assert.equal(results[completionFirst?0:1].status,"fulfilled");const rejected=results[completionFirst?1:0];assert.ok(rejected.status==="rejected"&&rejected.reason instanceof OrderCancellationReturnConflictError);
 const after=await snapshot(f);assert.equal(after.listing.currentStock,8);assert.equal(after.item.returnedQuantity,1);assert.equal(after.movements.filter(m=>m.type==="ORDER_RETURN").length,1);assert.equal(after.movements.filter(m=>m.type==="ORDER_CANCELLATION_RETURN").length,0);
});
it("completion revalidates persisted inspection quantities and condition",async()=>{
 const f=await fixture(),r=await inspected(f);for(const data of [{restockQuantity:2},{restockQuantity:-1},{condition:"DAMAGED" as const,restockQuantity:1}]){
  await prisma.orderReturn.update({where:{id:r.id},data});const before=await snapshot(f);await assert.rejects(completeOrderReturn(f.order.id,r.id,f.user.id));assert.deepEqual(await snapshot(f),before);
 }
});
it("managed CONSUMED stock remains eligible for a legitimate paid return",async()=>{
 config.PAYMENT_RESOLUTION_ENABLED=true;const f=await fixture(true,true);assert.equal((await prisma.paymentResolution.findUniqueOrThrow({where:{orderId:f.order.id}})).reservationDisposition,"CONSUMED");
 const r=await inspected(f);await completeOrderReturn(f.order.id,r.id,f.user.id);assert.equal((await snapshot(f)).listing.currentStock,8);
});
for(const completed of [false,true])it(`missing ${completed?"completed":"active"} historical return counters fail closed`,async()=>{
 const f=await fixture(),r=await inspected(f);if(completed)await completeOrderReturn(f.order.id,r.id,f.user.id);
 await prisma.orderItem.update({where:{id:f.item.id},data:completed?{returnedQuantity:0}:{reservedReturnQuantity:0}});await assertNoMutation(f,()=>request(f));
});
it("prior return movements cannot hide an already-restored active return",async()=>{
 const f=await fixture(),r=await inspected(f);await prisma.inventoryMovement.create({data:{listingId:f.listing.id,type:"ORDER_RETURN",quantityChange:1,note:`Completed order return ${r.id}`,performedByUserId:f.user.id}});
 await assertNoMutation(f,()=>completeOrderReturn(f.order.id,r.id,f.user.id));await assertNoMutation(f,()=>request(f));
});
it("duplicate completed return evidence blocks further restoration",async()=>{
 const f=await fixture(),r=await inspected(f);await completeOrderReturn(f.order.id,r.id,f.user.id);
 await prisma.inventoryMovement.create({data:{listingId:f.listing.id,type:"ORDER_RETURN",quantityChange:1,note:`Completed order return ${r.id}`,performedByUserId:f.user.id}});
 await assertNoMutation(f,()=>request(f));
});
it("historical over-restocked return evidence cannot authorize additional stock",async()=>{
 const f=await fixture(),r=await inspected(f);await completeOrderReturn(f.order.id,r.id,f.user.id);
 await prisma.orderReturn.update({where:{id:r.id},data:{restockQuantity:3}});
 await prisma.inventoryMovement.updateMany({where:{listingId:f.listing.id,type:"ORDER_RETURN",note:`Completed order return ${r.id}`},data:{quantityChange:3}});
 await assertNoMutation(f,()=>request(f));
});
it("split sale evidence with the right total is still ambiguous for one purchased item",async()=>{
 const f=await fixture();await prisma.inventoryMovement.updateMany({where:{listingId:f.listing.id,type:"WEBSITE_SALE"},data:{quantityChange:-1}});
 await prisma.inventoryMovement.create({data:{listingId:f.listing.id,type:"WEBSITE_SALE",quantityChange:-2,note:`Order ${f.order.id} sale`,performedByUserId:f.user.id}});
 await assertNoMutation(f,()=>request(f));
});

for (const managed of [false, true]) it(`${managed ? "managed release" : "legacy expiry"} warns once per blocked PENDING order without releasing inventory`, async t => {
 config.PAYMENT_RESOLUTION_ENABLED=managed;
 const f=await fixture(false);
 await prisma.order.update({where:{id:f.order.id},data:{reservationExpiresAt:new Date(0)}});
 await prisma.orderReturn.create({data:{orderItemId:f.item.id,quantity:1,reason:"OTHER",performedByUserId:f.user.id}});
 const warning=t.mock.method(console,"warn",()=>{});
 const before=await snapshot(f);
 const release=()=>managed?prisma.$transaction(async tx=>{
  await tx.$queryRaw`SELECT id FROM "Order" WHERE id=${f.order.id} FOR UPDATE`;
  return attemptManagedRelease(tx,f.order.id,true);
 }):expireOrderReservation(f.order.id);
 for(let i=0;i<3;i++)assert.equal(await release(),managed?false:null);
 assert.deepEqual(await snapshot(f),before);
 assert.equal(warning.mock.callCount(),1);
 assert.deepEqual(warning.mock.calls[0].arguments,[{
  event:"ORDER_RESERVATION_RELEASE_BLOCKED",orderId:f.order.id,
  source:managed?"MANAGED_RELEASE":"EXPIRY",reason:"CONFLICTING_HISTORICAL_RETURN_RECORDS_OR_COUNTERS",
 }]);
 // Cross-entry-point retries share suppression.
 await expireOrderReservation(f.order.id);
 assert.equal(warning.mock.callCount(),1);
 const now=Date.now();
 t.mock.method(Date,"now",()=>now+60*60*1000+1);
 await release();
 assert.equal(warning.mock.callCount(),2);
});

it("expiry does not warn about return conflicts on a non-PENDING order",async t=>{
 const f=await fixture();await request(f);
 const warning=t.mock.method(console,"warn",()=>{});
 assert.equal(await expireOrderReservation(f.order.id),null);
 assert.equal(warning.mock.callCount(),0);
});

for(const completed of [false,true])for(const duplicate of [false,true])it(`listing-scoped evidence rejects ${duplicate?"extra":"only"} wrong-listing restoration for ${completed?"completed":"active"} history`,async()=>{
 const f=await fixture(),other=await fixture(),r=await inspected(f);
 if(completed)await completeOrderReturn(f.order.id,r.id,f.user.id);
 if(completed&&!duplicate)await prisma.inventoryMovement.deleteMany({where:{listingId:f.listing.id,type:"ORDER_RETURN"}});
 await prisma.inventoryMovement.create({data:{listingId:other.listing.id,type:"ORDER_RETURN",quantityChange:1,note:`Completed order return ${r.id}`,performedByUserId:f.user.id}});
 await assertNoMutation(f,()=>request(f));
 if(!completed)await assertNoMutation(f,()=>completeOrderReturn(f.order.id,r.id,f.user.id));
});

it("listing-scoped evidence accepts legitimate history amid unrelated movements and rejects order-wide reversals",async()=>{
 const f=await fixture(),other=await fixture(),r=await inspected(f);
 await completeOrderReturn(f.order.id,r.id,f.user.id);
 const unrelated=await inspected(other);await completeOrderReturn(other.order.id,unrelated.id,other.user.id);
 const next=await inspected(f);await completeOrderReturn(f.order.id,next.id,f.user.id);
 await prisma.inventoryMovement.create({data:{listingId:other.listing.id,type:"ORDER_CANCELLATION_RETURN",quantityChange:1,note:`Order ${f.order.id} cancellation return`,performedByUserId:f.user.id}});
 await assertNoMutation(f,()=>request(f));
});
