import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, ensurePrivateDirectory } from './runtime-state.mjs';

const terminal = new Set(['succeeded', 'failed', 'cancelled']);
const fields = new Set(['prompt','tab_id','new_tab','output_path','output_dir','filename','transparent_background','reference_images']);
const now = () => new Date().toISOString();
const clone = value => structuredClone(value);
function text(value, name, max=32768) { if (typeof value !== 'string' || !value.trim() || value.length>max || value.includes('\0')) throw new Error(`Invalid ${name}`); return value; }

export class JobEngine {
  constructor({ driver, stateDir, maxParallel = Number(process.env.IMAGE_GEN_MAX_PARALLEL || 2), outputDir = process.cwd() }) {
    if (!Number.isInteger(maxParallel) || maxParallel<1 || maxParallel>32) throw new Error('maxParallel must be an integer from 1 to 32');
    this.driver=driver; this.stateDir=stateDir; this.outputDir=path.resolve(outputDir); this.maxParallel=maxParallel;
    this.jobs=new Map(); this.managedTabs=new Map(); this.operations=new Map(); this.busyTabs=new Set(); this.blockedTabs=new Set(); this.chain=Promise.resolve(); this.closed=false;
  }
  async init() {
    await ensurePrivateDirectory(this.stateDir); await fs.mkdir(path.join(this.stateDir,'artifacts'),{recursive:true,mode:0o700});
    let saved;
    try { saved=JSON.parse(await fs.readFile(path.join(this.stateDir,'jobs.json'),'utf8')); }
    catch(error) { if(error.code!=='ENOENT') throw new Error('Cannot read coordinator job registry'); }
    if(saved) {
      if(saved.version!==1 || !Array.isArray(saved.jobs)) throw new Error('Invalid coordinator job registry');
      for(const tab of saved.tabs || []) this.managedTabs.set(tab.tab_id,tab);
      for(const tabId of saved.blocked_tabs || []) this.blockedTabs.add(tabId);
      for(const job of saved.jobs) {
        if(!job || typeof job.job_id!=='string') throw new Error('Invalid coordinator job registry');
        if(!terminal.has(job.status)) Object.assign(job,{status:'failed',error:'Coordinator restarted; interrupted generation was not replayed',updated_at:now(),finished_at:now()});
        this.jobs.set(job.job_id,job);
      }
      await this._persist();
    }
    return this;
  }
  _exclusive(fn) { const run=this.chain.then(fn); this.chain=run.catch(()=>{}); return run; }
  _persist() { return atomicWrite(path.join(this.stateDir,'jobs.json'),JSON.stringify({version:1,jobs:[...this.jobs.values()],tabs:[...this.managedTabs.values()],blocked_tabs:[...this.blockedTabs]})); }
  async listTabs() { return (await this.driver.listTabs()).map(tab=>({...tab,...this.managedTabs.get(tab.tab_id)})); }
  async createTab(params={}) {
    if(!params || typeof params!=='object' || Array.isArray(params) || Object.keys(params).some(k=>k!=='name')) throw new Error('Invalid tab options');
    if(params.name!==undefined) text(params.name,'name',200);
    return this._exclusive(async()=>{const tab=await this.driver.createTab(params);this.managedTabs.set(tab.tab_id,{tab_id:tab.tab_id,managed:true,...(params.name?{name:params.name}:{})});await this._persist();return {...tab,...this.managedTabs.get(tab.tab_id)};});
  }
  async startGeneration(input) {
    return this._exclusive(async()=>{
      if(this.closed) throw new Error('Coordinator is shutting down');
      if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(k=>!fields.has(k))) throw new Error('Invalid generation options');
      text(input.prompt,'prompt');
      if(input.tab_id!==undefined) text(input.tab_id,'tab_id',512);
      for(const key of ['new_tab','transparent_background']) if(input[key]!==undefined && typeof input[key]!=='boolean') throw new Error(`Invalid ${key}`);
      if(input.tab_id && input.new_tab) throw new Error('tab_id conflicts with new_tab');
      for(const key of ['output_path','output_dir','filename']) if(input[key]!==undefined) text(input[key],key,32768);
      if(input.output_path && (input.output_dir || input.filename)) throw new Error('output_path conflicts with output_dir or filename');
      if(input.filename && (input.filename==='.' || input.filename==='..' || /[\\/]/.test(input.filename))) throw new Error('filename must be a basename');
      if(input.reference_images!==undefined && (!Array.isArray(input.reference_images) || input.reference_images.length>20)) throw new Error('Invalid reference_images');
      const references=(input.reference_images || []).map(ref=>path.resolve(text(ref,'reference image')));
      for(const ref of references) { if(!(await fs.stat(ref)).isFile()) throw new Error('Reference image must be a file'); }
      const id=randomUUID();
      let filename=input.filename || `generated_${id}.png`;
      if(!/\.png$/i.test(filename))filename+='.png';
      const output=path.resolve(input.output_path || path.join(input.output_dir || this.outputDir,filename));
      if(process.platform==='win32' && output.slice(path.parse(output).root.length).split(/[\\/]/).some(part=>/[. ]$|[<>:"|?*]/.test(part)||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)))throw new Error('Invalid output path');
      const key=await this._pathKey(output);
      const runtimeKey=await this._pathKey(path.join(this.stateDir,'placeholder'));
      const runtimeDirectory=path.dirname(runtimeKey);
      if(key===runtimeDirectory || key.startsWith(runtimeDirectory+path.sep))throw new Error('Output path conflicts with private runtime state');
      for(const job of this.jobs.values()) if(!terminal.has(job.status) && job.output_key===key) throw new Error('Output path is reserved by an active job');
      let tab;
      if(input.tab_id) { tab=(await this.driver.listTabs()).find(t=>t.tab_id===input.tab_id); if(!tab) throw new Error('Unknown tab_id'); }
      else {tab=await this.driver.createTab({});this.managedTabs.set(tab.tab_id,{tab_id:tab.tab_id,managed:true});}
      if(this.blockedTabs.has(tab.tab_id)) throw new Error('Tab has an unacknowledged cancellation');
      const stamp=now(); const job={job_id:id,tab_id:tab.tab_id,prompt:input.prompt,status:'queued',output_path:output,output_key:key,
        artifact_path:path.join(this.stateDir,'artifacts',`${id}.png`),transparent_background:input.transparent_background || false,reference_images:references,
        created_at:stamp,updated_at:stamp,started_at:null,finished_at:null,cancel_requested:false,result:null,error:null};
      this.jobs.set(id,job);
      try { await this._persist(); } catch(error) { this.jobs.delete(id); throw error; }
      const accepted=clone(job); await this._drain().catch(()=>{}); return accepted;
    });
  }
  async _pathKey(file) {
    let current=path.dirname(file); const suffix=[path.basename(file)];
    while(true) { try { current=await fs.realpath(current); break; } catch(error) { if(error.code!=='ENOENT') throw error; const parent=path.dirname(current); if(parent===current) throw error; suffix.unshift(path.basename(current)); current=parent; } }
    const value=path.join(current,...suffix); return process.platform==='win32'?value.toLowerCase():value;
  }
  async _drain() {
    if(this.closed) return;
    const starts=[];
    for(const job of this.jobs.values()) {
      if(this.operations.size>=this.maxParallel) break;
      if(job.status!=='queued' || this.busyTabs.has(job.tab_id) || this.blockedTabs.has(job.tab_id)) continue;
      job.status='running'; job.started_at=job.updated_at=now();
      const op={controller:new AbortController(),runSettled:false,cancelSettled:false};
      this.operations.set(job.job_id,op); this.busyTabs.add(job.tab_id); starts.push([job,op]);
    }
    if(starts.length) {
      try { await this._persist(); }
      catch(error) { for(const [job] of starts) { this.operations.delete(job.job_id); this.busyTabs.delete(job.tab_id); job.status='queued'; } throw error; }
      for(const [job,op] of starts) void this._run(job,op);
    }
  }
  async _run(job,op) {
    try {
      if(op.controller.signal.aborted) throw new Error('Cancelled before browser submission');
      op.result=await this.driver.run(clone(job),{signal:op.controller.signal,onStage:stage=>{
        if(typeof stage==='string') void this._exclusive(async()=>{ if(!terminal.has(job.status)) {job.stage=stage.slice(0,100);job.updated_at=now();await this._persist();} }).catch(()=>{});
      }});
    } catch(error) { op.error=error; }
    op.runSettled=true;
    await this._exclusive(()=>this._finish(job,op)).catch(()=>{});
  }
  async _finish(job,op) {
    if(!op.runSettled || (job.cancel_requested && !op.cancelSettled) || !this.operations.has(job.job_id)) return;
    if(job.cancel_requested) {
      job.status=op.cancelError?'failed':'cancelled'; job.error=op.cancelError?'Browser cancellation could not be acknowledged':null;
      if(op.cancelError) {
        this.blockedTabs.add(job.tab_id);
        for(const queued of this.jobs.values())if(queued.tab_id===job.tab_id && queued.status==='queued')Object.assign(queued,{status:'failed',error:'Tab has an unacknowledged cancellation',updated_at:now(),finished_at:now()});
      }
    } else if(op.error) { job.status='failed';job.error=op.error.message || 'Generation failed'; }
    else {
      try {
        const stat=await fs.lstat(job.artifact_path); if(!stat.isFile() || stat.isSymbolicLink()) throw new Error('Generation artifact is missing');
        await fs.mkdir(path.dirname(job.output_path),{recursive:true});
        const temp=`${job.output_path}.${job.job_id}.tmp`;
        try { await fs.copyFile(job.artifact_path,temp); await fs.rename(temp,job.output_path); } finally {await fs.rm(temp,{force:true}).catch(()=>{});}
        job.status='succeeded';job.result={...op.result,artifact_path:job.artifact_path,output_path:job.output_path};
      } catch(error) {job.status='failed';job.error=error.message;}
    }
    job.updated_at=job.finished_at=now(); await this._persist();
    this.operations.delete(job.job_id); this.busyTabs.delete(job.tab_id); await this._drain();
  }
  async getJob(id) { text(id,'job_id',512); const job=this.jobs.get(id); if(!job) throw new Error('Unknown job_id'); return clone(job); }
  async listJobs() { return [...this.jobs.values()].map(clone); }
  async waitJob(id,timeoutMs=30000) {
    if(!Number.isInteger(timeoutMs) || timeoutMs<0 || timeoutMs>30000) throw new Error('timeout_ms must be an integer from 0 to 30000');
    const end=Date.now()+timeoutMs;
    while(true) {const job=await this.getJob(id);if(terminal.has(job.status)||Date.now()>=end)return job;await new Promise(r=>setTimeout(r,Math.min(25,end-Date.now())));}
  }
  async cancelJob(id) {
    return this._exclusive(async()=>{
      await this.getJob(id);const job=this.jobs.get(id);if(terminal.has(job.status)||job.cancel_requested)return clone(job);
      job.cancel_requested=true;job.updated_at=now();
      if(job.status==='queued') {job.status='cancelled';job.finished_at=now();await this._persist();return clone(job);}
      await this._persist();const op=this.operations.get(id);op.controller.abort();
      Promise.resolve().then(()=>this.driver.cancel(clone(job))).catch(error=>{op.cancelError=error;}).finally(()=>{
        op.cancelSettled=true;void this._exclusive(()=>this._finish(job,op)).catch(()=>{});
      });
      return clone(job);
    });
  }
  async close() {this.closed=true;await this.chain;await this.driver.close();}
}
