import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/prompt-completion.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
class Node {
  listeners = new Map(); dataset = {}; attributes = {}; hidden = false;
  addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(handler); }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler); }
  dispatchEvent(event) { event.preventDefault ||= () => { event.defaultPrevented = true; }; for (const handler of this.listeners.get(event.type) || []) handler(event); return !event.defaultPrevented; }
  setAttribute(name, value) { this.attributes[name] = value; }
  closest() { return null; }
}
function fixture() {
  const input = new Node(), hint = new Node(), ghost = new Node(), doc = new Node(), requests = [], cancellations = [];
  doc.defaultView = new Node();
  let serial = 0, canSuggest = true, context = { sessionId: 'session-a', workspaceId: 'workspace-a', model: 'fixture' };
  input.ownerDocument = doc; doc.activeElement = input; input.value = '继续'; input.selectionStart = input.selectionEnd = 2;
  input.setSelectionRange = (from, to) => { input.selectionStart = from; input.selectionEnd = to; };
  input.setRangeText = (text, from, to) => { input.value = input.value.slice(0, from) + text + input.value.slice(to); input.setSelectionRange(from + text.length, from + text.length); };
  class InputEvent { constructor(type, fields) { this.type = type; Object.assign(this, fields); } }
  doc.execCommand = (_name, _unused, text) => { input.setRangeText(text, input.selectionStart, input.selectionEnd); input.dispatchEvent(new InputEvent('input', {})); return true; };
  const environment = vm.createContext({ InputEvent, crypto: { randomUUID: () => `request-${++serial}` } });
  vm.runInContext(source, environment);
  const controller = environment.ForgePromptCompletion.create({ input, hint, ghost, getContext: () => context, canSuggest: () => canSuggest,
    request: args => new Promise((resolve, reject) => requests.push({ args, resolve, reject })),
    cancel: args => { cancellations.push(args.id); return Promise.resolve(); },
  });
  const key = (key, extra = {}) => { const event = { type: 'keydown', key, ...extra }; input.dispatchEvent(event); return event; };
  const reply = (index = 0, suffix = '检查测试结果。') => requests[index].resolve({ ...requests[index].args, text: requests[index].args.draft + suffix });
  const edit = value => { input.value = value; input.setSelectionRange(value.length, value.length); input.dispatchEvent({ type: 'input' }); };
  const round = (runId = 'round-a', extra = {}) => ({ runId, sessionId: 'session-a', workspaceId: 'workspace-a', kind: 'agent', ...extra });
  return { input, hint, ghost, doc, requests, cancellations, controller, key, reply, edit, round,
    setContext: value => { context = value; }, setCanSuggest: value => { canSuggest = value; } };
}

test('Tab explicitly requests one completion and inserts only the continuation without submitting', async () => {
  const f = fixture();
  assert.equal(f.requests.length, 0);
  f.edit('继续检查'); await tick();
  assert.equal(f.requests.length, 0, 'Typing must never incur a background model request');
  assert.equal(f.key('Tab').defaultPrevented, true);
  f.key('Tab'); f.key('Tab', { repeat: true });
  assert.equal(f.requests.length, 1);
  assert.equal(f.hint.dataset.status, 'loading');
  f.reply(0, '并汇报结果。'); await tick();
  assert.equal(f.input.value, '继续检查并汇报结果。');
  assert.equal(f.hint.dataset.status, 'completed');
  assert.equal(f.input.selectionStart, f.input.value.length);
  assert.equal(f.requests.length, 1);
});

test('draft edits, Escape, blur, caret movement and session switches reject late replies and errors', async () => {
  for (const mode of ['edit', 'escape', 'blur', 'caret', 'session']) {
    const f = fixture(); f.key('Tab');
    if (mode === 'edit') f.edit('新的要求');
    if (mode === 'escape') f.key('Escape');
    if (mode === 'blur') { f.doc.activeElement = null; f.input.dispatchEvent({ type: 'blur' }); }
    if (mode === 'caret') { f.input.setSelectionRange(0, 0); f.doc.dispatchEvent({ type: 'selectionchange' }); }
    if (mode === 'session') { f.setContext({ sessionId: 'other', workspaceId: 'workspace-a' }); f.controller.sync(); }
    const value = f.input.value;
    f.reply(); await tick();
    assert.equal(f.input.value, value, mode);
    assert.deepEqual(f.cancellations, ['request-1'], mode);
    assert.notEqual(f.hint.dataset.status, 'completed');
    assert.notEqual(f.hint.dataset.status, 'loading');
  }
  const f = fixture(); f.key('Tab'); f.edit('new');
  f.requests[0].reject(new Error('late failure')); await tick();
  assert.equal(f.hint.dataset.status, 'idle');
});

