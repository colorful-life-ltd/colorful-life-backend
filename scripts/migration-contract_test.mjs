import {test} from 'node:test';
import assert from 'node:assert/strict';
import {validateMigrationHistory,validateTargetMarker} from './migration-contract.mjs';
test('restored endpoint, wrong environment and missing marker remain blocked',()=>{
 const env={DB_HOST:'original.rds.amazonaws.com',DEPLOYMENT_ENVIRONMENT:'production'};
 validateTargetMarker([{name:'production',database_host:env.DB_HOST}],env);
 for(const rows of [[],[{name:'staging',database_host:env.DB_HOST}],[{name:'production',database_host:'restored.rds.amazonaws.com'}]])assert.throws(()=>validateTargetMarker(rows,env));
});
test('failed, unknown and checksum-mismatched migrations reject even with write approval',()=>{
 const expected=new Map([['001','matching']]);
 for(const row of [{migration_name:'001',checksum:'matching',finished_at:null},{migration_name:'unknown',checksum:'matching',finished_at:new Date()},{migration_name:'001',checksum:'changed',finished_at:new Date()}])assert.throws(()=>validateMigrationHistory([row],expected,true));
});
test('pending migrations require explicit approval; recorded rollback does not count as application',()=>{
 const expected=new Map([['001','matching'],['002','next']]);
 const history=[{migration_name:'001',checksum:'matching',finished_at:new Date()},{migration_name:'002',checksum:'previous-failed-bytes',finished_at:null,rolled_back_at:new Date()}];
 assert.throws(()=>validateMigrationHistory(history,expected,false));
 assert.deepEqual(validateMigrationHistory(history,expected,true),{applied:1,pending:['002']});
 assert.deepEqual(validateMigrationHistory(history.slice(0,1),new Map([['001','matching']]),false),{applied:1,pending:[]});
});
