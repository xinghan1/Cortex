import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../src/renderer/app.js',import.meta.url),'utf8');
const loginSource=await fs.readFile(new URL('../src/renderer/antigravity-login.js',import.meta.url),'utf8');
function appFunction(name){const found=new RegExp(`(?:async )?function ${name}\\(`,'u').exec(source);assert.ok(found,name);const tail=source.slice(found.index),end=tail.slice(1).search(/\n(?:async )?function /u);return end<0?tail:tail.slice(0,end+1);}
const plain=value=>JSON.parse(JSON.stringify(value));
function fixture({provider='gemini',authMode='antigravity-agent'}={}){
  const nodes=new Map(),node=id=>{
    if(!nodes.has(id))nodes.set(id,{value:'',open:false,hidden:false,disabled:false,children:[],textContent:'',append(...children){this.children.push(...children);},replaceChildren(){this.children=[];this.value='';}});
    return nodes.get(id);
  };
  let resolve,reject;const pending=new Promise((yes,no)=>{resolve=yes;reject=no;}),calls=[];
  const draft={provider,authMode,...(authMode==='apiKey'?{baseUrl:'https://fixture.invalid/v1beta',apiKey:'memory-only-fixture-key'}:{})};
  const snapshot={profileId:authMode==='apiKey'?'':'profile-a',role:null,sharing:authMode!=='apiKey'};
  const context=vm.createContext({window:{},$:node,settingsRole:null,settingsCatalogRequest:0,settingsCatalog:null,settingsCatalogDraft:null,
    settingsCatalogError:'',settingsCatalogLoading:false,settingsSaving:false,contextBusy:()=>false,isChatGPTBusy:()=>false,
    selectedAuthMode:()=>draft.authMode,modelSettingsDraft:()=>({...draft}),modelSettingsDraftSnapshot:()=>({...draft,...snapshot}),
    modelSettingsScope:()=>({}),savedConnectionReady:()=>true,settingsModelSelectable:model=>model.compatible!==false,
    modelSettingsAction:async(action,input)=>{calls.push({action,input:plain(input)});return pending;},errorText:error=>error.message,
    element:()=>({value:'',textContent:'',disabled:false}),refreshControlLocks:()=>{node('save-settings').disabled=!context.selectedSettingsModel();},
  });
  vm.runInContext(loginSource,context);context.window.ForgeAntigravityLogin=context.ForgeAntigravityLogin;
  for(const name of ['normalizeCatalog','invalidateSettingsCatalog','settingsCatalogMatches','selectedSettingsModel','renderSettingsCatalog','settingsCatalogErrorText','fetchSettingsCatalog'])vm.runInContext(appFunction(name),context);
  node('provider-select').value=provider;node('settings-dialog').open=true;
  const result={provider,authMode,models:[{id:'fixture-model',displayName:'Fixture',compatible:true}],selectionToken:'validated-model-grant',expiresAt:Date.now()+60000};
  return{context,node,draft,snapshot,calls,resolve,reject,result,start:()=>context.fetchSettingsCatalog(true)};
}

test('successful settings previews retain their exact connection grant and require a real model selection',async()=>{
  for(const authMode of ['apiKey','gemini-account','antigravity-agent']){
    const f=fixture({authMode}),running=f.start();assert.equal(f.context.settingsCatalogLoading,true);assert.equal(f.node('save-settings').disabled,true);
    f.resolve(f.result);await running;assert.equal(f.context.settingsCatalog.selectionToken,'validated-model-grant');
    assert.equal(f.context.settingsCatalogLoading,false);assert.equal(f.context.settingsCatalogError,'');assert.equal(f.node('save-settings').disabled,true);
    f.node('chatgpt-model-select').value='fixture-model';assert.equal(f.context.selectedSettingsModel().id,'fixture-model');
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].action,'preview');assert.deepEqual(f.calls[0].input,f.draft);
  }
});

