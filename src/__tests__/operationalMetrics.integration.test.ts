import {it,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {prisma} from '../prisma/runtime.js';
import {operationalMetrics} from '../operations/metrics.js';
after(async()=>{await prisma.$disconnect();});
it('emits real-schema heartbeat and PROCESSING refund backlog without exposing financial identities',async()=>{
 const user=await prisma.user.create({data:{email:randomUUID()+'@metrics.test',passwordHash:'synthetic'}});
 const order=await prisma.order.create({data:{userId:user.id,status:'CONFIRMED',totalAmount:10,
 billingRecipientName:'Synthetic',billingLine1:'Synthetic',billingCity:'Synthetic',billingPostcode:'TEST',billingCountryCode:'GB',
 deliveryRecipientName:'Synthetic',deliveryLine1:'Synthetic',deliveryCity:'Synthetic',deliveryPostcode:'TEST',deliveryCountryCode:'GB'}});
 const reference='metrics-'+randomUUID();
 const payment=await prisma.payment.create({data:{orderId:order.id,provider:'MANUAL',providerReference:reference,amount:10,currency:'GBP',status:'SUCCEEDED'}});
 await prisma.refund.create({data:{orderId:order.id,paymentId:payment.id,amount:1,currency:'GBP',provider:'MANUAL',providerReference:randomUUID(),status:'PROCESSING',reason:'private reason must not be emitted'}});
 const before=await prisma.refund.count({where:{OR:[{reviewRequired:true},{status:'PROCESSING'}]}});
 const logs:string[]=[];const original=console.log;
 try{console.log=(value:unknown)=>logs.push(String(value));await operationalMetrics();}finally{console.log=original;}
 assert.equal(logs.length,1);
 const output=JSON.parse(logs[0]);
 assert.equal(output.WorkerHeartbeat,1);assert.equal(output.RefundBacklog,before);
 assert.ok(output._aws.CloudWatchMetrics[0].Metrics.some((m:{Name:string})=>m.Name==='WorkerHeartbeat'));
 for(const name of ['PaymentDueAge','PayPalInboxAge','EmailDueAge','PaymentSweepAge','InventoryDiscrepancies'])assert.ok(Number.isFinite(output[name]),name);
 assert.doesNotMatch(logs[0],new RegExp(reference));assert.doesNotMatch(logs[0],/private reason|metrics.test/);
});
