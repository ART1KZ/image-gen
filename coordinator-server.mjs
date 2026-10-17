import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { JobEngine } from './job-engine.mjs';
import { runtimePaths, ensureRuntime } from './runtime-state.mjs';

export const MAX_MESSAGE_BYTES = 1024 * 1024;
const methods = new Set(['ping','list_tabs','create_tab','start_generation','get_job','list_jobs','wait_job','cancel_job']);
function parameters(params, keys) {
  if(!params || typeof params!=='object' || Array.isArray(params) || Object.keys(params).some(k=>!keys.includes(k))) throw new Error('Invalid parameters');
}
function authorized(provided,secret) {return typeof provided==='string' && /^[a-f0-9]{64}$/.test(provided) && timingSafeEqual(Buffer.from(provided),Buffer.from(secret));}

async function defaultDriverFactory() {
  // Import only this fixed, local implementation; never accept a module name over IPC.
  const { BrowserDriver } = await import('./browser-driver.mjs');
  return new BrowserDriver();
}

/** Dependencies are injectable by trusted embedding code, never by requests or environment. */
export async function startCoordinator({env=process.env,driverFactory=defaultDriverFactory}={}) {
  const paths=runtimePaths(env); const secret=await ensureRuntime(paths);
  const sockets=new Set(); let engine; let initializationError; let initialized;
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{});socket.setTimeout(35000,()=>socket.destroy());
    let bytes=0;const chunks=[];let dispatched=false;
    const reply=value=>{if(!socket.destroyed)socket.end(`${JSON.stringify(value)}\n`);};
    socket.on('data',data=>{
      if(dispatched) return;
      bytes+=data.length;
      if(bytes>MAX_MESSAGE_BYTES){dispatched=true;reply({error:{code:'TOO_LARGE',message:'Message too large'}});return;}
      chunks.push(data);
      if(!data.includes(10))return;
      dispatched=true;
      const input=Buffer.concat(chunks).toString('utf8');
      let message;
      try {message=JSON.parse(input.trim());}catch{reply({error:{code:'INVALID_REQUEST',message:'Invalid JSON request'}});return;}
      if(!message || typeof message!=='object' || !authorized(message.secret,secret)) {reply({error:{code:'UNAUTHORIZED',message:'Unauthorized'}});return;}
      void (async()=>{
        await initialized;if(initializationError)throw new Error('Coordinator initialization failed');
        if(!methods.has(message.method))throw new Error('Unknown method');
        const params=message.params===undefined?{}:message.params;
        let result;
        switch(message.method){
          case 'ping': parameters(params,[]);result={pid:process.pid,namespace:paths.namespace,version:1,protocol:1,
            max_parallel:engine.maxParallel,capacity:{max_parallel:engine.maxParallel,active:engine.operations.size,queued:[...engine.jobs.values()].filter(job=>job.status==='queued').length}};break;
          case 'list_tabs':parameters(params,[]);result=await engine.listTabs();break;
          case 'create_tab':result=await engine.createTab(params);break;
          case 'start_generation':result=await engine.startGeneration(params);break;
          case 'get_job':parameters(params,['job_id']);result=await engine.getJob(params.job_id);break;
          case 'list_jobs':parameters(params,[]);result=await engine.listJobs();break;
          case 'wait_job':parameters(params,['job_id','timeout_ms']);result=await engine.waitJob(params.job_id,params.timeout_ms);break;
          case 'cancel_job':parameters(params,['job_id']);result=await engine.cancelJob(params.job_id);break;
        }
        reply({result});
      })().catch(error=>reply({error:{code:'REQUEST_FAILED',message:error.message || 'Request failed'}}));
    });
  });
  server.maxConnections=128;
  // Never unlink a live socket. A separate exclusive startup lock makes stale-socket
  // reclamation safe even when many detached launchers race on Unix.
  let startupHandle; const lockPath=path.join(paths.stateDir,'startup.lock');
  for(let i=0;i<400;i++) {
    try {startupHandle=await fs.open(lockPath,'wx',0o600);await startupHandle.writeFile(JSON.stringify({pid:process.pid}));break;}
    catch(error) {
      if(error.code!=='EEXIST')throw error;
      try {
        const before=await fs.stat(lockPath);let lock;
        try{lock=JSON.parse(await fs.readFile(lockPath,'utf8'));}catch{}
        let alive=!!lock || Date.now()-before.mtimeMs<5000;
        if(lock && Number.isInteger(lock.pid) && lock.pid>0)try{process.kill(lock.pid,0);}catch(err){alive=err.code!=='ESRCH';}
        else if(Date.now()-before.mtimeMs>=5000)alive=false;
        if(!alive){const current=await fs.stat(lockPath);if(current.ino===before.ino && current.mtimeMs===before.mtimeMs)await fs.unlink(lockPath);}
      } catch {}
      await new Promise(r=>setTimeout(r,25));
    }
  }
  if(!startupHandle)throw new Error('Coordinator startup is busy');
  let bound=false;
  try {
    const existing=await new Promise(resolve=>{const socket=net.createConnection(paths.socketPath);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.setTimeout(500,()=>{socket.destroy();resolve(true);});});
    if(existing)return null;
    if(process.platform!=='win32')await fs.rm(paths.socketPath,{force:true});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(paths.socketPath,()=>{server.removeListener('error',reject);resolve();});});bound=true;
    if(process.platform!=='win32')await fs.chmod(paths.socketPath,0o600);
    // Browser construction is delayed until an operation needs it. Ping and registry
    // recovery must work before Edge is launched or the user is signed in.
    let driverPromise;
    const getDriver=()=>driverPromise ||= Promise.resolve().then(driverFactory);
    const lazyDriver={listTabs:async()=> (await getDriver()).listTabs(),createTab:async p=>(await getDriver()).createTab(p),
      run:async(j,o)=>(await getDriver()).run(j,o),cancel:async j=>(await getDriver()).cancel(j),close:async()=>{if(driverPromise)await (await driverPromise).close();}};
    initialized=(async()=>{try{engine=new JobEngine({driver:lazyDriver,stateDir:paths.stateDir,maxParallel:Number(env.IMAGE_GEN_MAX_PARALLEL || 2)});await engine.init();}catch(error){initializationError=error;}})();
    await initialized;
    if(initializationError)throw initializationError;
  } catch(error) {if(bound)await new Promise(resolve=>server.close(resolve));throw error;}
  finally {await startupHandle.close();await fs.rm(lockPath,{force:true});}
  let closing;
  const close=()=>closing ||= (async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));await engine.close();})();
  return {server,engine,paths,close};
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const coordinator=await startCoordinator();
    if(coordinator)for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{void coordinator.close().finally(()=>process.exit(0));});
  } catch {console.error('[image-gen] Coordinator could not start. Check local runtime permissions and configuration.');process.exitCode=1;}
}
