import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const context = vm.createContext({});
vm.runInContext(await fs.readFile(new URL('../src/renderer/code-diff.js', import.meta.url), 'utf8'), context);
vm.runInContext(await fs.readFile(new URL('../src/renderer/task-change-summary.js', import.meta.url), 'utf8'), context);
const aggregate = (...args) => JSON.parse(JSON.stringify(context.ForgeTaskChangeSummary.aggregate(...args)));
const edit = (id, path, before, after, extra = {}) => ({ runId: 'run-one', toolCallId: id, path, before, after, ...extra });

test('same-run repeated writes merge first before to last after and count each file once', () => {
  const edits = [edit('a1', 'a.js', 'old\n', 'middle\n'), edit('b', 'b.js', null, 'one\ntwo\n'), edit('a2', 'a.js', 'middle\n', 'final\n')];
  const original = structuredClone(edits), value = aggregate(edits, 'run-one', { expectedCount: 3 });
  assert.deepEqual(value.files.map(file => [file.path, file.before, file.after, file.added, file.removed]),
    [['a.js', 'old\n', 'final\n', 1, 1], ['b.js', null, 'one\ntwo\n', 2, 0]]);
  assert.equal(value.added, 3); assert.equal(value.removed, 1); assert.equal(value.exact, true); assert.deepEqual(edits, original);
});

test('net-zero creations and edits disappear, including create/delete/recreate chains', () => {
  const value = aggregate([edit('1', 'x', null, 'created'), edit('2', 'x', 'created', null),
    edit('3', 'a', 'old', 'new'), edit('4', 'a', 'new', 'old'), edit('5', 'b', null, ''), edit('6', 'b', '', null),
    edit('7', 'c', null, 'first'), edit('8', 'c', 'first', null), edit('9', 'c', null, 'last')], 'run-one', { expectedCount: 9 });
  assert.deepEqual(value.files.map(file => file.path), ['c']); assert.equal(value.added, 1); assert.equal(value.removed, 0);
});

test('other runs, proposals and malformed snapshots never count; replayed snapshots deduplicate', () => {
  const first = edit('1', './src\\a.js', 'old', 'new');
  const value = aggregate([first, { ...first }, edit('2', 'other', null, 'not this run', { runId: 'other-run' }),
    { runId: 'run-one', kind: 'write', path: 'proposal', before: 'old' }, { ...first, path: 'bad', after: 3 }], 'run-one', { expectedCount: 1 });
  assert.equal(value.recordedCount, 1); assert.equal(value.files.length, 1); assert.equal(value.files[0].path, 'src/a.js'); assert.equal(value.complete, true);
});

test('non-contiguous snapshots remain separate segments and never claim a fabricated net diff', () => {
  const value = aggregate([edit('1', 'a', 'old', 'first'), edit('2', 'a', 'external change', 'last')], 'run-one', { expectedCount: 2 });
  const file = value.files[0]; assert.equal(file.continuous, false); assert.equal(file.segments.length, 2);
  assert.equal(file.added, null); assert.equal(file.removed, null); assert.equal(value.exact, false); assert.equal(value.added, null);
});

test('bounded or legacy archives expose recorded files but keep whole-run totals unknown', () => {
  for (const expectedCount of [undefined, 4]) {
    const value = aggregate([edit('last', 'a', 'later', 'latest')], 'run-one', { expectedCount });
    assert.equal(value.files.length, 1); assert.equal(value.complete, false); assert.equal(value.added, null); assert.equal(value.removed, null);
  }
  const empty = aggregate([], 'run-one', { expectedCount: 4 }); assert.equal(empty.complete, false); assert.equal(empty.expectedCount, 4);
});

test('Windows case and separator variants merge as one file identity', () => {
  const value = aggregate([edit('1', 'Docs\\README.md', 'old', 'first'), edit('2', './docs/readme.md', 'first', 'last')],
    'run-one', { expectedCount: 2 });
  assert.equal(value.files.length, 1); assert.equal(value.files[0].before, 'old'); assert.equal(value.files[0].after, 'last');
  assert.equal(value.files[0].continuous, true); assert.equal(value.complete, true);
});

