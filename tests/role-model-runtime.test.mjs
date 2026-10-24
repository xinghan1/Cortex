import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { RoleModelRuntime, MODEL_ROLES } from '../src/core/role-model-runtime.mjs';
import { deriveModelCapabilities } from '../src/core/model-catalog.mjs';

const require = createRequire(import.meta.url);
const { RoleModels } = require('../src/core/role-models.cjs');
const { Store } = require('../src/core/store.cjs');
const testRoot = path.resolve('tests', '.tmp');
const crypto = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`encrypted:${value}`),
  decryptString: value => value.toString().slice(10) };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const api = (extra = {}) => ({ provider: 'relay', baseUrl: 'https://role.example/v1', apiProtocol: 'responses', apiKey: 'role-only-secret', ...extra });
const model = (id, metadata = {}, provider = 'relay') => ({ id, displayName: id, ...deriveModelCapabilities(provider, id, metadata) });

async function fixture(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'role-runtime-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), testRoot.toLowerCase());
    assert.ok(path.basename(dir).startsWith('role-runtime-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const main = new Store(dir, crypto);
  await main.saveSettings({ provider: 'openai', model: 'main-model', apiKey: 'main-only-secret', reasoningEffort: 'high' });
  const configs = await new RoleModels(dir, crypto).init();
  const accounts = new Map(MODEL_ROLES.map(role => {
    const account = {
      state: { session: { status: 'disconnected', sharing: false, profileId: null } }, calls: [],
      models: [{ slug: 'gpt-6.1-sol', display_name: 'Official model' }],
      async publicState() { return structuredClone(this.state); },
      async listModels() { return structuredClone(this.models); },
      async requestModel(config) { this.calls.push(config); return { route: role, model: config.model }; },
    };
    return [role, account];
  }));
  const requests = [], catalogs = [];
  const catalog = {
    models: [model('coding-model', { supportsTools: true, reasoningEfforts: ['low', 'high'] }),
      model('text-model', { supportsTools: false }),
      model('image-model', { output_modalities: ['image'] })],
    async list(config) { catalogs.push(config); return { source: config.provider, models: structuredClone(this.models) }; },
  };
  const requestModel = async config => { requests.push(config); return { route: 'api', model: config.model }; };
  const create = (overrides = {}) => new RoleModelRuntime({ configs, accounts, catalog, requestModel,
    deriveCapabilities: deriveModelCapabilities, redact: value => configs.redact(main.redact(value)), ...overrides });
  return { dir, configs, accounts, requests, catalogs, catalog, main, create, runtime: create() };
}

async function select(runtime, role, input = api(), selected = 'coding-model') {
  const preview = await runtime.preview(role, input);
  await runtime.save(role, { ...input, model: selected, selectionToken: preview.selectionToken });
  return preview;
}

test('default role state follows main settings without exposing or inheriting its API key', async t => {
  const { runtime, main, configs } = await fixture(t);
  const state = await runtime.publicState(main.publicSettings());
  for (const role of MODEL_ROLES) {
    assert.equal(state[role].enabled, false);
    assert.deepEqual(state[role].effective, { provider: 'openai', authMode: 'apiKey', model: 'main-model' });
    assert.equal(configs.key(role, 'openai'), '');
    assert.equal(state[role].settings.providers.openai.hasKey, false);
    await assert.rejects(runtime.config(role), /跟随当前模型/);
  }
  assert.ok(!JSON.stringify(state).includes('main-only-secret'));
  assert.ok(!JSON.stringify(state).includes('encryptedKey'));
});

test('independent API configuration routes exact connection, model, protocol and reasoning without changing main', async t => {
  const { runtime, configs, main, requests, catalogs, accounts } = await fixture(t);
  const mainBefore = structuredClone(main.settings);
  const input = api({ provider: 'openai', apiKey: 'approval-private-key', baseUrl: 'https://approval.example/v1',
    apiProtocol: 'chat-completions', reasoningEffort: 'low' });
  await select(runtime, 'approval', input);
  const config = await runtime.config('approval', { permissionMode: 'auto' });
  assert.equal(config.provider, 'openai');
  assert.equal(config.authMode, 'apiKey');
  assert.equal(config.apiKey, 'approval-private-key');
  assert.equal(config.baseUrl, 'https://approval.example/v1');
  assert.equal(config.apiProtocol, 'chat-completions');
  assert.equal(config.model, 'coding-model');
  assert.equal(config.reasoningEffort, 'low');
  assert.equal(config.permissionMode, 'auto');
  assert.equal(config.modelRole, 'approval');
  assert.equal(config.modelCapabilities.supportsTools, true);
  assert.match(config.connectionKey, /^[a-f0-9]{64}$/u);
  const response = await runtime.dispatch({ ...config, messages: [{ role: 'user', content: 'Question' }], tools: [] });
  assert.equal(response.route, 'api');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].apiKey, 'approval-private-key');
  assert.equal(catalogs[0].apiKey, 'approval-private-key');
  assert.equal(accounts.get('approval').calls.length, 0);
  assert.deepEqual(main.settings, mainBefore);
  assert.equal(main.key('openai'), 'main-only-secret');
  assert.equal(configs.key('completion', 'openai'), '');
});

