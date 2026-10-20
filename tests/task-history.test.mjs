import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/task-history.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const project = (session, records) => JSON.parse(JSON.stringify(context.ForgeTaskHistory.project(session, records)));
const user = content => ({ role: 'user', content });
const assistant = (content, toolCalls = []) => ({ role: 'assistant', content, toolCalls });
const call = (id, name, args) => ({ id, name, arguments: args });
const result = (id, content) => ({ role: 'tool', toolCallId: id, content });
const record = (runId, start, end, status = 'completed') => ({ runId, messageStartIndex: start, messageIndex: end, elapsedMs: 1308000, status });
const runBlocks = blocks => blocks.filter(block => block.type === 'run');
const events = block => block.items.filter(item => item.type === 'event').map(item => item.event);
const deepFreeze = value => {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
};

test('successful edit snapshots restore by run and tool ID without entering model messages', () => {
  const saved = { runId: 'edit-run', toolCallId: 'edit-2', path: 'app.js', before: 'old\n', after: 'new\n', providerState: 'PRIVATE' };
  const session = deepFreeze({ messages: [user('修改文件'), assistant('', [call('edit-1', 'write_file', { path: 'first.js' }), call('edit-2', 'write_file', { path: 'app.js' })]), result('edit-1', '{"path":"first.js"}'), result('edit-2', '{"path":"app.js"}'), assistant('已修改。')],
    taskRuns: [record('edit-run', 0, 4)], events: [], fileEdits: [{ ...saved, runId: 'other-run', before: 'wrong' }, saved] });
  const output = events(runBlocks(project(session))[0]).filter(item => item.type === 'tool-result');
  assert.equal(output[0].fileChange, undefined);
  assert.deepEqual(output[1].fileChange, { path: 'app.js', before: 'old\n', after: 'new\n' });
  assert.equal(session.messages[3].fileChange, undefined);
  assert.equal(JSON.stringify(output).includes('PRIVATE'), false);
});

test('retained result events supplement edit snapshots once, and malformed snapshots stay absent', () => {
  const messages = [user('修改'), assistant('', [call('e', 'write_file', { path: 'a.js' })]), result('e', '{"path":"a.js"}'), assistant('完成')];
  const saved = { type: 'tool-result', runId: 'r', name: 'write_file', toolCallId: 'e', result: '{"path":"a.js"}', fileChange: { path: 'a.js', before: null, after: 'const x = 1;', providerState: 'PRIVATE' } };
  const session = { messages, taskRuns: [record('r', 0, 3)], events: [saved], fileEdits: [{ runId: 'r', toolCallId: 'e', path: 'a.js', after: 'missing-before' }] };
  const output = events(runBlocks(project(session))[0]).filter(item => item.type === 'tool-result');
  assert.equal(output.length, 1);
  assert.deepEqual(output[0].fileChange, { path: 'a.js', before: null, after: 'const x = 1;' });
});

test('manual undo restores its independent committed change without hiding chat messages', () => {
  const undo = { runId: 'manual-undo', kind: 'undo', messageIndex: 1, elapsedMs: 3000, status: 'completed' };
  const session = { messages: [user('创建文件'), assistant('已创建')], taskRuns: [record('create-run', 0, 1), undo], events: [],
    fileEdits: [{ runId: 'manual-undo', toolCallId: 'undo-tool', path: 'note.txt', before: 'created\n', after: null }] };
  const blocks = project(session);
  assert.deepEqual(blocks.filter(block => block.type === 'message').map(block => block.message.content), ['创建文件', '已创建']);
  assert.deepEqual(blocks.map(block => block.type === 'message' ? block.message.content : block.record.runId), ['创建文件', 'create-run', '已创建', 'manual-undo']);
  const output = events(runBlocks(blocks).find(block => block.record.kind === 'undo'));
  assert.deepEqual(output.map(item => item.type), ['tool-start', 'tool-result']);
  assert.deepEqual(output[1].fileChange, { path: 'note.txt', before: 'created\n', after: null });
});

