import assert from 'node:assert/strict';
import {it} from 'node:test';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
for(const workers of [false,true])it(`isolated API starts, reports readiness and drains SIGTERM (workers=${workers})`,async()=>{
 const portFinder=createServer();portFinder.listen(0,'127.0.0.1');await once(portFinder,'listening');const port=(portFinder.address() as {port:number}).port;
 await new Promise<void>(r=>portFinder.close(()=>r()));
 const child=spawn(process.execPath,['dist/index.js'],{env:{...process.env,NODE_ENV:'test',PORT:String(port),BACKGROUND_WORKERS_ENABLED:String(workers)},stdio:['ignore','pipe','pipe']});
 let output='';const exited=once(child,'exit');let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  await Promise.race([new Promise<void>((resolve,reject)=>{
   child.stdout.on('data',chunk=>{output=(output+String(chunk)).slice(-2000);if(output.includes('Server listening on port'))resolve();});
   child.once('exit',()=>reject(Error('Isolated API exited before readiness')));
  }),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Isolated API startup timeout')),15000);})]);
  if(timer)clearTimeout(timer);
  const response=await fetch(`http://127.0.0.1:${port}/ready`);assert.equal(response.status,200);
  child.kill('SIGTERM');const result=await Promise.race([exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('Shutdown timeout')),28000);})]);
  assert.equal(result[0],0);assert.equal(result[1],null);
 }finally{if(timer)clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});
