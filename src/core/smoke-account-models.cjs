// Real packaged renderer, isolated memory-only preload. No production IPC is
// replaced, no credentials are read, and HTTP/OAuth/inference are forbidden.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { BrowserWindow, session } = require('electron');
const { Store } = require('./store.cjs');

module.exports = async function smokeAccountModels({ win, output, dataDir }) {
  assert.equal(win.webContents.isOffscreen(), true);
  const nonce = randomUUID(), fixtureDir = path.join(dataDir, 'account-models-' + nonce);
  const preload = path.join(fixtureDir, 'preview-preload.cjs');
  const styles = ['glass', 'deepseek', 'codex', 'black', 'white', 'industrial'];
  const descriptors = [
    { provider: 'gemini', mode: 'antigravity-agent', select: 'gemini-auth-mode', key: 'antigravity' },
    { provider: 'kimi', mode: 'kimi-agent', select: 'kimi-auth-mode', key: 'kimiAgent' },
    { provider: 'glm', mode: 'glm-agent', select: 'glm-auth-mode', key: 'glmAgent' },
    { provider: 'openai', mode: 'chatgpt', select: 'openai-auth-mode', key: 'chatgpt' },
    { provider: 'anthropic', mode: 'claude-agent', select: 'anthropic-auth-mode', key: 'claudeAgent' },
    { provider: 'doubao', mode: 'ark-account', select: 'doubao-auth-mode', key: 'ark' },
  ];
  const raw = ['official-budget:4096', '官方深思 / 2026'];
  const labels = ['平衡 · 官方预算', '深入 · 官方原始档位'];
  const screenshots = [], observed = {}, network = [];
  let child, stage = 'create isolated renderer';
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const js = code => child.webContents.executeJavaScript(code);
  const until = async (label, check) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const result = await check(); if (result) return result; await wait(30); }
    throw new Error('Account/model smoke timed out: ' + label);
  };
  const click = async selector => {
    const point = await until('visible target ' + selector, () => js(`(()=>{
      const node=document.querySelector(${JSON.stringify(selector)});
      if(!node||node.disabled||!node.checkVisibility({visibilityProperty:true}))return null;
      node.scrollIntoView({block:'nearest',behavior:'instant'});const box=node.getBoundingClientRect();
      const p={x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};
      return box.width&&box.height&&node.contains(document.elementFromPoint(p.x,p.y))?p:null;
    })()`));
    child.webContents.focus();
    for (const type of ['mouseMove','mouseDown','mouseUp']) child.webContents.sendInputEvent({ type, ...point,
      ...(type === 'mouseMove' ? {} : { button:'left', clickCount:1 }) });
    await wait(55);
  };
  const capture = async filename => {
    await js('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    for (let attempt=1;attempt<=4;attempt++) {
      try { child.webContents.invalidate(); await wait(150 * attempt); const picture=await child.webContents.capturePage();
        assert.equal(picture.isEmpty(),false); await fs.writeFile(path.join(output,filename),picture.toPNG()); screenshots.push(filename); return; }
      catch(error) { if(attempt===4||!/UnknownVizError/u.test(String(error)))throw error; }
    }
  };
  const configure = async (descriptor, selected = 'raw') => {
    await js(`(()=>{if($('settings-dialog').open)$('settings-dialog').close();closeReasoningPopup();return true})()`);
    await js(`window.forge.__smokeConfigure(${JSON.stringify({ provider:descriptor.provider, authMode:descriptor.mode, selected })}).then(updateState)`);
    await until('fixture connection applied', () => js(`appState?.settings?.provider===${JSON.stringify(descriptor.provider)}&&appState.settings.authMode===${JSON.stringify(descriptor.mode)}`));
  };
  const controls = () => js(`(()=>{const range=$('reasoning-effort');return {options:rangeOptions(range),labels:JSON.parse(range.dataset.labels||'{}'),
    effort:range.dataset.effort,disabled:range.disabled,label:$('reasoning-value').textContent,pill:$('composer-reasoning-label').textContent,
    aria:range.getAttribute('aria-valuetext'),defaultDisabled:$('reasoning-default').disabled};})()`);
  const open = async descriptor => {
    await js('openSettings()'); await until('settings open',()=>js(`$('settings-dialog').open`));
    await js(`(()=>{$('provider-select').value=${JSON.stringify(descriptor.provider)};$('provider-select').dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  };
  const mode = async (descriptor, authMode) => js(`(()=>{const select=$(${JSON.stringify(descriptor.select)});select.value=${JSON.stringify(authMode)};select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
  const refresh = async () => { await js('fetchSettingsCatalog(true)'); await until('settings fixture catalog',()=>js('!!settingsCatalog&&!settingsCatalogLoading')); };
  const save = async (descriptor, authMode, model) => {
    await mode(descriptor,authMode); await refresh();
    assert.equal(await js(`(()=>{const select=$('chatgpt-model-select');select.value=${JSON.stringify(model)};select.dispatchEvent(new Event('change',{bubbles:true}));return select.value})()`),model);
    await click('#save-settings'); await until('fixture mode saved',()=>js(`!$('settings-dialog').open&&!settingsSaving&&appState.settings.authMode===${JSON.stringify(authMode)}&&appState.settings.model===${JSON.stringify(model)}`));
  };
  try {
    await fs.mkdir(fixtureDir,{recursive:true}); await fs.mkdir(output,{recursive:true});
    // Read only public presentation state; the isolated fixture owns every
    // mutation and never delegates an operation back to these production APIs.
    const original = await win.webContents.executeJavaScript('window.forge.getState()');
    const appearance = await win.webContents.executeJavaScript('window.forge.getAppearance()');
    const fresh = new Store(fixtureDir,{isEncryptionAvailable:()=>false}).publicSettings();
    const initial = { ...structuredClone(original), settings:fresh, workspace:null, workspaceId:null, sessionId:null,
      sessions:[],recentProjects:[],pendingApprovals:[],activeTask:{running:false},promptQueue:{items:[],paused:false},
      modelCatalog:null,temporary:false,roleModels:{} };
    for(const descriptor of descriptors) {
      const config=fresh.providers[descriptor.provider];
      config.modelsByAuth ||= {apiKey:''}; config.modelsByAuth.apiKey='api-'+descriptor.provider;
      config.modelsByAuth[descriptor.mode]='official-'+descriptor.provider;
      config.model=config.modelsByAuth.apiKey;config.authMode='apiKey';config.hasKey=true;
      initial[descriptor.key]={runtime:{status:'ready',version:'1.0.0'},region:descriptor.provider==='kimi'?'mainland-cn':descriptor.provider==='glm'?'bigmodel':undefined,
        session:{status:'connected',sharing:true,profileId:'smoke-'+descriptor.provider},profiles:[],error:null};
    }
    Object.assign(fresh,{provider:'deepseek',...fresh.providers.deepseek});
    const source=String.raw`
const {contextBridge}=require('electron');
const clone=value=>structuredClone(value),listeners=new Set(),calls=[],pending=new Map();
let state=INITIAL_STATE,appearance=INITIAL_APPEARANCE;
const descriptors=DESCRIPTORS,raw=RAW_LEVELS,labels=RAW_LABELS;
// This fixture-only sentinel stays in the isolated preload. Public state has
// boolean hasKey flags only; no getter exposes saved secrets or ciphertext.
const privateKey='account-smoke-private-'+NONCE;
const emit=value=>{for(const listener of listeners)listener(clone(value));};
const catalog=(provider=state.settings.provider,authMode=state.settings.authMode)=>{
 const descriptor=descriptors.find(value=>value.provider===provider),account=authMode!=='apiKey';
 const id=account?'official-'+provider:'api-'+provider;
 const native=account&&authMode!=='chatgpt'&&authMode!=='ark-account';
 return {provider,authMode,source:provider==='doubao'&&!account?'official-docs':'account-fixture',
   fetchedAt:new Date().toISOString(),selectionToken:'offline-selection-'+provider+'-'+authMode,expiresAt:new Date(Date.now()+600000).toISOString(),
   models:[{id,displayName:account?'官方账号模型 · '+provider:'API 模型 · '+provider,compatible:true,textCompatible:true,supportsTools:true,supportsImages:true,
    ...(native?{reasoningEfforts:raw,reasoningOptions:raw.map((value,index)=>({value,label:labels[index]})),defaultReasoningEffort:raw[0],currentReasoningEffort:raw[0]}:{reasoningEfforts:provider==='doubao'?['minimal','low','medium','high']:['low','high']})},
    {id:'managed-'+provider,displayName:'由官方管理的模型 · '+provider,compatible:true,textCompatible:true,supportsTools:true,reasoningEfforts:[],reasoningOptions:[]}]};
};
const sync=()=>{const config=state.settings.providers[state.settings.provider];Object.assign(state.settings,config);state.modelCatalog=catalog();return clone(state);};
const setConnection=({provider,authMode,selected='raw'})=>{const config=state.settings.providers[provider];config.authMode=authMode;
 config.model=selected==='managed'?'managed-'+provider:config.modelsByAuth[authMode];config.reasoningEffort='default';state.settings.provider=provider;return sync();};
const record=(method,arg)=>{const entry={method};if(arg)for(const key of ['provider','authMode','model','reasoningEffort','profileName'])if(typeof arg[key]==='string')entry[key]=arg[key];calls.push(entry);};
const bridge={
 getState:async()=>clone(state),getAppearance:async()=>clone(appearance),getCurrentSession:async()=>null,
 getAppUpdate:async()=>({status:'idle',currentVersion:state.version}),getExtensions:async()=>({extensions:[],commands:[]}),
 petState:async()=>({enabled:false,media:null,settings:{enabled:false}}),getPetDialog:async()=>({visible:false}),
 onEvent:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
 setAppearance:async patch=>{appearance={...appearance,...patch};emit({type:'appearance',appearance});return clone(appearance);},
 listModels:async arg=>{record('listModels',arg);return catalog(arg?.provider,arg?.authMode);},
 previewModelCatalog:async arg=>{record('previewModelCatalog',arg);return catalog(arg.provider,arg.authMode);},
 saveModelSettings:async arg=>{record('saveModelSettings',arg);if(arg.apiKey)throw Error('This preview must not receive a key');const config=state.settings.providers[arg.provider];
   config.authMode=arg.authMode;config.model=arg.model;config.modelsByAuth[arg.authMode]=arg.model;config.reasoningEffort='default';state.settings.provider=arg.provider;return sync();},
 selectModel:async arg=>{record('selectModel',arg);const config=state.settings.providers[state.settings.provider];config.model=arg.model;config.modelsByAuth[config.authMode]=arg.model;config.reasoningEffort='default';return sync();},
 setReasoningEffort:async arg=>{record('setReasoningEffort',arg);state.settings.providers[state.settings.provider].reasoningEffort=arg.reasoningEffort;return sync();},
 __smokeConfigure:async arg=>setConnection(arg),
 __smokeAccountStatus:async({key,status})=>{state[key].session.status=status;state[key].session.sharing=status==='connected';return clone(state);},
 __smokeAwaitAuthorizationCode:async()=>{state.ark.session.status='connecting';state.ark.session.sharing=false;state.ark.attempt={phase:'waiting-authorization-code',
   verificationUrl:'https://signin.volcengine.com/authorize/oauth/authorize?state=public-preview',expiresAt:'2099-01-01T00:10:00.000Z'};emit({type:'state',state});return clone(state);},
 arkOpenAuthorization:async()=>{record('arkOpenAuthorization');if(state.ark.attempt?.phase!=='waiting-authorization-code')throw Error('No authorization pending');return clone(state);},
 arkSubmitAuthorizationCode:async arg=>{record('arkSubmitAuthorizationCode');if(state.ark.attempt?.phase!=='waiting-authorization-code'||arg?.code!=='c3ludGhldGljLWF1dGhvcml6YXRpb24=')throw Error('[ARK_AUTH_CODE_INVALID] Invalid preview code');
   state.ark.attempt={phase:'exchanging-authorization-code'};emit({type:'state',state});return new Promise(resolve=>pending.set('ark-code',resolve));},
 __smokeChooseProfiles:async()=>{state.ark.session.status='connecting';state.ark.session.sharing=false;state.ark.attempt={phase:'choosing-profile'};
   state.ark.profiles=[{name:'platform_cn-beijing',type:'platform',region:'cn-beijing'},
    {name:'agent-plan_cn-beijing_personal',type:'agent-plan',region:'cn-beijing'},
    {name:'coding-plan_cn-beijing_personal',type:'coding-plan',region:'cn-beijing'}];emit({type:'state',state});pending.get('ark-code')?.(clone(state));pending.delete('ark-code');return clone(state);},
 arkSelectProfile:async arg=>{record('arkSelectProfile',arg);if(state.ark.attempt?.phase!=='choosing-profile'||!state.ark.profiles.some(profile=>profile.name===arg.profileName))throw Error('Unexpected preview profile selection');
   state.ark.attempt={phase:'validating-profile'};emit({type:'state',state});return new Promise(resolve=>pending.set('ark-profile',resolve));},
 __smokeFinishProfile:async()=>{if(!pending.has('ark-profile'))throw Error('No explicit profile selection pending');state.ark.attempt=null;state.ark.session.status='connected';state.ark.session.sharing=true;
   emit({type:'state',state});for(const key of ['ark-profile','ark']){pending.get(key)?.(clone(state));pending.delete(key);}return clone(state);},
 __smokeSnapshot:async()=>({calls:clone(calls),privateKeyPublic:JSON.stringify(state).includes(privateKey),productionIpc:false,pendingProfile:pending.has('ark-profile'),pendingCode:pending.has('ark-code')}),
};
for(const descriptor of descriptors)for(const action of ['SignIn','CancelSignIn','Disconnect','RetryStorage','Install']){
 const prefix=descriptor.key==='chatgpt'?'chatgpt':descriptor.key;
 bridge[prefix+action]=async()=>{record(prefix+action);const account=state[descriptor.key];
  if(action==='SignIn'){account.session.status='connecting';account.session.sharing=false;account.attempt={phase:'waiting-browser'};
   emit({type:'state',state});return new Promise(resolve=>pending.set(prefix,resolve));}
  account.session.status=action==='CancelSignIn'||action==='Disconnect'?'disconnected':'connected';account.session.sharing=account.session.status==='connected';account.attempt=null;
  emit({type:'state',state});for(const key of [prefix,prefix+'-profile',prefix+'-code']){pending.get(key)?.(clone(state));pending.delete(key);}return clone(state);
 };
}
for(const name of ['setEditorDirty','setMenuState','setContextSettings','setTextScale','copyText','browserLayout','stopFind'])bridge[name]=async()=>null;
for(const name of ['submitPrompt','runTask','openLink','openProviderAccount','openHelp','runTerminal','checkAppUpdate','downloadAppUpdate','installAppUpdate'])bridge[name]=async()=>{record(name);throw Error('External action forbidden in offline account/model smoke');};
contextBridge.exposeInMainWorld('forge',Object.freeze(bridge));
` .replace('INITIAL_STATE',()=>JSON.stringify(initial)).replace('INITIAL_APPEARANCE',()=>JSON.stringify({...appearance,backgroundImage:null,backgroundName:'',uiStyle:'glass'}))
      .replace('DESCRIPTORS',()=>JSON.stringify(descriptors)).replace('RAW_LEVELS',()=>JSON.stringify(raw)).replace('RAW_LABELS',()=>JSON.stringify(labels)).replace('NONCE',()=>JSON.stringify(nonce));
    await fs.writeFile(preload,source,'utf8');
    const isolated=session.fromPartition('account-model-smoke-'+nonce,{cache:false});
    isolated.setPermissionRequestHandler((_webContents,_permission,callback)=>callback(false));
    isolated.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*']},(details,callback)=>{network.push(details.url);callback({cancel:true});});
    child=new BrowserWindow({width:1280,height:900,show:false,webPreferences:{preload,partition:'account-model-smoke-'+nonce,
      contextIsolation:true,nodeIntegration:false,sandbox:false,offscreen:true,backgroundThrottling:false}});
    child.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    child.webContents.on('will-navigate',(event,url)=>{if(/^https?:/iu.test(url)){network.push(url);event.preventDefault();}});
    await child.loadFile(path.join(__dirname,'..','renderer','index.html'));
    await until('actual renderer initialized',()=>js('!!appState&&!!window.synoraClaudeAgentLogin&&!!window.synoraArkLogin'));
    await js(`(()=>{window.__accountSmokeErrors=[];addEventListener('error',event=>window.__accountSmokeErrors.push(String(event.message)));addEventListener('unhandledrejection',event=>window.__accountSmokeErrors.push(String(event.reason?.message||event.reason)));return true})()`);

    stage='unified account names';
    await open(descriptors[0]);
    for(const descriptor of descriptors){
      await js(`(()=>{$('provider-select').value=${JSON.stringify(descriptor.provider)};$('provider-select').dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
      const names=await js(`(()=>{const select=$(${JSON.stringify(descriptor.select)});return [...select.options].map(option=>({value:option.value,label:option.textContent}))})()`);
      assert.equal(names.find(value=>value.value===descriptor.mode)?.label,'账号登录',descriptor.provider+' account mode label');
      assert.equal(names.find(value=>value.value==='apiKey')?.label,'API Key');observed[descriptor.provider]={names};
    }
    assert.equal(await js(`!![...$('provider-select').options].find(option=>option.value==='doubao'&&option.textContent.includes('豆包'))`),true);

    stage='raw official reasoning and model changes';
    for(const descriptor of descriptors.filter(value=>!['chatgpt','ark-account'].includes(value.mode))){
      await configure(descriptor);await js('openReasoningPopup()');await until('native raw catalog ready',()=>js('!catalogLoading'));
      assert.deepEqual((await controls()).options,raw);
      await js(`(()=>{const range=$('reasoning-effort');range.value='1';range.dispatchEvent(new Event('input',{bubbles:true}));range.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
      await until('raw effort saved',()=>js(`!reasoningSaving&&appState.settings.reasoningEffort===${JSON.stringify(raw[1])}`));
      const chosen=await controls();assert.equal(chosen.label,labels[1]);assert.equal(chosen.pill,labels[1]);assert.equal(chosen.aria,labels[1]);
      await js(`selectCurrentModel(currentCatalog.models.find(value=>value.id===${JSON.stringify('managed-'+descriptor.provider)}))`);
      await until('new model options cleared',()=>js(`!modelSaving&&appState.settings.model===${JSON.stringify('managed-'+descriptor.provider)}`));
      const managed=await controls();assert.deepEqual(managed.options,[]);assert.deepEqual(managed.labels,{});assert.equal(managed.effort,'default');
      assert.equal(managed.label,'由官方代理管理');assert.equal(managed.pill,'由官方代理管理');assert.equal(managed.disabled,true);assert.equal(managed.defaultDisabled,true);
      observed[descriptor.provider].reasoning={chosen,managed};
    }

    stage='new Claude and Ark login panels and model slots';
    for(const descriptor of descriptors.filter(value=>['anthropic','doubao'].includes(value.provider))){
      await configure(descriptor);await open(descriptor);
      assert.equal(await js(`!$(${JSON.stringify(descriptor.provider==='anthropic'?'claude-agent-login-panel':'ark-login-panel')}).hidden&&$('api-key-field').hidden&&$('base-url-field').hidden`),true);
      assert.equal(await js(`$('api-key-input').value`),'');
      await js(`window.forge.__smokeAccountStatus(${JSON.stringify({key:descriptor.key,status:'disconnected'})}).then(updateState)`);
      const prefix=descriptor.provider==='anthropic'?'claude-agent':'ark';await click('#'+prefix+'-sign-in');
      await until('offline sign in waiting',()=>js(`!$(${JSON.stringify(prefix+'-cancel-sign-in')}).hidden`));
      assert.equal(await js(`$(${JSON.stringify(prefix+'-login-status')}).textContent.includes('等待')`),true);
      await capture('account-models-'+descriptor.provider+'-login.png');
      await click('#'+prefix+'-cancel-sign-in');await until('offline login cancelled',()=>js(`!isChatGPTBusy()&&appState[${JSON.stringify(descriptor.key)}].session.status==='disconnected'`));
      await js(`window.forge.__smokeAccountStatus(${JSON.stringify({key:descriptor.key,status:'connected'})}).then(updateState)`);
      await save(descriptor,'apiKey','api-'+descriptor.provider);
      await open(descriptor);await save(descriptor,descriptor.mode,'official-'+descriptor.provider);
      const slots=await js(`appState.settings.providers[${JSON.stringify(descriptor.provider)}].modelsByAuth`);
      assert.equal(slots.apiKey,'api-'+descriptor.provider);assert.equal(slots[descriptor.mode],'official-'+descriptor.provider);
      await open(descriptor);await mode(descriptor,'apiKey');assert.equal(await js(`$('api-key-input').value`),'');
      assert.equal(await js(`$('key-status').textContent`),'已在本机保存');
      await mode(descriptor,descriptor.mode);await refresh();
      assert.equal(await js(`settingsCatalog.models.some(value=>value.id===${JSON.stringify('api-'+descriptor.provider)})`),false);
      observed[descriptor.provider].slots=slots;
    }

    stage='Doubao documented API efforts and source label';
    const doubaoApi={...descriptors.find(value=>value.provider==='doubao'),mode:'apiKey'};
    await configure(doubaoApi);await js('openReasoningPopup()');await until('Doubao API metadata shown',()=>js('!catalogLoading'));
    assert.deepEqual((await controls()).options,['minimal','low','medium','high']);
    await open(doubaoApi);await refresh();assert.equal(await js(`$('settings-model-catalog-message').textContent.includes('官方文档')`),true);

    stage='Ark explicit profile selection and cancellation';
    const arkDescriptor=descriptors.find(value=>value.provider==='doubao');
    await configure(arkDescriptor);await open(arkDescriptor);
    const profileControls=()=>js(`(()=>{const select=$('ark-profile-select'),button=$('ark-profile-confirm');return {
      visible:!$('ark-profile-field').hidden,value:select.value,disabled:select.disabled,confirmDisabled:button.disabled,
      cancelDisabled:$('ark-cancel-sign-in').disabled,providerDisabled:$('provider-select').disabled,
      modeDisabled:$('doubao-auth-mode').disabled,status:$('ark-login-status').textContent,
      options:[...select.options].map(option=>({value:option.value,label:option.textContent}))}})()`);
    const beginProfileChoice=async()=>{
      await js(`window.forge.__smokeAccountStatus({key:'ark',status:'disconnected'}).then(updateState)`);
      await click('#ark-sign-in');await until('Ark browser authorization preview',()=>js(`appState.ark.session.status==='connecting'&&!$('ark-cancel-sign-in').hidden`));
      await js('window.forge.__smokeAwaitAuthorizationCode().then(updateState)');
      await until('Ark authorization code entry enabled during login lock',()=>js(`!$('ark-authorization-field').hidden&&!$('ark-code-input').disabled&&!$('ark-open-authorization').disabled`));
      assert.equal(await js(`$('ark-code-input').type==='password'&&$('ark-code-input').autocomplete==='off'&&$('provider-select').disabled&&$('doubao-auth-mode').disabled&&$('ark-code-submit').disabled&&!$('ark-cancel-sign-in').disabled`),true);
      assert.equal(await js(`$('ark-login-status').textContent.includes('等待粘贴')&&!$('ark-login-status').textContent.includes('已打开')`),true);
      await click('#ark-open-authorization');await until('Ark authorization reopen completed',()=>js(`!$('ark-open-authorization').disabled`));
      await capture('account-models-ark-authorization-code.png');
      await js(`(()=>{$('ark-code-input').value='c3ludGhldGljLWF1dGhvcml6YXRpb24=';$('ark-code-input').dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
      await until('Ark code submit enabled',()=>js(`!$('ark-code-submit').disabled`));await click('#ark-code-submit');
      await until('Ark authorization code exchange held',()=>js(`window.forge.__smokeSnapshot().then(value=>value.pendingCode)`));
      assert.equal(await js(`$('ark-code-input').value===''&&!$('ark-cancel-sign-in').disabled`),true);
      await js('window.forge.__smokeChooseProfiles().then(updateState)');
      await until('Ark three profiles shown',()=>js(`!$('ark-profile-field').hidden&&$('ark-profile-select').options.length===4`));
      const choosing=await profileControls();assert.equal(choosing.value,'','A new authorization must not silently select pay-as-you-go or reuse a cancelled profile');
      assert.equal(choosing.disabled,false,'Global login busy lock disabled the profile selector');
      assert.equal(choosing.confirmDisabled,true);assert.equal(choosing.cancelDisabled,false);
      assert.equal(choosing.providerDisabled,true);assert.equal(choosing.modeDisabled,true);
      assert.deepEqual(choosing.options.map(option=>option.value),['','platform_cn-beijing','agent-plan_cn-beijing_personal','coding-plan_cn-beijing_personal']);
      assert.match(choosing.options[1].label,/按量 API.*独立计费/u);assert.match(choosing.options[2].label,/Agent Plan/u);assert.match(choosing.options[3].label,/Coding Plan/u);
      return choosing;
    };
    const selectProfile=async profileName=>{
      await js(`(()=>{$('ark-profile-select').value=${JSON.stringify(profileName)};$('ark-profile-select').dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
      await until('Explicit profile confirm enabled',()=>js(`!$('ark-profile-confirm').disabled`));
      assert.equal((await profileControls()).value,profileName);
      await click('#ark-profile-confirm');await until('Profile validation held',()=>js(`window.forge.__smokeSnapshot().then(value=>value.pendingProfile)`));
      const busy=await profileControls();assert.equal(busy.disabled,true);assert.equal(busy.confirmDisabled,true);assert.equal(busy.cancelDisabled,false,'Profile validation must remain cancellable');
      return busy;
    };
    const beforeChoice=(await js('window.forge.__smokeSnapshot()')).calls.filter(value=>value.method==='arkSelectProfile').length;
    const firstChoice=await beginProfileChoice();
    await js(`$('ark-profile-confirm').click()`);await wait(80);
    assert.equal((await js('window.forge.__smokeSnapshot()')).calls.filter(value=>value.method==='arkSelectProfile').length,beforeChoice,'No profile may be selected automatically');
    await capture('account-models-ark-profile-choice.png');
    const validating=await selectProfile('agent-plan_cn-beijing_personal');
    await capture('account-models-ark-profile-validating.png');
    await click('#ark-cancel-sign-in');await until('Pending profile validation cancelled',()=>js(`!isChatGPTBusy()&&appState.ark.session.status==='disconnected'`));
    await wait(80);assert.equal(await js('appState.ark.session.sharing'),false);
    assert.equal((await js('window.forge.__smokeSnapshot()')).pendingProfile,false);
    const secondChoice=await beginProfileChoice();
    await selectProfile('coding-plan_cn-beijing_personal');
    await js('window.forge.__smokeFinishProfile().then(updateState)');
    await until('Explicit Coding Plan connection finished',()=>js(`!isChatGPTBusy()&&appState.ark.session.status==='connected'&&appState.ark.session.sharing`));
    const profileCalls=(await js('window.forge.__smokeSnapshot()')).calls.filter(value=>value.method==='arkSelectProfile').slice(beforeChoice);
    assert.deepEqual(profileCalls.map(value=>value.profileName),['agent-plan_cn-beijing_personal','coding-plan_cn-beijing_personal']);
    observed.doubao.profileSelection={firstChoice,secondChoice,validating,profileCalls,cancelledBeforeCommit:true};

    stage='six material styles and real screenshots';
    const claude=descriptors.find(value=>value.provider==='anthropic');await configure(claude);await open(claude);
    for(const style of styles){
      await js(`window.forge.setAppearance({uiStyle:${JSON.stringify(style)}})`);
      await until('material applied '+style,()=>js(`document.documentElement.dataset.uiStyle===${JSON.stringify(style)}`));
      const geometry=await js(`(()=>{const nodes=['settings-dialog','anthropic-auth-mode','claude-agent-login-panel','chatgpt-model-field'];return {style:document.documentElement.dataset.uiStyle,overflow:document.documentElement.scrollWidth>innerWidth+1,
        nodes:nodes.map(id=>{const n=$(id),r=n.getBoundingClientRect();return {id,visible:n.checkVisibility(),width:r.width,left:r.left,right:r.right}})}})()`);
      assert.equal(geometry.overflow,false);for(const box of geometry.nodes){assert.equal(box.visible,true,box.id+' '+style);assert.ok(box.width>0&&box.left>=0&&box.right<=1281,box.id+' within viewport '+style);}
      observed[style]=geometry;await capture('account-models-style-'+style+'.png');
    }
    const snapshot=await js('window.forge.__smokeSnapshot()');
    assert.equal(snapshot.privateKeyPublic,false);assert.equal(snapshot.productionIpc,false);
    assert.equal(await js(`(()=>{const text=JSON.stringify(appState)+document.documentElement.outerHTML;return text.includes('account-smoke-private-')||text.includes('encryptedKey')||!!document.querySelector('#api-key-input')?.value})()`),false);
    assert.deepEqual(network,[]);assert.deepEqual(await js('window.__accountSmokeErrors'),[]);
    assert.equal(snapshot.calls.some(value=>['submitPrompt','runTask','openLink','openProviderAccount','runTerminal'].includes(value.method)),false);
    const parent=await win.webContents.executeJavaScript('window.forge.getState()');
    assert.deepEqual(parent.settings,original.settings);assert.equal(parent.sessionId,original.sessionId);assert.deepEqual(parent.workspace,original.workspace);
    return {status:'completed',realApi:false,realOAuth:false,productionIpc:false,isolatedRenderer:true,accountNamesUnified:true,
      rawReasoningPreserved:true,officialLabelsPreserved:true,managedWithoutAdvertisedLevels:true,modelChangeClearsReasoning:true,
      claudeAndArkPanels:true,loginCancel:true,doubaoDocumentedFourEfforts:true,arkAuthorizationCodeEntry:true,arkCodeClearedBeforeExchange:true,arkAuthorizationReopen:true,arkExplicitProfileChoice:true,arkPayAsYouGoNotPreselected:true,arkBusySelectorUsable:true,arkProfileValidationCancelable:true,modelSlotsSeparate:true,keysAbsentFromRenderer:true,parentPreserved:true,
      styles,screenshots,observed};
  } catch(error) {
    if(child&&!child.isDestroyed()){
      await capture('account-models-failure.png').catch(()=>{});
      const context=await js(`({notice:$('notice-text')?.textContent,settingsOpen:$('settings-dialog')?.open,settingsError:$('settings-error')?.textContent,
        errors:window.__accountSmokeErrors||[],provider:appState?.settings?.provider,authMode:appState?.settings?.authMode})`).catch(()=>null);
      console.error('ACCOUNT_MODELS_SMOKE_FAILURE',JSON.stringify({stage,error:error.message,context,network}));
    }
    throw error;
  } finally { if(child&&!child.isDestroyed())child.destroy(); }
};
