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
  dispatchEvent(event) { this.fire(event.type, event); return true; }
  focus() { this.document.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  getBoundingClientRect() {
    if (this.hidden) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    const left = Number.parseFloat(this.style.left) || 0, top = Number.parseFloat(this.style.top) || 0;
    const width = Number.parseFloat(this.style.width) || 316, height = this.id === 'pet-dialog-input-bubble' ? 110 : 150;
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
  const observers = [], frames = new Map(), timers = new Map(); let nextFrame = 0, nextTimer = 0, clock = 0;
  const view = new Element(document, 'window'); Object.assign(view, { innerWidth: 1200, innerHeight: 900,
    getComputedStyle: node => ({ display: node.hidden ? 'none' : 'block', visibility: 'visible' }),
    requestAnimationFrame: fn => { const id = ++nextFrame; frames.set(id, fn); return id; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay }); return id; }, clearTimeout: id => timers.delete(id),
    performance: { now: () => clock }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } },
    MutationObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe(target) { this.target = target; } disconnect() { this.target = null; } },
    ResizeObserver: class { constructor(callback) { this.callback = callback; } observe() {} unobserve() {} disconnect() {} },
  });
  document.defaultView = view;
  document.addEventListener=(...args)=>view.addEventListener(...args);document.removeEventListener=(...args)=>view.removeEventListener(...args);
  const composer = document.createElement('div'); composer.className = 'composer-area';
  const taskForm = document.createElement('form'); taskForm.id = 'task-form';
  const draft = document.createElement('textarea'); draft.id = 'task-input'; draft.value = '原有草稿 <script>保留</script>'; draft.setSelectionRange(2, 5);
  const toolbar = document.createElement('div'); toolbar.className = 'composer-context';
  const attachments = document.createElement('div'); attachments.id = 'attachment-drafts';
  taskForm.append(draft, attachments, toolbar); composer.append(taskForm); document.body.append(composer);
  const pet = document.createElement('aside'); pet.id = 'pet-overlay'; pet.rect = { left: 900, top: 500, right: 1100, bottom: 700, width: 200, height: 200 }; document.body.append(pet);
  return { document, view, composer, taskForm, draft, pet, frames, timers,
    advance(milliseconds) {
      const end = clock + milliseconds;
      while (true) { const next = [...timers].sort((a,b) => a[1].at-b[1].at)[0]; if (!next || next[1].at > end) break;
        clock = next[1].at; timers.delete(next[0]); next[1].fn(); }
      clock = end;
    },
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
    sendPetChat: async arg => { calls.push({ method: 'chat', ...arg }); if (options.chat) return options.chat(arg); current = { ...asking('chat-reply', false), revision: current.revision + 1 }; return envelope(current); },
    reactPetAction: async arg => { calls.push({ method: 'react', ...arg }); if(options.react)return options.react(arg);return envelope({...empty(current.revision+1),running:true,activity:'reaction'}); },
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
  assert.notEqual(h.node('pet-dialog-question').textContent, '<img onerror=unsafe> 选择一个处理方式？'); assert.equal(h.draft.value, original);
  assert.deepEqual([h.draft.selectionStart, h.draft.selectionEnd], selection);
});

