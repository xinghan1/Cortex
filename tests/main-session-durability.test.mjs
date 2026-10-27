import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {Store}=require('../src/core/store.cjs');
const {SessionCheckpoints,recoverInterruptedSession}=require('../src/core/session-checkpoints.cjs');
const {selectModelContext}=require('../src/core/model-context.cjs');
const source=(await fs.readFile(new URL('../src/main.cjs',import.meta.url),'utf8')).replaceAll('\r\n','\n');
function code(name,next){const begin=source.indexOf(`function ${name}(`),end=source.indexOf(`\n${next}`,begin+1);assert.ok(begin>=0&&end>begin,name);return source.slice(source.slice(begin-6,begin)==='async '?begin-6:begin,end);}
const mainCode=[code('emit','function emitSessionMetrics('),code('recordLiveEvent','function rememberTerminalEvent('),
  code('persistSessionSnapshot','async function rememberSessionSelection('),code('sessionContextCheckpoint','function setWorkspace('),
  code('startTask','async function runPersistedChangeOperation(')].join('\n');
const readCode=code('readSessionForContext','function broadcastAppearance(');
const deferred=()=>{let resolve,reject;const promise=new Promise((pass,fail)=>{resolve=pass;reject=fail;});return{promise,resolve,reject};};
const root=path.resolve('tests/.tmp');
const crypto={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from('fixture:'+value),decryptString:value=>value.toString().slice(8)};
async function fixture(t,{external=false,temporary=false,storageFailure=false}={}){
  await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'main-durable-'));
  t.after(async()=>{assert.equal(path.dirname(path.resolve(dir)).toLowerCase(),root.toLowerCase());assert.ok(path.basename(dir).startsWith('main-durable-'));await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:50});});
  const store=new Store(dir,crypto);await store.init();
  await store.saveSettings({provider:external?'anthropic':'deepseek',authMode:external?'claude-agent':'apiKey',model:'durable-fixture-model',...(external?{}:{apiKey:'LOCAL_TEST_ONLY_KEY'})});
  const session=store.createSession('C:/durability-project');if(temporary)session.temporary=true;
  const starting=[],events=[],ready=deferred(),release=deferred(),models=[],executions=[];
  const account={publicState:async()=>({session:{profileId:'fixture-native-account',sharing:true,status:'connected'}})};
  let context;
  const fakeTurn=async options=>{
    if(!external)await options.requestModel({signal:options.signal});
    const messages=external?options.session.messages:options.messages;
    if(!external)messages.push({role:'assistant',content:'Checking file',toolCalls:[{id:'tool-one',name:'read_file',arguments:{path:'one.txt'}}],
      providerState:{provider:'deepseek',model:'durable-fixture-model',endpoint:'https://api.deepseek.com/chat/completions',message:{role:'assistant',content:'Checking file'}}});
    options.emit({type:'assistant-message',text:'Checking file',toolCallCount:1});
    options.emit({type:'tool-start',name:'read_file',args:{path:'one.txt'},toolCallId:'tool-one'});
    if(!external)await options.workspace.execute('read_file',{path:'one.txt'},{signal:options.signal});
    if(!external)messages.push({role:'tool',toolCallId:'tool-one',content:'Saved result from an executed tool'});
    options.emit({type:'tool-result',name:'read_file',toolCallId:'tool-one',result:'Saved result from an executed tool'});
    options.emit({type:'text-delta',text:'A visible partial answer',replace:true});
    ready.resolve();
    if(storageFailure){await context.activeRun.checkpoints.flush();return;}
    await release.promise;
    messages.push({role:'assistant',content:'A visible partial answer, completed.',toolCalls:[]});
    options.emit({type:'assistant-message',text:'A visible partial answer, completed.',toolCallCount:0});
  };
  const win={isDestroyed:()=>false,isVisible:()=>false,isMinimized:()=>false,webContents:{isDestroyed:()=>false,send:(_channel,event)=>events.push(structuredClone(event))}};
  const host={active:null,publishWorkspaces(){}};
  context=vm.createContext({SessionCheckpoints,recoverInterruptedSession,selectModelContext,createHash,randomUUID,structuredClone,AbortController,DOMException,performance,
    sessionRunOwner:'current-process-owner',sessionRecoveryErrors:new Map(),store,currentSession:session,loadedSnapshot:false,
    initialized:true,lastRememberedSessionId:session.id,workspaceId:'workspace-fixture',win,host,context:null,activeRun:null,
    tools:{root:session.workspace,execute:async()=>{const disk=await store.getSession(session.id);assert.ok(disk.messages.some(value=>value.toolCalls?.[0]?.id==='tool-one'));
      assert.ok(disk.events.some(event=>event.type==='tool-start'&&event.toolCallId==='tool-one'),'tool-start is durable before execution');executions.push('read_file');return 'file';}},
    publicSettings:()=>store.publicSettings(),catalogContext:async()=>({key:'fixture-connection'}),catalogSnapshots:new Map([['fixture-connection',{models:[]}]]),
    capacityFor:()=>({modelCapacity:{capacityTokens:40000}}),capabilitiesFor:()=>({supportsTools:true,contextWindow:40000}),
    isExternalAgentMode:mode=>mode==='claude-agent',isAccountMode:mode=>mode==='claude-agent',accountController:()=>account,resolvedReasoningEffort:()=> 'default',
    promptCompletion:{abort(){}},petDialog:{close(){},stop(){},snapshot:()=>({}),greet(){},ask:async()=>({})},
    requireIdle(){},requireSharedReady(){},requireTools(){},normalizeImageAttachments:()=>[],stopGeneration:0,shuttingDown:false,quitting:false,
    metricsConnectionKey:null,metricsModelCapacity:null,configRevision:1,permissionMode:'request',redact:String,
    makePendingContextUsage:()=>({status:'pending'}),makeRun:kind=>{const ended=deferred();return{id:randomUUID(),kind,controller:new AbortController(),done:ended.promise,finish:ended.resolve,startedAt:Date.now(),startedMonotonic:performance.now()};},
    setTimeout:(callback,delay)=>{if(delay===40)starting.push(callback);return{unref(){}};},clearTimeout(){},
    runAgent:fakeTurn,runExternalAgentTurn:fakeTurn,runDemo:async()=>{},lastPetGreetingAt:0,
    TOOL_DEFINITIONS:[],BROWSER_TOOL_DEFINITIONS:[],PET_QUESTION_TOOL:{name:'ask_user_question'},
    dispatchModelRequest:async()=>{models.push('inference');return{};},currentRequestConfig:async()=>({}),roleRequestConfig:async()=>({}),
    createSubagentWorkspace:()=>({}),takeSteering:async()=>[],officialAgentPermission:async()=>({allowed:true}),officialAgentUserInput:async()=>({}),
    recordRunUsage:async()=>{},recordRunFileChange(){},emitSessionMetrics(){},telemetrySnapshot:()=>({}),rememberTerminalEvent(){},
    liveImageViewSources:()=>[],eventSequence:0,approvals:new Map(),approvalController:{drain:async()=>{}},
    persistentTaskUndo:{copySession:async()=>{},seal:async()=>{}},app:{getVersion:()=> '0.24.1'},
    createTurnUsage:()=>({}),rememberTaskRun:record=>{session.taskRuns=[record];},pendingPrompts:[],pauseQueue(){},emitQueue(){},
    broadcastState:async()=>{},scheduleNextPrompt(){},publicSession:value=>structuredClone(value),
    rememberSessionSelection:async()=>true,
  });
  context.context={};host.active=context.context;
  vm.runInContext(mainCode,context);
  let sessionWrites=0;
  if(storageFailure){const write=store.write.bind(store);store.write=async(relative,data)=>{if(relative.startsWith('sessions')&&++sessionWrites>1)throw Object.assign(new Error('Local test storage full'),{code:'ENOSPC'});return write(relative,data);};}
  const restarted=async()=>{
    const restartDir=path.join(dir,'restarted');const reader=new Store(restartDir,crypto);await reader.init();
    await fs.copyFile(path.join(dir,'sessions',session.id+'.json'),path.join(restartDir,'sessions',session.id+'.json'));
    const scope=vm.createContext({store:reader,recoverInterruptedSession,sessionRunOwner:'restarted-process-owner',sessionRecoveryErrors:new Map(),sessionRenameRevision:0,sessionRenameLocks:new Set(),sessionDeleteLocks:new Set()});
    vm.runInContext(readCode,scope);return{reader,loaded:await scope.readSessionForContext(session.id)};
  };
  return{context,session,store,starting,events,ready,release,models,executions,restarted,dir};
}

