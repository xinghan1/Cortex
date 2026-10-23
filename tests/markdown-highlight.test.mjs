import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/syntax-highlight.js', import.meta.url), 'utf8');
const diffSource = await fs.readFile(new URL('../src/renderer/code-diff.js', import.meta.url), 'utf8');
const context = vm.createContext({}); vm.runInContext(source, context);
const api = context.ForgeSyntax;
const tokenize = (text, state = {}, budget) => Array.from(api.tokenize(text, 'markdown', state, budget), token => ({ ...token }));
const joined = parts => parts.map(token => token.text).join('');
function at(parts, offset) {
  let cursor = 0;
  for (const part of parts) { if (offset < cursor + part.text.length) return part.kind; cursor += part.text.length; }
}
const kindAt = (parts, text, needle) => at(parts, text.indexOf(needle));

test('Markdown file extensions and fence aliases resolve without treating plain text as Markdown', () => {
  for (const path of ['README.md', 'C:\\项目\\README.MD', '/project/guide.markdown', 'guide.mdown', 'guide.mkd'])
    assert.equal(api.languageForPath(path), 'markdown');
  assert.equal(api.languageForPath('notes.txt'), '');
  for (const hint of ['md', 'markdown', 'language-md']) {
    const text = '# Heading';
    assert.ok(Array.from(api.tokenize(text, hint)).some(part => part.kind !== 'plain'));
  }
});

test('Markdown source receives structural colours while preserving every byte of visible source', () => {
  const text = '# 中文标题\r\n\r\n- [x] **完成事项**，*说明* 和 `inline()`\r\n> 引用\r\n'
    + '[文档](https://example.invalid/a?x=1&y=2) ![图片](image.png)\r\n| 项目 | 状态 |\r\n| --- | --- |\r\n---\r\n';
  const parts = tokenize(text);
  assert.equal(joined(parts), text);
  for (const needle of ['#', '- [x]', '`inline()`', '[文档]', '| 项目', '---'])
    assert.notEqual(kindAt(parts, text, needle), 'plain', needle);
  assert.ok(new Set(parts.filter(part => part.kind !== 'plain').map(part => part.kind)).size >= 3);
});

test('fenced source uses its declared programming language and closes back to Markdown', () => {
  const text = '```javascript\nconst count = 3;\nif (count) print("ok");\n```\n# 后续标题\n'
    + '~~~python\ndef greet(name):\n    return "你好"\n~~~\n'
    + '```json\n{"enabled": true, "size": 12}\n```\n';
  const parts = tokenize(text);
  assert.equal(joined(parts), text);
  assert.equal(kindAt(parts, text, 'const'), 'keyword');
  assert.equal(kindAt(parts, text, 'if (count)'), 'control');
  assert.equal(kindAt(parts, text, 'def greet'), 'keyword');
  assert.equal(kindAt(parts, text, 'return'), 'control');
  assert.equal(kindAt(parts, text, '"enabled"'), 'property');
  assert.notEqual(kindAt(parts, text, '# 后续标题'), 'plain');
});

test('fence marker type and length determine closure, and unknown languages stay literal', () => {
  const text = '````python\nfirst = 1\n```\ndef stillInside(): pass\n~~~~\n````\n# Outside\n'
    + '~~~unknown-language\nconst noSyntax = "raw";\n<script>bad()</script>\n~~~\n';
  const parts = tokenize(text);
  assert.equal(joined(parts), text);
  assert.equal(kindAt(parts, text, 'def stillInside'), 'keyword');
  assert.notEqual(kindAt(parts, text, '# Outside'), 'plain');
  assert.equal(kindAt(parts, text, 'const noSyntax'), 'plain');
  assert.equal(kindAt(parts, text, '<script>'), 'plain');
});

test('separate diff lines preserve embedded multiline state and reset it at the closing fence', () => {
  const state = {}, lines = ['```js', '/* first comment', 'still a comment */ const next = 2;', '```', '# Heading'];
  const results = lines.map(line => tokenize(line, state));
  results.forEach((parts, index) => assert.equal(joined(parts), lines[index]));
  assert.equal(kindAt(results[2], lines[2], 'still a comment'), 'comment');
  assert.equal(kindAt(results[2], lines[2], 'const'), 'keyword');
  assert.notEqual(kindAt(results[4], lines[4], '# Heading'), 'plain');
  const restarted = tokenize('```js\nconst fresh = 1;\n```', state);
  assert.equal(kindAt(restarted, joined(restarted), 'const fresh'), 'keyword');
});

test('unclosed inline markers do not hide following lines and open fences retain readable source', () => {
  const text = '未闭合 ` 和 **标记\n# 后续标题\n```python\n"""未结束字符串\n继续\n';
  const parts = tokenize(text);
  assert.equal(joined(parts), text);
  assert.notEqual(kindAt(parts, text, '# 后续标题'), 'plain');
  assert.equal(kindAt(parts, text, '继续'), 'string');
});

