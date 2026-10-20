import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(await readFile(new URL('../src/renderer/task-history.js', import.meta.url), 'utf8'), context);
const project = session => JSON.parse(JSON.stringify(context.ForgeTaskHistory.project(session)));
const record = { runId: 'parent', messageStartIndex: 0, messageIndex: 2, status: 'completed', elapsedMs: 5000 };
const messages = [{ role: 'user', content: '并行检查' }, { role: 'assistant', content: '正在检查' }, { role: 'assistant', content: '已完成' }];
const snapshot = (id, status = 'running') => ({ id, name: '检查 ' + id, task: '检查文件并返回总结', status,
  startedAt: '2026-10-20T12:00:00.000Z', endedAt: status === 'running' ? '' : '2026-10-20T12:00:02.000Z',
  elapsedMs: 2000, inputTokens: 100, outputTokens: 20, summary: status === 'running' ? '' : '检查通过', activity: [] });
const update = (agent, extras = {}) => ({ type: 'subagent-update', runId: 'parent', messageIndex: 1, agent, ...extras });
const eventList = session => project({ messages, taskRuns: [record], ...session }).find(item => item.type === 'run').items.filter(item => item.type === 'event').map(item => item.event);
const agents = session => eventList(session).filter(event => event.type === 'subagent-update');
const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); for (const item of Object.values(value)) deepFreeze(item); }
  return value;
};

test('subagent histories retain actual public task, status, usage and code as literal data', () => {
  const agent = snapshot('lint', 'completed');
  agent.activity = [
    { type: 'message', text: '正在检查 JavaScript' },
    { type: 'tool-start', name: 'read_file', toolCallId: 'read-1', args: { path: 'app.js' } },
    { type: 'tool-result', name: 'read_file', toolCallId: 'read-1', result: '<script>alert("literal")</script>\nconst providerState = "ordinary code";' },
  ];
  const output = agents({ events: [update(agent)] });
  assert.equal(output.length, 1);
  assert.deepEqual(output[0].agent, agent);
  assert.equal(output[0].runId, 'parent');
  assert.equal(output[0].messageIndex, 1);
});

test('nested agent/activity whitelists drop private state while preserving public tool parameter values', () => {
  const agent = { ...snapshot('secure', 'completed'), providerState: { key: 'AGENT_PRIVATE' }, reasoning: 'INTERNAL_REASONING', unknown: 'UNKNOWN_AGENT_FIELD',
    activity: [
      { type: 'analysis', text: 'PRIVATE_ANALYSIS' },
      { type: 'tool-start', name: 'run_command', providerState: 'ACTIVITY_PRIVATE', internal: 'UNKNOWN_ACTIVITY_FIELD', args: {
        command: 'node -e "console.log(\'providerState\')"', timeout_ms: 1000,
        providerState: 'ARGS_PRIVATE', options: { authorization: 'AUTH_PRIVATE', visible: true },
      } },
      { type: 'tool-result', name: 'read_file', result: { path: 'app.js', content: 'literal providerState', nativeState: 'RESULT_PRIVATE' } },
    ] };
  const session = deepFreeze({ messages, taskRuns: [record], events: [update(agent, { providerState: 'EVENT_PRIVATE', reasoning: 'EVENT_REASONING' })] });
  const before = JSON.stringify(session), output = project(session), encoded = JSON.stringify(output);
  assert.equal(JSON.stringify(session), before, 'Projection must never mutate its input archive');
  for (const hidden of ['AGENT_PRIVATE', 'INTERNAL_REASONING', 'UNKNOWN_AGENT_FIELD', 'PRIVATE_ANALYSIS', 'ACTIVITY_PRIVATE', 'UNKNOWN_ACTIVITY_FIELD', 'ARGS_PRIVATE', 'AUTH_PRIVATE', 'RESULT_PRIVATE', 'EVENT_PRIVATE', 'EVENT_REASONING']) assert.ok(!encoded.includes(hidden), hidden);
  const restored = output.find(item => item.type === 'run').items.find(item => item.event?.type === 'subagent-update').event.agent;
  assert.equal(restored.activity.length, 2);
  assert.equal(restored.activity[0].args.command, agent.activity[1].args.command);
  assert.deepEqual(restored.activity[0].args.options, { visible: true });
  assert.equal(restored.activity[1].result.content, 'literal providerState');
});

