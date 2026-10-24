import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { requestModel } from '../src/core/providers.mjs';
import { ModelCatalog } from '../src/core/model-catalog.mjs';
const require = createRequire(import.meta.url), { Store } = require('../src/core/store.cjs'), { RoleModels } = require('../src/core/role-models.cjs');
const { modelCapacityConnectionKey } = require('../src/core/model-capacity-preferences.cjs');
const { approvalReviewerConnectionKey } = require('../src/core/approval-reviewer-preferences.cjs');
const key = 'vendor-fixture-private-key', tools = [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
const initial = [{ id: 'first-user', role: 'user', content: 'Read a file.' }];
const chat = (content = 'Done', extra = {}) => ({ choices: [{ message: { content, ...extra }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 6 } } });
const response = (output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] }]) => ({ status: 'completed', output,
  usage: { input_tokens: 30, output_tokens: 10, input_tokens_details: { cached_tokens: 6 }, output_tokens_details: { reasoning_tokens: 7 } } });
function fixture(provider, extra = {}, generate = () => provider === 'kimi' && extra.apiProtocol !== 'chat-completions' ? response() : chat()) {
  const calls = [], progress = [], deltas = [];
  return { calls, progress, deltas, request: input => requestModel({ provider, model: provider === 'kimi' ? 'kimi-k3.1-pro' : 'glm-5.3', apiKey: key,
    connectionKey: 'independent-connection', messages: initial, tools, appVersion: '0.22.3', sessionId: 'session-one',
    onTextDelta: value => deltas.push(value), onProgress: value => progress.push(value),
    fetchImpl: async (url, options) => { const sent = { url, options, body: JSON.parse(options.body) }; calls.push(sent); return Response.json(generate(sent)); }, ...extra, ...input }) };
}
const tmpRoot = path.resolve('tests/.tmp'), crypto = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`encrypted:${value}`), decryptString: value => value.toString().slice(10) };
async function dir(t) { await fs.mkdir(tmpRoot, { recursive: true }); const value = await fs.mkdtemp(path.join(tmpRoot, 'vendor-api-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(value)).toLowerCase(), tmpRoot.toLowerCase()); assert.ok(path.basename(value).startsWith('vendor-api-')); await fs.rm(value, { recursive: true, force: true }); }); return value; }

test('Kimi Responses uses native Moonshot API, honest product identity, a stable cache lineage and no unsupported OpenAI include override', async () => {
  const f = fixture('kimi'); const result = await f.request({ reasoningEffort: 'high' });
  assert.equal(f.calls[0].url, 'https://api.moonshot.cn/v1/responses'); assert.equal(f.calls[0].options.headers.Authorization, `Bearer ${key}`);
  assert.equal(f.calls[0].options.headers['User-Agent'], 'Synora-code/0.22.3'); assert.equal(Object.hasOwn(f.calls[0].body, 'include'), false);
  assert.deepEqual(f.calls[0].body.reasoning, { effort: 'high' }); assert.equal(f.calls[0].body.store, false);
  const cached = f.calls[0].body.prompt_cache_key; assert.match(cached, /^synora-[a-f\d]{64}$/u);
  await f.request({ messages: [...initial, result.message, { role: 'user', content: 'Continue' }] });
  assert.equal(f.calls[1].body.prompt_cache_key, cached);
  await f.request({ sessionId: 'other-session' }); assert.notEqual(f.calls[2].body.prompt_cache_key, cached);
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 10, cachedInputTokens: 6 });
});

test('Kimi encrypted Responses items and calls are retained exactly once and bound to the actual provider/connection/model', async () => {
  const native = [{ type: 'reasoning', id: 'reason-one', encrypted_content: 'opaque-reasoning', summary: [] },
    { type: 'function_call', id: 'item-one', call_id: 'call-one', name: 'read_file', arguments: '{"path":"one.txt"}' }];
  const f = fixture('kimi', {}, () => response(native)); const first = await f.request();
  assert.equal(first.message.providerState.provider, 'kimi'); const history = [...initial, first.message, { role: 'tool', toolCallId: 'call-one', content: 'file' }];
  await f.request({ messages: history }); assert.deepEqual(f.calls[1].body.input.slice(1, 3), native);
  assert.equal(f.calls[1].body.input.filter(value => value.type === 'function_call').length, 1);
  for (const patch of [{ apiKey: 'another-key' }, { connectionKey: 'other-connection' }, { model: 'kimi-k3' }, { baseUrl: 'https://api.kimi.com/coding/v1' }, { apiProtocol: 'chat-completions' }])
    await assert.rejects(f.request({ ...patch, messages: history }), { code: 'PROVIDER_NATIVE_STATE_MISMATCH' });
  const changed = structuredClone(first.message); changed.toolCalls[0].arguments.path = 'different.txt';
  await assert.rejects(f.request({ messages: [...initial, changed, history.at(-1)] }), { code: 'PROVIDER_NATIVE_STATE_MISMATCH' });
});

test('Kimi Chat Completions preserves all reasoning_content with tool results and never disables K3.1 thinking', async () => {
  const f = fixture('kimi', { apiProtocol: 'chat-completions' }, () => chat('', { reasoning_content: 'PRIVATE_REASONING',
    tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'read_file', arguments: '{"path":"one.txt"}' } }] }));
  const first = await f.request({ reasoningEffort: 'max' });
  assert.equal(first.message.providerState.message.reasoning_content, 'PRIVATE_REASONING'); assert.equal(f.deltas.join(''), '');
  await f.request({ messages: [...initial, first.message, { role: 'tool', toolCallId: 'call-one', content: 'file' }] });
  assert.equal(f.calls[1].body.messages[1].reasoning_content, 'PRIVATE_REASONING'); assert.equal(f.calls[0].body.reasoning_effort, 'max');
  assert.equal(Object.hasOwn(f.calls[0].body, 'thinking'), false);
  await assert.rejects(f.request({ reasoningEffort: 'none' }), { code: 'INVALID_REASONING_EFFORT' });
  await f.request({ model: 'kimi-k2.6', reasoningEffort: 'none' }); assert.deepEqual(f.calls.at(-1).body.thinking, { type: 'disabled' });
});

