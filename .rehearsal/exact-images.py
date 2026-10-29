"""Temporary hosted-runner-only rehearsal. Never connects to AWS or serving resources.
Uses pre-signed GET capabilities for exact immutable image objects, not AWS credentials.
"""
import os,json,subprocess,hashlib,urllib.request,urllib.error,time,secrets,datetime,importlib.util,re,shutil,base64,gzip
from pathlib import Path
assert os.environ.get('GITHUB_ACTIONS')=='true' and os.environ.get('RUNNER_ENVIRONMENT')=='github-hosted'
ROOT=Path(os.environ['GITHUB_WORKSPACE']); WORK=Path(os.environ['RUNNER_TEMP'])/'returns-exact';WORK.mkdir(mode=0o700)
OUT=ROOT/'evidence';OUT.mkdir(exist_ok=True)
CANDIDATE='dfebb5f0cb2fc128d68c2abb1d5ae040b43640e6';OLD='7363c1638ead2a10125065b71f98ef9be717385a';INFRA='b8e27080f3725d43d0d194f0e499f3ee5e829832'
BLOBS=json.loads(gzip.decompress(base64.b64decode(os.environ.pop('RETURN_REHEARSAL_BLOB_LINKS'))));REG='localhost:5000';PROJECT='returns-exact-fixture';NET='returns-exact-isolated'
INFRA_BLOB=os.environ.pop('RETURN_REHEARSAL_INFRA_SOURCE')
# All subprocesses receive no AWS credentials, object URLs or private source payload.
for key in list(os.environ):
 if key.startswith('AWS_') and key!='AWS_EC2_METADATA_DISABLED':os.environ.pop(key)
os.environ['AWS_EC2_METADATA_DISABLED']='true'
def run(args,**kw):
 result=subprocess.run(args,text=True,capture_output=True,**kw)
 if result.returncode:raise RuntimeError('Command failed: '+' '.join(args[:3])+'\n'+result.stdout[-2500:]+'\n'+result.stderr[-2500:])
 return result.stdout.strip()
def phase(name):print('PHASE: '+name,flush=True)
def request(path,data=None,method=None,headers=None):
 req=urllib.request.Request('http://127.0.0.1:5000'+path,data=data,method=method,headers=headers or {})
 with urllib.request.urlopen(req,timeout=90) as r:return r.read(),dict(r.headers)
def digest(raw):return 'sha256:'+hashlib.sha256(raw).hexdigest()
def publish(repo,manifest,blobs):
 for d in dict.fromkeys([json.loads(manifest)['config']['digest']]+[x['digest'] for x in json.loads(manifest)['layers']]):
  raw=blobs[d];assert digest(raw)==d
  _,h=request('/v2/'+repo+'/blobs/uploads/',b'',method='POST')
  location=h['Location'];location=location.replace('http://localhost:5000','http://127.0.0.1:5000')
  location+=('&' if '?' in location else '?')+'digest='+d
  req=urllib.request.Request(location,data=raw,method='PUT',headers={'Content-Type':'application/octet-stream'})
  with urllib.request.urlopen(req,timeout=90) as r:assert r.status==201
 raw=manifest.encode();d=digest(raw)
 _,h=request('/v2/'+repo+'/manifests/'+d,raw,method='PUT',headers={'Content-Type':json.loads(manifest)['mediaType']});assert h['Docker-Content-Digest']==d
 ref=REG+'/'+repo+'@'+d;run(['docker','pull',ref]);return ref

def image_meta(ref,revision):
 info=json.loads(run(['docker','image','inspect',ref]))[0]
 assert info['Config']['Labels']['org.opencontainers.image.revision']==revision
 assert info['Config']['User'] not in ('','0','root')
 return {'ref':ref,'contentDigest':ref.split('@')[1],'configDigest':info['Id'],'sourceRevision':revision}
def wait_registry():
 for _ in range(30):
  try:request('/v2/');return
  except Exception:time.sleep(1)
 raise RuntimeError('Isolated registry not ready')
