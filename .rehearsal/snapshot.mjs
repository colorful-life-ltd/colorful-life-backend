import pg from 'pg';import {databaseUrl,databasePoolOptions} from './dist/config/database.js';
const c=new pg.Client(databasePoolOptions(databaseUrl(process.env),process.env));
try{
 await c.connect();await c.query('BEGIN READ ONLY');const data={};
 for(const t of ['_prisma_migrations','Order','OrderItem','OrderReturn','ReturnCase','ReturnSubmission','ProductListing','InventoryMovement','OperationalAudit','OrderConfirmationJob','Payment','Refund']){
  data[t]=(await c.query('SELECT to_jsonb(t) AS row FROM public."'+t+'" t ORDER BY t.id')).rows.map(r=>r.row);
 }
 data.privileges=(await c.query(`SELECT table_name,privilege_type FROM information_schema.role_table_grants WHERE grantee='cl_runtime' ORDER BY table_name,privilege_type`)).rows;
 if(data._prisma_migrations.length!==74||data._prisma_migrations.some(r=>!r.finished_at||r.rolled_back_at))throw Error('Migration history not complete');
 if(data.Refund.length!==0||data.InventoryMovement.length!==3||data.InventoryMovement.some(m=>m.type!=='WEBSITE_SALE'||m.quantityChange>=0))throw Error('Unintended refund/stock movement');
 await c.query('ROLLBACK');console.log(JSON.stringify(data));
}finally{await c.end()}
