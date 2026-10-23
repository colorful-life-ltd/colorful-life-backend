/** Owner-only metadata recovery; never rolls back DDL or resumes applications. */
import pg from 'pg';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {databaseUrl,databasePoolOptions,migrationDatabaseUrl} from '../src/config/database.ts';
import {validateRecoveryApproval} from './recovery-contract.mjs';
if(process.env.DB_USER!=='cl_owner')throw Error('Only owner identity may perform recovery');
const approval=validateRecoveryApproval(JSON.parse(process.env.RECOVERY_APPROVAL_JSON??'null'),process.env);
const checksum=createHash('sha256').update(readFileSync('prisma/migrations/'+approval.migrationName+'/migration.sql')).digest('hex');
if(checksum!==approval.migrationSha256)throw Error('Recovery source checksum mismatch');
if(!/^[A-Za-z0-9]{32,}$/.test(process.env.MIGRATOR_PASSWORD??''))throw Error('Dedicated migrator credential required for metadata recovery');
const migratorEnv={...process.env,DB_USER:'cl_migrator',DB_PASSWORD:process.env.MIGRATOR_PASSWORD};
const migrationClient=new pg.Client(databasePoolOptions(databaseUrl(migratorEnv),migratorEnv));
const client=new pg.Client(databasePoolOptions(databaseUrl(process.env),process.env));
try{
 await client.connect();
 const marker=await client.query('SELECT name,database_host FROM cl_operations.environment');
 if(marker.rows.length!==1||marker.rows[0].name!==approval.environment||marker.rows[0].database_host!==approval.databaseHost)throw Error('Recovery database binding mismatch');
 await client.query("SELECT pg_advisory_lock(hashtext('colorful-life-owner-migration-recovery'))");
 await migrationClient.connect();
 const row=(await migrationClient.query('SELECT checksum,finished_at,rolled_back_at FROM public._prisma_migrations WHERE migration_name=$1 ORDER BY started_at DESC LIMIT 1',[approval.migrationName])).rows[0];
 if(!row||row.finished_at||row.rolled_back_at||row.checksum!==checksum)throw Error('Recovery requires the exact unresolved failed migration');
 await client.query("INSERT INTO cl_operations.migration_recovery_events (approval_id,phase,details) VALUES ($1,'STARTED',$2)",[approval.approvalId,approval]);
 const env={...migratorEnv,DATABASE_URL:migrationDatabaseUrl(migratorEnv)};
 delete env.DB_PASSWORD;delete env.MIGRATOR_PASSWORD;delete env.RUNTIME_PASSWORD;delete env.RECOVERY_APPROVAL_JSON;
 const result=spawnSync(process.execPath,['node_modules/prisma/build/index.js','migrate','resolve','--'+approval.action,approval.migrationName],{env,stdio:'inherit'});
 await client.query('INSERT INTO cl_operations.migration_recovery_events (approval_id,phase,details) VALUES ($1,$2,$3)',[approval.approvalId,result.status===0?'SUCCEEDED':'FAILED',{exitCode:result.status}]);
 if(result.status!==0)throw Error('Prisma recovery did not succeed');
 console.log('Owner migration recovery audited; applications remain drained');
}catch{console.error('Owner recovery failed; retain drain and investigate audit/history');process.exitCode=1;}
finally{await migrationClient.end();await client.end();}
