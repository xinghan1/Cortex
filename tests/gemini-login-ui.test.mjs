import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../src/renderer/gemini-login.js',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
class Element {
  constructor(document){Object.assign(this,{document,children:[],events:new Map(),attributes:{},value:'',textContent:'',hidden:false,disabled:false});}
  set id(value){this._id=value;if(value)this.document.elements.set(value,this);}get id(){return this._id;}
  set innerHTML(_){throw new Error('Account data must remain text-only');}
  append(...nodes){this.children.push(...nodes);}after(...nodes){this.document.body.append(...nodes);}before(...nodes){this.document.body.append(...nodes);}
  setAttribute(name,value){this.attributes[name]=String(value);}addEventListener(type,fn){this.events.set(type,fn);}removeEventListener(type,fn){if(this.events.get(type)===fn)this.events.delete(type);}
  click(){if(!this.disabled)return this.events.get('click')?.();}change(){return this.events.get('change')?.();}remove(){this.removed=true;}
}
const disconnected=()=>({session:{status:'disconnected',sharing:false,profileId:null},attempt:null,error:null,cli:{available:true,version:'0.65.0'}});
const connected=id=>({...disconnected(),session:{status:'connected',sharing:true,profileId:id}});
function fixture({role=null,initial=disconnected(),methods={},settings={provider:'gemini'},onModeChange=()=>{}}={}){
  const document={elements:new Map(),createElement(){return new Element(document);},getElementById(id){return this.elements.get(id);}};document.body=new Element(document);
  for(const id of ['openai-auth-mode-field','base-url-field','provider-select']){const node=new Element(document);node.id=id;document.body.append(node);}document.elements.get('provider-select').value='gemini';
  const context=vm.createContext({document});vm.runInContext(source,context);
  let scope={settings,gemini:initial},busy=false;const calls=[],invalidations=[],applied=[],modeChanges=[];
  const bridge={getState:async()=>scope};
  for(const name of ['geminiSignIn','geminiCancelSignIn','geminiDisconnect','geminiRetryStorage','roleGeminiSignIn','roleGeminiCancelSignIn','roleGeminiDisconnect','roleGeminiRetryStorage'])bridge[name]=(...args)=>{calls.push([name,plain(args)]);return methods[name]?methods[name](...args):scope;};
  let ui;ui=context.ForgeGeminiLogin.create({document,bridge,getScope:()=>scope,getRole:()=>role,isBusy:()=>busy,
    onState:next=>{applied.push(next);scope=next;ui.render();},onChange:()=>ui.render(),onInvalidate:value=>invalidations.push(value),
    onModeChange:()=>{modeChanges.push(document.elements.get('gemini-auth-mode').value);onModeChange();}});
  return{ui,calls,invalidations,applied,modeChanges,api:context.ForgeGeminiLogin,node:id=>document.elements.get(id),
    // Exercise retained legacy controller diagnostics without advertising a
    // selectable legacy option in the actual account form.
    mode(){this.node('gemini-auth-mode').value='gemini-account';this.node('gemini-auth-mode').change();},
    update(value){scope={...scope,gemini:value};ui.render();},busy(value){busy=value;ui.render();}};
}

test('Google connection selector offers API Key and Antigravity without the retired Gemini CLI entry or automatic login',()=>{
  const f=fixture();assert.equal(f.node('gemini-auth-mode-field').hidden,false);assert.equal(f.node('gemini-login-panel').hidden,true);assert.equal(f.calls.length,0);
  const options=f.node('gemini-auth-mode').children;
  assert.deepEqual(options.map(option=>option.value),['apiKey','antigravity-agent']);
  assert.ok(options.every(option=>!option.textContent.includes('旧 Gemini CLI')));
  assert.equal(f.node('gemini-cli-path'),undefined);assert.equal(f.node('gemini-client-id'),undefined);assert.equal(f.calls.length,0);
  f.node('provider-select').value='deepseek';f.ui.render();assert.equal(f.node('gemini-login-panel').hidden,true);
});

test('opening a saved legacy account uses an API draft without mutating settings or reusing Google credentials',()=>{
  for(const role of [null,'subagent','approval','completion','sidebar','pet']){
    const settings=Object.freeze({provider:'gemini',authMode:'gemini-account',model:'saved-model',hasApiKey:true});
    const f=fixture({role,settings,initial:connected('saved-legacy-profile')});
    f.ui.fill('gemini-account');
    assert.equal(f.node('gemini-auth-mode').value,'apiKey');assert.equal(f.node('gemini-login-panel').hidden,true);
    assert.equal(f.calls.length,0);assert.equal(f.invalidations.length,0);assert.equal(f.modeChanges.length,0);
    assert.deepEqual(settings,{provider:'gemini',authMode:'gemini-account',model:'saved-model',hasApiKey:true});
    f.ui.fill('antigravity-agent');assert.equal(f.node('gemini-auth-mode').value,role==null?'antigravity-agent':'apiKey');
    f.ui.fill('apiKey');assert.equal(f.node('gemini-auth-mode').value,'apiKey');assert.equal(f.calls.length,0);
  }
});

