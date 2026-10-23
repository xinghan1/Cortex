import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/markdown.js', import.meta.url), 'utf8');
const syntaxSource = await fs.readFile(new URL('../src/renderer/syntax-highlight.js', import.meta.url), 'utf8');
function fixture() {
  const doc = {}, timers = new Map();
  let timerId = 0;
  class Node {
    constructor(tag, value = '') {
      this.tag = tag; this.value = value; this.children = []; this.ownerDocument = doc;
      this.attributes = {}; this.listeners = {}; this.dataset = {}; this.disabled = false;
      this.classList = { add: value => { this.className = `${this.className || ''} ${value}`.trim(); } };
    }
    appendChild(node) { this.children.push(node); return node; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    set textContent(value) { this.value = String(value); this.children = []; }
    get textContent() { return this.value + this.children.map(node => node.textContent).join(''); }
    async click() { await this.listeners.click?.({ preventDefault() {} }); }
  }
  doc.createElement = tag => new Node(tag);
  doc.createTextNode = value => new Node('#text', value);
  doc.createDocumentFragment = () => new Node('#fragment');
  const context = vm.createContext({ URL,
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(syntaxSource, context); vm.runInContext(source, context);
  const container = new Node('div');
  const findAll = (tagOrClass, root = container) => root.children.flatMap(child => [
    ...(tagOrClass.startsWith('.') ? (child.className || '').split(' ').includes(tagOrClass.slice(1)) : child.tag === tagOrClass) ? [child] : [],
    ...findAll(tagOrClass, child),
  ]);
  return {
    container, findAll, timers,
    render: (value, options) => context.ForgeMarkdown.renderMarkdown(container, value, options),
    expireFeedback: () => { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((pass, fail) => { resolve = pass; reject = fail; });
  return { promise, resolve, reject };
}

test('each code block copies only its complete raw source including CRLF, indentation and hostile-looking text', async () => {
  const { render, findAll, expireFeedback } = fixture(), copied = [];
  const powershell = 'Write-Output "<img src=x onerror=bad()>"\r\n  $path = "C:\\用户\\a.txt"\r\n\t# **原样** 🟢\r\n';
  const javascript = 'const value = "第二块";\n';
  render('```powershell ignored-info\r\n' + powershell + '```\r\n\r\n```js\n' + javascript + '```', { onCopy: text => copied.push(text) });
  const buttons = findAll('.message-code-copy'), labels = findAll('.message-code-language'), code = findAll('code');
  assert.equal(buttons.length, 2); assert.equal(labels[0].textContent, 'powershell');
  assert.equal(code[0].textContent, powershell); assert.ok(findAll('.syntax-token', code[0]).length > 0);
  assert.equal(findAll('img').length, 0, 'Code is never interpreted as HTML');
  assert.equal(buttons[0].type, 'button');
  assert.equal(buttons[0].attributes['aria-label'], '复制代码');
  assert.equal(findAll('.message-code-copy-feedback')[0].attributes['aria-live'], 'polite');
  await buttons[0].click();
  assert.deepEqual(copied, [powershell]); assert.equal(buttons[0].dataset.state, 'copied');
  assert.equal(buttons[0].textContent, '已复制'); assert.equal(buttons[1].dataset.state, 'idle');
  await buttons[1].click();
  assert.deepEqual(copied, [powershell, javascript]);
  expireFeedback();
  assert.equal(buttons[0].dataset.state, 'idle'); assert.equal(buttons[1].textContent, '复制');
});

test('copy requests suppress repeated clicks per block while other code blocks remain independent', async () => {
  const { render, findAll } = fixture(), first = deferred(), second = deferred(), copied = [];
  render('```txt\none\n```\n\n```txt\ntwo\n```', { onCopy: text => {
    copied.push(text); return text === 'one\n' ? first.promise : second.promise;
  } });
  const [one, two] = findAll('.message-code-copy');
  const firstClick = one.click();
  assert.equal(one.disabled, true); assert.equal(one.dataset.state, 'copying');
  assert.equal(one.textContent, '复制中…'); assert.equal(two.disabled, false);
  await one.click();
  const secondClick = two.click();
  assert.deepEqual(copied, ['one\n', 'two\n']);
  second.resolve(); await secondClick;
  assert.equal(two.dataset.state, 'copied'); assert.equal(one.dataset.state, 'copying');
  first.resolve(); await firstClick;
  assert.equal(one.dataset.state, 'copied'); assert.equal(one.disabled, false); assert.equal(two.disabled, false);
});

test('clipboard failure is visible and retryable without showing bridge error contents or claiming success', async () => {
  const { render, findAll } = fixture(); let attempts = 0;
  render('```\nplain text\n```', { onCopy: () => { if (++attempts === 1) throw new Error('private failure details'); } });
  const [button] = findAll('.message-code-copy');
  await button.click();
  assert.equal(button.dataset.state, 'failed'); assert.equal(button.textContent, '复制失败');
  assert.equal(button.attributes['aria-label'], '复制失败，点击重试'); assert.equal(button.disabled, false);
  assert.equal(findAll('.message-code-language')[0].textContent, '代码');
  await button.click();
  assert.equal(attempts, 2); assert.equal(button.dataset.state, 'copied');
  render('```\nwithout callback\n```');
  await findAll('.message-code-copy')[0].click();
  assert.equal(findAll('.message-code-copy')[0].dataset.state, 'failed', 'Unavailable clipboard support must not report success');
});

test('streaming rerenders replace old callbacks and late feedback cannot change the newly rendered code block', async () => {
  const { render, findAll, timers } = fixture(), pending = deferred(), copied = [];
  const onCopy = text => { copied.push(text); return copied.length === 1 ? pending.promise : undefined; };
  render('```powershell\nWrite-Output "par', { onCopy });
  const oldButton = findAll('.message-code-copy')[0], oldClick = oldButton.click();
  render('```powershell\nWrite-Output "partial completed"\n```', { onCopy });
  const newButton = findAll('.message-code-copy')[0];
  assert.notEqual(oldButton, newButton); assert.equal(newButton.dataset.state, 'idle');
  pending.resolve(); await oldClick;
  assert.equal(newButton.dataset.state, 'idle'); assert.equal(timers.size, 0, 'Detached controls do not schedule success feedback');
  await newButton.click();
  assert.deepEqual(copied, ['Write-Output "par', 'Write-Output "partial completed"\n']);
  assert.equal(findAll('.message-code-copy').length, 1); assert.equal(newButton.dataset.state, 'copied');
});

test('empty code and code beyond the highlighting budget are copied without truncation or metadata', async () => {
  const { render, findAll } = fixture(), copied = [];
  const largeCode = 'const code = "完整内容";\t\n'.repeat(10_000);
  render('```\n```\n\n```js\n' + largeCode + '```', { onCopy: text => copied.push(text) });
  const [empty, large] = findAll('.message-code-copy');
  await empty.click(); await large.click();
  assert.equal(copied[0], ''); assert.equal(copied[1], largeCode);
  assert.equal(findAll('code')[1].textContent, largeCode);
});