def save_registry_image(ref):
 repo=ref.split('/')[1].split('@')[0];d=ref.split('@')[1]
 raw,_=request('/v2/'+repo+'/manifests/'+d,headers={'Accept':'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json'})
 assert digest(raw)==d;m=json.loads(raw);p=OUT/'candidate-registry-bundle'/repo;p.mkdir(parents=True)
 (p/'manifest.json').write_bytes(raw)
 for b in [m['config']]+m['layers']:
  content,_=request('/v2/'+repo+'/blobs/'+b['digest']);assert digest(content)==b['digest'];(p/b['digest'].split(':')[1]).write_bytes(content)
 (p/'identity.json').write_text(json.dumps({'digest':d,'sourceRevision':CANDIDATE}))

phase('Load exact old API and migration blobs into an isolated local registry')
run(['docker','run','-d','--name','returns-exact-registry','-p','127.0.0.1:5000:5000','registry:2']);wait_registry()
raw_blobs={}
for d,url in BLOBS['blobs'].items():
 try:
  with urllib.request.urlopen(url,timeout=90) as r:raw=r.read()
 except Exception:raise RuntimeError('Exact immutable blob download failed; regenerate scoped links') from None
 assert digest(raw)==d;raw_blobs[d]=raw
old_refs=[]
for i in BLOBS['images']:
 assert digest(i['manifest'].encode())==i['digest']
 repo='returns-api' if i['repository'].endswith('-api') else 'returns-migration'
 old_refs.append(publish(repo,i['manifest'],raw_blobs))
old_api,old_migration=old_refs;del raw_blobs;del BLOBS
old_info=image_meta(old_api,OLD);old_migration_info=image_meta(old_migration,OLD)
assert old_info['contentDigest']=='sha256:58545e4fbd43f0d804c13a7532b2aa5fe1d23949a712684033d2518614a4d973'
phase('Build exact reviewed candidate; no registry credentials, no deployment')
assert run(['git','-c','safe.directory='+str(ROOT/'candidate'),'-C',str(ROOT/'candidate'),'rev-parse','HEAD'])==CANDIDATE
infra_source=gzip.decompress(base64.b64decode(INFRA_BLOB))
assert hashlib.sha256(infra_source).hexdigest()=='a2f208b65e59d657eb386b840a4101ec0c80c41b9bc2f60595026c269ac0d487'
infra_path=WORK/'reviewed-deployer.py';infra_path.write_bytes(infra_source);infra_path.chmod(0o600)
new_refs=[]
for kind,file in [('api','Dockerfile'),('migration','Dockerfile.migrations')]:
 tag=REG+'/returns-'+kind+':candidate'
 run(['docker','build','--platform','linux/amd64','--file',file,'--label','org.opencontainers.image.revision='+CANDIDATE,'--label','org.opencontainers.image.source=https://github.com/colorful-life-ltd/colorful-life-backend','--tag',tag,'.'],cwd=ROOT/'candidate')
 run(['docker','push',tag]);raw,_=request('/v2/returns-'+kind+'/manifests/candidate',headers={'Accept':'application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json'})
 ref=REG+'/returns-'+kind+'@'+digest(raw);run(['docker','pull',ref]);new_refs.append(ref);save_registry_image(ref)
new_api,new_migration=new_refs
new_info=image_meta(new_api,CANDIDATE);new_migration_info=image_meta(new_migration,CANDIDATE)
identity={'old':old_info,'candidate':new_info,'oldMigration':old_migration_info,'candidateMigration':new_migration_info,'infraRevision':INFRA,'pr221':'2b1864c51028c5be613d302296cee15db99fd848','artifactFormat':'exact registry manifest plus original compressed blobs; preserve bytes/digest on promotion, do not rebuild'}
(OUT/'image-identities.json').write_text(json.dumps(identity,indent=2)+'\n');print(json.dumps(identity),flush=True)