test('a document and its embedded lexers share one budget and keep uncoloured source after exhaustion', () => {
  const text = '# Heading\n```js\nconst x = 2; if (x) print("ok");\n```\n'.repeat(400);
  const budget = { remainingCharacters: 100, remainingTokens: 7 };
  const parts = tokenize(text, {}, budget);
  assert.equal(joined(parts), text);
  assert.ok(parts.filter(part => part.kind !== 'plain').length <= 7);
  assert.ok(budget.remainingCharacters >= 0 && budget.remainingCharacters <= 100);
  assert.ok(budget.remainingTokens >= 0 && budget.remainingTokens <= 7);
  assert.equal(parts.at(-1).kind, 'plain');
  const stopped = tokenize('# Next\n```python\ndef ignored(): pass\n```', {}, { remainingCharacters: 0, remainingTokens: 0 });
  assert.ok(stopped.every(part => part.kind === 'plain'));
});

test('large hostile markup has bounded work without changing or executing source', () => {
  const text = '['.repeat(40000) + '`*_<'.repeat(40000) + '\n```md\n# nested Markdown remains literal\n```\n';
  const start = performance.now(), parts = tokenize(text);
  assert.ok(performance.now() - start < 2500);
  assert.equal(joined(parts), text);
  assert.ok(parts.filter(part => part.kind !== 'plain').length <= 12000);
});

function dom() {
  const document = {};
  class Node {
    constructor(tag, text = '') { this.tag = tag; this.text = text; this.children = []; this.dataset = {}; this.attributes = {}; this.ownerDocument = document; }
    appendChild(node) { this.children.push(node); return node; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener() {}
    set textContent(value) { this.text = value; this.children = []; }
    get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
  }
  document.createTextNode = text => new Node('#text', text);
  document.createElement = tag => { assert.ok(['span', 'article', 'header', 'div', 'button', 'code'].includes(tag)); return new Node(tag); };
  document.createDocumentFragment = () => new Node('#fragment');
  const all = node => [node, ...node.children.flatMap(all)];
  return { document, Node, all };
}

test('Markdown highlighting appends only text and spans, including hostile links and HTML', () => {
  const { document, Node, all } = dom(), node = new Node('code');
  const text = '# Header\n[恶意](javascript:bad())\n<script>bad()</script>\n```html\n<img src=x onerror=bad()>\n```';
  api.append(document, node, text, 'md', {});
  assert.equal(node.textContent, text);
  assert.ok(all(node).every(item => ['code', '#text', 'span'].includes(item.tag)));
  assert.ok(all(node).some(item => item.className?.includes('syntax-token')));
});

test('removed Markdown lines cannot change the added side embedded lexer state', () => {
  const { document, all } = dom();
  const local = vm.createContext({ document }); vm.runInContext(source, local); vm.runInContext(diffSource, local);
  const before = '```js\n/* common start\nold */ const oldValue = 1;\n*/\nconst count = 1;\n```\n';
  const after = '```js\n/* common start\nnew still comment\n*/\nconst count = 2;\n```\n';
  const card = local.ForgeCodeDiff.create({ path: 'README.md', before, after });
  const row = all(card).find(node => node.dataset.kind === 'add' && node.textContent.includes('new still comment'));
  assert.ok(row);
  const code = row.children.find(node => node.tag === 'code');
  assert.equal(code.textContent, 'new still comment');
  assert.ok(code.children.some(node => node.className === 'syntax-token syntax-comment'));
});

test('a skipped diff hunk clears an unseen Markdown fence and its embedded lexer state', () => {
  const { document, all } = dom();
  const local = vm.createContext({ document }); vm.runInContext(source, local); vm.runInContext(diffSource, local);
  const lines = Array.from({ length: 45 }, (_, index) => `unchanged ${index}`);
  lines.splice(0, 6, '# old title', '```js', '/* comment begins', 'still comment', '*/', '```');
  lines[36] = '# old ending';
  const updated = lines.slice(); updated[0] = '# new title'; updated[36] = '# new ending';
  const card = local.ForgeCodeDiff.create({ path: 'README.md', before: lines.join('\n'), after: updated.join('\n') });
  assert.ok(all(card).some(node => node.dataset.kind === 'gap'));
  const row = all(card).find(node => node.dataset.kind === 'add' && node.textContent.includes('# new ending'));
  const code = row.children.find(node => node.tag === 'code');
  assert.ok(code.children.some(node => node.className === 'syntax-token syntax-keyword'));
  assert.ok(code.children.every(node => node.className !== 'syntax-token syntax-comment'));
});