test('completed run keeps user and final answer visible and reconstructs tool inputs/results without retained events', () => {
  const messages = [user('检查代码'), assistant('我先读取文件。', [call('read', 'read_file', { path: 'app.js' })]), result('read', 'const a = 1;'), assistant('已检查，代码正确。')];
  const blocks = project({ messages, events: [], taskRuns: [record('r1', 0, 3)] });
  assert.deepEqual(blocks.map(block => [block.type, block.index]), [['message', 0], ['run', undefined], ['message', 3]]);
  assert.equal(blocks[1].finalIndex, 3);
  assert.equal(blocks[1].items[0].message.content, '我先读取文件。');
  assert.deepEqual(events(blocks[1]), [
    { type: 'tool-start', runId: 'r1', messageIndex: 1, toolCallId: 'read', name: 'read_file', args: { path: 'app.js' } },
    { type: 'tool-result', runId: 'r1', messageIndex: 2, toolCallId: 'read', name: 'read_file', result: 'const a = 1;' },
  ]);
});

test('multiple runs and duplicate task/event summaries retain one chronological group each', () => {
  const r1 = record('r1', 0, 1), r2 = record('r2', 2, 5);
  const blocks = project({ messages: [user('第一轮'), assistant('一'), user('第二轮'), assistant('操作', [call('x', 'run_command', { command: 'node --version' })]), result('x', '{"exitCode":0,"output":"v22"}'), assistant('二')],
    taskRuns: [r1, r2], events: [{ type: 'run-end', ...r1 }, { type: 'run-end', ...r2 }] });
  assert.deepEqual(blocks.map(block => block.type === 'run' ? block.record.runId : block.message.content), ['第一轮', 'r1', '一', '第二轮', 'r2', '二']);
  assert.equal(runBlocks(blocks).length, 2);
});

test('same-name calls are matched by stored call IDs, not the wrong result occurrence', () => {
  const messages = [user('读两个文件'), assistant('读取', [call('b', 'read_file', { path: 'b.py' }), call('a', 'read_file', { path: 'a.py' })]), result('a', 'AAA'), result('b', 'BBB'), assistant('完成')];
  const run = runBlocks(project({ messages }, [record('r', 0, 4)]))[0];
  assert.deepEqual(events(run).map(event => [event.type, event.toolCallId, event.args?.path || event.result]), [
    ['tool-start', 'a', 'a.py'], ['tool-result', 'a', 'AAA'], ['tool-start', 'b', 'b.py'], ['tool-result', 'b', 'BBB'],
  ]);
});

test('stopped partial local-only reply remains in process, never becomes the final answer', () => {
  const partial = { ...assistant('只生成了部分\n\n[本次响应未完成]'), localOnly: true };
  const blocks = project({ messages: [user('继续'), partial] }, [record('r', 0, 1, 'stopped')]);
  assert.deepEqual(blocks.map(block => block.type), ['message', 'run']);
  assert.equal(blocks[1].finalIndex, null);
  assert.equal(blocks[1].items[0].message.localOnly, true);
  assert.equal(blocks[1].record.status, 'stopped');
});

test('failed tool run does not mistake tool-using assistant commentary for final answer', () => {
  const messages = [user('执行'), assistant('我来执行。', [call('x', 'run_command', { command: 'false' })]), result('x', '工具执行失败：进程已停止')];
  const blocks = project({ messages }, [record('r', 0, 2, 'failed')]);
  assert.equal(blocks[1].finalIndex, null);
  assert.equal(blocks[1].items[0].message.content, '我来执行。');
  assert.equal(events(blocks[1]).at(-1).result, '工具执行失败：进程已停止');
});

test('in-flight call with no result remains inspectable instead of inventing success', () => {
  const messages = [user('执行'), assistant('', [call('x', 'run_command', { command: 'wait' })])];
  const run = runBlocks(project({ messages }, [record('r', 0, 1, 'stopped')]))[0];
  assert.deepEqual(events(run).map(event => event.type), ['tool-start']);
  assert.equal(run.finalIndex, null);
});