test('login duplicate prevention leaves native cancellation available while the official browser grants access',async()=>{
  const login=deferred(),f=fixture({methods:{geminiSignIn:()=>login.promise}});f.mode();
  const pending=f.node('gemini-login-sign-in').click();await f.node('gemini-login-sign-in').click();
  assert.equal(f.calls.filter(([method])=>method==='geminiSignIn').length,1);assert.equal(f.node('gemini-login-cancel').hidden,false);assert.equal(f.node('gemini-login-cancel').disabled,false);
  await f.node('gemini-login-cancel').click();assert.equal(f.calls.at(-1)[0],'geminiCancelSignIn');
  login.resolve({settings:{},gemini:connected('new-main-login')});await pending;
  assert.equal(f.node('gemini-login-status').textContent,'Google 账号已连接');assert.equal(f.node('gemini-login-models').disabled,false);
});

test('all five role account actions use only their own bridge and invalidation scope',async()=>{
  for(const role of ['subagent','approval','completion','sidebar','pet']){
    const f=fixture({role,initial:connected(role)});f.mode();await f.node('gemini-login-disconnect').click();
    assert.deepEqual(f.calls[0],['roleGeminiDisconnect',[{role}]]);assert.equal(f.invalidations[0],role);
    f.update({...disconnected(),cli:{available:false,version:null}});await f.node('gemini-login-retry').click();
    assert.deepEqual(f.calls.at(-1),['roleGeminiRetryStorage',[{role}]]);
    f.update(disconnected());await f.node('gemini-login-sign-in').click();assert.deepEqual(f.calls.at(-1),['roleGeminiSignIn',[{role}]]);
    assert.ok(f.calls.every(([method])=>method.startsWith('roleGemini')));
  }
});

test('missing bundled CLI cannot pretend to log in and sanitized errors never display process text or credentials',async()=>{
  const f=fixture({initial:{...disconnected(),cli:{available:false,version:null},error:{code:'GEMINI_CLI_UNAVAILABLE',message:'PRIVATE_TOKEN_STACK'}}});f.mode();
  assert.equal(f.node('gemini-login-sign-in').disabled,true);await f.node('gemini-login-sign-in').click();assert.equal(f.calls.length,0);
  assert.equal(f.node('gemini-login-retry').hidden,false);assert.equal(f.node('gemini-login-retry').textContent,'重新检测');assert.doesNotMatch(f.node('gemini-login-message').textContent,/PRIVATE_TOKEN_STACK/);
  assert.equal(f.api.errorMessage({code:'GEMINI_UNKNOWN',message:'SECRET_PROCESS_OUTPUT'}),'Google 账号连接未完成，请重试。');
  f.update({...disconnected(),session:{status:'connecting',sharing:false},attempt:{phase:'waiting-browser'}});
  assert.equal(f.node('gemini-login-status').textContent,'等待 Google 浏览器授权');assert.equal(f.node('gemini-login-models').disabled,true);
});

test('destroying the account form releases its nodes and discards late authorization results',async()=>{
  const login=deferred(),f=fixture({methods:{geminiSignIn:()=>login.promise}});f.mode();const pending=f.node('gemini-login-sign-in').click();
  f.ui.destroy();login.resolve({settings:{},gemini:connected('late')});await pending;
  assert.equal(f.applied.length,0);assert.equal(f.node('gemini-login-panel').removed,true);assert.equal(f.node('gemini-auth-mode-field').removed,true);
});

test('a user cancellation does not turn an IPC AbortError into a misleading login failure',async()=>{
  const login=deferred(),f=fixture({methods:{geminiSignIn:()=>login.promise,geminiCancelSignIn:()=>{login.reject(new Error('Remote AbortError: cancelled'));return {settings:{},gemini:disconnected()};}}});
  f.mode();const pending=f.node('gemini-login-sign-in').click();await f.node('gemini-login-cancel').click();await pending;
  assert.equal(f.node('gemini-login-message').hidden,true);assert.equal(f.ui.isBusy(),false);
});

