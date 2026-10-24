import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { listModels } from '../src/vendor/siwc/models.js';
import { ChatGPTConnection } from '../src/core/chatgpt.mjs';
import { deriveModelCapabilities } from '../src/core/model-catalog.mjs';
import { prepareContext, contextCompressionPolicy } from '../src/core/context-compaction.mjs';
import { captureContextMeasurement, estimateRequestTokens } from '../src/core/context-usage.mjs';
import { runAgent } from '../src/core/agent.mjs';

const model = 'gpt-6.1-sol';
const state = { status: 'connected', sharing: true, profileId: 'local-fixture-profile' };
const cryptography = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
const tools = [{ name: 'read_file', description: 'Read', parameters: { type: 'object' } },
  { name: 'browser_snapshot', description: 'Read visible text', parameters: { type: 'object' } }];
const transcript = size => [{ role: 'user', content: '修复当前程序，保留用户修改。' },
  { role: 'assistant', content: '读取项目。', toolCalls: [{ id: 'read-one', name: 'read_file', arguments: { path: 'fixture.js' } }] },
  { role: 'tool', toolCallId: 'read-one', content: 'CODE_RESULT\n' + 'X'.repeat(size) }];

function mockClient() {
  return { getSession: async () => state, listProfiles: async () => [],
    subscribe: listener => { listener(state); return () => {}; },
    signIn: async () => state, cancelSignIn() {}, selectProfile: async () => state, disconnect: async () => {},
    listModels: () => listModels('fixture-account-credential', new AbortController().signal),
    withAccessToken: operation => operation('fixture-account-credential', new AbortController().signal) };
}

test('official GPT-6.1-Sol keeps its verified capacity through SDK, main-process sanitizer and the compression budget', async t => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/models'); assert.equal(init.headers.authorization, 'Bearer fixture-account-credential');
    return Response.json({ models: [{ slug: model, display_name: 'GPT-6.1-Sol', visibility: 'list' },
      { slug: 'future-official-model', display_name: 'Future', visibility: 'list', context_window: 256000,
        accessToken: 'MUST_NOT_BE_PUBLIC', capabilities: { arbitrary: 'MUST_NOT_BE_PUBLIC' } },
      { slug: 'input-only', display_name: 'Input', visibility: 'list', max_input_tokens: 64000 },
      { slug: 'invalid-capacity', display_name: 'Invalid', visibility: 'list', context_window: '1000000' }] });
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const connection = new ChatGPTConnection({ dataDir: path.resolve('tests/.tmp/metadata-only-mock'), safeStorage: cryptography,
    createClient: async () => mockClient(), openExternal: async () => {} });
  await connection.init();
  const models = await connection.listModels();
  const sol = models.find(value => value.slug === model);
  assert.equal(sol.contextWindow, 1050000); assert.equal(sol.contextWindowKind, 'total');
  assert.equal(models.find(value => value.slug === 'future-official-model').contextWindow, 256000);
  assert.equal(models.find(value => value.slug === 'input-only').contextWindowKind, 'input');
  assert.equal(models.find(value => value.slug === 'invalid-capacity').contextWindow, undefined);
  assert.equal(JSON.stringify(models).includes('MUST_NOT_BE_PUBLIC'), false);
  assert.equal(JSON.stringify(await connection.publicState()).includes('fixture-account-credential'), false);
  const capabilities = deriveModelCapabilities('openai', model, { ...sol, officialSource: true });
  const policy = contextCompressionPolicy({ modelCapabilities: capabilities });
  assert.equal(policy.effectiveTriggerTokens, 840000); assert.equal(policy.triggerClampReason, 'model-capacity');
  assert.equal(Object.hasOwn(policy, 'fallbackGuardTokens'), false);
  const messages = transcript(230000), original = structuredClone(messages);
  const prepared = await prepareContext({ messages, tools, modelCapabilities: capabilities,
    summarize: () => assert.fail('This moderate first-turn tool history must not use the 45k unknown-model guard') });
  assert.equal(prepared.compacted, false); assert.equal(prepared.metadata.contextLimit, 1050000);
  assert.equal(prepared.metadata.effectiveTriggerTokens, 840000); assert.deepEqual(messages, original);
});