test('the pet role keeps API, ChatGPT and DeepSeek connections independent from sidebar and main accounts', async t => {
  const { runtime, configs, accounts, requests, main, dir } = await fixture(t), mainBefore = main.publicSettings();
  await select(runtime, 'sidebar', api({ apiKey: 'sidebar-private-key' }), 'text-model');
  const sidebarBefore = configs.publicState().sidebar;
  await select(runtime, 'pet', api({ apiKey: 'pet-private-key' }), 'text-model');
  const apiConfig = await runtime.config('pet');
  await runtime.dispatch({ ...apiConfig, messages: [{ role: 'user', content: 'hello' }], tools: [] });
  assert.equal(requests[0].apiKey, 'pet-private-key'); assert.equal(requests[0].modelRole, 'pet');
  assert.equal(apiConfig.modelCapabilities.supportsTools, false);

  const petAccount = accounts.get('pet');
  petAccount.state.session = { status: 'connected', sharing: true, profileId: 'pet-chatgpt-account' };
  await select(runtime, 'pet', { provider: 'openai', authMode: 'chatgpt' }, 'gpt-6.1-sol');
  const accountConfig = await runtime.config('pet');
  assert.equal(accountConfig.chatgptProfileId, 'pet-chatgpt-account'); assert.equal(accountConfig.apiKey, '');
  assert.equal((await runtime.dispatch({ ...accountConfig, tools: [] })).route, 'pet');
  assert.equal(petAccount.calls.length, 1); assert.equal(accounts.get('sidebar').calls.length, 0);

  const deepseekCalls = [], petDeepseek = {
    state: { session: { status: 'connected', sharing: true, profileId: 'pet-deepseek-account' } },
    async publicState() { return structuredClone(this.state); },
    async listModels() { return [model('deepseek-flash', { supportsTools: false }, 'deepseek')]; },
    async requestModel(config) { deepseekCalls.push(config); return { route: 'pet-deepseek' }; },
  };
  runtime.deepseekAccounts.set('pet', petDeepseek);
  await select(runtime, 'pet', { provider: 'deepseek', authMode: 'deepseek-account' }, 'deepseek-flash');
  const deepseekConfig = await runtime.config('pet');
  assert.equal(deepseekConfig.deepseekProfileId, 'pet-deepseek-account'); assert.equal(deepseekConfig.apiKey, '');
  assert.equal((await runtime.dispatch({ ...deepseekConfig, tools: [] })).route, 'pet-deepseek');
  assert.equal(deepseekCalls.length, 1); assert.equal(deepseekCalls[0].modelRole, 'pet');
  petDeepseek.state.session.profileId = 'replaced-pet-account';
  await assert.rejects(runtime.dispatch(deepseekConfig), /授权已变化/u);
  const restored = await new RoleModels(dir, crypto).init();
  assert.equal(restored.publicState().pet.settings.authMode, 'deepseek-account');
  assert.equal(restored.publicState().pet.settings.model, 'deepseek-flash');
  assert.equal(restored.key('pet', 'relay'), 'pet-private-key');
  assert.deepEqual(configs.publicState().sidebar, sidebarBefore); assert.deepEqual(main.publicSettings(), mainBefore);
  const publicState = await runtime.publicState(mainBefore);
  assert.equal(publicState.pet.deepseek.session.profileId, 'replaced-pet-account');
  assert.ok(!JSON.stringify(publicState).includes('pet-private-key'));
});

