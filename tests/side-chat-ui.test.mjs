import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/renderer/side-chat.js', import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const snapshot = (revision, extra = {}) => ({ open: true, running: false, revision, messages: [], ...extra });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture(bridge) {
  const elements = new Map(), nodes = [], notices = [];
  let workspaceId = 'A', focused = null;
  class Element {
    constructor(tag) {
      this.tag = tag; this.children = []; this.listeners = new Map(); this.dataset = {}; this.attributes = {};
      this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false;
      this.scrollHeight = 0; this.scrollTop = 0; this.clientHeight = 0;
      this.classList = { toggle() {} }; nodes.push(this);
    }
    set id(value) { this._id = value; elements.set(value, this); }
    get id() { return this._id; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...items) { this.children.push(...items); }
    prepend(...items) { this.children.unshift(...items); }
    replaceChildren(...items) { this.children = items; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    focus() { focused = this; }
    get text() { return this.textContent + this.children.map(child => child.text).join(' '); }
  }
  const hosts = new Map(['.workspace-layout', '.conversation-controls'].map(selector => [selector, new Element('div')]));
  const document = { documentElement: new Element('html'), createElement: tag => new Element(tag),
    createElementNS: (_, tag) => new Element(tag), createDocumentFragment: () => new Element('fragment'),
    querySelector: selector => hosts.get(selector) };
  const window = {}, context = vm.createContext({ document, window });
  vm.runInContext(source, context);
  const controls = window.ForgeSideChat.create({ bridge, getWorkspaceId: () => workspaceId,
    notice: (...args) => notices.push(args) });
  controls.apply(snapshot(1));
  return { controls, notices, node: id => elements.get(id), focus: () => focused,
    quote: () => nodes.find(node => node.className === 'side-chat-quote-draft'),
    hint: () => nodes.find(node => node.className === 'side-chat-hint'),
    switchWorkspace(id, next) { workspaceId = id; controls.apply(next, id); },
    submit: () => elements.get('side-chat-form').listeners.get('submit')({ preventDefault() {} }),
  };
}

test('closing a project cannot suppress another project sidebar or steal focus when its reply arrives', async () => {
  const close = deferred(), f = fixture({ sideChatClose: () => close.promise });
  const closing = f.controls.close();
  assert.equal(f.node('side-chat-panel').hidden, true);
  f.switchWorkspace('B', snapshot(8, { messages: [{ id: 'B', role: 'user', content: 'project B only' }] }));
  f.node('side-chat-input').focus();
  assert.equal(f.node('side-chat-panel').hidden, false);
  assert.match(f.node('side-chat-messages').text, /project B only/u);
  close.resolve(snapshot(2, { open: false })); await closing;
  assert.equal(f.node('side-chat-panel').hidden, false);
  assert.equal(f.focus(), f.node('side-chat-input'));
  f.controls.apply(snapshot(3, { messages: [{ role: 'assistant', content: 'late A' }] }), 'A');
  assert.doesNotMatch(f.node('side-chat-messages').text, /late A/u);
});

test('a new quote during send preflight preserves that quote and releases the input after the original send reply', async () => {
  const send = deferred(), sent = [];
  let nextOpen = snapshot(2);
  const f = fixture({ sideChatOpen: async () => nextOpen,
    sideChatSend: input => { sent.push(plain(input)); return send.promise; } });
  await f.controls.open('original quote'); f.node('side-chat-input').value = 'original question';
  const sending = f.submit();
  assert.equal(f.node('side-chat-input').disabled, true);
  nextOpen = snapshot(4, { running: true }); await f.controls.open('next question quote');
  assert.equal(f.node('side-chat-input').value, 'original question');
  assert.equal(f.node('side-chat-input').disabled, true, 'Opening a quote does not unlock an unacknowledged send');
  send.resolve(snapshot(3, { running: true })); await sending;
  assert.deepEqual(sent, [{ text: 'original question', quote: 'original quote' }]);
  assert.equal(f.node('side-chat-input').disabled, false);
  assert.equal(f.node('side-chat-input').value, '');
  assert.equal(f.quote().hidden, false); assert.match(f.quote().text, /next question quote/u);
  f.controls.apply(snapshot(5)); f.node('side-chat-input').value = 'next question';
  f.node('side-chat-input').listeners.get('input')();
  assert.equal(f.node('side-chat-send').disabled, false);
});

