import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { testTempRoot } from './helpers/temp-root.mjs';
import { WorkspaceTools } from '../src/core/workspace.mjs';

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(testTempRoot,'synora-undo-journal-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(root)).toLowerCase(),path.resolve(testTempRoot).toLowerCase());
    assert.ok(path.basename(root).startsWith('synora-undo-journal-'));await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const tools=new WorkspaceTools(root,{approve:async()=>true});
  return {root,tools,read:name=>fs.readFile(path.join(root,name),'utf8')};
}
const undo=async(tools,changes,options)=>JSON.parse(await tools.undoChanges(changes,options));

test('durable preparation precedes actual write/create/delete and commit hooks see committed disk',async t=>{
  const {root,tools,read}=await fixture(t);await fs.writeFile(path.join(root,'existing.txt'),'after');await fs.writeFile(path.join(root,'created.txt'),'new');
  const calls=[],changes=[{path:'existing.txt',before:'before',after:'after'},{path:'missing.txt',before:'restored',after:null},{path:'created.txt',before:null,after:'new'}];
  const actual=async name=>read(name).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  const result=await undo(tools,changes,{beforeCommit:async change=>{assert.equal(await actual(change.path),change.before);await Promise.resolve();calls.push(['before',change.path]);},
    onCommitted:async change=>{assert.equal(await actual(change.path),change.after);await Promise.resolve();calls.push(['after',change.path]);}});
  assert.equal(result.status,'completed');assert.equal(result.completed.length,3);
  assert.deepEqual(calls,[['before','created.txt'],['after','created.txt'],['before','missing.txt'],['after','missing.txt'],['before','existing.txt'],['after','existing.txt']]);
});

test('preparation failure cannot create even an empty file or change an existing file',async t=>{
  const {root,tools,read}=await fixture(t);await fs.writeFile(path.join(root,'existing.txt'),'after');
  for(const change of [{path:'missing.txt',before:'restored',after:null},{path:'existing.txt',before:'before',after:'after'},{path:'existing.txt',before:null,after:'after'}]){
    const result=await undo(tools,[change],{beforeCommit:async()=>{throw new Error('Journal preparation failed');}});
    assert.equal(result.status,'failed');assert.deepEqual(result.completed,[]);assert.equal(await read('existing.txt'),'after');
    await assert.rejects(read('missing.txt'),{code:'ENOENT'});
  }
});

test('commit persistence failure reports the actual changed file and stops later files',async t=>{
  const {root,tools,read}=await fixture(t);await fs.writeFile(path.join(root,'a.txt'),'a-after');await fs.writeFile(path.join(root,'b.txt'),'b-after');
  const published=[];const result=await undo(tools,[{path:'a.txt',before:'a-before',after:'a-after'},{path:'b.txt',before:'b-before',after:'b-after'}],{
    beforeCommit:async()=>{},onFileChange:change=>published.push(change.path),onCommitted:async()=>{throw new Error('Journal completion failed');}});
  assert.equal(result.status,'partial');assert.deepEqual(result.completed,['b.txt']);assert.deepEqual(result.remaining,['a.txt']);assert.deepEqual(published,['b.txt']);
  assert.equal(await read('b.txt'),'b-before');assert.equal(await read('a.txt'),'a-after');
});

test('files edited while durable preparation waits are preserved for writes and deletes',async t=>{
  const {root,tools,read}=await fixture(t);
  for(const before of ['old',null]){
    await fs.writeFile(path.join(root,'a.txt'),'after');
    const result=await undo(tools,[{path:'a.txt',before,after:'after'}],{beforeCommit:async()=>{await fs.writeFile(path.join(root,'a.txt'),'external edit');}});
    assert.equal(result.status,'failed');assert.deepEqual(result.completed,[]);assert.equal(await read('a.txt'),'external edit');
  }
});

test('redo labels describe restoring the change and actual inverse content is approved',async t=>{
  const {root,tools,read}=await fixture(t);await fs.writeFile(path.join(root,'a.txt'),'original');
  let request;tools.approve=async value=>{request=value;return true;};
  const result=await undo(tools,[{path:'a.txt',before:'edited',after:'original'}],{operationLabel:'恢复'});
  assert.equal(result.status,'completed');assert.match(result.message,/已恢复/);assert.match(request.title,/恢复/);
  assert.equal(request.before,'original');assert.equal(request.after,'edited');assert.equal(await read('a.txt'),'edited');
});