test('repeated child updates coalesce to the latest snapshot at the original spawn position', () => {
  const toolMessages = [messages[0], { role: 'assistant', content: '读文件', toolCalls: [{ id: 'read', name: 'read_file', arguments: { path: 'a.js' } }] }, { role: 'tool', toolCallId: 'read', content: 'code' }, messages[2]];
  const finished = { ...snapshot('first', 'completed'), elapsedMs: 7000, summary: '完整总结' };
  const output = eventList({ messages: toolMessages, taskRuns: [{ ...record, messageIndex: 3 }], events: [
    update(snapshot('first'), { messageIndex: 0, sequence: 1 }),
    { type: 'tool-start', runId: 'parent', name: 'read_file', toolCallId: 'read', messageIndex: 1 },
    { type: 'tool-result', runId: 'parent', name: 'read_file', toolCallId: 'read', result: 'code', messageIndex: 2 },
    update(finished, { messageIndex: 2, sequence: 4 }),
  ] });
  assert.deepEqual(output.map(event => event.type), ['subagent-update', 'tool-start', 'tool-result']);
  assert.equal(output[0].agent.status, 'completed');
  assert.equal(output[0].agent.summary, '完整总结');
  assert.equal(output[0].agent.elapsedMs, 7000);
  assert.equal(output[0].sequence, 1, 'The first event anchors the card in the parent process');
});

test('independent children keep spawn order when their completions arrive in reverse order', () => {
  const output = agents({ events: [update(snapshot('a')), update(snapshot('b')), update(snapshot('b', 'failed')), update(snapshot('a', 'completed'))] });
  assert.deepEqual(output.map(event => [event.agent.id, event.agent.status]), [['a', 'completed'], ['b', 'failed']]);
});

test('per-session child archive restores missing streams only for the matching parent run', () => {
  const restored = { ...snapshot('archived', 'completed'), parentRunId: 'parent', providerState: 'PRIVATE_ARCHIVE' };
  const output = agents({ events: [], subagents: [restored, { ...snapshot('unrelated'), parentRunId: 'other-run' }, null, { parentRunId: 'parent' }] });
  assert.equal(output.length, 1);
  assert.equal(output[0].agent.id, 'archived');
  assert.equal(output[0].agent.summary, '检查通过');
  assert.equal(output[0].agent.parentRunId, undefined, 'The parent ownership field must not leak into child UI data');
  assert.equal(JSON.stringify(output).includes('PRIVATE_ARCHIVE'), false);
});

test('durable parent timing restores old children after a newer run evicts every old event', () => {
  const historyMessages = [messages[0], { role: 'assistant', content: '旧任务完成' },
    { role: 'user', content: '新任务' }, { role: 'assistant', content: '新任务完成' }];
  const oldAgent = { ...snapshot('old-child', 'completed'), parentRunId: 'old-parent', summary: '旧子任务的实际总结' };
  const session = deepFreeze({ messages: historyMessages,
    taskRuns: [
      { ...record, runId: 'old-parent', messageStartIndex: 0, messageIndex: 1 },
      { ...record, runId: 'new-parent', messageStartIndex: 2, messageIndex: 3 },
    ],
    events: Array.from({ length: 150 }, (_, sequence) => ({ type: 'context-compacted', runId: 'new-parent',
      messageIndex: 3, sequence, text: '新任务上下文已整理', count: sequence + 1 })),
    subagents: [oldAgent],
  });
  const output = project(session);
  assert.deepEqual(output.filter(item => item.type === 'message').map(item => item.message.content), historyMessages.map(item => item.content));
  const oldRun = output.find(item => item.type === 'run' && item.record.runId === 'old-parent');
  assert.ok(oldRun, 'The old parent timing must survive event suffix retention');
  const restored = oldRun.items.filter(item => item.event?.type === 'subagent-update');
  assert.equal(restored.length, 1);
  assert.equal(restored[0].event.agent.id, 'old-child');
  assert.equal(restored[0].event.agent.status, 'completed');
  assert.equal(restored[0].event.agent.summary, '旧子任务的实际总结');
  assert.equal(restored[0].event.agent.elapsedMs, oldAgent.elapsedMs);
  assert.ok(!session.events.some(event => event.runId === 'old-parent'), 'Fixture must contain no retained old parent event');
});

