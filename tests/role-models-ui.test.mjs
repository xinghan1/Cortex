import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/renderer/role-models.js', import.meta.url), 'utf8');
const appSource = await readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const namespace = {}; vm.runInNewContext(source, namespace);
const roles = namespace.ForgeRoleModels;
const plain = value => JSON.parse(JSON.stringify(value));
class Element {
  constructor() { this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.textContent = ''; this.value = ''; this.open = false; this.hidden = false; this.disabled = false; this.classList = { toggle() {} }; }
  append(...values) { this.children.push(...values); }
  replaceChildren(...values) { this.children = values; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  click() { return this.listeners.click?.(); }
  close() { this.open = false; this.listeners.close?.(); }
  showModal() { this.open = true; }
  get text() { return this.textContent + this.children.map(child => child.text).join(' '); }
}
const state = () => ({ settings: { provider: 'openai', model: 'main-model', providers: { openai: { hasKey: true } } },
  chatgpt: { session: { status: 'connected', profileId: 'main-account', sharing: true } }, roleModels: {
    approval: { enabled: true, settings: { provider: 'relay', model: 'approval-model', providers: { relay: { hasKey: true, baseUrl: 'https://role.invalid/v1' } } }, chatgpt: { session: { profileId: 'role-account', status: 'connected', sharing: true } } },
    completion: { enabled: false, settings: { provider: 'deepseek', providers: { deepseek: { hasKey: false } } }, chatgpt: {} },
  } });

test('role configuration reads only its own saved keys and account even while following the main model', () => {
  const value = state();
  assert.equal(roles.scope(value, null), value);
  assert.equal(roles.scope(value, 'approval').chatgpt.session.profileId, 'role-account');
  assert.equal(roles.scope(value, 'completion').settings.providers.deepseek.hasKey, false);
  assert.equal(roles.scope(value, 'sidebar').settings.providers, undefined);
  assert.equal(roles.scope(value, 'sidebar').chatgpt.session, undefined);
  assert.throws(() => roles.scope(value, '__proto__'), /未识别/u);
});

test('only main and subagent require tool capability; text-only roles retain text compatibility checks', () => {
  const text = { id: 'text-model', compatible: false, textCompatible: true, supportsTools: false };
  for (const role of [null, 'subagent']) assert.equal(roles.selectable(role, text), false);
  for (const role of ['approval', 'completion', 'sidebar']) {
    assert.equal(roles.selectable(role, text), true);
    assert.equal(roles.selectable(role, { compatible: false, textCompatible: false }), false);
    assert.equal(roles.selectable(role, { supportsTools: false }), true);
  }
});

test('catalog, save and all account actions route to the chosen role without altering main actions', async () => {
  const methods = {
    preview: ['previewModelCatalog', 'previewRoleModelCatalog'], save: ['saveModelSettings', 'saveRoleModelSettings'],
    signin: ['chatgptSignIn', 'roleChatgptSignIn'], profile: ['chatgptSelectProfile', 'roleChatgptSelectProfile'],
    cancel: ['chatgptCancelSignIn', 'roleChatgptCancelSignIn'], disconnect: ['chatgptDisconnect', 'roleChatgptDisconnect'],
    retry: ['chatgptRetryStorage', 'roleChatgptRetryStorage'], usage: ['chatgptOpenUsage', 'roleChatgptOpenUsage'],
  };
  const calls = [], bridge = Object.fromEntries(Object.values(methods).flat().map(method => [method, input => { calls.push([method, plain(input)]); return 'saved'; }]));
  for (const [action, [main, scoped]] of Object.entries(methods)) {
    const input = Object.freeze({ model: 'chosen', selectionToken: 'catalog-token' });
    assert.equal(await roles.invoke(bridge, null, action, input), 'saved'); assert.deepEqual(calls.at(-1), [main, input]);
    for (const role of roles.roles) {
      await roles.invoke(bridge, role.id, action, input); assert.deepEqual(calls.at(-1), [scoped, { ...input, role: role.id }]);
    }
  }
  await assert.rejects(roles.invoke(bridge, '__proto__', 'save'), /未识别/u);
  await assert.rejects(roles.invoke({}, 'approval', 'save'), /不支持/u);
});

function listFixture(bridge = {}) {
  const elements = new Map(['role-models-dialog', 'role-models-list', 'role-models-close'].map(id => [id, new Element()]));
  const calls = [], notices = []; let busy = false, controller;
  controller = roles.create({ document: { getElementById: id => elements.get(id), createElement: () => new Element() }, bridge,
    onConfigure: role => calls.push(role), onState: value => controller.update(value), notice: (...args) => notices.push(args), isBusy: () => busy });
  return { controller, elements, calls, notices, rows: () => elements.get('role-models-list').children, busy: value => { busy = value; } };
}

test('role list shows follow versus independent models and opens the existing form for exactly one role', async () => {
  const f = listFixture(), value = state(); value.approvalReviewer = { model: 'legacy-reviewer' };
  f.controller.update(value); f.controller.openList();
  assert.equal(f.rows().length, 4);
  assert.match(f.rows()[0].text, /跟随主模型.*main-model/u);
  assert.match(f.rows()[1].text, /独立配置.*approval-model/u);
  assert.match(f.rows()[2].text, /跟随主模型.*main-model/u);
  await f.rows()[1].children[1].children[0].click();
  assert.deepEqual(f.calls, ['approval']); assert.equal(f.elements.get('role-models-dialog').open, false);
  value.roleModels.approval.enabled = false; f.controller.update(value); f.controller.openList();
  assert.match(f.rows()[1].text, /当前连接.*legacy-reviewer/u);
  assert.equal(f.rows()[1].children[1].children[1].disabled, false);
  f.busy(true); f.controller.open('sidebar'); assert.deepEqual(f.calls, ['approval']);
});

test('restore-follow saves only the chosen role, locks duplicate actions and retains configuration on failure', async () => {
  let finish; const requests = [], value = state();
  const f = listFixture({ resetRoleModel: input => { requests.push(plain(input)); return new Promise(resolve => { finish = resolve; }); } });
  f.controller.update(value); f.controller.openList();
  const resetting = f.controller.reset('approval'); await f.controller.reset('approval');
  assert.deepEqual(requests, [{ role: 'approval' }]); assert.equal(f.rows()[0].children[1].children[0].disabled, true);
  const restored = state(); restored.roleModels.approval.enabled = false; finish(restored); await resetting;
  assert.match(f.rows()[1].text, /跟随主模型/u);
  assert.equal(restored.roleModels.approval.settings.model, 'approval-model', 'Reset does not clear stored credentials or model details');
  const failed = listFixture({ resetRoleModel: async () => { throw new Error('save unavailable'); } });
  failed.controller.update(value); failed.controller.openList(); await failed.controller.reset('approval');
  assert.match(failed.rows()[1].text, /独立配置.*approval-model/u); assert.equal(failed.notices[0][1], true);
});

function appFunction(name) {
  const match = new RegExp(`(?:async )?function ${name}\\(`, 'u').exec(appSource);
  assert.ok(match, name);
  const tail = appSource.slice(match.index), end = tail.slice(1).search(/\n(?:async )?function /u);
  return end < 0 ? tail : tail.slice(0, end + 1);
}
function formFixture() {
  const elements = new Map(), calls = [];
  const node = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const context = vm.createContext({ window: { ForgeRoleModels: roles }, appState: state(), settingsRole: null,
    catalogRequest: 0, catalogLoading: false, chatgptLocalError: '', settingsSaving: false, settingsCatalog: { selectionToken: 'token' },
    $: node, contextBusy: () => false, isChatGPTBusy: () => false, closeReasoningPopup() {}, invalidateSettingsCatalog() {}, renderChatGPTState() {},
    refreshControlLocks() {}, renderSettingsCatalog() {}, selectedAuthMode: () => 'apiKey',
    bridge: { saveModelSettings: async input => { calls.push(['main', plain(input)]); return state(); }, saveRoleModelSettings: async input => { calls.push(['role', plain(input)]); return state(); } },
    updateState: next => { context.appState = next; }, notice: message => calls.push(['notice', message]), errorText: error => error.message,
    selectedSettingsModel: () => ({ id: 'selected-model' }), modelSettingsDraft: () => ({ provider: 'relay', apiKey: 'typed-key' }),
  });
  for (const name of ['modelSettingsScope', 'modelSettingsConfig', 'modelSettingsChatGPT', 'modelSettingsAction', 'modelSettingsDraftSnapshot', 'fillProvider', 'openSettings', 'saveSettings']) vm.runInContext(appFunction(name), context);
  return { context, node, calls };
}

test('the shared form opens role provider settings without inheriting the main saved-key marker', () => {
  const f = formFixture(); f.node('api-key-input').value = 'stale-draft';
  f.context.openSettings('completion');
  assert.equal(f.context.settingsRole, 'completion'); assert.equal(f.node('provider-select').value, 'deepseek');
  assert.equal(f.node('api-key-input').value, ''); assert.equal(f.node('key-status').textContent, '未配置');
  f.context.openSettings('approval'); assert.equal(f.node('base-url-input').value, 'https://role.invalid/v1');
  assert.equal(f.node('key-status').textContent, '已在本机保存');
  f.context.openSettings(); assert.equal(f.context.settingsRole, null); assert.equal(f.node('provider-select').value, 'openai');
});

test('shared form saves the validated role catalog token through the role bridge without changing main settings', async () => {
  const f = formFixture(); f.context.openSettings('approval');
  await f.context.saveSettings({ preventDefault() {} });
  assert.deepEqual(f.calls[0], ['role', { provider: 'relay', apiKey: 'typed-key', model: 'selected-model', selectionToken: 'token', role: 'approval' }]);
  assert.equal(f.context.appState.settings.model, 'main-model'); assert.equal(f.node('api-key-input').value, '');
  f.context.openSettings(); await f.context.saveSettings({ preventDefault() {} });
  assert.equal(f.calls[2][0], 'main'); assert.equal(Object.hasOwn(f.calls[2][1], 'role'), false);
});

test('catalog snapshots bind scope and independent ChatGPT identity so late previews cannot cross role boundaries', () => {
  const f = formFixture(); f.context.modelSettingsDraft = () => ({ provider: 'openai', authMode: 'chatgpt' });
  f.context.settingsRole = 'approval'; const scoped = plain(f.context.modelSettingsDraftSnapshot());
  assert.equal(scoped.role, 'approval'); assert.equal(scoped.profileId, 'role-account');
  f.context.settingsRole = null; const main = plain(f.context.modelSettingsDraftSnapshot());
  assert.equal(main.profileId, 'main-account'); assert.notDeepEqual(main, scoped);
});
