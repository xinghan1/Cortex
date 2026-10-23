import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/task-history.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
vm.runInContext(await fs.readFile(new URL('../src/renderer/image-view-card.js', import.meta.url), 'utf8'), context);
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

test('viewed image references survive event rollover and deduplicate without copying image bytes', () => {
  const view = { type: 'images-viewed', version: 1, requestId: 'image-request', runId: 'r', messageIndex: 0,
    images: [{ messageId: 'message-image', attachmentIndex: 0, attachmentId: 'image-one', dataUrl: 'PRIVATE_BYTES' }], providerState: 'PRIVATE' };
  const session = { messages: [{ ...user('查看图片'), id: 'message-image' }, assistant('已查看')],
    taskRuns: [record('r', 0, 1)], events: [], imageViews: [view] };
  const restored = events(runBlocks(project(session))[0]).filter(event => event.type === 'images-viewed');
  assert.equal(restored.length, 1);
  assert.deepEqual(restored[0].images, [{ messageId: 'message-image', attachmentIndex: 0, attachmentId: 'image-one' }]);
  assert.equal(JSON.stringify(restored).includes('PRIVATE'), false);
  session.events.push(view);
  assert.equal(events(runBlocks(project(session))[0]).filter(event => event.type === 'images-viewed').length, 1);
});

test('a legacy unmarked multi-user task restores actual image receipts without guessing its grouping', () => {
  const first = { type: 'images-viewed', version: 1, requestId: 'first-image', runId: 'r', messageIndex: 0,
    images: [{ messageId: 'initial-user', attachmentIndex: 0 }] };
  const second = { ...first, requestId: 'second-image', messageIndex: 2, images: [{ messageId: 'steering-user', attachmentIndex: 0 }] };
  const session = { messages: [{ ...user('先看图片'), id: 'initial-user' }, assistant('正在查看'),
    { ...user('再看这张'), id: 'steering-user' }, assistant('完成')], taskRuns: [record('r', 0, 3)],
    events: [first], imageViews: [first, second] };
  const blocks = project(session), run = runBlocks(blocks)[0];
  assert.equal(run.unanchored, true);
  assert.deepEqual(events(run).filter(event => event.type === 'images-viewed').map(event => event.requestId), ['first-image', 'second-image']);
  assert.deepEqual(blocks.filter(block => block.type === 'message').map(block => block.message.content), ['先看图片', '正在查看', '再看这张', '完成']);
});

test('each anchored history displays only its own images from legacy context-wide receipts', () => {
  const reference = messageId => ({ messageId, attachmentIndex: 0 });
  const messages = [{ ...user('旧图片一'), id: 'old-one' }, assistant('一'),
    { ...user('旧图片二'), id: 'old-two' }, assistant('二'),
    { ...user('新图片'), id: 'current' }, assistant('三'),
    { ...user('下一轮图片'), id: 'future' }, assistant('四')];
  const view = { type: 'images-viewed', version: 1, requestId: 'current-images', runId: 'current-run', messageIndex: 4,
    images: ['old-one', 'old-two', 'current', 'future'].map(reference) };
  for (const archive of ['events', 'activityEvents', 'imageViews']) {
    const currentRun = record('current-run', 4, 5);
    const session = deepFreeze({ messages, taskRuns: [record('old-one-run', 0, 1), record('old-two-run', 2, 3),
      { ...currentRun, ...(archive === 'activityEvents' ? { activityEvents: [view] } : {}) }, record('future-run', 6, 7)],
      events: archive === 'events' ? [view] : [], imageViews: archive === 'imageViews' ? [view] : [] });
    const snapshot = JSON.stringify(session);
    const restored = events(runBlocks(project(session)).find(run => run.record.runId === 'current-run'))
      .filter(event => event.type === 'images-viewed');
    assert.equal(restored.length, 1, archive);
    assert.deepEqual(restored[0].images, [reference('current')], archive);
    assert.equal(context.ForgeImageViewCard.resolve(restored[0], messages).count, 1, archive);
    assert.equal(JSON.stringify(session), snapshot, 'projection must not rewrite source messages or receipts');
  }
});

