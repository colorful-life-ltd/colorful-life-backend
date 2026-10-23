export function validateRecoveryApproval(a,env,now=new Date()){
 if(a.version!==1||!['rolled-back','applied'].includes(a.action)||a.environment!==env.DEPLOYMENT_ENVIRONMENT||a.databaseHost!==env.DB_HOST||a.servicesDrained!==true)throw Error('Recovery target/action/drain approval mismatch');
 if(!/^[0-9a-f-]{36}$/.test(a.approvalId)||!/^\d{14}_[a-z0-9_]+$/.test(a.migrationName)||!/^[0-9a-f]{64}$/.test(a.migrationSha256))throw Error('Exact recovery identity/checksum required');
 if(!a.owner||!a.reason||!a.evidence?.startsWith('https://github.com/'))throw Error('Owner reason and schema/cleanup evidence required');
 const issued=new Date(a.approvedAt),expiry=new Date(a.expiresAt);
 if(!(issued<=now&&now<expiry&&expiry-issued<=4*3600000))throw Error('Recovery approval expired or exceeds four hours');
 return a;
}
