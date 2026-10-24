import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { ModelCatalog, deriveModelCapabilities } from '../src/core/model-catalog.mjs';
import { RoleModelRuntime, MODEL_ROLES } from '../src/core/role-model-runtime.mjs';
const require = createRequire(import.meta.url);
const { Store } = require('../src/core/store.cjs');
const { RoleModels } = require('../src/core/role-models.cjs');
const { modelCapacityConnectionKey, modelCapacityScope } = require('../src/core/model-capacity-preferences.cjs');
const { approvalReviewerConnectionKey } = require('../src/core/approval-reviewer-preferences.cjs');
const root = path.resolve('tests/.tmp');
const crypto = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`encrypted:${value}`), decryptString: value => value.toString().slice(10) };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const apiModel = (name, extra = {}) => ({ name: `models/${name}`, displayName: 'Friendly Gemini', inputTokenLimit: 128000, outputTokenLimit: 8192,
  supportedGenerationMethods: ['generateContent', 'countTokens'], ...extra });
async function directory(t) {
  await fs.mkdir(root, { recursive: true }); const dir = await fs.mkdtemp(path.join(root, 'gemini-core-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), root.toLowerCase()); assert.ok(path.basename(dir).startsWith('gemini-core-')); await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}
async function runtimeFixture(t) {
  const dir = await directory(t), configs = await new RoleModels(dir, crypto).init(), calls = [], catalogs = [];
  const accounts = new Map(MODEL_ROLES.map(role => [role, { publicState: async () => ({ session: { status: 'disconnected', sharing: false, profileId: null } }) }]));
  const geminiAccounts = new Map(MODEL_ROLES.map(role => [role, {
    state: { session: { status: 'connected', sharing: true, profileId: `gemini-${role}-profile` } }, calls: [], reads: 0,
    models: [{ id: 'gemini-cli-model', displayName: 'CLI Gemini', compatible: true, textCompatible: true, supportsTools: true, supportsImages: false, reasoningEfforts: [] }],
    async publicState() { return structuredClone(this.state); }, async listModels() { this.reads++; return structuredClone(this.models); },
    async requestModel(value) { this.calls.push(value); return { route: `gemini-account:${role}`, model: value.model }; },
  }]));
  const catalog = { async list(value) { catalogs.push(value); return { source: 'api', models: [{ id: 'gemini-api-model', displayName: 'API Gemini', contextWindow: 64000,
    contextWindowKind: 'input', contextWindowOrigin: 'provider', maxOutputTokens: 4096, reasoningEfforts: [] }] }; } };
  const create = () => new RoleModelRuntime({ configs, accounts, geminiAccounts, catalog, deriveCapabilities: deriveModelCapabilities,
    requestModel: async value => { calls.push(value); return { route: 'api', model: value.model }; } });
  return { dir, configs, accounts, geminiAccounts, catalog, catalogs, calls, create, runtime: create() };
}
async function select(runtime, role, input, model) {
  const preview = await runtime.preview(role, input); await runtime.save(role, { ...input, model, selectionToken: preview.selectionToken }); return preview;
}

test('native Gemini catalog pagination uses API-key headers, friendly labels and authoritative input/output token fields', async () => {
  const calls = [], catalog = new ModelCatalog();
  const result = await catalog.list({ provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'gemini-native-key', fetchImpl: async (url, init) => {
    calls.push({ url: new URL(url), init });
    return Response.json(calls.length === 1 ? { models: [apiModel('gemini-one', { contextWindow: 9999999, capabilities: { contextWindow: 8888888 }, thinking: true,
      reasoningEfforts: ['max'], maxOutputTokens: 77777 })], nextPageToken: 'page+/=two' }
      : { models: [apiModel('text-embedding-model', { supportedGenerationMethods: ['embedContent'] }), apiModel('gemini-two')] });
  } });
  assert.equal(calls.length, 2); assert.equal(calls[0].url.pathname, '/v1beta/models'); assert.equal(calls[1].url.searchParams.get('pageToken'), 'page+/=two');
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'gemini-native-key'); assert.equal(Object.hasOwn(calls[0].init.headers, 'Authorization'), false);
  assert.equal(calls[0].url.searchParams.has('key'), false); assert.equal(calls[0].init.redirect, 'error');
  assert.equal(result.models[0].id, 'gemini-one'); assert.equal(result.models[0].displayName, 'Friendly Gemini');
  assert.equal(result.models[0].contextWindow, 128000); assert.equal(result.models[0].contextWindowKind, 'input'); assert.equal(result.models[0].maxOutputTokens, 8192);
  assert.deepEqual(result.models[0].reasoningEfforts, []); assert.equal(result.models[1].compatible, false); assert.equal(result.models[1].textCompatible, false);
  assert.equal(deriveModelCapabilities('gemini', 'gemini-cli-model').contextWindow, undefined);
});

test('Gemini native directory rejects malformed generation methods, token limits, identifiers and unsafe pagination', async () => {
  for (const row of [apiModel('../bad'), apiModel('one', { inputTokenLimit: '128000' }), apiModel('one', { outputTokenLimit: -1 }),
    apiModel('one', { supportedGenerationMethods: 'generateContent' }), apiModel('one', { supportedGenerationMethods: ['generateContent\n'] })]) {
    await assert.rejects(new ModelCatalog().list({ provider: 'gemini', apiKey: 'native-key', fetchImpl: async () => Response.json({ models: [row] }) }), { code: 'CATALOG_INVALID_RESPONSE' });
  }
  for (const nextPageToken of [17, 'repeat', 'native-key']) {
    const expected = nextPageToken === 'native-key' ? 'CATALOG_UNSAFE_RESPONSE' : 'CATALOG_INVALID_RESPONSE';
    await assert.rejects(new ModelCatalog().list({ provider: 'gemini', apiKey: 'native-key', fetchImpl: async () => Response.json({ models: [], nextPageToken }) }), { code: expected });
  }
  await assert.rejects(new ModelCatalog().list({ provider: 'gemini', apiKey: 'native-key', baseUrl: 'https://example.com/v1beta/models/gemini:generateContent' }), { code: 'CATALOG_INVALID_URL' });
});

test('Store migrates an old provider set and keeps Gemini API-key/account models and encrypted credentials separate across restart', async t => {
  const dir = await directory(t), old = new Store(dir, crypto);
  await old.saveSettings({ provider: 'deepseek', model: 'old-model', apiKey: 'old-deepseek-key' });
  const legacy = structuredClone(old.settings); delete legacy.providers.gemini; await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify(legacy));
  const store = new Store(dir, crypto); await store.init(); assert.equal(store.key('deepseek'), 'old-deepseek-key');
  assert.equal(store.publicSettings().providers.gemini.authMode, 'apiKey');
  await store.saveSettings({ provider: 'gemini', authMode: 'apiKey', model: 'gemini-api-model', apiKey: 'separate-gemini-api-key' });
  await store.saveSettings({ provider: 'gemini', authMode: 'gemini-account', model: 'gemini-cli-model' });
  await store.saveSettings({ provider: 'gemini', authMode: 'apiKey' }); assert.equal(store.publicSettings().model, 'gemini-api-model');
  await store.saveSettings({ provider: 'gemini', authMode: 'gemini-account' });
  const restored = new Store(dir, crypto); await restored.init();
  assert.equal(restored.publicSettings().authMode, 'gemini-account'); assert.equal(restored.publicSettings().model, 'gemini-cli-model');
  assert.equal(restored.key('gemini'), 'separate-gemini-api-key'); assert.equal(restored.key('deepseek'), 'old-deepseek-key');
  assert.deepEqual(restored.publicSettings().modelsByAuth, { apiKey: 'gemini-api-model', 'gemini-account': 'gemini-cli-model', 'antigravity-agent': '' });
  assert.doesNotMatch(JSON.stringify(restored.publicSettings()), /separate-gemini-api-key|encryptedKey/);
  await assert.rejects(restored.saveSettings({ provider: 'deepseek', authMode: 'gemini-account' }), /登录方式/);
  await assert.rejects(restored.saveSettings({ provider: 'gemini', reasoningEffort: 'none' }), /思考强度/);
});

test('Gemini usage survives ledger reload as reported values without inventing missing counters', async t => {
  const dir = await directory(t), store = new Store(dir, crypto); await store.init();
  for (const reported of [true, false]) await store.recordUsage({ id: randomUUID(), timestamp: new Date().toISOString(), provider: 'gemini', model: 'gemini-test',
    sessionId: 'main-session', runId: 'run', status: 'completed', reported, inputTokens: reported ? 30 : null, outputTokens: reported ? 11 : null,
    cachedInputTokens: 10, purpose: 'pet-chat' });
  const reopened = new Store(dir, crypto); await reopened.init();
  const records = reopened.usage.records; assert.equal(records.length, 2);
  assert.equal(records[0].provider, 'gemini'); assert.equal(records[0].cachedInputTokens, 10); assert.equal(records[0].purpose, 'pet-chat');
  assert.equal(records[1].reported, false); assert.equal(records[1].inputTokens, null); assert.equal(records[1].outputTokens, null);
});

test('older role files add an empty Gemini connection without rewriting disk or borrowing any existing key', async t => {
  const f = await runtimeFixture(t); await f.configs.save('sidebar', { provider: 'openai', model: 'sidebar-old', apiKey: 'sidebar-key' });
  const file = path.join(f.dir, 'role-models.json'), value = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const role of MODEL_ROLES) for (const provider of ['gemini', 'kimi', 'glm']) delete value.roles[role].settings.providers[provider];
  const legacy = JSON.stringify(value); await fs.writeFile(file, legacy);
  const reopened = await new RoleModels(f.dir, crypto).init(); assert.equal(reopened.key('sidebar', 'openai'), 'sidebar-key');
  for (const role of MODEL_ROLES) { assert.equal(reopened.key(role, 'gemini'), ''); assert.equal(reopened.publicState()[role].settings.providers.gemini.authMode, 'apiKey'); }
  assert.equal(await fs.readFile(file, 'utf8'), legacy);
  await reopened.save('pet', { provider: 'gemini', authMode: 'gemini-account', model: 'gemini-cli-model' });
  const latest = await new RoleModels(f.dir, crypto).init(); assert.equal(latest.publicState().pet.settings.authMode, 'gemini-account');
  assert.equal(latest.key('pet', 'gemini'), ''); assert.equal(latest.key('sidebar', 'openai'), 'sidebar-key');
});

