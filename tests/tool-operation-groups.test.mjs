import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

class Element {
  constructor(tagName) { this.tagName = tagName; this.className = ''; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.parentElement = null; this.content = ''; this.open = false; this.hidden = false; }
  get lastElementChild() { return this.children.at(-1) || null; }
  set textContent(value) { this.content = String(value); for (const child of this.children) child.parentElement = null; this.children = []; }
  get textContent() { return this.content + this.children.map(child => child.textContent).join(''); }
  append(...children) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } }
  insertBefore(child, before) { child.remove(); const index = this.children.indexOf(before); assert.notEqual(index, -1); child.parentElement = this; this.children.splice(index, 0, child); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, listener) { (this.listeners[type] ||= []).push(listener); }
  dispatch(type) { for (const listener of this.listeners[type] || []) listener({ type, target: this }); }
  get classList() { return { contains: value => this.className.split(' ').includes(value), remove: value => { this.className = this.className.split(' ').filter(name => name !== value).join(' '); } }; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [...(selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector) ? [child] : [], ...child.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const context = vm.createContext({ document: { createElement: tag => new Element(tag) } });
vm.runInContext(await fs.readFile(new URL('../src/renderer/tool-operation-groups.js', import.meta.url), 'utf8'), context);
const api = context.ForgeToolOperationGroups;
const event = (name = 'read_file', runId = 'run-one') => ({ name, runId });
const card = (text = 'original card', status = 'running') => {
  const element = new Element('details'); element.className = 'tool-card' + (status === 'running' ? ' running' : '');
  if (status !== 'running') element.dataset.status = status;
  const summary = new Element('summary'); summary.textContent = text;
  const detail = new Element('pre'); detail.textContent = 'Original parameters and exact tool result';
  element.append(summary, detail); return element;
};
const finish = (element, status = 'completed') => { element.classList.remove('running'); element.dataset.status = status; api.refresh(element); };
const groups = target => target.querySelectorAll('.tool-operation-group');

test('two adjacent reads move the same original cards into one collapsed group; completion updates its visible summary', () => {
  const target = new Element('div'), first = card('a.txt'), second = card('b.txt'), created = [];
  assert.equal(api.appendTool(target, first, event()), null);
  assert.equal(target.children[0], first);
  const detail = first.querySelector('pre'), group = api.appendTool(target, second, event(), { onGroup: value => created.push(value) });
  assert.equal(group.open, false); assert.equal(target.children.length, 1); assert.equal(target.children[0], group);
  const body = group.querySelector('.tool-operation-group-items');
  assert.deepEqual(body.children, [first, second]); assert.equal(first.querySelector('pre'), detail);
  assert.equal(detail.textContent, 'Original parameters and exact tool result'); assert.deepEqual(created, [group]);
  assert.equal(group.querySelector('.tool-operation-group-label').textContent, '正在读取文件');
  assert.equal(group.querySelector('.tool-operation-group-count').textContent, '2 次');
  assert.equal(group.querySelector('.tool-operation-group-status').textContent, '2 进行中');
  api.refresh(group); assert.equal(group.open, false, 'Running status refreshes never unfold the block');
  finish(first);
  assert.equal(group.querySelector('.tool-operation-group-status').textContent, '1 进行中 · 1 已完成');
  assert.equal(group.open, false);
  finish(second);
  assert.equal(group.dataset.status, 'completed'); assert.equal(group.dataset.count, '2');
  assert.equal(group.querySelector('.tool-operation-group-label').textContent, '读取了文件');
  assert.equal(group.querySelector('.tool-operation-group-status').hidden, true);
  assert.equal(group.open, false);
});

test('later adjacent reads extend the same group without recreating details or counting repeated paths as distinct files', () => {
  const target = new Element('div'), first = card('same.txt', 'completed'), second = card('same.txt', 'completed'), third = card('same.txt', 'completed');
  let notifications = 0;
  api.appendTool(target, first, event());
  const group = api.appendTool(target, second, event(), { onGroup: () => { notifications++; } });
  group.open = true;
  assert.equal(api.appendTool(target, third, event(), { onGroup: () => { notifications++; } }), group);
  assert.equal(notifications, 1); assert.equal(groups(target).length, 1); assert.equal(group.open, true);
  assert.deepEqual(group.querySelector('.tool-operation-group-items').children, [first, second, third]);
  assert.equal(group.querySelector('.tool-operation-group-label').textContent, '读取了文件');
  assert.equal(group.querySelector('.tool-operation-group-count').textContent, '3 次');
  assert.equal(api.appendTool(target, third, event()), group, 'Reattaching an existing original card is idempotent');
  assert.equal(group.dataset.count, '3'); assert.equal(target.querySelectorAll('.tool-card').length, 3);
});

test('creating a group preserves an already opened original detail and later status changes preserve its current fold state', () => {
  const target = new Element('div'), first = card('opened first', 'completed'), second = card('next');
  first.open = true;
  api.appendTool(target, first, event()); const group = api.appendTool(target, second, event());
  assert.equal(group.open, true); assert.equal(first.open, true);
  group.open = false;
  finish(second, 'failed');
  assert.equal(group.open, false, 'A failed result cannot reopen an already collapsed block');
});

test('a continuous block mixes reads, lists, edits and commands while unsupported tools break it', () => {
  const target = new Element('div');
  for (const name of ['read_file', 'read_file', 'list_files', 'list_files']) api.appendTool(target, card(name, 'completed'), event(name));
  const group = groups(target)[0]; assert.equal(groups(target).length, 1);
  assert.equal(group.dataset.operation, 'mixed'); assert.equal(group.dataset.kind, 'read-list');
  assert.equal(group.querySelector('.tool-operation-group-label').textContent, '读取了文件和文件列表');
  for (const name of ['write_file', 'replace_in_file', 'undo_last_change', 'run_command']) api.appendTool(target, card(name, 'completed'), event(name));
  assert.equal(groups(target).length, 1); assert.equal(group.dataset.count, '8'); assert.equal(group.dataset.kind, 'edit-command');
  assert.equal(group.querySelector('.tool-operation-group-label').textContent, '编辑了文件并运行了命令');
  assert.equal(group.querySelector('.tool-operation-group-count').textContent, '8 项操作');
  for (const name of ['browser_snapshot', 'approval-review', 'unsupported_search', '__proto__', 'constructor']) {
    const first = card(name, 'completed'), second = card(name, 'completed');
    assert.equal(api.appendTool(target, first, event(name)), null); assert.equal(api.appendTool(target, second, event(name)), null);
    assert.equal(first.parentElement, target); assert.equal(second.parentElement, target);
  }
  assert.equal(groups(target).length, 1);
  api.appendTool(target, card('read again', 'completed'), event());
  assert.equal(groups(target).length, 1, 'The next operation cannot jump across a browser, approval or unsupported tool');
});

test('adjacent completed searches form one default-collapsed block preserving exact search results and manual disclosure', () => {
  const target = new Element('div'), originals = [card('src/main/java', 'completed'), card('src/main/java', 'completed'), card('src/config', 'completed')];
  assert.equal(api.appendTool(target, originals[0], event('search_files')), null, 'One search stays an ordinary result');
  const group = api.appendTool(target, originals[1], event('search_files'));
  assert.equal(group.open, false); assert.equal(group.dataset.kind, 'search'); assert.equal(group.dataset.operation, 'search_files');
  assert.equal(group.querySelector('.tool-operation-group-label').textContent, '已完成搜索');
  assert.equal(group.querySelector('.tool-operation-group-count').textContent, '2 次');
  assert.equal(group.querySelector('.tool-operation-group-status').hidden, true);
  assert.deepEqual(group.querySelector('.tool-operation-group-items').children, originals.slice(0, 2));
  group.open = true;
  assert.equal(api.appendTool(target, originals[2], event('search_files')), group);
  assert.equal(group.open, true); assert.equal(group.dataset.count, '3');
  assert.deepEqual(group.querySelector('.tool-operation-group-items').children, originals);
  assert.ok(originals.every(original => original.querySelector('pre').textContent === 'Original parameters and exact tool result'));
});

test('search groups keep operation families, assistant messages, steering and task boundaries separate', () => {
  const target = new Element('div');
  const append = (name = 'search_files', runId = 'run-one') => api.appendTool(target, card(name, 'completed'), event(name, runId));
  append('read_file'); append('read_file'); append(); append(); append('run_command'); append('run_command');
  assert.deepEqual(groups(target).map(group => [group.dataset.kind, group.dataset.count]), [['read', '2'], ['search', '2'], ['command', '2']]);
  append(); const assistant = new Element('article'); assistant.className = 'message assistant'; target.append(assistant);
  append(); append();
  assert.equal(groups(target).at(-1).dataset.kind, 'search'); assert.equal(groups(target).at(-1).dataset.count, '2');
  api.breakGroup(target); assert.equal(append(), null);
  append('search_text');
  assert.equal(groups(target).at(-1).dataset.count, '2', 'Historical search_text joins only the adjacent search family');
  assert.equal(groups(target).at(-1).dataset.operation, 'mixed');
  assert.equal(append('search_files', 'another-run'), null);
  assert.equal(groups(target).length, 5, 'Neither a task boundary nor an assistant message may join earlier searches');
});

test('search running and historical failure summaries never claim all searches completed or unfold automatically', () => {
  const target = new Element('div'), completed = card('first', 'completed'), running = card('second');
  api.appendTool(target, completed, event('search_files（模拟）'));
  const group = api.appendTool(target, running, event('search_files（模拟）'));
  assert.equal(group.querySelector('.tool-operation-group-label').textContent, '正在搜索');
  assert.equal(group.querySelector('.tool-operation-group-status').textContent, '1 进行中 · 1 已完成');
  finish(running, 'failed');
  assert.equal(group.open, false); assert.equal(group.querySelector('.tool-operation-group-label').textContent, '搜索');
  assert.equal(group.querySelector('.tool-operation-group-status').textContent, '1 已完成 · 1 未完成');
  const historical = new Element('div');
  api.appendTool(historical, card('restored one', 'completed'), event('search_files'));
  const restored = api.appendTool(historical, card('restored two', 'completed'), event('search_text'));
  assert.equal(restored.open, false); assert.equal(restored.querySelector('.tool-operation-group-label').textContent, '已完成搜索');
});

test('labels describe actual member kinds and count mixed operations without claiming every item edited or ran a command', () => {
  for (const [names, label, kind] of [
    [['write_file', 'replace_in_file'], '编辑了文件', 'edit'],
    [['undo_last_change', 'write_file'], '编辑了文件', 'edit'],
    [['run_command', 'run_command'], '运行了命令', 'command'],
    [['read_file', 'run_command'], '运行了命令', 'command'],
    [['list_files', 'write_file'], '编辑了文件', 'edit'],
    [['write_file', 'run_command'], '编辑了文件并运行了命令', 'edit-command'],
    [['list_files', 'list_files'], '读取了文件列表', 'list'],
  ]) {
    const target = new Element('div'), originals = names.map(name => card(name, 'completed'));
    originals.forEach((element, index) => api.appendTool(target, element, event(names[index])));
    const group = groups(target)[0];
    assert.equal(group.querySelector('.tool-operation-group-label').textContent, label); assert.equal(group.dataset.kind, kind);
    assert.equal(group.querySelector('.tool-operation-group-count').textContent, `2 ${kind === 'list' ? '次' : '项操作'}`);
    assert.deepEqual(group.querySelector('.tool-operation-group-items').children, originals);
    assert.equal(group.open, false);
  }
});

test('mixed command and edit blocks keep rich original child nodes and report running or failed members honestly', () => {
  const target = new Element('div'), edit = card('edit', 'completed'), command = card('command');
  const diff = new Element('div'); diff.className = 'code-diff-card'; diff.textContent = 'Exact original diff'; edit.append(diff);
  const result = new Element('div'); result.className = 'command-result'; result.textContent = 'Exact original stdout and exit code'; command.append(result);
  api.appendTool(target, edit, event('write_file')); const group = api.appendTool(target, command, event('run_command'));
  assert.equal(group.querySelector('.tool-operation-group-label').textContent, '正在编辑文件并运行命令');
  assert.equal(group.querySelector('.code-diff-card'), diff); assert.equal(group.querySelector('.command-result'), result);
  finish(command, 'failed');
  assert.equal(group.querySelector('.tool-operation-group-label').textContent, '编辑文件并运行命令');
  assert.equal(group.querySelector('.tool-operation-group-status').textContent, '1 已完成 · 1 未完成');
  assert.equal(group.open, false, 'Mixed edit/command failures update the summary without unfolding its details');
  group.querySelector('summary').dispatch('click'); group.open = true;
  api.refresh(command); assert.equal(group.open, true, 'A manual expansion remains open across result refreshes');
});

test('messages, image cards and approval UI break adjacency without copying or hiding the boundary node', () => {
  for (const boundary of ['message user', 'message assistant', 'image-view-card', 'approval-card']) {
    const target = new Element('div'), before = card('before', 'completed'), after = card('after', 'completed');
    api.appendTool(target, before, event());
    const message = new Element('article'); message.className = boundary; message.textContent = 'Boundary stays visible'; target.append(message);
    api.appendTool(target, after, event());
    assert.equal(groups(target).length, 0); assert.deepEqual(target.children, [before, message, after]);
    const next = card('next', 'completed'), group = api.appendTool(target, next, event());
    assert.equal(groups(target).length, 1); assert.deepEqual(target.children, [before, message, group]);
    assert.deepEqual(group.querySelector('.tool-operation-group-items').children, [after, next]);
  }
});

test('explicit steering boundaries prevent reuse of an earlier group even before a message node is inserted', () => {
  const target = new Element('div'), first = card('first', 'completed'), second = card('second', 'completed');
  api.appendTool(target, first, event()); const original = api.appendTool(target, second, event());
  api.breakGroup(target);
  const third = card('after steering', 'completed'); assert.equal(api.appendTool(target, third, event()), null);
  const fourth = card('same next segment', 'completed'), following = api.appendTool(target, fourth, event());
  assert.equal(groups(target).length, 2); assert.notEqual(following, original);
  assert.deepEqual(original.querySelector('.tool-operation-group-items').children, [first, second]);
  assert.deepEqual(following.querySelector('.tool-operation-group-items').children, [third, fourth]);
  api.breakGroup(target); assert.equal(api.appendTool(target, card('last'), event()), null);
});

test('run IDs and different target containers provide independent grouping boundaries', () => {
  const target = new Element('div'), other = new Element('div');
  api.appendTool(target, card('first'), event('read_file', 'run-a'));
  api.appendTool(target, card('second'), event('read_file', 'run-b'));
  assert.equal(groups(target).length, 0);
  const group = api.appendTool(target, card('third'), event('read_file', 'run-b'));
  assert.equal(group.dataset.runId, 'run-b'); assert.equal(group.dataset.count, '2');
  api.appendTool(other, card('other first'), event('read_file', 'run-b'));
  assert.equal(groups(other).length, 0); assert.equal(groups(target).length, 1);
});

test('failed, denied, stopped and missing-result summaries stay visible while details open only by user choice', () => {
  for (const [status, label] of [['failed', '未完成'], ['denied', '未执行'], ['stopped', '已停止'], ['unknown', '未返回']]) {
    const target = new Element('div'), first = card('first'), second = card('second');
    api.appendTool(target, first, event()); const group = api.appendTool(target, second, event());
    finish(first, status);
    assert.equal(group.open, false, 'The first unsuccessful result must not automatically unfold details');
    assert.match(group.querySelector('.tool-operation-group-status').textContent, new RegExp(label, 'u'));
    group.querySelector('summary').dispatch('click'); group.open = true;
    finish(second, status);
    assert.equal(group.open, true, 'Later results preserve a manual expansion');
    assert.equal(group.dataset.status, status); assert.equal(group.querySelector('.tool-operation-group-status').hidden, false);
    assert.equal(group.querySelector('.tool-operation-group-label').textContent, '读取文件');
    assert.equal(group.querySelector('.tool-operation-group-status').textContent, `2 ${label}`);
    group.querySelector('summary').dispatch('click'); group.open = false;
    api.appendTool(target, card('another unsuccessful result', status), event());
    assert.equal(group.open, false, 'Appending another unsuccessful operation preserves a manual collapse');
    assert.equal(group.querySelector('.tool-operation-group-status').textContent, `3 ${label}`);
  }
});

test('historical terminal states group through the same API and never change the original card expansion state', () => {
  const target = new Element('div'), first = card('a', 'completed'), second = card('b', 'failed');
  api.appendTool(target, first, event('read_file（模拟）'));
  const group = api.appendTool(target, second, event('read_file（模拟）'));
  assert.equal(group.dataset.operation, 'read_file'); assert.equal(group.open, false);
  assert.equal(first.open, false); assert.equal(second.open, false);
  assert.equal(group.querySelector('.tool-operation-group-status').textContent, '1 已完成 · 1 未完成');
  assert.equal(group.querySelector('.tool-operation-group-label').textContent.includes('已读取'), false);
});

test('moving an original card to another target dissolves a one-card group and preserves both cards and order', () => {
  const target = new Element('div'), other = new Element('div'), first = card('first', 'completed'), second = card('second', 'completed');
  const boundary = new Element('article'); boundary.textContent = 'before'; target.append(boundary);
  api.appendTool(target, first, event()); const group = api.appendTool(target, second, event());
  assert.equal(api.appendTool(other, first, event()), null);
  assert.deepEqual(target.children, [boundary, second]); assert.deepEqual(other.children, [first]);
  assert.equal(groups(target).length, 0); assert.equal(api.refresh(group), null);
  const following = api.appendTool(target, card('third', 'completed'), event());
  assert.deepEqual(following.querySelector('.tool-operation-group-items').children.map(element => element.querySelector('summary').textContent), ['second', 'third']);
});