test('actual main startup durably saves the user before execution and crash recovery reports stopped',async t=>{
  const f=await fixture(t);const started=await f.context.startTask({text:'Keep this explicit user request'});
  assert.equal(f.starting.length,1);assert.equal(f.models.length,0);assert.equal(f.executions.length,0);
  const disk=await f.store.getSession(f.session.id);assert.equal(disk.messages[0].content,'Keep this explicit user request');assert.equal(disk.runCheckpoint.runId,started.runId);
  const {loaded}=await f.restarted();assert.equal(loaded.messages[0].content,'Keep this explicit user request');
  assert.equal(loaded.taskRuns.at(-1).status,'stopped');assert.equal(loaded.runCheckpoint,undefined);
  f.context.activeRun.checkpoints.dispose();f.context.activeRun.finish();
});

for(const external of [false,true])test(`actual main ${external?'official agent':'API'} checkpoints partial output and completed tool records, then final save wins`,async t=>{
  const f=await fixture(t,{external});await f.context.startTask({text:'Preserve my running conversation'});
  const running=f.starting[0]();await f.ready.promise;await f.context.activeRun.checkpoints.flush();
  const {loaded}=await f.restarted();assert.equal(loaded.messages[0].content,'Preserve my running conversation');
  const partial=loaded.messages.find(message=>message.source==='interrupted-stream');
  assert.equal(partial.localOnly,true);assert.deepEqual(partial.toolCalls,[]);assert.equal(partial.providerState,undefined);
  assert.match(partial.content,/A visible partial answer/);assert.match(partial.content,/未完成/);
  assert.ok(loaded.events.some(event=>event.type==='tool-result'&&event.result==='Saved result from an executed tool'));
  assert.equal(loaded.taskRuns.at(-1).status,'stopped');
  if(!external)assert.ok(loaded.messages.some(message=>message.role==='tool'&&message.content==='Saved result from an executed tool'));
  f.release.resolve();await running;
  const final=await f.store.getSession(f.session.id);assert.equal(final.runCheckpoint,undefined);
  assert.equal(final.messages.at(-1).content,'A visible partial answer, completed.');assert.equal(final.messages.some(message=>message.source==='interrupted-stream'),false);
  assert.equal(final.taskRuns.at(-1).status,'completed');assert.equal(f.context.activeRun,null);
});