test('text roles accept text-only models while subagents reject models without coding tools', async t => {
  const { runtime } = await fixture(t);
  for (const role of ['approval', 'completion', 'sidebar', 'pet']) {
    const preview = await select(runtime, role, api(), 'text-model');
    assert.equal(preview.models.find(value => value.id === 'text-model').compatible, true);
    const config = await runtime.config(role);
    assert.equal(config.modelCapabilities.textCompatible, true);
    assert.equal(config.modelCapabilities.supportsTools, false);
    assert.equal(config.model, 'text-model');
    await assert.rejects(runtime.save(role, { ...api(), model: 'image-model', selectionToken: preview.selectionToken }),
      { code: 'SETTINGS_CATALOG_MODEL_INCOMPATIBLE' });
  }
  const preview = await runtime.preview('subagent', api());
  assert.equal(preview.models.find(value => value.id === 'text-model').compatible, false);
  await assert.rejects(runtime.save('subagent', { ...api(), model: 'text-model', selectionToken: preview.selectionToken }),
    { code: 'SETTINGS_CATALOG_MODEL_INCOMPATIBLE' });
  await runtime.save('subagent', { ...api(), model: 'coding-model', selectionToken: preview.selectionToken });
  assert.equal((await runtime.config('subagent')).modelCapabilities.supportsTools, true);
});

test('model selection grants cannot be reused across roles or changed connections', async t => {
  const { runtime, configs } = await fixture(t);
  const input = api(), preview = await runtime.preview('approval', input);
  await assert.rejects(runtime.save('sidebar', { ...input, model: 'coding-model', selectionToken: preview.selectionToken }),
    { code: 'SETTINGS_CATALOG_CONNECTION_CHANGED' });
  for (const change of [{ apiKey: 'other-secret' }, { baseUrl: 'https://other.example/v1' },
    { apiProtocol: 'chat-completions' }, { provider: 'openai' }]) {
    await assert.rejects(runtime.save('approval', { ...input, ...change, model: 'coding-model', selectionToken: preview.selectionToken }),
      { code: 'SETTINGS_CATALOG_CONNECTION_CHANGED' });
  }
  await assert.rejects(runtime.save('approval', { ...input, model: 'forged-model', selectionToken: preview.selectionToken,
    modelCapabilities: { supportsTools: true } }), { code: 'SETTINGS_CATALOG_MODEL_NOT_FOUND' });
  assert.equal(configs.isEnabled('approval'), false);
  await runtime.save('approval', { ...input, model: 'coding-model', selectionToken: preview.selectionToken });
  assert.equal(configs.isEnabled('approval'), true);
});

test('saved connection fields are fixed to the validated draft even if retained key changes before persistence', async t => {
  const { runtime, configs } = await fixture(t);
  await select(runtime, 'approval', api());
  const retained = api(); delete retained.apiKey;
  const preview = await runtime.preview('approval', retained);
  const save = configs.save.bind(configs);
  let intercepted = false;
  configs.save = async (role, input) => {
    if (!intercepted) {
      intercepted = true;
      await save(role, api({ model: 'changed-before-save', apiKey: 'racing-new-key', baseUrl: 'https://racing.example/v1' }));
    }
    return save(role, input);
  };
  await runtime.save('approval', { ...retained, model: 'coding-model', selectionToken: preview.selectionToken });
  const config = await runtime.config('approval');
  assert.equal(config.apiKey, 'role-only-secret');
  assert.equal(config.baseUrl, 'https://role.example/v1');
});

test('preview redacts draft keys, including JSON-escaped credentials, from returned model metadata', async t => {
  const { runtime, catalog, configs } = await fixture(t);
  const secret = 'draft-"private\\key-secret';
  catalog.models = [model('coding-model', { supportsTools: true })];
  catalog.models[0].displayName = `Model echo ${secret}`;
  catalog.models[0].details = { echo: secret };
  const preview = await runtime.preview('approval', api({ apiKey: secret }));
  assert.equal(preview.models[0].displayName, 'Model echo [已隐藏密钥]');
  assert.equal(preview.models[0].details.echo, '[已隐藏密钥]');
  assert.equal(configs.key('approval', 'relay'), '');
  assert.ok(!JSON.stringify(preview).includes('private'));
});

