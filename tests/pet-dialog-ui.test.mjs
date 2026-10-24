import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/pet-dialog.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
class Element {
  constructor(document, tag = 'div') {
    Object.assign(this, { document, tagName: tag.toUpperCase(), id: '', className: '', hidden: false, disabled: false,
      children: [], parentElement: null, style: {}, dataset: {}, attributes: new Map(), events: new Map(), value: '',
      textContent: '', selectionStart: 0, selectionEnd: 0, scrollTop: 0, scrollHeight: 200, clientHeight: 200 });
    const classes = new Set(); this.classList = { add: name => classes.add(name), remove: name => classes.delete(name),
      contains: name => classes.has(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) };
  }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); } }
  insertBefore(node, reference) { node.remove(); node.parentElement = this; this.children.splice(this.children.indexOf(reference), 0, node); }
  remove() {
    if (!this.parentElement) return;
    if (this.contains(this.document.activeElement)) this.document.activeElement = this.document.body;
    const siblings = this.parentElement.children; siblings.splice(siblings.indexOf(this), 1); this.parentElement = null;
  }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  get isConnected() { return this.document.body.contains(this); }
  get offsetWidth() { return this.id === 'pet-dialog-launcher' ? 100 : this.getBoundingClientRect().width; }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (selector === '[hidden]' && node.hidden) return node; return null; }
  setAttribute(key, value) { this.attributes.set(key, String(value)); }
  getAttribute(key) { return this.attributes.get(key); }
  addEventListener(type, fn) { const list = this.events.get(type) || []; list.push(fn); this.events.set(type, list); }
  removeEventListener(type, fn) { this.events.set(type, (this.events.get(type) || []).filter(value => value !== fn)); }
  fire(type, fields = {}) { const event = { target: this, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...fields }; for (const fn of this.events.get(type) || []) fn(event); return event; }
  focus() { this.document.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  getBoundingClientRect() {
    if (this.hidden) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    const left = Number.parseFloat(this.style.left) || 0, top = Number.parseFloat(this.style.top) || 0;
    const width = Number.parseFloat(this.style.width) || 340, height = 280;
    return this.rect || { left, top, width, height, right: left + width, bottom: top + height };
  }
}
function documentFixture() {
  const document = {}; document.createElement = tag => new Element(document, tag);
  document.documentElement = document.createElement('html'); document.body = document.createElement('body'); document.activeElement = document.body;
  const all = (node = document.body) => [node, ...node.children.flatMap(child => all(child))];
  document.getElementById = id => all().find(node => node.id === id) || null;
  document.querySelector = selector => selector.startsWith('#') ? document.getElementById(selector.slice(1))
    : all().find(node => node.className.split(' ').includes(selector.slice(1))) || null;
  const observers = [], frames = new Map(); let nextFrame = 0;
  const view = new Element(document, 'window'); Object.assign(view, { innerWidth: 1200, innerHeight: 900,
    getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible' }),
    requestAnimationFrame: fn => { const id = ++nextFrame; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe(target) { this.target = target; } disconnect() { this.target = null; } },
    ResizeObserver: class { constructor(callback) { this.callback = callback; } observe() {} unobserve() {} disconnect() {} },
  });
  document.defaultView = view;
  const composer = document.createElement('div'); composer.className = 'composer-area';
  const taskForm = document.createElement('form'); taskForm.id = 'task-form';
  const draft = document.createElement('textarea'); draft.id = 'task-input'; draft.value = '原有草稿 <script>保留</script>'; draft.setSelectionRange(2, 5);
  const toolbar = document.createElement('div'); toolbar.className = 'composer-context';
  const attachments = document.createElement('div'); attachments.id = 'attachment-drafts';
  taskForm.append(draft, attachments, toolbar); composer.append(taskForm); document.body.append(composer);
  const pet = document.createElement('aside'); pet.id = 'pet-overlay'; pet.rect = { left: 900, top: 500, right: 1100, bottom: 700, width: 200, height: 200 }; document.body.append(pet);
  return { document, view, composer, taskForm, draft, pet, frames,
    notify(node) { for (const observer of observers) if (observer.target === node) observer.callback([]); },
    flush() { let rounds = 0; while (frames.size && rounds++ < 10) { const pending = [...frames]; frames.clear(); for (const [, fn] of pending) fn(); } assert.ok(rounds < 10, 'Layout frames must settle'); },
  };
}
const empty = (revision = 0) => ({ revision, question: null, messages: [], running: false, error: null });
const asking = (id = 'question-one', blocking = true) => ({ ...empty(1), question: {
  id, blocking, kind: blocking ? 'decision' : 'casual', question: '<img onerror=unsafe> 选择一个处理方式？', options: ['先检查', '直接修改'],
} });
async function fixture(t, initial = asking(), options = {}) {
  const dom = documentFixture(); if (options.hiddenPet) dom.pet.hidden = true;
  let context = { workspaceId: 'workspace-one', sessionId: 'session-one' }, current = initial, listener, unsubscribed = false;
  const calls = [];
  const envelope = value => ({ ...value, ...context });
  const bridge = { getState: async () => ({ ...context }), getPetDialog: async () => envelope(current),
    onEvent: fn => { listener = fn; return () => { unsubscribed = true; }; },
    answerPetDialog: async arg => { calls.push({ method: 'answer', ...arg }); if (options.answer) return options.answer(arg); current = empty(current.revision + 1); return envelope(current); },
    dismissPetDialog: async arg => { calls.push({ method: 'dismiss', ...arg }); current = empty(current.revision + 1); return envelope(current); },
    sendPetChat: async arg => { calls.push({ method: 'chat', ...arg }); current = { ...asking('chat-reply', false), revision: current.revision + 1 }; return envelope(current); },
    stopTask: async () => { calls.push({ method: 'stop' }); },
  };
  vm.runInNewContext(source, { window: dom.view });
  const api = dom.view.ForgePetDialog.create({ document: dom.document, bridge }); await api.ready; dom.flush();
  t.after(() => api.destroy());
  return { ...dom, api, calls, node: id => dom.document.getElementById(id), envelope,
    emit(value) { current = value; listener({ type: 'pet-dialog', ...context, petDialog: value }); dom.flush(); },
    changeContext(value) { context = value; current = empty(); listener({ type: 'state', state: context }); dom.flush(); },
    get unsubscribed() { return unsubscribed; },
  };
}