test('actual main leaves temporary runs off disk at startup, during streaming and after completion',async t=>{
  const f=await fixture(t,{external:true,temporary:true});await f.context.startTask({text:'Temporary private request'});
  const running=f.starting[0]();await f.ready.promise;await f.context.activeRun.checkpoints.flush();
  await assert.rejects(f.store.getSession(f.session.id),{code:'ENOENT'});f.release.resolve();await running;
  await assert.rejects(f.store.getSession(f.session.id),{code:'ENOENT'});
});

test('actual main surfaces checkpoint storage failure, preserves last JSON and never starts the tool',async t=>{
  const f=await fixture(t,{storageFailure:true});await f.context.startTask({text:'Do not lose the saved request'});
  await f.starting[0]();
  assert.ok(f.events.some(event=>event.type==='storage-error'&&/增量保存失败/u.test(event.error)));
  assert.equal(f.executions.length,0);assert.equal(f.events.findLast(event=>event.type==='run-end').status,'failed');
  const old=await f.store.getSession(f.session.id);assert.equal(old.messages[0].content,'Do not lose the saved request');
  assert.equal(f.context.activeRun,null);
});


test('actual main keeps question answers durably after the activity suffix rolls over without adding user turns',async t=>{
  const f=await fixture(t,{external:true});await f.context.startTask({text:'An existing user turn'});
  const running=f.starting[0]();await f.ready.promise;
  const runId=f.context.activeRun.id;
  f.context.emit({type:'question-answer',questionId:'explicit-question',question:'保留哪些已有文件？',options:['全部','仅当前'],answer:'我选择全部保留',source:'user',runId,sessionId:f.session.id,messageIndex:0});
  for(let index=0;index<170;index++)f.context.emit({type:'agent-plan',entries:[{content:'Plan '+index,status:'pending'}]});
  await f.context.activeRun.checkpoints.flush();
  const disk=await f.store.getSession(f.session.id);
  assert.equal(disk.messages.filter(value=>value.role==='user').length,1);assert.equal(disk.questionAnswers.length,1);
  assert.equal(disk.questionAnswers[0].answer,'我选择全部保留');assert.ok(Number.isSafeInteger(disk.questionAnswers[0].sequence));
  assert.equal(disk.events.some(event=>event.type==='question-answer'),false,'The bounded activity suffix can roll while canonical user answers remain');
  const {loaded}=await f.restarted();assert.equal(loaded.questionAnswers[0].question,'保留哪些已有文件？');
  f.release.resolve();await running;assert.equal((await f.store.getSession(f.session.id)).questionAnswers.length,1);
});