test('legacy missing or out-of-range anchors preserve original messages and provide standalone metadata', () => {
  const messages = [user('以前的问题'), assistant('以前的回答')];
  for (const old of [{ runId: 'old', messageIndex: 1, elapsedMs: 1000 }, record('old', 0, 99), record('old', -1, 1), record('old', 1, 0)]) {
    const blocks = project({ messages }, [old]);
    assert.deepEqual(blocks.filter(block => block.type === 'message').map(block => block.message.content), ['以前的问题', '以前的回答']);
    assert.equal(runBlocks(blocks)[0].unanchored, true);
    assert.equal(runBlocks(blocks)[0].items.length, 0);
  }
});

test('steering messages inside one run stay flat and in original order', () => {
  const messages = [user('开始'), assistant('先检查'), { ...user('额外要求'), source: 'steer' }, assistant('已完成')];
  const blocks = project({ messages }, [record('r', 0, 3)]);
  assert.deepEqual(blocks.filter(block => block.type === 'message').map(block => block.message.content), ['开始', '先检查', '额外要求', '已完成']);
  assert.equal(runBlocks(blocks)[0].unanchored, true);
});

test('ambiguous overlapping records leave all message content visible', () => {
  const messages = [user('请求'), assistant('过程'), assistant('回答')];
  const blocks = project({ messages }, [record('r1', 0, 1), record('r2', 0, 2)]);
  assert.deepEqual(blocks.filter(block => block.type === 'message').map(block => block.index), [0, 1, 2]);
  assert.equal(runBlocks(blocks).length, 2);
  assert.ok(runBlocks(blocks).every(block => block.unanchored));
});

test('matched persisted tool events do not duplicate reconstructed tools; output and approvals interleave inside their tool', () => {
  const messages = [user('测试'), assistant('运行测试', [call('x', 'run_command', { command: 'npm test' })]), result('x', '{"exitCode":0,"output":"passed"}'), assistant('测试通过')];
  const persisted = [
    { type: 'assistant-message', text: '运行测试' },
    { type: 'tool-start', name: 'run_command', args: { command: 'npm test' } },
    { type: 'approval-request', id: 'approval', kind: 'command', command: 'npm test' },
    { type: 'approval-resolved', id: 'approval', approved: true },
    { type: 'command-output', text: 'passed\n' },
    { type: 'tool-result', name: 'run_command', result: '{"exitCode":0,"output":"passed"}' },
    { type: 'assistant-message', text: '测试通过' },
  ].map((event, sequence) => ({ ...event, runId: 'r', sequence }));
  const run = runBlocks(project({ messages, events: persisted }, [record('r', 0, 3)]))[0];
  assert.deepEqual(events(run).map(event => event.type), ['tool-start', 'approval-request', 'approval-resolved', 'command-output', 'tool-result']);
  assert.equal(events(run)[3].text, 'passed\n');
});

test('event-only demo tools and safe context notices survive historical projection', () => {
  const messages = [user('演示'), assistant('开始演示'), assistant('演示结束')];
  const persisted = [
    { type: 'assistant-message', text: '开始演示' },
    { type: 'tool-start', name: 'read_file（模拟）', args: { path: 'hello.js' } },
    { type: 'tool-result', name: 'read_file（模拟）', result: 'code' },
    { type: 'context-compacted', messageIndex: 2, text: '上下文已自动压缩', count: 1 },
  ].map(event => ({ ...event, runId: 'demo' }));
  const run = runBlocks(project({ messages, events: persisted }, [record('demo', 0, 2)]))[0];
  assert.deepEqual(events(run).map(event => event.type), ['tool-start', 'tool-result', 'context-compacted']);
  assert.equal(run.finalIndex, 2);
});

