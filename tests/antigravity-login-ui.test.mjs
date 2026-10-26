import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../src/renderer/antigravity-login.js',import.meta.url),'utf8');
const appSource=await fs.readFile(new URL('../src/renderer/app.js',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
class Element{
  constructor(document){Object.assign(this,{document,children:[],events:new Map(),attributes:{},value:'',textContent:'',hidden:false,disabled:false});}
  set id(value){this._id=value;this.document.nodes.set(value,this);}get id(){return this._id;}
  append(...nodes){this.children.push(...nodes);}before(...nodes){this.document.body.append(...nodes);}
  setAttribute(key,value){this.attributes[key]=String(value);}removeAttribute(key){delete this.attributes[key];}
  addEventListener(type,handler){this.events.set(type,handler);}removeEventListener(type,handler){if(this.events.get(type)===handler)this.events.delete(type);}
  click(){if(!this.disabled)return this.events.get('click')?.();}remove(){this.removed=true;}
  set innerHTML(_){throw new Error('Untrusted account state must remain text-only');}
}
const empty=()=>({runtime:{status:'missing',version:null,download:null},session:{status:'disconnected',sharing:false,profileId:null},error:null});

test('download failures show fixed network guidance instead of raw transport or proxy details',()=>{
  for(const [code,hint] of [
    ['AGY_DOWNLOAD_TIMEOUT','超时'], ['AGY_DOWNLOAD_PROXY','系统代理'],
    ['AGY_DOWNLOAD_TLS','证书'], ['AGY_DOWNLOAD_DNS','DNS'],
  ]) {
    const f=fixture({initial:{...empty(),runtime:{status:'error',error:{code,message:'PRIVATE_PROXY_PASSWORD https://host/?token=SECRET'}}}});f.open();
    assert.match(f.node('antigravity-login-message').textContent,new RegExp(hint,'u'));
    assert.doesNotMatch(f.node('antigravity-login-message').textContent,/PRIVATE|SECRET|https:/u);
    assert.equal(f.node('antigravity-install').disabled,false);
    assert.equal(f.calls.length,0);
  }
});
function fixture({initial=empty(),role=null,methods={},descriptor}={}){
  const spec={provider:'gemini',modeId:'gemini-auth-mode',authMode:'antigravity-agent',stateKey:'antigravity',prefix:'antigravity',bridgePrefix:'antigravity',...descriptor};
  const document={nodes:new Map(),getElementById(id){return this.nodes.get(id);},createElement(){return new Element(document);}};document.body=new Element(document);
  for(const id of ['provider-select',spec.modeId,spec.modeId+'-field','base-url-field']){const element=new Element(document);element.id=id;}
  document.nodes.get('provider-select').value=spec.provider;document.nodes.get(spec.modeId).value='apiKey';
  for(const value of ['apiKey',spec.authMode]){const option=new Element(document);option.value=value;document.nodes.get(spec.modeId).append(option);}
  let state={settings:{provider:spec.provider},[spec.stateKey]:initial},busy=false;const calls=[],args=[],applied=[],invalidations=[];let refreshed=0;
  const bridge={getState:async()=>state};
  for(const suffix of ['Install','SignIn','CancelSignIn','Disconnect','RetryStorage']){const name=spec.bridgePrefix+suffix;bridge[name]=value=>{calls.push(name);args.push(value);return methods[name]?methods[name](value):state;};}
  const context=vm.createContext({document,URL});vm.runInContext(source,context);let ui;
  ui=context.ForgeAntigravityLogin.create({document,bridge,descriptor,getScope:()=>state,getRole:()=>role,isBusy:()=>busy,
    onState:next=>{state=next;applied.push(next);ui.render();},onChange:()=>ui.render(),onInvalidate:()=>invalidations.push(true),onRefreshModels:()=>{refreshed++;}});
  return{ui,calls,args,applied,invalidations,api:context.ForgeAntigravityLogin,node:id=>document.nodes.get(id),
    open(){this.node(spec.modeId).value=spec.authMode;ui.render();},update(value){state={...state,[spec.stateKey]:value};ui.render();},
    busy(value){busy=value;ui.render();},refreshed:()=>refreshed};
}

test('official-agent panel remains independent from API keys, old CLI and five role account actions',async()=>{
  const f=fixture();assert.equal(f.node('antigravity-login-panel').hidden,true);assert.equal(f.calls.length,0);
  f.open();assert.equal(f.node('antigravity-login-panel').hidden,false);assert.match(f.node('antigravity-login-help').textContent,/完整执行主会话/);
  assert.equal(f.node('antigravity-sign-in').disabled,false);assert.equal(f.calls.length,0);
  f.node('gemini-auth-mode').value='gemini-account';f.ui.render();assert.equal(f.node('antigravity-login-panel').hidden,true);
  for(const role of ['subagent','approval','completion','sidebar','pet']){const r=fixture({role});r.open();assert.equal(r.node('antigravity-login-panel').hidden,true);await r.node('antigravity-sign-in').click();assert.equal(r.calls.length,0);}
});

const kimi={provider:'kimi',authMode:'kimi-agent',stateKey:'kimiAgent',prefix:'kimi-agent',name:'Kimi Code',modeId:'kimi-auth-mode',bridgePrefix:'kimiAgent',errorPrefix:'KIMI_',
  regions:[['mainland-cn','中国大陆'],['global','国际']],allowDeviceCode:true,verificationHosts:['kimi.com','moonshot.cn','moonshot.ai']};
const glm={provider:'glm',authMode:'glm-agent',stateKey:'glmAgent',prefix:'glm-agent',name:'ZCode',modeId:'glm-auth-mode',bridgePrefix:'glmAgent',errorPrefix:'ZCODE_',regions:[['bigmodel','智谱'],['zai','Z.AI']]};

test('Kimi and ZCode share the agent controller while keeping regional login bridges and runtime state independent',async()=>{
  for(const descriptor of [kimi,glm]){
    const region=descriptor.regions[0][0],f=fixture({descriptor,initial:{...empty(),region,runtime:{status:'ready'}}});f.open();
    assert.equal(f.ui.getRegion(),region);const nextRegion=descriptor.regions[1][0];f.node(descriptor.prefix+'-region').value=nextRegion;
    f.node(descriptor.prefix+'-region').events.get('change')();assert.equal(f.invalidations.length,1);
    await f.node(descriptor.prefix+'-sign-in').click();assert.deepEqual(f.calls,[descriptor.bridgePrefix+'SignIn']);
    assert.equal(JSON.stringify(f.args[0]),JSON.stringify({region:nextRegion}));
    assert.doesNotMatch(f.node(descriptor.prefix+'-login-help').textContent,/Google/);
    for(const role of ['subagent','approval','completion','sidebar','pet']){
      const r=fixture({descriptor,role});r.ui.fill(descriptor.authMode);assert.equal(r.node(descriptor.modeId).value,'apiKey');
      assert.equal(r.node(descriptor.modeId).children.find(option=>option.value===descriptor.authMode).disabled,true);
      await r.node(descriptor.prefix+'-sign-in').click();assert.equal(r.calls.length,0);
    }
  }
});

test('switching account region invalidates the directory immediately and cannot use the previous connected account as the new region',()=>{
  const f=fixture({descriptor:kimi,initial:{...empty(),region:'mainland-cn',runtime:{status:'ready'},session:{status:'connected',sharing:true,profileId:'mainland-generation'}}});f.open();
  assert.equal(f.node('kimi-agent-models').hidden,false);f.node('kimi-agent-region').value='global';f.node('kimi-agent-region').events.get('change')();
  assert.equal(f.node('kimi-agent-login-status').textContent,'请连接所选地区账号');assert.equal(f.node('kimi-agent-models').hidden,true);assert.equal(f.node('kimi-agent-sign-in').hidden,false);
  assert.equal(f.calls.length,0,'selecting a region never silently authorizes or disconnects an account');
});
test('Kimi subscription denial explains the Coding access requirement without displaying remote details or losing the connected account controls',()=>{
  const f=fixture({descriptor:kimi,initial:{...empty(),region:'mainland-cn',runtime:{status:'ready'},session:{status:'connected',sharing:true,profileId:'signed-in-profile'},
    error:{code:'KIMI_SUBSCRIPTION_REQUIRED',message:'PRIVATE_REMOTE_URL https://example.invalid/?token=SECRET'}}});f.open();
  const expected='账号已登录，但当前订阅没有 Kimi Code 访问权限，请在官方账号中确认 Coding 套餐。';
  assert.equal(f.node('kimi-agent-login-message').textContent,expected);assert.equal(f.node('kimi-agent-login-message').hidden,false);
  assert.equal(f.node('kimi-agent-login-status').textContent,'Kimi Code 官方代理已连接');assert.equal(f.node('kimi-agent-sign-in').hidden,true);assert.equal(f.node('kimi-agent-models').disabled,false);
  assert.equal(f.api.errorMessage(new Error('[KIMI_SUBSCRIPTION_REQUIRED] PRIVATE_REMOTE_URL')),expected);assert.doesNotMatch(f.node('kimi-agent-login-message').textContent,/PRIVATE|SECRET|https:/);assert.equal(f.calls.length,0);
});

test('ZCode authorization URL and browser failures display only the matching fixed recovery guidance',()=>{
  for(const [code,expected]of [
    ['ZCODE_AUTH_URL_INVALID','官方代理返回的授权地址无效，请重试登录。'],
    ['ZCODE_BROWSER_OPEN_FAILED','无法打开官方授权页面，请检查默认浏览器后重试。'],
  ]){
    const f=fixture({descriptor:glm,initial:{...empty(),region:'bigmodel',runtime:{status:'ready'},error:{code,message:'PRIVATE_REMOTE https://bigmodel.cn/login?state=SECRET&redirect=PRIVATE_PATH'}}});f.open();
    assert.equal(f.node('glm-agent-login-message').textContent,expected);assert.equal(f.node('glm-agent-login-message').hidden,false);
    assert.equal(f.node('glm-agent-sign-in').hidden,false);assert.equal(f.node('glm-agent-sign-in').disabled,false);
    assert.equal(f.api.errorMessage(new Error(`Error invoking remote method: [${code}] PRIVATE_REMOTE https://host/?token=SECRET`)),expected);
    assert.doesNotMatch(f.node('glm-agent-login-message').textContent,/PRIVATE|SECRET|https:/);assert.equal(f.calls.length,0);
  }
});

test('GLM component preparation failures preserve signed-in account controls and show a safe recovery action',()=>{
  const f=fixture({descriptor:glm,initial:{...empty(),region:'bigmodel',runtime:{status:'missing'},session:{status:'connected',sharing:true,profileId:'retained-profile'},
    error:{code:'ZCODE_RUNTIME_MISSING',message:'PRIVATE_LOCAL_PATH'}}});f.open();
  assert.equal(f.node('glm-agent-login-status').textContent,'ZCode 官方代理已连接');
  assert.equal(f.node('glm-agent-sign-in').hidden,true);assert.equal(f.node('glm-agent-install').hidden,false);
  assert.match(f.node('glm-agent-login-message').textContent,/准备组件/);assert.doesNotMatch(f.node('glm-agent-login-message').textContent,/PRIVATE_LOCAL_PATH/);
});

test('GLM account resource failures are distinguished from rate limits without requesting another login',()=>{
  for(const [code,hint] of [['ZCODE_QUOTA_UNAVAILABLE','1113'],['ZCODE_PLAN_EXPIRED','到期'],['ZCODE_PLAN_LIMIT','用量'],['ZCODE_RATE_LIMITED','频率']]) {
    const f=fixture({descriptor:glm,initial:{...empty(),region:'bigmodel',runtime:{status:'ready'},session:{status:'connected',sharing:true,profileId:'retained-profile'},
      error:{code,message:'PRIVATE_AUTH_BODY https://host/?token=SECRET'}}});f.open();
    assert.match(f.node('glm-agent-login-message').textContent,new RegExp(hint,'u'));
    assert.doesNotMatch(f.node('glm-agent-login-message').textContent,/PRIVATE|SECRET|https:/u);
    assert.equal(f.node('glm-agent-login-status').textContent,'ZCode 官方代理已连接');
    assert.equal(f.node('glm-agent-sign-in').hidden,true);assert.equal(f.node('glm-agent-models').disabled,false);assert.equal(f.calls.length,0);
  }
});

test('empty official catalogs explain the upstream account directory while keeping their connections',()=>{
  for(const [descriptor,code,prefix,name]of [[undefined,'AGY_CATALOG_EMPTY','antigravity','Antigravity'],[glm,'ZCODE_CATALOG_EMPTY','glm-agent','ZCode']]){
    const expected=`${name} 已连接，但官方会话没有返回可选模型，请刷新目录或检查账号权限。`;
    const f=fixture({descriptor,initial:{...empty(),region:'bigmodel',runtime:{status:'ready'},session:{status:'connected',sharing:true,profileId:'connected-profile'},
      error:{code,message:'PRIVATE_MODELS_URL https://remote.invalid/?token=SECRET'}}});f.open();
    assert.equal(f.node(prefix+'-login-message').textContent,expected);assert.equal(f.node(prefix+'-login-status').textContent,name+' 官方代理已连接');
    assert.equal(f.node(prefix+'-models').disabled,false);assert.equal(f.node(prefix+'-sign-in').hidden,true);
    assert.equal(f.api.errorMessage(new Error(`[${code}] PRIVATE_MODELS_URL`)),expected);assert.equal(f.calls.length,0);
  }
});

test('only the Kimi public device flow can show a verified HTTPS URL and code; ZCode nonce URLs and unknown fields remain hidden',()=>{
  const attempt={phase:'waiting-browser',verificationUrl:'https://www.kimi.com/code',userCode:'ABCD-1234',accessToken:'PRIVATE_TOKEN'};
  const f=fixture({descriptor:kimi,initial:{...empty(),region:'mainland-cn',session:{status:'connecting'},attempt}});f.open();
  assert.equal(f.node('kimi-agent-verification').hidden,false);assert.equal(f.node('kimi-agent-verification-url').textContent,attempt.verificationUrl);assert.equal(f.node('kimi-agent-user-code').textContent,'ABCD-1234');
  f.update({...empty(),session:{status:'connecting'},attempt:{...attempt,verificationUrl:'https://kimi.com.attacker.invalid/PRIVATE',userCode:'<PRIVATE>'}});
  assert.equal(f.node('kimi-agent-verification').hidden,true);
  const g=fixture({descriptor:glm,initial:{...empty(),session:{status:'connecting'},attempt:{...attempt,verificationUrl:'https://bigmodel.cn/oauth?nonce=PRIVATE'}}});g.open();assert.equal(g.node('glm-agent-verification').hidden,true);
  f.update({...empty(),region:'global',runtime:{status:'error',error:{code:'KIMI_DOWNLOAD_FAILED',message:'PRIVATE_URL'}}});
  assert.match(f.node('kimi-agent-login-message').textContent,/下载失败/);assert.doesNotMatch(f.node('kimi-agent-login-message').textContent,/PRIVATE/);
});

test('runtime download reports measured bytes and indeterminate progress without implying login',async()=>{
  const install=deferred(),f=fixture({methods:{antigravityInstall:()=>install.promise}});f.open();const pending=f.node('antigravity-install').click();
  f.update({...empty(),runtime:{status:'downloading',download:{receivedBytes:1536,totalBytes:1048576}}});
  assert.equal(f.node('antigravity-download').hidden,false);assert.equal(f.node('antigravity-download-size').textContent,'1.5 KB / 1.0 MB');
  assert.equal(f.node('antigravity-download-progress').value,1536);assert.equal(f.node('antigravity-download-progress').max,1048576);
  f.update({...empty(),runtime:{status:'downloading',download:{receivedBytes:2048,totalBytes:null}}});assert.equal(f.node('antigravity-download-size').textContent,'2.0 KB / —');
  install.resolve({settings:{},antigravity:{...empty(),runtime:{status:'ready',version:'1.2.3'}}});await pending;
  assert.equal(f.node('antigravity-login-status').textContent,'官方代理已安装，尚未连接账号');assert.deepEqual(f.calls,['antigravityInstall']);
});

test('Google login rejects duplicate submissions and cancellation remains usable during installation or browser authorization',async()=>{
  const signIn=deferred(),f=fixture({methods:{antigravitySignIn:()=>signIn.promise,antigravityCancelSignIn:()=>{signIn.reject(new Error('[AGY_CANCELLED] PRIVATE'));return null;}}});f.open();
  const pending=f.node('antigravity-sign-in').click();await f.node('antigravity-sign-in').click();
  f.update({...empty(),runtime:{status:'downloading',download:{receivedBytes:0,totalBytes:null}}});
  assert.equal(f.node('antigravity-cancel-sign-in').hidden,false);assert.equal(f.node('antigravity-cancel-sign-in').disabled,false);
  f.update(empty());await f.node('antigravity-cancel-sign-in').click();await pending;
  assert.deepEqual(f.calls,['antigravitySignIn','antigravityCancelSignIn']);assert.equal(f.node('antigravity-login-message').hidden,true);
});

test('connected official agent refreshes the shared catalog and sanitized errors cannot expose OAuth URLs or runtime paths',async()=>{
  const f=fixture({initial:{...empty(),runtime:{status:'ready',version:'1.2.3'},session:{status:'connected',sharing:true,profileId:'safe-generation'}}});f.open();
  assert.equal(f.node('antigravity-sign-in').hidden,true);assert.equal(f.node('antigravity-models').disabled,false);await f.node('antigravity-models').click();assert.equal(f.refreshed(),1);
  assert.match(f.api.errorMessage(new Error("Error invoking remote method: [AGY_ACCESS_DENIED] PRIVATE_OAUTH?code=SECRET")),/账号.*访问/);
  assert.equal(f.api.errorMessage({code:'AGY_UNKNOWN',message:'PRIVATE_TOKEN_FILE'}),'官方代理操作未完成，请重试。');
  assert.match(f.api.errorMessage(new Error('[AGY_CALLBACK_FAILED] PRIVATE_CALLBACK_STATE')),/操作已停止/);
  f.update({...empty(),error:{code:'AGY_PROXY_FAILED',message:'PRIVATE_PROXY_PASSWORD'}});assert.doesNotMatch(f.node('antigravity-login-message').textContent,/PRIVATE/);
  assert.equal(f.api.formatBytes(-1),'—');assert.equal(f.api.formatBytes(1073741824),'1.0 GB');
});

test('destroying the official-agent form discards late account results and releases the mode listener',async()=>{
  const signIn=deferred(),f=fixture({methods:{antigravitySignIn:()=>signIn.promise}});f.open();const pending=f.node('antigravity-sign-in').click();f.ui.destroy();
  signIn.resolve({settings:{},antigravity:{...empty(),session:{status:'connected',sharing:true,profileId:'late'}}});await pending;
  assert.equal(f.applied.length,0);assert.equal(f.node('antigravity-login-panel').removed,true);assert.equal(f.node('gemini-auth-mode').events.has('change'),false);
});

test('official-agent drafts bind the current generation and hide API secrets while role dialogs cannot select the mode',()=>{
  const extract=name=>{const match=new RegExp(`(?:async )?function ${name}\\(`,'u').exec(appSource);const tail=appSource.slice(match.index),end=tail.slice(1).search(/\n(?:async )?function /u);return end<0?tail:tail.slice(0,end+1);};
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,{value:''});return nodes.get(id);};
  const state={settings:{provider:'gemini',authMode:'antigravity-agent',providers:{gemini:{hasKey:true,baseUrl:'https://unused.invalid'}}},
    antigravity:{runtime:{status:'ready'},session:{status:'connected',sharing:true,profileId:'generation-one'}}};
  const context=vm.createContext({appState:state,settingsRole:null,$:node,modelSettingsScope:()=>state,modelSettingsChatGPT:()=>({})});
  for(const name of ['currentAuthMode','selectedAuthMode','catalogIdentity','modelSettingsDraft','modelSettingsDraftSnapshot','savedConnectionReady'])vm.runInContext(extract(name),context);
  node('provider-select').value='gemini';node('gemini-auth-mode').value='antigravity-agent';node('api-key-input').value='PRIVATE_KEY';
  assert.equal(context.savedConnectionReady('gemini','antigravity-agent'),true);
  assert.equal(JSON.stringify(context.modelSettingsDraft()),JSON.stringify({provider:'gemini',authMode:'antigravity-agent'}));
  const snapshot=context.modelSettingsDraftSnapshot(),identity=context.catalogIdentity('gemini','antigravity-agent');assert.equal(snapshot.profileId,'generation-one');
  state.antigravity.runtime.version='2.0.0';assert.notEqual(context.catalogIdentity('gemini','antigravity-agent'),identity);
  assert.notEqual(context.modelSettingsDraftSnapshot().agentRuntime,snapshot.agentRuntime);
  state.antigravity.session.profileId='generation-two';assert.notEqual(context.catalogIdentity('gemini','antigravity-agent'),identity);
  assert.doesNotMatch(JSON.stringify(context.modelSettingsDraftSnapshot()),/PRIVATE_KEY|unused/);
  state.antigravity.runtime.status='missing';assert.equal(context.savedConnectionReady('gemini','antigravity-agent'),false);
  context.settingsRole='pet';assert.equal(context.selectedAuthMode(),'apiKey');
});