phase('Create isolated PostgreSQL73 and repository-managed grants')
run(['docker','network','create','--internal',NET])
pw={k:secrets.token_hex(24) for k in ['owner','runtime','migrator','bootstrap']}
common={'NODE_ENV':'development','DEPLOYMENT_ENVIRONMENT':'staging','DB_HOST':'postgres','DB_PORT':'5432','DB_NAME':'colorful_life','JWT_SECRET':secrets.token_hex(32),'PAYMENT_ABUSE_HMAC_SECRET':secrets.token_hex(32),'CLIENT_IP_MODE':'direct','CORS_ALLOWED_ORIGINS':'https://rehearsal.example.invalid','FRONTEND_URL':'https://rehearsal.example.invalid','STRIPE_SECRET_KEY':'sk_test_synthetic','AWS_EC2_METADATA_DISABLED':'true','AWS_SHARED_CREDENTIALS_FILE':'/dev/null','AWS_CONFIG_FILE':'/dev/null','AWS_ACCESS_KEY_ID':'test-no-send','AWS_SECRET_ACCESS_KEY':'test-no-send','ORDER_CONFIRMATION_EMAIL_ENABLED':'false','DISPATCH_CONFIRMATION_EMAIL_ENABLED':'false','RETURN_AUTHORIZATION_EMAIL_ENABLED':'false','PAYMENT_STRIPE_INITIATION_ENABLED':'false','PAYMENT_PAYPAL_INITIATION_ENABLED':'false','PAYMENT_RESOLUTION_ENABLED':'false','REFUND_RECONCILIATION_ENABLED':'false','CARRIER_TRACKING_POLLING_ENABLED':'false','PAYMENT_CHALLENGE_ENABLED':'false','REGISTRATION_ENABLED':'false'}
def envfile(name,values):
 p=WORK/(name+'.env');p.write_text(''.join(k+'='+str(v)+'\n' for k,v in values.items()));p.chmod(0o600);return p
pg_env=envfile('postgres',{'POSTGRES_USER':'bootstrap','POSTGRES_PASSWORD':pw['bootstrap'],'POSTGRES_DB':'colorful_life'})
run(['docker','run','-d','--name',PROJECT+'-postgres-1','--network',NET,'--network-alias','postgres','--env-file',str(pg_env),'--label','com.docker.compose.project='+PROJECT,'--label','com.docker.compose.service=postgres','--health-cmd','pg_isready -U bootstrap -d colorful_life','--health-interval','1s','--health-retries','30','postgres:16'])
for _ in range(40):
 c=json.loads(run(['docker','inspect',PROJECT+'-postgres-1']))[0]
 if c['State'].get('Health',{}).get('Status')=='healthy':break
 time.sleep(1)
else:raise RuntimeError('Disposable postgres not healthy')
base_runtime={**common,'DB_USER':'cl_runtime','DB_PASSWORD':pw['runtime']}
files={}
for role in ['owner','migrator','runtime']:
 files[role]=envfile(role,{**common,'DB_USER':'cl_'+role,'DB_PASSWORD':pw[role]})
bootstrap_env=envfile('bootstrap',{**common,'DB_USER':'bootstrap','DB_PASSWORD':pw['bootstrap'],'OWNER_PASSWORD':pw['owner']})
def node(ref,code,role='runtime',payload=None):
 return run(['docker','run','--rm','-i','--network',NET,'--read-only','--cap-drop','ALL','--env-file',str(files[role]),'--entrypoint','node',ref,'--input-type=module','-e',code],input=json.dumps(payload or {}))
