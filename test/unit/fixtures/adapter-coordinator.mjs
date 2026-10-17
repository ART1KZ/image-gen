import fs from 'node:fs/promises';
import { PNG } from 'pngjs';
import { startCoordinator } from '../../../coordinator-server.mjs';
class AdapterDriver {
 tabs=[{tab_id:'existing-tab',title:'Existing',url:'https://chatgpt.com/',managed:false}];
 async listTabs(){return this.tabs;}
 async createTab({name}={}){const tab={tab_id:`tab-${this.tabs.length}`,title:name||'New',url:'https://chatgpt.com/',managed:true};this.tabs.push(tab);return tab;}
 async run(job,{signal}){await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,100);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new Error('aborted'));},{once:true});});if(job.prompt==='fail')throw new Error('fixture failure');const image=new PNG({width:16,height:16});for(let i=0;i<image.data.length;i+=4){image.data[i]=job.prompt==='blue'?0:255;image.data[i+2]=job.prompt==='blue'?255:0;image.data[i+3]=255;}await fs.writeFile(job.artifact_path,PNG.sync.write(image));return {artifact_path:job.artifact_path};}
 async cancel(){}
 async close(){}
}
await startCoordinator({driverFactory:()=>new AdapterDriver()});
