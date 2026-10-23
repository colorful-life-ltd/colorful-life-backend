import {test} from 'node:test';import assert from 'node:assert/strict';
import {validateRecoveryApproval} from './recovery-contract.mjs';
test('recovery requires exact target, explicit drain, evidence and expiring owner authorization',()=>{
 const env={DEPLOYMENT_ENVIRONMENT:'staging',DB_HOST:'db.internal'};
 const a={version:1,approvalId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',action:'rolled-back',environment:'staging',databaseHost:'db.internal',servicesDrained:true,migrationName:'20260815133317_init_core_domain',migrationSha256:'a'.repeat(64),owner:'owner',reason:'Verified failed first statement',evidence:'https://github.com/org/repo/issues/1',approvedAt:'2026-10-19T00:00:00Z',expiresAt:'2026-10-19T01:00:00Z'};
 assert.equal(validateRecoveryApproval(a,env,new Date('2026-10-19T00:30:00Z')),a);
 for(const change of [{databaseHost:'other'},{action:'reset'},{servicesDrained:false},{expiresAt:'2027-01-01T00:00:00Z'},{evidence:''}])assert.throws(()=>validateRecoveryApproval({...a,...change},env,new Date('2026-10-19T00:30:00Z')));
});