test('a blocking bubble uses text-only choices and scope-bound answers without sending or editing the main draft', async t => {
  const pending = deferred(), h = await fixture(t, asking(), { answer: () => pending.promise });
  assert.equal(h.node('pet-dialog').dataset.mode, 'bubble');
  assert.equal(h.node('pet-dialog-question').textContent, '<img onerror=unsafe> 选择一个处理方式？');
  assert.equal(h.node('pet-dialog-question').children.length, 0);
  const original = h.draft.value, selection = [h.draft.selectionStart, h.draft.selectionEnd];
  const choice = h.node('pet-dialog-options').children[1]; choice.fire('click'); choice.fire('click');
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].choiceIndex, 1); assert.equal(h.calls[0].text, undefined);
  assert.equal(h.calls[0].workspaceId, 'workspace-one'); assert.equal(h.calls[0].sessionId, 'session-one');
  pending.resolve(h.envelope(empty(2))); await tick(); h.flush();
  assert.equal(h.node('pet-dialog').hidden, true); assert.equal(h.draft.value, original);
  assert.deepEqual([h.draft.selectionStart, h.draft.selectionEnd], selection);
});

test('hiding the pet replaces only the form presentation and retains a usable stop action and original selection', async t => {
  const h = await fixture(t, empty(), { hiddenPet: true }); h.draft.focus();
  const original = h.draft.value; h.emit(asking());
  assert.equal(h.node('pet-dialog').parentElement, h.composer);
  assert.equal(h.document.documentElement.classList.contains('pet-dialog-replaces-composer'), true);
  assert.equal(h.taskForm.hidden, false); assert.equal(h.draft.value, original);
  h.node('pet-dialog-input').focus(); h.node('pet-dialog-stop').fire('click'); await tick();
  assert.equal(h.calls[0].method, 'stop');
  h.emit(empty(2));
  assert.equal(h.document.documentElement.classList.contains('pet-dialog-replaces-composer'), false);
  assert.equal(h.document.activeElement, h.draft); assert.deepEqual([h.draft.selectionStart, h.draft.selectionEnd], [2, 5]);
});

test('IME and Shift+Enter cannot accidentally answer, while failures preserve the answer and allow retry or cancellation', async t => {
  let failed = true;
  const h = await fixture(t, asking(), { answer: async () => { if (failed) throw new Error('测试发送失败'); return h.envelope(empty(2)); } });
  const input = h.node('pet-dialog-input'); input.value = '自定义答复'; input.fire('compositionstart');
  input.fire('keydown', { key: 'Enter', isComposing: true }); input.fire('compositionend'); input.fire('keydown', { key: 'Enter', shiftKey: true });
  assert.equal(h.calls.length, 0);
  input.fire('keydown', { key: 'Enter' }); await tick();
  assert.equal(h.calls[0].text, '自定义答复'); assert.equal(h.calls[0].choiceIndex, undefined);
  assert.equal(input.value, '自定义答复'); assert.equal(h.node('pet-dialog-error').hidden, false);
  failed = false; input.fire('keydown', { key: 'Enter' }); await tick(); assert.equal(h.node('pet-dialog').hidden, true);
  h.emit({ ...asking('new-question'), revision: 3 }); h.node('pet-dialog').fire('keydown', { key: 'Escape' }); await tick();
  assert.equal(h.calls.at(-1).method, 'dismiss'); assert.equal(h.calls.at(-1).id, 'new-question');
});

