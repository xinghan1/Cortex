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
  const input = new Node(), hint = new Node(), doc = new Node(), requests = [], cancellations = [];
  let serial = 0, context = { sessionId: 'session-a', workspaceId: 'workspace-a', model: 'fixture' };
  input.ownerDocument = doc; doc.activeElement = input; input.value = '继续'; input.selectionStart = input.selectionEnd = 2;
  input.setSelectionRange = (from, to) => { input.selectionStart = from; input.selectionEnd = to; };
  input.setRangeText = (text, from, to) => { input.value = input.value.slice(0, from) + text + input.value.slice(to); input.setSelectionRange(from + text.length, from + text.length); };
  class InputEvent { constructor(type, fields) { this.type = type; Object.assign(this, fields); } }
  doc.execCommand = (_name, _unused, text) => { input.setRangeText(text, input.selectionStart, input.selectionEnd); input.dispatchEvent(new InputEvent('input', {})); return true; };
  const environment = vm.createContext({ InputEvent, crypto: { randomUUID: () => `request-${++serial}` } });
  vm.runInContext(source, environment);
  const controller = environment.ForgePromptCompletion.create({ input, hint, getContext: () => context,
    request: args => new Promise((resolve, reject) => requests.push({ args, resolve, reject })),
    cancel: args => { cancellations.push(args.id); return Promise.resolve(); },
  });
  const key = (key, extra = {}) => { const event = { type: 'keydown', key, ...extra }; input.dispatchEvent(event); return event; };
  const reply = (index = 0, suffix = '检查测试结果。') => requests[index].resolve({ ...requests[index].args, text: requests[index].args.draft + suffix });
  const edit = value => { input.value = value; input.setSelectionRange(value.length, value.length); input.dispatchEvent({ type: 'input' }); };
  return { input, hint, doc, requests, cancellations, controller, key, reply, edit, setContext: value => { context = value; } };
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

test('account isolation failures explain the next step without exposing arbitrary provider errors', async () => {
  const f = fixture(); f.key('Tab');
  f.requests[0].reject(new Error("Error invoking remote method: 会话模型账号已变化，请新建会话后再补全提示词。")); await tick();
  assert.equal(f.hint.textContent, '账号已变化 · 新建会话后补全');
  assert.equal(f.input.value, '继续');
  f.key('Tab'); f.requests[1].reject(new Error('provider secret diagnostic')); await tick();
  assert.equal(f.hint.textContent, '补全未完成，可重新按 Tab');
  assert.equal(f.input.value, '继续');
});
