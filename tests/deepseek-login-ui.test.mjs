import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/deepseek-login.js', import.meta.url), 'utf8');
const appSource = await fs.readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((pass, fail) => { resolve = pass; reject = fail; }); return { promise, resolve, reject }; };
class Element {
  constructor(tag, document) { this.tag = tag; this.document = document; this.children = []; this.listeners = new Map(); this.attributes = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.dataset = {}; this.classList = { toggle() {} }; }
  set id(value) { this._id = value; if (value) this.document.elements.set(value, this); }
  get id() { return this._id; }
  set innerHTML(_) { throw new Error('Account state cannot be interpreted as HTML'); }
  append(...nodes) { this.children.push(...nodes); }
  after(...nodes) { this.document.body.append(...nodes); }
  before(...nodes) { this.document.body.append(...nodes); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  removeEventListener(type, callback) { if (this.listeners.get(type) === callback) this.listeners.delete(type); }
  remove() { this.removed = true; }
  click() { if (!this.disabled) return this.listeners.get('click')?.(); }
  change() { if (!this.disabled) return this.listeners.get('change')?.(); }
}
const account = overrides => ({ session: { status: 'disconnected', sharing: false, profileId: null }, attempt: null, error: null, storageRecovery: false, models: [], ...overrides });
const connected = profileId => account({ session: { status: 'connected', sharing: true, profileId, identity: { name: '测试 <script>', contact: 'account@example.invalid' } } });
function fixture({ role = null, initial = account(), methods = {} } = {}) {
  const document = { elements: new Map(), createElement(tag) { return new Element(tag, document); }, getElementById(id) { return this.elements.get(id); } };
  document.body = new Element('body', document);
  for (const id of ['openai-auth-mode-field', 'base-url-field', 'provider-select']) { const node = new Element('div', document); node.id = id; document.body.append(node); }
  document.elements.get('provider-select').value = 'deepseek';
  const context = vm.createContext({ document }); vm.runInContext(source, context);
  let scope = { settings: { provider: 'deepseek' }, deepseek: initial }, busy = false, modeChanges = 0, refreshes = 0;
  const calls = [], invalidations = [], changes = [];
  const bridge = { getState: async () => scope };
  for (const name of ['deepseekSignIn', 'deepseekCancelSignIn', 'deepseekDisconnect', 'deepseekRetryStorage', 'roleDeepseekSignIn', 'roleDeepseekCancelSignIn', 'roleDeepseekDisconnect', 'roleDeepseekRetryStorage'])
    bridge[name] = (...args) => { calls.push([name, plain(args)]); return methods[name] ? methods[name](...args) : scope; };
  let ui;
  ui = context.ForgeDeepSeekLogin.create({ document, bridge, getScope: () => scope, getRole: () => role, isBusy: () => busy,
    onState: next => { scope = next; ui.render(); }, onChange: () => { changes.push(true); ui.render(); }, onInvalidate: value => invalidations.push(value),
    onModeChange: () => { modeChanges++; }, onRefreshModels: () => { refreshes++; } });
  return { ui, calls, invalidations, changes, document, api: context.ForgeDeepSeekLogin, node: id => document.elements.get(id),
    update(next) { scope = { ...scope, deepseek: next }; ui.render(); }, busy(value) { busy = value; ui.render(); },
    mode() { document.elements.get('deepseek-auth-mode').value = 'deepseek-account'; return document.elements.get('deepseek-auth-mode').change(); },
    get modeChanges() { return modeChanges; }, get refreshes() { return refreshes; },
  };
}

test('DeepSeek adds an independent API-key/account selector with fixed official URL and no automatic login', () => {
  const f = fixture();
  assert.equal(f.node('deepseek-auth-mode-field').hidden, false); assert.equal(f.node('deepseek-login-panel').hidden, true);
  assert.equal(f.calls.length, 0); f.mode();
  assert.equal(f.modeChanges, 1); assert.equal(f.node('deepseek-login-panel').hidden, false);
  assert.equal(f.node('deepseek-login-url').textContent, 'https://api.deepseek.com/anthropic/v1');
  f.node('provider-select').value = 'openai'; f.ui.render();
  assert.equal(f.node('deepseek-auth-mode-field').hidden, true); assert.equal(f.node('deepseek-login-panel').hidden, true);
  assert.equal(f.calls.length, 0);
});

test('native sign-in is explicit, duplicate sign-ins lock and cancellation remains accessible during browser authorization', async () => {
  const login = deferred(), cancel = deferred();
  const f = fixture({ methods: { deepseekSignIn: () => login.promise, deepseekCancelSignIn: () => cancel.promise } }); f.mode();
  const signing = f.node('deepseek-login-sign-in').click();
  assert.equal(f.ui.isBusy(), true); assert.deepEqual(f.calls, [['deepseekSignIn', []]]); assert.deepEqual(f.invalidations, [null]);
  assert.equal(f.node('deepseek-login-cancel').hidden, false); assert.equal(f.node('deepseek-login-cancel').disabled, false);
  await f.node('deepseek-login-sign-in').click(); assert.equal(f.calls.length, 1);
  f.update(account({ session: { status: 'connecting', sharing: false, profileId: null }, attempt: { phase: 'waiting-browser', expiresAt: Date.now() + 10000 } }));
  assert.equal(f.node('deepseek-login-status').textContent, '等待官方浏览器授权');
  const cancelling = f.node('deepseek-login-cancel').click(); await f.node('deepseek-login-cancel').click();
  assert.deepEqual(f.calls.at(-1), ['deepseekCancelSignIn', []]); assert.equal(f.calls.length, 2);
  cancel.resolve({ settings: {}, deepseek: account() }); await cancelling;
  login.reject(new Error('DEEPSEEK_CANCELLED')); await signing;
  assert.equal(f.ui.isBusy(), false); assert.equal(f.node('deepseek-login-message').hidden, true);
});

test('every independent role routes its own login, disconnect and storage retry without main-account calls', async () => {
  for (const role of ['subagent', 'approval', 'completion', 'sidebar', 'pet']) {
    const f = fixture({ role }); f.mode(); await f.node('deepseek-login-sign-in').click();
    f.update(connected(role + '-generation')); await f.node('deepseek-login-disconnect').click();
    f.update(account({ storageRecovery: true, error: { code: 'DEEPSEEK_STORAGE_UNREADABLE' } })); await f.node('deepseek-login-retry').click();
    assert.deepEqual(f.calls, [['roleDeepseekSignIn', [{ role }]], ['roleDeepseekDisconnect', [{ role }]], ['roleDeepseekRetryStorage', [{ role }]]]);
    assert.deepEqual(f.invalidations, [role, role, role]);
  }
});

test('connected identity is text-only, model refresh requires authorization and storage failures preserve a retry path', async () => {
  const f = fixture(); f.mode();
  assert.equal(f.node('deepseek-login-models').disabled, true);
  f.update(connected('generation-one'));
  assert.equal(f.node('deepseek-login-identity').textContent, '测试 <script> · account@example.invalid');
  assert.equal(f.node('deepseek-login-models').disabled, false); await f.node('deepseek-login-models').click(); assert.equal(f.refreshes, 1);
  f.update(account({ storageRecovery: true, error: { code: 'DEEPSEEK_STORAGE_UNREADABLE', message: 'sensitive raw storage details' } }));
  assert.equal(f.node('deepseek-login-retry').hidden, false); assert.equal(f.node('deepseek-login-sign-in').hidden, true);
  assert.match(f.node('deepseek-login-message').textContent, /原信息已保留/u);
  assert.doesNotMatch(f.node('deepseek-login-message').textContent, /sensitive/u);
  assert.equal(f.api.errorMessage(new Error('Bearer PRIVATE_SECRET')), 'DeepSeek 连接操作未完成，请重试。');
});

function appFunction(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`, 'u').exec(appSource); assert.ok(match, name);
  const tail = appSource.slice(match.index), end = tail.slice(1).search(/\n(?:async )?function /u);
  return end < 0 ? tail : tail.slice(0, end + 1);
}
function appFixture() {
  const nodes = new Map(); const document = { elements: nodes, body: new Element('body'), createElement: tag => new Element(tag, document) };
  const node = id => { if (!nodes.has(id)) { const value = new Element('input', document); value.id = id; nodes.set(id, value); } return nodes.get(id); };
  const state = { settings: { provider: 'deepseek', authMode: 'deepseek-account', model: 'deepseek-v4-pro', providers: { deepseek: { hasKey: true, baseUrl: 'https://custom.invalid' } } }, deepseek: connected('main-generation'),
    roleModels: { approval: { enabled: true, settings: { provider: 'deepseek', authMode: 'deepseek-account', model: 'reviewer' }, deepseek: connected('role-generation') } } };
  const context = vm.createContext({ appState: state, settingsRole: null, modelSettingsScope: () => context.settingsRole ? state.roleModels[context.settingsRole] : state,
    modelSettingsChatGPT: () => ({ session: {} }), $: node, settingsCatalog: null, settingsCatalogDraft: null,
  });
  for (const name of ['currentAuthMode', 'catalogIdentity', 'activeCatalogIdentity', 'savedConnectionReady', 'selectedAuthMode', 'modelSettingsDraft', 'modelSettingsDraftSnapshot', 'settingsCatalogMatches']) vm.runInContext(appFunction(name), context);
  node('provider-select').value = 'deepseek'; node('deepseek-auth-mode').value = 'deepseek-account';
  node('base-url-input').value = 'https://untrusted.invalid'; node('api-key-input').value = 'DO_NOT_SEND_KEY';
  return { context, state, node };
}

test('account drafts never send typed API keys or URLs and bind model selections to the selected role credential generation', () => {
  const f = appFixture();
  assert.equal(f.context.currentAuthMode(), 'deepseek-account'); assert.equal(f.context.selectedAuthMode(), 'deepseek-account');
  assert.deepEqual(plain(f.context.modelSettingsDraft()), { provider: 'deepseek', authMode: 'deepseek-account' });
  assert.equal(f.context.savedConnectionReady('deepseek', 'deepseek-account'), true);
  const originalIdentity = f.context.activeCatalogIdentity();
  f.state.deepseek.session.profileId = 'same-user-new-authorization'; assert.notEqual(f.context.activeCatalogIdentity(), originalIdentity);
  f.context.settingsRole = 'approval'; const draft = plain(f.context.modelSettingsDraftSnapshot());
  assert.equal(draft.role, 'approval'); assert.equal(draft.profileId, 'role-generation'); assert.equal(draft.sharing, true);
  f.context.settingsCatalog = { selectionToken: 'grant', models: [] }; f.context.settingsCatalogDraft = draft;
  assert.equal(f.context.settingsCatalogMatches(), true);
  f.state.roleModels.approval.deepseek.session.profileId = 'new-role-generation'; assert.equal(f.context.settingsCatalogMatches(), false);
  f.node('deepseek-auth-mode').value = 'apiKey';
  assert.equal(f.context.selectedAuthMode(), 'apiKey'); assert.equal(f.context.modelSettingsDraft().apiKey, 'DO_NOT_SEND_KEY');
});

test('Tab context includes both the current account and an independently configured completion account without secrets', () => {
  const match = appSource.match(/getContext:\s*(\(\) => appState\?\.workspace[\s\S]+?\}\s*: null),\s*request: args => bridge\.completePrompt/u);
  assert.ok(match, 'The real completion context factory must be inspected');
  const f = appFixture(), c = f.context;
  Object.assign(c, { sessionId: 'session', projectSwitching: false, promptSubmitting: false, modelSaving: false, settingsSaving: false, isChatGPTBusy: () => false,
    approvals: new Set(), currentWorkspaceId: () => 'workspace', currentCatalogKey: '' });
  f.state.workspace = { root: 'D:/fixture' };
  const getContext = vm.runInContext(`(${match[1]})`, c);
  const first = plain(getContext()); f.state.deepseek.session.profileId = 'new-main'; const mainChanged = plain(getContext());
  assert.notEqual(first.account, mainChanged.account);
  f.state.roleModels.completion = { enabled: true, settings: { provider: 'deepseek', authMode: 'deepseek-account', model: 'completion' }, deepseek: connected('completion-one') };
  const scoped = plain(getContext()); f.state.roleModels.completion.deepseek.session.profileId = 'completion-two';
  assert.notEqual(scoped.completionConnection, getContext().completionConnection);
  assert.doesNotMatch(JSON.stringify(getContext()), /DO_NOT_SEND_KEY|accessToken|refreshToken/u);
});

test('disposing a login form prevents late authorization results from applying to a new scope', async () => {
  const login = deferred(), f = fixture({ methods: { deepseekSignIn: () => login.promise } }); f.mode();
  const signing = f.node('deepseek-login-sign-in').click(); f.ui.destroy();
  login.resolve({ settings: {}, deepseek: connected('late') }); await signing;
  assert.equal(f.node('deepseek-login-panel').removed, true); assert.equal(f.node('deepseek-auth-mode-field').removed, true);
});
