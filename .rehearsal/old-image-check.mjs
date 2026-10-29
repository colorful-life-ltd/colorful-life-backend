import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {prisma} from './dist/prisma/runtime.js';
import {cancelOrderReturn} from './dist/domain/orders/orderReturnService.js';
const f=JSON.parse(readFileSync(0,'utf8'));
try{
 const before=await prisma.orderReturn.findMany({where:{orderItemId:f.itemId},orderBy:{id:'asc'}});assert.equal(before.length,2);assert.equal(before[0].status,'RECEIVED');
 const reserved=(await prisma.orderItem.findUniqueOrThrow({where:{id:f.itemId}})).reservedReturnQuantity;assert.equal(reserved,2);
 await cancelOrderReturn(f.orderId,f.secondLineId);
 assert.equal((await prisma.orderReturn.findUniqueOrThrow({where:{id:f.secondLineId}})).status,'CANCELLED');
 assert.equal((await prisma.orderItem.findUniqueOrThrow({where:{id:f.itemId}})).reservedReturnQuantity,1);
 assert.equal(await prisma.refund.count(),0);assert.equal(await prisma.inventoryMovement.count(),0);
 console.log('PASS: exact old image reads schema74 candidate-created returns and cancels/relinquishes reservation without refunds or stock changes');
}finally{await prisma.$disconnect()}