bootstrap="import pg from 'pg';const c=new pg.Client({host:'postgres',database:'colorful_life',user:'bootstrap',password:process.env.DB_PASSWORD});await c.connect();await c.query(\"CREATE ROLE cl_owner LOGIN NOSUPERUSER CREATEDB CREATEROLE PASSWORD '\"+process.env.OWNER_PASSWORD+\"'\");await c.query('ALTER DATABASE colorful_life OWNER TO cl_owner');await c.end();"
run(['docker','run','--rm','--network',NET,'--env-file',str(bootstrap_env),'--entrypoint','node',old_migration,'--input-type=module','-e',bootstrap])
initialize=envfile('initialize',{**common,'DB_USER':'cl_owner','DB_PASSWORD':pw['owner'],'RUNTIME_PASSWORD':pw['runtime'],'MIGRATOR_PASSWORD':pw['migrator']})
run(['docker','run','--rm','--network',NET,'--env-file',str(initialize),'--entrypoint','node',old_migration,'scripts/database-identities.mjs','initialize'])
def migrate(ref):
 p=envfile('approved-migrator',{**common,'DB_USER':'cl_migrator','DB_PASSWORD':pw['migrator'],'MIGRATION_WRITES_APPROVED':'true'})
 return run(['docker','run','--rm','--network',NET,'--env-file',str(p),'--entrypoint','node',ref,'scripts/deploy-database.mjs'])
print(migrate(old_migration),flush=True)

# Use the real reviewed deployer and Host; only replace production-host facilities
# (ECR login, systemd/metadata guard, fixed project/ref names). Migration/approval/
# context/health/switch/restore logic is unchanged. Fixture observation times are
# shortened; production timing/configuration remain unchanged.
spec=importlib.util.spec_from_file_location('deployer',infra_path);d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
d.PROJECT=PROJECT;d.API=re.compile(re.escape(REG)+r'/returns-api@sha256:[0-9a-f]{64}');d.MIGRATION=re.compile(re.escape(REG)+r'/returns-migration@sha256:[0-9a-f]{64}');d.API_STABLE_SECONDS=5;d.HEALTH_TIMEOUT={'api':30,'worker':30}
runtime_path=WORK/'runtime.json';runtime_path.write_text(json.dumps(base_runtime));runtime_path.chmod(0o600)
identities=WORK/'identities.json';identities.write_text(json.dumps({'RUNTIME_PASSWORD':pw['runtime'],'MIGRATOR_PASSWORD':pw['migrator']}));identities.chmod(0o600)
api_env=envfile('api',{**base_runtime,'BACKGROUND_WORKERS_ENABLED':'false'});worker_env=envfile('worker',{**base_runtime,'BACKGROUND_WORKERS_ENABLED':'true'})
compose=f'''name: {PROJECT}
services:
  api:
    image: {old_api}
    command: [node, dist/index.js]
    env_file: [{api_env}]
    volumes: ["{runtime_path}:/run/colorful/runtime.json:ro"]
    ports: ["127.0.0.1:3001:3000"]
    networks: [isolated]
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 1s
      retries: 20
  worker:
    image: {old_api}
    command: [node, dist/worker.js]
    env_file: [{worker_env}]
    networks: [isolated]
    healthcheck:
      test: [CMD, node, -e, "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 1s
      retries: 20
  migration_artifact:
    image: {old_migration}
    profiles: [never-start]
networks:
  isolated:
    external: true
    name: {NET}
'''
(WORK/'compose.restricted.yml').write_text(compose)
class FixtureHost(d.Host):
 def __init__(self):super().__init__(WORK);self.identities_path=identities;self.fail_next=False
 def http_ok(self,path):
  # The internal fixture network deliberately blocks published host ports.
  # Probe real HTTP inside the isolated API container instead of relaxing egress.
  result=subprocess.run(['docker','exec',PROJECT+'-api-1','node','--input-type=module','-e',"const r=await fetch('http://127.0.0.1:3000"+path+"');process.exit(r.ok?0:1)"],capture_output=True,text=True)
  return result.returncode==0
 def compose_files(self):return ['compose.restricted.yml']
 def pull(self,refs):
  for ref in refs:assert ref.startswith(REG+'/');run(['docker','pull',ref])
 def start(self,service):
  super().start(service)
  if self.fail_next and service=='api':
   self.fail_next=False
   run(['docker','rm','-f',PROJECT+'-api-1'])
   raise d.DeployError('Synthetic candidate startup failure with API container removed')
