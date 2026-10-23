import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = new Map(); this.parentElement = null; this.className = ''; this.content = ''; this.open = false; }
  set textContent(value) { this.content = String(value); this.children = []; }
  get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  after(node) { const parent = this.parentElement; assert.ok(parent); node.remove(); node.parentElement = parent; parent.children.splice(parent.children.indexOf(this) + 1, 0, node); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(node => node !== this); this.parentElement = null; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type) { for (const listener of this.listeners.get(type) || []) listener(); }
  querySelector(selector) { return this.children.find(node => node.className === selector.slice(1)) || this.children.map(node => node.querySelector(selector)).find(Boolean) || null; }
}

const statusSource = await fs.readFile(new URL('../src/renderer/context-compaction-status.js', import.meta.url), 'utf8');
const appSource = await fs.readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
function appFunction(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const end = appSource.indexOf('\nfunction ', start + 1);
  return appSource.slice(start, end < 0 ? appSource.length : end);
}

function fixture() {
  const root = new Element('div'), block = new Element('details'), target = new Element('div');
  block.open = true; block.append(target); root.append(block);
  const context = vm.createContext({ document: { createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag) } });
  vm.runInContext(statusSource, context);
  return { root, block, target, context, api: context.ForgeContextCompaction };
}

test('pending compression remains visible when task folds and completion retains its position before later steering', () => {
  const { root, block, target, api } = fixture();
  const earlier = new Element('p'); earlier.textContent = 'Earlier operation'; target.append(earlier);
  const progress = api.createProgress({ target, block, runId: 'run-one' });
  const later = new Element('p'); later.textContent = 'Later steering'; target.append(later);
  assert.equal(progress.node.textContent, '正在压缩上下文 · 可能需要几分钟');
  assert.equal(progress.node.attributes.role, 'status');
  assert.equal(progress.node.parentElement, target);
  block.open = false; block.dispatch('toggle');
  assert.deepEqual(root.children, [block, progress.node]);
  block.open = true; block.dispatch('toggle');
  assert.equal(progress.node.parentElement, target);
  assert.equal(target.children.indexOf(progress.node) < target.children.indexOf(later), true);
  block.open = false; block.dispatch('toggle');
  const completed = progress.finish();
  assert.deepEqual(target.children, [earlier, completed, later]);
  assert.equal(completed.textContent, '上下文已自动压缩');
  assert.equal(completed.className, 'context-compaction-notice');
  block.dispatch('toggle');
  assert.equal(completed.parentElement, target, 'Settled notices stay in folded history');
});

test('reconnection only changes the live notice and each terminal outcome removes the running label', () => {
  for (const [status, expected] of [['failed', '上下文压缩失败'], ['stopped', '上下文压缩已停止'], ['cancelled', '上下文压缩已取消']]) {
    const { block, target, api } = fixture();
    const progress = api.createProgress({ target, block });
    progress.reconnect({ status: 'waiting', attempt: 2, maxAttempts: 5 });
    assert.equal(progress.node.textContent, '正在压缩上下文 · 正在重连 2/5');
    progress.reconnect(null);
    assert.equal(progress.node.textContent, '正在压缩上下文 · 可能需要几分钟');
    const node = progress.finish(status);
    progress.reconnect({ status: 'retrying', attempt: 3, maxAttempts: 5 });
    assert.equal(node.textContent, expected);
    assert.equal(node.dataset.status, status);
    assert.equal(block.listeners.get('toggle').size, 0);
  }
});

test('resetting a conversation removes both a detached live notice and its timeline anchor', () => {
  const { root, block, target, api } = fixture();
  const progress = api.createProgress({ target, block });
  block.open = false; block.dispatch('toggle');
  progress.remove();
  assert.deepEqual(root.children, [block]);
  assert.equal(target.children.length, 0);
  assert.equal(block.listeners.get('toggle').size, 0);
});

function rendererFixture() {
  const data = fixture();
  const activity = { block: data.block, events: data.target, runId: 'current', status: 'running' };
  Object.assign(data.context, { window: { ForgeContextCompaction: data.api }, activity,
    finishStream() {}, scrollBottom() {}, moveTaskActivityToEnd() {}, setTaskActivityPhase() {}, renderTaskReconnect() {},
    belongsToCurrentWorkspace: () => true, taskProcessTarget: () => data.target,
  });
  vm.runInContext('let running = true; let contextCompacting = false; let activeTaskActivity = activity; const contextCompactionNotices = new Set();', data.context);
  for (const name of ['currentCompactionEvent', 'beginContextCompaction', 'finishContextCompaction', 'syncContextCompaction', 'appendContextCompactionNotice', 'handleEvent']) vm.runInContext(appFunction(name), data.context);
  return { ...data, activity, handle: event => data.context.handleEvent(event), state: () => vm.runInContext('({ contextCompacting, progress: activeTaskActivity.compaction })', data.context) };
}

test('renderer ignores stale and subagent compaction events and repeated starts retain one live status', () => {
  const { handle, state, target } = rendererFixture();
  handle({ type: 'context-compaction-start', runId: 'old' });
  handle({ type: 'context-compaction-start', runId: 'current', agentId: 'child' });
  assert.equal(state().contextCompacting, false);
  handle({ type: 'context-compaction-start', runId: 'current' });
  const original = state().progress.node;
  handle({ type: 'context-compaction-start', runId: 'current' });
  assert.equal(state().progress.node, original);
  assert.equal(target.children.filter(node => node.className === 'context-compaction-progress').length, 1);
  handle({ type: 'context-compaction-end', runId: 'old', status: 'failed' });
  assert.equal(state().contextCompacting, true);
  handle({ type: 'context-compacted', runId: 'current', count: 1 });
  assert.equal(state().contextCompacting, false);
  assert.equal(original.className, 'context-compaction-notice');
  assert.equal(original.textContent, '上下文已自动压缩');
  handle({ type: 'context-compacted', runId: 'current', count: 1 });
  assert.equal(target.children.length, 1, 'Duplicate completion does not add another notice');
});

test('cancelled compression and active-state restoration do not leave stale running notices', () => {
  const { handle, state, context, target } = rendererFixture();
  context.syncContextCompaction({ running: true, kind: 'agent', runId: 'current', compacting: true });
  assert.equal(state().contextCompacting, true);
  handle({ type: 'context-compaction-end', runId: 'current', status: 'cancelled' });
  assert.equal(state().contextCompacting, false);
  assert.equal(target.children[0].textContent, '上下文压缩已取消');
  context.syncContextCompaction({ running: true, kind: 'agent', runId: 'current', compacting: true });
  assert.equal(state().contextCompacting, true);
  context.syncContextCompaction({ running: false, kind: 'agent', runId: 'current', compacting: false });
  assert.equal(state().contextCompacting, false);
  assert.equal(target.children.some(node => node.className === 'context-compaction-progress'), false);
});
