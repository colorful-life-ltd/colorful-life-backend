import {it} from 'node:test';
import assert from 'node:assert/strict';
import {databaseUrl,databasePoolOptions,migrationDatabaseUrl} from '../config/database.js';
it('assembles encoded task credentials without leaking them',()=>{
 const value=databaseUrl({DB_HOST:'db.internal',DB_NAME:'colorful',DB_USER:'runtime',DB_PASSWORD:'a@b:/?#'});
 assert.equal(new URL(value!).password,'a%40b%3A%2F%3F%23');
 assert.throws(()=>databaseUrl({DATABASE_URL:'postgresql://other',DB_HOST:'db.internal'}),/exactly one/);
});
it('production rejects missing CA and TLS query overrides',()=>{
 assert.throws(()=>databasePoolOptions('postgresql://runtime:password@db.internal/app',{NODE_ENV:'production'}),/Verified RDS/);
 assert.throws(()=>databasePoolOptions('postgresql://runtime:password@db.internal/app?sslmode=no-verify',{NODE_ENV:'production',RDS_CA_FILE:'/does/not/matter'}),/overrides/);
});
it('production verifies hostname with a pinned trust file and strict schema-engine TLS',()=>{
 const env={NODE_ENV:'production',RDS_CA_FILE:'certs/rds-ca-rsa2048-g1.pem',DB_HOST:'rds.internal',DB_NAME:'app',DB_USER:'runtime',DB_PASSWORD:'private'};
 const options=databasePoolOptions(databaseUrl(env)!,env);
 assert.ok('ssl' in options);assert.equal(options.ssl?.rejectUnauthorized,true);assert.equal(options.ssl?.servername,'rds.internal');
 const migrated=new URL(migrationDatabaseUrl(env));assert.equal(migrated.searchParams.get('sslmode'),'require');assert.equal(migrated.searchParams.get('sslaccept'),'strict');assert.equal(migrated.searchParams.get('sslcert'),env.RDS_CA_FILE);
});
it('development preserves normal connection behavior',()=>assert.equal('ssl' in databasePoolOptions('postgresql://local/db',{NODE_ENV:'development'}),false));
it('TLS hostname checking rejects a valid certificate for a different host',async()=>{
 const {checkServerIdentity}=await import('node:tls');
 const cert={subjectaltname:'DNS:database.rds.amazonaws.com'} as import('node:tls').PeerCertificate;
 assert.equal(checkServerIdentity('database.rds.amazonaws.com',cert),undefined);
 const error=checkServerIdentity('different.rds.amazonaws.com',cert);assert.ok(error && 'code' in error);assert.equal(error.code,'ERR_TLS_CERT_ALTNAME_INVALID');
});
