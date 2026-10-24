import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { prepareContext, contextCompressionPolicy } from '../src/core/context-compaction.mjs';
import { runAgent } from '../src/core/agent.mjs';

const { ModelCapacityPreferences, modelCapacityConnectionKey, modelCapacityScope, applyModelCapacity } =
  createRequire(import.meta.url)('../src/core/model-capacity-preferences.cjs');
const root = path.resolve('tests/.tmp');
const api = { provider: 'relay', authMode: 'apiKey', config: { baseUrl: 'https://relay.example/v1/', apiProtocol: 'responses' } };
const secret = 'model-capacity-private-api-key';
const connection = modelCapacityConnectionKey(api, secret), model = 'exact-configured-model';

async function fixture(t) {
  await fs.mkdir(root, { recursive: true });
  const dir = await fs.mkdtemp(path.join(root, 'model-capacity-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), root.toLowerCase());
    assert.ok(path.basename(dir).startsWith('model-capacity-'));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const preferences = await new ModelCapacityPreferences(dir).init();
  return { dir, preferences, file: path.join(dir, 'model-capacities.json') };
}

test('scope binds an exact model to a stable connection without persisting credentials or UI state', () => {
  assert.match(connection, /^[a-f\d]{64}$/u);
  assert.equal(connection, modelCapacityConnectionKey({ ...api, model: 'another', config: { ...api.config, baseUrl: 'https://relay.example/v1', contextWindow: 1000 } }, secret));
  assert.notEqual(connection, modelCapacityConnectionKey(api, 'another-key'));
  assert.notEqual(connection, modelCapacityConnectionKey({ ...api, provider: 'openai' }, secret));
  assert.notEqual(connection, modelCapacityConnectionKey({ ...api, config: { ...api.config, baseUrl: 'https://other.example/v1' } }, secret));
  assert.notEqual(connection, modelCapacityConnectionKey({ ...api, config: { ...api.config, apiProtocol: 'chat-completions' } }, secret));
  assert.notEqual(modelCapacityScope(connection, model), modelCapacityScope(connection, model.toUpperCase()));
  const account = { provider: 'openai', authMode: 'chatgpt', account: { session: { profileId: 'local-profile-a', status: 'connected', sharing: true } } };
  const accountKey = modelCapacityConnectionKey(account);
  assert.equal(accountKey, modelCapacityConnectionKey({ ...account, config: { baseUrl: 'https://unused.example' },
    account: { session: { profileId: 'local-profile-a', status: 'reauth_required', sharing: false } } }, 'ignored-token'));
  assert.notEqual(accountKey, modelCapacityConnectionKey({ ...account, account: { session: { profileId: 'local-profile-b' } } }));
  assert.notEqual(accountKey, modelCapacityConnectionKey({ provider: 'deepseek', authMode: 'deepseek-account', account: account.account }));
  assert.throws(() => modelCapacityConnectionKey({ ...account, account: { session: {} } }), { code: 'MODEL_CAPACITY_INVALID_CONNECTION' });
});

test('manual capacities persist by connection and exact model, reset independently, and never read the legacy global trigger', async t => {
  const { dir, preferences, file } = await fixture(t);
  await fs.writeFile(path.join(dir, 'preferences.json'), JSON.stringify({ version: 2, textScale: 120, contextCompressionTriggerTokens: 850000 }));
  assert.equal(preferences.get(connection, model), null);
  await preferences.set(connection, model, 128000);
  await preferences.set(connection, 'another-model', 64000);
  const anotherConnection = modelCapacityConnectionKey(api, 'different-user-key');
  assert.equal(preferences.get(anotherConnection, model), null);
  const restored = await new ModelCapacityPreferences(dir).init();
  assert.equal(restored.get(connection, model), 128000);
  assert.equal(restored.get(connection, 'another-model'), 64000);
  const stored = await fs.readFile(file, 'utf8');
  for (const privateValue of [secret, model, 'relay.example', 'different-user-key', '850000']) assert.equal(stored.includes(privateValue), false);
  await restored.reset(connection, model);
  assert.equal(restored.get(connection, model), null);
  assert.equal(restored.get(connection, 'another-model'), 64000);
  const reopened = await new ModelCapacityPreferences(dir).init();
  assert.equal(reopened.get(connection, model), null);
});

test('invalid values, stale-invalid identities and capacities above a known limit cannot change a saved preference', async t => {
  const { preferences, file } = await fixture(t);
  await preferences.set(connection, model, 64000);
  const original = await fs.readFile(file, 'utf8');
  for (const value of [undefined, 0, 999, 16000001, -1, 1000.5, '128000', NaN, Infinity])
    await assert.rejects(preferences.set(connection, model, value), { code: 'MODEL_CAPACITY_INVALID_VALUE' });
  await assert.rejects(preferences.set(connection, model, 128001, { advertisedTokens: 128000 }), { code: 'MODEL_CAPACITY_ABOVE_LIMIT' });
  await assert.rejects(preferences.set('invalid-connection', model, 128000), { code: 'MODEL_CAPACITY_INVALID_CONNECTION' });
  await assert.rejects(preferences.set(connection, ' model ', 128000), { code: 'MODEL_CAPACITY_INVALID_MODEL' });
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('a failed atomic save preserves prior memory and does not poison later queued writes', async t => {
  const { dir, preferences, file } = await fixture(t);
  await preferences.set(connection, model, 64000);
  await fs.rename(file, `${file}.backup`); await fs.mkdir(file);
  await assert.rejects(preferences.set(connection, model, 128000), { code: 'MODEL_CAPACITY_SAVE_FAILED' });
  assert.equal(preferences.get(connection, model), 64000);
  await fs.rmdir(file); await fs.rename(`${file}.backup`, file);
  await Promise.all([preferences.set(connection, model, 128000), preferences.set(connection, 'other', 256000)]);
  await preferences.settled();
  const restored = await new ModelCapacityPreferences(dir).init();
  assert.equal(restored.get(connection, model), 128000); assert.equal(restored.get(connection, 'other'), 256000);
  assert.equal((await fs.readdir(dir)).some(name => name.endsWith('.tmp')), false);
});

test('malformed saved preferences are preserved during startup and cannot advertise a made-up capacity', async t => {
  const { dir, file } = await fixture(t), damaged = '{invalid-capacity-json';
  await fs.writeFile(file, damaged);
  const preferences = await new ModelCapacityPreferences(dir).init();
  assert.equal(preferences.get(connection, model), null);
  assert.equal(await fs.readFile(file, 'utf8'), damaged);
  assert.equal(applyModelCapacity().modelCapacity.capacityTokens, null);
});

test('manual unknown capacities become total windows and real catalog limits remain authoritative', () => {
  const unknown = applyModelCapacity({ capabilities: { supportsImages: true }, manualTokens: 128000 });
  assert.deepEqual(unknown.modelCapacity, { capacityTokens: 128000, advertisedTokens: null, manualTokens: 128000,
    source: 'manual', limitKind: 'total', capacityOrigin: 'manual', advertisedOrigin: 'unknown', sourceLabel: '手动设置',
    sourceDescription: '手动设置的上下文容量，仅适用于当前连接和型号；服务商实际限制仍然适用。',
    compressionTriggerTokens: 102400, manualClamped: false });
  assert.equal(unknown.capabilities.contextWindow, 128000); assert.equal(unknown.capabilities.supportsImages, true);
  const original = { contextWindow: 64000, contextWindowKind: 'input', supportsTools: true };
  const narrower = applyModelCapacity({ capabilities: original, manualTokens: 32000 });
  assert.equal(narrower.capabilities.contextWindow, 32000); assert.equal(narrower.capabilities.contextWindowKind, 'input');
  const clamped = applyModelCapacity({ capabilities: original, manualTokens: 128000 });
  assert.equal(clamped.modelCapacity.capacityTokens, 64000); assert.equal(clamped.modelCapacity.manualClamped, true);
  assert.deepEqual(original, { contextWindow: 64000, contextWindowKind: 'input', supportsTools: true });
  const reset = applyModelCapacity({ capabilities: original, manualTokens: null });
  assert.equal(reset.modelCapacity.source, 'catalog'); assert.equal(reset.capabilities.contextWindow, 64000);
  assert.notEqual(reset.capabilities.contextWindowPreferenceKey, clamped.capabilities.contextWindowPreferenceKey);
  const unset = applyModelCapacity({ capabilities: {}, manualTokens: null });
  assert.equal(unset.modelCapacity.capacityTokens, null); assert.equal(unset.modelCapacity.source, 'unknown');
  assert.equal(unset.modelCapacity.compressionTriggerTokens, 45000);
});

test('capacity descriptions distinguish account input ceilings, public defaults, Ollama configuration and manual values without changing limits', () => {
  for (const [origin, kind, label, phrase] of [
    ['provider', 'total', '服务商返回', '服务商接口返回的上下文容量'],
    ['account', 'input', '账号接口返回', '账号接口返回的输入上限'],
    ['account', 'total', '账号接口返回', '账号接口返回的上下文容量'],
    ['official-default', 'total', '官方型号默认', '不代表当前账号一定可用'],
    ['ollama', 'total', 'Ollama 运行配置', '受模型训练容量约束'],
  ]) {
    const capabilities = { contextWindow: 500000, contextWindowKind: kind, contextWindowOrigin: origin };
    const automatic = applyModelCapacity({ capabilities }).modelCapacity;
    assert.equal(automatic.capacityTokens, 500000); assert.equal(automatic.capacityOrigin, origin);
    assert.equal(automatic.advertisedOrigin, origin); assert.equal(automatic.sourceLabel, label);
    assert.ok(automatic.sourceDescription.includes(phrase)); assert.equal(automatic.limitKind, kind);
    const manual = applyModelCapacity({ capabilities, manualTokens: 1000000 }).modelCapacity;
    assert.equal(manual.capacityTokens, 500000); assert.equal(manual.manualClamped, true);
    assert.equal(manual.capacityOrigin, 'manual'); assert.equal(manual.advertisedOrigin, origin);
    assert.equal(manual.limitKind, kind); assert.equal(manual.sourceLabel, '手动设置');
    assert.ok(manual.sourceDescription.includes('服务商实际限制仍然适用'));
  }
  const invalid = applyModelCapacity({ capabilities: { contextWindow: 1000000, contextWindowOrigin: 'PRIVATE_METADATA' } });
  assert.equal(invalid.modelCapacity.capacityOrigin, 'provider'); assert.equal(invalid.capabilities.contextWindowOrigin, 'provider');
  assert.equal(JSON.stringify(invalid).includes('PRIVATE_METADATA'), false);
  const unknown = applyModelCapacity().modelCapacity;
  assert.equal(unknown.capacityOrigin, 'unknown'); assert.equal(unknown.sourceDescription, '当前模型未提供容量，可在下方填写。');
});

test('the effective capacity drives compression rather than the old 850000 absolute trigger or unknown character guard', async () => {
  for (const capacity of [128000, 2000000]) {
    const applied = applyModelCapacity({ capabilities: {}, manualTokens: capacity });
    const policy = contextCompressionPolicy({ modelCapabilities: applied.capabilities, contextCompressionTriggerTokens: applied.modelCapacity.capacityTokens });
    assert.equal(policy.effectiveTriggerTokens, Math.floor(capacity * 0.8));
  }
  const messages = [{ role: 'user', content: 'Keep the real task and constraints.' },
    { role: 'assistant', content: 'Working.', toolCalls: [{ id: 'read', name: 'read_file', arguments: { path: 'file.js' } }] },
    { role: 'tool', toolCallId: 'read', content: 'X'.repeat(230000) }];
  const original = structuredClone(messages);
  const applied = applyModelCapacity({ manualTokens: 128000 });
  const roomy = await prepareContext({ messages, modelCapabilities: applied.capabilities,
    contextCompressionTriggerTokens: applied.modelCapacity.capacityTokens,
    summarize: () => assert.fail('A valid manual capacity must replace the unknown-model 45k/character guard') });
  assert.equal(roomy.compacted, false); assert.equal(roomy.metadata.effectiveTriggerTokens, 102400);
  const small = applyModelCapacity({ manualTokens: 64000 });
  const bounded = await prepareContext({ messages, modelCapabilities: small.capabilities,
    contextCompressionTriggerTokens: small.modelCapacity.capacityTokens, summarize: async () => 'Task and constraints retained, file read, work pending.' });
  assert.equal(bounded.compacted, true); assert.equal(bounded.metadata.effectiveTriggerTokens, 51200);
  assert.deepEqual(messages, original);
});

test('resetting a manual capacity during a run cannot resurrect the old manual window from the temporary catalog cache', async () => {
  let manualTokens = 2000000, normal = 0, summaries = 0;
  const messages = [{ role: 'user', content: 'Inspect the real project.' }];
  const current = () => {
    const applied = applyModelCapacity({ manualTokens });
    return { provider: 'relay', authMode: 'apiKey', model, apiKey: secret, baseUrl: 'https://relay.example/v1',
      connectionKey: 'same-account-and-model', permissionMode: 'full', modelCapabilities: applied.capabilities,
      contextCompressionTriggerTokens: applied.modelCapacity.capacityTokens ?? 850000 };
  };
  await runAgent({ config: current(), getRequestConfig: async () => current(), messages,
    toolDefinitions: [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } }],
    workspace: { root: 'C:/fixture', execute: async () => { manualTokens = null; return 'X'.repeat(230000); } },
    signal: new AbortController().signal, emit() {}, requestModel: async request => {
      if (request.messages[0].content.startsWith('[CONTEXT_COMPACTION]')) {
        summaries++; return { message: { role: 'assistant', content: 'Task retained; file read and work pending.', toolCalls: [] }, usage: { inputTokens: 10, outputTokens: 10 } };
      }
      const toolCalls = ++normal === 1 ? [{ id: 'read', name: 'read_file', arguments: { path: 'file.js' } }] : [];
      return { message: { role: 'assistant', content: 'Working.', toolCalls }, usage: { inputTokens: 10, outputTokens: 10 } };
    } });
  assert.equal(normal, 2); assert.equal(summaries, 1);
  assert.equal(messages.find(message => message.role === 'tool').content.length, 230000);
});