test('late answers, errors and events from an old conversation cannot change the new temporary dialogue', async t => {
  for (const fail of [false, true]) {
    const pending = deferred(), h = await fixture(t, asking(), { answer: () => pending.promise });
    h.node('pet-dialog-options').children[0].fire('click');
    h.changeContext({ workspaceId: 'workspace-two', sessionId: 'session-two' }); await tick();
    const next = { ...asking('current-question'), revision: 2 }; h.emit(next);
    if (fail) pending.reject(new Error('OLD ERROR')); else pending.resolve({ ...asking('old-question'), workspaceId: 'workspace-one', sessionId: 'session-one', revision: 20 });
    await tick(); h.flush();
    assert.match(h.node('pet-dialog-question').textContent, /选择一个处理方式/);
    assert.equal(h.node('pet-dialog-error').hidden, true);
    h.api.update({ ...asking('ignored'), workspaceId: 'workspace-one', sessionId: 'session-one', revision: 99 });
    h.node('pet-dialog-options').children[0].fire('click'); assert.equal(h.calls.at(-1).id, 'current-question');
    pending.resolve(h.envelope(empty(3))); h.api.destroy(); assert.equal(h.unsubscribed, true); assert.equal(h.frames.size, 0);
  }
});

test('casual messages stay collapsed while drafting, direct chat uses its own scoped API and never replaces a blocking question', async t => {
  const h = await fixture(t, asking('casual-one', false));
  assert.equal(h.node('pet-dialog-details').hidden, true); assert.equal(h.node('pet-dialog-toggle').textContent, '宠物有话要说');
  assert.equal(h.document.documentElement.classList.contains('pet-dialog-replaces-composer'), false);
  const original = h.draft.value; h.node('pet-dialog-launcher').fire('click');
  assert.equal(h.node('pet-dialog-details').hidden, false);
  h.node('pet-dialog-input').value = '直接和宠物聊天'; h.node('pet-dialog-form').fire('submit'); await tick();
  assert.equal(h.calls[0].method, 'chat'); assert.equal(h.calls[0].id, undefined); assert.equal(h.calls[0].text, '直接和宠物聊天');
  assert.equal(h.draft.value, original);
  h.emit({ ...asking('blocking'), revision: 5 }); h.emit({ ...asking('casual-interruption', false), revision: 6 });
  h.node('pet-dialog-options').children[0].fire('click'); await tick(); assert.equal(h.calls.at(-1).id, 'blocking');
});

test('dragging and resizing coalesce anchor layout, and IME defers moving the active answer form', async t => {
  const h = await fixture(t, asking());
  const before = h.node('pet-dialog').style.left;
  h.pet.rect = { left: 500, top: 300, right: 700, bottom: 500, width: 200, height: 200 };
  h.notify(h.pet); h.notify(h.pet); assert.equal(h.frames.size, 1); h.flush(); assert.notEqual(h.node('pet-dialog').style.left, before);
  const input = h.node('pet-dialog-input'); input.value = '输入法中的内容'; input.focus(); input.fire('compositionstart');
  h.pet.hidden = true; h.notify(h.pet); h.flush(); assert.equal(h.node('pet-dialog').parentElement, h.document.body);
  input.fire('compositionend'); h.flush(); assert.equal(h.node('pet-dialog').parentElement, h.composer); assert.equal(input.value, '输入法中的内容');
  h.pet.hidden = false; h.view.innerWidth = 300; h.notify(h.pet); h.flush();
  const box = h.node('pet-dialog').getBoundingClientRect(); assert.ok(box.left >= 8 && box.right <= 292);
});

test('a new blocking question waits for the original draft IME to finish before hiding its form', async t => {
  const h = await fixture(t, empty(), { hiddenPet: true });
  h.draft.focus(); h.draft.fire('compositionstart'); h.emit(asking('arrived-during-composition'));
  assert.equal(h.document.documentElement.classList.contains('pet-dialog-replaces-composer'), false);
  h.draft.value += '输入法完成'; h.draft.setSelectionRange(3, 6); h.draft.fire('compositionend'); h.flush();
  assert.equal(h.document.documentElement.classList.contains('pet-dialog-replaces-composer'), true);
  const finalDraft = h.draft.value; h.node('pet-dialog-input').focus(); h.emit(empty(2));
  assert.equal(h.draft.value, finalDraft); assert.deepEqual([h.draft.selectionStart, h.draft.selectionEnd], [3, 6]);
  assert.equal(h.document.activeElement, h.draft);
});

test('active chat can start without a question or primary session and closing a pending reply only folds it', async t => {
  const h = await fixture(t, empty(), { hiddenPet: true });
  h.changeContext({ workspaceId: 'workspace-one', sessionId: null }); await tick(); h.flush();
  h.node('pet-dialog-launcher').fire('click'); assert.equal(h.node('pet-dialog').hidden, false);
  h.node('pet-dialog-input').value = '主动聊天'; h.node('pet-dialog-form').fire('submit'); await tick();
  assert.deepEqual(h.calls[0], { method: 'chat', workspaceId: 'workspace-one', sessionId: null, text: '主动聊天' });
  h.emit({ ...empty(3), running: true }); h.node('pet-dialog-close').fire('click');
  assert.equal(h.node('pet-dialog').hidden, true);
  h.emit({ ...asking('late-casual', false), revision: 4 });
  assert.equal(h.node('pet-dialog-details').hidden, true); assert.equal(h.node('pet-dialog-stop').hidden, true);
  assert.equal(h.document.documentElement.classList.contains('pet-dialog-replaces-composer'), false);
});
