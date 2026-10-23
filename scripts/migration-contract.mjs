export function validateTargetMarker(rows,env){
 if(rows.length!==1||!env.DB_HOST||rows[0].name!==env.DEPLOYMENT_ENVIRONMENT||rows[0].database_host!==env.DB_HOST)throw Error('Environment/instance mismatch; restored targets require owner reconciliation');
}
export function validateMigrationHistory(applied,expected,approved){
 for(const row of applied){
  if(row.rolled_back_at)continue;
  if(!row.finished_at||expected.get(row.migration_name)!==row.checksum)throw Error('Failed, unknown or checksum-mismatched migration');
 }
 const finished=new Set(applied.filter(x=>x.finished_at&&!x.rolled_back_at).map(x=>x.migration_name));
 const pending=[...expected.keys()].filter(x=>!finished.has(x));
 if(pending.length&&!approved)throw Error('Pending migrations require reviewed writer drain and owner approval');
 return {applied:finished.size,pending};
}
