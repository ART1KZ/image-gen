import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { parseCliArgs, runCli } from '../../cli.mjs';
import { TOOL_DEFINITIONS, createToolService } from '../../service-tools.mjs';
import { request } from '../../coordinator-client.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const job=(status='queued')=>({job_id:'job-1',tab_id:'tab-1',status,output_path:'/exported/image.png',result:null,error:null});
const capture=()=>({value:'',write(text){this.value+=text;}});
async function removeAdapterTemp(directory){const resolved=await fs.realpath(directory),parent=await fs.realpath(os.tmpdir());if(path.dirname(resolved)!==parent || !path.basename(resolved).startsWith('image-adapter'))throw new Error('Refusing to remove unexpected temporary directory');await fs.rm(resolved,{recursive:true,force:true});}
function png(red,blue=0){const image=new PNG({width:16,height:16});for(let i=0;i<image.data.length;i+=4){image.data[i]=red;image.data[i+2]=blue;image.data[i+3]=255;}return PNG.sync.write(image);}

test('CLI parses target, output, references, async and headed flags without dropping prompt text',()=>{
 const args=parseCliArgs(['generate','--prompt','snow "fox" --red','--tab=target-1','--output','hero.png','--reference-image','one.png','--reference','two.png','--transparent','--async','--json','--headed']);
 assert.equal(args.command,'generate');assert.equal(args.params.prompt,'snow "fox" --red');assert.equal(args.params.tab_id,'target-1');assert.equal(args.params.output_path,'hero.png');assert.deepEqual(args.params.reference_images,['one.png','two.png']);assert.equal(args.params.transparent_background,true);assert.equal(args.async,true);assert.equal(args.json,true);assert.equal(args.headed,true);
 assert.equal(parseCliArgs(['tabs','create','--name','Hero']).params.name,'Hero');
 assert.equal(parseCliArgs(['jobs','cancel','job-2']).params.job_id,'job-2');
});
test('CLI rejects conflicting, missing, duplicate and command-inappropriate arguments',()=>{
 for(const args of [['generate'],['generate','--prompt'],['generate','--prompt','x','--tab','a','--new-tab'],['generate','--prompt','x','--output','one','--filename','two'],['generate','--prompt','x','--prompt','y'],['jobs','get'],['tabs','list','--async'],['generate','--prompt','x','--mystery'],['jobs','list','unexpected']])assert.throws(()=>parseCliArgs(args));
});
test('async CLI submits once, writes machine-readable stdout, and uses launch environment',async()=>{
 const stdout=capture(),stderr=capture(),calls=[];
 const code=await runCli(['generate','--prompt','x','--async','--json','--headed'],{stdout,stderr,env:{TEST_ENV:'yes'},request:async(method,params,options)=>{calls.push({method,params,options});return job();}});
 assert.equal(code,0);assert.equal(calls.length,1);assert.equal(calls[0].method,'start_generation');assert.equal(calls[0].options.env.IMAGE_GEN_HEADLESS,'0');assert.equal(JSON.parse(stdout.value).job_id,'job-1');assert.doesNotMatch(stdout.value,/accepted/i);
});
test('CLI waits without resubmission and distinguishes terminal failures from usage errors',async()=>{
 const calls=[];const stdout=capture(),stderr=capture();
 const code=await runCli(['generate','--prompt','x','--json'],{stdout,stderr,request:async(method)=>{calls.push(method);return method==='start_generation'?job():{...job('failed'),error:'refused'};}});
 assert.equal(code,1);assert.deepEqual(calls,['start_generation','wait_job']);assert.equal(JSON.parse(stdout.value).status,'failed');assert.match(stderr.value,/refused/);
 const invalidOut=capture();assert.equal(await runCli(['generate','--json'],{stdout:invalidOut,stderr:capture()}),2);assert.ok(JSON.parse(invalidOut.value).error);
});
test('login delegates once with a visible browser configuration',async()=>{
 let seen;assert.equal(await runCli(['login'],{stdout:capture(),stderr:capture(),env:{IMAGE_GEN_HEADLESS:'1'},login:async options=>{seen=options;return 0;}}),0);assert.equal(seen.env.IMAGE_GEN_HEADLESS,'0');
});
test('all eight MCP tools expose strict schemas and map to shared service operations',async()=>{
 assert.deepEqual(TOOL_DEFINITIONS.map(t=>t.name).sort(),['generate_image','list_tabs','create_tab','start_generation','get_job','list_jobs','wait_job','cancel_job'].sort());
 assert.equal(TOOL_DEFINITIONS.find(t=>t.name==='wait_job').inputSchema.properties.timeout_ms.maximum,30000);
 for(const tool of TOOL_DEFINITIONS)assert.equal(tool.inputSchema.additionalProperties,false);
 const calls=[];const service=createToolService({request:async(method,params)=>{calls.push({method,params});return method==='list_tabs'||method==='list_jobs'?[]:job();}});
 for(const method of ['list_tabs','create_tab','start_generation','get_job','list_jobs','wait_job','cancel_job'])assert.equal((await service.callTool(method,method==='start_generation'?{prompt:'x'}:{})).isError,undefined);
 assert.deepEqual(calls.map(c=>c.method),['list_tabs','create_tab','start_generation','get_job','list_jobs','wait_job','cancel_job']);
 assert.equal((await service.callTool('constructor',{})).isError,true);
});
test('synchronous MCP compatibility starts once and returns immutable artifact bytes after repeated bounded waits',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'image-adapter-artifact-'));t.after(()=>removeAdapterTemp(dir));const artifact=path.join(dir,'immutable.png'),output=path.join(dir,'export.png');const original=png(255),replacement=png(0,255);await fs.writeFile(artifact,original);await fs.writeFile(output,replacement);
 const accepted={...job(),output_path:output};const calls=[];let waits=0;
 const service=createToolService({request:async(method,params)=>{calls.push({method,params});if(method==='start_generation')return accepted;return ++waits===1?job('running'):{...accepted,status:'succeeded',result:{artifact_path:artifact,output_path:output}};}});
 const response=await service.callTool('generate_image',{prompt:'one',filename:'legacy',tab_id:'target'});
 assert.equal(response.isError,undefined);assert.equal(calls.filter(c=>c.method==='start_generation').length,1);assert.equal(calls.filter(c=>c.method==='wait_job').length,2);assert.ok(calls.filter(c=>c.method==='wait_job').every(c=>c.params.timeout_ms<=30000));
 assert.deepEqual(Buffer.from(response.content.find(c=>c.type==='image').data,'base64'),original);assert.equal(response.structuredContent.job_id,'job-1');assert.equal(response._meta.job_id,'job-1');assert.match(response.content[0].text,/TRANSPARENCY_REPORT/);assert.match(response.content[0].text,/export\.png/);
});
test('MCP refuses mutable-export fallback when a successful job artifact is missing',async()=>{
 const service=createToolService({request:async()=>({...job('succeeded'),result:{output_path:'stale.png'}})});
 const result=await service.callTool('generate_image',{prompt:'x'});assert.equal(result.isError,true);assert.match(result.content[0].text,/artifact_path/);
});

