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
  const create = () => new RoleModelRuntime({ configs, accounts, catalog, requestModel,
    deriveCapabilities: deriveModelCapabilities, redact: value => configs.redact(main.redact(value)) });
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

test('text roles accept text-only models while subagents reject models without coding tools', async t => {
  const { runtime } = await fixture(t);
  for (const role of ['approval', 'completion', 'sidebar']) {
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