test('native choice-only questions hide and disable free text in both pet and composer presentations', async t => {
  for(const hiddenPet of [false,true]){
    const current=asking();current.question.choiceOnly=true;
    const h=await fixture(t,current,{hiddenPet}),input=h.node('pet-dialog-input'),send=h.node('pet-dialog-send');
    assert.equal(h.node('pet-dialog-input-bubble').hidden,true);assert.equal(input.disabled,true);assert.equal(send.disabled,true);assert.equal(send.hidden,true);
    assert.equal(h.node('pet-dialog-cancel').hidden,false);assert.equal(h.node('pet-dialog-stop').hidden,false);
    assert.equal(h.node('pet-dialog-options').children.length,2);assert.ok(h.node('pet-dialog-options').children.every(node=>!node.disabled));
    input.value='不能转换成第一个选项';h.node('pet-dialog-form').fire('submit');input.fire('keydown',{key:'Enter'});await tick();assert.equal(h.calls.length,0);
    h.view.fire('synora:pet-chat-open');assert.equal(h.document.activeElement,h.node('pet-dialog-options').children[0]);
    assert.equal(h.node('pet-dialog-input-bubble').hidden,true);
    h.node('pet-dialog-options').children[1].fire('click');await tick();
    assert.equal(h.calls[0].choiceIndex,1);assert.equal(h.calls[0].text,undefined);assert.equal(input.value,'不能转换成第一个选项');
    assert.equal(h.draft.value,'原有草稿 <script>保留</script>');assert.deepEqual([h.draft.selectionStart,h.draft.selectionEnd],[2,5]);
  }
});

test('choice-only failures stay visible beside the choices and cancellation never invents an answer', async t => {
  const current=asking();current.question.choiceOnly=true;
  const h=await fixture(t,current,{hiddenPet:true,answer:async()=>{throw new Error('原生选项发送失败');}});
  h.node('pet-dialog-options').children[0].fire('click');await tick();
  assert.equal(h.node('pet-dialog-error').hidden,false);assert.equal(h.node('pet-dialog-error').parentElement,h.node('pet-dialog'));
  assert.equal(h.node('pet-dialog-input').disabled,true);assert.equal(h.node('pet-dialog-options').children[1].disabled,false);
  h.node('pet-dialog-cancel').fire('click');await tick();assert.equal(h.calls.at(-1).method,'dismiss');assert.equal(h.calls.at(-1).text,undefined);
});

