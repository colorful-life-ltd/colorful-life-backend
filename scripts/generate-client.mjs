import {spawnSync} from 'node:child_process';
import {readdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const result=spawnSync(process.execPath,['node_modules/prisma/build/index.js','generate'],{env:process.env,stdio:'inherit'});
if(result.status!==0)process.exit(result.status??1);
function normalize(dir){
 for(const entry of readdirSync(dir,{withFileTypes:true})){
  const path=join(dir,entry.name);
  if(entry.isDirectory())normalize(path);
  else if(path.endsWith('.ts')){const source=readFileSync(path,'utf8');writeFileSync(path,source.replace(/[ \t]+$/gm,'').trimEnd()+'\n');}
 }
}
normalize('src/generated/prisma-client');
