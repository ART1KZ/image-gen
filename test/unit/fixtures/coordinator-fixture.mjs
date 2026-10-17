import fs from 'node:fs/promises';
import { startCoordinator } from '../../../coordinator-server.mjs';
class FakeDriver {
 tabs=[];
 async listTabs(){return this.tabs;}
 async createTab({name}={}){const tab={tab_id:`tab-${this.tabs.length}`,title:name||'New',url:'https://chatgpt.com/',managed:true};this.tabs.push(tab);return tab;}
 async run(job,{signal}) {await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,job.prompt==='slow'?30000:100);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('aborted'));},{once:true});});await fs.writeFile(job.artifact_path,job.prompt);return {artifact_path:job.artifact_path};}
 async cancel(){}
 async close(){}
}
await startCoordinator({driverFactory:()=>new FakeDriver()});