test('a text-only anchored round omits receipts containing only earlier images, including archive fallback', () => {
  const oldView = { type: 'images-viewed', version: 1, requestId: 'old-images', runId: 'text-run', messageIndex: 2,
    images: [{ messageId: 'old-user', attachmentIndex: 0 }] };
  const session = deepFreeze({ messages: [{ ...user('旧图片'), id: 'old-user' }, assistant('已看'),
    { ...user('只发文字'), id: 'text-user' }, assistant('完成')],
    taskRuns: [record('old-run', 0, 1), record('text-run', 2, 3)], events: [oldView],
    imageViews: [oldView, { ...oldView, requestId: 'fallback-old-images' }] });
  const run = runBlocks(project(session)).find(run => run.record.runId === 'text-run');
  assert.equal(events(run).filter(event => event.type === 'images-viewed').length, 0);
  assert.equal(session.imageViews.length, 2);
});

test('anchored image filtering retains initial and consumed steering references with missing originals', () => {
  const references = ['old-user', 'initial-user', 'steering-user'].map(messageId => ({ messageId, attachmentIndex: 0 }));
  const view = { type: 'images-viewed', version: 1, requestId: 'steering-images', runId: 'r', messageIndex: 4, images: references };
  const session = deepFreeze({ messages: [{ ...user('旧图片'), id: 'old-user' }, assistant('旧回复'),
    { ...user('当前图片'), id: 'initial-user' }, assistant('查看中'),
    { ...user('补充图片'), id: 'steering-user', source: 'steering' }, assistant('完成')],
    taskRuns: [record('old', 0, 1), record('r', 2, 5)], events: [], imageViews: [view] });
  const run = runBlocks(project(session)).find(run => run.record.runId === 'r');
  const restored = events(run).find(event => event.type === 'images-viewed');
  assert.deepEqual(restored.images, references.slice(1));
  const resolved = context.ForgeImageViewCard.resolve(restored, session.messages);
  assert.equal(resolved.count, 2); assert.equal(resolved.availableCount, 0); assert.equal(resolved.missingCount, 2);
  assert.equal(run.items.find(item => item.index === 4).message.source, 'steering');
});

test('unanchored and overlapping histories preserve image receipts and missing preview counts without guessing', () => {
  const view = { type: 'images-viewed', version: 1, requestId: 'unknown-images', runId: 'r', messageIndex: 2,
    images: [{ messageId: 'old-user', attachmentIndex: 0 }, { messageId: 'missing-user', attachmentIndex: 0 }] };
  const messages = [{ ...user('旧图片'), id: 'old-user' }, assistant('旧回复'),
    { ...user('现在的文字'), id: 'current-user' }, assistant('完成')];
  for (const taskRuns of [[{ runId: 'r', messageIndex: 3 }],
    [record('r', 2, 3), record('overlapping', 2, 3)]]) {
    const session = deepFreeze({ messages, taskRuns, events: [], imageViews: [view] });
    const run = runBlocks(project(session)).find(run => run.record.runId === 'r');
    assert.equal(run.unanchored, true);
    const restored = events(run).find(event => event.type === 'images-viewed');
    assert.deepEqual(restored.images, view.images);
    const resolved = context.ForgeImageViewCard.resolve(restored, messages);
    assert.equal(resolved.count, 2); assert.equal(resolved.missingCount, 2);
  }
});

