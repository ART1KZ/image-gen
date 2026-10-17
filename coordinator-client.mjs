import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { runtimePaths, readSecret } from './runtime-state.mjs';

const serverPath=fileURLToPath(new URL('./coordinator-server.mjs',import.meta.url));
function connect(paths,timeoutMs) {
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection(paths.socketPath);const timer=setTimeout(()=>{const error=new Error('Coordinator connection timed out');error.code='ETIMEDOUT';socket.destroy(error);},timeoutMs);
    const failed=error=>{clearTimeout(timer);reject(error);};socket.once('error',failed);
    socket.once('connect',()=>{clearTimeout(timer);socket.removeListener('error',failed);socket.on('error',()=>{});resolve(socket);});
  });
}
async function connection(paths,env,timeoutMs,autoStart) {
  let launch=false;
  try{return await connect(paths,Math.min(timeoutMs,1000));}
  catch(error){if(!autoStart || !['ENOENT','ECONNREFUSED','ETIMEDOUT','EBUSY'].includes(error.code))throw error;launch=['ENOENT','ECONNREFUSED'].includes(error.code);}
  if(launch){const child=spawn(process.execPath,[serverPath],{cwd:path.dirname(serverPath),env,detached:true,windowsHide:true,stdio:'ignore'});child.on('error',()=>{});child.unref();}
  const deadline=Date.now()+Math.min(timeoutMs,15000);
  while(Date.now()<deadline){try{return await connect(paths,Math.min(2000,deadline-Date.now()));}catch(error){if(!['ENOENT','ECONNREFUSED','ETIMEDOUT','EBUSY'].includes(error.code))throw error;}await new Promise(r=>setTimeout(r,50));}
  throw new Error('Coordinator did not become ready');
}
/** One request per connection. A sent request is never retried: it may be accepted. */
export async function request(method,params={},options={}) {
  const {timeoutMs=35000,autoStart=true,env=process.env}=options;
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw new Error('Invalid request timeout');
  if(typeof method!=='string')throw new Error('Invalid method');
  if(method==='start_generation' && params && typeof params==='object' && !Array.isArray(params)) {
    params={...params};
    for(const key of ['output_path','output_dir'])if(typeof params[key]==='string')params[key]=path.resolve(params[key]);
    if(!params.output_path && !params.output_dir)params.output_dir=process.cwd();
    if(Array.isArray(params.reference_images))params.reference_images=params.reference_images.map(p=>typeof p==='string'?path.resolve(p):p);
  }
  const paths=runtimePaths(env);const socket=await connection(paths,env,timeoutMs,autoStart);
  let secret;try{secret=await readSecret(paths);}catch(error){socket.destroy();const failure=new Error(`Coordinator discovery credentials are unavailable (${error.code || error.message}) in ${paths.stateDir}. Use the same IMAGE_GEN_STATE_DIR outside Windows AppData as the running coordinator for this browser profile.`);failure.cause=error;throw failure;}
  const message=Buffer.from(JSON.stringify({secret,method,params})+'\n');
  if(message.length>1024*1024){socket.destroy();throw new Error('Message too large');}
  return new Promise((resolve,reject)=>{
    const chunks=[];let bytes=0;let settled=false;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(result);};
    const timer=setTimeout(()=>finish(new Error('Coordinator request timed out; accepted jobs continue running')),timeoutMs);
    socket.on('error',error=>finish(error));socket.on('end',()=>{if(!settled)finish(new Error('Coordinator disconnected; request outcome is unknown'));});
    socket.on('data',data=>{
      bytes+=data.length;if(bytes>16*1024*1024){finish(new Error('Coordinator response too large'));return;}chunks.push(data);
      if(!data.includes(10))return;
      try{const reply=JSON.parse(Buffer.concat(chunks).toString('utf8').trim());if(reply.error){const error=new Error(reply.error.code==='UNAUTHORIZED'?'Coordinator credentials do not match. Use the same IMAGE_GEN_STATE_DIR as the running coordinator for this browser profile.':reply.error.message);error.code=reply.error.code;finish(error);}else finish(null,reply.result);}
      catch(error){finish(error);}
    });
    socket.write(message);
  });
}