test('external same-name files show complete addresses and merge only their own canonical snapshots', async () => {
  const edits = [edit('1', 'same.txt', 'client before', 'client after'),
    edit('2', 'G:/server/same.txt', 'server before', 'server middle'),
    edit('2', 'g:\\server\\same.txt', 'server before', 'server middle'),
    edit('3', 'g:\\server\\same.txt', 'server middle', 'server after'),
    edit('4', 'H:/other/same.txt', null, 'other server')];
  const value = aggregate(edits, 'run-one', { expectedCount: 4 });
  assert.equal(value.complete, true); assert.equal(value.files.length, 3);
  assert.deepEqual(value.files.map(file => [file.path, file.before, file.after]), [
    ['same.txt', 'client before', 'client after'], ['G:/server/same.txt', 'server before', 'server after'], ['H:/other/same.txt', null, 'other server']]);
  const card = context.ForgeTaskChangeSummary.create(value), rows = card.querySelectorAll('.task-change-file');
  assert.deepEqual(rows.map(row => row.dataset.external), ['false', 'true', 'true']);
  assert.equal(rows[1].querySelector('.task-change-path').textContent, 'G:/server/same.txt');
  assert.equal(rows[1].title, 'G:/server/same.txt');
  await rows[1].click();
  assert.equal(card.querySelectorAll('.task-change-diff').length, 1);
  assert.equal(card.querySelector('.task-change-diff').dataset.path, 'G:/server/same.txt');
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.className = ''; this.disabled = false; this.hidden = false; this.content = ''; }
  set textContent(value) { this.content = String(value); this.children.forEach(child => { child.parentNode = null; }); this.children = []; }
  get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
  get classList() {
    return { add: (...values) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...values])].join(' '); },
      contains: value => this.className.split(' ').includes(value),
      toggle: (value, enabled) => {
        const classes = new Set(this.className.split(' ').filter(Boolean));
        const add = enabled ?? !classes.has(value); if (add) classes.add(value); else classes.delete(value);
        this.className = [...classes].join(' '); return add;
      } };
  }
  append(...items) { for (const child of items) { child.remove(); child.parentNode = this; this.children.push(child); } }
  appendChild(child) { this.append(child); return child; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, callback) { this.listeners[type] = callback; }
  querySelectorAll(selector) {
    const result = [];
    for (const child of this.children) {
      if (selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector) result.push(child);
      result.push(...child.querySelectorAll(selector));
    }
    return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  async click() {
    for (let element = this; element; element = element.parentNode) if (element.disabled || element.hidden || element.inert) return;
    return this.listeners.click?.();
  }
}
context.document = { createElement: tag => new Element(tag), createTextNode: value => { const text = new Element('#text'); text.textContent = value; return text; } };
const summary = () => aggregate([edit('one', 'a', 'old', 'new')], 'run-one', { expectedCount: 1 });

test('one file has one stable clickable row with a lazy inline preview reused across repeated toggles', async () => {
  const expanded = [], card = context.ForgeTaskChangeSummary.create(summary(), { onExpand: entry => expanded.push(entry) });
  const entry = card.querySelector('.task-change-entry'), row = card.querySelector('.task-change-file'), view = card.querySelector('.task-change-view');
  const preview = entry.querySelector('.task-change-file-preview');
  assert.equal(card.querySelectorAll('.task-change-file').length, 1); assert.equal(card.querySelectorAll('.task-change-diff').length, 0);
  assert.equal(preview.querySelector('.task-change-collapse-inner').inert, true);
  await row.click();
  const diff = entry.querySelector('.task-change-diff');
  assert.equal(row.attributes['aria-expanded'], 'true'); assert.equal(preview.classList.contains('open'), true);
  assert.equal(row.parentNode, entry); assert.equal(diff.parentNode.parentNode.parentNode, entry);
  assert.equal(card.querySelectorAll('details').length, 0); assert.equal(card.querySelectorAll('summary').length, 0);
  assert.equal(card.querySelectorAll('.task-change-diff-heading').length, 0);
  assert.equal(card.querySelectorAll('.code-diff-filename').length, 0); assert.equal(card.querySelectorAll('.code-diff-stats').length, 0);
  assert.equal(card.querySelectorAll('.code-diff-copy').length, 1); assert.equal(card.querySelectorAll('.task-change-path').length, 1);
  assert.equal(expanded[0], entry);
  await row.click(); assert.equal(row.attributes['aria-expanded'], 'false'); assert.equal(view.textContent, '查看变更');
  assert.equal(preview.querySelector('.task-change-collapse-inner').inert, true);
  for (let count = 0; count < 3; count++) { await view.click(); await view.click(); }
  await row.click();
  assert.equal(entry.querySelector('.task-change-diff'), diff); assert.equal(card.querySelector('.task-change-entry'), entry);
  assert.equal(card.querySelectorAll('.task-change-file').length, 1); assert.equal(card.querySelectorAll('.task-change-diff').length, 1);
  assert.equal(card.querySelectorAll('.code-diff-card').length, 1); assert.equal(expanded.length, 5);
  assert.ok(expanded.every(value => value === entry));
});