test('retained agent stream prevents duplicate cards from the session archive', () => {
  const eventAgent = { ...snapshot('same', 'completed'), summary: '流中的总结' };
  const output = agents({ events: [update(eventAgent)], subagents: [{ ...snapshot('same', 'running'), parentRunId: 'parent' }, { ...snapshot('missing', 'stopped'), parentRunId: 'parent' }] });
  assert.deepEqual(output.map(event => event.agent.id), ['same', 'missing']);
  assert.equal(output[0].agent.summary, '流中的总结');
});

test('per-run logs take precedence while the latest agent snapshots survive run field projection', () => {
  const output = agents({ taskRuns: [{ ...record, activityEvents: [update(snapshot('record')), update(snapshot('record', 'completed'))] }],
    events: [update(snapshot('truncated-session', 'failed'))] });
  assert.deepEqual(output.map(event => [event.agent.id, event.agent.status]), [['record', 'completed']]);
});

test('unanchored and steering-ambiguous runs preserve chat messages alongside archived children', () => {
  const steered = [messages[0], messages[1], { role: 'user', content: '额外检查', source: 'steer' }, messages[2]];
  for (const task of [{ ...record, messageIndex: 3 }, { runId: 'parent', messageIndex: 3, status: 'stopped' }]) {
    const output = project({ messages: steered, taskRuns: [task], subagents: [{ ...snapshot('kept', 'completed'), parentRunId: 'parent' }] });
    assert.deepEqual(output.filter(item => item.type === 'message').map(item => item.message.content), steered.map(item => item.content));
    const run = output.find(item => item.type === 'run');
    assert.equal(run.unanchored, true);
    assert.equal(run.items.length, 1);
    assert.equal(run.items[0].event.agent.id, 'kept');
    assert.equal(run.items[0].event.agent.summary, '检查通过');
  }
});

test('projection does not invent elapsed time or token usage for old child snapshots', () => {
  const output = agents({ events: [update({ id: 'old', name: '旧任务', task: '检查', status: 'running' })] });
  assert.deepEqual(output[0].agent, { id: 'old', name: '旧任务', task: '检查', status: 'running' });
});

test('damaged and hostile optional agent fields never evaluate code or pollute prototypes', () => {
  const cyclic = { path: 'x.js' }; cyclic.self = cyclic;
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"secret":"NO"},"path":"safe.js"}');
  const output = agents({ events: [update(null), update({ id: 42 }), update({ id: 'valid', status: 'completed', elapsedMs: -1, inputTokens: Infinity,
    activity: [null, { type: 'provider-state', text: 'NO' }, { type: 'tool-start', args: cyclic }, { type: 'tool-result', result: hostile }] })] });
  assert.equal(output.length, 1);
  assert.equal(output[0].agent.elapsedMs, undefined);
  assert.equal(output[0].agent.inputTokens, undefined);
  assert.deepEqual(output[0].agent.activity[0].args, { path: 'x.js' });
  assert.deepEqual(output[0].agent.activity[1].result, { path: 'safe.js' });
  assert.equal({}.polluted, undefined);
});
