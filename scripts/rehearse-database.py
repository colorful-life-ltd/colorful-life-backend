#!/usr/bin/env python3
"""Creates ONLY a new owned temporary PostgreSQL cluster; never accepts an existing DB URL."""
import argparse,json,os,secrets,socket,subprocess,tempfile,hashlib,uuid,datetime,shutil
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--full-suite',action='store_true');parser.add_argument('--recovery-drill',action='store_true');parser.add_argument('--skip-application-tests',action='store_true');parser.add_argument('--returns-upgrade',action='store_true',help='Rehearse populated historical returns into permanent cases');parser.add_argument('--fba-upgrade',action='store_true',help='Rehearse populated migration 72 -> 73 and the real FBA service as cl_runtime');parser.add_argument('--single-admin-upgrade',action='store_true',help='Rehearse migration 74 -> 75 with existing Admin and Customer rows');args=parser.parse_args()
if sum([args.fba_upgrade,args.returns_upgrade,args.single_admin_upgrade])>1:raise RuntimeError('Run each populated upgrade separately')
root=Path(__file__).resolve().parents[1]
pg=Path('/usr/lib/postgresql/16/bin')
if not (pg/'initdb').is_file():raise RuntimeError('PostgreSQL16 binaries required; install them before the rehearsal')
owned=Path(tempfile.mkdtemp(prefix='colorful-aws-rehearsal-'))
password=secrets.token_hex(24)
pw=owned/'owner-password';pw.write_text(password);pw.chmod(0o600)
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
env={k:v for k,v in os.environ.items() if not k.startswith(('DB_','DATABASE_','TEST_DATABASE_','PG','AWS_','PAYPAL_','STRIPE_')) and k not in ['NODE_OPTIONS','NODE_TEST_CONTEXT','NODE_ENV']}
env.update(PGHOST='127.0.0.1',PGPORT=str(port),PGUSER='rehearsal_bootstrap',PGPASSWORD=password)
commands=[]
def run(command,extra=None):
 commands.append(command)
 print('RUN '+json.dumps(command),flush=True)
 subprocess.run(command,cwd=root,env={**env,**(extra or {})},check=True)
