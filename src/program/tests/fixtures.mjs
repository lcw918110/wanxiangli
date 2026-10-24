import assert from 'node:assert/strict';
import {access,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ProgramSession} from '../../../dist/program/Program.js';
export {assert,readFile,writeFile,join,delay};
export const WAIT='Keep waiting for the original operation and retain its real result. '.repeat(4);
export const json=JSON.stringify;
const quote=value=>"'"+String(value).replaceAll("'","'\\''")+"'";
export const command=(code,...args)=>'exec '+[quote(process.execPath),'-e',quote(code),...args.map(quote)].join(' ');
export function deferred(){let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};}
export async function exists(path){try{await access(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
export const BARRIER_MS=10000;
export async function until(check,message){const end=performance.now()+BARRIER_MS;while(!(await check())){assert.ok(performance.now()<end,message);await delay(10);}}
export const file=path=>until(()=>exists(path),'Missing file barrier: '+path);
export function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
export const inspect=session=>name=>session.inspect().find(entry=>entry.name===name);
export async function settled(session,name){
  let receipt=inspect(session)(name);
  await until(()=>{receipt=inspect(session)(name);return ['completed','failed','abandoned'].includes(receipt.state);},'program did not settle: '+name);
  return receipt;
}
export const BASE=String.raw`class JsProgram {
  constructor(api){this._api=api;}
  call(...args){return this._api.call(...args);}
  park(payload){return this._api.park(payload);}
  unpark(...args){return this._api.unpark(...args);}
  abandon(name){return this._api.abandon(name);}
  signal(name,signal){return this._api.signal(name,signal);}
  send(name,input){return this._api.send(name,input);}
  slow(){return this._api.slow();}
  mark(path,value){return this._api.mark(path,value);}
}`;
export async function harness(t){
 const root=await mkdtemp(join(tmpdir(),'wxl-program-'));
 const session=ProgramSession('test-'+randomUUID());let sequence=0;
 const run=(name,body,api={},extra={})=>session.execute({
   name,program:'class Js extends JsProgram { async run() {'+body+'\n}}',baseClass:BASE,
   callId:'call-'+(++sequence),api:{mark:(path,value)=>writeFile(join(root,path),value),...api},
   root,outputRoot:root,planB:WAIT,executionBudgetMs:1000,outputBoundBytes:1<<20,capabilities:['Read','Write','Exec'],...extra
 });
 const control=async(body,planB=WAIT)=>{const r=await run('control-'+(++sequence),body,{}, {planB});assert.notEqual(r.state,'failed',json(r));return r.state==='completed'?r.value:r;};
 const resume=(name,value,planB=WAIT)=>control('return this.unpark('+json(name)+','+json(value)+');',planB);
 t.after(async()=>{await session.close();await rm(root,{recursive:true,force:true});});
 return {root,session,run,control,resume};
}
export function heldCommand(root,name,output=''){
 return command("const fs=require('node:fs');const [start,release,end,out]=process.argv.slice(1);fs.writeFileSync(start,'started');const timer=setInterval(()=>{if(!fs.existsSync(release))return;clearInterval(timer);fs.writeFileSync(end,'ended');process.stdout.write(out);},5);",join(root,name+'-started'),join(root,name+'-release'),join(root,name+'-ended'),output);
}
export const runningCommand=(root,name)=>command("require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000);",join(root,name+'-pid'));
