import assert from 'node:assert/strict';
import {before,after,it} from 'node:test';
import {randomUUID} from 'node:crypto';
import jwt from 'jsonwebtoken';
import app from '../app.js';
import {config} from '../config/index.js';
import {prisma} from '../prisma/runtime.js';
import {createOrder} from '../domain/orders/orderService.js';
import {setPayPalOrderClientForTests} from '../domain/payments/paypalOrderService.js';
import {setPayPalCaptureClientForTests} from '../domain/payments/paypalCaptureService.js';
let server:ReturnType<typeof app.listen>,base:string;
before(async()=>{server=app.listen(0);await new Promise<void>(r=>server.once('listening',r));base=`http://127.0.0.1:${(server.address() as {port:number}).port}`});
after(async()=>{await prisma.$disconnect();await new Promise<void>(r=>server.close(()=>r()))});
it('PayPal stays disabled with Sandbox credentials, enabled flags and policy; Stripe remains the only offered provider',async()=>{
 const previous={...config},environment=process.env.DEPLOYMENT_ENVIRONMENT;
 const prior=await prisma.paymentInitiationPolicy.findUniqueOrThrow({where:{provider:'PAYPAL'}});
 const user=await prisma.user.create({data:{email:`${randomUUID()}@example.invalid`,passwordHash:'not-a-login-fixture',emailVerified:true}});
 const product=await prisma.legoProduct.create({data:{setNumber:randomUUID(),title:'Sandbox fixture',theme:'TEST',ageRecommendation:'18+',pieceCount:1}});
 const listing=await prisma.productListing.create({data:{legoProductId:product.id,condition:'NEW',originalPrice:1,currentStock:3}});
 const orders:number[]=[];let calls=0,captures=0;
 const restoreCreate=setPayPalOrderClientForTests({async createOrder(){calls++;return{id:`PP-${randomUUID()}`}}});
 const restoreCapture=setPayPalCaptureClientForTests({async captureOrder(id){captures++;return{id,status:'COMPLETED',purchase_units:[{payments:{captures:[{id:`CAP-${randomUUID()}`,status:'COMPLETED',amount:{value:'3.95',currency_code:'GBP'}}]}}]}}});
 const headers={Authorization:`Bearer ${jwt.sign({id:user.id,role:'CUSTOMER'},config.JWT_SECRET)}`,'Content-Type':'application/json'};
 try{
  Object.assign(config,{PAYMENT_RESOLUTION_ENABLED:true,PAYMENT_PAYPAL_INITIATION_ENABLED:true,PAYMENT_STRIPE_INITIATION_ENABLED:false,PAYPAL_CLIENT_ID:'sandbox-fixture',PAYPAL_CLIENT_SECRET:'synthetic',PAYPAL_BASE_URL:'https://api-m.sandbox.paypal.com'});
  await prisma.paymentInitiationPolicy.update({where:{provider:'PAYPAL'},data:{enabled:true}});
  await prisma.address.create({data:{userId:user.id,recipientName:'Sandbox Buyer',line1:'1 Fictional Road',city:'London',postcode:'SW1A 1AA',countryCode:'GB',isDefaultBilling:true}});
  const order=await createOrder(user.id,{shippingMethod:'STANDARD',items:[{productListingId:listing.id,quantity:1}]});orders.push(order.id);
  const post=()=>fetch(`${base}/orders/${order.id}/payments/paypal`,{method:'POST',headers});
  const protectedResponse=await fetch(`${base}/orders/${order.id}/payments/paypal`,{method:'POST',headers:{...headers,'X-Checkout-Challenge':'unverified'}});assert.equal(protectedResponse.status,403);assert.equal(calls,0);
  process.env.DEPLOYMENT_ENVIRONMENT='production';assert.equal((await post()).status,503);
  process.env.DEPLOYMENT_ENVIRONMENT='staging';config.PAYPAL_BASE_URL='https://api-m.paypal.com';assert.equal((await post()).status,503);
  config.PAYPAL_BASE_URL='https://api-m.sandbox.paypal.com';config.PAYMENT_PAYPAL_INITIATION_ENABLED=false;assert.equal((await post()).status,503);
  config.PAYMENT_PAYPAL_INITIATION_ENABLED=true;await prisma.paymentInitiationPolicy.update({where:{provider:'PAYPAL'},data:{enabled:false}});assert.equal((await post()).status,503);
  assert.equal(calls,0);assert.equal(await prisma.payment.count({where:{orderId:order.id}}),0);
  await prisma.paymentInitiationPolicy.update({where:{provider:'PAYPAL'},data:{enabled:true}});
  const initial=await (await fetch(`${base}/orders/${order.id}`,{headers})).json();
  assert.equal(initial.paymentWindow.provider,'STRIPE');
  assert.equal(initial.paymentWindow.initiationEligibility,'INELIGIBLE');
  for(let attempt=0;attempt<2;attempt++){
   assert.equal((await post()).status,503);
   assert.equal((await fetch(`${base}/orders/${order.id}/payments/paypal/capture`,{method:'POST',headers})).status,503);
  }
  assert.equal(calls,0);assert.equal(captures,0);
  assert.equal(await prisma.payment.count({where:{orderId:order.id}}),0);

 }finally{
  restoreCreate();restoreCapture();Object.assign(config,previous);if(environment===undefined)delete process.env.DEPLOYMENT_ENVIRONMENT;else process.env.DEPLOYMENT_ENVIRONMENT=environment;
  await prisma.paymentInitiationPolicy.update({where:{provider:'PAYPAL'},data:{enabled:prior.enabled}});
  await prisma.order.deleteMany({where:{id:{in:orders}}});await prisma.inventoryMovement.deleteMany({where:{listingId:listing.id}});await prisma.productListing.delete({where:{id:listing.id}});await prisma.legoProduct.delete({where:{id:product.id}});await prisma.user.delete({where:{id:user.id}});
 }
});
