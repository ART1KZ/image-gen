import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobEngine } from '../../job-engine.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(fn) { for (let i=0;i<200;i++) { if (fn()) return; await new Promise(r=>setTimeout(r,5)); } assert.fail('condition timed out'); }
class ControlledDriver {
  tabs = [{tab_id:'a',title:'A',url:'https://chatgpt.com/',managed:true},{tab_id:'b',title:'B',url:'https://chatgpt.com/',managed:true}];
  active = new Map(); starts = []; cancels = new Map();
  async listTabs() { return this.tabs; }
  async createTab() { const tab={tab_id:`new-${this.tabs.length}`,title:'New',url:'https://chatgpt.com/',managed:true}; this.tabs.push(tab); return tab; }
  run(job,{signal,onStage}) { this.starts.push(job.job_id); onStage('submitted'); return new Promise((resolve,reject)=>{ this.active.set(job.job_id,{job,resolve,reject}); signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}); }); }
  cancel(job) { return new Promise(resolve=>this.cancels.set(job.job_id,resolve)); }
  async finish(id,text=id) { const run=this.active.get(id); await fs.writeFile(run.job.artifact_path,text); run.resolve({artifact_path:run.job.artifact_path}); }
  async close() {}
}
async function setup(t,options={}) { const dir=await fs.mkdtemp(path.join(os.tmpdir(),'image-engine-')); const driver=new ControlledDriver(); const engine=new JobEngine({driver,stateDir:path.join(dir,'state'),outputDir:path.join(dir,'out'),...options}); await engine.init(); t.after(async()=>{ for(const resolve of driver.cancels.values()) resolve(); await engine.close(); await fs.rm(dir,{recursive:true,force:true}); }); return {engine,driver,dir}; }

test('same-tab FIFO and cross-tab overlap respect global capacity',async t=>{
  const {engine,driver}=await setup(t);
  const a=await engine.startGeneration({prompt:'one',tab_id:'a'});
  const a2=await engine.startGeneration({prompt:'two',tab_id:'a'});
  const b=await engine.startGeneration({prompt:'three',tab_id:'b'});
  await until(()=>driver.starts.length===2);
  assert.deepEqual(driver.starts,[a.job_id,b.job_id]);
  assert.equal((await engine.listTabs()).find(tab=>tab.tab_id==='a').active_job_id,a.job_id);
  assert.equal(a.conversation_url,'https://chatgpt.com/');
  await driver.finish(a.job_id); await until(()=>driver.starts.length===3);
  assert.equal(driver.starts[2],a2.job_id);
  await driver.finish(b.job_id); await driver.finish(a2.job_id);
  assert.equal((await engine.waitJob(a2.job_id,1000)).status,'succeeded');
});

test('cancellation holds tab and capacity through browser acknowledgement and never exports',async t=>{
  const {engine,driver}=await setup(t,{maxParallel:1});
  const a=await engine.startGeneration({prompt:'one',tab_id:'a'});
  const b=await engine.startGeneration({prompt:'two',tab_id:'b'});
  await until(()=>driver.starts.length===1);
  assert.equal((await engine.cancelJob(a.job_id)).cancel_requested,true);
  await until(()=>driver.cancels.has(a.job_id)); await tick();
  assert.equal(driver.starts.length,1);
  await assert.rejects(fs.access(a.output_path));
  driver.cancels.get(a.job_id)();
  assert.equal((await engine.waitJob(a.job_id,1000)).status,'cancelled');
  await until(()=>driver.starts.length===2); await driver.finish(b.job_id);
  assert.equal((await engine.waitJob(b.job_id,1000)).status,'succeeded');
});

test('concurrent acceptance rejects active path conflict; completed artifact stays immutable',async t=>{
  const {engine,driver,dir}=await setup(t); const output=path.join(dir,'same.png');
  const accepted=await Promise.allSettled(['a','b'].map(tab_id=>engine.startGeneration({prompt:'first',tab_id,output_path:output})));
  assert.equal(accepted.filter(x=>x.status==='fulfilled').length,1);
  const a=accepted.find(x=>x.status==='fulfilled').value; await until(()=>driver.active.has(a.job_id));
  await driver.finish(a.job_id,'first'); const finished=await engine.waitJob(a.job_id,1000);
  const b=await engine.startGeneration({prompt:'second',tab_id:'b',output_path:output}); await until(()=>driver.active.has(b.job_id));
  await driver.finish(b.job_id,'second'); await engine.waitJob(b.job_id,1000);
  assert.equal(await fs.readFile(finished.result.artifact_path,'utf8'),'first');
  assert.equal(await fs.readFile(output,'utf8'),'second');
});

test('validates all accepted fields and creates a fresh tab by default',async t=>{
  const {engine,driver}=await setup(t);
  for(const input of [{prompt:''},{prompt:'x',tab_id:'a',new_tab:true},{prompt:'x',transparent_background:'yes'},{prompt:'x',reference_images:[17]},{prompt:'x',filename:'../x.png'},{prompt:'x',tab_id:'missing'},{prompt:'x',surprise:true}]) await assert.rejects(engine.startGeneration(input));
  assert.equal((await engine.listJobs()).length,0);
  const a=await engine.startGeneration({prompt:'new'}); assert.match(a.tab_id,/^new-/); await until(()=>driver.active.has(a.job_id));
  await driver.finish(a.job_id); assert.equal((await engine.waitJob(a.job_id,1000)).status,'succeeded');
  await assert.rejects(engine.waitJob(a.job_id,30001));
});