test('retention-truncated events still recover all archived tool calls and results', () => {
  const messages = [user('读取'), assistant('读取两个文件', [call('x', 'read_file', { path: 'a.md' }), call('y', 'read_file', { path: 'b.json' })]), result('x', '# A'), result('y', '{}'), assistant('完成')];
  const session = { messages, events: [{ runId: 'r', type: 'tool-result', name: 'read_file', result: '{}' }, { ...record('r', 0, 4), type: 'run-end' }] };
  const run = runBlocks(project(session))[0];
  assert.equal(events(run).filter(event => event.type === 'tool-start').length, 2);
  assert.equal(events(run).filter(event => event.type === 'tool-result').length, 2);
});

test('truncated suffix of same-name calls attaches later output to the remaining call', () => {
  const messages = [user('测试两次'), assistant('测试', [call('x', 'run_command', { command: 'first' }), call('y', 'run_command', { command: 'second' })]), result('x', 'first result'), result('y', 'second result'), assistant('完成')];
  const persisted = [
    { type: 'tool-result', name: 'run_command', result: 'first result' },
    { type: 'tool-start', name: 'run_command', args: { command: 'second' } },
    { type: 'command-output', text: 'second output' },
    { type: 'tool-result', name: 'run_command', result: 'second result' },
  ].map(event => ({ ...event, runId: 'r' }));
  const run = runBlocks(project({ messages, events: persisted }, [record('r', 0, 4)]))[0];
  assert.deepEqual(events(run).map(event => event.type === 'tool-start' ? event.args.command : event.result || event.text), ['first', 'first result', 'second', 'second output', 'second result']);
});

test('projection is pure and does not expose native provider state or unknown event fields', () => {
  const session = deepFreeze({ messages: [user('开始'), { ...assistant('读取', [{ ...call('x', 'read_file', { path: 'x.md' }), providerState: { secret: 'CALL_SECRET' } }]), providerState: { reasoning: 'DO_NOT_RENDER' }, reasoning: 'PRIVATE_REASONING' }, result('x', '# 内容'), assistant('完成')],
    providerState: { secret: 'SESSION_SECRET' },
    events: [{ runId: 'r', type: 'approval-auto', kind: 'write', title: '批准写入', providerState: { secret: 'EVENT_SECRET' }, reasoning: 'HIDDEN' }], taskRuns: [record('r', 0, 3)] });
  const before = JSON.stringify(session), blocks = project(session), encoded = JSON.stringify(blocks);
  assert.equal(JSON.stringify(session), before);
  for (const secret of ['providerState', 'DO_NOT_RENDER', 'PRIVATE_REASONING', 'SESSION_SECRET', 'CALL_SECRET', 'EVENT_SECRET', 'HIDDEN']) assert.ok(!encoded.includes(secret), secret);
  assert.match(encoded, /批准写入/u);
});

test('attachment-only user messages stay outside the collapsed process with their original metadata', () => {
  const message = { ...user(''), id: 'image-message', createdAt: '2026-10-20T12:00:00Z', attachments: [{ name: 'photo.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,eA==' }] };
  const blocks = project({ messages: [message, assistant('识别完成')] }, [record('r', 0, 1)]);
  assert.deepEqual(blocks[0].message, message);
  assert.equal(blocks[0].type, 'message');
  assert.equal(blocks[2].message.content, '识别完成');
});

test('explicit record logs take precedence over truncated session event duplicates', () => {
  const messages = [user('演示'), assistant('开始'), assistant('完成')];
  const detail = { type: 'tool-start', name: 'read_file（模拟）', args: { path: 'hello.js' } };
  const summary = { ...record('r', 0, 2), activityEvents: [detail, { type: 'tool-result', name: detail.name, result: 'value' }] };
  const run = runBlocks(project({ messages, events: [{ ...detail, runId: 'r' }] }, [summary]))[0];
  assert.equal(events(run).filter(event => event.type === 'tool-start').length, 1);
});

test('empty and damaged optional archive lists do not crash projection', () => {
  assert.deepEqual(project({}), []);
  assert.deepEqual(project({ messages: null, events: [null, {}], taskRuns: [null] }), []);
  assert.equal(project({ messages: [], taskRuns: [{ runId: 'empty', elapsedMs: 0 }] })[0].unanchored, true);
});
