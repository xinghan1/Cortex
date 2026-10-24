import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const appSource = await fs.readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const html = await fs.readFile(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
const roleSource = await fs.readFile(new URL('../src/renderer/role-models.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function appFunction(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`, 'u').exec(appSource); assert.ok(match, name);
  const tail = appSource.slice(match.index), end = tail.slice(1).search(/\n(?:async )?function /u);
  return end < 0 ? tail : tail.slice(0, end + 1);
}
function fixture(role = null) {
  const elements = new Map();
  const node = id => {
    if (!elements.has(id)) elements.set(id, { value: '', hidden: false, disabled: false, textContent: '', dataset: {}, classList: { toggle() {} } });
    return elements.get(id);
  };
  const state = { settings: { provider: 'gemini', model: 'gemini-main', authMode: 'apiKey', providers: { gemini: { hasKey: true, baseUrl: 'https://generativelanguage.googleapis.com/v1beta' } } },
    roleModels: Object.fromEntries(['subagent','approval','completion','sidebar','pet'].map(id => [id, { enabled: true, settings: { provider: 'gemini', model: 'gemini-'+id, providers: { gemini: { hasKey: false } } } }])) };
  const context = vm.createContext({ window: {}, appState: state, settingsRole: role, $: node,
    modelSettingsScope: () => role ? state.roleModels[role] : state, modelSettingsChatGPT: () => ({ session: {} }),
    modelSettingsConfig: () => (role ? state.roleModels[role] : state).settings,
    invalidateSettingsCatalog() {}, renderChatGPTState() {}, chatgptLocalError: '',
  });
  for (const name of ['currentAuthMode','selectedAuthMode','savedConnectionReady','catalogIdentity','activeCatalogIdentity','modelSettingsDraft','modelSettingsDraftSnapshot','settingsCatalogMatches','syncAuthModeVisibility','fillProvider']) vm.runInContext(appFunction(name), context);
  node('provider-select').value = 'gemini';node('api-protocol-select').value = 'responses';
  return { context, state, node };
}

test('Gemini is listed as a first-class provider and does not inherit OpenAI thinking levels', () => {
  assert.match(html, /<option value="gemini">Google · Gemini<\/option>/u);
  assert.match(appSource, /gemini:\s*\[\]/u);
  const roles = vm.createContext({});vm.runInContext(roleSource, roles);
  assert.deepEqual(plain(roles.ForgeRoleModels.roles.map(role => role.id)), ['subagent','approval','completion','sidebar','pet']);
});

test('Gemini API key settings use the native default URL, hide compatible protocols, and never send an OpenAI protocol', () => {
  const f = fixture();f.context.fillProvider('gemini');f.context.syncAuthModeVisibility();
  assert.equal(f.node('base-url-input').value, 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(f.node('api-protocol-field').hidden, true);assert.equal(f.node('openai-auth-mode-field').hidden, true);
  assert.equal(f.node('settings-footer-hint').textContent, 'Gemini 原生接口');assert.equal(f.node('api-key-field').hidden, false);
  f.node('api-key-input').value='isolated-gemini-key';
  assert.deepEqual(plain(f.context.modelSettingsDraft()), {provider:'gemini',authMode:'apiKey',baseUrl:'https://generativelanguage.googleapis.com/v1beta',apiKey:'isolated-gemini-key'});
  assert.equal(f.context.savedConnectionReady('gemini','apiKey'),true);
});

test('all five independent roles reuse Gemini settings without inheriting the main saved key or another role', () => {
  for (const role of ['subagent','approval','completion','sidebar','pet']) {
    const f=fixture(role);f.node('api-key-input').value='old-key-draft';f.context.fillProvider('gemini');
    assert.equal(f.node('api-key-input').value,'');assert.equal(f.node('key-status').textContent,'未配置');
    f.node('api-key-input').value='key-'+role;
    const draft=plain(f.context.modelSettingsDraftSnapshot());
    assert.equal(draft.role,role);assert.equal(draft.provider,'gemini');assert.equal(draft.apiKey,'key-'+role);
    assert.equal(Object.hasOwn(draft,'apiProtocol'),false);assert.equal(draft.profileId,'');
  }
});

test('Google account drafts omit typed keys and endpoints and bind all role catalog grants to their own login generation', () => {
  for (const role of [null,'subagent','approval','completion','sidebar','pet']) {
    const f=fixture(role),scope=role?f.state.roleModels[role]:f.state;
    scope.settings.authMode='gemini-account';scope.gemini={session:{status:'connected',sharing:true,profileId:role||'main-generation'}};
    f.node('gemini-auth-mode').value='gemini-account';f.node('base-url-input').value='https://untrusted.invalid';f.node('api-key-input').value='NEVER_SEND_THIS_KEY';
    assert.equal(f.context.currentAuthMode(scope.settings),'gemini-account');assert.equal(f.context.savedConnectionReady('gemini','gemini-account',scope),true);
    assert.deepEqual(plain(f.context.modelSettingsDraft()),{provider:'gemini',authMode:'gemini-account'});
    const snapshot=plain(f.context.modelSettingsDraftSnapshot());assert.equal(snapshot.profileId,role||'main-generation');
    f.context.settingsCatalog={selectionToken:'catalog-grant',models:[]};f.context.settingsCatalogDraft=snapshot;assert.equal(f.context.settingsCatalogMatches(),true);
    const identity=f.context.catalogIdentity('gemini','gemini-account',scope);scope.gemini.session.profileId='new-login-generation';
    assert.equal(f.context.settingsCatalogMatches(),false);assert.notEqual(f.context.catalogIdentity('gemini','gemini-account',scope),identity);
    f.context.syncAuthModeVisibility();assert.equal(f.node('api-key-field').hidden,true);assert.equal(f.node('base-url-field').hidden,true);
    assert.doesNotMatch(JSON.stringify(f.context.modelSettingsDraftSnapshot()),/NEVER_SEND_THIS_KEY|untrusted/);
  }
});

test('Gemini main and independent completion account changes invalidate the real Tab context without exposing credentials',()=>{
  const match=appSource.match(/getContext:\s*(\(\) => appState\?\.workspace[\s\S]+?\}\s*: null),\s*request: args => bridge\.completePrompt/u);assert.ok(match);
  const f=fixture(),c=f.context;f.state.workspace={root:'D:/disposable-fixture'};f.state.settings.authMode='gemini-account';
  f.state.gemini={session:{status:'connected',sharing:true,profileId:'main-generation'}};
  f.state.roleModels.completion={enabled:true,settings:{provider:'gemini',authMode:'gemini-account',model:'gemini-completion'},gemini:{session:{status:'connected',sharing:true,profileId:'completion-generation'}}};
  Object.assign(c,{sessionId:'session',projectSwitching:false,promptSubmitting:false,modelSaving:false,settingsSaving:false,isChatGPTBusy:()=>false,
    approvals:new Set(),currentWorkspaceId:()=> 'workspace',currentCatalogKey:''});
  const getContext=vm.runInContext(`(${match[1]})`,c),first=plain(getContext());
  f.state.gemini.session.profileId='new-main-generation';assert.notEqual(first.account,getContext().account);
  f.state.roleModels.completion.gemini.session.profileId='new-completion-generation';assert.notEqual(first.completionConnection,getContext().completionConnection);
  assert.doesNotMatch(JSON.stringify(getContext()),/apiKey|accessToken|refreshToken/);
});
