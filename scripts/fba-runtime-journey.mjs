/** Isolated rehearsal only: invoke through rehearse-database.py --fba-upgrade. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import pg from 'pg';
import {databaseUrl,databasePoolOptions} from '../src/config/database.ts';

if(process.env.LOCAL_DATABASE_REHEARSAL!=='true'||process.env.NODE_ENV!=='development'||
 process.env.DB_HOST!=='127.0.0.1'||process.env.DB_NAME!=='colorful_life'||
 process.env.DB_USER!=='cl_runtime'||!process.env.DB_PORT||process.env.DB_PORT==='5432'){
 throw Error('Only the owned loopback runtime-identity rehearsal is supported');
}
const [mode,file]=process.argv.slice(2);
if(!['seed','verify'].includes(mode)||!file)throw Error('Explicit rehearsal mode and fixture file required');
const {prisma}=await import('../dist/prisma/runtime.js');
const sql=new pg.Client(databasePoolOptions(databaseUrl(process.env),process.env));
try{
 await sql.connect();
 assert.equal((await sql.query('SELECT current_user AS name')).rows[0].name,'cl_runtime');
 if(mode==='seed'){
  assert.equal((await sql.query(`SELECT to_regclass('public."FbaShipment"') AS shipment`)).rows[0].shipment,null);
  const admin=await prisma.user.create({data:{email:`${randomUUID()}@example.test`,passwordHash:'synthetic',role:'ADMIN',emailVerified:true}});
  const make=async(stock,reserved)=>{
   const product=await prisma.legoProduct.create({data:{setNumber:`T-${randomUUID()}`,title:'Owned upgrade fixture',theme:'TEST',ageRecommendation:'8+',pieceCount:10}});
   return prisma.productListing.create({data:{legoProductId:product.id,condition:'NEW',originalPrice:10,currentStock:stock,reservedStock:reserved}});
  };
  const a=await make(9,2),b=await make(5,1);
  const movement=await prisma.inventoryMovement.create({data:{listingId:a.id,quantityChange:-1,type:'FBA_OUTBOUND',note:'Synthetic legacy outbound',performedByUserId:admin.id}});
  // Explicit projection avoids querying the new nullable column before migration 73 exists.
  const legacy=await prisma.fbaOutbound.create({data:{productListingId:a.id,movementId:movement.id,idempotencyKey:randomUUID(),requestHash:'a'.repeat(64),shipmentReference:'SYNTHETIC-LEGACY',actualQuantity:1,appliedQuantity:1,shortfall:0,currentStockAfter:9,reservedStockAfter:2},select:{id:true}});
  const legacyRow=(await sql.query('SELECT * FROM "FbaOutbound" WHERE id=$1',[legacy.id])).rows[0];
  writeFileSync(file,JSON.stringify({admin:admin.id,a:a.id,b:b.id,legacy:legacyRow}));
  console.log('Populated migration-72 fixture seeded using cl_runtime');
 }else{
  const fixture=JSON.parse(readFileSync(file,'utf8'));
  const {recordFbaShipment}=await import('../dist/domain/inventory/fbaShipmentService.js');
  const old=(await sql.query('SELECT * FROM "FbaOutbound" WHERE id=$1',[fixture.legacy.id])).rows[0];
  const {fbaShipmentId,...unchanged}=old;assert.equal(fbaShipmentId,null);assert.deepEqual(unchanged,fixture.legacy);
  const input={idempotencyKey:randomUUID(),externalReference:'SYNTHETIC'+randomUUID().replaceAll('-',''),items:[{productListingId:fixture.a,quantity:2},{productListingId:fixture.b,quantity:1}]};
  const outcomes=await Promise.all(Array.from({length:3},()=>recordFbaShipment(input,fixture.admin)));
  assert.equal(outcomes.filter(x=>!x.replayed).length,1);
  assert.equal(new Set(outcomes.map(x=>x.shipment.id)).size,1);
  const id=outcomes[0].shipment.id;
  assert.equal(await prisma.fbaShipment.count(),1);assert.equal(await prisma.fbaOutbound.count({where:{fbaShipmentId:id}}),2);
  const a=await prisma.productListing.findUniqueOrThrow({where:{id:fixture.a}}),b=await prisma.productListing.findUniqueOrThrow({where:{id:fixture.b}});
  assert.deepEqual([a.currentStock,a.reservedStock,b.currentStock,b.reservedStock],[7,2,4,1]);
  await assert.rejects(recordFbaShipment({...input,note:'Changed payload'},fixture.admin),e=>e.code==='IDEMPOTENCY_CONFLICT');
  await assert.rejects(recordFbaShipment({...input,idempotencyKey:randomUUID()},fixture.admin),e=>e.code==='DUPLICATE_FBA_SHIPMENT');
  await assert.rejects(recordFbaShipment({idempotencyKey:randomUUID(),items:[{productListingId:fixture.a,quantity:6}]},fixture.admin),e=>e.code==='INSUFFICIENT_AVAILABLE_STOCK');
  assert.equal(await prisma.fbaShipment.count(),1);
  for(const query of ['UPDATE "FbaShipment" SET note=note','DELETE FROM "FbaShipment"','DELETE FROM "FbaShipmentSequence"','TRUNCATE "FbaShipmentSequence"']){
   await assert.rejects(sql.query(query),e=>e.code==='42501');
  }
  const after=(await sql.query('SELECT * FROM "FbaOutbound" WHERE id=$1',[fixture.legacy.id])).rows[0];
  assert.deepEqual(after,old);
  console.log('Migration 72 -> 73 preserves legacy history; real cl_runtime FBA concurrency, replay, duplicate/stock refusals and privilege denials PASS');
 }
}finally{await sql.end();await prisma.$disconnect();}
