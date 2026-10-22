import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { legacyTaskUndoRuns } from '../src/core/legacy-task-undo.mjs';

function fixture({ counted = true } = {}) {
  const runId = randomUUID(), id = randomUUID();
  const record = { runId, kind:'agent', status:'completed', messageStartIndex:0, messageIndex:3,
    ...(counted ? { fileChangeCount:1 } : {}) };
  return { id, workspace:'E:\\fixture', taskRuns:[record], events:[], fileEdits:[{runId,toolCallId:'write-1',path:'a.txt',before:'old\n',after:'new\n'}],
    messages:[{role:'user',content:'Edit a'}, {role:'assistant',content:'',toolCalls:[{id:'write-1',name:'write_file',arguments:'{}'}]},
      {role:'tool',toolCallId:'write-1',content:JSON.stringify({path:'a.txt',bytes:4,message:'文件已保存。'})}, {role:'assistant',content:'Done'}] };
}

test('complete counted old runs import exact snapshots without changing the saved session', () => {
  const session = fixture(), saved = structuredClone(session), runs = legacyTaskUndoRuns(session);
  assert.deepEqual(runs,[{runId:session.taskRuns[0].runId,changes:[{path:'a.txt',before:'old\n',after:'new\n'}],undonePaths:[]}]);
  assert.deepEqual(session,saved);
});

test('older counter-free histories require complete successful file-tool provenance, excluding refusals', () => {
  const session = fixture({counted:false});
  assert.equal(legacyTaskUndoRuns(session).length,1);
  session.messages[1].toolCalls.push({id:'denied',name:'write_file',arguments:'{}'});
  session.messages.splice(3,0,{role:'tool',toolCallId:'denied',content:JSON.stringify({denied:true,message:'拒绝'})});
  session.taskRuns[0].messageIndex++;
  assert.equal(legacyTaskUndoRuns(session).length,1);
  session.messages[3].content=JSON.stringify({path:'missing.txt',bytes:2});
  assert.deepEqual(legacyTaskUndoRuns(session),[]);
});

test('truncated, conflicting, redacted or protected snapshots cannot turn into original source', () => {
  for(const mutate of [
    session=>session.taskRuns[0].fileChangeCount++,
    session=>{session.fileEdits[0].before='[已隐藏密钥]';},
    session=>{session.fileEdits[0].after='[已隐藏 ChatGPT 凭据]';},
    session=>{session.fileEdits[0].path='../outside.txt';},
    session=>{session.fileEdits[0].path='.env';},
    session=>{delete session.fileEdits[0].before;},
    session=>{session.fileEdits.push({...session.fileEdits[0],after:'conflicting replay'});},
    session=>{session.fileEdits[0].before='a'.repeat(512*1024+1);},
  ]) { const session=fixture();mutate(session);assert.deepEqual(legacyTaskUndoRuns(session),[]); }
});

test('continuity and exact commit count are required for repeated edits of one file', () => {
  const session=fixture();session.taskRuns[0].fileChangeCount=2;
  session.fileEdits.push({...session.fileEdits[0],toolCallId:'write-2',before:'new\n',after:'final\n'});
  assert.equal(legacyTaskUndoRuns(session)[0].changes.length,2);
  session.fileEdits[1].before='user intervened';assert.deepEqual(legacyTaskUndoRuns(session),[]);
});

test('counter-free histories with missing results, overlapping users or unmeasured child writes stay unavailable', () => {
  for(const mutate of [
    session=>{session.messages[2].content='unknown result';},
    session=>{session.messages[2].role='user';},
    session=>{session.subagents=[{parentRunId:session.taskRuns[0].runId}];},
    session=>{session.messages[1].toolCalls.push({id:'spawn',name:'spawn_agent'});},
  ]) { const session=fixture({counted:false});mutate(session);assert.deepEqual(legacyTaskUndoRuns(session),[]); }
});

test('legacy completed undo is imported as redoable only with matching inverse committed snapshots', () => {
  const session=fixture(), target=session.taskRuns[0].runId, undoRun=randomUUID();
  session.events.push({type:'tool-start',runId:undoRun,name:'undo_run_changes',args:{runId:target}},
    {type:'tool-result',runId:undoRun,name:'undo_run_changes',result:JSON.stringify({status:'completed',completed:['a.txt']})});
  session.fileEdits.push({runId:undoRun,toolCallId:'undo-1',path:'a.txt',before:'new\n',after:'old\n'});
  assert.deepEqual(legacyTaskUndoRuns(session)[0].undonePaths,['a.txt']);
  session.fileEdits[1].after='not the original';assert.deepEqual(legacyTaskUndoRuns(session)[0].undonePaths,[]);
  session.fileEdits.pop();assert.deepEqual(legacyTaskUndoRuns(session)[0].undonePaths,[]);
});

test('temporary, demo, malformed and net-zero archives cannot create persistent undo entries', () => {
  assert.deepEqual(legacyTaskUndoRuns(null),[]);
  for(const mutate of [session=>{session.temporary=true;},session=>{session.demo=true;},session=>{session.id='../bad';},
    session=>{session.fileEdits[0].after=session.fileEdits[0].before;}]){
    const session=fixture();mutate(session);assert.deepEqual(legacyTaskUndoRuns(session),[]);
  }
  const session=fixture({counted:false});session.subagents={};assert.equal(legacyTaskUndoRuns(session).length,1);
});