test('wait transport failures preserve the accepted job ID without another submission',async()=>{
 const calls=[];const failedRequest=async method=>{calls.push(method);if(method==='start_generation')return job();throw new Error('Coordinator disconnected');};
 const response=await createToolService({request:failedRequest}).callTool('generate_image',{prompt:'x'});
 assert.equal(response.isError,true);assert.equal(response.structuredContent.job_id,'job-1');assert.deepEqual(calls,['start_generation','wait_job']);
 const stdout=capture(),stderr=capture();assert.equal(await runCli(['generate','--prompt','x','--json'],{stdout,stderr,request:failedRequest}),1);
 assert.equal(JSON.parse(stdout.value).job_id,'job-1');assert.match(stderr.value,/jobs get job-1/);
});

async function processContext(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'image-adapters-'));const env={...process.env,IMAGE_GEN_STATE_DIR:path.join(dir,'state'),IMAGE_GEN_PROFILE_DIR:path.join(dir,'profile')};const server=spawn(process.execPath,[path.join(root,'test/unit/fixtures/adapter-coordinator.mjs')],{env,cwd:dir,windowsHide:true,stdio:'ignore'});t.after(async()=>{server.kill();await new Promise(r=>setTimeout(r,150));await removeAdapterTemp(dir);});for(let i=0;i<150;i++){try{await request('ping',{}, {env,autoStart:false,timeoutMs:200});return {dir,env};}catch{}await new Promise(r=>setTimeout(r,50));}throw new Error('fixture coordinator unavailable');}
async function cliProcess(args,{dir,env}){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(root,'cli.mjs'),...args],{env,cwd:dir,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);child.on('error',reject);child.on('exit',code=>resolve({code,stdout,stderr}));});}
test('real CLI processes share IPC jobs and resolve relative outputs in the caller directory',async t=>{
 const c=await processContext(t);const started=await cliProcess(['generate','--prompt','red','--tab','existing-tab','--output','relative.png','--async','--json'],c);assert.equal(started.code,0,started.stderr);const accepted=JSON.parse(started.stdout);assert.equal(accepted.output_path,path.join(c.dir,'relative.png'));assert.equal(accepted.tab_id,'existing-tab');
 const waited=await cliProcess(['jobs','wait',accepted.job_id,'--json'],c);assert.equal(waited.code,0,waited.stderr);assert.equal(JSON.parse(waited.stdout).status,'succeeded');
 const listed=await cliProcess(['tabs','list','--json'],c);assert.equal(JSON.parse(listed.stdout)[0].tab_id,'existing-tab');
 const failed=await cliProcess(['jobs','get','missing','--json'],c);assert.equal(failed.code,1);assert.ok(JSON.parse(failed.stdout).error);
});
test('real MCP stdio handshake lists eight tools and returns an image through authenticated IPC',async t=>{
 const c=await processContext(t);
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'mcp-server.mjs')],env:c.env,cwd:c.dir,stderr:'pipe'});
 const client=new Client({name:'adapter-test',version:'1.0.0'},{capabilities:{}});
 try {
   await client.connect(transport);
   assert.equal(client.getServerVersion().version,'3.0.0');
   const tools=await client.listTools();assert.equal(tools.tools.length,8);
   const tabs=await client.callTool({name:'list_tabs',arguments:{}});assert.equal(tabs.structuredContent.tabs[0].tab_id,'existing-tab');
   const response=await client.callTool({name:'generate_image',arguments:{prompt:'blue',filename:'mcp-result',new_tab:true}});
   assert.equal(response.isError,undefined,JSON.stringify(response));assert.ok(response.content.some(c=>c.type==='image'));assert.equal(response.structuredContent.status,'succeeded');assert.equal(response.structuredContent.output_path,path.join(c.dir,'mcp-result.png'));
 } finally {await client.close();}
});
