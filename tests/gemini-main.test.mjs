import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { SettingsCatalogSelections } from '../src/core/settings-model-catalog.mjs';
import { RoleModelRuntime } from '../src/core/role-model-runtime.mjs';
import { modelCapacityConnectionKey, applyModelCapacity } from '../src/core/model-capacity-preferences.cjs';

const { Store } = createRequire(import.meta.url)('../src/core/store.cjs');
const { selectModelContext } = createRequire(import.meta.url)('../src/core/model-context.cjs');
const source=(await fs.readFile(new URL('../src/main.cjs',import.meta.url),'utf8')).replaceAll('\r\n','\n');
const preload=await fs.readFile(new URL('../src/preload.cjs',import.meta.url),'utf8');
const roles=['subagent','approval','completion','sidebar','pet'];
const helpers=source.slice(source.indexOf('const isExternalAgentMode ='),source.indexOf('\nconst roleAccountIdentities'));
const plain=value=>JSON.parse(JSON.stringify(value));
function fn(name){const start=source.search(new RegExp(`(?:async )?function ${name}\\(`,'u'));assert.ok(start>0,name);const tail=source.slice(start),end=tail.slice(1).search(/\n(?:async )?function /u);return end<0?tail:tail.slice(0,end+1);}
const crypto={isEncryptionAvailable:()=>true,encryptString:value=>Buffer.from(value),decryptString:value=>value.toString()};
function fixture({mode='gemini-account',profile='google-main-a',historyProfile=profile,history=true}={}){
  const store=new Store(path.resolve('tests/.tmp/gemini-main-memory-only'),crypto);let keyReads=0;
  store.settings={provider:'gemini',providers:{gemini:{model:'gemini-fixture',baseUrl:'https://fixture.invalid/v1beta',authMode:mode,
    reasoningEffort:'default',modelsByAuth:{apiKey:'gemini-fixture','gemini-account':'gemini-fixture'},encryptedKey:Buffer.from('GEMINI_MAIN_MEMORY_KEY').toString('base64')}}};
  store.write=async()=>{};const readKey=store.key.bind(store);store.key=provider=>{keyReads++;return readKey(provider);};
  const account={session:{status:'connected',sharing:true,profileId:profile}},calls=[],enabled=new Set(),snapshots=new Map(),sentinel=new Error('owner-state-captured');
  const gemini={publicState:async()=>structuredClone(account),listModels:async()=>{calls.push('account-models');return[{id:'gemini-fixture',compatible:true,supportsTools:true}];},requestModel:async config=>{calls.push({transport:'google-account',config});return'account';},redact:String};
  const c=vm.createContext({Store,safeStorage:crypto,store,createHash,randomUUID,selectModelContext,structuredClone,AbortController,DOMException,path,
    gemini,chatgpt:null,deepseek:null,antigravity:null,kimiAgent:null,glmAgent:null,app:{getVersion:()=> '0.23.0'},permissionMode:'request',configRevision:1,workspaceId:'workspace-a',
    publicSettings:()=>store.publicSettings(),state:async()=>({settings:store.publicSettings()}),catalogSnapshots:snapshots,modelCatalog:{list:async input=>{calls.push({transport:'native-catalog',input});return{models:[{id:'gemini-fixture',compatible:true,supportsTools:true}]};}},
    redact:String,broadcastState:async()=>{},broadcastAllStates:async()=>{},requireIdle(){},requireSharedReady(){},mutateShared:async action=>action(),
    settingsCatalogSelections:new SettingsCatalogSelections(),settingsCatalogPreviews:new Map(),rememberSelection(){},
    resolvedReasoningEffort:()=> 'default',capabilitiesFor:()=>({supportsTools:true,contextWindow:32768}),capacityFor:()=>({modelCapacity:{capacityTokens:32768}}),
    modelCapacityConnectionKey,applyModelCapacity,modelCapacityPreferences:{get:()=>null},
    roleModels:{isEnabled:role=>enabled.has(role)},roleRuntime:{revisions:Object.fromEntries(roles.map(role=>[role,0])),
      config:async role=>({provider:'gemini',authMode:'gemini-account',apiKey:'',model:'gemini-role-'+role,modelRole:role,roleConnectionRevision:0,geminiProfileId:'role-'+role,modelCapabilities:{}}),
      dispatch:async config=>{calls.push({transport:'role',config});return'role';}},
    requestModel:async config=>{calls.push({transport:'native-api',config});return'api';},
    promptCompletion:{abort(){}},petDialog:{close(){}},normalizeImageAttachments:()=>[],requireTools(){},tools:{root:'C:/disposable-project'},
    shuttingDown:false,quitting:false,stopGeneration:0,loadedSnapshot:false,win:{isDestroyed:()=>false},
    currentSession:{id:'old-session',workspace:'C:/disposable-project',messages:history?[{role:'user',content:'PRIMARY_PRIVATE_HISTORY'}]:[],
      chatgptProfileId:null,deepseekProfileId:null,geminiProfileId:historyProfile},
    createSession:async()=>{calls.push('new-session');c.currentSession={id:'fresh-session',workspace:'C:/disposable-project',messages:[]};},
    makePendingContextUsage:()=>({}),makeRun:()=>{throw sentinel;},metricsConnectionKey:null,metricsModelCapacity:null,
  });
  for(const name of ['catalogContext','catalogConnectionKey','modelSettingsDraft','previewModelSettingsCatalog','commitModelSettings','fetchModelCatalog','currentRequestConfig','roleRequestConfig','dispatchModelRequest','startTask'])vm.runInContext(fn(name),c);
  vm.runInContext(helpers,c);
  const run={controller:new AbortController(),geminiProfileId:profile};
  return{c,store,account,gemini,calls,enabled,snapshots,sentinel,run,keyReads:()=>keyReads};
}