test('send rejection after opening another quote releases controls without losing the draft', async () => {
  const send = deferred(), f = fixture({ sideChatOpen: async () => snapshot(2), sideChatSend: () => send.promise });
  f.node('side-chat-input').value = 'keep this draft'; const sending = f.submit();
  await f.controls.open('new quote'); send.reject(new Error('connection unavailable')); await sending;
  assert.equal(f.node('side-chat-input').disabled, false); assert.equal(f.node('side-chat-send').disabled, false);
  assert.equal(f.node('side-chat-input').value, 'keep this draft');
  assert.match(f.quote().text, /new quote/u);
  assert.match(f.node('side-chat-error').textContent, /connection unavailable/u);
});

test('hiding retains chat, draft and quote while background sends and streaming finish without reopening it', async () => {
  const user = { role: 'user', content: 'temporary question' };
  const partial = { role: 'assistant', content: 'background answer', status: 'streaming' };
  const completed = { ...partial, status: 'completed' };
  let nextOpen = snapshot(8);
  const send = deferred(), close = deferred(), f = fixture({ sideChatSend: () => send.promise,
    sideChatClose: () => close.promise, sideChatOpen: async () => nextOpen });
  await f.controls.open('retained reference');
  f.node('side-chat-input').value = 'next draft'; const sending = f.submit();
  f.controls.apply(snapshot(9, { running: true, messages: [user] }));
  const closing = f.controls.close();
  assert.equal(f.node('side-chat-panel').hidden, true);
  assert.match(f.node('side-chat-messages').text, /temporary question/u);
  assert.equal(f.node('side-chat-input').value, 'next draft');
  assert.match(f.quote().text, /retained reference/u);
  assert.equal(f.node('side-chat-stop').hidden, false);
  assert.equal(f.focus(), f.node('toggle-side-chat'));
  f.controls.apply(snapshot(10, { running: true, messages: [user, partial] }));
  assert.equal(f.node('side-chat-panel').hidden, true);
  assert.match(f.node('side-chat-messages').text, /background answer/u);
  close.resolve(snapshot(11, { open: false, running: true, messages: [user, partial] })); await closing;
  send.resolve(snapshot(9, { running: true, messages: [user] })); await sending;
  assert.equal(f.node('side-chat-input').value, 'next draft');
  assert.equal(f.node('side-chat-input').disabled, false);
  assert.match(f.quote().text, /retained reference/u);
  assert.equal(f.focus(), f.node('toggle-side-chat'));
  f.controls.apply(snapshot(12, { open: false, messages: [user, completed] }));
  assert.equal(f.node('side-chat-panel').hidden, true);
  assert.match(f.node('side-chat-messages').text, /background answer/u);
  f.controls.apply(snapshot(10, { running: true, messages: [user, partial] }));
  assert.equal(f.node('side-chat-panel').hidden, true);
  assert.equal(f.node('side-chat-stop').hidden, true);
  nextOpen = snapshot(13, { messages: [user, completed] });
  await f.controls.open();
  assert.equal(f.node('side-chat-panel').hidden, false);
  assert.equal(f.node('side-chat-input').disabled, false);
  assert.equal(f.node('side-chat-input').value, 'next draft');
  assert.match(f.quote().text, /retained reference/u);
  assert.match(f.node('side-chat-messages').text, /temporary question.*background answer/u);
});

test('hide labels explain that temporary chat is deleted only when exiting the app', () => {
  const f = fixture({});
  assert.equal(f.node('side-chat-close').title, '收起侧边问答');
  assert.equal(f.node('side-chat-close').attributes['aria-label'], '收起侧边问答');
  assert.equal(f.hint().textContent, '临时聊天 · 退出软件后删除');
});