test('restart marks interrupted queued and running jobs failed without replay',async t=>{
  const {engine,driver,dir}=await setup(t);
  const a=await engine.startGeneration({prompt:'one',tab_id:'a'}); const b=await engine.startGeneration({prompt:'two',tab_id:'a'});
  await until(()=>driver.starts.length===1);
  const snapshot=JSON.parse(await fs.readFile(path.join(dir,'state','jobs.json'),'utf8'));
  const other=await fs.mkdtemp(path.join(os.tmpdir(),'image-recovery-')); t.after(()=>fs.rm(other,{recursive:true,force:true}));
  await fs.writeFile(path.join(other,'jobs.json'),JSON.stringify(snapshot));
  const newDriver=new ControlledDriver(); const recovered=new JobEngine({driver:newDriver,stateDir:other}); await recovered.init(); t.after(()=>recovered.close());
  assert.equal((await recovered.getJob(a.job_id)).status,'failed'); assert.equal((await recovered.getJob(b.job_id)).status,'failed'); assert.equal(newDriver.starts.length,0);
  await engine.cancelJob(a.job_id); await until(()=>driver.cancels.has(a.job_id)); driver.cancels.get(a.job_id)();
});

test('queued cancellation never submits, while stop acknowledgement waits for run to settle',async t=>{
  const {engine,driver}=await setup(t,{maxParallel:1});
  driver.run=function(job){this.starts.push(job.job_id);return new Promise((resolve,reject)=>this.active.set(job.job_id,{job,resolve,reject}));};
  driver.cancel=async()=>{};
  const a=await engine.startGeneration({prompt:'one',tab_id:'a'}); const b=await engine.startGeneration({prompt:'two',tab_id:'b'});
  assert.equal((await engine.cancelJob(b.job_id)).status,'cancelled');
  await engine.cancelJob(a.job_id);await tick();
  assert.equal((await engine.waitJob(a.job_id,0)).status,'running');
  await driver.finish(a.job_id,'late artifact');
  assert.equal((await engine.waitJob(a.job_id,1000)).status,'cancelled');
  assert.equal(driver.starts.length,1); await assert.rejects(fs.access(a.output_path));
});

test('cancellation acknowledgement failure fails queued jobs on the unsafe tab',async t=>{
  const {engine,driver}=await setup(t);
  driver.cancel=async()=>{throw new Error('stop was not acknowledged');};
  const a=await engine.startGeneration({prompt:'one',tab_id:'a'});const queued=await engine.startGeneration({prompt:'two',tab_id:'a'});
  await engine.cancelJob(a.job_id);assert.equal((await engine.waitJob(a.job_id,1000)).status,'failed');
  assert.equal((await engine.waitJob(queued.job_id,1000)).status,'failed');
  await assert.rejects(engine.startGeneration({prompt:'three',tab_id:'a'}),/unacknowledged/);
});

test('rejects output paths targeting private state or immutable artifacts',async t=>{
  const {engine,dir}=await setup(t);
  for(const target of ['jobs.json','ipc-secret','artifacts/previous.png'])await assert.rejects(engine.startGeneration({prompt:'x',output_path:path.join(dir,'state',target)}),/runtime/);
});

test('Windows path aliases cannot reserve one destination twice', {skip:process.platform!=='win32'},async t=>{
  const {engine,dir}=await setup(t);const output=path.join(dir,'case.png');
  const a=await engine.startGeneration({prompt:'one',tab_id:'a',output_path:output});
  await assert.rejects(engine.startGeneration({prompt:'two',tab_id:'b',output_path:output.toUpperCase()}),/reserved/);
  await assert.rejects(engine.startGeneration({prompt:'two',tab_id:'b',output_path:`${output}.`}),/Invalid output/);
  await engine.cancelJob(a.job_id);
});

test('managed tab metadata is durable across an engine restart',async t=>{
  const {engine,driver,dir}=await setup(t);const tab=await engine.createTab({name:'Artwork'});
  await engine.close();driver.tabs.find(t=>t.tab_id===tab.tab_id).managed=false;
  const recovered=new JobEngine({driver,stateDir:path.join(dir,'state')});await recovered.init();t.after(()=>recovered.close());
  const listed=(await recovered.listTabs()).find(t=>t.tab_id===tab.tab_id);assert.equal(listed.managed,true);assert.equal(listed.name,'Artwork');
});

test('basename filename retains legacy PNG extension semantics',async t=>{
 const {engine}=await setup(t);
 const job=await engine.startGeneration({prompt:'x',filename:'picture',tab_id:'a'});assert.equal(path.basename(job.output_path),'picture.png');
 const second=await engine.startGeneration({prompt:'x',filename:'UPPER.PNG',tab_id:'b'});assert.equal(path.basename(second.output_path),'UPPER.PNG');
});