class FixtureDeployer(d.Deployer):
 def preflight(self):
  assert os.environ['RUNNER_ENVIRONMENT']=='github-hosted';assert self.health('postgres')=='healthy';assert self.host.compose_files()==['compose.restricted.yml']
h=FixtureHost();deploy=FixtureDeployer(h)
checks=[]
def check(name):checks.append(name);phase('PASS '+name)

def ready(ref):
 deploy.wait_healthy('api',ref,40);deploy.wait_healthy('worker',ref,40)
 assert h.http_ok('/health') and h.http_ok('/ready')
 for service in ['api','worker']:
  result=run(['docker','exec',PROJECT+'-'+service+'-1','node','--input-type=module','-e',"const r=await fetch('http://127.0.0.1:3000/ready');if(!r.ok)process.exit(1);console.log('ready')"])
  assert result=='ready'
phase('Old immutable API and Worker on schema73')
h.start('api');h.start('worker');ready(old_api);check('old image API/Worker startup on73')
phase('Apply migration74 and grants only on disposable PostgreSQL')
print(migrate(new_migration),flush=True)
probe_log=run(['docker','run','--rm','--network',NET,'--env-file',str(files['runtime']),'--entrypoint','node',new_migration,'scripts/runtime-privilege-probes.mjs']);print(probe_log,flush=True);(OUT/'runtime-privilege-probes.log').write_text(probe_log)
check('migration74/grants and 16 runtime denial probes')
ready(old_api);check('old immutable API/Worker readiness on74')

# Exercise new image functionality before authorizing a paired application switch.
phase('Candidate immutable image startup and synthetic HTTP return journey')
(WORK/'compose.restricted.yml').write_text(d.rewrite(compose,(old_api,old_migration),(new_api,new_migration)))
h.start('api');h.start('worker');ready(new_api)
journey=(ROOT/'.rehearsal/return-journey.mjs').read_text()
fixture=json.loads(node(new_api,journey,payload={'mode':'seed','jwt':common['JWT_SECRET']}))
journey_result=node(new_api,journey,payload={'mode':'journey','fixture':fixture,'jwt':common['JWT_SECRET']});print(journey_result,flush=True)
fixture=json.loads(journey_result)['fixture'];(WORK/'fixture.json').write_text(json.dumps(fixture));check('candidate startup/auth/ownership/eligibility/multiple submissions/authorise/receive/no refunds')