test('Electron invoke wrappers retain a safe diagnostic when only the bracketed Gemini code survives',()=>{
  const f=fixture();
  for(const [code,expected]of [
    ['GEMINI_CLI_REQUEST_FAILED','账号服务请求失败'],['GEMINI_CLI_EXITED','组件意外退出'],
    ['GEMINI_INVALID_RESPONSE','数据格式无效'],['GEMINI_PROXY_FAILED','网络代理'],['GEMINI_SIGN_IN_FAILED','登录未完成'],
    ['GEMINI_AUTH_FAILED','账号服务验证'],['GEMINI_SESSION_FAILED','会话创建失败'],
    ['GEMINI_ACCOUNT_VALIDATION_REQUIRED','额外验证'],['GEMINI_SERVICE_UNAVAILABLE','初始化未返回有效结果'],
    ['GEMINI_ACCOUNT_ACTION_REQUIRED','账号条款确认'],['GEMINI_QUOTA_EXCEEDED','额度不足'],
  ]){
    const wrapped=new Error(`Error invoking remote method 'forge:geminiSignIn': GeminiConnectionError: [${code}] PRIVATE_OAUTH_URL?code=SECRET_AUTHORIZATION_CODE`);
    const text=f.api.errorMessage(wrapped);assert.ok(text.includes(expected));assert.doesNotMatch(text,/PRIVATE|SECRET|forge:|GeminiConnectionError|\[GEMINI_/);
  }
  assert.equal(f.api.errorMessage(new Error("Error invoking remote method 'forge:geminiSignIn': [GEMINI_CANCELLED] SECRET")),'');
});

test('structured post-browser phase takes precedence over a generic IPC failure without displaying OAuth or CLI output',async()=>{
  const f=fixture({methods:{geminiSignIn:async()=>{f.update({...disconnected(),error:{code:'GEMINI_CLI_REQUEST_FAILED',phase:'session-new',message:'RAW_GOOGLE_ACCESS_TOKEN'}});throw new Error('Remote error with no surviving code OAUTH_SECRET');}}});
  f.mode();await f.node('gemini-login-sign-in').click();
  assert.match(f.node('gemini-login-message').textContent,/建立账号会话失败：.*账号服务请求失败/);
  assert.doesNotMatch(f.node('gemini-login-message').textContent,/RAW_GOOGLE|OAUTH_SECRET/);
  f.update({...disconnected(),error:{code:'GEMINI_INVALID_RESPONSE',phase:'model-list',message:'PRIVATE_CLI_STDERR'}});
  assert.match(f.node('gemini-login-message').textContent,/读取模型目录失败：.*数据格式无效/);
});

test('only allowed diagnostic phases are displayed and unknown encoded errors remain generic',()=>{
  const f=fixture();
  assert.match(f.api.errorMessage({code:'GEMINI_PROXY_FAILED',phase:'initialize',message:'PRIVATE'}),/^初始化登录组件失败：/);
  assert.match(f.api.errorMessage({code:'GEMINI_STORAGE_UNREADABLE',phase:'storage',message:'SECRET_PATH'}),/^保存连接失败：/);
  assert.match(f.api.errorMessage({code:'GEMINI_QUOTA_EXCEEDED',phase:'prompt',message:'PRIVATE_ACCOUNT'}),/^发送模型请求失败：.*额度不足/);
  assert.doesNotMatch(f.api.errorMessage({code:'GEMINI_SIGN_IN_FAILED',phase:'https://accounts.google.com/?code=SECRET',message:'PRIVATE'}),/SECRET|accounts|PRIVATE/);
  assert.equal(f.api.errorMessage(new Error('[GEMINI_FUTURE_UNKNOWN] PRIVATE_OAUTH_RESPONSE')),'Google 账号连接未完成，请重试。');
  f.update({...disconnected(),session:{status:'connecting',sharing:false},attempt:{phase:'session-new'}});
  assert.equal(f.node('gemini-login-status').textContent,'正在建立账号会话…');
  f.update({...disconnected(),session:{status:'connecting',sharing:false},attempt:{phase:'model-list'}});
  assert.equal(f.node('gemini-login-status').textContent,'正在读取账号模型目录…');
});

test('a model-list error after successful Google authorization preserves the connected state and refresh controls',()=>{
  const f=fixture({initial:{...connected('authorized-profile'),error:{code:'GEMINI_SESSION_FAILED',phase:'model-list',message:'PRIVATE_ACCOUNT_URL'}}});f.mode();
  assert.equal(f.node('gemini-login-status').textContent,'Google 账号已连接');
  assert.equal(f.node('gemini-login-models').disabled,false);
  assert.equal(f.node('gemini-login-disconnect').hidden,false);
  assert.match(f.node('gemini-login-message').textContent,/读取模型目录失败：.*刷新模型目录/);
  assert.doesNotMatch(f.node('gemini-login-message').textContent,/PRIVATE_ACCOUNT_URL/);
});

test('every currently emitted Gemini account failure code has a local diagnostic rather than raw process details',async()=>{
  const core=await fs.readFile(new URL('../src/core/gemini-login.mjs',import.meta.url),'utf8'),f=fixture();
  const codes=new Set([...core.matchAll(/failure\('(GEMINI_[A-Z_]+)'/gu)].map(match=>match[1]));assert.ok(codes.size>=20);
  for(const code of codes){
    const text=f.api.errorMessage(new Error(`Error invoking remote method: [${code}] PRIVATE_STDERR_TOKEN`));
    assert.notEqual(text,'Google 账号连接未完成，请重试。',code);assert.doesNotMatch(text,/PRIVATE_STDERR_TOKEN/);
  }
});

test('retired personal Gemini CLI service explains the real cause and offers an explicit API Key mode change without mutating saved settings',()=>{
  for(const role of [null,'subagent','approval','completion','sidebar','pet']){
    const settings=Object.freeze({provider:'gemini',authMode:'gemini-account',model:'saved-model',hasApiKey:true});
    let invalidated=0;
    const f=fixture({role,settings,onModeChange:()=>{invalidated++;},initial:{...disconnected(),error:{code:'GEMINI_CLIENT_UNSUPPORTED',phase:'authenticate',message:'PRIVATE_ACCOUNT_URL'}}});
    f.mode();const before=invalidated;
    assert.equal(f.node('gemini-auth-mode').value,'gemini-account','no automatic fallback');
    assert.equal(f.node('gemini-login-use-api-key').hidden,false);
    assert.match(f.node('gemini-login-message').textContent,/个人.*Google AI Pro\/Ultra.*旧 Gemini CLI 服务/);
    assert.doesNotMatch(f.node('gemini-login-message').textContent,/PRIVATE_ACCOUNT_URL|网络.*重试|当前地区/);
    assert.equal(f.node('gemini-login-sign-in').disabled,false,'enterprise login remains available');
    f.node('gemini-login-use-api-key').click();
    assert.equal(f.node('gemini-auth-mode').value,'apiKey');
    assert.equal(f.node('gemini-login-panel').hidden,true);
    assert.equal(f.node('gemini-login-use-api-key').hidden,true);
    assert.equal(invalidated,before+1);assert.equal(f.modeChanges.at(-1),'apiKey');
    assert.deepEqual(settings,{provider:'gemini',authMode:'gemini-account',model:'saved-model',hasApiKey:true});
    assert.equal(f.calls.length,0,'mode switch never logs in, disconnects, opens a browser or saves configuration');
  }
});

test('API Key action is restricted to unsupported-client errors and remains disabled during an active login',async()=>{
  for(const code of ['GEMINI_ACCESS_DENIED','GEMINI_REGION_UNAVAILABLE','GEMINI_AUTH_FAILED']){
    const f=fixture({initial:{...disconnected(),error:{code,message:'PRIVATE_SERVER_TEXT'}}});f.mode();
    assert.equal(f.node('gemini-login-use-api-key').hidden,true);assert.doesNotMatch(f.node('gemini-login-message').textContent,/PRIVATE_SERVER_TEXT/);
  }
  const pending=deferred(),f=fixture({methods:{geminiSignIn:()=>pending.promise}});f.mode();
  const signIn=f.node('gemini-login-sign-in').click();
  f.update({...disconnected(),session:{status:'connecting',sharing:false},error:{code:'GEMINI_CLIENT_UNSUPPORTED'}});
  assert.equal(f.node('gemini-login-use-api-key').disabled,true);f.node('gemini-login-use-api-key').click();
  assert.equal(f.node('gemini-auth-mode').value,'gemini-account');
  f.update(disconnected());pending.reject(new Error("Error invoking remote method 'forge:geminiSignIn': [GEMINI_CLIENT_UNSUPPORTED] PRIVATE"));await signIn;
  assert.equal(f.node('gemini-login-use-api-key').hidden,false);assert.equal(f.node('gemini-login-use-api-key').disabled,false);
  assert.match(f.node('gemini-login-message').textContent,/官方 Antigravity/);
});

test('Google mode selector offers the complete official agent only to the main model',()=>{
  const f=fixture();const options=f.node('gemini-auth-mode').children;
  assert.deepEqual(options.map(option=>option.value),['apiKey','antigravity-agent']);
  f.ui.fill('antigravity-agent');assert.equal(f.node('gemini-auth-mode').value,'antigravity-agent');assert.equal(f.node('gemini-login-panel').hidden,true);
  for(const role of ['subagent','approval','completion','sidebar','pet']){
    const r=fixture({role});r.ui.fill('antigravity-agent');assert.equal(r.node('gemini-auth-mode').value,'apiKey');
    assert.equal(r.node('gemini-auth-mode').children.find(option=>option.value==='antigravity-agent').disabled,true);
  }
});
