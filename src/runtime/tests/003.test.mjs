import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync,linkSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSession } from '../../../dist/runtime/Runtime.js'
function fixture(t,callbacks={}) {
  const space=mkdtempSync(join(tmpdir(),'runtime-files-')),root=join(space,'project')
  mkdirSync(root);t.after(()=>rmSync(space,{recursive:true,force:true}))
  return {space,root,path:name=>join(root,name),files:FileSession({root,...callbacks})}
}
const ok=result=>{assert.equal(result.ok,true,JSON.stringify(result));return result}
const changed=result=>{assert.equal(result.ok,false,JSON.stringify(result));assert.equal(result.code,'FILE_CHANGED')}
function reject(code){const error=new Error(code);error.__jsFailure={code,reason:code};throw error}
test('FileSession: reread explicitly accepts external version',t=>{
  const {files,path}=fixture(t);writeFileSync(path('a'),'first');assert.equal(ok(files.cat('a')).text,'first')
  writeFileSync(path('a'),'outside');changed(files.write('a','next'));assert.equal(readFileSync(path('a'),'utf8'),'outside')
  assert.equal(ok(files.cat('a')).text,'outside');ok(files.write('a','next'));assert.equal(readFileSync(path('a'),'utf8'),'next')
})
test('FileSession: unread write establishes a guarded version',t=>{
  const {files,path}=fixture(t);writeFileSync(path('a'),'seed');ok(files.write('a','known'))
  writeFileSync(path('a'),'outside');changed(files.write('a','next'));assert.equal(readFileSync(path('a'),'utf8'),'outside')
})
test('FileSession: symlink read shares canonical guard',t=>{
  const {files,path}=fixture(t);writeFileSync(path('a'),'first');symlinkSync('a',path('alias'))
  assert.equal(ok(files.cat('alias')).text,'first');writeFileSync(path('a'),'outside');changed(files.write('a','next'))
})
test('FileSession: audit keeps caller paths and read reports canonical path',t=>{
  const before=[],after=[],reads=[],token={}
  const {files,path}=fixture(t,{before:m=>{before.push(m);return token},after:(m,v)=>after.push({m,v}),read:(absolute,text)=>reads.push({absolute,text})})
  mkdirSync(path('nested'));writeFileSync(path('nested/a'),'old');ok(files.cat('nested/a'));ok(files.write('nested/a','new'))
  assert.deepEqual(reads,[{absolute:realpathSync(path('nested/a')),text:'old'}]);assert.equal(before.length,1)
  assert.equal(before[0].path,'nested/a');assert.equal(before[0].originalText,'old');assert.equal(before[0].newText,'new')
  assert.equal(after.length,1);assert.equal(after[0].m.path,'nested/a');assert.equal(after[0].v,token)
  assert.equal(readFileSync(path('nested/a'),'utf8'),'new')
})
test('FileSession: admission denial has no physical effect',t=>{
  let afterCount=0
  const {files,path}=fixture(t,{before:()=>reject('TEST_FILE_DENIED'),after:()=>afterCount++})
  writeFileSync(path('a'),'old');const result=files.write('a','new')
  assert.equal(result.ok,false);assert.equal(result.code,'TEST_FILE_DENIED');assert.equal(readFileSync(path('a'),'utf8'),'old');assert.equal(afterCount,0)
})
test('FileSession: receipt failure keeps committed bytes and version',t=>{
  const {files,path}=fixture(t,{after:()=>reject('TEST_RECEIPT_FAILED')})
  writeFileSync(path('a'),'old');const result=files.write('a','committed')
  assert.equal(result.code,'TEST_RECEIPT_FAILED');assert.equal(readFileSync(path('a'),'utf8'),'committed')
  writeFileSync(path('a'),'outside');changed(files.write('a','next'))
})
test('FileSession: mkdir omits file ledger and stat/ls retain shapes',t=>{
  const mutations=[];const {files,path}=fixture(t,{before:v=>mutations.push(v),after:v=>mutations.push(v)})
  ok(files.mkdir('folder'));assert.deepEqual(mutations,[]);assert.equal(lstatSync(path('folder')).isDirectory(),true)
  assert.equal(files.mkdir('folder').code,'DIRECTORY_EXISTS');assert.equal(files.mkdir('missing/child').code,'PARENT_DIRECTORY_MISSING')
  writeFileSync(path('plain'),'text');assert.deepEqual(ok(files.stat('missing')).stat,{exists:false,size:0,mtime:null,isDir:false})
  const stat=ok(files.stat('plain')).stat;assert.equal(stat.exists,true);assert.equal(stat.size,4);assert.equal(stat.isDir,false);assert.ok(Number.isFinite(Date.parse(stat.mtime)))
  assert.deepEqual(new Set(ok(files.ls('.')).entries),new Set(['folder/','plain']))
})
test('FileSession: rm/mv receipts and audits keep caller paths',t=>{
  const mutations=[];const {files,path}=fixture(t,{before:v=>mutations.push(v)});writeFileSync(path('a'),'text')
  assert.deepEqual(files.mv('./a','./b'),{ok:true,moved:'./a',destination:'./b'});assert.equal(mutations[0].path,'./a');assert.equal(mutations[0].destination,'./b')
  assert.equal(existsSync(path('a')),false);assert.equal(readFileSync(path('b'),'utf8'),'text')
  assert.deepEqual(files.rm('./b'),{ok:true,removed:'./b'});assert.equal(mutations[1].path,'./b');assert.equal(existsSync(path('b')),false);ok(files.write('./b','recreated'))
})
test('FileSession: same-path move keeps observed version',t=>{
  const mutations=[];const {files,path}=fixture(t,{before:v=>mutations.push(v)});writeFileSync(path('a'),'first');ok(files.cat('a'))
  assert.deepEqual(files.mv('a','./a'),{ok:true,moved:'a',destination:'./a'});assert.deepEqual(mutations,[])
  writeFileSync(path('a'),'outside');changed(files.write('a','next'))
})
test('FileSession: hardlink rename no-op keeps paths and versions',t=>{
  const mutations=[];const {files,path}=fixture(t,{before:v=>mutations.push(v)});writeFileSync(path('a'),'first');linkSync(path('a'),path('b'));ok(files.cat('a'));ok(files.cat('b'))
  assert.deepEqual(files.mv('a','b'),{ok:true,moved:'a',destination:'b'});assert.equal(existsSync(path('a')),true);assert.equal(existsSync(path('b')),true)
  assert.equal(lstatSync(path('a'),{bigint:true}).ino,lstatSync(path('b'),{bigint:true}).ino);assert.deepEqual(mutations,[])
  writeFileSync(path('a'),'outside');changed(files.write('a','next'));changed(files.write('b','next'))
})
test('FileSession: replacing a symlink guards committed destination',t=>{
  const {files,path}=fixture(t);writeFileSync(path('a'),'first');symlinkSync('a',path('target'));ok(files.cat('a'));ok(files.mv('a','target'))
  assert.equal(existsSync(path('a')),false);assert.equal(lstatSync(path('target')).isSymbolicLink(),false)
  writeFileSync(path('target'),'outside');changed(files.write('target','next'))
})
test('FileSession: directory move carries observed versions',t=>{
  const {files,path}=fixture(t);mkdirSync(path('from'));writeFileSync(path('from/a'),'first');ok(files.cat('from/a'));ok(files.mv('from','to'))
  writeFileSync(path('to/a'),'outside');changed(files.write('to/a','next'))
})
test('FileSession: absolute paths retain OS authority',t=>{
  const {files,space}=fixture(t);const outside=join(space,'outside-project');writeFileSync(outside,'first')
  assert.equal(ok(files.cat(outside)).text,'first');ok(files.write(outside,'next'));assert.equal(readFileSync(outside,'utf8'),'next')
})