test('Kimi Coding Plan regional endpoints are explicit and keep their key/model identifiers unchanged', async () => {
  for (const baseUrl of ['https://api.kimi.com/coding/v1', 'https://api.kimi.ai/coding/v1', 'https://api.moonshot.ai/v1']) {
    const f = fixture('kimi', { baseUrl, model: 'k3.1-pro' }); await f.request();
    assert.equal(f.calls[0].url, `${baseUrl}/responses`); assert.equal(f.calls[0].body.model, 'k3.1-pro'); assert.equal(f.calls.length, 1);
    assert.equal(Object.hasOwn(f.calls[0].options.headers, 'X-Msh-Platform'), false);
  }
});

test('GLM exact model thought/effort fields follow the documented API mapping without applying guesses to a custom model or gateway', async () => {
  for (const [model, effort, expected, disabled = false] of [['glm-5.3', 'low', 'low'], ['glm-5.3-flash', 'max', 'max'],
    ['glm-5.2', 'low', 'high'], ['glm-5.2', 'medium', 'high'], ['glm-5.2', 'xhigh', 'max'], ['glm-5.2', 'none', undefined, true], ['glm-5.2', 'minimal', undefined, true]]) {
    const f = fixture('glm', { model }); await f.request({ reasoningEffort: effort });
    assert.equal(f.calls[0].body.reasoning_effort, expected);
    assert.deepEqual(f.calls[0].body.thinking, disabled ? { type: 'disabled' } : { type: 'enabled', clear_thinking: false });
    assert.equal(f.calls[0].body.tool_stream, true); assert.equal(f.calls[0].body.tool_choice, 'auto');
  }
  const f = fixture('glm'); await f.request(); assert.equal(f.calls[0].url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  for (const reasoningEffort of ['none', 'minimal', 'medium', 'xhigh']) await assert.rejects(f.request({ reasoningEffort }), { code: 'INVALID_REASONING_EFFORT' });
  await f.request({ model: 'glm-future' }); assert.equal(Object.hasOwn(f.calls.at(-1).body, 'thinking'), false);
  await f.request({ baseUrl: 'https://gateway.example/v1' }); assert.equal(Object.hasOwn(f.calls.at(-1).body, 'thinking'), false);
  await assert.rejects(f.request({ apiProtocol: 'responses' }), { code: 'INVALID_API_PROTOCOL' });
});

test('GLM reasoning and complete object/string tool parameters round trip without exposing private reasoning or crossing endpoints', async () => {
  const f = fixture('glm', {}, () => chat('Reading', { reasoning_content: 'GLM_PRIVATE_THOUGHT', tool_calls: [{ id: 'read-one', type: 'function',
    function: { name: 'read_file', arguments: { path: 'one.txt' } } }] }));
  const first = await f.request(); assert.equal(first.message.providerState.provider, 'glm'); assert.equal(f.deltas.join(''), 'Reading');
  const history = [...initial, first.message, { role: 'tool', toolCallId: 'read-one', content: 'file' }];
  await f.request({ messages: history }); assert.equal(f.calls[1].body.messages[1].reasoning_content, 'GLM_PRIVATE_THOUGHT');
  assert.equal(f.calls[1].body.messages[1].tool_calls[0].function.arguments, '{"path":"one.txt"}');
  await assert.rejects(f.request({ baseUrl: 'https://api.z.ai/api/paas/v4', messages: history }), { code: 'PROVIDER_NATIVE_STATE_MISMATCH' });
});

test('both new providers reject truncated tool responses and settle ignored-abort transport without a usable tool result', async () => {
  for (const provider of ['kimi', 'glm']) {
    const f = fixture(provider, {}, () => provider === 'kimi' ? { ...response([{ type: 'function_call', call_id: 'one', name: 'read_file', arguments: '{"path":' }]),
      status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }
      : { choices: [{ message: { content: '', tool_calls: [{ id: 'one', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }, finish_reason: 'length' }] });
    await assert.rejects(f.request(), { code: 'PROVIDER_TRUNCATED' });
    const stop = new AbortController(), held = fixture(provider, { signal: stop.signal, fetchImpl: () => new Promise(() => {}) });
    const pending = held.request(), rejected = assert.rejects(pending, { name: 'AbortError' }); stop.abort(); await rejected;
  }
});

test('Kimi discovery reports actual API capability/capacity; GLM official seeds clearly identify documentation and custom endpoints never inherit them', async () => {
  const catalog = new ModelCatalog(), calls = [];
  const kimi = await catalog.list({ provider: 'kimi', apiKey: key, fetchImpl: async (url, options) => { calls.push({ url, options }); return Response.json({ data: [
    { id: 'kimi-k3.1-pro', context_length: 262144, supports_image_in: true, supports_reasoning: true }] }); } });
  assert.equal(kimi.source, 'api'); assert.equal(calls[0].url, 'https://api.moonshot.cn/v1/models'); assert.equal(kimi.models[0].contextWindow, 262144);
  assert.equal(kimi.models[0].supportsImages, true); assert.deepEqual(kimi.models[0].reasoningEfforts, ['low', 'high', 'max']);
  const glm = await catalog.list({ provider: 'glm', apiKey: key, fetchImpl: () => { throw Error('No /models route should be called'); } });
  assert.equal(glm.source, 'official-docs'); assert.equal(glm.models.length, 4); assert.equal(glm.models[0].contextWindow, undefined);
  const custom = await catalog.list({ provider: 'glm', baseUrl: 'https://custom.example/v1', apiKey: key,
    fetchImpl: async () => Response.json({ data: [{ id: 'glm-5.3' }] }) });
  assert.equal(custom.source, 'api'); assert.equal(custom.models[0].contextWindow, undefined); assert.equal(custom.models[0].reasoningEfforts, undefined);
});

test('Store keeps three Gemini modes and independent new API keys across restart, and never grants fake Kimi/GLM account auth', async t => {
  const location = await dir(t), store = new Store(location, crypto);
  await store.saveSettings({ provider: 'gemini', model: 'api-model', apiKey: 'gemini-key' });
  await store.saveSettings({ provider: 'gemini', authMode: 'gemini-account', model: 'cli-model' });
  await store.saveSettings({ provider: 'gemini', authMode: 'antigravity-agent', model: 'agent-model' });
  await store.saveSettings({ provider: 'kimi', model: 'kimi-k3.1-pro', apiKey: 'kimi-key' });
  await store.saveSettings({ provider: 'glm', model: 'glm-5.3', apiKey: 'glm-key' });
  const reopened = new Store(location, crypto); await reopened.init();
  assert.equal(reopened.publicSettings().apiProtocol, 'chat-completions'); assert.equal(reopened.publicSettings().providers.kimi.apiProtocol, 'responses');
  assert.deepEqual(reopened.publicSettings().providers.gemini.modelsByAuth, { apiKey: 'api-model', 'gemini-account': 'cli-model', 'antigravity-agent': 'agent-model' });
  for (const provider of ['kimi', 'glm']) { assert.equal(reopened.key(provider), `${provider}-key`); await assert.rejects(reopened.saveSettings({ provider, authMode: 'gemini-account' }), /登录方式/); }
  assert.equal(reopened.key('gemini'), 'gemini-key'); assert.doesNotMatch(JSON.stringify(reopened.publicSettings()), /kimi-key|glm-key|gemini-key|encryptedKey/);
  await assert.rejects(reopened.saveSettings({ provider: 'glm', apiProtocol: 'responses' }), /协议/);
});

test('legacy five/six-provider role schemas gain empty Kimi/GLM connections and an empty Antigravity model slot without lending keys', async t => {
  for (const withGemini of [false, true]) {
    const location = await dir(t), roles = await new RoleModels(location, crypto).init();
    await roles.save('sidebar', { provider: 'openai', model: 'old', apiKey: 'sidebar-private' });
    const file = path.join(location, 'role-models.json'), data = JSON.parse(await fs.readFile(file, 'utf8'));
    for (const role of Object.values(data.roles)) { delete role.settings.providers.kimi; delete role.settings.providers.glm;
      if (withGemini) delete role.settings.providers.gemini.modelsByAuth['antigravity-agent']; else delete role.settings.providers.gemini; }
    const legacy = JSON.stringify(data); await fs.writeFile(file, legacy);
    const latest = await new RoleModels(location, crypto).init(); assert.equal(latest.key('sidebar', 'openai'), 'sidebar-private');
    for (const provider of ['kimi', 'glm']) assert.equal(latest.key('sidebar', provider), '');
    assert.equal(latest.publicState().sidebar.settings.providers.gemini.modelsByAuth['antigravity-agent'], ''); assert.equal(await fs.readFile(file, 'utf8'), legacy);
    for (const operation of ['save', 'draft']) await assert.rejects(latest[operation]('pet', { provider: 'gemini', authMode: 'antigravity-agent', model: 'agent' }), { code: 'ROLE_MODELS_AGENT_UNSUPPORTED' });
    await latest.save('completion', { provider: 'kimi', model: 'kimi-k3.1-pro', apiKey: 'completion-key' });
    const reopened = await new RoleModels(location, crypto).init(); assert.equal(reopened.publicState().completion.settings.apiProtocol, 'responses'); assert.equal(reopened.key('completion', 'kimi'), 'completion-key');
  }
});

test('capacity/reviewer scopes isolate API providers and bind Antigravity to its own account identity and mode', () => {
  for (const helper of [modelCapacityConnectionKey, approvalReviewerConnectionKey]) {
    const api = { provider: 'kimi', authMode: 'apiKey', config: { baseUrl: 'https://api.moonshot.cn/v1', apiProtocol: 'responses' } };
    assert.notEqual(helper(api, key), helper({ ...api, provider: 'glm' }, key));
    const account = { provider: 'gemini', authMode: 'antigravity-agent', account: { session: { profileId: 'agent-a' } } };
    assert.notEqual(helper(account), helper({ ...account, authMode: 'gemini-account' }));
    assert.notEqual(helper(account), helper({ ...account, account: { session: { profileId: 'agent-b' } } }));
    assert.throws(() => helper({ ...account, provider: 'kimi' }));
  }
});

test('official Kimi/GLM Agent selections and regions remain separate from API models, URLs and encrypted keys after restart', async t => {
  const location = await dir(t), store = new Store(location, crypto);
  for (const [provider, region] of [['kimi', 'global'], ['glm', 'zai']]) {
    await store.saveSettings({ provider, authMode: 'apiKey', model: `${provider}-api`, apiKey: `${provider}-private`, baseUrl: 'https://custom.example/v1' });
    await store.saveSettings({ provider, authMode: `${provider}-agent`, region, model: `${provider}-native` });
    assert.equal(store.publicSettings().baseUrl, 'https://custom.example/v1'); assert.equal(store.key(provider), `${provider}-private`);
    await store.saveSettings({ provider, authMode: 'apiKey' }); assert.equal(store.publicSettings().model, `${provider}-api`);
    await store.saveSettings({ provider, authMode: `${provider}-agent` }); assert.equal(store.publicSettings().model, `${provider}-native`);
    const before = structuredClone(store.publicSettings()); await assert.rejects(store.saveSettings({ provider, region: provider === 'kimi' ? 'zai' : 'global' }), /账号区域/); assert.deepEqual(store.publicSettings(), before);
  }
  const restored = new Store(location, crypto); await restored.init();
  for (const [provider, region] of [['kimi', 'global'], ['glm', 'zai']]) {
    const settings = restored.publicSettings().providers[provider]; assert.deepEqual(settings.modelsByAuth, { apiKey: `${provider}-api`, [`${provider}-agent`]: `${provider}-native` });
    assert.equal(settings.region, region); assert.equal(settings.authMode, `${provider}-agent`); assert.equal(restored.key(provider), `${provider}-private`);
  }
  assert.doesNotMatch(JSON.stringify(restored.publicSettings()), /-private|encryptedKey/);
});

test('old eight-provider API settings migrate empty Agent slots and regions without borrowing keys or accepting Agent roles', async t => {
  const location = await dir(t), store = new Store(location, crypto); await store.saveSettings({ provider: 'kimi', model: 'legacy-kimi', apiKey: 'main-kimi' });
  const settingsFile = path.join(location, 'settings.json'), saved = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  for (const provider of ['kimi', 'glm']) { delete saved.providers[provider].authMode; delete saved.providers[provider].modelsByAuth; delete saved.providers[provider].region; }
  await fs.writeFile(settingsFile, JSON.stringify(saved)); const restored = new Store(location, crypto); await restored.init();
  assert.deepEqual(restored.publicSettings().providers.kimi.modelsByAuth, { apiKey: 'legacy-kimi', 'kimi-agent': '' }); assert.equal(restored.key('kimi'), 'main-kimi'); assert.equal(restored.key('glm'), '');
  const roles = await new RoleModels(location, crypto).init(); await roles.save('sidebar', { provider: 'kimi', model: 'legacy-role-kimi', apiKey: 'role-kimi' });
  const roleFile = path.join(location, 'role-models.json'), oldRoles = JSON.parse(await fs.readFile(roleFile, 'utf8'));
  for (const role of Object.values(oldRoles.roles)) for (const provider of ['kimi', 'glm']) { delete role.settings.providers[provider].authMode; delete role.settings.providers[provider].modelsByAuth; delete role.settings.providers[provider].region; }
  const raw = JSON.stringify(oldRoles); await fs.writeFile(roleFile, raw); const migrated = await new RoleModels(location, crypto).init();
  assert.equal(migrated.key('sidebar', 'kimi'), 'role-kimi'); assert.equal(migrated.key('sidebar', 'glm'), ''); assert.equal(migrated.publicState().sidebar.settings.providers.kimi.region, 'mainland-cn'); assert.equal(await fs.readFile(roleFile, 'utf8'), raw);
  for (const provider of ['kimi', 'glm']) for (const operation of ['save', 'draft']) await assert.rejects(migrated[operation]('pet', { provider, authMode: `${provider}-agent`, model: 'native' }), { code: 'ROLE_MODELS_AGENT_UNSUPPORTED' });
});

test('official Kimi/GLM Agent preference identities never alias API credentials, another provider or account generation', () => {
  for (const helper of [modelCapacityConnectionKey, approvalReviewerConnectionKey]) for (const provider of ['kimi', 'glm']) {
    const context = { provider, authMode: `${provider}-agent`, account: { session: { profileId: 'profile-one' } } };
    assert.notEqual(helper(context), helper({ ...context, account: { session: { profileId: 'profile-two' } } }));
    assert.notEqual(helper(context), helper({ provider, authMode: 'apiKey', config: { baseUrl: 'https://custom.example/v1', apiProtocol: 'responses' } }, key));
    assert.throws(() => helper({ ...context, provider: provider === 'kimi' ? 'glm' : 'kimi' }));
  }
});
