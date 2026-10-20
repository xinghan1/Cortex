import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareContext, contextCompressionPolicy, DEFAULT_CONTEXT_COMPRESSION_TRIGGER_TOKENS } from '../src/core/context-compaction.mjs';
import { estimateContextTokens } from '../src/core/session-metrics.cjs';
import { runAgent } from '../src/core/agent.mjs';

const signal = () => new AbortController().signal;
const call = (id, name, args) => ({ id, name, arguments: args });
const history = (size = 40000) => [
  { role: 'user', content: '目标 GOAL：修改 src/example.js；约束 CONSTRAINT：保留用户改动。' },
  { role: 'assistant', content: '进度 PROGRESS：已读取原文件。', toolCalls: [call('read', 'read_file', { path: 'src/example.js' })] },
  { role: 'tool', toolCallId: 'read', content: '改动 CHANGE：新增校验。测试 TEST：一项失败。未完成 TODO：修复并重跑。\n' + 'X'.repeat(size) },
];
const reply = (content = 'Completed.', toolCalls = []) => ({ message: { role: 'assistant', content, toolCalls },
  usage: { inputTokens: 10, outputTokens: 2 }, usageReported: true });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const config = { provider: 'relay', apiProtocol: 'responses', apiKey: 'fixture-key', model: 'fixture-model', reasoningEffort: 'default',
  modelCapabilities: { contextWindow: 1000000 }, permissionMode: 'request', connectionKey: 'fixture-connection', configRevision: 1 };
const agentOptions = extra => ({ config, messages: [{ role: 'user', content: 'GOAL：修复 src/example.js，CONSTRAINT：保留用户修改。' }],
  workspace: { root: 'C:/fixture', execute: async () => 'ok' }, toolDefinitions: [], signal: signal(), emit: () => {}, ...extra });

test('default absolute trigger is 850000 and model/fallback guards clamp the requested target transparently', () => {
  assert.equal(DEFAULT_CONTEXT_COMPRESSION_TRIGGER_TOKENS, 850000);
  const roomy = contextCompressionPolicy({ modelCapabilities: { contextWindow: 2000000 } });
  assert.equal(roomy.requestedTriggerTokens, 850000); assert.equal(roomy.effectiveTriggerTokens, 850000);
  assert.equal(roomy.triggerClamped, false); assert.equal(roomy.compressionTriggerBasis, 'estimated-request-input');
  const small = contextCompressionPolicy({ modelCapabilities: { contextWindow: 64000 }, contextCompressionTriggerTokens: 16000000 });
  assert.equal(small.effectiveTriggerTokens, 51200); assert.equal(small.triggerClampReason, 'model-capacity');
  const unknown = contextCompressionPolicy({ contextCompressionTriggerTokens: 850000 });
  assert.equal(unknown.effectiveTriggerTokens, 45000); assert.equal(unknown.triggerClampReason, 'unknown-capacity');
  assert.equal(unknown.fallbackGuardTokens, 45000); assert.equal(Object.hasOwn(unknown, 'contextLimit'), false);
  assert.equal(contextCompressionPolicy({ modelCapabilities: { contextWindow: 64000 }, contextCompressionTriggerTokens: 10000 }).effectiveTriggerTokens, 10000);
  for (const invalid of [0, 999, 16000001, -1, 1000.1, '850000', NaN, Infinity, null])
    assert.throws(() => contextCompressionPolicy({ contextCompressionTriggerTokens: invalid }), { code: 'CONTEXT_INVALID_TRIGGER' });
});