test('a late send acknowledgement after hiding and reopening preserves the new draft, reference and focus', async () => {
  const send = deferred(), close = deferred();
  let opened = 1;
  const f = fixture({ sideChatSend: () => send.promise, sideChatClose: () => close.promise,
    sideChatOpen: async () => snapshot(++opened) });
  await f.controls.open('original reference');
  f.node('side-chat-input').value = 'sent question'; const sending = f.submit();
  const hiding = f.controls.close();
  await f.controls.open('new reference');
  f.node('side-chat-input').value = 'new question draft';
  f.node('toggle-side-chat').focus();
  send.resolve(snapshot(2, { running: true })); await sending;
  assert.equal(f.node('side-chat-input').value, 'new question draft');
  assert.match(f.quote().text, /new reference/u);
  assert.equal(f.focus(), f.node('toggle-side-chat'));
  assert.equal(f.node('side-chat-input').disabled, false);
  close.resolve(snapshot(4, { open: false })); await hiding;
  assert.equal(f.node('side-chat-panel').hidden, false, 'The superseded hide acknowledgement cannot close a reopened panel');
});

test('a hidden panel cannot be resurrected by open streaming snapshots before the next explicit open', async () => {
  let nextOpen = snapshot(2);
  const f = fixture({ sideChatClose: async () => snapshot(3, { open: false }), sideChatOpen: async () => nextOpen });
  f.node('side-chat-input').value = 'unfinished question';
  await f.controls.open('unfinished reference');
  await f.controls.close();
  f.controls.apply(snapshot(4, { running: true, messages: [{ role: 'assistant', content: 'late stream' }] }));
  f.controls.apply(snapshot(5, { messages: [{ role: 'assistant', content: 'finished stream' }] }));
  assert.equal(f.node('side-chat-panel').hidden, true);
  assert.match(f.node('side-chat-messages').text, /finished stream/u);
  assert.equal(f.node('side-chat-input').value, 'unfinished question');
  assert.match(f.quote().text, /unfinished reference/u);
  nextOpen = snapshot(6, { messages: [{ role: 'assistant', content: 'finished stream' }] });
  await f.controls.open();
  assert.equal(f.node('side-chat-panel').hidden, false);
  assert.match(f.node('side-chat-messages').text, /finished stream/u);
  f.controls.apply(snapshot(4, { running: true }));
  assert.match(f.node('side-chat-messages').text, /finished stream/u);
  assert.equal(f.node('side-chat-stop').hidden, true);
});

test('a previous project send cannot clear a new draft even after switching away and back', async () => {
  const send = deferred(), f = fixture({ sideChatSend: () => send.promise });
  f.node('side-chat-input').value = 'previous A question'; const sending = f.submit();
  f.switchWorkspace('B', snapshot(1)); f.switchWorkspace('A', snapshot(4));
  f.node('side-chat-input').value = 'new A draft'; f.node('side-chat-input').focus();
  send.resolve(snapshot(2, { running: true })); await sending;
  assert.equal(f.node('side-chat-input').value, 'new A draft');
  assert.equal(f.node('side-chat-input').disabled, false);
  assert.equal(f.node('side-chat-stop').hidden, true);
});

test('out-of-order open replies preserve the latest quote and a running chat draft', async () => {
  const first = deferred(), second = deferred(); let count = 0;
  const f = fixture({ sideChatOpen: () => ++count === 1 ? first.promise : second.promise });
  f.controls.apply(snapshot(2, { running: true })); f.node('side-chat-input').value = 'next draft';
  const openingFirst = f.controls.open('older quote'), openingSecond = f.controls.open('latest quote');
  second.resolve(snapshot(4, { running: true })); await openingSecond;
  first.resolve(snapshot(3, { running: true })); await openingFirst;
  assert.match(f.quote().text, /latest quote/u); assert.doesNotMatch(f.quote().text, /older quote/u);
  assert.equal(f.node('side-chat-input').value, 'next draft');
  assert.equal(f.node('side-chat-input').disabled, false); assert.equal(f.node('side-chat-stop').hidden, false);
});
