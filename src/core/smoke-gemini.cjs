// Native Gemini API controls and readonly tool roundtrip with loopback models.
// Account verification receives an isolated CLI fixture from the smoke host.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeGemini({ win, output, dataDir, store, GeminiConnection, installAccountFixture, broadcastState }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const nonce=randomUUID(),project=path.join(dataDir,'gemini-'+nonce),model='gemini-native-fixture',key='isolated-gemini-key-'+nonce;
  const prompt='请读取 README.md 并说明内容。GEMINI_NATIVE_'+nonce,source='GEMINI_READONLY_FIXTURE_'+nonce;
  const records=[],problems=[],screenshots=[];
  let child,original,appearance,baseUrl,stage='initialize',configured=false,restoreAccounts;
  const mockAccounts=[];
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const js=(code,target=child)=>target.webContents.executeJavaScript(code);
  const call=(name,arg,target=child)=>js(`window.forge[${JSON.stringify(name)}](${arg===undefined?'':JSON.stringify(arg)})`,target);
  const state=()=>call('getState');
  const until=async(label,check)=>{const end=Date.now()+20000;while(Date.now()<end){assert.deepEqual(problems,[]);const value=await check();if(value)return value;await wait(30);}throw new Error('Gemini smoke timed out: '+label);};
  const click=async selector=>{
    const point=await until('native target '+selector,()=>js(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n||n.disabled||!n.checkVisibility({visibilityProperty:true}))return null;n.scrollIntoView({block:'nearest',behavior:'instant'});const r=n.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};return n.contains(document.elementFromPoint(p.x,p.y))?p:null})()`));
    child.webContents.focus();for(const type of ['mouseMove','mouseDown','mouseUp'])child.webContents.sendInputEvent({type,...point,...(type==='mouseMove'?{}:{button:'left',clickCount:1})});await wait(65);
  };
  const capture=async filename=>{
    for(let attempt=1;attempt<=4;attempt++)try{child.webContents.invalidate();await wait(attempt*150);const image=await child.webContents.capturePage();assert.equal(image.isEmpty(),false);await fs.writeFile(path.join(output,filename),image.toPNG());screenshots.push(filename);return;}catch(error){if(attempt===4||!/UnknownVizError/.test(String(error)))throw error;}
  };
  const respond=(response,parts,usage)=>{
    response.writeHead(200,{'Content-Type':'text/event-stream'});response.end('data: '+JSON.stringify({candidates:[{index:0,content:{role:'model',parts},finishReason:'STOP'}],usageMetadata:usage})+'\n\n');
  };
  const server=http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://127.0.0.1');assert.equal(url.searchParams.has('key'),false);assert.equal(request.headers['x-goog-api-key'],key);assert.equal(request.headers.authorization,undefined);
      if(request.method==='GET'&&url.pathname==='/v1beta/models'){
        response.writeHead(200,{'Content-Type':'application/json'});response.end(JSON.stringify({models:[
          {name:'models/'+model,displayName:'Gemini 原生验证模型',inputTokenLimit:32768,outputTokenLimit:4096,supportedGenerationMethods:['generateContent']},
          {name:'models/embedding-fixture',displayName:'仅嵌入模型',supportedGenerationMethods:['embedContent']}]}));return;
      }
      assert.equal(request.method,'POST');assert.equal(url.pathname,'/v1beta/models/'+model+':streamGenerateContent');assert.equal(url.searchParams.get('alt'),'sse');
      let raw='';for await(const chunk of request){raw+=chunk;assert.ok(raw.length<1000000);}const body=JSON.parse(raw);assert.ok(Array.isArray(body.contents));assert.equal(Object.hasOwn(body,'messages'),false);assert.equal(Object.hasOwn(body,'input'),false);
      const results=body.contents.flatMap(content=>content.parts||[]).filter(part=>part.functionResponse);
      const record={toolResult:results.length>0,usesNativeTools:!!body.tools?.[0]?.functionDeclarations,body};records.push(record);
      if(!body.tools?.length){respond(response,[{text:JSON.stringify({continuation:'请继续检查。'})}],{promptTokenCount:0,candidatesTokenCount:0});return;}
      assert.ok(body.tools[0].functionDeclarations.some(tool=>tool.name==='read_file'));
      if(!results.length){
        assert.ok(body.contents.some(content=>(content.parts||[]).some(part=>part.text?.includes(prompt))));
        respond(response,[{functionCall:{id:'native-read',name:'read_file',args:{path:'README.md'}},thoughtSignature:'ISOLATED_GEMINI_SIGNATURE'}],{promptTokenCount:200,candidatesTokenCount:10,thoughtsTokenCount:5,cachedContentTokenCount:40});
      }else{
        assert.equal(results.length,1);assert.equal(results[0].functionResponse.name,'read_file');assert.ok(JSON.stringify(results[0]).includes(source));
        assert.ok(body.contents.some(content=>content.role==='model'&&content.parts.some(part=>part.thoughtSignature==='ISOLATED_GEMINI_SIGNATURE'&&part.functionCall?.name==='read_file')),'Native signed call is replayed with its matching result');
        respond(response,[{text:'GEMINI_NATIVE_COMPLETE：已读取本地验证文件。'}],{promptTokenCount:800,candidatesTokenCount:20,thoughtsTokenCount:5,cachedContentTokenCount:100});
      }
    }catch(error){problems.push(error.message);if(!response.destroyed){if(!response.headersSent)response.writeHead(500,{'Content-Type':'application/json'});response.end(JSON.stringify({error:{message:error.message}}));}}
  });
  const openSettings=async role=>{await js(role?`window.aiCodeCommands.execute(${JSON.stringify('role-'+role+'-settings')})`:`openSettings()`);await until('settings dialog',()=>js(`$('settings-dialog').open`));};
  const selectApi=async()=>{
    await js(`(()=>{$('provider-select').value='gemini';$('provider-select').dispatchEvent(new Event('change',{bubbles:true}));$('gemini-auth-mode').value='apiKey';$('gemini-auth-mode').dispatchEvent(new Event('change',{bubbles:true}));$('base-url-input').value=${JSON.stringify(baseUrl)};$('api-key-input').value=${JSON.stringify(key)};for(const id of ['base-url-input','api-key-input'])$(id).dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
    assert.equal(await js(`$('api-protocol-field').hidden`),true);await click('#settings-model-refresh');
    await until('native Gemini catalog',()=>js(`Boolean(settingsCatalog?.models.some(model=>model.id===${JSON.stringify(model)})&&!settingsCatalogLoading)`));
    assert.equal(await js(`Array.from($('chatgpt-model-select').options).find(option=>option.value==='embedding-fixture').disabled`),true);
    await js(`$('chatgpt-model-select').value=${JSON.stringify(model)};$('chatgpt-model-select').dispatchEvent(new Event('change',{bubbles:true}));true`);
  };
  try{
    await fs.mkdir(project,{recursive:true});await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(project,'README.md'),source+'\n');
    original=await call('getState',undefined,win);appearance=await call('getAppearance',undefined,win);assert.equal(original.settings.providers.gemini.hasKey,false,'Only an isolated unconfigured Gemini provider may be used');
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));baseUrl=`http://127.0.0.1:${server.address().port}/v1beta`;
    child=BrowserWindow.fromId((await call('newWindow',undefined,win)).id);assert.ok(child&&child.webContents.isOffscreen());child.setContentSize(1440,1000);child.setOpacity(0);child.showInactive();child.webContents.focus();
    await until('Gemini renderer',()=>js('Boolean(appState&&window.synoraGeminiLogin&&!projectSwitching)'));await js(`openRecentProject({path:${JSON.stringify(project)}})`);
    await until('fixture project',async()=>(await state()).workspace?.root===project&&await js('!projectSwitching'));
    stage='native API catalog and key settings';await openSettings();await selectApi();await capture('gemini-api-catalog.png');await click('#save-settings');configured=true;
    await until('Gemini API saved',async()=>(await state()).settings.provider==='gemini'&&(await state()).settings.model===model&&await js(`!$('settings-dialog').open&&!settingsSaving`));
    assert.equal(Object.hasOwn((await state()).settings,'apiProtocol'),false);
    await js(`$('task-input').value='保留草稿 GEMINI_UNSENT';$('task-input').dispatchEvent(new Event('input',{bubbles:true}));true`);
    stage='actual native stream tool roundtrip and token accounting';await call('runTask',{text:prompt});
    await until('native complete',async()=>!(await state()).activeTask.running&&await js(`$('messages').textContent.includes('GEMINI_NATIVE_COMPLETE')`));
    assert.equal(records.filter(record=>record.usesNativeTools).length,2);assert.equal(await fs.readFile(path.join(project,'README.md'),'utf8'),source+'\n');
    const metrics=(await state()).sessionMetrics;assert.equal(metrics.contextUsedTokens,800,'Gemini input capacity uses the latest reported input');
    assert.equal(await js(`$('task-input').value`),'保留草稿 GEMINI_UNSENT');await capture('gemini-native-complete.png');
    stage='all roles share Gemini API form and account mode is distinct';
    for(const role of ['subagent','approval','completion','sidebar','pet']){
      await openSettings(role);await js(`$('provider-select').value='gemini';$('provider-select').dispatchEvent(new Event('change',{bubbles:true}));true`);
      assert.equal(await js(`$('gemini-auth-mode-field').hidden`),false);assert.equal(await js(`$('api-protocol-field').hidden`),true);
      assert.equal(await js(`$('key-status').textContent`),'未配置');await click('#close-settings');
    }
    await openSettings();await js(`$('gemini-auth-mode').value='gemini-account';$('gemini-auth-mode').dispatchEvent(new Event('change',{bubbles:true}));true`);
    assert.equal(await js(`$('api-key-field').hidden&&$('base-url-field').hidden&&!$('gemini-login-panel').hidden`),true);
    for(const uiStyle of ['glass','black','white','industrial','deepseek','codex']){
      await call('setAppearance',{uiStyle});await until('account material '+uiStyle,()=>js(`document.documentElement.dataset.uiStyle===${JSON.stringify(uiStyle)}`));await capture('gemini-account-'+uiStyle+'.png');
    }
    await click('#close-settings');
    stage='isolated real ACP process and native Google account controls';
    assert.equal(typeof GeminiConnection,'function');assert.equal(typeof installAccountFixture,'function');
    const cliRoot=path.join(dataDir,'fake-acp-'+nonce),cliEntry=path.join(cliRoot,'gemini-fixture.cjs'),cliLog=path.join(cliRoot,'requests.ndjson'),holdFile=path.join(cliRoot,'hold-login');
    await fs.mkdir(cliRoot,{recursive:true});
    await fs.writeFile(cliEntry,String.raw`const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const log=value=>fs.appendFileSync(path.join(__dirname,'requests.ndjson'),JSON.stringify(value)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{let request;try{request=JSON.parse(line);}catch{return;}
const {id,method,params}=request;log({method,home:process.env.GEMINI_CLI_HOME,model:process.argv.includes('--model')?process.argv[process.argv.indexOf('--model')+1]:null});
let result={};
if(method==='initialize')result={protocolVersion:1,agentInfo:{name:'gemini-cli',version:'0.65.0'},authMethods:[{id:'oauth-personal'}]};
else if(method==='authenticate'){if(fs.existsSync(path.join(__dirname,'hold-login')))return;}
else if(method==='session/new')result={sessionId:'isolated-session',models:{availableModels:[{modelId:'gemini-account-fixture',name:'Google账号验证模型'}],currentModelId:'gemini-account-fixture'}};
else if(method==='session/prompt'){
const text=params.prompt[0].text,payload=JSON.parse(text.slice(text.lastIndexOf('\n')+1));
const content=payload.tools.length?'GEMINI_MOCK_MAIN_ACCOUNT_COMPLETE':'GEMINI_MOCK_PET_ACCOUNT_COMPLETE';
send({jsonrpc:'2.0',method:'session/update',params:{sessionId:params.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({content,toolCalls:[]})}}}});
result={stopReason:'end_turn',usage:{inputTokens:40,outputTokens:7,thoughtTokens:3,cachedReadTokens:5}};
}
if(id!==undefined)send({jsonrpc:'2.0',id,result});});
`);
    const buildAccount=async name=>{const value=new GeminiConnection({dataDir:path.join(cliRoot,name),cliEntry,nodeExecutable:process.execPath,requestTimeoutMs:10000,attemptTimeoutMs:10000,onChange:()=>broadcastState()});await value.init();mockAccounts.push(value);return value;};
    const mainAccount=await buildAccount('main'),roleAccounts=Object.fromEntries(await Promise.all(['subagent','approval','completion','sidebar','pet'].map(async role=>[role,await buildAccount(role)])));
    restoreAccounts=await installAccountFixture(mainAccount,roleAccounts);
    const authRecords=async()=>fs.readFile(cliLog,'utf8').then(value=>value.trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)),()=>[]);
    const accountMode=async role=>{await openSettings(role);await js(`$('provider-select').value='gemini';$('provider-select').dispatchEvent(new Event('change',{bubbles:true}));$('gemini-auth-mode').value='gemini-account';$('gemini-auth-mode').dispatchEvent(new Event('change',{bubbles:true}));true`);};
    await accountMode();await fs.writeFile(holdFile,'hold native OAuth fixture\n');await click('#gemini-login-sign-in');
    await until('ACP authenticate is held',async()=>(await authRecords()).some(record=>record.method==='authenticate'));
    assert.equal(await js(`!$('gemini-login-cancel').hidden&&!$('gemini-login-cancel').disabled`),true);await click('#gemini-login-cancel');
    await until('native cancellation unlocks login',async()=>(await state()).gemini.session.status!=='connecting'&&await js(`!window.synoraGeminiLogin.isBusy()`));
    assert.equal((await state()).gemini.session.profileId,null);await fs.unlink(holdFile);
    await click('#gemini-login-sign-in');await until('native Google connected',async()=>(await state()).gemini.session.status==='connected'&&await js(`$('gemini-login-status').textContent==='Google 账号已连接'`));
    const mainProfile=(await state()).gemini.session.profileId;assert.ok(mainProfile);
    await click('#settings-model-refresh');await until('ACP actual available models',()=>js(`settingsCatalog?.authMode==='gemini-account'&&settingsCatalog.models.some(model=>model.id==='gemini-account-fixture')`));
    await js(`$('chatgpt-model-select').value='gemini-account-fixture';$('chatgpt-model-select').dispatchEvent(new Event('change',{bubbles:true}));true`);await click('#save-settings');
    await until('account selection saved',async()=>(await state()).settings.authMode==='gemini-account'&&await js(`!$('settings-dialog').open&&!settingsSaving`));
    const apiRequests=records.length;await call('runTask',{text:'验证Google账号模式的独立文字推理。'});
    await until('actual ACP account inference',async()=>!(await state()).activeTask.running&&await js(`$('messages').textContent.includes('GEMINI_MOCK_MAIN_ACCOUNT_COMPLETE')`));assert.equal(records.length,apiRequests,'Google account inference never calls API-key native HTTP transport');
    stage='independent pet Google account and main account isolation';await accountMode('pet');
    assert.equal((await state()).roleModels.pet.gemini.session.status,'disconnected');await click('#gemini-login-sign-in');
    await until('role Google connected',async()=>(await state()).roleModels.pet.gemini.session.status==='connected'&&await js(`!window.synoraGeminiLogin.isBusy()`));
    const petProfile=(await state()).roleModels.pet.gemini.session.profileId;assert.ok(petProfile&&petProfile!==mainProfile);assert.equal((await state()).gemini.session.profileId,mainProfile);
    await click('#settings-model-refresh');await until('role ACP models',()=>js(`settingsCatalog?.models.some(model=>model.id==='gemini-account-fixture')&&!settingsCatalogLoading`));
    await js(`$('chatgpt-model-select').value='gemini-account-fixture';$('chatgpt-model-select').dispatchEvent(new Event('change',{bubbles:true}));true`);await click('#save-settings');
    await until('role account saved',async()=>(await state()).roleModels.pet.enabled&&await js(`!$('settings-dialog').open&&!settingsSaving`));
    const current=await state();await call('sendPetChat',{workspaceId:current.workspaceId,sessionId:current.sessionId,text:'验证独立Google宠物账号。'});
    await until('role ACP inference',async()=>{const value=await call('getPetDialog');return !value.running&&value.messages.some(message=>message.content==='GEMINI_MOCK_PET_ACCOUNT_COMPLETE');});
    await accountMode('pet');await click('#gemini-login-disconnect');await until('role disconnected alone',async()=>(await state()).roleModels.pet.gemini.session.status==='disconnected'&&await js(`!window.synoraGeminiLogin.isBusy()`));
    assert.equal((await state()).gemini.session.profileId,mainProfile);await click('#close-settings');await call('resetRoleModel',{role:'pet'});
    const rpc=await authRecords(),homes=[...new Set(rpc.map(record=>record.home))];assert.ok(homes.length>=2);assert.ok(rpc.filter(record=>record.method==='session/prompt').length>=2);
    const accountEvidence={mock:true,realGoogleLogin:false,realNodeAcpProcess:true,nativeLoginAndCancel:true,actualAvailableModelsSelected:true,
      accountInferenceBypassesApiKey:true,independentRoleProfileAndHome:true,roleDisconnectKeepsMainAccount:true,model:'gemini-account-fixture',rpcMethods:[...new Set(rpc.map(record=>record.method))]};
    assert.deepEqual(problems,[]);
    const result={status:'completed',realApi:false,realCommands:false,localFixtureOnly:true,nativeGeminiProtocol:true,keyUsesHeaderNotQuery:true,
      nativeCatalogSelectionAndSave:true,embeddingCannotBeSaved:true,readonlyToolExecutedExactlyOnce:true,thoughtSignatureRoundtrip:true,
      correctLatestInputCapacity:true,centralDraftPreserved:true,allFiveRoleForms:true,sixAccountMaterialStyles:true,account:accountEvidence,
      nativeRequests:records.map(({toolResult,usesNativeTools})=>({toolResult,usesNativeTools})),
      usage:store?.usage?.records?.filter(record=>record.provider==='gemini').map(({inputTokens,outputTokens,cachedInputTokens})=>({inputTokens,outputTokens,cachedInputTokens}))||[],screenshots};
    await fs.writeFile(path.join(output,'gemini-smoke-result.json'),JSON.stringify(result,null,2)+'\n');return result;
  }catch(error){
    const failure={status:'failed',stage,error:error.message,stack:error.stack,requests:records.map(({toolResult,usesNativeTools})=>({toolResult,usesNativeTools})),problems};
    if(child&&!child.isDestroyed())try{failure.state=await state();await capture('gemini-failure.png');}catch(diagnostic){failure.diagnosticError=diagnostic.message;}
    await fs.writeFile(path.join(output,'gemini-smoke-result.json'),JSON.stringify(failure,null,2)+'\n');throw new Error('Gemini smoke failed at '+stage+': '+error.message,{cause:error});
  }finally{
    if(child&&!child.isDestroyed())await call('geminiDisconnect').catch(()=>{});
    if(typeof restoreAccounts==='function')await restoreAccounts();
    for(const account of mockAccounts)await account.dispose().catch(()=>{});
    if(child&&!child.isDestroyed()){
      await call('stopTask').catch(()=>{});await until('fixture idle',async()=>!(await state()).activeTask.running).catch(()=>{});
      if(appearance)await call('setAppearance',{uiStyle:appearance.uiStyle}).catch(()=>{});
      if(configured){const previous=original.settings.providers.gemini;await call('saveSettings',{provider:'gemini',model:previous.model,baseUrl:previous.baseUrl,authMode:'apiKey',clearKey:true}).catch(()=>{});}
      child.close();await until('child closes',()=>child.isDestroyed()).catch(()=>child.destroy());
    }
    await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }
};
