// Build-stage packaging only. Derive exact versions from the application lockfile,
// then let npm prune retain their complete dependency graphs (including engines).
import {readFileSync,writeFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync('package.json','utf8'));
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
manifest.dependencies=Object.fromEntries(['prisma','pg','dotenv'].map(name=>{
  const version=lock.packages?.['node_modules/'+name]?.version;
  if(!version)throw new Error('Missing locked migration dependency: '+name);
  return [name,version];
}));
delete manifest.devDependencies;
writeFileSync('package.json',JSON.stringify(manifest,null,2)+'\n');