test('the estimated next input triggers at the exact boundary and counts system and tool overhead', async () => {
  const messages = history(6000), original = structuredClone(messages), modelCapabilities = { contextWindow: 1000000 };
  const exact = estimateContextTokens(messages);
  assert.ok(exact >= 1000);
  assert.equal((await prepareContext({ messages, modelCapabilities, contextCompressionTriggerTokens: exact + 1,
    summarize: () => assert.fail('One token below the threshold must not charge for a summary') })).compacted, false);
  const atBoundary = await prepareContext({ messages, modelCapabilities, contextCompressionTriggerTokens: exact,
    summarize: async () => '目标与约束保留，已读 src/example.js，校验测试失败，待修复重跑。' });
  assert.equal(atBoundary.compacted, true); assert.equal(atBoundary.metadata.estimatedBeforeTokens, exact);
  assert.equal(atBoundary.metadata.effectiveTriggerTokens, exact);
  const small = history(16000), overhead = [{ role: 'system', content: 'S'.repeat(4000) }];
  const tools = [{ name: 'read_file', description: 'T'.repeat(1200), parameters: { type: 'object' } }];
  assert.equal((await prepareContext({ messages: small, modelCapabilities, contextCompressionTriggerTokens: 5000,
    summarize: () => assert.fail('Without overhead this input is below the threshold') })).compacted, false);
  const withOverhead = await prepareContext({ messages: small, modelCapabilities, systemMessages: overhead, tools,
    contextCompressionTriggerTokens: 5000, summarize: async () => 'Keep the goal, constraints and pending failed verification.' });
  assert.equal(withOverhead.compacted, true); assert.ok(withOverhead.metadata.estimatedBeforeTokens >= 5000);
  assert.ok(withOverhead.metadata.estimatedAfterTokens <= withOverhead.metadata.targetTokens);
  assert.deepEqual(messages, original);
});

test('unknown capacities retain conservative character guards while accepting a lower absolute token preference', async () => {
  const unknown = await prepareContext({ messages: history(190000), contextCompressionTriggerTokens: 16000000,
    summarize: async () => 'Keep goal, constraints, changes and failed verification.' });
  assert.equal(unknown.compacted, true); assert.equal(unknown.metadata.requestedTriggerTokens, 16000000);
  assert.equal(unknown.metadata.effectiveTriggerTokens, 45000);
  assert.equal(unknown.metadata.triggerChars, 180000); assert.equal(unknown.metadata.targetChars, 150000);
  assert.equal(unknown.metadata.triggerClampReason, 'unknown-capacity');
  assert.equal(Object.hasOwn(unknown.metadata, 'contextLimit'), false);
  const lower = await prepareContext({ messages: history(12000), contextCompressionTriggerTokens: 2000,
    summarize: async () => '任务和待验证事项保留。' });
  assert.equal(lower.compacted, true); assert.equal(lower.metadata.effectiveTriggerTokens, 2000);
  assert.equal(lower.metadata.triggerClamped, false);
});

test('fallback planning reserves a Chinese summary before retaining recent exact output', async () => {
  const messages = history(190000);
  messages.push({ role: 'assistant', content: 'Read a recent file.', toolCalls: [call('recent', 'read_file', { path: 'recent.js' })] },
    { role: 'tool', toolCallId: 'recent', content: 'Y'.repeat(100000) });
  const original = structuredClone(messages);
  const result = await prepareContext({ messages, summarize: async ({ maxSummaryChars }) => '摘'.repeat(maxSummaryChars) });
  assert.equal(result.compacted, true);
  assert.ok(result.metadata.estimatedAfterTokens <= result.metadata.targetTokens);
  assert.deepEqual(messages, original);
});

