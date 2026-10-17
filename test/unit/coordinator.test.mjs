import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimePaths, readSecret, ensureRuntime } from '../../runtime-state.mjs';
import { request } from '../../coordinator-client.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
test('Windows discovery uses the same directory when a client omits or redirects LOCALAPPDATA', {skip:process.platform!=='win32'}, ()=>{
 const baseEnv={...process.env,IMAGE_GEN_STATE_DIR:undefined};
 const standard=runtimePaths({...baseEnv,LOCALAPPDATA:path.join(os.homedir(),'AppData','Local')});
 const omitted=runtimePaths({...baseEnv,LOCALAPPDATA:undefined});
 const redirected=runtimePaths({...baseEnv,LOCALAPPDATA:path.join(os.homedir(),'AppData','Local','Packages','synthetic-client','LocalCache','Local')});
 assert.equal(omitted.secretPath,standard.secretPath);
 assert.equal(redirected.secretPath,standard.secretPath);
 assert.equal(omitted.socketPath,standard.socketPath);
 assert.equal(redirected.socketPath,standard.socketPath);
 const explicit=runtimePaths({...baseEnv,IMAGE_GEN_STATE_DIR:path.join(os.tmpdir(),'explicit-image-gen-state'),LOCALAPPDATA:undefined});
 assert.equal(explicit.stateDir,path.join(os.tmpdir(),'explicit-image-gen-state',standard.namespace));
});
async function context(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'image-ipc-')); const env={...process.env,IMAGE_GEN_STATE_DIR:dir,IMAGE_GEN_PROFILE_DIR:path.join(dir,'profile')}; const paths=runtimePaths(env); const children=[];
  t.after(async()=>{try{const daemon=await request('ping',{}, {env,autoStart:false,timeoutMs:1000});process.kill(daemon.pid);}catch{}for(const child of children)if(child.exitCode===null)child.kill(); await new Promise(r=>setTimeout(r,150));await fs.rm(dir,{recursive:true,force:true});});
  function child(file,args=[]) {const processChild=spawn(process.execPath,[file,...args],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(processChild);return processChild;}
  async function ready() {for(let i=0;i<150;i++){try{return await request('ping',{}, {env,autoStart:false,timeoutMs:200});}catch{}await new Promise(r=>setTimeout(r,50));}throw new Error('coordinator did not start');}
  return {dir,env,paths,child,ready};
}
async function raw(paths,message) {return new Promise((resolve,reject)=>{const socket=net.createConnection(paths.socketPath);let result='';socket.on('connect',()=>socket.write(message));socket.on('data',data=>result+=data);socket.on('end',()=>resolve(result));socket.on('error',reject);socket.setTimeout(3000,()=>{socket.destroy();reject(new Error('timeout'));});});}
test('local IPC authenticates before dispatch and rejects unknown or oversized messages',async t=>{
 const c=await context(t);c.child('test/unit/fixtures/coordinator-fixture.mjs');await c.ready();const secret=await readSecret(c.paths);
 const discovery=await c.ready();assert.equal(discovery.protocol,1);assert.equal(discovery.capacity.max_parallel,2);
 assert.equal(JSON.parse(await raw(c.paths,JSON.stringify({secret:'wrong',method:'create_tab',params:{}})+'\n')).error.code,'UNAUTHORIZED');
 assert.equal(JSON.parse(await raw(c.paths,JSON.stringify({secret:'💣'.repeat(32),method:'ping',params:{}})+'\n')).error.code,'UNAUTHORIZED');
 assert.deepEqual(await request('list_tabs',{}, {env:c.env,autoStart:false}),[]);
 await assert.rejects(request('constructor',{}, {env:c.env,autoStart:false}),/Unknown method/);
 await assert.rejects(request('get_job',{job_id:'x',extra:1},{env:c.env,autoStart:false}),/Invalid parameters/);
 const huge=await raw(c.paths,'x'.repeat(1024*1024+1)+'\n'); assert.match(huge,/TOO_LARGE/);
 assert.equal(JSON.parse(await raw(c.paths,JSON.stringify({secret,method:'ping',params:{}})+'\n')).result.pid,(await c.ready()).pid);
});

test('conflicting discovery credentials explain state-directory mismatch',async t=>{
 const c=await context(t);c.child('test/unit/fixtures/coordinator-fixture.mjs');await c.ready();
 const otherDir=await fs.mkdtemp(path.join(os.tmpdir(),'image-discovery-'));t.after(()=>fs.rm(otherDir,{recursive:true,force:true}));
 const otherEnv={...c.env,IMAGE_GEN_STATE_DIR:otherDir};await ensureRuntime(runtimePaths(otherEnv));
 await assert.rejects(request('ping',{}, {env:otherEnv,autoStart:false}),/IMAGE_GEN_STATE_DIR/);
});
test('accepted jobs survive client disconnect and restart reports interruptions without replay',async t=>{
 const c=await context(t);const server=c.child('test/unit/fixtures/coordinator-fixture.mjs');await c.ready();
 const job=await request('start_generation',{prompt:'finish',output_dir:path.join(c.dir,'out')},{env:c.env,autoStart:false});
 const finished=await request('wait_job',{job_id:job.job_id,timeout_ms:3000},{env:c.env,autoStart:false});assert.equal(finished.status,'succeeded');assert.equal(await fs.readFile(finished.result.artifact_path,'utf8'),'finish');
 const pending=await request('start_generation',{prompt:'slow'},{env:c.env,autoStart:false});server.kill();await new Promise(r=>server.once('exit',r));
 c.child('test/unit/fixtures/coordinator-fixture.mjs');await c.ready();assert.equal((await request('get_job',{job_id:pending.job_id},{env:c.env,autoStart:false})).status,'failed');
});
test('concurrent autostart clients converge on one process without attaching a browser',async t=>{
 const c=await context(t); const clients=Array.from({length:5},()=>c.child('test/unit/fixtures/client-fixture.mjs'));
 const results=await Promise.all(clients.map(child=>new Promise((resolve,reject)=>{let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('exit',code=>code===0?resolve(JSON.parse(out)):reject(new Error(err)));})));
 assert.equal(new Set(results.map(x=>x.pid)).size,1); const pid=results[0].pid;t.after(()=>{try{process.kill(pid);}catch{}});
});

test('stale incomplete startup ownership recovers after a crashed launcher',async t=>{
 const c=await context(t);await ensureRuntime(c.paths);const lock=path.join(c.paths.stateDir,'startup.lock');await fs.writeFile(lock,'');const old=new Date(Date.now()-60000);await fs.utimes(lock,old,old);
 c.child('test/unit/fixtures/coordinator-fixture.mjs');assert.equal((await c.ready()).namespace,c.paths.namespace);
});

test('runtime namespace canonicalizes browser port and private credentials remain restricted',async t=>{
 const c=await context(t);await ensureRuntime(c.paths);
 assert.equal(runtimePaths({...c.env,IMAGE_GEN_CDP_PORT:'09222'}).namespace,runtimePaths({...c.env,IMAGE_GEN_CDP_PORT:'9222'}).namespace);
 if(process.platform!=='win32'){const mode=(await fs.stat(c.paths.secretPath)).mode;assert.equal(mode & 0o077,0);}
 else {
  const check=c.child('test/unit/fixtures/acl-fixture.mjs',[c.paths.secretPath]);let out='';check.stdout.on('data',d=>out+=d);await new Promise(r=>check.on('exit',r));assert.equal(out.trim(),'private');
 }
});
