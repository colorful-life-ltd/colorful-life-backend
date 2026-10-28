import pg from 'pg';
import {scramVerifier} from './scram-verifier.mjs';
import {databaseUrl,databasePoolOptions} from '../src/config/database.ts';
const mode=process.argv[2];
if(!['initialize','grant'].includes(mode))throw Error('Explicit identity operation required');
const client=new pg.Client(databasePoolOptions(databaseUrl(process.env),process.env));
const appendOnly=new Set(['OperationalAudit','FbaOutbound','FbaShipment','InventoryMovement','InventoryAudit','FinancialEvidence','ReservationReleaseProof','OrderFulfilmentEvent','ShipmentTrackingEvent','ShipmentTrackingConflict','ShipmentCarrierEvidence','CommercialInvoice']);
const deleteAllowed=new Set(['Address','CartItem','RefreshSession','EmailVerificationToken','PasswordResetToken','PasswordRecoveryLimit','ProductImage','AbuseBucket','PaymentChallengeUse']);
try {
 await client.connect();await client.query('BEGIN');
 await client.query("SET LOCAL lock_timeout='5s'");await client.query("SET LOCAL statement_timeout='60s'");
 if(mode==='initialize'){
  if(process.env.DB_USER!=='cl_owner')throw Error('Initialization requires the dedicated owner identity');
  const prior=await client.query("SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public'");
  if(prior.rows[0].count!==0)throw Error('Initialization is limited to a new empty database; existing data requires a reviewed adoption plan');
  if(!['staging','production'].includes(process.env.DEPLOYMENT_ENVIRONMENT))throw Error('Explicit environment required');
  const existing=await client.query("SELECT rolname FROM pg_roles WHERE rolname IN ('cl_runtime','cl_migrator')");
  if(existing.rowCount)throw Error('Identity initialization already performed; use reviewed rotation/recovery, never overwrite');
  for(const [name,key]of [['cl_runtime','RUNTIME_PASSWORD'],['cl_migrator','MIGRATOR_PASSWORD']]){
   const password=process.env[key];if(!password||!/^[A-Za-z0-9]{32,}$/.test(password))throw Error('Invalid generated identity credential');
   await client.query('CREATE ROLE '+name+" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD '"+scramVerifier(password)+"'");
  }
  await client.query('REVOKE ALL ON DATABASE colorful_life FROM PUBLIC');
  await client.query('GRANT CONNECT ON DATABASE colorful_life TO cl_runtime,cl_migrator');
  await client.query('GRANT CREATE ON DATABASE colorful_life TO cl_migrator');
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await client.query('GRANT cl_migrator TO cl_owner');
  await client.query('ALTER SCHEMA public OWNER TO cl_migrator');
  await client.query('REVOKE cl_migrator FROM cl_owner');
  await client.query('GRANT USAGE ON SCHEMA public TO cl_runtime');
  await client.query('CREATE SCHEMA cl_operations');
  await client.query('CREATE TABLE cl_operations.migration_recovery_events (approval_id uuid NOT NULL, phase text NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY (approval_id,phase))');
  await client.query('CREATE TABLE cl_operations.environment (name text PRIMARY KEY, database_host text NOT NULL)');
  await client.query('INSERT INTO cl_operations.environment VALUES ($1,$2)',[process.env.DEPLOYMENT_ENVIRONMENT,process.env.DB_HOST]);
  await client.query('GRANT USAGE ON SCHEMA cl_operations TO cl_migrator');
  await client.query('GRANT SELECT ON cl_operations.environment TO cl_migrator');
 }else{
  const tables=await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'_prisma_migrations'");
  // Explicit allowlist of deployed schema: newly added models require a reviewed grant contract update.
  const {readFileSync}=await import('node:fs');const contract=JSON.parse(readFileSync(new URL('./database-tables.json',import.meta.url),'utf8'));
  for(const {tablename}of tables.rows){
   if(!contract.includes(tablename))throw Error('Unknown table in runtime grant contract');
   const quoted='"'+tablename.replaceAll('"','""')+'"';
   await client.query('REVOKE ALL ON TABLE public.'+quoted+' FROM PUBLIC,cl_runtime');
   const rights=appendOnly.has(tablename)?'SELECT,INSERT':deleteAllowed.has(tablename)?'SELECT,INSERT,UPDATE,DELETE':'SELECT,INSERT,UPDATE';
   await client.query('GRANT '+rights+' ON TABLE public.'+quoted+' TO cl_runtime');
  }
  await client.query('GRANT UPDATE ("pdfBytes","pdfSha256") ON public."CommercialInvoice" TO cl_runtime');
  await client.query('GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO cl_runtime');
  await client.query("REVOKE ALL ON TABLE public._prisma_migrations FROM PUBLIC,cl_runtime");
  const roles=await client.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname='cl_runtime'");
  if(roles.rowCount!==1||Object.values(roles.rows[0]).some(Boolean))throw Error('Unsafe runtime identity');
  const bad=await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tableowner='cl_runtime'");
  if(bad.rowCount)throw Error('Runtime must not own tables');
 }
 await client.query('COMMIT');console.log('Database identity operation complete');
}catch{await client.query('ROLLBACK').catch(()=>{});console.error('Database identity operation failed; review without logging credentials');process.exitCode=1;}
finally{await client.end();}
