import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { requestModel } from '../src/core/providers.mjs';
import { ModelCatalog, deriveModelCapabilities } from '../src/core/model-catalog.mjs';
import { DOUBAO_BASE_URL, DOUBAO_DOC_MODELS } from '../src/core/doubao-contracts.mjs';
const require = createRequire(import.meta.url), { Store } = require('../src/core/store.cjs'), { RoleModels, ROLE_KEYS } = require('../src/core/role-models.cjs');
const apiKey = 'doubao-local-fixture-secret', model = 'doubao-seed-2-1-pro-260915';
const messages = [{ role: 'user', content: 'Read file' }];
const tools = [{ name: 'read_file', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
const native = { role: 'assistant', content: 'Reading', reasoning_content: 'private summary', encrypted_content: 'opaque-signed-thought',
  tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'read_file', arguments: '{"path":"one.txt"}' } }] };
const chat = (message = native) => ({ choices: [{ message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 30, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 4 } } });
function fixture(extra = {}, reply = () => Response.json(chat())) {
  const calls = [], deltas = [];
  return { calls, deltas, request: input => requestModel({ provider: 'doubao', model, apiKey, messages, tools,
    connectionKey: 'doubao-test-connection', onTextDelta: value => deltas.push(value),
    fetchImpl: async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return reply(); }, ...extra, ...input }) };
}
const crypto = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(`encrypted:${value}`), decryptString: value => value.toString().slice(10) };
const root = path.resolve('tests/.tmp');
async function directory(t) {
  await fs.mkdir(root, { recursive: true }); const dir = await fs.mkdtemp(path.join(root, 'doubao-'));
  t.after(async () => { assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), root.toLowerCase()); assert.ok(path.basename(dir).startsWith('doubao-')); await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

test('Doubao uses official Ark Chat with bearer auth, exact model, tools and native output limit', async () => {
  const f = fixture(); const result = await f.request({ reasoningEffort: 'high', maxOutputTokens: 2000 });
  assert.equal(f.calls[0].url, `${DOUBAO_BASE_URL}/chat/completions`);
  assert.equal(f.calls[0].options.headers.Authorization, `Bearer ${apiKey}`);
  assert.equal(f.calls[0].body.model, model); assert.equal(f.calls[0].body.reasoning_effort, 'high');
  assert.equal(f.calls[0].body.max_completion_tokens, 2000); assert.equal(f.calls[0].body.max_tokens, undefined);
  assert.deepEqual(f.calls[0].body.tools[0], { type: 'function', function: tools[0] });
  assert.deepEqual(result.usage, { inputTokens: 30, outputTokens: 10, cachedInputTokens: 4 });
  assert.equal(f.deltas.join(''), 'Reading'); assert.equal(result.message.providerState.provider, 'doubao');
  assert.equal(result.message.providerState.message.encrypted_content, native.encrypted_content);
  assert.equal(JSON.stringify(result).includes(apiKey), false);
});

test('Doubao preserves encrypted thought and tool history once, and binds replay to provider/model/connection', async () => {
  const f = fixture(); const first = await f.request();
  const history = [...messages, first.message, { role: 'tool', toolCallId: 'call-one', content: 'file contents' }];
  await f.request({ messages: history });
  assert.deepEqual(f.calls[1].body.messages[1], native); assert.equal(f.calls[1].body.messages.filter(value => value.tool_calls).length, 1);
  for (const patch of [{ model: 'ep-other' }, { apiKey: 'other-key' }, { connectionKey: 'other' }, { baseUrl: 'https://gateway.example/v3' }])
    await assert.rejects(f.request({ ...patch, messages: history }), { code: 'PROVIDER_NATIVE_STATE_MISMATCH' });
  const changed = structuredClone(first.message); changed.content = 'tampered';
  await assert.rejects(f.request({ messages: [...messages, changed] }), { code: 'PROVIDER_NATIVE_STATE_MISMATCH' });
  const second = fixture({}, () => Response.json(chat({ role: 'assistant', content: 'Safe' })));
  await second.request({ messages: [...messages, { ...first.message, providerState: { ...first.message.providerState, provider: 'glm' } }] });
  assert.equal(second.calls[0].body.messages[1].encrypted_content, undefined);
});

test('Doubao stream assembles encrypted fragments, reasoning and tool JSON without exposing private fields', async () => {
  const frames = [
    { choices: [{ index: 0, delta: { reasoning_content: 'private ', encrypted_content: 'opaque-' } }] },
    { choices: [{ index: 0, delta: { reasoning_content: 'summary', encrypted_content: 'signed', content: 'Reading', tool_calls: [{ index: 0, id: 'call-one', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"one.txt"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 30, completion_tokens: 10 } },
  ];
  const f = fixture({}, () => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const result = await f.request();
  assert.equal(result.message.providerState.message.encrypted_content, 'opaque-signed');
  assert.equal(result.message.providerState.message.reasoning_content, 'private summary');
  assert.deepEqual(result.message.toolCalls[0].arguments, { path: 'one.txt' }); assert.equal(f.deltas.join(''), 'Reading');
});

test('Doubao sends normalized image input and rejects invalid protocol, guesses and secret reflection', async () => {
  const f = fixture(); await f.request({ messages: [{ role: 'user', content: 'Image', attachments: [{ dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2r8AAAAASUVORK5CYII=' }] }] });
  assert.equal(f.calls[0].body.messages[0].content[1].type, 'image_url');
  for (const patch of [{ apiProtocol: 'responses' }, { reasoningEffort: 'max' }, { reasoningEffort: 'none' }, { model: 'ep-user-model', reasoningEffort: 'high' }, { baseUrl: 'https://gateway.example/v3', reasoningEffort: 'high' }])
    await assert.rejects(f.request(patch), error => ['INVALID_API_PROTOCOL', 'INVALID_REASONING_EFFORT'].includes(error.code));
  await f.request({ model: 'ep-user-model' }); assert.equal(f.calls.at(-1).body.model, 'ep-user-model');
  const secret = fixture({}, () => Response.json(chat({ role: 'assistant', content: 'Safe', encrypted_content: apiKey })));
  await assert.rejects(secret.request(), { code: 'PROVIDER_SECRET_IN_RESPONSE' });
});

test('Doubao cancellation settles ignored abort, and truncated or malformed tool responses cannot execute', async () => {
  const f = fixture({}, () => new Promise(() => {})), abort = new AbortController();
  const pending = f.request({ signal: abort.signal }); abort.abort(); await assert.rejects(pending, { name: 'AbortError' });
  const truncated = fixture({}, () => Response.json({ choices: [{ message: native, finish_reason: 'length' }] }));
  await assert.rejects(truncated.request(), { code: 'PROVIDER_TRUNCATED' });
  const malformed = fixture({}, () => Response.json(chat({ ...native, tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'read_file', arguments: '{' } }] })));
  await assert.rejects(malformed.request(), { code: 'INVALID_TOOL_ARGUMENTS' });
});

test('Doubao catalog is an explicit official documentation snapshot; custom gateway metadata stays separate', async () => {
  const catalog = new ModelCatalog(); let requests = 0;
  const result = await catalog.list({ provider: 'doubao', apiKey, fetchImpl: () => { requests++; throw Error('Must not guess a models endpoint'); } });
  assert.equal(requests, 0); assert.equal(result.source, 'official-docs'); assert.match(result.sourceUrl, /volcengine/);
  assert.deepEqual(result.models.map(value => value.id), DOUBAO_DOC_MODELS.map(value => value.id));
  assert.deepEqual(result.models[0].reasoningEfforts, ['minimal', 'low', 'medium', 'high']);
  assert.equal(result.models[0].contextWindowOrigin, 'official-default');
  assert.equal(result.models[0].defaultReasoningEffort, 'high');
  assert.equal(result.models[0].supportsImages, true); assert.equal(result.models[0].supportsTools, true);
  assert.deepEqual(deriveModelCapabilities('doubao', 'ep-custom'), {});
  const custom = await catalog.list({ provider: 'doubao', apiKey, baseUrl: 'https://gateway.example/v3', fetchImpl: async () => { requests++; return Response.json({ data: [{ id: model, supportsTools: false, supportsImages: false, context_window: 40000 }] }); } });
  assert.equal(custom.source, 'api'); assert.equal(custom.models[0].contextWindow, 40000); assert.equal(custom.models[0].supportsImages, false);
  assert.equal(custom.models[0].reasoningEfforts, undefined); assert.equal(requests, 1);
});

test('Store migrates Claude API and keeps API/account model slots and keys independent across restart', async t => {
  const dir = await directory(t), store = new Store(dir, crypto); await store.init();
  await store.saveSettings({ provider: 'anthropic', model: 'claude-api', apiKey: 'claude-key' });
  const before = structuredClone(store.settings); delete before.providers.doubao; delete before.providers.anthropic.authMode; delete before.providers.anthropic.modelsByAuth;
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify(before));
  const migrated = new Store(dir, crypto); await migrated.init();
  assert.equal(migrated.key('anthropic'), 'claude-key'); assert.equal(migrated.publicSettings().providers.anthropic.modelsByAuth.apiKey, 'claude-api');
  await migrated.saveSettings({ provider: 'anthropic', authMode: 'claude-agent', model: 'claude-official', reasoningEffort: '官方强度 / special' });
  await migrated.saveSettings({ provider: 'doubao', authMode: 'apiKey', model, apiKey });
  await migrated.saveSettings({ provider: 'doubao', authMode: 'ark-account', model: 'plan-model' });
  const reload = new Store(dir, crypto); await reload.init();
  assert.equal(reload.publicSettings().providers.anthropic.reasoningEffort, '官方强度 / special');
  assert.equal(reload.key('anthropic'), 'claude-key'); assert.equal(reload.key('doubao'), apiKey);
  await reload.saveSettings({ provider: 'doubao', authMode: 'apiKey' }); assert.equal(reload.publicSettings().model, model);
  await reload.saveSettings({ provider: 'anthropic', authMode: 'apiKey' }); assert.equal(reload.publicSettings().model, 'claude-api'); assert.equal(reload.publicSettings().reasoningEffort, 'default');
});

test('Store preserves bounded official agent reasoning identifiers, rejects malformed values and API impostors', async t => {
  const dir = await directory(t), store = new Store(dir, crypto); await store.init();
  for (const [provider, authMode] of [['gemini', 'antigravity-agent'], ['kimi', 'kimi-agent'], ['glm', 'glm-agent'], ['anthropic', 'claude-agent']]) {
    await store.saveSettings({ provider, authMode, reasoningEffort: '官方 / native-level-42' });
    const reload = new Store(dir, crypto); await reload.init(); assert.equal(reload.publicSettings().reasoningEffort, '官方 / native-level-42');
    for (const reasoningEffort of ['', ' x ', 'x'.repeat(129), 'bad\nvalue']) await assert.rejects(store.saveSettings({ provider, authMode, reasoningEffort }));
    await assert.rejects(store.saveSettings({ provider, authMode: 'apiKey', reasoningEffort: '官方 / native-level-42' }));
  }
});

test('legacy role settings gain empty Doubao and Claude auth slots without losing independent credentials', async t => {
  const dir = await directory(t), roles = new RoleModels(dir, crypto); await roles.init();
  await roles.save('approval', { provider: 'anthropic', model: 'claude-role', apiKey: 'role-private' });
  const file = path.join(dir, 'role-models.json'), old = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const role of ROLE_KEYS) { delete old.roles[role].settings.providers.doubao; delete old.roles[role].settings.providers.anthropic.authMode; delete old.roles[role].settings.providers.anthropic.modelsByAuth; }
  await fs.writeFile(file, JSON.stringify(old)); const reload = new RoleModels(dir, crypto); await reload.init();
  assert.equal(reload.isEnabled('approval'), true); assert.equal(reload.key('approval', 'anthropic'), 'role-private');
  assert.equal(reload.publicState().approval.settings.model, 'claude-role'); assert.equal(reload.publicState().approval.settings.providers.doubao.hasKey, false);
  for (const [provider, authMode] of [['anthropic', 'claude-agent'], ['doubao', 'ark-account']])
    await assert.rejects(reload.save('completion', { provider, authMode, model: 'account-model' }), { code: 'ROLE_MODELS_AGENT_UNSUPPORTED' });
  await reload.save('completion', { provider: 'doubao', model, apiKey });
  const final = new RoleModels(dir, crypto); await final.init(); assert.equal(final.key('completion', 'doubao'), apiKey); assert.equal(final.key('approval', 'anthropic'), 'role-private');
});


test('official Ark Plan endpoints use Chat and new account preferences are isolated by provider and profile', async () => {
  for (const prefix of ['/api/plan/v3', '/api/coding/v3']) {
    const f = fixture({ baseUrl: `https://ark.cn-beijing.volces.com${prefix}` });
    await f.request({ reasoningEffort: 'high' }); assert.equal(f.calls[0].url, `https://ark.cn-beijing.volces.com${prefix}/chat/completions`);
  }
  const { modelCapacityConnectionKey } = require('../src/core/model-capacity-preferences.cjs');
  const { approvalReviewerConnectionKey } = require('../src/core/approval-reviewer-preferences.cjs');
  for (const keyFor of [modelCapacityConnectionKey, approvalReviewerConnectionKey]) {
    const account = (provider, authMode, profileId = 'profile-a') => ({ provider, authMode, account: { session: { profileId } } });
    const ark = keyFor(account('doubao', 'ark-account')), claude = keyFor(account('anthropic', 'claude-agent'));
    assert.match(ark, /^[a-f\d]{64}$/u); assert.notEqual(ark, claude);
    assert.notEqual(ark, keyFor(account('doubao', 'ark-account', 'profile-b')));
    assert.throws(() => keyFor(account('openai', 'ark-account')));
    assert.notEqual(ark, keyFor({ provider: 'doubao', authMode: 'apiKey', config: { baseUrl: DOUBAO_BASE_URL, apiProtocol: 'chat-completions' } }, apiKey));
  }
});


test('Doubao usage and native session state survive restart while all legacy API keys remain intact', async t => {
  const dir = await directory(t), store = new Store(dir, crypto); await store.init();
  const oldProviders = Object.keys(store.settings.providers).filter(value => value !== 'doubao');
  for (const provider of oldProviders) await store.saveSettings({ provider, model: `${provider}-model`,
    ...(provider === 'relay' ? { baseUrl: 'https://relay.example/v1' } : {}), apiKey: `old-private-${provider}` });
  const old = structuredClone(store.settings); delete old.providers.doubao; delete old.providers.anthropic.authMode; delete old.providers.anthropic.modelsByAuth;
  await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify(old));
  const migrated = new Store(dir, crypto); await migrated.init();
  for (const provider of oldProviders) assert.equal(migrated.key(provider), `old-private-${provider}`);
  assert.equal(migrated.key('doubao'), '');
  await migrated.saveSettings({ provider: 'doubao', apiKey, model });
  const first = await fixture().request(), session = migrated.createSession('C:/doubao-project');
  session.provider = 'doubao'; session.model = model; session.messages.push(...messages, first.message);
  await migrated.saveSession(session);
  await migrated.recordUsage({ id: randomUUID(), timestamp: '2026-10-26T01:00:00Z', provider: 'doubao', model,
    sessionId: session.id, runId: 'doubao-run', inputTokens: 30, outputTokens: 10, cachedInputTokens: 4, reported: true, status: 'completed' });
  const reloaded = new Store(dir, crypto); await reloaded.init();
  const restored = await reloaded.getSession(session.id);
  assert.deepEqual(restored.messages[1].providerState, first.message.providerState);
  assert.equal(reloaded.usage.records[0].provider, 'doubao'); assert.equal(reloaded.usage.records[0].cachedInputTokens, 4);
  assert.equal(JSON.stringify(restored).includes(apiKey), false);
  for (const provider of oldProviders) assert.equal(reloaded.key(provider), `old-private-${provider}`);
});