test('independent ChatGPT roles use their own account, official protocol and profile-bound routing', async t => {
  const { runtime, accounts, requests, catalogs, main } = await fixture(t);
  const approval = accounts.get('approval'), sidebar = accounts.get('sidebar');
  approval.state.session = { status: 'connected', sharing: true, profileId: 'approval-account' };
  sidebar.state.session = { status: 'connected', sharing: true, profileId: 'sidebar-account' };
  const input = { provider: 'openai', authMode: 'chatgpt', baseUrl: 'https://unused.example/v1', reasoningEffort: 'high' };
  await select(runtime, 'approval', input, 'gpt-6.1-sol');
  await select(runtime, 'sidebar', input, 'gpt-6.1-sol');
  const config = await runtime.config('approval');
  assert.equal(config.apiKey, '');
  assert.equal(config.chatgptProfileId, 'approval-account');
  assert.equal(config.baseUrl, 'https://api.openai.com/v1');
  assert.equal(config.apiProtocol, 'responses');
  assert.equal(config.modelCapabilities.supportsTools, true);
  const response = await runtime.dispatch({ ...config, tools: [] });
  assert.equal(response.route, 'approval');
  assert.equal(approval.calls.length, 1);
  assert.equal(sidebar.calls.length, 0);
  assert.equal(requests.length, 0);
  assert.equal(catalogs.length, 0);
  assert.equal(main.publicSettings().authMode, 'apiKey');
  approval.state.session.profileId = 'changed-account';
  await assert.rejects(runtime.dispatch(config), /授权已变化/);
  approval.state.session.sharing = false;
  await assert.rejects(runtime.preview('approval', input), /授权套餐用量/);
});

test('revision changes cancel stale dispatch and cancellation affects only the changed role', async t => {
  const { runtime, configs, requests } = await fixture(t);
  await select(runtime, 'approval');
  await select(runtime, 'completion');
  const first = await runtime.config('approval'), other = await runtime.config('completion');
  runtime.invalidate('approval');
  await assert.rejects(runtime.dispatch(first), { name: 'AbortError' });
  await runtime.dispatch(other);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].modelRole, 'completion');
  const beforeReset = runtime.revisions.completion;
  await runtime.reset('approval');
  assert.equal(configs.isEnabled('approval'), false);
  assert.equal(configs.isEnabled('completion'), true);
  assert.equal(runtime.revisions.completion, beforeReset);
  assert.equal(configs.key('approval'), 'role-only-secret');
  await runtime.dispatch(other);
  await assert.rejects(runtime.config('approval'), /跟随当前模型/);
});

test('Ollama capability refresh after restart rejects revision changes and respects an aborted caller', async t => {
  const { runtime, catalog, create } = await fixture(t);
  catalog.models = [model('local-model', { capabilities: ['completion'], contextWindowTokens: 65536 }, 'ollama')];
  await select(runtime, 'completion', { provider: 'ollama', baseUrl: 'http://localhost:11434', contextWindowTokens: 65536 }, 'local-model');
  const fresh = create(), entered = deferred(), release = deferred();
  const list = catalog.list.bind(catalog);
  catalog.list = async config => { entered.resolve(); await release.promise; return list(config); };
  const pending = fresh.config('completion');
  await entered.promise;
  fresh.invalidate('completion');
  release.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  const current = await fresh.config('completion');
  assert.equal(current.modelCapabilities.supportsTools, false);
  assert.equal(current.modelCapabilities.textCompatible, true);
  assert.equal(current.modelCapabilities.contextWindow, 65536);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(fresh.config('completion', { signal: cancelled.signal }), { name: 'AbortError' });
});

test('a revision change while ChatGPT dispatch awaits account state prevents the old request', async t => {
  const { runtime, accounts } = await fixture(t);
  const account = accounts.get('approval');
  account.state.session = { status: 'connected', sharing: true, profileId: 'approval-account' };
  await select(runtime, 'approval', { provider: 'openai', authMode: 'chatgpt' }, 'gpt-6.1-sol');
  const config = await runtime.config('approval');
  const entered = deferred(), release = deferred();
  account.publicState = async () => { entered.resolve(); await release.promise; return structuredClone(account.state); };
  const pending = runtime.dispatch(config);
  await entered.promise;
  runtime.invalidate('approval'); release.resolve();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(account.calls.length, 0);
});

