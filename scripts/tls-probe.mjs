import pg from 'pg';
import {spawnSync} from 'node:child_process';
import {databaseUrl,databasePoolOptions,migrationDatabaseUrl} from '../src/config/database.ts';
const mode=process.argv[2];
if(mode==='migration'||mode==='migration-plaintext'){
 const env={...process.env,DATABASE_URL:mode==='migration'?migrationDatabaseUrl(process.env):databaseUrl(process.env)+'?sslmode=disable'};delete env.DB_PASSWORD;
 const result=spawnSync(process.execPath,['node_modules/prisma/build/index.js','db','execute','--stdin'],{env,input:'SELECT 1;',encoding:'utf8'});
 if(result.status!==0){console.error(result.stderr);process.exit(1);}
 console.log('Prisma schema-engine verified TLS query passed');
}else{
 const client=new pg.Client(mode==='plaintext'?{connectionString:databaseUrl(process.env),ssl:false}:databasePoolOptions(databaseUrl(process.env),process.env));
 try{await client.connect();await client.query('SELECT 1');console.log('Runtime verified TLS query passed');}finally{await client.end();}
}
