import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../src/renderer/subagents.js', import.meta.url), 'utf8');
class Element {
  constructor() { this.children = []; this.dataset = {}; this.textContent = ''; this.hidden = false; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute() {}
  addEventListener() {}
  querySelectorAll() { return []; }
}
function fixture() {
  let time = 0;
  const document = { createElement: () => new Element(), createElementNS: () => new Element(), createDocumentFragment: () => new Element() };
  const window = {};
  vm.runInNewContext(source, { document, window, performance: { now: () => time }, setInterval: () => { throw new Error('Unexpected per-card timer'); } });
  return { api: window.ForgeSubagents, advance: value => { time += value; } };
}
const snapshot = { id: 'one', name: '测试', task: '任务', status: 'running', elapsedMs: 1000, inputTokens: 120, outputTokens: 34, activity: [] };
const collect = element => [element.textContent, ...element.children.flatMap(collect)];
test('tool calls and results appear as one named operation with actual status', () => {
  const f = fixture(), card = f.api.render({ ...snapshot, activity: [
    { type: 'tool-start', name: 'write_file', toolCallId: 'id-1', args: { path: 'index.html' } },
    { type: 'tool-result', name: 'write_file', toolCallId: 'id-1', status: 'completed', result: '{"ok":true}' },
    { type: 'tool-start', name: 'run_command', toolCallId: 'id-2', args: { command: 'npm test' } },
    { type: 'tool-result', name: 'run_command', toolCallId: 'id-2', status: 'failed', result: '{"exitCode":1}' },
  ] });
  const texts = collect(card);
  assert.equal(texts.filter(value => value === '编辑文件 · index.html · 已完成').length, 1);
  assert.equal(texts.filter(value => value === '运行命令 · 未完成').length, 1);
  assert.ok(!texts.some(value => value.startsWith('工具返回 ·')));
  assert.ok(texts.includes('输入参数')); assert.ok(texts.includes('执行结果'));
});
test('legacy and unfinished operations are not falsely reported as completed', () => {
  const f = fixture(), card = f.api.render({ ...snapshot, status: 'stopped', activity: [
    { type: 'tool-start', name: 'search_files', toolCallId: 'pending', args: { query: 'example' } },
    { type: 'tool-result', name: 'list_files', result: '已返回' },
  ] });
  const texts = collect(card);
  assert.ok(texts.includes('搜索文件 · 未返回')); assert.ok(texts.includes('读取文件列表 · 已返回'));
});
const meta = card => card.children[0].children[3];
const phase = card => card.children[0].children[2];
function usage(card) {
  const find = element => element.className === 'subagent-usage' ? element : element.children.map(find).find(Boolean);
  return find(card);
}

test('child telemetry shows the model phase and clearly labels output estimates without rebuilding the process log', () => {
  const f = fixture(), card = f.api.render({ ...snapshot, telemetry: { phase: 'waiting', estimated: true, estimatedOutputTokens: 0 } });
  assert.equal(phase(card).textContent, '等待模型响应');
  const usageNode = usage(card);
  f.api.update(card, { ...snapshot, telemetry: { phase: 'thinking', estimated: true, estimatedOutputTokens: 211 } });
  assert.equal(phase(card).textContent, '正在思考');
  assert.equal(usage(card), usageNode);
  assert.match(usageNode.textContent, /输出 34 Token · 估算输出 211 Token/);
  f.api.update(card, { ...snapshot, telemetry: { phase: 'generating', estimated: true, estimatedOutputTokens: 500 } });
  assert.equal(phase(card).textContent, '正在生成');
  assert.match(usageNode.textContent, /估算输出 500 Token/);
  f.api.update(card, { ...snapshot, status: 'completed', telemetry: { phase: 'generating', estimated: true, estimatedOutputTokens: 500 } });
  assert.equal(phase(card).textContent, '已完成');
  assert.doesNotMatch(usage(card).textContent, /估算输出/);
});

test('running child time advances without snapshots and remains monotonic when an older update arrives', () => {
  const f = fixture(), card = f.api.render(snapshot);
  assert.equal(meta(card).textContent, '用时 1s');
  const usageNode = usage(card);
  assert.equal(usageNode.textContent, '用时 1s · 输入 120 Token · 输出 34 Token');
  f.advance(2200); f.api.tick(card);
  assert.equal(meta(card).textContent, '用时 3s');
  assert.equal(usage(card), usageNode, 'Tick must not recreate the body or lose expanded details');
  assert.equal(usageNode.textContent, '用时 3s · 输入 120 Token · 输出 34 Token');
  f.api.update(card, { ...snapshot, elapsedMs: 2000 });
  assert.equal(meta(card).textContent, '用时 3s');
  f.advance(1000); f.api.tick(card);
  assert.equal(meta(card).textContent, '用时 4s');
  assert.equal(usage(card).textContent, '用时 4s · 输入 120 Token · 输出 34 Token');
  f.api.update(card, { ...snapshot, elapsedMs: 5500, status: 'completed' });
  assert.equal(meta(card).textContent, '用时 5s');
  f.advance(5000); f.api.tick(card);
  assert.equal(meta(card).textContent, '用时 5s');
  assert.equal(usage(card).textContent, '用时 5s · 输入 120 Token · 输出 34 Token');
});

test('stopping, parent completion and historical cards do not keep advancing', () => {
  const f = fixture(), stopped = f.api.render(snapshot), historical = f.api.render(snapshot, { historical: true });
  f.advance(3100); f.api.finish(stopped); f.api.tick(historical);
  assert.equal(meta(stopped).textContent, '用时 4s');
  assert.equal(meta(historical).textContent, '用时 1s');
  assert.equal(usage(stopped).textContent, '用时 4s · 输入 120 Token · 输出 34 Token');
  assert.equal(usage(historical).textContent, '用时 1s · 输入 120 Token · 输出 34 Token');
  f.advance(4000); f.api.tick(stopped); f.api.tick(historical);
  assert.equal(meta(stopped).textContent, '用时 4s');
  assert.equal(meta(historical).textContent, '用时 1s');
});

test('streaming and confirmed text appear once while distinct summary and prior activity remain visible', () => {
  const f = fixture();
  const latest = { ...snapshot, summary: '正在整理', activity: [{ type: 'message', text: '此前过程' }, { type: 'message', text: '正在整理', streaming: true }] };
  const card = f.api.render(latest);
  const texts = element => [element.textContent, ...element.children.flatMap(texts)];
  assert.equal(texts(card).filter(value => value === '正在整理').length, 1);
  assert.ok(texts(card).includes('此前过程'));
  f.api.update(card, { ...latest, summary: '最终回答', activity: [{ type: 'message', text: '此前过程' }, { type: 'message', text: '最终回答' }] });
  assert.equal(texts(card).filter(value => value === '最终回答').length, 1);
  assert.ok(texts(card).includes('此前过程'));
  f.api.update(card, { ...latest, summary: '独立总结' });
  assert.equal(texts(card).filter(value => value === '独立总结').length, 1);
  assert.equal(texts(card).filter(value => value === '正在整理').length, 1);
});

test('parent task activity drives only its current rendered cards', async () => {
  const app = await readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  const body = app.slice(app.indexOf('function renderTaskActivityElapsed('), app.indexOf('\nfunction createTaskActivity('));
  const calls = [], activity = { status: 'running', elapsed: {}, events: { querySelectorAll: () => ['child'] } };
  const context = { activeTaskActivity: activity, window: { ForgeSubagents: { tick: card => calls.push(card) } }, taskElapsed: () => 1200, activityDuration: () => '用时 1秒' };
  vm.runInNewContext(body + '\nrenderTaskActivityElapsed();', context);
  assert.deepEqual(calls, ['child']); assert.equal(activity.elapsed.textContent, '用时 1秒');
  activity.status = 'completed'; vm.runInNewContext(body + '\nrenderTaskActivityElapsed();', context);
  assert.deepEqual(calls, ['child']);
});