test('Gemini role account configuration needs no API key and its schema is preserved rather than silently downgraded on reload', async t => {
  const f = await runtimeFixture(t), input = { provider: 'gemini', authMode: 'gemini-account' };
  await select(f.runtime, 'pet', { provider: 'gemini', authMode: 'apiKey', apiKey: 'pet-api-key' }, 'gemini-api-model');
  await select(f.runtime, 'pet', input, 'gemini-cli-model');
  const restored = await new RoleModels(f.dir, crypto).init(), settings = restored.publicState().pet.settings;
  assert.equal(settings.authMode, 'gemini-account'); assert.equal(settings.model, 'gemini-cli-model'); assert.equal(restored.key('pet', 'gemini'), 'pet-api-key');
  assert.deepEqual(settings.modelsByAuth, { apiKey: 'gemini-api-model', 'gemini-account': 'gemini-cli-model', 'antigravity-agent': '' });
  const file = path.join(f.dir, 'role-models.json'), valid = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const mutate of [value => { value.authMode = 'unsupported-mode'; }, value => { value.modelsByAuth['gemini-account'] = 'different-model'; },
    value => { delete value.modelsByAuth; }]) {
    const invalid = structuredClone(valid); mutate(invalid.roles.pet.settings.providers.gemini); await fs.writeFile(file, JSON.stringify(invalid));
    await assert.rejects(new RoleModels(f.dir, crypto).init(), { code: 'ROLE_MODELS_LOAD_FAILED' });
  }
});

