import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import jwt from 'jsonwebtoken';
import {prisma} from './dist/prisma/runtime.js';
const p=JSON.parse(readFileSync(0,'utf8'));
try {
 if(p.mode==='seed') {
  const customer=await prisma.user.create({data:{email:`synthetic-${randomUUID()}@example.invalid`,passwordHash:'synthetic-not-login',emailVerified:true,role:'CUSTOMER'}});
  const other=await prisma.user.create({data:{email:`synthetic-${randomUUID()}@example.invalid`,passwordHash:'synthetic-not-login',emailVerified:true,role:'CUSTOMER'}});
  const admin=await prisma.user.create({data:{email:`synthetic-${randomUUID()}@example.invalid`,passwordHash:'synthetic-not-login',emailVerified:true,role:'ADMIN'}});
  const product=await prisma.legoProduct.create({data:{setNumber:'SYNTHETIC-RMA',title:'Synthetic rehearsal LEGO',theme:'TEST',ageRecommendation:'8+',pieceCount:10}});
  const listing=await prisma.productListing.create({data:{legoProductId:product.id,condition:'NEW',originalPrice:10,currentStock:20}});
  const address={RecipientName:'Synthetic',Line1:'1 Synthetic Road',City:'Test',Postcode:'T1',CountryCode:'GB'};
  const addresses=Object.fromEntries(['billing','delivery'].flatMap(prefix=>Object.entries(address).map(([k,v])=>[prefix+k,v])));
  const order=await prisma.order.create({data:{userId:customer.id,status:'DISPATCHED',dispatchedAt:new Date(),totalAmount:50,...addresses,orderItems:{create:{productListingId:listing.id,quantity:5,unitPrice:10,lineTotal:50}}},include:{orderItems:true}});
  await prisma.payment.create({data:{orderId:order.id,provider:'MANUAL',providerReference:'synthetic-manual-only',status:'SUCCEEDED',paidAt:new Date(),amount:50}});
  const beforeDispatch=await prisma.order.create({data:{userId:customer.id,status:'CONFIRMED',totalAmount:10,...addresses,orderItems:{create:{productListingId:listing.id,quantity:1,unitPrice:10,lineTotal:10}}},include:{orderItems:true}});
  await prisma.payment.create({data:{orderId:beforeDispatch.id,provider:'MANUAL',providerReference:'synthetic-predispatch',status:'SUCCEEDED',paidAt:new Date(),amount:10}});
  const unpaid=await prisma.order.create({data:{userId:customer.id,status:'DISPATCHED',dispatchedAt:new Date(),totalAmount:10,...addresses,orderItems:{create:{productListingId:listing.id,quantity:1,unitPrice:10,lineTotal:10}}},include:{orderItems:true}});
  console.log(JSON.stringify({customerId:customer.id,otherId:other.id,adminId:admin.id,orderId:order.id,itemId:order.orderItems[0].id,listingId:listing.id,predispatch:{id:beforeDispatch.id,itemId:beforeDispatch.orderItems[0].id},unpaid:{id:unpaid.id,itemId:unpaid.orderItems[0].id}}));
 } else {
  const f=p.fixture;
  const token=(id,role)=>jwt.sign({id,role},p.jwt,{expiresIn:'1h'});
  const ct=token(f.customerId,'CUSTOMER'),at=token(f.adminId,'ADMIN'),ot=token(f.otherId,'CUSTOMER');
  async function api(path,token,body,expected=200){
   const r=await fetch('http://returns-exact-fixture-api-1:3000'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
   const value=await r.json();assert.equal(r.status,expected,JSON.stringify({path,status:r.status,value}));return value;
  }
  const submission=item=>({idempotencyKey:randomUUID(),lines:[{orderItemId:item,quantity:1,reason:'CHANGE_OF_MIND',reasonNote:'Synthetic rehearsal'}]});
  let c=await api(`/orders/${f.orderId}/return-requests`,ct,submission(f.itemId),201);
  f.reference=c.reference;f.lineId=c.submissions[0].lines[0].id;
  const replay=submission(f.itemId);
  c=await api(`/orders/${f.orderId}/return-requests`,ct,replay,201);
  f.secondLineId=c.submissions[1].lines[0].id;
  const again=await api(`/orders/${f.orderId}/return-requests`,ct,replay,201);assert.equal(again.submissions.length,2);assert.equal(again.reference,f.reference);
  await api(`/orders/${f.orderId}/return-case`,ot,undefined,404);
  await api(`/admin/returns/${f.orderId}`,ct,undefined,403);
  for(const order of [f.predispatch,f.unpaid]) {
   const r=await fetch('http://returns-exact-fixture-api-1:3000'+`/orders/${order.id}/return-requests`,{method:'POST',headers:{Authorization:'Bearer '+ct,'Content-Type':'application/json'},body:JSON.stringify(submission(order.itemId))});assert.equal(r.status,409);
  }
  const authorise={shippingPayer:'SELLER',instructions:'Synthetic rehearsal return instructions only.',postageInstructions:'Contact synthetic support for prepaid instructions.',rightsReviewed:true};
  await api(`/admin/returns/${f.orderId}/lines/${f.lineId}/authorize`,at,authorise);
  await api(`/admin/returns/${f.orderId}/lines/${f.lineId}/receive`,at,{receivedAt:new Date().toISOString(),note:'Synthetic operator receipt, no real goods'});
  const account=await api(`/orders/${f.orderId}/return-case`,ct);
  assert.equal(account.reference,f.reference);assert.equal(account.submissions.length,2);
  assert.equal(account.submissions[0].lines[0].status,'RECEIVED');assert.ok(account.submissions[0].lines[0].instructions);
  const line=await prisma.orderReturn.findUniqueOrThrow({where:{id:f.lineId}});assert.equal(line.receivedByUserId,f.adminId);assert.equal(line.receiptNote,'Synthetic operator receipt, no real goods');
  assert.equal(await prisma.returnCase.count({where:{orderId:f.orderId}}),1);assert.equal(await prisma.returnSubmission.count(),2);
  assert.equal(await prisma.refund.count(),0);assert.equal(await prisma.inventoryMovement.count(),0);
  assert.equal((await prisma.productListing.findUniqueOrThrow({where:{id:f.listingId}})).currentStock,20);
  const jobs=await prisma.orderConfirmationJob.findMany();assert.equal(jobs.length,1);assert.equal(jobs[0].type,'RETURN_AUTHORIZATION');assert.equal(jobs[0].state,'PENDING');
  assert.equal((await prisma.orderItem.findUniqueOrThrow({where:{id:f.itemId}})).reservedReturnQuantity,2);
  console.log(JSON.stringify({result:'PASS',fixture:f,tests:['JWT/auth/ownership','paid+dispatch eligibility','one permanent case/two requests','idempotency','admin authorise/receive','account instructions+receipt operator','durable unsent email','no refund or stock movement']}));
 }
}finally{await prisma.$disconnect()}