test('view changes opens only visible file rows, and showing more reuses previews without a duplicate filename list', async () => {
  const edits = Array.from({ length: 5 }, (_, index) => edit(String(index), `src/file-${index}.js`, 'old\n', 'new\n'));
  const card = context.ForgeTaskChangeSummary.create(aggregate(edits, 'run-one', { expectedCount: edits.length }));
  const rows = card.querySelectorAll('.task-change-file'), view = card.querySelector('.task-change-view'), more = card.querySelector('.task-change-more');
  const visibleRows = () => rows.filter(row => { for (let parent = row; parent; parent = parent.parentNode) if (parent.inert) return false; return true; });
  assert.equal(visibleRows().length, 3); assert.equal(card.querySelectorAll('.task-change-diff').length, 0);
  await view.click();
  assert.deepEqual(rows.map(row => row.attributes['aria-expanded']), ['true', 'true', 'true', 'false', 'false']);
  assert.equal(card.querySelectorAll('.task-change-diff').length, 3);
  await more.click(); assert.equal(visibleRows().length, 5); assert.equal(card.querySelectorAll('.task-change-diff').length, 5);
  const previews = card.querySelectorAll('.task-change-diff');
  await more.click(); assert.equal(visibleRows().length, 3); assert.equal(rows[3].attributes['aria-expanded'], 'false');
  await view.click(); assert.ok(rows.every(row => row.attributes['aria-expanded'] === 'false'));
  await view.click(); await more.click();
  assert.equal(visibleRows().length, 5); assert.equal(card.querySelectorAll('.task-change-file').length, 5);
  assert.deepEqual(card.querySelectorAll('.task-change-diff'), previews);
  assert.equal(card.querySelectorAll('.task-change-path').length, 5); assert.equal(card.querySelectorAll('.code-diff-filename').length, 0);
  await rows[1].click(); assert.equal(rows[1].attributes['aria-expanded'], 'false'); assert.equal(view.textContent, '收起变更');
});

test('inline previews retain separate discontinuous segments and distinguish archive gaps from large diff fallback', async () => {
  const broken = aggregate([edit('one', 'a', 'old', 'first'), edit('two', 'a', 'external', 'last')], 'run-one', { expectedCount: 2 });
  const card = context.ForgeTaskChangeSummary.create(broken); await card.querySelector('.task-change-file').click();
  assert.equal(card.querySelectorAll('.task-change-file').length, 1); assert.equal(card.querySelectorAll('.task-change-diff').length, 1);
  assert.equal(card.querySelectorAll('.code-diff-card').length, 2); assert.equal(card.querySelectorAll('.code-diff-copy').length, 2);
  assert.match(card.textContent, /记录不连续，总净变化未计算/u); assert.match(card.textContent, /以下分别展示已记录片段/u);
  const large = aggregate([edit('large', 'large.js', Array.from({ length: 150 }, (_, index) => `old ${index}\n`).join(''),
    Array.from({ length: 150 }, (_, index) => `new ${index}\n`).join(''))], 'run-one', { expectedCount: 1 });
  assert.equal(large.files[0].continuous, true); assert.equal(large.exact, false);
  const fallback = context.ForgeTaskChangeSummary.create(large);
  assert.match(fallback.textContent, /改动较大，差异按整段替换展示/u); assert.doesNotMatch(fallback.textContent, /记录不连续/u);
  const incomplete = context.ForgeTaskChangeSummary.create(aggregate([edit('one', 'a', 'old', 'new')], 'run-one'));
  assert.match(incomplete.textContent, /快照可能未完整保留/u); assert.doesNotMatch(incomplete.textContent, /改动较大/u);
});

test('historical cards use actual backend availability and support repeated undo/redo/undo without permanent UI locks', async () => {
  let controls = { canUndo: true, canRedo: false }, undos = 0, redos = 0;
  const card = context.ForgeTaskChangeSummary.create(summary(), { ...controls, historical: true, getControls: () => controls,
    onUndo: async () => { undos++; controls = { canUndo: false, canRedo: true }; return { status: 'completed' }; },
    onRedo: async () => { redos++; controls = { canUndo: true, canRedo: false }; return { status: 'completed' }; } });
  const undo = card.querySelector('.task-change-undo'), redo = card.querySelector('.task-change-redo');
  assert.equal(undo.disabled, false); assert.equal(redo.hidden, true);
  await undo.click(); assert.equal(undo.disabled, true); assert.equal(redo.disabled, false); assert.equal(redo.hidden, false);
  await redo.click(); assert.equal(undo.disabled, false); assert.equal(redo.hidden, true);
  assert.match(card.querySelector('.task-change-status').textContent, /已取消撤销/u);
  await undo.click(); assert.equal(undos, 2); assert.equal(redos, 1); assert.equal(redo.disabled, false);
  assert.equal(card.dataset.undone, undefined);
});

test('partial undo can leave both directions available, while a pending action locks both without inventing success', async () => {
  let resolve, calls = 0;
  const controls = { canUndo: true, canRedo: true };
  const card = context.ForgeTaskChangeSummary.create(summary(), { ...controls, getControls: () => controls,
    onUndo: () => { calls++; return new Promise(done => { resolve = done; }); }, onRedo: () => assert.fail('A pending undo must lock redo') });
  const undo = card.querySelector('.task-change-undo'), redo = card.querySelector('.task-change-redo');
  const pending = undo.click(); assert.equal(undo.disabled, true); assert.equal(redo.disabled, true);
  await redo.click(); await undo.click(); assert.equal(calls, 1);
  resolve({ status: 'partial', message: '仅撤销一个文件，另一文件出现冲突。' }); await pending;
  assert.equal(undo.disabled, false); assert.equal(redo.disabled, false); assert.equal(redo.hidden, false);
  assert.match(card.querySelector('.task-change-status').textContent, /另一文件出现冲突/u);
  context.ForgeTaskChangeSummary.updateControls(card, { canUndo: false, canRedo: false });
  assert.equal(undo.disabled, true); assert.equal(redo.disabled, true); assert.equal(redo.hidden, true);
});