test('all independent Gemini role accounts use their own catalog/profile and dispatch directly to the account bridge without native API keys', async t => {
  const f = await runtimeFixture(t);
  for (const role of MODEL_ROLES) {
    await select(f.runtime, role, { provider: 'gemini', authMode: 'gemini-account' }, 'gemini-cli-model');
    const config = await f.runtime.config(role), result = await f.runtime.dispatch({ ...config, tools: [], messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(result.route, `gemini-account:${role}`); assert.equal(config.geminiProfileId, `gemini-${role}-profile`); assert.equal(config.apiKey, '');
    assert.equal(config.modelCapabilities.contextWindow, undefined); assert.deepEqual(config.modelCapabilities.reasoningEfforts, []);
    assert.equal(f.geminiAccounts.get(role).calls.length, 1); assert.equal(f.geminiAccounts.get(role).calls[0].modelRole, role);
  }
  assert.equal(f.calls.length, 0); assert.equal(f.catalogs.length, 0);
  const state = await f.runtime.publicState({ provider: 'deepseek', authMode: 'apiKey', model: 'main' });
  assert.equal(state.pet.gemini.session.profileId, 'gemini-pet-profile'); assert.doesNotMatch(JSON.stringify(state), /encryptedKey|pet-api-key/);
});

test('Gemini account changes invalidate preview grants and prevent an old role config from dispatching', async t => {
  const f = await runtimeFixture(t), role = 'approval', input = { provider: 'gemini', authMode: 'gemini-account' }, account = f.geminiAccounts.get(role);
  const preview = await f.runtime.preview(role, input); account.state.session.profileId = 'replacement-profile';
  await assert.rejects(f.runtime.save(role, { ...input, model: 'gemini-cli-model', selectionToken: preview.selectionToken }), /连接|目录/);
  await select(f.runtime, role, input, 'gemini-cli-model'); const config = await f.runtime.config(role);
  account.state.session.profileId = 'another-profile'; await assert.rejects(f.runtime.dispatch(config), /授权已变化/);
  account.state.session.profileId = config.geminiProfileId; account.state.session.sharing = false;
  await assert.rejects(f.runtime.dispatch(config), /授权已变化/); assert.equal(account.calls.length, 0);
});

test('a cold Gemini account reads only its current CLI catalog and refuses post-await account/revision changes or cancellation', async t => {
  const f = await runtimeFixture(t), role = 'subagent', input = { provider: 'gemini', authMode: 'gemini-account' };
  await select(f.runtime, role, input, 'gemini-cli-model');
  const account = f.geminiAccounts.get(role), before = account.reads, cold = f.create();
  const config = await cold.config(role); assert.equal(account.reads, before + 1); assert.equal(config.modelCapabilities.contextWindow, undefined);
  for (const action of ['profile', 'revision', 'stop']) {
    const held = deferred(), current = f.create(), parent = new AbortController(); let entered = false;
    account.state.session.profileId = 'gemini-subagent-profile'; account.listModels = () => { entered = true; return held.promise; };
    const pending = current.config(role, { signal: parent.signal }); const rejection = assert.rejects(pending, { name: 'AbortError' });
    while (!entered) await tick();
    if (action === 'profile') account.state.session.profileId = 'changed-profile';
    else if (action === 'revision') current.invalidate(role); else parent.abort();
    if (action !== 'stop') held.resolve(account.models);
    await rejection; assert.equal(current.snapshots.has(role), false); held.resolve(account.models);
  }
});

test('a cold Gemini API role recovers its real input capacity and uses only its independent API key', async t => {
  const f = await runtimeFixture(t); await select(f.runtime, 'completion', { provider: 'gemini', apiKey: 'independent-gemini-key', authMode: 'apiKey' }, 'gemini-api-model');
  const cold = f.create(), before = f.catalogs.length, config = await cold.config('completion');
  assert.equal(f.catalogs.length, before + 1); assert.equal(f.catalogs.at(-1).apiKey, 'independent-gemini-key');
  assert.equal(config.modelCapabilities.contextWindow, 64000); assert.equal(config.modelCapabilities.contextWindowKind, 'input');
  assert.equal(config.modelCapabilities.maxOutputTokens, 4096); assert.equal(config.geminiProfileId, null);
  assert.equal((await cold.dispatch(config)).route, 'api'); assert.equal(f.calls[0].apiKey, 'independent-gemini-key');
  f.catalog.list = async () => { throw new Error('offline'); };
  const unknown = await f.create().config('completion'); assert.equal(unknown.modelCapabilities.contextWindow, undefined);
});

test('Gemini capacity and reviewer preferences are stable within one account and isolated by provider, mode, key and exact model', () => {
  const api = { provider: 'gemini', authMode: 'apiKey', config: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta' } };
  const account = { provider: 'gemini', authMode: 'gemini-account', account: { session: { profileId: 'profile-a', status: 'connected' } } };
  for (const helper of [modelCapacityConnectionKey, approvalReviewerConnectionKey]) {
    const first = helper(account); assert.equal(first, helper({ ...account, account: { session: { profileId: 'profile-a', status: 'connecting' } } }));
    assert.notEqual(first, helper({ ...account, account: { session: { profileId: 'profile-b' } } }));
    assert.notEqual(first, helper(api, 'native-key')); assert.notEqual(helper(api, 'native-key'), helper(api, 'other-key'));
    assert.throws(() => helper({ ...account, provider: 'deepseek' }));
  }
  assert.notEqual(modelCapacityScope(modelCapacityConnectionKey(account), 'Gemini'), modelCapacityScope(modelCapacityConnectionKey(account), 'gemini'));
});