test('keyboard navigation and composition remain available outside explicit end-of-draft Tab', () => {
  const f = fixture();
  for (const options of [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }]) {
    assert.equal(f.key('Tab', options).defaultPrevented, undefined);
  }
  f.input.setSelectionRange(0, 1); assert.equal(f.key('Tab').defaultPrevented, undefined);
  f.input.setSelectionRange(0, 0); assert.equal(f.key('Tab').defaultPrevented, undefined);
  f.input.setSelectionRange(2, 2);
  f.input.dispatchEvent({ type: 'compositionstart' }); assert.equal(f.key('Tab').defaultPrevented, undefined);
  f.input.dispatchEvent({ type: 'compositionend' });
  assert.equal(f.requests.length, 0);
  f.controller.dispose(); f.key('Tab'); assert.equal(f.requests.length, 0);
});

test('malformed and cross-session results preserve the draft, and failure allows a fresh request', async () => {
  const f = fixture(); f.key('Tab');
  f.requests[0].resolve({ ...f.requests[0].args, sessionId: 'other', text: '替换原文' }); await tick();
  assert.equal(f.input.value, '继续');
  assert.equal(f.hint.dataset.status, 'error');
  f.key('Tab'); f.requests[1].reject(new Error('offline')); await tick();
  assert.equal(f.input.value, '继续'); assert.equal(f.hint.dataset.status, 'error');
  f.key('Tab'); f.reply(2); await tick();
  assert.equal(f.input.value, '继续检查测试结果。');
});

test('completion failures allow retry without exposing arbitrary provider errors', async () => {
  const f = fixture(); f.key('Tab');
  f.requests[0].reject(new Error("Error invoking remote method: 会话模型账号已变化，请新建会话后再补全提示词。")); await tick();
  assert.equal(f.hint.textContent, '补全未完成，可重新按 Tab');
  assert.equal(f.input.value, '继续');
  f.key('Tab'); f.requests[1].reject(new Error('provider secret diagnostic')); await tick();
  assert.equal(f.hint.textContent, '补全未完成，可重新按 Tab');
  assert.equal(f.input.value, '继续');
});

test('a live completed round requests one empty-draft suggestion, visible unfocused until Tab explicitly accepts', async () => {
  const f = fixture(); f.edit('');
  f.doc.activeElement = null;
  f.controller.startRound(f.round());
  const pending = f.controller.suggestAfterRound(f.round('round-a', { status: 'completed' }));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].args.draft, '');
  assert.equal(f.input.value, '');
  f.reply(0, '请补充边界条件测试。'); await pending;
  assert.equal(f.input.value, '', 'A suggestion must never become a submitted or persisted draft automatically');
  assert.equal(f.ghost.textContent, '请补充边界条件测试。'); assert.equal(f.ghost.hidden, false);
  assert.equal(f.hint.hidden, true);
  for (let index = 0; index < 5; index++) {
    f.controller.sync();
    f.controller.suggestAfterRound(f.round('round-a', { status: 'completed' }));
  }
  f.controller.startRound(f.round());
  f.controller.suggestAfterRound(f.round('round-a', { status: 'completed' }));
  assert.equal(f.requests.length, 1, 'Usage broadcasts or duplicate run events must not generate another suggestion');
  assert.equal(f.key('Tab').defaultPrevented, undefined, 'An unfocused textarea cannot accept a suggestion');
  f.doc.activeElement = f.input; f.input.dispatchEvent({ type: 'focus' });
  assert.equal(f.hint.dataset.status, 'suggested');
  assert.equal(f.key('Tab').defaultPrevented, true);
  assert.equal(f.input.value, '请补充边界条件测试。'); assert.equal(f.ghost.hidden, true);
  assert.equal(f.hint.dataset.status, 'completed'); assert.equal(f.requests.length, 1);
});

