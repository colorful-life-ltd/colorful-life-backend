import pg from 'pg';
import {validateTargetMarker,validateMigrationHistory} from './migration-contract.mjs';
import {readdirSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {databaseUrl,databasePoolOptions} from '../src/config/database.ts';
const db=new pg.Client(databasePoolOptions(databaseUrl(process.env),process.env));
try{
 await db.connect();await db.query('BEGIN READ ONLY');await db.query("SET LOCAL statement_timeout='30s'");
 const marker=await db.query('SELECT name,database_host FROM cl_operations.environment');
 validateTargetMarker(marker.rows,process.env);
 const exists=await db.query("SELECT to_regclass('public._prisma_migrations') IS NOT NULL AS exists");
 const applied=exists.rows[0].exists?(await db.query('SELECT migration_name,checksum,finished_at,rolled_back_at FROM public._prisma_migrations ORDER BY started_at')).rows:[];
 const expected=new Map(readdirSync('prisma/migrations',{withFileTypes:true}).filter(x=>x.isDirectory()).map(x=>[x.name,createHash('sha256').update(readFileSync('prisma/migrations/'+x.name+'/migration.sql')).digest('hex')]));
 const summary=validateMigrationHistory(applied,expected,process.env.MIGRATION_WRITES_APPROVED==='true');
 console.log(JSON.stringify({event:'migration_preflight',...summary,environment:process.env.DEPLOYMENT_ENVIRONMENT}));
 await db.query('COMMIT');
}catch{console.error('Migration preflight failed; inspect target history and approved cutover');process.exitCode=1;}
finally{await db.end();}
