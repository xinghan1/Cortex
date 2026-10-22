import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(await fs.readFile(new URL('../src/renderer/round-token-usage.js', import.meta.url), 'utf8'), context);
vm.runInContext(await fs.readFile(new URL('../src/renderer/task-history.js', import.meta.url), 'utf8'), context);
const { formatTokens, describe } = context.ForgeRoundTokenUsage;
const plain = value => JSON.parse(JSON.stringify(value));
const usage = (inputTokens, outputTokens, extra = {}) => ({ version: 1, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
  requests: 1, reportedRequests: 1, unreportedRequests: 0, partialRequests: 0, status: 'reported', ...extra });
const run = (extra = {}) => ({ runId: 'r', kind: 'agent', status: 'completed', usage: usage(8700, 1000), ...extra });

test('compact round usage uses K/M/B and promotes rounded boundaries', () => {
  for (const [input, expected] of [[0, '0'], [999, '999'], [1000, '1K'], [9700, '9.7K'], [999949, '999.9K'], [999950, '1M'], [1234500, '1.2M'], [999950000, '1B'], [2400000000, '2.4B']]) {
    assert.equal(formatTokens(input), expected);
  }
  for (const invalid of [-1, null, '9700', NaN, Infinity, 2.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(formatTokens(invalid), null);
});

test('actual reported totals include a real zero without reading session totals or estimating text', () => {
  const value = describe(run({ usage: usage(0, 0), content: 'A long response cannot become a token estimate', sessionMetrics: { totalTokens: 9000000 } }));
  assert.equal(value.label, '用量 0 tok');
  assert.equal(value.status, 'reported');
  assert.match(value.title, /输入 0 \/ 输出 0 Token，共 0 Token/u);
  assert.equal(describe(run()).label, '用量 9.7K tok');
});

test('partial reports show a star, known input/output and missing coverage', () => {
  const value = describe(run({ status: 'failed', usage: usage(5000, 20, { totalTokens: 999999, requests: 3, reportedRequests: 1, unreportedRequests: 1, partialRequests: 1, status: 'partial' }) }));
  assert.equal(value.label, '用量 5K tok*');
  assert.equal(value.status, 'partial');
  assert.match(value.title, /输入 5,000 \/ 输出 20 Token，共 5,020 Token/u);
  assert.match(value.title, /3 次请求，1 次有用量报告/u);
  assert.match(value.title, /缺失部分未计入/u);
  assert.equal(describe(run({ usage: usage(0, 0, { historicalApproximate: true }) })).label, '用量 0 tok*');
});

test('missing or unusable reports stay unavailable and never pretend to be zero', () => {
  for (const bad of [undefined, {}, { status: 'unavailable', inputTokens: 0, outputTokens: 0, totalTokens: 0 }, { status: 'reported', inputTokens: -10, outputTokens: NaN }, { status: 'reported', totalTokens: '100' }]) {
    const value = describe(run({ status: 'stopped', usage: bad }));
    assert.equal(value.label, '用量 未回报');
    assert.equal(value.status, 'unavailable');
  }
  assert.equal(describe(run({ usage: { status: 'partial', totalTokens: 11, inputTokens: null, outputTokens: 11 } })).label, '用量 11 tok*');
});

test('manual operations, offline demos and unfinished tasks cannot acquire model usage badges', () => {
  for (const extra of [{ runId: '' }, { kind: 'undo' }, { kind: 'terminal' }, { demo: true }, { status: 'running' }, { status: undefined }]) assert.equal(describe(run(extra)), null);
  for (const status of ['completed', 'failed', 'stopped']) assert.equal(describe(run({ status })).runId, 'r');
});

test('history keeps distinct per-run reports across steering and duplicate end events without exposing private usage keys', () => {
  const first = run({ messageStartIndex: 0, messageIndex: 3, elapsedMs: 1000,
    usage: { ...usage(9500, 200), apiKey: 'PRIVATE', providerState: { secret: 'PRIVATE' } } });
  const second = run({ runId: 'r2', status: 'stopped', messageStartIndex: 4, messageIndex: 4, elapsedMs: 2000, usage: { status: 'unavailable', totalTokens: null } });
  const session = { messages: [{ role: 'user', content: 'start' }, { role: 'assistant', content: 'working' },
    { role: 'user', source: 'steering', content: 'adjust' }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'next' }],
  taskRuns: [first, second], events: [{ ...first, type: 'run-end' }], sessionMetrics: { totalTokens: 888888 } };
  const before = JSON.stringify(session);
  const blocks = plain(context.ForgeTaskHistory.project(session)), records = blocks.filter(block => block.type === 'run');
  assert.equal(records.length, 2);
  assert.equal(records[0].finalIndex, 3);
  assert.equal(records[1].finalIndex, null);
  assert.equal(describe(records[0].record).label, '用量 9.7K tok');
  assert.equal(describe(records[1].record).label, '用量 未回报');
  assert.equal(JSON.stringify(records).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(session), before);
});

test('missing and overlapping history anchors stay explicitly unanchored for badge omission', () => {
  const records = [run({ elapsedMs: 1, messageIndex: 1 }), run({ runId: 'overlap-a', elapsedMs: 1, messageStartIndex: 0, messageIndex: 1 }),
    run({ runId: 'overlap-b', elapsedMs: 1, messageStartIndex: 0, messageIndex: 1 })];
  const blocks = plain(context.ForgeTaskHistory.project({ messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'answer' }], taskRuns: records }));
  assert.equal(blocks.filter(block => block.type === 'run').length, 3);
  assert.ok(blocks.filter(block => block.type === 'run').every(block => block.unanchored === true));
  assert.deepEqual(blocks.filter(block => block.type === 'message').map(block => block.message.content), ['one', 'answer']);
});

test('history accepts only typed public usage fields, never nested provider data inside count fields', () => {
  const record = run({ messageStartIndex: 0, messageIndex: 1, elapsedMs: 0, usage: { version: 1, status: 'partial', inputTokens: { secret: 'PRIVATE' },
    outputTokens: 12, totalTokens: 12, historicalApproximate: { secret: 'PRIVATE' }, requests: -1, headers: { Authorization: 'PRIVATE' } } });
  const projected = plain(context.ForgeTaskHistory.project({ messages: [{ role: 'user', content: 'one' }, { role: 'assistant', content: 'answer' }], taskRuns: [record] }));
  assert.deepEqual(projected.find(block => block.type === 'run').record.usage, { version: 1, outputTokens: 12, totalTokens: 12, status: 'partial' });
  assert.equal(JSON.stringify(projected).includes('PRIVATE'), false);
});