test('initialization, history, failed/demo/undo rounds, existing drafts, attachments and queues never automatically request', () => {
  for (const mode of ['init', 'history', 'failed', 'stopped', 'demo', 'undo', 'draft', 'attachment', 'queue', 'wrong-session']) {
    const f = fixture();
    if (mode !== 'draft') f.edit('');
    f.controller.sync(); assert.equal(f.requests.length, 0);
    if (!['init', 'history'].includes(mode)) f.controller.startRound(f.round('round-a', { demo: mode === 'demo', kind: mode === 'undo' ? 'undo' : 'agent' }));
    if (mode === 'history') { f.controller.startRound(f.round()); f.controller.cancel(); }
    if (['attachment', 'queue'].includes(mode)) f.setCanSuggest(false);
    if (mode === 'wrong-session') f.setContext({ sessionId: 'new-session', workspaceId: 'workspace-a', model: 'fixture' });
    f.controller.suggestAfterRound(f.round('round-a', { status: ['failed', 'stopped'].includes(mode) ? mode : 'completed' }));
    assert.equal(f.requests.length, 0, mode);
    f.edit(''); f.setCanSuggest(true); f.controller.sync();
    f.controller.suggestAfterRound(f.round('round-a', { status: 'completed' }));
    assert.equal(f.requests.length, 0, `${mode}: clearing a blocker later must not replay the round`);
  }
});

test('typing, context/model changes, new runs and closing cancel automatic requests and ignore late results', async () => {
  for (const mode of ['typing', 'session', 'model', 'role-model', 'attachment', 'new-run', 'close', 'dispose']) {
    const f = fixture(); f.edit(''); f.controller.startRound(f.round());
    const pending = f.controller.suggestAfterRound(f.round('round-a', { status: 'completed' }));
    if (mode === 'typing') f.edit('我自己的问题');
    if (mode === 'session') { f.setContext({ sessionId: 'session-b', workspaceId: 'workspace-a', model: 'fixture' }); f.controller.sync(); }
    if (mode === 'model' || mode === 'role-model') { f.setContext({ sessionId: 'session-a', workspaceId: 'workspace-a', model: mode === 'model' ? 'new-model' : 'fixture', completionModel: mode === 'role-model' ? 'independent-model' : '' }); f.controller.sync(); }
    if (mode === 'attachment') { f.setCanSuggest(false); f.controller.sync(); }
    if (mode === 'new-run') f.controller.startRound(f.round('round-b'));
    if (mode === 'close') f.doc.defaultView.dispatchEvent({ type: 'pagehide' });
    if (mode === 'dispose') f.controller.dispose();
    const draft = f.input.value;
    f.reply(); await pending; await tick();
    assert.equal(f.input.value, draft, mode); assert.equal(f.ghost.hidden, true, mode);
    assert.deepEqual(f.cancellations, ['request-1'], mode);
  }
});

test('Escape dismisses ghost text, IME and Shift+Tab keep normal behavior, and a later round can suggest again', async () => {
  const f = fixture(); f.edit(''); f.controller.startRound(f.round());
  let pending = f.controller.suggestAfterRound(f.round('round-a', { status: 'completed' })); f.reply(); await pending;
  assert.equal(f.key('Tab', { shiftKey: true }).defaultPrevented, undefined);
  assert.equal(f.key('Tab', { isComposing: true }).defaultPrevented, undefined);
  assert.equal(f.key('Escape', { isComposing: true }).defaultPrevented, undefined);
  assert.equal(f.ghost.hidden, false); assert.equal(f.input.value, '');
  assert.equal(f.key('Escape').defaultPrevented, true); assert.equal(f.ghost.hidden, true);
  f.controller.sync(); assert.equal(f.requests.length, 1);
  f.controller.startRound(f.round('round-b'));
  pending = f.controller.suggestAfterRound(f.round('round-b', { status: 'completed' })); f.reply(1, '请检查错误处理。'); await pending;
  assert.equal(f.ghost.textContent, '请检查错误处理。'); assert.equal(f.input.value, '');
});

test('automatic failures are silent and user typing can still use the original manual Tab completion', async () => {
  const f = fixture(); f.edit(''); f.controller.startRound(f.round());
  const pending = f.controller.suggestAfterRound(f.round('round-a', { status: 'completed' }));
  f.requests[0].reject(new Error('private provider diagnostic')); await pending;
  assert.equal(f.input.value, ''); assert.equal(f.ghost.hidden, true); assert.equal(f.hint.dataset.status, 'idle');
  f.edit('请继续'); f.key('Tab'); f.reply(1, '补充测试。'); await tick();
  assert.equal(f.input.value, '请继续补充测试。'); assert.equal(f.requests.length, 2);
});
