import {spawnSync} from 'node:child_process';
const commands=[['scripts/migration-preflight.mjs'],['scripts/migrate.mjs',process.env.MIGRATION_WRITES_APPROVED==='true'?'deploy':'status'],['scripts/database-identities.mjs','grant']];
for(const command of commands){const result=spawnSync(process.execPath,command,{env:process.env,stdio:'inherit'});if(result.status!==0)process.exit(result.status??1);}
