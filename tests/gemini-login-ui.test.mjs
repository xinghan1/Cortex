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
function fixture({role=null,initial=disconnected(),methods={}}={}){
  const document={elements:new Map(),createElement(){return new Element(document);},getElementById(id){return this.elements.get(id);}};document.body=new Element(document);
  for(const id of ['openai-auth-mode-field','base-url-field','provider-select']){const node=new Element(document);node.id=id;document.body.append(node);}document.elements.get('provider-select').value='gemini';
  const context=vm.createContext({document});vm.runInContext(source,context);
  let scope={settings:{provider:'gemini'},gemini:initial},busy=false;const calls=[],invalidations=[],applied=[];
  const bridge={getState:async()=>scope};
  for(const name of ['geminiSignIn','geminiCancelSignIn','geminiDisconnect','geminiRetryStorage','roleGeminiSignIn','roleGeminiCancelSignIn','roleGeminiDisconnect','roleGeminiRetryStorage'])bridge[name]=(...args)=>{calls.push([name,plain(args)]);return methods[name]?methods[name](...args):scope;};
  let ui;ui=context.ForgeGeminiLogin.create({document,bridge,getScope:()=>scope,getRole:()=>role,isBusy:()=>busy,
    onState:next=>{applied.push(next);scope=next;ui.render();},onChange:()=>ui.render(),onInvalidate:value=>invalidations.push(value)});
  return{ui,calls,invalidations,applied,api:context.ForgeGeminiLogin,node:id=>document.elements.get(id),
    mode(){this.node('gemini-auth-mode').value='gemini-account';this.node('gemini-auth-mode').change();},
    update(value){scope={...scope,gemini:value};ui.render();},busy(value){busy=value;ui.render();}};
}

test('Google account mode uses bundled official Gemini CLI without paths, OAuth client IDs or automatic login',()=>{
  const f=fixture();assert.equal(f.node('gemini-auth-mode-field').hidden,false);assert.equal(f.node('gemini-login-panel').hidden,true);assert.equal(f.calls.length,0);
  f.mode();assert.equal(f.node('gemini-login-panel').hidden,false);assert.match(f.node('gemini-login-help').textContent,/官方 Gemini CLI 账号额度/);
  assert.equal(f.node('gemini-cli-path'),undefined);assert.equal(f.node('gemini-client-id'),undefined);assert.equal(f.calls.length,0);
  f.node('provider-select').value='deepseek';f.ui.render();assert.equal(f.node('gemini-login-panel').hidden,true);
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