test('manual undo/redo remains archived without adding a model task or hiding chat messages', () => {
  const undo = { runId: 'manual-undo', kind: 'undo', messageIndex: 1, elapsedMs: 3000, status: 'completed' };
  const session = { messages: [user('创建文件'), assistant('已创建')], taskRuns: [record('create-run', 0, 1), undo], events: [],
    fileEdits: [{ runId: 'manual-undo', toolCallId: 'undo-tool', path: 'note.txt', before: 'created\n', after: null }] };
  const blocks = project(session);
  assert.deepEqual(blocks.filter(block => block.type === 'message').map(block => block.message.content), ['创建文件', '已创建']);
  assert.deepEqual(blocks.map(block => block.type === 'message' ? block.message.content : block.record.runId), ['创建文件', 'create-run', '已创建']);
  assert.equal(runBlocks(blocks).some(block => block.record.kind === 'undo'), false);
  assert.equal(session.taskRuns.includes(undo), true);
  assert.deepEqual(session.fileEdits[0], { runId: 'manual-undo', toolCallId: 'undo-tool', path: 'note.txt', before: 'created\n', after: null });
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

test('unmarked, queued and unrelated user messages inside a range stay flat instead of being guessed as steering', () => {
  for (const source of [undefined, 'steer', 'queue', 'direct']) {
    const messages = [user('开始'), assistant('先检查'), { ...user('额外要求'), ...(source ? { source } : {}) }, assistant('已完成')];
    const blocks = project({ messages }, [record('r', 0, 3)]);
    assert.deepEqual(blocks.filter(block => block.type === 'message').map(block => block.message.content), ['开始', '先检查', '额外要求', '已完成']);
    assert.equal(runBlocks(blocks)[0].unanchored, true);
  }
});

test('consumed steering stays at its real message boundary among reconstructed tools, images and the separate queued task', () => {
  const image = { name: 'diagram.png', mediaType: 'image/png', dataUrl: 'data:image/png;base64,eA==' };
  const messages = [user('开始'), assistant('先读取', [call('a', 'read_file', { path: 'a.js' })]), result('a', 'A'),
    { ...user('先补测试'), id: 'steering-one', source: 'steering', providerState: 'PRIVATE_STEERING' },
    assistant('再读取', [call('b', 'read_file', { path: 'b.js' })]), result('b', 'B'),
    { ...user(''), id: 'steering-image', source: 'steering', attachments: [image] },
    assistant('查看图片后修改', [call('c', 'write_file', { path: 'c.js' })]), result('c', '{"path":"c.js"}'), assistant('当前任务完成'),
    { ...user('下一个排队任务'), source: 'queue' }, assistant('排队任务完成')];
  const receipt = { type: 'images-viewed', version: 1, runId: 'r', requestId: 'view-steering', messageIndex: 6,
    images: [{ messageId: 'steering-image', attachmentIndex: 0 }] };
  const session = deepFreeze({ messages, taskRuns: [record('r', 0, 9), record('queued', 10, 11)], events: [], imageViews: [receipt],
    fileEdits: [{ runId: 'r', toolCallId: 'c', path: 'c.js', before: null, after: 'created' }] });
  const blocks = project(session), run = runBlocks(blocks)[0];
  assert.deepEqual(blocks.map(block => block.type === 'message' ? block.message.content : block.record.runId),
    ['开始', 'r', '当前任务完成', '下一个排队任务', 'queued', '排队任务完成']);
  assert.equal(run.unanchored, undefined); assert.equal(run.finalIndex, 9);
  assert.deepEqual(run.items.map(item => item.type === 'message' ? `message:${item.index}`
    : item.event.type === 'images-viewed' ? 'images' : `${item.event.type}:${item.event.toolCallId}`),
  ['message:1', 'tool-start:a', 'tool-result:a', 'message:3', 'message:4', 'tool-start:b', 'tool-result:b',
    'message:6', 'images', 'message:7', 'tool-start:c', 'tool-result:c']);
  assert.deepEqual(run.items.find(item => item.index === 6).message, messages[6]);
  assert.deepEqual(events(run).find(event => event.toolCallId === 'c' && event.type === 'tool-result').fileChange,
    { path: 'c.js', before: null, after: 'created' });
  assert.equal(JSON.stringify(blocks).includes('PRIVATE_STEERING'), false);
});

test('lightweight steering boundaries place event-only progress after the actual message without rendering duplicate user events', () => {
  const messages = [user('开始'), assistant('相同的过程文本'), { ...user('补充'), id: 's', source: 'steering' },
    assistant('相同的过程文本'), assistant('完成')];
  const eventLog = [
    { type: 'user-message', id: 's', source: 'steering' },
    { type: 'subagent-update', agent: { id: 'after-steering', name: '测试', status: 'completed' } },
    { type: 'assistant-message', text: '相同的过程文本' },
    { type: 'context-compacted', count: 1 },
  ].map((event, sequence) => ({ ...event, sequence, runId: 'r' }));
  const run = runBlocks(project({ messages, events: eventLog }, [record('r', 0, 4)]))[0];
  assert.deepEqual(run.items.map(item => item.type === 'message' ? `message:${item.index}` : item.event.type),
    ['message:1', 'message:2', 'subagent-update', 'message:3', 'context-compacted']);
  assert.equal(run.items.filter(item => item.type === 'message' && item.message.role === 'user').length, 1);
  assert.equal(events(run).some(event => event.type === 'user-message'), false);
  assert.equal(run.finalIndex, 4);
});

test('a real overlap involving an interior steering message still keeps all messages visible once', () => {
  const messages = [user('开始'), assistant('先检查'), { ...user('补充'), source: 'steering', id: 's' }, assistant('继续'), assistant('完成')];
  const blocks = project({ messages }, [record('r', 0, 4), record('ambiguous', 2, 4)]);
  assert.deepEqual(blocks.filter(block => block.type === 'message').map(block => block.index), [0, 1, 2, 3, 4]);
  assert.equal(runBlocks(blocks).length, 2); assert.ok(runBlocks(blocks).every(block => block.unanchored));
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
