import {it} from 'node:test';
import assert from 'node:assert/strict';
import {CreateOrderSchema} from '../domain/orders/orderValidator.js';
import {ManualPurchaseSchema} from '../domain/purchases/manualPurchaseValidator.js';
it('rejects oversized order arrays before reading or validating any element',()=>{
 let reads=0;const item={get productListingId(){reads++;return 1},get quantity(){reads++;return 1}};
 const parsed=CreateOrderSchema.safeParse({shippingMethod:'STANDARD',items:Array(34000).fill(item)});
 assert.equal(parsed.success,false);assert.equal(reads,0);
 if(!parsed.success){assert.equal(parsed.error.issues.length,1);assert.equal(parsed.error.issues[0].code,'too_big');assert.equal(JSON.stringify(parsed.error.format()).length<512,true)}
});
it('bounds manual purchase items before traversal and retains valid order data within the cap',()=>{
 let reads=0;const item={get condition(){reads++;return 'NEW'}};
 const rejected=ManualPurchaseSchema.shape.items.safeParse(Array(34000).fill(item));assert.equal(rejected.success,false);assert.equal(reads,0);
 const order={shippingMethod:'STANDARD',items:Array.from({length:500},(_,i)=>({productListingId:i+1,quantity:1}))};
 assert.deepEqual(CreateOrderSchema.parse(order),order);assert.equal(CreateOrderSchema.safeParse({...order,items:[]}).success,false);
});
