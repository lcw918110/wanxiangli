import test from 'node:test';
import {assert,harness,heldCommand,command,json,WAIT,file,exists,writeFile,readFile,join,settled} from './fixtures.mjs';

test('SPEC[program-005] entry requires a non-empty planB before any program effect',async t=>{
  const h=await harness(t);
  for(const [name,planB]of [['missing',undefined],['empty',''],['number',48000]]){
    const r=await h.run(name,"await this.mark('invalid','ran');return true;",{}, {planB});
    assert.equal(r.state,'failed');assert.equal(r.code,'INVALID_ARGUMENT');
  }
  assert.equal(await exists(join(h.root,'invalid')),false);
  const admitted=await h.run('space','return true;',{}, {planB:' '});
  assert.notEqual(admitted.code,'INVALID_ARGUMENT',json(admitted));
  const completed=admitted.state==='parked'?await h.resume('space'):admitted;
  const final=['completed','failed','abandoned'].includes(completed.state)?completed:await settled(h.session,'space');
  assert.equal(final.state,'completed',json(final));
  assert.equal(final.value,true);
});

test('SPEC[program-005] one expired unpark window stops caller and target without implicit second resume',{timeout:15000},async t=>{
  const h=await harness(t),cmd=heldCommand(h.root,'target','actual');
  const target=await h.run('target',"this.park('ready');const result=this.call("+json(cmd)+");await this.mark('target-after','yes');return result;");
  assert.equal(target.state,'parked');
  const outer=await h.run('outer',"const result=this.unpark('target');await this.mark('outer-after','yes');return result;",{}, {planB:'xxxx'});
  assert.equal(outer.state,'parked',json(outer));assert.equal(outer.reason,'control');
  assert.equal(h.session.inspect().find(x=>x.name==='target').state,'parked');
  await file(join(h.root,'target-started'));await writeFile(join(h.root,'target-release'),'go');await file(join(h.root,'target-ended'));
  assert.equal(await exists(join(h.root,'target-after')),false);assert.equal(await exists(join(h.root,'outer-after')),false);
  const resumedOuter=await h.resume('outer');
  assert.equal(resumedOuter.state,'completed',json(resumedOuter));
  assert.equal(resumedOuter.value.name,'target');assert.equal(resumedOuter.value.state,'parked');
  assert.equal(await readFile(join(h.root,'outer-after'),'utf8'),'yes');
  assert.equal(await exists(join(h.root,'target-after')),false);
  const done=await h.resume('target');assert.equal(done.value.stdout,'actual');assert.equal(done.value.exitCode,0);
});

test('SPEC[program-005] a target completion cannot cancel its caller shared deadline',{timeout:15000},async t=>{
  const h=await harness(t);
  await h.run('fast',"this.park('ready');return 'done';");
  const cmd=heldCommand(h.root,'outer-call','output');
  const outer=await h.run('outer',"const target=this.unpark('fast');const call=this.call("+json(cmd)+");return {target,call};",{}, {planB:'xxxx'});
  assert.equal(outer.state,'parked',json(outer));assert.equal(outer.reason,'call');
  assert.equal(h.session.inspect().find(x=>x.name==='fast').state,'completed');
  await file(join(h.root,'outer-call-started'));await writeFile(join(h.root,'outer-call-release'),'go');await file(join(h.root,'outer-call-ended'));
  const done=await h.resume('outer');assert.equal(done.value.target.value,'done');assert.equal(done.value.call.stdout,'output');
});

test('SPEC[program-005] an unpark value cannot create a larger request window',{timeout:15000},async t=>{
  const h=await harness(t),cmd=heldCommand(h.root,'value','output');
  await h.run('target',"const value=this.park('ready');this.call("+json(cmd)+");return value;");
  const parked=await h.run('control',"return this.unpark('target','x'.repeat(48000));",{}, {planB:'xxxx'});
  assert.equal(parked.state,'parked');assert.equal(parked.reason,'control');
  assert.equal(h.session.inspect().find(x=>x.name==='target').state,'parked');
  await file(join(h.root,'value-started'));await writeFile(join(h.root,'value-release'),'go');await file(join(h.root,'value-ended'));
  const done=await h.resume('target');assert.equal(done.value.length,48000);
});

test('SPEC[program-005] physical replay includes the original top-level planB',async t=>{
  const h=await harness(t),body="return this.park('ready');";
  const first=await h.run('same',body,{}, {callId:'physical',planB:WAIT});
  assert.deepEqual(await h.run('same',body,{}, {callId:'physical',planB:WAIT}),first);
  const changed=await h.run('same',body,{}, {callId:'physical',planB:WAIT+'extra'});
  assert.equal(changed.code,'CALL_REPLAY_MISMATCH');
});
