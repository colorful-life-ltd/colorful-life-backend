#!/usr/bin/env python3
"""New disposable local TLS-only PostgreSQL16; no existing endpoint accepted."""
import os,secrets,socket,subprocess,tempfile
from pathlib import Path
root=Path(__file__).resolve().parents[1];owned=Path(tempfile.mkdtemp(prefix='colorful-tls-rehearsal-'));pg=Path('/usr/lib/postgresql/16/bin')
with socket.socket() as s:s.bind(('127.0.0.1',0));port=s.getsockname()[1]
password=secrets.token_hex(24);pw=owned/'owner-password';pw.write_text(password);pw.chmod(0o600)
env={k:v for k,v in os.environ.items() if not k.startswith(('DB_','DATABASE_','TEST_DATABASE_','PG','AWS_')) and k not in ['NODE_OPTIONS','NODE_TEST_CONTEXT','NODE_ENV']}
def run(args,extra=None,expected=True):
 print('RUN '+str(args),flush=True)
 before=(owned/'postgres.log').read_text().count('no encryption') if (owned/'postgres.log').exists() else 0
 result=subprocess.run(args,cwd=root,env={**env,**(extra or {})},capture_output=True,text=True)
 if (result.returncode==0)!=expected:raise RuntimeError('Unexpected TLS probe result: '+result.stdout+result.stderr)
 if not expected:
  if args[-1] in ['plaintext','migration-plaintext']:
   if (owned/'postgres.log').read_text().count('no encryption')<=before:raise RuntimeError('Expected server-side plaintext rejection was not observed')
  elif not any(word in (result.stdout+result.stderr).lower() for word in ['certificate','hostname','tls','ssl']):raise RuntimeError('Unexpected failure mechanism in TLS negative probe')
 print('PASS' if expected else 'EXPECTED TLS REJECTION',flush=True)
started=False
try:
 for name in ['ca','wrong-ca']:
  run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(owned/(name+'.key')),'-out',str(owned/(name+'.pem')),'-days','1','-subj','/CN=synthetic-'+name])
 run(['openssl','req','-newkey','rsa:2048','-nodes','-keyout',str(owned/'server.key'),'-out',str(owned/'server.csr'),'-subj','/CN=synthetic-postgres'])
 (owned/'extensions').write_text('subjectAltName=IP:127.0.0.1\n')
 run(['openssl','x509','-req','-in',str(owned/'server.csr'),'-CA',str(owned/'ca.pem'),'-CAkey',str(owned/'ca.key'),'-CAcreateserial','-out',str(owned/'server.pem'),'-days','1','-extfile',str(owned/'extensions')])
 (owned/'server.key').chmod(0o600)
 run([str(pg/'initdb'),'-D',str(owned/'data'),'-U','cl_owner','--pwfile',str(pw),'-A','scram-sha-256','--no-locale'])
 (owned/'data/pg_hba.conf').write_text('local all all scram-sha-256\nhostnossl all all 127.0.0.0/8 reject\nhostssl all all 127.0.0.0/8 scram-sha-256\n')
 run([str(pg/'pg_ctl'),'-D',str(owned/'data'),'-l',str(owned/'postgres.log'),'-o',f'-h 127.0.0.1,127.0.0.2 -p {port} -k {owned} -c ssl=on -c ssl_cert_file={owned}/server.pem -c ssl_key_file={owned}/server.key','-w','start']);started=True
 run([str(pg/'createdb'),'colorful_life'],dict(PGHOST='127.0.0.1',PGPORT=str(port),PGUSER='cl_owner',PGPASSWORD=password,PGSSLMODE='verify-full',PGSSLROOTCERT=str(owned/'ca.pem')))
 common=dict(NODE_ENV='production',DB_HOST='127.0.0.1',DB_PORT=str(port),DB_NAME='colorful_life',DB_USER='cl_owner',DB_PASSWORD=password,RDS_CA_FILE=str(owned/'ca.pem'))
 for mode in ['runtime','migration']:
  run(['node','scripts/tls-probe.mjs',mode],common)
  run(['node','scripts/tls-probe.mjs',mode],common|dict(RDS_CA_FILE=str(owned/'wrong-ca.pem')),False)
  run(['node','scripts/tls-probe.mjs',mode],common|dict(DB_HOST='127.0.0.2'),False)
 run(['node','scripts/tls-probe.mjs','plaintext'],common,False)
 run(['node','scripts/tls-probe.mjs','migration-plaintext'],common,False)
 print('TLS: runtime + upgraded Prisma engine valid CA/host PASS; wrong CA/host and plaintext REJECTED',flush=True)
finally:
 if started:run([str(pg/'pg_ctl'),'-D',str(owned/'data'),'-m','fast','-w','stop'])
 print('Owned TLS cluster stopped; evidence '+str(owned),flush=True)