snapshot_code=(ROOT/'.rehearsal/snapshot.mjs').read_text()
before=json.loads(node(new_api,snapshot_code,role='migrator'))
(OUT/'synthetic-integrity-before.json').write_text(json.dumps(before,indent=2))
# Establish previous-image compatibility with real records created by candidate.
(WORK/'compose.restricted.yml').write_text(compose);h.start('api');h.start('worker');ready(old_api)
old_compat=node(old_api,(ROOT/'.rehearsal/old-image-check.mjs').read_text(),payload=fixture);print(old_compat,flush=True);check('old immutable client reads candidate-created returns and preserves reservation transitions')
# The old compatibility test cancels one outstanding synthetic line deliberately;
# record this expected state before all subsequent rollback integrity comparisons.
before=json.loads(node(new_api,snapshot_code,role='migrator'))
(OUT/'synthetic-integrity-before-rollback.json').write_text(json.dumps(before,indent=2))
old_sums=h.migration_checksums(old_migration);new_sums=h.migration_checksums(new_migration)
assert len(old_sums)==73 and len(new_sums)==74
postgres=h.inspect(PROJECT+'-postgres-1');server=postgres['NetworkSettings']['Networks'][NET]['IPAddress']
db={'host':'postgres','name':'colorful_life','port':5432,'server':server,'environment':'staging'}
# Preliminary synthetic approval exists ONLY inside disposable runner, never serving host.
# It does not assert release-owner approval; the script below tests the gate using
# fixture owner identity, and final evidence is emitted only after observed success.
now=datetime.datetime.now(datetime.timezone.utc)
rehearsal={'previousApi':old_api,'nextApi':new_api,'targetMigration':new_migration,'rehearsedAt':now.isoformat(),'logSha256':hashlib.sha256(old_compat.encode()).hexdigest(),'oldImageOnMigratedSchema':True,'returnWritesAndReservations':True,'apiWorkerReadiness':True,'applicationRollback':True}
artifact=(WORK/'return-additive-rehearsal.json');artifact.write_text(json.dumps(rehearsal));artifact.chmod(0o600)
approval={'version':1,'ownerApproved':True,'approvedBy':'SYNTHETIC TEST FIXTURE ONLY - NOT RELEASE OWNER APPROVAL','approvedAt':now.isoformat(),'expiresAt':(now+datetime.timedelta(hours=1)).isoformat(),'previous':{'api':old_api,'migration':old_migration},'next':{'api':new_api,'migration':new_migration},'database':db,'migrationChecksums':new_sums,'rehearsal':{**rehearsal,'artifactSha256':hashlib.sha256(artifact.read_bytes()).hexdigest()}}
ap=WORK/'return-additive-approval.json';ap.write_text(json.dumps(approval));ap.chmod(0o600)
phase('Actual reviewed deployment/rollback code with immutable fixture images')
deploy.deploy(new_api,new_migration,CANDIDATE);ready(new_api);check('approved additive deployment through real gate')
deploy.rollback();ready(old_api);check('manual application rollback to old immutable image')
assert json.loads(node(new_api,snapshot_code,role='migrator'))==before
check('history/records/grants unchanged after manual rollback')
h.fail_next=True
try:deploy.deploy(new_api,new_migration,CANDIDATE)
except d.DeployError as e:assert 'previous images restored and healthy' in str(e)
else:raise AssertionError('Synthetic failed startup was not rejected')
ready(old_api);assert json.loads(node(new_api,snapshot_code,role='migrator'))==before
check('failed candidate with missing API automatically restores old image and preserves DB')
deploy.deploy(new_api,new_migration,CANDIDATE);ready(new_api)
run(['docker','stop',PROJECT+'-api-1']);deploy.rollback();ready(old_api)
assert json.loads(node(new_api,snapshot_code,role='migrator'))==before
check('manual rollback with stopped API preserves DB')
deploy.deploy(new_api,new_migration,CANDIDATE);ready(new_api)
run(['docker','rm','-f',PROJECT+'-api-1']);deploy.rollback();ready(old_api)
after=json.loads(node(new_api,snapshot_code,role='migrator'));assert after==before
check('manual rollback with missing API preserves DB')
(OUT/'synthetic-integrity-after.json').write_text(json.dumps(after,indent=2))
result={'result':'PASS','identities':identity,'checks':checks,'migrationCount':74,'runtimeDenialProbes':16,'databaseSnapshotBeforeRollbackSha256':hashlib.sha256(json.dumps(before,sort_keys=True).encode()).hexdigest(),'databaseSnapshotAfterRollbackSha256':hashlib.sha256(json.dumps(after,sort_keys=True).encode()).hexdigest(),'isolation':'GitHub hosted runner; internal Docker network; synthetic database only; no AWS credentials, serving host/database access, real emails or provider operations','testAdaptations':'Fixture project/local registry refs and CI preflight replace production host guards; HTTP probes stay inside internal network; API observation5s instead of300s; actual migration/history/approval/context/restore code used unchanged','releaseOwnerApproval':False}
(OUT/'exact-image-rehearsal.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True)
phase('ALL EXACT-IMAGE CHECKS PASSED; no serving resources changed')
