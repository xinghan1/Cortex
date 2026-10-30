import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source=await fs.readFile(new URL('../src/renderer/app.js',import.meta.url),'utf8');
const html=await fs.readFile(new URL('../src/renderer/index.html',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
function appFunction(name){const match=new RegExp(`(?:async )?function ${name}\\(`,'u').exec(source);assert.ok(match,name);const tail=source.slice(match.index),end=tail.slice(1).search(/\n(?:async )?function /u);return end<0?tail:tail.slice(0,end+1);}
function fixture(provider,role=null){
  const elements=new Map(),node=id=>{if(!elements.has(id))elements.set(id,{value:'',hidden:false,disabled:false,dataset:{},classList:{toggle(){}}});return elements.get(id);};
  const state={settings:{provider,model:'saved-main',providers:{kimi:{hasKey:true},glm:{hasKey:true}}},roleModels:Object.fromEntries(['subagent','approval','completion','sidebar','pet'].map(id=>[id,{enabled:true,settings:{provider,providers:{[provider]:{hasKey:false}}}}]))};
  const calls=[],notices=[],context=vm.createContext({window:{},appState:state,settingsRole:role,$:node,
    modelSettingsScope:()=>role?state.roleModels[role]:state,modelSettingsChatGPT:()=>({session:{}}),modelSettingsConfig:()=>role?state.roleModels[role].settings:state.settings,
    invalidateSettingsCatalog(){},renderChatGPTState(){},chatgptLocalError:'',notice:(...args)=>notices.push(args),
    bridge:{openProviderAccount:async arg=>calls.push(plain(arg))}});
  for(const name of ['currentAuthMode','selectedAuthMode','savedConnectionReady','catalogIdentity','modelSettingsDraft','modelSettingsDraftSnapshot','settingsCatalogMatches','syncAuthModeVisibility','fillProvider','openProviderAccount'])vm.runInContext(appFunction(name),context);
  node('provider-select').value=provider;
  return{state,context,node,calls,notices};
}

test('Kimi and GLM expose domestic API Key forms without compatible protocol or fake account modes',()=>{
  for(const [provider,url]of [['kimi','https://api.moonshot.cn/v1'],['glm','https://open.bigmodel.cn/api/paas/v4']]){
    const f=fixture(provider);assert.ok(html.includes(`<option value="${provider}">`));f.context.fillProvider(provider);f.context.syncAuthModeVisibility();
    assert.equal(f.node('base-url-input').value,url);assert.equal(f.node('api-key-field').hidden,false);assert.equal(f.node('api-protocol-field').hidden,true);
    assert.equal(f.node('provider-account-panel').hidden,false);assert.equal(f.context.selectedAuthMode(),'apiKey');
    assert.equal(f.context.currentAuthMode({provider,authMode:provider+'-account'}),'apiKey');
    f.node('api-key-input').value='key-'+provider;
    assert.deepEqual(plain(f.context.modelSettingsDraft()),{provider,authMode:'apiKey',baseUrl:url,apiKey:'key-'+provider});
    assert.equal(f.calls.length,0,'displaying a form must not open a browser or authorize an account');
  }
  assert.match(html,/控制台登录不会自动授权 Cortex/u);
});

test('international URLs stay explicit and opening official console never sends a key or mutates the draft',async()=>{
  for(const [provider,url]of [['kimi','https://api.moonshot.ai/v1'],['glm','https://api.z.ai/api/paas/v4']]){
    const f=fixture(provider);f.context.fillProvider(provider);f.node('base-url-input').value=url;f.node('api-key-input').value='SECRET_KEY';
    const before=plain(f.context.modelSettingsDraft());await f.context.openProviderAccount();
    assert.deepEqual(f.calls,[{provider,baseUrl:url}]);assert.deepEqual(plain(f.context.modelSettingsDraft()),before);
    assert.doesNotMatch(JSON.stringify(f.calls),/SECRET_KEY|apiKey|model/);
    f.node('provider-account-open').disabled=true;await f.context.openProviderAccount();assert.equal(f.calls.length,1);
  }
});

test('five role API keys remain independent and directory grants become stale on endpoint or key changes',()=>{
  for(const provider of ['kimi','glm'])for(const role of ['subagent','approval','completion','sidebar','pet']){
    const f=fixture(provider,role);f.node('api-key-input').value='old-secret';f.context.fillProvider(provider);
    assert.equal(f.node('api-key-input').value,'');assert.equal(f.node('key-status').textContent,'未配置');
    assert.equal(f.context.savedConnectionReady(provider,'apiKey',f.state.roleModels[role]),false);
    f.node('api-key-input').value=role+'-key';
    const draft=plain(f.context.modelSettingsDraftSnapshot());assert.equal(draft.role,role);assert.equal(draft.apiKey,role+'-key');
    f.context.settingsCatalog={selectionToken:'grant'};f.context.settingsCatalogDraft=draft;assert.equal(f.context.settingsCatalogMatches(),true);
    f.node('base-url-input').value='https://other.invalid/v1';assert.equal(f.context.settingsCatalogMatches(),false);
    f.node('base-url-input').value=draft.baseUrl;f.node('api-key-input').value='replacement';assert.equal(f.context.settingsCatalogMatches(),false);
  }
});

test('switching Kimi to GLM clears typed secrets and does not reuse the previous platform URL',()=>{
  const f=fixture('kimi');f.context.fillProvider('kimi');f.node('api-key-input').value='kimi-secret';
  f.context.fillProvider('glm');assert.equal(f.node('api-key-input').value,'');assert.equal(f.node('base-url-input').value,'https://open.bigmodel.cn/api/paas/v4');
  f.node('provider-select').value='deepseek';f.context.syncAuthModeVisibility();assert.equal(f.node('provider-account-panel').hidden,true);
});

test('Kimi and ZCode official-agent drafts contain only their own region and login generation, never API credentials',()=>{
  for(const [provider,authMode,key,controller,region,nextRegion]of [
    ['kimi','kimi-agent','kimiAgent','synoraKimiAgentLogin','mainland-cn','global'],
    ['glm','glm-agent','glmAgent','synoraGlmAgentLogin','bigmodel','zai'],
  ]){
    const f=fixture(provider);f.state.settings.authMode=authMode;f.state[key]={runtime:{status:'ready',version:'1.2.3'},region,session:{status:'connected',sharing:true,profileId:provider+'-login'}};
    let selectedRegion=region;f.context.window[controller]={getRegion:()=>selectedRegion,render(){}};
    f.node(provider+'-auth-mode').value=authMode;f.node('api-key-input').value='PRIVATE_API_KEY';f.node('base-url-input').value='https://PRIVATE_API_URL.invalid';
    assert.equal(f.context.currentAuthMode(f.state.settings),authMode);assert.equal(f.context.selectedAuthMode(),authMode);
    assert.equal(f.context.savedConnectionReady(provider,authMode,f.state),true);
    assert.deepEqual(plain(f.context.modelSettingsDraft()),{provider,authMode,region});
    f.context.syncAuthModeVisibility();assert.equal(f.node('api-key-field').hidden,true);assert.equal(f.node('provider-account-panel').hidden,true);
    const draft=plain(f.context.modelSettingsDraftSnapshot()),identity=f.context.catalogIdentity(provider,authMode,f.state);
    assert.equal(draft.profileId,provider+'-login');assert.doesNotMatch(JSON.stringify(draft),/PRIVATE_API/);
    f.context.settingsCatalog={selectionToken:'regional-grant'};f.context.settingsCatalogDraft=draft;assert.equal(f.context.settingsCatalogMatches(),true);
    selectedRegion=nextRegion;assert.equal(f.context.settingsCatalogMatches(),false);
    f.state[key].region=nextRegion;f.state[key].session.profileId='new-login';assert.notEqual(f.context.catalogIdentity(provider,authMode,f.state),identity);
    f.state[key].session.profileId=null;assert.equal(f.context.savedConnectionReady(provider,authMode,f.state),false);
  }
});

test('an official-agent primary cannot silently turn five inherited role forms into agent logins',()=>{
  for(const provider of ['kimi','glm'])for(const role of ['subagent','approval','completion','sidebar','pet']){
    const f=fixture(provider,role);f.node(provider+'-auth-mode').value=provider+'-agent';
    assert.equal(f.context.selectedAuthMode(),'apiKey');assert.equal(f.context.modelSettingsDraft().authMode,'apiKey');
  }
});