test('a low preference respects necessary instructions without failing valid requests or repeatedly billing summaries', async () => {
  const systemMessages = [{ role: 'system', content: 'S'.repeat(20000) }], modelCapabilities = { contextWindow: 1000000 };
  const short = [{ role: 'user', content: 'Keep this exact task.' }];
  const ordinary = await prepareContext({ messages: short, systemMessages, modelCapabilities, contextCompressionTriggerTokens: 1000,
    summarize: () => assert.fail('Immutable instructions alone must not force a paid summary') });
  assert.equal(ordinary.compacted, false); assert.equal(ordinary.metadata.triggerFloorApplied, true);
  assert.equal(ordinary.metadata.triggerClampReason, 'necessary-context');
  assert.ok(ordinary.metadata.effectiveTriggerTokens > 1000);
  assert.ok(ordinary.metadata.effectiveTriggerTokens <= 800000);
  const messages = history(50000), checkpoint = {};
  let summaries = 0;
  const request = { messages, checkpoint, systemMessages, modelCapabilities, contextCompressionTriggerTokens: 1000,
    summarize: async () => { summaries++; return '任务和约束保留，变更待测试。'; } };
  const first = await prepareContext(request);
  assert.equal(first.compacted, true); assert.equal(first.metadata.triggerFloorApplied, true);
  assert.equal((await prepareContext(request)).compacted, false);
  assert.equal(summaries, 1);
  await assert.rejects(prepareContext({ messages: history(40000), modelCapabilities: { contextWindow: 8000 },
    systemMessages: [{ role: 'system', content: 'S'.repeat(40000) }], contextCompressionTriggerTokens: 16000000,
    summarize: () => assert.fail('A preference cannot exceed the real model safety budget') }), { code: 'CONTEXT_COMPACTION_LIMIT' });
});

test('lowering a static threshold can rebuild a saved summary from the original transcript once', async () => {
  const messages = history(200000), original = structuredClone(messages), checkpoint = {};
  const common = { messages, checkpoint, modelCapabilities: { contextWindow: 1000000 } };
  await prepareContext({ ...common, contextCompressionTriggerTokens: 30000,
    summarize: async () => 'OLD_SUMMARY_ONLY_MARKER' + '摘'.repeat(10000) });
  assert.equal(checkpoint.count, 1);
  let calls = 0;
  const lower = { ...common, contextCompressionTriggerTokens: 5000, summarize: async ({ source }) => {
    calls++; assert.equal(source.includes('OLD_SUMMARY_ONLY_MARKER'), false);
    for (const marker of ['GOAL', 'CONSTRAINT', 'PROGRESS', 'CHANGE', 'TEST', 'TODO']) assert.ok(source.includes(marker));
    return '目标约束、文件改动、失败测试和未完成事项保留。';
  } };
  const result = await prepareContext(lower);
  assert.equal(result.compacted, true); assert.equal(checkpoint.count, 2);
  assert.equal(result.metadata.requestedTriggerTokens, 5000);
  assert.equal((await prepareContext(lower)).compacted, false); assert.equal(calls, 1);
  assert.deepEqual(messages, original);
});

test('a live threshold change applies at the next planning boundary without a revision bump and preserves summary content and ledger accuracy', async () => {
  let current = { ...config, contextCompressionTriggerTokens: 100000 }, normal = 0, summaries = 0;
  const records = [], contexts = [], messages = agentOptions({}).messages;
  await runAgent(agentOptions({ messages, getRequestConfig: async () => current,
    workspace: { root: 'C:/fixture', execute: async () => {
      current = { ...current, contextCompressionTriggerTokens: 5000 };
      return 'PROGRESS：完成 src/example.js 的 CHANGE，TEST：失败，TODO：修复后重跑。\n' + 'X'.repeat(120000);
    } },
    onUsage: async record => records.push(record), onContextUsage: value => contexts.push(value),
    requestModel: async request => {
      if (request.messages[0].content.startsWith('[CONTEXT_COMPACTION]')) {
        summaries++; assert.equal(request.contextCompressionTriggerTokens, 5000);
        assert.match(request.messages[0].content, /目标和约束.*进度|原任务目标和约束/s);
        for (const marker of ['GOAL', 'CONSTRAINT', 'PROGRESS', 'CHANGE', 'TEST', 'TODO']) assert.ok(request.messages[1].content.includes(marker));
        return reply('GOAL/CONSTRAINT 保留；CHANGE 已写，TEST 失败，TODO 修复重跑。');
      }
      if (++normal === 1) return reply('检查文件。', [call('read', 'read_file', { path: 'src/example.js' })]);
      assert.ok(request.messages.some(message => message.content.includes('自动压缩的历史资料')));
      return reply('已汇总实际进度。');
    },
  }));
  assert.equal(normal, 2); assert.equal(summaries, 1); assert.equal(records.length, 3);
  assert.equal(new Set(records.map(record => record.id)).size, 3);
  assert.equal(records.reduce((total, record) => total + record.inputTokens, 0), 30);
  assert.deepEqual(contexts.filter(value => value.status === 'estimated').map(value => value.requestedTriggerTokens), [100000, 5000]);
  assert.equal(messages.filter(message => message.role === 'user').length, 1);
  assert.ok(messages.find(message => message.role === 'tool').content.length > 120000);
});