started=False
try:
 run([str(pg/'initdb'),'-D',str(owned/'data'),'-U','rehearsal_bootstrap','--pwfile',str(pw),'-A','scram-sha-256','--no-locale'])
 run([str(pg/'pg_ctl'),'-D',str(owned/'data'),'-l',str(owned/'postgres.log'),'-o',f'-h 127.0.0.1 -p {port} -k {owned} -c log_statement=none -c log_min_duration_statement=-1 -c log_parameter_max_length=0 -c log_parameter_max_length_on_error=0 -c log_min_error_statement=panic -c log_min_messages=fatal -c log_error_verbosity=terse','-w','start']);started=True
 # Model RDS's database owner without PostgreSQL SUPERUSER; the bootstrap identity is test-only.
 run(['node','--input-type=module','-e',"import pg from 'pg';import {scramVerifier} from './scripts/scram-verifier.mjs';const c=new pg.Client({database:'postgres'});await c.connect();try{await c.query(\"CREATE ROLE cl_owner LOGIN NOSUPERUSER CREATEDB CREATEROLE PASSWORD '\"+scramVerifier(process.env.PGPASSWORD)+\"'\");}finally{await c.end();}"])
 env['PGUSER']='cl_owner'
 run([str(pg/'createdb'),'colorful_life'])
 runtime=secrets.token_hex(24);migrator=secrets.token_hex(24)
 common=dict(NODE_ENV='development',DEPLOYMENT_ENVIRONMENT='staging',DB_HOST='127.0.0.1',DB_PORT=str(port),DB_NAME='colorful_life')
 run(['node','scripts/database-identities.mjs','initialize'],{**common,'DB_USER':'cl_owner','DB_PASSWORD':password,'RUNTIME_PASSWORD':runtime,'MIGRATOR_PASSWORD':migrator})
 if args.recovery_drill:
  run([str(pg/'psql'),'-d','colorful_life','-v','ON_ERROR_STOP=1','-c','REVOKE CREATE ON DATABASE colorful_life FROM cl_migrator'])
  command=['node','scripts/migrate.mjs','deploy'];commands.append(command)
  result=subprocess.run(command,cwd=root,env={**env,**common,'DB_USER':'cl_migrator','DB_PASSWORD':migrator,'MIGRATION_WRITES_APPROVED':'true'})
  if result.returncode==0:raise RuntimeError('Expected injected migration failure')
  name=sorted((root/'prisma/migrations').glob('*/migration.sql'))[0].parent.name
  now=datetime.datetime.now(datetime.timezone.utc)
  approval=dict(version=1,approvalId=str(uuid.uuid4()),environment='staging',databaseHost='127.0.0.1',migrationName=name,migrationSha256=hashlib.sha256((root/'prisma/migrations'/name/'migration.sql').read_bytes()).hexdigest(),action='rolled-back',owner='synthetic-rehearsal',reason='Injected missing CREATE privilege; first statement made no schema changes',evidence='https://github.com/synthetic/rehearsal/issues/1',servicesDrained=True,approvedAt=now.isoformat(),expiresAt=(now+datetime.timedelta(minutes=30)).isoformat())
  run(['node','scripts/recover-migration.mjs'],{**common,'DB_USER':'cl_owner','DB_PASSWORD':password,'MIGRATOR_PASSWORD':migrator,'RECOVERY_APPROVAL_JSON':json.dumps(approval)})
  run([str(pg/'psql'),'-d','colorful_life','-v','ON_ERROR_STOP=1','-c','GRANT CREATE ON DATABASE colorful_life TO cl_migrator'])
 if args.fba_upgrade or args.returns_upgrade or args.single_admin_upgrade:
  # Exercise the complete prior history in an owned directory; never hide/move source migrations.
  migrations=sorted((root/'prisma/migrations').glob('*/migration.sql'))
  fba_index=next((i for i,m in enumerate(migrations) if m.parent.name=='20261027120000_fba_shipment_builder'),-1)
  return_index=next((i for i,m in enumerate(migrations) if m.parent.name=='20261029150000_return_management_v1'),-1)
  admin_index=next((i for i,m in enumerate(migrations) if m.parent.name=='20261101120000_single_admin_bootstrap'),-1)
  if fba_index!=72 or return_index!=73 or admin_index!=74 or admin_index!=len(migrations)-1:
   raise RuntimeError('Review the baseline upgrade rehearsal when migration history changes')
  baseline=owned/'baseline-migrations';baseline.mkdir()
  shutil.copy2(root/'prisma/migrations/migration_lock.toml',baseline/'migration_lock.toml')
  baseline_end=fba_index if args.fba_upgrade else (return_index if args.returns_upgrade else admin_index)
  for migration in migrations[:baseline_end]:
   target=baseline/migration.parent.name;target.mkdir();shutil.copy2(migration,target/'migration.sql')
  config=owned/'baseline.config.ts'
  config.write_text('export default '+json.dumps({'schema':str(root/'prisma/schema.prisma'),'migrations':{'path':str(baseline)}})[:-1]+', datasource: {url: process.env.DATABASE_URL}};\n')
  run(['node','node_modules/prisma/build/index.js','migrate','deploy','--config',str(config)],{'DATABASE_URL':f'postgresql://cl_migrator:{migrator}@127.0.0.1:{port}/colorful_life'})
  run(['node','scripts/database-identities.mjs','grant'],{**common,'DB_USER':'cl_migrator','DB_PASSWORD':migrator})
  if not (root/'dist/domain/inventory/fbaShipmentService.js').is_file():run(['npm','run','build'])
  journey={**common,'DB_USER':'cl_runtime','DB_PASSWORD':runtime,'JWT_SECRET':'synthetic-runtime-rehearsal-only','PAYMENT_ABUSE_HMAC_SECRET':secrets.token_hex(32),'CLIENT_IP_MODE':'direct','LOCAL_DATABASE_REHEARSAL':'true'}
  if args.fba_upgrade:run(['node','scripts/fba-runtime-journey.mjs','seed',str(owned/'fba-fixture.json')],journey)
  if args.returns_upgrade:run(['node','scripts/return-upgrade-journey.mjs','seed',str(owned/'return-fixture.json')],journey)
  if args.single_admin_upgrade:
   fixture="import pg from 'pg';const c=new pg.Client();await c.connect();try{for(const [email,role] of [['existing-admin@single-admin.test','ADMIN'],['existing-customer@single-admin.test','CUSTOMER']])await c.query('INSERT INTO \\\"User\\\" (email,\\\"passwordHash\\\",role,\\\"emailVerified\\\",\\\"updatedAt\\\") VALUES ($1,$2,$3,true,now())',[email,'synthetic-fixture',role]);}finally{await c.end()}"
   run(['node','--input-type=module','-e',fixture],{**common,'DB_USER':'cl_runtime','DB_PASSWORD':runtime,'PGDATABASE':'colorful_life','PGUSER':'cl_runtime','PGPASSWORD':runtime})
   identities=owned/'sandbox-identities.json';identities.write_text(json.dumps({'OWNER_PASSWORD':password,'RUNTIME_PASSWORD':runtime,'MIGRATOR_PASSWORD':migrator}));identities.chmod(0o600)
   run(['node','scripts/sandbox-migrate-single-admin.mjs'],{**common,'EXPECTED_DB_SERVER':'127.0.0.1','LOCAL_DATABASE_REHEARSAL':'true','SANDBOX_IDENTITIES_FILE':str(identities),'MIGRATION_WRITES_APPROVED':'true'})
   run(['node','scripts/sandbox-migrate-single-admin.mjs'],{**common,'EXPECTED_DB_SERVER':'127.0.0.1','LOCAL_DATABASE_REHEARSAL':'true','SANDBOX_IDENTITIES_FILE':str(identities),'MIGRATION_WRITES_APPROVED':'true'})
 if not args.single_admin_upgrade:run(['node','scripts/deploy-database.mjs'],{**common,'DB_USER':'cl_migrator','DB_PASSWORD':migrator,'MIGRATION_WRITES_APPROVED':'true'})
 if args.single_admin_upgrade:
  verify="import pg from 'pg';const c=new pg.Client();await c.connect();try{const rows=await c.query('SELECT role,count(*)::int AS n FROM \\\"User\\\" WHERE email IN ($1,$2) GROUP BY role',[ 'existing-admin@single-admin.test','existing-customer@single-admin.test']);if(rows.rows.length!==2||!rows.rows.some(r=>r.role==='ADMIN'&&r.n===1)||!rows.rows.some(r=>r.role==='CUSTOMER'&&r.n===1))throw Error('Existing accounts were not preserved');for(const operation of [()=>c.query('INSERT INTO \\\"User\\\" (email,\\\"passwordHash\\\",role,\\\"updatedAt\\\") VALUES ($1,$2,$3,now())',['second-admin@single-admin.test','synthetic','ADMIN']),()=>c.query('UPDATE \\\"User\\\" SET role=\\\'ADMIN\\\' WHERE email=$1',['existing-customer@single-admin.test'])]){let rejected=false;try{await operation()}catch(e){rejected=e.code==='23505'}if(!rejected)throw Error('The database did not reject a second Admin');}}finally{await c.end()}"
  run(['node','--input-type=module','-e',verify],{**common,'DB_USER':'cl_runtime','DB_PASSWORD':runtime,'PGDATABASE':'colorful_life','PGUSER':'cl_runtime','PGPASSWORD':runtime})
 if not args.single_admin_upgrade:run(['node','scripts/runtime-privilege-probes.mjs'],{**common,'DB_USER':'cl_runtime','DB_PASSWORD':runtime})
 if args.fba_upgrade:run(['node','scripts/fba-runtime-journey.mjs','verify',str(owned/'fba-fixture.json')],journey)
 if args.returns_upgrade:run(['node','scripts/return-upgrade-journey.mjs','verify',str(owned/'return-fixture.json')],journey)
 print('FRESH DATABASE / ALL MIGRATIONS / GRANTS / RUNTIME PROBES: PASS',flush=True)
 if not args.skip_application_tests:
  run([str(pg/'createdb'),'colorful_life_test'])
  url=f'postgresql://cl_owner:{password}@127.0.0.1:{port}/colorful_life_test'
  tests=dict(TEST_DATABASE_URL=url,DATABASE_URL=f'postgresql://unused@127.0.0.1:{port}/unused_normal',JWT_SECRET='synthetic-rehearsal-only',STRIPE_SECRET_KEY='sk_test_synthetic')
  run(['npm','run','build'])
  run(['node','dist/testing/runTests.js','run','dist/__tests__/operationalMetrics.integration.test.js','dist/__tests__/emailIsolation.test.js','dist/__tests__/paymentResolutionFoundation.integration.test.js','dist/__tests__/fbaShipment.integration.test.js','dist/__tests__/fbaShipmentContract.integration.test.js'],tests)
  if args.full_suite:run(['npm','test'],tests)
finally:
 if started:run([str(pg/'pg_ctl'),'-D',str(owned/'data'),'-m','fast','-w','stop'])
 log=(owned/'postgres.log').read_text() if (owned/'postgres.log').exists() else ''
 if any(marker in log for marker in ['synthetic-sensitive-bind-marker','synthetic-sensitive-literal-marker']):raise RuntimeError('Sensitive SQL marker appeared in server logs')
 for secret in [password,locals().get('runtime',''),locals().get('migrator','')]:
  if secret and secret in log:raise RuntimeError('Plaintext synthetic credential appeared in server logs')
 (owned/'commands.json').write_text(json.dumps(commands,indent=2))
 print('Owned disposable cluster stopped; retained evidence: '+str(owned),flush=True)