test('restarted account roles reload their own narrower catalog before budgeting and reuse the current snapshot', async t => {
  const { dir, runtime, accounts, create } = await fixture(t);
  const input = { provider: 'openai', authMode: 'chatgpt' };
  for (const [index, role] of MODEL_ROLES.entries()) {
    const account = accounts.get(role);
    account.state.session = { status: 'connected', sharing: true, profileId: `${role}-account` };
    account.models = [{ slug: 'gpt-6.1-sol', displayName: 'Account model', contextWindow: 128000 + index * 1000,
      contextWindowKind: index === 1 ? 'input' : 'total' }];
    await select(runtime, role, input, 'gpt-6.1-sol');
  }
  const restored = await new RoleModels(dir, crypto).init(), fresh = create({ configs: restored });
  assert.equal(fresh.snapshots.size, 0);
  for (const [index, role] of MODEL_ROLES.entries()) {
    const account = accounts.get(role); let listings = 0;
    account.listModels = async (options = {}) => {
      listings++; assert.notEqual(options.force, true);
      return structuredClone(account.models);
    };
    account.signIn = () => assert.fail('Restoring a role must never start browser login');
    const config = await fresh.config(role);
    assert.equal(config.modelCapabilities.contextWindow, 128000 + index * 1000);
    assert.equal(config.modelCapabilities.contextWindowKind, index === 1 ? 'input' : 'total');
    assert.equal(config.chatgptProfileId, `${role}-account`);
    await fresh.config(role);
    assert.equal(listings, 1);
  }
});

test('failed cold account catalogs remain unknown instead of borrowing published capacity and can recover', async t => {
  const { runtime, accounts, create } = await fixture(t), account = accounts.get('subagent');
  account.state.session = { status: 'connected', sharing: true, profileId: 'own-account' };
  await select(runtime, 'subagent', { provider: 'openai', authMode: 'chatgpt' }, 'gpt-6.1-sol');
  const fresh = create(); let failed = true, listings = 0;
  account.listModels = async () => {
    listings++;
    if (failed) throw new Error('Synthetic network failure');
    return [{ slug: 'gpt-6.1-sol', displayName: 'Account model', contextWindow: 128000, contextWindowKind: 'total' }];
  };
  const unknown = await fresh.config('subagent');
  assert.equal(unknown.modelCapabilities.contextWindow, undefined);
  assert.equal(unknown.modelCapabilities.contextWindowKind, undefined);
  assert.equal(unknown.modelCapabilities.supportsTools, true);
  assert.deepEqual(unknown.modelCapabilities.reasoningEfforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(fresh.snapshots.size, 0);
  failed = false;
  assert.equal((await fresh.config('subagent')).modelCapabilities.contextWindow, 128000);
  assert.equal(listings, 2);
  const missing = create(); account.listModels = async () => [{ slug: 'other-model', displayName: 'Other' }];
  assert.equal((await missing.config('subagent')).modelCapabilities.contextWindow, undefined);
});

test('a role or account change during a cold catalog load cannot publish or use the stale snapshot', async t => {
  const { runtime, accounts, create } = await fixture(t), account = accounts.get('subagent');
  account.state.session = { status: 'connected', sharing: true, profileId: 'old-account' };
  await select(runtime, 'subagent', { provider: 'openai', authMode: 'chatgpt' }, 'gpt-6.1-sol');
  for (const change of ['revision', 'profile', 'sharing']) {
    account.state.session = { status: 'connected', sharing: true, profileId: 'old-account' };
    const fresh = create(), entered = deferred(), release = deferred();
    account.listModels = async () => {
      entered.resolve(); await release.promise;
      return [{ slug: 'gpt-6.1-sol', displayName: 'Old', contextWindow: 128000 }];
    };
    const pending = fresh.config('subagent');
    await entered.promise;
    if (change === 'revision') fresh.invalidate('subagent');
    else if (change === 'profile') account.state.session.profileId = 'new-account';
    else account.state.session.sharing = false;
    release.resolve();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(fresh.snapshots.size, 0);
  }
});

test('cancelling one cold catalog caller does not cancel another role caller or write after cancellation', async t => {
  const { runtime, accounts, create } = await fixture(t), account = accounts.get('subagent');
  account.state.session = { status: 'connected', sharing: true, profileId: 'own-account' };
  await select(runtime, 'subagent', { provider: 'openai', authMode: 'chatgpt' }, 'gpt-6.1-sol');
  const fresh = create(), entered = deferred(), release = deferred(), controller = new AbortController();
  account.listModels = async (options = {}) => {
    assert.equal(options.signal, undefined);
    entered.resolve(); await release.promise;
    return [{ slug: 'gpt-6.1-sol', displayName: 'Account model', contextWindow: 128000 }];
  };
  const cancelled = fresh.config('subagent', { signal: controller.signal });
  await entered.promise;
  const current = fresh.config('subagent');
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(fresh.snapshots.size, 0);
  release.resolve();
  assert.equal((await current).modelCapabilities.contextWindow, 128000);
});