test('the real main catalog preview and selection use native Gemini API credentials and reject a grant after switching to a Google profile',async()=>{
  const f=fixture({mode:'apiKey',historyProfile:null});
  const grant=await f.c.previewModelSettingsCatalog({provider:'gemini',authMode:'apiKey'});
  const listing=f.calls.find(call=>call.transport==='native-catalog');assert.equal(listing.input.provider,'gemini');assert.equal(listing.input.apiKey,'GEMINI_MAIN_MEMORY_KEY');
  assert.doesNotMatch(JSON.stringify(grant),/GEMINI_MAIN_MEMORY_KEY|encryptedKey/);
  await f.c.commitModelSettings({provider:'gemini',authMode:'apiKey',model:'gemini-fixture',selectionToken:grant.selectionToken});
  assert.equal(f.store.publicSettings().authMode,'apiKey');
  await assert.rejects(f.c.commitModelSettings({provider:'gemini',authMode:'gemini-account',model:'gemini-fixture',selectionToken:grant.selectionToken}),{code:'SETTINGS_CATALOG_CONNECTION_CHANGED'});
  assert.equal(f.store.publicSettings().authMode,'apiKey');
});

test('Google catalog and request configuration use only the account controller, fixed official endpoint and bound profile',async()=>{
  const f=fixture(),catalog=await f.c.fetchModelCatalog({force:true});assert.equal(catalog.authMode,'gemini-account');
  assert.equal(f.calls.filter(call=>call==='account-models').length,1);assert.equal(f.keyReads(),0);
  f.run.connectionKey=(await f.c.catalogContext()).key;const config=await f.c.currentRequestConfig(f.run);
  assert.equal(config.apiKey,'');assert.equal(config.geminiProfileId,'google-main-a');assert.equal(config.baseUrl,'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(await f.c.dispatchModelRequest(config),'account');assert.equal(f.keyReads(),0);
  assert.equal(f.calls.some(call=>call.transport==='native-api'||call.transport==='native-catalog'),false);
  f.account.session.profileId='google-main-b';await assert.rejects(f.c.currentRequestConfig(f.run),/连接已变更|授权已变更/);
});

test('actual startTask preserves the chat and separates model context for API/account and Google profile changes',async()=>{
  for(const [mode,profile,previous]of[['gemini-account','google-b',null],['apiKey',null,'google-a'],['gemini-account','google-b','google-a']]){
    const f=fixture({mode,profile,historyProfile:previous});await assert.rejects(f.c.startTask({text:'新的明确任务'}),error=>error===f.sentinel);
    assert.equal(f.calls.filter(call=>call==='new-session').length,0);assert.equal(f.c.currentSession.id,'old-session');
    assert.equal(f.c.currentSession.modelContext.startIndex,1);
    assert.equal(f.c.currentSession.geminiProfileId,profile);assert.equal(f.c.currentSession.messages.length,2);assert.equal(f.c.currentSession.messages[1].content,'新的明确任务');
    assert.equal(f.keyReads(),mode==='apiKey'?1:0);
  }
  const same=fixture();await assert.rejects(same.c.startTask({text:'同账号继续'}),error=>error===same.sentinel);
  assert.equal(same.calls.includes('new-session'),false);assert.equal(same.c.currentSession.messages.length,2);
});

test('a missing Google profile or mismatched in-flight account rejects before appending a user message or reading an API key',async()=>{
  const f=fixture({profile:null});await assert.rejects(f.c.startTask({text:'不得启动'}),/Google 账号/);
  assert.equal(f.c.currentSession.messages.length,1);assert.equal(f.calls.includes('new-session'),false);assert.equal(f.keyReads(),0);
  await assert.rejects(f.c.currentRequestConfig(f.run),/授权已变更/);assert.equal(f.keyReads(),0);
  const changed=fixture();changed.run.geminiProfileId='other-login';await assert.rejects(changed.c.currentRequestConfig(changed.run),/授权已变更/);assert.equal(changed.keyReads(),0);
});

function completionOptions(f){
  const start=source.indexOf('const promptCompletion = createPromptCompletionController({'),end=source.indexOf('\nconst sideChat =',start);
  f.c.createPromptCompletionController=value=>value;f.c.localOperation=false;f.c.promptPreflights=0;
  f.c.context={};f.c.host={active:f.c.context};f.c.recordRunUsage=async()=>{};
  vm.runInContext(source.slice(start,end)+'\nglobalThis.options=promptCompletion;',f.c);return f.c.options;
}
function petOptions(f){
  const start=source.indexOf('const petDialog = createPetDialogController({'),end=source.indexOf('\nfunction publicSettings()',start);
  f.c.createPetDialogController=value=>value;f.c.recordRunUsage=async()=>{};f.c.host={active:{},publishWorkspaces(){}};f.c.context=f.c.host.active;
  vm.runInContext(source.slice(start,end)+'\nglobalThis.options=petDialog;',f.c);return f.c.options;
}

test('actual Tab callbacks bind current Google profile, reject an old session and invalidate a result after account change',async()=>{
  const f=fixture(),options=completionOptions(f),signal=new AbortController().signal;
  const snapshot={...options.getSnapshot(),hasConversation:true};assert.equal(snapshot.geminiProfileId,'google-main-a');
  const config=await options.getConfig(snapshot,signal);assert.equal(config.geminiProfileId,'google-main-a');assert.equal(config.apiKey,'');
  await options.validateConfig(config,snapshot,signal);f.account.session.profileId='google-main-b';
  await assert.rejects(options.getConfig(snapshot,signal),/会话模型账号已变化/);await assert.rejects(options.validateConfig(config,snapshot,signal),{name:'AbortError'});
  assert.equal(f.keyReads(),0);
});

test('actual Pet preflight rejects inherited account history while an explicitly configured pet retains only its own profile',async()=>{
  const f=fixture({profile:'google-b',historyProfile:'google-a'}),options=petOptions(f),signal=new AbortController().signal;
  await assert.rejects(options.getConfig({signal}),/会话模型账号已变化/);assert.equal(f.keyReads(),0);
  f.enabled.add('pet');const config=await options.getConfig({signal});assert.equal(config.modelRole,'pet');assert.equal(config.geminiProfileId,'role-pet');
  assert.equal(config.apiKey,'');assert.doesNotMatch(JSON.stringify(config),/PRIMARY_PRIVATE_HISTORY|google-b/);
});

test('main dispatcher and the real role runtime choose each of five Google accounts and reject a changed profile',async()=>{
  const calls=[],states=new Map(roles.map(role=>[role,{session:{status:'connected',sharing:true,profileId:'own-'+role}}]));
  const accounts=new Map(roles.map(role=>[role,{publicState:async()=>states.get(role),requestModel:async()=>{calls.push(role);return role;}}]));
  const runtime=new RoleModelRuntime({configs:{isEnabled:()=>true},accounts:new Map(),geminiAccounts:accounts,catalog:{},deriveCapabilities:()=>({}),requestModel:()=>assert.fail('Google accounts never use API transport')});
  const f=fixture();f.c.roleRuntime=runtime;
  for(const role of roles){
    const config={provider:'gemini',authMode:'gemini-account',modelRole:role,roleConnectionRevision:0,geminiProfileId:'own-'+role};
    assert.equal(await f.c.dispatchModelRequest(config),role);states.get(role).session.profileId='changed-'+role;
    await assert.rejects(f.c.dispatchModelRequest(config),/授权已变化/);
  }
  assert.deepEqual(calls,roles);assert.equal(f.calls.length,0);assert.equal(f.keyReads(),0);
});

test('preload exposes the exact Gemini account bridge names and forwards only the chosen role argument',async()=>{
  let bridge;const calls=[];const electron={contextBridge:{exposeInMainWorld:(_name,value)=>{bridge=value;}},ipcRenderer:{invoke:async(...args)=>{calls.push(args);},on(){},removeListener(){}}};
  vm.runInNewContext(preload,{require:name=>{assert.equal(name,'electron');return electron;}});
  for(const action of ['SignIn','CancelSignIn','Disconnect','RetryStorage']){
    await bridge['gemini'+action]();assert.equal(calls.at(-1)[0],'forge:gemini'+action);
    for(const role of roles){await bridge['roleGemini'+action]({role});assert.deepEqual(plain(calls.at(-1)),['forge:roleGemini'+action,{role}]);}
  }
});