test('reported or cumulative usage is not the next request trigger', async () => {
  let requests = 0;
  await runAgent(agentOptions({ config: { ...config, contextCompressionTriggerTokens: 10000 },
    requestModel: async request => {
      assert.equal(request.messages[0].content.startsWith('[CONTEXT_COMPACTION]'), false);
      if (++requests === 1) return { ...reply('', [call('read', 'read_file', { path: 'small.txt' })]),
        usage: { inputTokens: 800000, outputTokens: 1000 } };
      return reply();
    },
  }));
  assert.equal(requests, 2);
});

test('children follow a live threshold change while root context and accounting remain independent', async () => {
  let current = { ...config, contextCompressionTriggerTokens: 100000 }, parentRound = 0, childRound = 0, summaries = 0;
  const records = [], contexts = [];
  await runAgent(agentOptions({ getRequestConfig: async () => current, onUsage: async value => records.push(value), onContextUsage: value => contexts.push(value),
    subagentFactory: async () => ({ root: 'C:/fixture', execute: async () => {
      current = { ...current, contextCompressionTriggerTokens: 5000 };
      return 'Child result, verification pending.\n' + 'X'.repeat(120000);
    } }),
    requestModel: async request => {
      if (request.messages[0].content.startsWith('[CONTEXT_COMPACTION]')) {
        summaries++; assert.match(request.messages[1].content, /CHILD_TASK_MARKER/);
        return reply('Child inspected the fixture; validation remains pending.');
      }
      if (request.messages[0].content.includes('你是独立子智能体')) {
        if (++childRound === 1) return reply('', [call('child-read', 'read_file', { path: 'large.txt' })]);
        assert.equal(request.contextCompressionTriggerTokens, 5000); return reply('Child summary.');
      }
      if (++parentRound === 1) return reply('', [call('spawn', 'spawn_agent', { name: 'Inspector', task: 'CHILD_TASK_MARKER inspect fixture.' }), call('join', 'wait_agents', {})]);
      return reply('Combined result.');
    },
  }));
  assert.equal(summaries, 1);
  assert.equal(records.filter(record => record.agentId && record.purpose === 'context-compaction').length, 1);
  assert.equal(records.filter(record => !record.agentId && record.purpose === 'context-compaction').length, 0);
  assert.equal(records.length, 5);
  assert.equal(contexts.filter(value => value.status === 'estimated').length, 2);
});

test('cancelling a triggered summary preserves archive and checkpoint and records only the partial summary request', async () => {
  const controller = new AbortController(), entered = deferred(), messages = history(120000), original = structuredClone(messages), checkpoint = {}, records = [];
  const running = runAgent(agentOptions({ config: { ...config, contextCompressionTriggerTokens: 5000 }, messages, contextCheckpoint: checkpoint,
    signal: controller.signal, onUsage: async value => records.push(value), requestModel: async request => {
      assert.ok(request.messages[0].content.startsWith('[CONTEXT_COMPACTION]'));
      request.onProgress({ usage: { inputTokens: 13, outputTokens: 2 } }); entered.resolve();
      await new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }));
    },
  }));
  await entered.promise; controller.abort(new Error('Stop compression'));
  await assert.rejects(running, /Stop compression/);
  assert.deepEqual(messages, original); assert.deepEqual(checkpoint, {});
  assert.equal(records.length, 1); assert.equal(records[0].purpose, 'context-compaction');
  assert.equal(records[0].status, 'stopped'); assert.equal(records[0].inputTokens, 13); assert.equal(records[0].outputTokens, 2);
});
