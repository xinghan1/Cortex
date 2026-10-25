// Native host/UI integration with real controllers and disposable Node agents.
// This fixture never downloads an agent, opens real OAuth, or calls a model API.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { BrowserWindow } = require('electron');

module.exports = async function smokeOfficialAgents({ win, output, dataDir, store, AntigravityAgent, KimiAgent, ZCodeAgent,
  installOfficialAgentFixtures, broadcastState }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const nonce = randomUUID(), project = path.join(dataDir, 'official-agent-project-' + nonce), fixtureDir = path.join(dataDir, 'official-agent-fixtures-' + nonce);
  const script = path.join(fixtureDir, 'agent.cjs'), logFile = path.join(fixtureDir, 'requests.ndjson');
  const screenshots = [], events = [], processes = [], controllers = [], problems = [], apiRequests = [], browserCalls = [];
  const glmLoginUrls = Object.freeze({
    bigmodel:'https://bigmodel.cn/login?appId=zcode-native&redirect=https%3A%2F%2Fbigmodel.cn%2Fzcode%2Fcallback%3Fsource%3Dnative%26flow%3Dfixture&state=native-state%2Bexact&nonce=native-nonce',
    zai:'https://chat.z.ai/api/oauth/authorize?appId=zcode-native&redirect=https%3A%2F%2Fchat.z.ai%2Fzcode%2Fcallback%3Fsource%3Dnative%26flow%3Dfixture&state=native-state%2Bexact&nonce=native-nonce',
  });
  let child, restore, original, appearance, petState, baseUrl, stage = 'initialize';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = async (code, target = child) => {
    let timer; try { return await Promise.race([target.webContents.executeJavaScript(code),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Official-agent renderer operation timed out')),30000);})]); }
    finally { clearTimeout(timer); }
  };
  const call = (name, arg, target = child) => js(`window.forge[${JSON.stringify(name)}](${arg === undefined ? '' : JSON.stringify(arg)})`, target);
  const state = () => call('getState');
  const until = async (label, read, timeout = 25000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { assert.deepEqual(problems, []); const value = await read(); if (value) return value; await wait(35); }
    throw new Error('Official-agent smoke timed out: ' + label);
  };
  const click = async selector => {
    const point = await until('native target ' + selector, () => js(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});if(!node||node.disabled||!node.checkVisibility({visibilityProperty:true}))return null;node.scrollIntoView({block:'nearest',behavior:'instant'});const r=node.getBoundingClientRect(),p={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};return node.contains(document.elementFromPoint(p.x,p.y))?p:null})()`));
    child.webContents.focus(); for (const type of ['mouseMove','mouseDown','mouseUp']) child.webContents.sendInputEvent({ type, ...point, ...(type === 'mouseMove' ? {} : { button:'left',clickCount:1 }) }); await wait(70);
  };
  const capture = async filename => {
    for (let attempt = 1; attempt <= 4; attempt++) try {
      await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await new Promise(resolve=>{let timer;const done=()=>{clearTimeout(timer);child.webContents.removeListener('paint',done);resolve();};child.webContents.once('paint',done);timer=setTimeout(done,700);child.webContents.invalidate();});
      await wait(attempt * 120); const image = await child.webContents.capturePage(); assert.equal(image.isEmpty(), false);
      await fs.writeFile(path.join(output, filename), image.toPNG()); screenshots.push(filename); return;
    } catch (error) { if (attempt === 4 || !/UnknownVizError/u.test(String(error))) throw error; }
  };
  const log = () => fs.readFile(logFile, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)), () => []);
  const server = http.createServer(async (request, response) => {
    apiRequests.push({ method: request.method, path: request.url });
    if (request.method === 'GET') { response.writeHead(200, {'Content-Type':'application/json'}); response.end(JSON.stringify({object:'list',data:[{id:'api-backup',supports_tools:true}]})); return; }
    problems.push('Full official agent unexpectedly called the API Key HTTP transport'); response.writeHead(500, {'Content-Type':'application/json'}); response.end(JSON.stringify({error:{message:'API inference disabled in official-agent fixture'}}));
  });
  const descriptors = [
    { provider:'gemini',authMode:'antigravity-agent',key:'antigravity',prefix:'antigravity',mode:'gemini-auth-mode',version:'1.4.3',Constructor:AntigravityAgent },
    { provider:'kimi',authMode:'kimi-agent',key:'kimiAgent',prefix:'kimi-agent',mode:'kimi-auth-mode',version:'2.3.1',Constructor:KimiAgent,region:'mainland-cn',secondRegion:'global' },
    { provider:'glm',authMode:'glm-agent',key:'glmAgent',prefix:'glm-agent',mode:'glm-auth-mode',version:'0.17.0',Constructor:ZCodeAgent,region:'bigmodel',secondRegion:'zai' },
  ];
  const fakeRuntime = descriptor => {
    const value = {status:'missing',version:descriptor.version,download:null,error:null};
    return { init:async()=>{}, publicState:async()=>structuredClone(value), async ensure({signal} = {}) {
      signal?.throwIfAborted();
      if (value.status !== 'ready') { Object.assign(value,{status:'downloading',download:{receivedBytes:512,totalBytes:1024}}); await broadcastState(); await wait(20); signal?.throwIfAborted(); Object.assign(value,{status:'ready',download:null,error:null}); await broadcastState(); }
      return {entry:path.join(fixtureDir,descriptor.key + '-official.exe'),args:[],version:descriptor.version};
    }, cancel(){},async dispose(){} };
  };
  const killTree = async childProcess => {
    if (!childProcess || childProcess.exitCode !== null || childProcess.signalCode) return;
    let timer; const closed = new Promise(resolve => childProcess.once('close',resolve));
    childProcess.kill('SIGKILL');
    await Promise.race([closed,new Promise(resolve => {timer=setTimeout(resolve,2000);})]); clearTimeout(timer);
  };
  const openSettings = async role => { await js(role ? `window.aiCodeCommands.execute(${JSON.stringify('role-' + role + '-settings')})` : 'openSettings()'); await until('settings dialog', () => js(`$('settings-dialog').open`)); };
  const selectMode = async descriptor => {
    await openSettings(); await js(`(()=>{$('provider-select').value=${JSON.stringify(descriptor.provider)};$('provider-select').dispatchEvent(new Event('change',{bubbles:true}));$(${JSON.stringify(descriptor.mode)}).value=${JSON.stringify(descriptor.authMode)};$(${JSON.stringify(descriptor.mode)}).dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    assert.equal(await js(`$('api-key-field').hidden&&$('base-url-field').hidden`),true);
  };
  const selectCatalog = async (descriptor, screenshot) => {
    await click('#settings-model-refresh');
    await until('actual agent models ' + descriptor.provider, () => js(`Boolean(settingsCatalog?.models.length&&!settingsCatalogLoading)`));
    const model = await js(`(()=>{const row=settingsCatalog.models.find(model=>model.compatible!==false);if(!row)throw new Error('No compatible official agent model');$('chatgpt-model-select').value=row.id;$('chatgpt-model-select').dispatchEvent(new Event('change',{bubbles:true}));return row.id})()`);
    if(screenshot)await capture(screenshot);
    await click('#save-settings'); await until('agent model saved', async () => (await state()).settings.authMode === descriptor.authMode && (await state()).settings.model === model && await js(`!$('settings-dialog').open&&!settingsSaving`)); return model;
  };
  const run = async (descriptor, marker, answer = 'allow') => {
    const previousEnds=await js(`window.__officialSmoke.events.filter(event=>event.type==='run-end').length`);
    const start = await call('runTask',{text:'OFFICIAL_NATIVE_' + marker + '_' + descriptor.provider + '_' + nonce});
    if (marker === 'STOP') {
      await until('held official task', async () => (await log()).some(record => record.kind === descriptor.provider && record.marker === 'STOP'));
      await click('#stop-button');
    } else if(marker==='QUESTION') {
      await until('Kimi native choice-only question',async()=>{const question=(await call('getPetDialog')).question;return question?.question==='官方Kimi选择本次测试方式'&&question.blocking&&question.choiceOnly===true;});
      assert.equal((await state()).pendingApprovals.length,0,'Fixed questions must not become ordinary approval requests');
      await wait(250); assert.equal((await state()).activeTask.running,true,'Full mode must wait for a real choice');
      assert.equal((await log()).some(record=>record.kind==='kimi'&&record.id===99&&record.response),false,'Full mode must not automatically select the first option');
      assert.equal(await js(`$('pet-dialog-input-bubble').hidden&&$('pet-dialog-input').disabled&&$('pet-dialog-send').hidden&&$('pet-dialog-send').disabled&&$('pet-dialog-options').children.length===2&&!$('pet-dialog-cancel').hidden`),true);
      await capture('official-agent-kimi-choice-only-full.png'); await click('#pet-dialog-options .pet-dialog-choice:nth-child(2)');
    } else {
      await until('official permission', async () => (await state()).pendingApprovals.length > 0);
      await click(answer === 'deny' ? '#composer-approval .approval-reject:not(:disabled)' : '#composer-approval .approval-accept:not(:disabled)');
      if (descriptor.provider==='glm' && answer!=='deny') {
        await until('ZCode native question',async()=>(await call('getPetDialog')).question?.question==='官方代理选择本次测试方式');
        await click('#pet-dialog-options .pet-dialog-choice:nth-child(2)');
      }
    }
    await until('official task terminal', async () => !(await state()).activeTask.running && (await state()).pendingApprovals.length === 0 && await js(`window.__officialSmoke.events.filter(event=>event.type==='run-end').length>${previousEnds}`));
    const expected = marker === 'STOP' ? 'stopped' : 'completed';
    const ended = await js(`window.__officialSmoke.events.filter(event=>event.type==='run-end').at(-1)`); assert.equal(ended.status,expected,ended.error || marker);
    if (marker !== 'STOP') assert.ok(await js(`$('messages').textContent.includes(${JSON.stringify('OFFICIAL_' + (answer === 'deny' ? 'DENIED' : 'COMPLETE') + '_' + descriptor.provider)})`));
    assert.equal(await fs.readFile(path.join(project,'README.md'),'utf8'),'OFFICIAL_FIXTURE_READONLY\n');
    return { marker, status:ended.status, runId:ended.runId || start?.runId };
  };
  try {
    await fs.mkdir(output,{recursive:true}); await fs.mkdir(fixtureDir,{recursive:true}); await fs.mkdir(project,{recursive:true}); await fs.writeFile(path.join(project,'README.md'),'OFFICIAL_FIXTURE_READONLY\n');
    await fs.writeFile(path.join(fixtureDir,'glm-login-urls.json'),JSON.stringify(glmLoginUrls));
    original = await call('getState',undefined,win); appearance = await call('getAppearance',undefined,win); petState = await call('petState',undefined,win);
    for (const descriptor of descriptors) { assert.equal(typeof descriptor.Constructor,'function'); assert.equal(original.settings.providers[descriptor.provider]?.hasKey,false,'Only a fresh disposable provider may be configured'); }
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    await fs.writeFile(script,String.raw`const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const kind=process.argv[2],args=process.argv.slice(3),logFile=path.join(__dirname,'requests.ndjson');
const home=process.env.KIMI_CODE_HOME||process.env.ZCODE_DATA_BASE_DIR||process.env.GEMINI_HOME||__dirname;
fs.mkdirSync(home,{recursive:true});const regionFile=path.join(home,'.native-fixture-region');
const log=value=>fs.appendFileSync(logFile,JSON.stringify({kind,...value})+'\n');
const send=value=>process.stdout.write(JSON.stringify(kind==='glm'?value:{jsonrpc:'2.0',...value})+'\n');
const reply=(request,result)=>send({id:request.id,result});
const region=()=>{try{return fs.readFileSync(regionFile,'utf8')}catch{return kind==='glm'?'bigmodel':'mainland-cn'}};
log({event:'spawn',args});
if(kind==='kimi'&&args.includes('--login')){const selected=args[args.indexOf('--region')+1];fs.writeFileSync(regionFile,selected);process.stderr.write('Opening browser for Kimi device login: https://auth.kimi.com/device?user_code=ABCD-1234\nIf the browser did not open, paste the URL above and enter code: ABCD-1234\n');setTimeout(()=>process.exit(0),40);return;}
if(kind==='glm'&&args.includes('login')){const selected=args[args.indexOf('login')+1];if(!args.includes('--no-browser'))throw new Error('The controlled browser bridge must use the official no-browser mode');const url=JSON.parse(fs.readFileSync(path.join(__dirname,'glm-login-urls.json'),'utf8'))[selected];process.stderr.write('Open this URL to sign in:\n'+url+'\n');fs.writeFileSync(regionFile,selected);process.stdout.write(JSON.stringify({status:'ready',provider:selected,user:{user_id:'native-fixture-user'},model:selected+'/glm-official-fixture'})+'\n');setTimeout(()=>process.exit(0),25);return;}
let sessionNumber=0,pending=null,sequence=0;const sessions=new Map();
const model=()=>kind==='gemini'?'gemini-official-fixture':kind==='kimi'?'kimi-'+region()+'-fixture':'glm-official-fixture';
const modelConfig=()=>[{id:'model',name:'Model',type:'select',currentValue:model(),options:[{group:'official',name:'Official',options:[{value:model(),name:kind+' native fixture'}]}]}];
const emptyCatalog=()=>fs.existsSync(path.join(__dirname,'empty-catalog-'+kind+'.flag'));
const update=(sessionId,value)=>send({method:'session/update',params:{sessionId,update:value}});
const zEvent=(sessionId,type,payload)=>send({method:'session/event',params:{sessionId,turnId:'turn-'+sessionNumber,seq:++sequence,eventId:'event-'+sequence,type,payload}});
function finish(allowed){const request=pending;if(!request)return;pending=null;const sessionId=request.params.sessionId;
const text='OFFICIAL_'+(allowed?'COMPLETE':'DENIED')+'_'+kind;
if(kind==='glm'){zEvent(sessionId,'tool.updated',{toolCallId:'tool-native',toolName:'Bash',kind:allowed?'result':'error',result:allowed?'line 1\nline 2\n':'denied'});zEvent(sessionId,'part.delta',{messageId:'assistant-native',partId:'part-native',field:'text',delta:text});zEvent(sessionId,'turn.completed',{inputId:request.params.inputId,resultType:'success',response:text,usage:{inputTokens:101,outputTokens:23}});}
else{for(let i=0;i<2;i++)update(sessionId,{sessionUpdate:'tool_call_update',toolCallId:'tool-native',status:allowed?'completed':'failed',content:[{type:'content',content:{type:'text',text:allowed?'line 1\nline 2\n':'denied'}}]});update(sessionId,{sessionUpdate:'agent_message_chunk',content:{type:'text',text}});reply(request,{stopReason:'end_turn',usage:{inputTokens:101,outputTokens:23}});}}
readline.createInterface({input:process.stdin}).on('line',line=>{let request;try{request=JSON.parse(line)}catch{return}const {id,method,params={}}=request;log({method,id,...(request.result?{response:request.result}:{}),...(request.error?{error:request.error.code}:{})});
if(!method){if(pending){if(kind==='glm'&&id===99){if(request.result?.action!=='accept'||request.result?.content?.answers?.['官方代理选择本次测试方式']!=='keep-files')throw new Error('Native question did not preserve the selected value');finish(true);return;}if(kind==='kimi'&&id===99){if(request.result?.outcome?.optionId!=='q0_opt_1')throw new Error('Native fixed choice must come from the user');finish(true);return;}const allowed=kind==='glm'?request.result?.decision==='allow':request.result?.outcome?.optionId==='allow-once-native';if(kind==='glm'&&allowed){send({id:99,method:'interaction/requestUserInput',params:{requestId:'native-question',sessionId:pending.params.sessionId,turnId:'turn-'+sessionNumber,questions:[{question:'官方代理选择本次测试方式',options:[{label:'仅检查',value:'inspect-only'},{label:'保留文件',value:'keep-files'}]}]}});return;}finish(allowed)}return;}
if(method==='initialize'){reply(request,{protocolVersion:1,agentInfo:{name:kind==='kimi'?'Kimi Code CLI':'antigravity-acp',version:kind==='kimi'?'2.3.1':'1.4.3'},authMethods:[{id:kind==='kimi'?'login':'oauth-personal',type:kind==='kimi'?'terminal':'agent'}],agentCapabilities:{loadSession:true,promptCapabilities:{image:true,audio:true}}});return;}
if(kind==='gemini'&&method==='session/set_config_option'){if(params.configId!=='model'||params.value!==model())throw new Error('Native model selection must use its returned model config ID and value');log({event:'config-selection',configId:params.configId,value:params.value});reply(request,{});return;}
if(method==='authenticate'||method==='logout'||method.startsWith('session/set_')){reply(request,{});return;}
if(method==='runtime/capabilities'){reply(request,{independentPlanState:true,historyFirst:true});return;}
if(method==='session/new'||method==='session/resume'||method==='session/load'){const sessionId=params.sessionId||'session-'+kind+'-'+ ++sessionNumber;sessions.set(sessionId,{});const empty=kind==='gemini'&&emptyCatalog(),late=kind==='gemini'&&sessionNumber===1&&!empty;reply(request,{sessionId,models:{availableModels:kind==='gemini'?[]:[{modelId:model(),name:kind+' native fixture'}],currentModelId:model()},configOptions:kind==='gemini'?(empty||late?[]:modelConfig()):[{id:'model',category:'model',type:'select',currentValue:model(),options:[{value:model(),name:kind+' native fixture'}]}],modes:{availableModes:[{id:'agent',name:'Agent'},{id:'default',name:'Default'},{id:'guarded',name:'Guarded'}],currentModeId:'agent'}});if(late)setTimeout(()=>{log({event:'late-model-config',sessionId});update(sessionId,{sessionUpdate:'config_option_update',configOptions:modelConfig()});},30);return;}
if(method==='session/create'||method==='create'){const sessionId='session-glm-'+ ++sessionNumber;sessions.set(sessionId,{});reply(request,{protocol:{name:'ZCode Protocol',version:1},session:{sessionId,workspace:params.workspace,mode:'guarded'},settings:{model:{available:emptyCatalog()?[]:[{ref:{providerId:region(),modelId:model()},label:'ZCode native fixture',properties:{inputFormat:['text'],outputFormat:['text']}}]}}});return;}
if(method==='session/subscribe'||method==='subscribe'){reply(request,{sessionId:params.sessionId,eventSeq:0,events:[]});return;}
if(method==='session/prompt'||method==='session/send'||method==='send'){const subscriptionFile=path.join(__dirname,'kimi-subscription-error.once');if(kind==='kimi'&&fs.existsSync(subscriptionFile)){fs.unlinkSync(subscriptionFile);log({marker:'SUBSCRIPTION_DENIED'});send({id,error:{code:-32000,message:'Authentication required: 403 Your current subscription does not have access to Kimi Code right now. Upgrade your plan to keep coding with Kimi Code: https://example.invalid/?secret=PRIVATE_TOKEN',data:null}});return;}pending=request;const sessionId=params.sessionId,body=JSON.stringify(params),marker=body.includes('OFFICIAL_NATIVE_STOP_')?'STOP':body.includes('OFFICIAL_NATIVE_QUESTION_')?'QUESTION':body.includes('OFFICIAL_NATIVE_DENY_')?'DENY':'ALLOW';log({marker});
if(kind==='glm'){reply(request,{accepted:true,sessionId,stateRevision:1});zEvent(sessionId,'turn.started',{inputId:params.inputId,turnNumber:1,input:params.content});zEvent(sessionId,'tool.updated',{toolCallId:'tool-native',toolName:'Bash',input:{command:'mock-only-no-execution'},kind:'scheduled'});for(const stdoutTail of ['line 1\n','line 1\nline 2\n'])zEvent(sessionId,'tool.updated',{toolCallId:'tool-native',toolName:'Bash',stdoutTail,kind:'progress'});}
else{update('foreign-session',{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'WRONG_SESSION_SHOULD_NOT_APPEAR'}});update(sessionId,{sessionUpdate:'tool_call',toolCallId:'tool-native',title:'模拟官方代理操作',kind:'execute',status:'in_progress',rawInput:{command:'mock-only-no-execution'},content:[{type:'content',content:{type:'text',text:'line 1\n'}}]});}
if(marker==='STOP')return;
if(kind==='kimi'&&marker==='QUESTION'){send({id:99,method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:'1:ask-user',title:'AskUserQuestion',content:[{type:'content',content:{type:'text',text:'官方Kimi选择本次测试方式'}}]},options:[{optionId:'q0_opt_0',kind:'allow_once',name:'仅检查'},{optionId:'q0_opt_1',kind:'allow_once',name:'保留文件'},{optionId:'q0_skip',kind:'reject_once',name:'Skip'}]}});return;}
if(kind==='glm')send({id:1,method:'interaction/requestPermission',params:{requestId:'native-permission',sessionId,turnId:'turn-'+sessionNumber,toolCallId:'tool-native',toolName:'Bash',reason:'模拟官方代理操作',riskLevel:'medium',input:{command:'mock-only-no-execution'},options:[{optionId:'allow-once-native',kind:'allow_once',name:'允许一次',response:{decision:'allow',reason:'Approved once'}},{optionId:'deny-native',kind:'deny',name:'拒绝',response:{decision:'deny'}}]}});
else send({id:1,method:'session/request_permission',params:{sessionId,toolCall:{toolCallId:'tool-native',title:'模拟官方代理操作',kind:'execute',rawInput:{command:'mock-only-no-execution'}},options:[{optionId:'allow-once-native',kind:'allow_once',name:'允许一次'},{optionId:'deny-native',kind:'reject_once',name:'拒绝'}]}});return;}
if(method==='session/cancel'||method==='session/stop'){if(id!==undefined)reply(request,{});if(pending){const previous=pending;pending=null;if(kind==='glm')zEvent(params.sessionId,'turn.completed',{inputId:previous.params.inputId,resultType:'cancelled',response:''});else reply(previous,{stopReason:'cancelled'});}return;}
if(id!==undefined)reply(request,{});
});
`);
    const installed = {};
    for (const descriptor of descriptors) {
      const runtime = fakeRuntime(descriptor), agent = new descriptor.Constructor({dataDir:path.join(fixtureDir,descriptor.key),runtime,
        spawnImpl:(_entry,args,options)=>{const process=spawn(global.process.execPath,[script,descriptor.provider,...args],{...options,env:{...options.env,ELECTRON_RUN_AS_NODE:'1'}});processes.push(process);return process;},
        ...(descriptor.provider==='glm'?{openExternal:async url=>{assert.ok(Object.values(glmLoginUrls).includes(url),'Browser callback must preserve the complete original authorization URL');const parsed=new URL(url);assert.equal(parsed.searchParams.get('appId'),'zcode-native');assert.equal(parsed.searchParams.get('state'),'native-state+exact');assert.equal(parsed.searchParams.get('nonce'),'native-nonce');assert.ok(parsed.searchParams.get('redirect').endsWith('?source=native&flow=fixture'));browserCalls.push(url);}}:{}),
        killTreeImpl:killTree,onChange:()=>broadcastState(),requestTimeoutMs:15000,startTimeoutMs:10000,stopGraceMs:100});
      await agent.init(); controllers.push(agent); installed[descriptor.key]=agent;
      installed[descriptor.provider==='gemini'?'antigravityRuntime':descriptor.provider==='kimi'?'kimiRuntime':'glmRuntime']=runtime;
    }
    restore = await installOfficialAgentFixtures(installed);
    child = BrowserWindow.fromId((await call('newWindow',undefined,win)).id); assert.ok(child?.webContents.isOffscreen()); child.setContentSize(1440,1000); child.setOpacity(0); child.showInactive();
    await until('official-agent renderer',()=>js('Boolean(appState&&window.synoraAntigravityLogin&&window.synoraKimiAgentLogin&&window.synoraGlmAgentLogin&&!projectSwitching)'));
    await js(`window.__officialSmoke={events:[]};window.__officialSmoke.off=window.forge.onEvent(event=>window.__officialSmoke.events.push(event));openRecentProject({path:${JSON.stringify(project)}})`);
    await until('fixture project',async()=>(await state()).workspace?.root===project&&await js('!projectSwitching'));
    await call('setPet',{enabled:false}); await call('setPermissionMode',{mode:'request'});
    for (const descriptor of descriptors) await call('saveSettings',{provider:descriptor.provider,authMode:'apiKey',model:'api-backup',baseUrl,apiKey:'native-isolated-'+descriptor.provider+'-'+nonce});
    const records=[];
    for (const descriptor of descriptors) {
      stage='install/login/catalog '+descriptor.provider; await selectMode(descriptor);
      await click('#'+descriptor.prefix+'-install'); await until('fake runtime installed',async()=>(await state())[descriptor.key].runtime.status==='ready'&&await js('!isChatGPTBusy()'));
      assert.equal((await state())[descriptor.key].session.status,'disconnected','Install must never imply account authorization');
      await click('#'+descriptor.prefix+'-sign-in'); await until('mock official login',async()=>(await state())[descriptor.key].session.status==='connected'&&await js('!isChatGPTBusy()'));
      const profile=(await state())[descriptor.key].session.profileId; assert.ok(profile); const model=await selectCatalog(descriptor,'official-agent-'+descriptor.provider+'-connected.png');
      const providerSettings=(await state()).settings.providers[descriptor.provider];
      assert.equal(providerSettings.hasKey,true,'Account mode preserves its saved API key');
      assert.equal(providerSettings.baseUrl,baseUrl,'Account mode preserves its separate API address');
      assert.equal(providerSettings.modelsByAuth.apiKey,'api-backup','Account mode preserves the API model selection');
      await until('official agent reasoning ownership',()=>js(`$('composer-reasoning-label').textContent==='官方代理'&&$('reasoning-effort').disabled&&$('reasoning-effort').title==='推理与工具由官方代理管理'`));
      stage='native full agent allow '+descriptor.provider; const allowed=await run(descriptor,'ALLOW'); records.push({provider:descriptor.provider,profile,model,...allowed});
      assert.ok(await js(`window.__officialSmoke.events.filter(event=>event.type==='tool-result'&&event.toolCallId.startsWith(${JSON.stringify(allowed.runId+':')})).some(event=>JSON.parse(event.result).output.includes('line 2'))`),'The native final output must retain subsequent progress');
      assert.equal(await js(`$('messages').textContent.includes('WRONG_SESSION_SHOULD_NOT_APPEAR')`),false);
      const rpc=await log(); assert.ok(rpc.some(record=>record.kind===descriptor.provider&&record.response&&(descriptor.provider==='glm'?record.response.decision==='allow':record.response.outcome?.optionId==='allow-once-native')));
      if(descriptor.provider==='glm')assert.ok(rpc.some(record=>record.id===99&&record.response?.action==='accept'&&record.response.content?.answers?.['官方代理选择本次测试方式']==='keep-files'));
      if(descriptor.provider==='gemini'||descriptor.provider==='glm'){
        stage='empty official directory keeps '+descriptor.provider+' connected';await selectMode(descriptor);
        const emptyFlag=path.join(fixtureDir,'empty-catalog-'+descriptor.provider+'.flag'),code=descriptor.provider==='gemini'?'AGY_CATALOG_EMPTY':'ZCODE_CATALOG_EMPTY';
        const expected=(descriptor.provider==='gemini'?'Antigravity':'ZCode')+' 已连接，但官方会话没有返回可选模型，请刷新目录或检查账号权限。';
        await fs.writeFile(emptyFlag,'simulate an empty upstream account directory');
        try{
          await click('#settings-model-refresh');
          await until('typed empty directory '+descriptor.provider,async()=>(await state())[descriptor.key].error?.code===code&&await js(`!settingsCatalogLoading&&Boolean(settingsCatalogError)`));
          const connected=(await state())[descriptor.key].session;assert.equal(connected.status,'connected');assert.equal(connected.sharing,true);assert.equal(connected.profileId,profile);
          assert.equal(await js(`settingsCatalog===null&&settingsCatalogDraft===null&&selectedSettingsModel()===undefined&&$('save-settings').disabled`),true);
          assert.equal(await js(`$(${JSON.stringify(descriptor.prefix+'-login-message')}).textContent`),expected);
          assert.equal(await js(`$('settings-model-catalog-message').textContent`),expected,'Directory errors must not expose IPC wrappers or error class names');
          assert.equal(await js(`$(${JSON.stringify(descriptor.prefix+'-sign-in')}).hidden&&!$(${JSON.stringify(descriptor.prefix+'-models')}).disabled`),true);
          await capture('official-agent-'+descriptor.provider+'-empty-catalog.png');
        }finally{await fs.rm(emptyFlag,{force:true});}
        await selectCatalog(descriptor);assert.equal((await state())[descriptor.key].session.profileId,profile);
      }
      if(descriptor.provider==='kimi'){
        stage='Kimi subscription denial keeps its connected account';const loginCount=(await log()).filter(record=>record.kind==='kimi'&&record.event==='spawn'&&record.args.includes('--login')).length;
        await fs.writeFile(path.join(fixtureDir,'kimi-subscription-error.once'),'one simulated denial');
        const failed=await call('runTask',{text:'OFFICIAL_NATIVE_SUBSCRIPTION_kimi_'+nonce});
        const ended=await until('subscription request terminal',async()=>await js(`window.__officialSmoke.events.find(event=>event.type==='run-end'&&event.runId===${JSON.stringify(failed.runId)})`));
        assert.equal(ended.status,'failed');
        await until('subscription failure settled',async()=>!(await state()).activeTask.running);
        const retained=(await state()).kimiAgent;assert.equal(retained.session.status,'connected');assert.equal(retained.session.sharing,true);assert.equal(retained.session.profileId,profile);assert.equal(retained.error.code,'KIMI_SUBSCRIPTION_REQUIRED');
        assert.doesNotMatch(JSON.stringify(retained),/PRIVATE_TOKEN|example\.invalid|secret=/);
        await selectMode(descriptor);await until('subscription recovery guidance',()=>js(`$('kimi-agent-login-message').textContent==='账号已登录，但当前订阅没有 Kimi Code 访问权限，请在官方账号中确认 Coding 套餐。'`));
        assert.equal(await js(`$('kimi-agent-sign-in').hidden&&!$('kimi-agent-models').hidden&&!$('kimi-agent-models').disabled`),true);
        await capture('official-agent-kimi-subscription.png');await selectCatalog(descriptor);
        assert.equal((await log()).filter(record=>record.kind==='kimi'&&record.event==='spawn'&&record.args.includes('--login')).length,loginCount,'Subscription denial must not trigger another login');
        records.push({provider:'kimi',marker:'SUBSCRIPTION',status:ended.status,runId:failed.runId,profilePreserved:true});
      }
      await openSettings('pet'); await js(`$('provider-select').value=${JSON.stringify(descriptor.provider)};$('provider-select').dispatchEvent(new Event('change',{bubbles:true}));true`);
      assert.equal(await js(`Array.from($(${JSON.stringify(descriptor.mode)}).options).find(option=>option.value===${JSON.stringify(descriptor.authMode)}).disabled`),true);
      assert.equal(await js(`$('key-status').textContent`),'未配置'); await click('#close-settings');
      if (descriptor.secondRegion) {
        stage='region isolation '+descriptor.provider; await selectMode(descriptor);
        await js(`$(${JSON.stringify(descriptor.prefix+'-region')}).value=${JSON.stringify(descriptor.secondRegion)};$(${JSON.stringify(descriptor.prefix+'-region')}).dispatchEvent(new Event('change',{bubbles:true}));true`);
        assert.equal(await js(`settingsCatalog===null&&$(${JSON.stringify(descriptor.prefix+'-models')}).hidden`),true);
        await click('#'+descriptor.prefix+'-sign-in'); await until('region account connected',async()=>(await state())[descriptor.key].region===descriptor.secondRegion&&(await state())[descriptor.key].session.status==='connected'&&await js('!isChatGPTBusy()'));
        assert.notEqual((await state())[descriptor.key].session.profileId,profile); const secondModel=await selectCatalog(descriptor); assert.notEqual(secondModel,model,'Actual model selection stays bound to the regional account');
      }
    }
    stage='Kimi native question in Full mode'; const ki=descriptors[1]; await selectMode(ki); await selectCatalog(ki); await call('setPermissionMode',{mode:'full',confirmed:true});
    records.push({provider:'kimi',...await run(ki,'QUESTION')});
    assert.ok((await log()).some(record=>record.kind==='kimi'&&record.id===99&&record.response?.outcome?.optionId==='q0_opt_1'));
    await call('setPermissionMode',{mode:'request'});
    stage='native deny and stop'; const ag=descriptors[0]; await selectMode(ag); await selectCatalog(ag); records.push({provider:'gemini',...await run(ag,'DENY','deny')});records.push({provider:'gemini',...await run(ag,'STOP')});
    await capture('official-agent-stopped.png');
    stage='six theme account panels'; await selectMode(ag);
    for (const uiStyle of ['glass','black','white','industrial','deepseek','codex']) { await call('setAppearance',{uiStyle}); await until('material '+uiStyle,()=>js(`document.documentElement.dataset.uiStyle===${JSON.stringify(uiStyle)}`)); await capture('official-agent-'+uiStyle+'.png'); }
    await click('#close-settings');
    assert.deepEqual(browserCalls,[glmLoginUrls.bigmodel,glmLoginUrls.zai]);
    assert.ok((await log()).some(record=>record.kind==='gemini'&&record.event==='late-model-config'));
    assert.ok((await log()).some(record=>record.kind==='gemini'&&record.event==='config-selection'&&record.configId==='model'&&record.value==='gemini-official-fixture'));
    assert.ok((await log()).filter(record=>record.kind==='glm'&&record.event==='spawn'&&record.args.includes('login')).every(record=>record.args.includes('--no-browser')));
    assert.doesNotMatch(JSON.stringify((await state()).glmAgent),/zcode-native|native-state|redirect=/);
    events.push(...await js('window.__officialSmoke.events')); assert.equal(events.some(event=>event.type==='tool-start'&&event.name==='run_command'),true);
    assert.equal(apiRequests.some(request=>request.method==='POST'),false); assert.deepEqual(problems,[]);
    const result={status:'completed',mock:true,realLogin:false,realModelCalls:false,realDownloads:false,realCommands:false,actualNodeChildProcesses:true,
      allThreeNativeModes:true,installIsNotLogin:true,scopeAndRegionIsolation:true,apiKeysPreserved:true,rolesCannotBorrowAgentOrKey:true,
      nativePermissionAllowOnceId:true,nativeUserInputValue:true,nativeChoiceOnlyFullWaitsForUser:true,nativeDeny:true,nativeStop:true,foreignSessionRejected:true,sixThemes:true,
      glmFullAuthorizationQueryPreserved:true,glmNoBrowserMode:true,realBrowserOpened:false,glmBrowserCallbackCount:browserCalls.length,kimiSubscriptionKeepsConnectedAccount:true,
      agyGroupedModelConfigWithoutCategory:true,agyLateConfigDiscovery:true,agyNativeConfigSelection:true,emptyOfficialCatalogKeepsProfiles:true,emptyOfficialCatalogCannotSave:true,
      records,screenshots,methods:[...new Set((await log()).map(record=>record.method).filter(Boolean))],usage:store?.usage?.records?.filter(record=>records.some(value=>value.runId===record.runId)).map(({provider,status,reported,inputTokens,outputTokens})=>({provider,status,reported,inputTokens,outputTokens}))||[]};
    await fs.writeFile(path.join(output,'official-agents-smoke-result.json'),JSON.stringify(result,null,2)+'\n'); return result;
  } catch(error) {
    const failure={status:'failed',stage,error:error.message,stack:error.stack,problems};
    if(child&&!child.isDestroyed())try{failure.state=await state();await capture('official-agents-failure.png');}catch(diagnostic){failure.diagnostic=diagnostic.message;}
    await fs.writeFile(path.join(output,'official-agents-smoke-result.json'),JSON.stringify(failure,null,2)+'\n'); throw new Error('Official-agent smoke failed at '+stage+': '+error.message,{cause:error});
  } finally {
    if(child&&!child.isDestroyed()){await call('stopTask').catch(()=>{});await until('task idle for cleanup',async()=>!(await state()).activeTask.running).catch(()=>{});}
    for(const agent of controllers)await agent.dispose().catch(()=>{});
    if(typeof restore==='function')await restore();
    if(child&&!child.isDestroyed()){
      if(appearance)await call('setAppearance',{uiStyle:appearance.uiStyle}).catch(()=>{});if(petState)await call('setPet',{enabled:petState.enabled}).catch(()=>{});
      if(original){for(const descriptor of descriptors){const previous=original.settings.providers[descriptor.provider]||{};await call('saveSettings',{provider:descriptor.provider,authMode:'apiKey',model:previous.model,baseUrl:previous.baseUrl,clearKey:true}).catch(()=>{});}await call('setPermissionMode',{mode:original.permissionMode,confirmed:original.permissionMode==='full'}).catch(()=>{});}
      child.close();await until('smoke window closes',()=>child.isDestroyed()).catch(()=>child.destroy());
    }
    for(const process of processes)if(process.exitCode===null&&!process.signalCode)await killTree(process);
    if(server.listening)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
  }
};