test('late success and failure cannot publish a catalog or an old account error after a draft or account changes',async()=>{
  for(const outcome of ['success','failure'])for(const changed of ['profile','provider','key','role','new-snapshot-field']){
    const f=fixture(),running=f.start();
    if(changed==='profile')f.snapshot.profileId='profile-b';
    if(changed==='provider'){f.draft.provider='glm';f.draft.authMode='glm-agent';}
    if(changed==='key')f.draft.apiKey='replacement-memory-key';
    if(changed==='role')f.snapshot.role='sidebar';
    if(changed==='new-snapshot-field')f.snapshot.agentRuntime='new-runtime-generation';
    if(outcome==='failure')f.reject(new Error('OLD_ACCOUNT_FAILURE_SHOULD_NOT_BE_DISPLAYED'));else f.resolve(f.result);
    await running;assert.equal(f.context.settingsCatalog,null,changed+' '+outcome);assert.equal(f.context.settingsCatalogError,'',changed+' '+outcome);
    assert.equal(f.context.settingsCatalogLoading,false);assert.equal(f.node('save-settings').disabled,true);
    assert.doesNotMatch(f.node('settings-model-catalog-message').textContent,/OLD_ACCOUNT/);
  }
});

test('closed settings ignore a late account directory result or error without creating a usable model token',async()=>{
  for(const outcome of ['success','failure']){
    const f=fixture(),running=f.start();f.node('settings-dialog').open=false;
    if(outcome==='success')f.resolve(f.result);else f.reject(new Error('CLOSED_DIALOG_FAILURE'));
    await running;assert.equal(f.context.settingsCatalog,null);assert.equal(f.context.settingsCatalogError,'');assert.equal(f.node('save-settings').disabled,true);
  }
});

test('an empty upstream preview failure leaves no catalog or token while showing the concrete safe account explanation',async()=>{
  const f=fixture(),running=f.start();const message='[AGY_CATALOG_EMPTY] Antigravity 已连接，但官方会话没有返回可选模型，请刷新目录或检查账号权限。';
  f.reject(new Error(message));await running;
  assert.equal(f.context.settingsCatalog,null);assert.equal(f.context.settingsCatalogDraft,null);assert.equal(f.context.selectedSettingsModel(),undefined);
  assert.equal(f.node('save-settings').disabled,true);assert.equal(f.context.settingsCatalogLoading,false);assert.equal(f.node('settings-model-catalog-message').textContent,message.replace('[AGY_CATALOG_EMPTY] ',''));
});

test('IPC-wrapped Antigravity and ZCode empty directory codes show only the fixed account explanation',async()=>{
  for(const [provider,authMode,code,name]of [['gemini','antigravity-agent','AGY_CATALOG_EMPTY','Antigravity'],['glm','glm-agent','ZCODE_CATALOG_EMPTY','ZCode']]){
    const f=fixture({provider,authMode});
    if(provider==='glm')f.context.modelSettingsScope=()=>({glmAgent:{region:undefined}});
    const running=f.start();f.reject(new Error(`Error invoking remote method 'forge:previewModelCatalog': ${provider==='glm'?'SettingsCatalogError':'AntigravityError'}: [${code}] PRIVATE_MODELS_URL https://remote.invalid/?token=SECRET`));await running;
    assert.equal(f.node('settings-model-catalog-message').textContent,`${name} 已连接，但官方会话没有返回可选模型，请刷新目录或检查账号权限。`);
    assert.doesNotMatch(f.context.settingsCatalogError,/Error|CATALOG|PRIVATE|SECRET|https:/);assert.equal(f.node('save-settings').disabled,true);
  }
});

test('structured empty codes are sanitized while unrelated catalog failures retain their original actionable detail',async()=>{
  const f=fixture();let running=f.start();f.reject(Object.assign(new Error('PRIVATE_REMOTE_DETAIL'),{code:'AGY_CATALOG_EMPTY'}));await running;
  assert.equal(f.context.settingsCatalogError,'Antigravity 已连接，但官方会话没有返回可选模型，请刷新目录或检查账号权限。');
  const other=fixture();running=other.start();const message='Error invoking remote method: 当前凭据无权读取此目录，请确认 API Key。';
  other.reject(Object.assign(new Error(message),{code:'CATALOG_HTTP_403'}));await running;assert.equal(other.context.settingsCatalogError,message);
});