test('exact official model fallbacks respect explicit service capacities and never apply to proxies or unknown IDs', () => {
  for (const id of [model, 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol']) {
    assert.equal(deriveModelCapabilities('openai', id, { officialSource: true }).contextWindow, 1050000);
    assert.equal(deriveModelCapabilities('openai', id).contextWindow, undefined);
    assert.equal(deriveModelCapabilities('relay', id, { officialSource: true }).contextWindow, undefined);
    for (const capacity of [128000, 2000000])
      assert.equal(deriveModelCapabilities('openai', id, { officialSource: true, context_window: capacity }).contextWindow, capacity);
    assert.equal(deriveModelCapabilities('openai', id, { officialSource: true, allowPublishedContextWindow: false }).contextWindow, undefined);
    assert.equal(deriveModelCapabilities('openai', id, { officialSource: true, allowPublishedContextWindow: false, context_window: 128000 }).contextWindow, 128000);
  }
  assert.deepEqual(deriveModelCapabilities('openai', model, { officialSource: true, allowPublishedContextWindow: false }).reasoningEfforts,
    ['low', 'medium', 'high', 'xhigh', 'max']);
  const input = deriveModelCapabilities('openai', model, { officialSource: true, max_input_tokens: 64000 });
  assert.equal(input.contextWindow, 64000); assert.equal(input.contextWindowKind, 'input');
  for (const id of ['gpt-6.1-sol-next', 'gpt-6.1-sol-custom', 'unverified-future-model']) {
    const unknown = deriveModelCapabilities('openai', id, { officialSource: true });
    assert.equal(unknown.contextWindow, undefined);
    assert.equal(contextCompressionPolicy({ modelCapabilities: unknown }).effectiveTriggerTokens, 45000);
  }
});

test('the first user round can read four files and two page snapshots below the real GPT-6.1-Sol threshold', async () => {
  const events = [], records = [], samples = [], messages = [{ role: 'user', content: '检查当前程序并修复问题。' }]; let requests = 0;
  const config = { provider: 'openai', authMode: 'chatgpt', model, baseUrl: 'https://api.openai.com/v1',
    connectionKey: 'fixture-account-generation', permissionMode: 'full',
    modelCapabilities: deriveModelCapabilities('openai', model, { officialSource: true }) };
  await runAgent({ config, getRequestConfig: async () => config, messages, tools, toolDefinitions: tools,
    workspace: { root: 'C:/fixture', execute: async name => name === 'browser_snapshot' ? 'VISIBLE_PAGE_TEXT\n' + 'W'.repeat(24000) : 'CODE_RESULT\n' + 'X'.repeat(45000) },
    signal: new AbortController().signal, emit: event => events.push(event), onContextUsage: value => samples.push(value),
    onUsage: async value => records.push(value), requestModel: async request => {
      assert.equal(request.messages[0].content.startsWith('[CONTEXT_COMPACTION]'), false);
      const toolCalls = ++requests === 1 ? Array.from({ length: 6 }, (_, index) => ({ id: `read-${index}`,
        name: index < 4 ? 'read_file' : 'browser_snapshot', arguments: index < 4 ? { path: `fixture-${index}.js` } : {} })) : [];
      return { message: { role: 'assistant', content: toolCalls.length ? '检查文件和网页。' : '检查完成。', toolCalls },
        usage: { inputTokens: estimateRequestTokens(request.messages, request.tools), outputTokens: 120 }, usageReported: true };
    } });
  assert.equal(requests, 2); assert.equal(messages.filter(value => value.role === 'user').length, 1);
  assert.equal(messages.filter(value => value.role === 'tool').length, 6);
  assert.equal(events.some(event => event.type === 'context-compaction-start'), false);
  assert.equal(records.some(value => value.purpose === 'context-compaction'), false);
  assert.ok(samples.every(value => value.effectiveTriggerTokens === 840000));
});

test('a real near-capacity measured context still compacts within the first round without rewriting the archive', async () => {
  const modelCapabilities = deriveModelCapabilities('openai', model, { officialSource: true });
  const config = { provider: 'openai', authMode: 'chatgpt', model, modelCapabilities };
  const prefix = transcript(4000), messages = [...prefix, { role: 'user', source: 'steering', content: '继续完成当前任务。' }];
  const original = structuredClone(messages);
  const contextMeasurement = captureContextMeasurement({ config, messages: prefix, tools, inputTokens: 830000, outputTokens: 10000 });
  let summaries = 0;
  const prepared = await prepareContext({ messages, modelCapabilities, tools, contextMeasurement,
    summarize: async () => { summaries++; return '原始任务、用户约束与文件检查结果保留；待完成当前修复。'; } });
  assert.equal(prepared.compacted, true); assert.equal(summaries, 1);
  assert.equal(prepared.metadata.effectiveTriggerTokens, 840000);
  assert.equal(prepared.metadata.reportedContextTokens, 840000);
  assert.deepEqual(messages, original);
});
