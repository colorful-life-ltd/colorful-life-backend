import assert from 'node:assert/strict';
import { after, afterEach, beforeEach, it } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { prisma } from '../prisma/runtime.js';
import { config } from '../config/index.js';
import { createOrder } from '../domain/orders/orderService.js';
import { confirmOrder } from '../domain/orders/orderConfirmationService.js';
import { getCustomerOrder, listCustomerOrders } from '../domain/orders/orderReadService.js';
import { createAdminProductUpdateService } from '../domain/products/adminProductUpdateService.js';
import { getCatalogueProductById } from '../domain/products/productCatalogueService.js';
import { addCartItem } from '../domain/cart/cartService.js';
import { recordFbaOutbound } from '../domain/inventory/fbaOutboundService.js';
import { reconcileStocktake, writeOffInventory } from '../domain/inventory/inventoryAdjustmentService.js';
import { createAdminProductListingService } from '../domain/products/adminProductListingService.js';
import { requestPaidCancellation, withdrawPaidCancellation } from '../domain/orders/paidCancellation.js';
import { fulfilmentEligibility } from '../domain/fulfilment/fulfilmentService.js';
import { reconcileRefundWebhook } from '../domain/refunds/refundWebhookService.js';
const managed=config.PAYMENT_RESOLUTION_ENABLED;
beforeEach(()=>{config.PAYMENT_RESOLUTION_ENABLED=false;});
afterEach(()=>{config.PAYMENT_RESOLUTION_ENABLED=managed;});
after(()=>prisma.$disconnect());
const contract=JSON.parse(readFileSync('contracts/integration-v1.json','utf8'));
async function fixture(stock=10) {
 const admin=await prisma.user.create({data:{email:`${randomUUID()}@integration.test`,passwordHash:'synthetic',role:'ADMIN',emailVerified:true}});
 const user=await prisma.user.create({data:{email:`${randomUUID()}@integration.test`,passwordHash:'synthetic',emailVerified:true,addresses:{create:{recipientName:'Test Customer',line1:'1 Test Road',city:'London',postcode:'SW1A 1AA',countryCode:'GB',isDefaultBilling:true}}}});
 const product=await prisma.legoProduct.create({data:{setNumber:randomUUID(),title:'Integration contract',theme:'TEST',ageRecommendation:'8+',pieceCount:1}});
 const listing=await prisma.productListing.create({data:{legoProductId:product.id,condition:'NEW',originalPrice:20,currentStock:stock}});
 return {admin,user,product,listing};
}
async function paid() {
 const f=await fixture();
 const order=await createOrder(f.user.id,{shippingMethod:'STANDARD',items:[{productListingId:f.listing.id,quantity:1}]},randomUUID());
 // A fixed successful financial fixture isolates read contracts; provider finality
 // transitions are covered by productionReviewRemediation.integration.test.ts.
 const payment=await prisma.payment.create({data:{orderId:order.id,amount:order.totalAmount,currency:'GBP',provider:'STRIPE',status:'SUCCEEDED',paidAt:new Date(),providerReference:`pi_${randomUUID()}`}});
 await confirmOrder(f.admin.id,order.id);
 return {...f,order,payment};
}
it('explicit availability policy never derives Discontinued from stock; it blocks new purchases while retaining old orders and URLs',async()=>{
 const f=await paid(), update=createAdminProductUpdateService();
 await assert.rejects(update.update(f.product.id,{availabilityState:'DISCONTINUED'}),/ADMIN/);
 await update.update(f.product.id,{availabilityState:'DISCONTINUED',availabilityReason:'Definitively confirmed no future restock or sale'},f.admin.id);
 const page=await getCatalogueProductById(f.product.id);assert.equal(page?.availability,'DISCONTINUED');assert.deepEqual(page?.offers,[]);
 await assert.rejects(addCartItem(f.user.id,f.listing.id,1));
 await assert.rejects(createOrder(f.user.id,{shippingMethod:'STANDARD',items:[{productListingId:f.listing.id,quantity:1}]},randomUUID()));
 assert.equal((await getCustomerOrder(f.user.id,f.order.id))?.status,'CONFIRMED');
 await update.update(f.product.id,{isPublished:false});assert.ok(await getCatalogueProductById(f.product.id));
 const draft=await prisma.legoProduct.create({data:{setNumber:randomUUID(),title:'Private draft',theme:'TEST',ageRecommendation:'8+',pieceCount:1,isPublished:false}});
 assert.equal(await getCatalogueProductById(draft.id),null);
 await update.update(f.product.id,{isPublished:true,availabilityState:'STANDARD',availabilityReason:'Administrator restored regular availability'},f.admin.id);
 assert.equal((await getCatalogueProductById(f.product.id))?.availability,'IN_STOCK');
 const empty=await fixture(0);assert.equal((await getCatalogueProductById(empty.product.id))?.availability,'OUT_OF_STOCK');
 await update.update(empty.product.id,{availabilityState:'MORE_ON_THE_WAY',availabilityReason:'Confirmed supplier replenishment expected'},empty.admin.id);
 assert.equal((await getCatalogueProductById(empty.product.id))?.availability,'MORE_ON_THE_WAY');
 await assert.rejects(addCartItem(empty.user.id,empty.listing.id,1));
});
it('FBA contract records applied/shortfall; reasoned idempotent stocktake resolves the exact discrepancy without replaying an old count',async()=>{
 const f=await fixture(),order=await createOrder(f.user.id,{shippingMethod:'STANDARD',items:[{productListingId:f.listing.id,quantity:1}]},randomUUID());
 const result=await recordFbaOutbound({productListingId:f.listing.id,quantity:12,shipmentReference:randomUUID(),note:contract.shortfallOutbound.outbound.note,idempotencyKey:randomUUID()},f.admin.id);
 assert.equal(result.outbound.appliedQuantity,contract.shortfallOutbound.outbound.appliedQuantity);
 assert.equal(result.outbound.shortfall,contract.shortfallOutbound.outbound.shortfall);
 assert.equal(result.outbound.movement.quantityChange,-result.outbound.appliedQuantity);
 const position=await prisma.productListing.count({where:{id:{lt:f.listing.id}}});
 const feed=await createAdminProductListingService().list({page:Math.floor(position/50)+1,pageSize:50});
 const row=feed.items.find(l=>l.id===f.listing.id);assert.ok(row);assert.equal(row.discrepancies.length,1);
 const input={productListingId:f.listing.id,actualStock:3,reasonNote:'Warehouse physical recount confirms three units',performedByUserId:f.admin.id},key=randomUUID();
 await assert.rejects(reconcileStocktake({...input,actualStock:0},randomUUID()));
 const first=await reconcileStocktake(input,key);
 await reconcileStocktake({...input,actualStock:4},randomUUID());
 const replay=await reconcileStocktake(input,key);assert.equal(replay.listing.currentStock,first.listing.currentStock);
 assert.equal((await prisma.productListing.findUniqueOrThrow({where:{id:f.listing.id}})).currentStock,4);
 await assert.rejects(reconcileStocktake({...input,actualStock:5},key),/IDEMPOTENCY_CONFLICT/);
 assert.equal(await prisma.operationalAudit.count({where:{requestKey:`fba-resolved:${result.outbound.id}`}}),1);
 assert.ok(order.id);
});
it('write-off replay and concurrent retries deduct once; changed actor/payload cannot reuse the key',async()=>{
 const f=await fixture(),key=randomUUID(),input={sourceProductListingId:f.listing.id,quantity:2,reason:'WAREHOUSE_DAMAGE' as const,reasonNote:'Two units physically damaged',performedByUserId:f.admin.id};
 const results=await Promise.all([writeOffInventory(input,key),writeOffInventory(input,key)]);
 assert.equal(results[0].movement.id,results[1].movement.id);
 assert.equal((await prisma.productListing.findUniqueOrThrow({where:{id:f.listing.id}})).currentStock,8);
 await assert.rejects(writeOffInventory({...input,quantity:3},key),/IDEMPOTENCY_CONFLICT/);
});
it('customer projection keeps external refunds and cancellation generations visible without private audit/evidence',async()=>{
 const f=await paid();
 const request=await requestPaidCancellation(f.admin.id,f.order.id,'PRIVATE operator cancellation investigation',randomUUID());
 assert.equal((await fulfilmentEligibility(f.order.id)).reason,contract.fulfilmentError.error.reason);
 assert.equal((await getCustomerOrder(f.user.id,f.order.id))?.cancellation.state,'REQUESTED');
 await withdrawPaidCancellation(f.admin.id,f.order.id,request.requestId,'PRIVATE mistaken cancellation withdrawal',randomUUID());
 assert.equal((await getCustomerOrder(f.user.id,f.order.id))?.cancellation.state,'NONE');
 assert.equal((await fulfilmentEligibility(f.order.id)).eligible,true);
 await reconcileRefundWebhook({version:2,kind:'refund',provider:'STRIPE',id:randomUUID(),eventType:'refund.updated',reference:`re_${randomUUID()}`,parentReference:f.payment.providerReference,amount:contract.externalRefund.amount,currency:'GBP',status:'SUCCEEDED'});
 const raw=await prisma.refund.findFirstOrThrow({where:{paymentId:f.payment.id}});assert.equal(raw.performedByUserId,null);
 const detail=await getCustomerOrder(f.user.id,f.order.id);assert.equal(detail?.refunds[0].amount.toFixed(2),contract.externalRefund.amount);
 assert.equal(detail?.refunds[0].reviewRequired,false);
 const serialized=JSON.stringify(detail);for(const field of ['providerReference','performedByUserId','OperationalAudit','PRIVATE','idempotencyKey','inspectionNote'])assert.ok(!serialized.includes(field));
 assert.equal((await fulfilmentEligibility(f.order.id)).eligible,true); // Finalized partial refund remains eligible.
 const stranger=await fixture();assert.equal(await getCustomerOrder(stranger.user.id,f.order.id),null);
 assert.equal((await listCustomerOrders(stranger.user.id)).length,0);
});
