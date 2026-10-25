import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
const workflow=readFileSync('.github/workflows/sandbox-deploy.yml','utf8');
const marker='      - name: Check out the exact approved deployment source';
const step=workflow.slice(workflow.indexOf(marker)).split('      - uses:')[0].split('        run: |\n')[1]?.split('\n').map(l=>l.replace(/^          /,'')).join('\n');
test('deployment checks exact source before AWS credentials and retains manual admission',()=>{
 assert.ok(step);assert.ok(workflow.indexOf(marker)<workflow.indexOf('      - uses: aws-actions/configure-aws-credentials'));
 assert.ok(workflow.includes('workflow_dispatch:'));assert.ok(workflow.includes("vars.SANDBOX_BACKEND_DEPLOY_ENABLED == 'true'"));assert.ok(workflow.includes('git merge-base --is-ancestor'));assert.ok(workflow.includes('for check in verify packaging deployment-rehearsal; do'));
});
test('requested older commit supplies actual source; invalid or dirty source fails closed',()=>{
 const root=mkdtempSync(join(tmpdir(),'sandbox-source-'));
 const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
 try {
  git('init');git('config','user.email','synthetic@example.invalid');git('config','user.name','Synthetic');
  writeFileSync(join(root,'source.txt'),'older-source');git('add','.');git('commit','-m','older');const older=git('rev-parse','HEAD');
  writeFileSync(join(root,'source.txt'),'newer-source');git('commit','-am','newer');const newer=git('rev-parse','HEAD');
  assert.notEqual(older,newer);
  const run=(sha:string)=>spawnSync('bash',['-euc',step!],{cwd:root,env:{...process.env,DEPLOY_SHA:sha},encoding:'utf8'});
  assert.equal(run(older).status,0);assert.equal(git('rev-parse','HEAD'),older);assert.equal(readFileSync(join(root,'source.txt'),'utf8'),'older-source');
  assert.notEqual(run('0'.repeat(40)).status,0);
  writeFileSync(join(root,'source.txt'),'unreviewed-dirty-source');assert.notEqual(run(older).status,0);
 } finally {rmSync(root,{recursive:true,force:true});}
});