test('ordinary blocking questions restore custom answers after a choice-only question ends', async t => {
  const current=asking();current.question.choiceOnly=true;const h=await fixture(t,current);
  h.emit({...asking('ordinary'),revision:2});
  assert.equal(h.node('pet-dialog-input-bubble').hidden,false);assert.equal(h.node('pet-dialog-input').disabled,false);assert.equal(h.node('pet-dialog-send').hidden,false);
  h.node('pet-dialog-input').value='保留自由文本答复';h.node('pet-dialog-form').fire('submit');await tick();
  assert.equal(h.calls[0].text,'保留自由文本答复');assert.equal(h.calls[0].choiceIndex,undefined);
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
  failed = false; input.fire('keydown', { key: 'Enter' }); await tick(); assert.equal(h.node('pet-dialog-options').children.length, 0);
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

test('casual speech is independent of draft and input bubbles, direct chat uses its own scoped API and cannot replace a blocking question', async t => {
  const h = await fixture(t, asking('casual-one', false));
  assert.equal(h.node('pet-dialog').hidden, false); assert.equal(h.node('pet-dialog-input-bubble').hidden, true);
  assert.equal(h.node('pet-dialog-messages'), null); assert.equal(h.node('pet-dialog-toggle'), null);
  assert.equal(h.document.documentElement.classList.contains('pet-dialog-replaces-composer'), false);
  const original = h.draft.value; h.view.fire('synora:pet-chat-open');
  assert.equal(h.node('pet-dialog-input-bubble').hidden, false);
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
  h.pet.hidden = true; h.notify(h.pet); h.flush(); assert.equal(h.node('pet-dialog-input-bubble').parentElement, h.document.body);
  input.fire('compositionend'); h.flush(); assert.equal(h.node('pet-dialog-input-bubble').parentElement, h.composer); assert.equal(input.value, '输入法中的内容');
  h.pet.hidden = false; h.view.innerWidth = 300; h.view.fire('resize'); h.notify(h.pet); h.flush();
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
  h.view.fire('synora:pet-chat-open'); assert.equal(h.node('pet-dialog-input-bubble').hidden, false);
  h.node('pet-dialog-input').value = '主动聊天'; h.node('pet-dialog-form').fire('submit'); await tick();
  assert.deepEqual(h.calls[0], { method: 'chat', workspaceId: 'workspace-one', sessionId: null, text: '主动聊天' });
  h.emit({ ...empty(3), running: true }); h.node('pet-dialog-input-bubble').fire('keydown',{key:'Escape'});
  assert.equal(h.node('pet-dialog').hidden, true); h.advance(500); h.flush(); assert.equal(h.node('pet-dialog-input-bubble').hidden, true);
  h.emit({ ...asking('late-casual', false), revision: 4 });
  assert.equal(h.node('pet-dialog').hidden, true); assert.equal(h.node('pet-dialog-stop').hidden, true);
  assert.equal(h.document.documentElement.classList.contains('pet-dialog-replaces-composer'), false);
});

test('welcome is local once per renderer, total lifetime includes two 500ms transitions and Unicode determines duration', async t => {
  const h = await fixture(t, empty());
  const panel = h.node('pet-dialog'), greeting = 'Hello！我是大肥鱼，今天你要做些什么呢？';
  assert.equal(h.node('pet-dialog-question').textContent, greeting); assert.equal(panel.dataset.phase, 'entering');
  const duration = Number(panel.dataset.duration); assert.ok(duration>=5000&&duration<=10000);
  h.advance(500); assert.equal(panel.dataset.phase,'visible');
  h.advance(duration-1001); assert.equal(panel.hidden,false); assert.equal(panel.dataset.phase,'visible');
  h.advance(1); assert.equal(panel.dataset.phase,'leaving'); h.advance(499); assert.equal(panel.hidden,false);
  h.advance(1); h.flush(); assert.equal(panel.hidden,true); assert.equal(h.calls.length,0);
  h.notify(h.pet); h.flush(); assert.equal(panel.hidden,true);
  assert.equal(h.view.ForgePetDialog.durationForText('😀'),5080); assert.equal(h.view.ForgePetDialog.durationForText(''),5000);
  assert.equal(h.view.ForgePetDialog.durationForText('长'.repeat(200)),10000);
  h.api.destroy(); assert.equal(h.timers.size,0);
});

test('ordinary queued speech cannot interrupt its minimum lifetime, local actions are bounded and idle loops stay silent', async t => {
  const h = await fixture(t, { ...asking('long-casual',false), question:{...asking('long-casual',false).question,question:'字'.repeat(100)} });
  const action = (kind,sequence) => h.view.fire('synora:pet-action',{detail:{kind,sequence}});
  action('idle',1); assert.equal(h.calls.length,0);
  for (const [index,kind] of ['drag','thinking','working','result','waiting'].entries()) { action(kind,index+2); if(index<4)h.advance(2000); }
  assert.equal(h.node('pet-dialog-question').textContent,'字'.repeat(100));
  h.advance(2000); const seen=[];
  while(!h.node('pet-dialog').hidden) { seen.push(h.node('pet-dialog-question').textContent); h.advance(Number(h.node('pet-dialog').dataset.duration)); }
  assert.equal(seen.length,4); assert.match(seen[0],/搬家/); assert.ok(seen.every(text=>!text.includes('等你呀')));
  assert.equal(h.calls.length,0);
});

test('blocking speech survives timers and rejects action interruption, while ordinary expiry never discards focused chat input', async t => {
  const h = await fixture(t, empty());
  h.view.fire('synora:pet-chat-open'); const input=h.node('pet-dialog-input'); input.focus(); input.value='尚未发出的聊天'; input.fire('compositionstart');
  h.emit({...asking('casual-next',false),revision:2}); h.advance(30000); h.flush();
  assert.equal(input.value,'尚未发出的聊天'); assert.equal(h.document.activeElement,input); assert.equal(h.node('pet-dialog-input-bubble').hidden,false);
  h.emit({...asking('blocking-now'),revision:3}); h.view.fire('synora:pet-action',{detail:{kind:'clicks',sequence:100}}); h.advance(30000);
  assert.equal(h.node('pet-dialog').hidden,false); assert.match(h.node('pet-dialog-question').textContent,/选择一个处理方式/);
  assert.equal(input.value,'尚未发出的聊天'); assert.equal(h.calls.length,0);
});

test('scope changes reset abandoned composition flags and clear all old speech, queues and timers', async t => {
  const h=await fixture(t,empty()); h.view.fire('synora:pet-chat-open');
  h.node('pet-dialog-input').fire('compositionstart'); h.draft.fire('compositionstart');
  h.changeContext({workspaceId:'fresh-workspace',sessionId:'fresh-session'}); await tick(); h.flush();
  h.pet.hidden=true; h.emit({...asking('fresh-blocking'),revision:2});
  assert.equal(h.document.documentElement.classList.contains('pet-dialog-replaces-composer'),true);
  assert.equal(h.node('pet-dialog-input-bubble').parentElement,h.composer);
  h.node('pet-dialog-input').value='新会话答复'; h.node('pet-dialog-input').fire('keydown',{key:'Enter'}); await tick();
  assert.equal(h.calls[0].text,'新会话答复'); assert.equal(h.calls[0].workspaceId,'fresh-workspace');
  h.api.destroy(); assert.equal(h.timers.size,0); assert.equal(h.frames.size,0);
});

test('opening chat never reserves pet space and showing the pet restores its lower bubble immediately', async t => {
  const h=await fixture(t,empty()), changes=[]; h.view.addEventListener('synora:pet-chat-layout',event=>changes.push(event.detail));
  const original={...h.pet.rect};
  h.view.fire('synora:pet-chat-open'); h.flush();
  assert.equal(changes.length,0); assert.deepEqual(h.pet.rect,original);
  const bubble=h.node('pet-dialog-input-bubble').getBoundingClientRect(); assert.ok(bubble.top>=h.pet.rect.bottom);
  h.pet.hidden=true; h.notify(h.pet); h.flush(); assert.equal(h.node('pet-dialog-input-bubble').dataset.mode,'composer');
  h.pet.hidden=false; h.notify(h.pet); h.flush(); assert.equal(h.node('pet-dialog-input-bubble').dataset.mode,'bubble');
  h.notify(h.pet); h.view.fire('resize'); h.flush(); assert.equal(changes.length,0);
  h.api.destroy(); assert.equal(changes.length,0);
});

test('bottom-edge chat stays below the pet in a compact floating bubble without changing composer flow', async t => {
  const h=await fixture(t,empty());
  h.pet.rect={left:900,top:650,right:1100,bottom:850,width:200,height:200};
  const original={...h.pet.rect};
  h.view.fire('synora:pet-chat-open'); h.notify(h.pet); h.flush();
  const bubble=h.node('pet-dialog-input-bubble');
  assert.equal(bubble.dataset.mode,'bubble'); assert.equal(bubble.parentElement,h.document.body);
  assert.equal(Number.parseFloat(bubble.style.top),858); assert.equal(Number.parseFloat(bubble.style.maxHeight),34);
  assert.equal(h.node('pet-dialog-input').style.minHeight,'32px'); assert.deepEqual(h.pet.rect,original);
  h.view.innerHeight=1000; h.view.fire('resize'); h.flush();
  assert.equal(bubble.dataset.mode,'bubble');
  assert.equal(Number.parseFloat(bubble.style.top),858);
  assert.equal(Number.parseFloat(bubble.style.maxHeight),134);
  assert.equal(h.node('pet-dialog-input').style.minHeight,'');
  assert.deepEqual(h.pet.rect,original);
  h.view.innerHeight=900; h.view.fire('resize'); h.flush();
  assert.equal(bubble.dataset.mode,'bubble'); assert.equal(bubble.parentElement,h.document.body);
  assert.equal(Number.parseFloat(bubble.style.maxHeight),34);
  assert.deepEqual(h.pet.rect,original);
});

test('blocking question bubbles expand without widening casual chat or overflowing a narrow viewport', async t => {
  const h=await fixture(t,asking());
  const petBounds={...h.pet.rect},petStyle={...h.pet.style};
  assert.equal(Number.parseFloat(h.node('pet-dialog').style.width),600);
  assert.equal(Number.parseFloat(h.node('pet-dialog-input-bubble').style.width),316);
  for(const viewport of [616,500,360]){
    h.view.innerWidth=viewport;h.view.fire('resize');h.flush();
    const box=h.node('pet-dialog').getBoundingClientRect();
    assert.equal(box.width,Math.min(600,viewport-16));assert.ok(box.left>=8);assert.ok(box.right<=viewport-8);
    assert.equal(h.node('pet-dialog-cancel').hidden,false);assert.equal(h.node('pet-dialog-stop').hidden,false);
    assert.equal(h.node('pet-dialog-options').children.length,2);assert.ok(h.node('pet-dialog-options').children.every(node=>!node.disabled));
    assert.deepEqual(h.pet.rect,petBounds);assert.deepEqual(h.pet.style,petStyle);
  }
  h.view.innerWidth=1200;h.view.fire('resize');h.flush();
  h.emit(empty(2));h.emit({...asking('casual',false),revision:3});
  assert.equal(Number.parseFloat(h.node('pet-dialog').style.width),316);
  assert.deepEqual(h.pet.rect,petBounds);assert.deepEqual(h.pet.style,petStyle);
});

test('consecutive chat accepts clear only the submitted draft when launch events arrive before the IPC response', async t => {
  let pending=deferred();
  const h=await fixture(t,asking('previous-casual',false),{chat:()=>{h.emit({...empty(h.calls.length*2),running:true});return pending.promise;}});
  h.view.fire('synora:pet-chat-open'); const input=h.node('pet-dialog-input');
  for(let index=1;index<=2;index++) {
    input.value='发送第'+index+'条'; h.node('pet-dialog-form').fire('submit');
    assert.equal(input.disabled,true); pending.resolve(h.envelope({...empty(index*2),running:true})); await tick();
    assert.equal(input.value,''); h.emit({...asking('reply-'+index,false),revision:index*2+1});
    assert.equal(input.disabled,false); pending=deferred();
  }
  input.value='第三条已发'; h.node('pet-dialog-form').fire('submit');
  input.fire('compositionstart'); input.value='正在输入的新候选';
  pending.resolve(h.envelope({...empty(6),running:true})); await tick();
  assert.equal(input.value,'正在输入的新候选'); input.fire('compositionend');
  assert.equal(h.calls.filter(call=>call.method==='chat').length,3);
});

test('explicitly reopening chat can reread the latest expired reply without loading a history window or calling a model', async t => {
  const h=await fixture(t,asking('expired-reply',false)); h.advance(11000); h.flush();
  assert.equal(h.node('pet-dialog').hidden,true); h.view.fire('synora:pet-chat-open');
  assert.equal(h.node('pet-dialog').hidden,false); assert.match(h.node('pet-dialog-question').textContent,/选择一个处理方式/);
  assert.equal(h.node('pet-dialog-messages'),null); assert.equal(h.calls.length,0);
});

test('bundled pet bubbles use its visible character envelope while imported packs retain their full box', async t => {
  const h=await fixture(t,asking());
  h.pet.dataset.packId='dsh-pet';h.notify(h.pet);h.flush();
  const box=h.pet.rect, character=h.view.ForgePetDialog.contentAnchor(box,'dsh-pet');
  const speech=h.node('pet-dialog').getBoundingClientRect(), input=h.node('pet-dialog-input-bubble').getBoundingClientRect();
  assert.ok(Math.abs(speech.bottom-(character.top-10))<.01);
  assert.ok(Math.abs(input.top-(character.bottom+8))<.01);
  assert.ok(input.top<box.bottom,'Transparent padding should not push the input away from the feet');
  assert.equal(h.node('pet-dialog').dataset.anchor,'character');
  h.pet.dataset.packId='imported-pet';h.notify(h.pet);h.flush();
  assert.equal(h.node('pet-dialog').dataset.anchor,'box');
  assert.equal(h.node('pet-dialog-input-bubble').getBoundingClientRect().top,box.bottom+8);
  assert.equal(h.view.ForgePetDialog.contentAnchor(box,'imported-pet'),box);
});

test('hiding the pet while its welcome is active presents a queued model reply in the composer fallback', async t => {
  const h=await fixture(t,empty());assert.match(h.node('pet-dialog-question').textContent,/Hello/);
  h.emit({...asking('queued-reply',false),revision:2});assert.match(h.node('pet-dialog-question').textContent,/Hello/);
  h.pet.hidden=true;h.notify(h.pet);h.flush();
  assert.equal(h.node('pet-dialog').hidden,false);assert.equal(h.node('pet-dialog').dataset.mode,'composer');
  assert.match(h.node('pet-dialog-question').textContent,/选择一个处理方式/);
  h.advance(11000);h.flush();assert.equal(h.node('pet-dialog').hidden,true);
});

test('entry animation transforms do not change the layout height used to anchor bubbles', async t => {
  const h=await fixture(t,asking()), panel=h.node('pet-dialog'), inputBubble=h.node('pet-dialog-input-bubble');
  panel.offsetHeight=150; inputBubble.offsetHeight=110;
  const original=panel.getBoundingClientRect.bind(panel);
  panel.getBoundingClientRect=()=>{const r=original();return{...r,height:135,bottom:r.top+135};};
  const changes=[];h.view.addEventListener('synora:pet-chat-layout',event=>changes.push(event.detail));
  h.pet.rect={left:900,top:450,right:1100,bottom:650,width:200,height:200};h.notify(h.pet);h.flush();
  assert.equal(Number.parseFloat(panel.style.top),290);assert.equal(changes.length,0,'An unchanged real input height must not re-reserve animated dimensions');
});

test('pet-open replaces launch and close controls, while outside collapse preserves local draft and never dismisses backend history', async t => {
  const h=await fixture(t,empty());assert.equal(h.node('pet-dialog-launcher'),null);assert.equal(h.node('pet-dialog-close'),null);
  h.view.fire('synora:pet-chat-open');const input=h.node('pet-dialog-input'),bubble=h.node('pet-dialog-input-bubble');
  assert.equal(h.node('pet-dialog-send').parentElement,input.parentElement);input.value='尚未发出的聊天';input.setSelectionRange(1,4);
  for(const target of [input,bubble,h.pet,h.node('pet-dialog')])h.view.fire('pointerdown',{target});
  assert.notEqual(bubble.dataset.phase,'leaving');
  h.view.fire('pointerdown',{target:h.draft,composedPath:()=>[bubble]});assert.notEqual(bubble.dataset.phase,'leaving');
  const event=h.view.fire('pointerdown',{target:h.draft});assert.equal(event.prevented,undefined);assert.equal(bubble.dataset.phase,'leaving');
  h.advance(500);h.flush();assert.equal(bubble.hidden,true);assert.equal(input.value,'尚未发出的聊天');assert.deepEqual([input.selectionStart,input.selectionEnd],[1,4]);
  assert.equal(h.calls.length,0);h.view.fire('synora:pet-chat-open');assert.equal(input.value,'尚未发出的聊天');assert.equal(bubble.hidden,false);
});

test('outside clicks leave a submitting or replying input open without consuming the main interface click', async t => {
  const accepted=deferred(),h=await fixture(t,empty(),{chat:()=>accepted.promise});h.view.fire('synora:pet-chat-open');
  h.node('pet-dialog-input').value='等待回复';h.node('pet-dialog-form').fire('submit');
  let event=h.view.fire('pointerdown',{target:h.draft});assert.equal(event.prevented,undefined);assert.notEqual(h.node('pet-dialog-input-bubble').dataset.phase,'leaving');
  accepted.resolve(h.envelope({...empty(2),running:true,activity:'chat'}));await tick();
  event=h.view.fire('pointerdown',{target:h.draft});assert.equal(event.prevented,undefined);assert.notEqual(h.node('pet-dialog-input-bubble').dataset.phase,'leaving');
  h.emit({...asking('completed-chat',false),revision:3});h.view.fire('pointerdown',{target:h.draft});
  assert.equal(h.node('pet-dialog-input-bubble').dataset.phase,'leaving');assert.ok(h.calls.every(call=>call.method!=='dismiss'));
});

test('outside collapse waits for IME commit and blocking questions cannot collapse by an outside click', async t => {
  const h=await fixture(t,empty());h.view.fire('synora:pet-chat-open');const input=h.node('pet-dialog-input');
  input.fire('compositionstart');input.value='候选文字';h.view.fire('pointerdown',{target:h.draft});
  assert.notEqual(h.node('pet-dialog-input-bubble').dataset.phase,'leaving');input.value='已提交文字';input.fire('compositionend');h.advance(500);h.flush();
  assert.equal(input.value,'已提交文字');assert.equal(h.node('pet-dialog-input-bubble').hidden,true);
  h.emit({...asking('must-answer'),revision:3});h.view.fire('pointerdown',{target:h.draft});
  assert.equal(h.node('pet-dialog-input-bubble').hidden,false);assert.equal(h.calls.length,0);
});

test('three explicit menu actions use scoped model reactions without local canned text and manual typing is protected', async t => {
  const h=await fixture(t,empty());h.advance(11000);h.flush();
  for(const [index,kind] of ['clicks','turn','actions'].entries()) {
    h.emit(empty(index*3+2));h.view.fire('synora:pet-action',{detail:{kind,sequence:index+100}});await tick();
    assert.equal(h.calls.at(-1).method,'react');assert.equal(h.calls.at(-1).kind,kind);assert.equal(h.calls.at(-1).workspaceId,'workspace-one');
    assert.equal(h.node('pet-dialog').hidden,true,'No fixed line should precede the model result');
    h.emit({...asking('model-'+index,false),revision:index*3+4,question:{...asking('model-'+index,false).question,kind:'reaction',question:'模型回应 '+kind,fallback:false}});
    assert.equal(h.node('pet-dialog-question').textContent,'模型回应 '+kind);h.advance(11000);h.flush();
  }
  h.emit(empty(20));h.view.fire('synora:pet-chat-open');h.node('pet-dialog-input').value='正在聊天';
  h.view.fire('synora:pet-action',{detail:{kind:'turn',sequence:200}});await tick();assert.equal(h.calls.length,3);
  h.node('pet-dialog-input').value='';h.view.fire('synora:pet-action',{detail:{kind:'turn',sequence:201}});await tick();
  assert.equal(h.calls.length,4,'An empty open editor should not block an explicit menu action');
});

test('reaction activity keeps the chat editor available for a manual message and ignores stale reaction responses', async t => {
  const pending=deferred(),h=await fixture(t,empty(),{react:()=>pending.promise});h.view.fire('synora:pet-action',{detail:{kind:'turn',sequence:1}});
  h.emit({...empty(2),running:true,activity:'reaction'});h.view.fire('synora:pet-chat-open');assert.equal(h.node('pet-dialog-input').disabled,false);
  h.changeContext({workspaceId:'next',sessionId:'next'});await tick();
  pending.resolve({workspaceId:'workspace-one',sessionId:'session-one',...asking('old-reaction',false),revision:50});await tick();
  assert.notEqual(h.node('pet-dialog-question').textContent,'<img onerror=unsafe> 选择一个处理方式？');
});
