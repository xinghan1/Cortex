import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/syntax-highlight.js', import.meta.url), 'utf8');
const markdown = await fs.readFile(new URL('../src/renderer/markdown.js', import.meta.url), 'utf8');
const context = vm.createContext({ URL });
vm.runInContext(source, context);
vm.runInContext(markdown, context);
const api = context.ForgeSyntax;
const tokens = (value, lang, state) => JSON.parse(JSON.stringify(api.tokenize(value, lang, state)));
const kindOf = (parts, value) => parts.find(part => part.text === value)?.kind;

test('code colours distinguish flow, declaration, function, property and operators without changing text', () => {
  const value = "const clean = pick(event, eventFields);\nif (change) clean.fileChange = 'ready';\nreturn { type: 'event', count: 3 }; // comment";
  const parts = tokens(value, 'javascript');
  assert.equal(parts.map(part => part.text).join(''), value);
  assert.equal(kindOf(parts, 'const'), 'keyword');
  assert.equal(kindOf(parts, 'if'), 'control');
  assert.equal(kindOf(parts, 'pick'), 'function');
  assert.equal(kindOf(parts, 'fileChange'), 'property');
  assert.equal(kindOf(parts, "'ready'"), 'string');
  assert.equal(kindOf(parts, '3'), 'number');
  assert.equal(kindOf(parts, '='), 'operator');
  assert.equal(parts.at(-1).kind, 'comment');
});

test('language-aware comments leave CSS colours, quoted URLs and JSON keys intact', () => {
  const css = tokens('.card { color: #eef6ff; width: 40px; } /* note */', 'css');
  assert.equal(kindOf(css, '#eef6ff'), 'number');
  assert.equal(kindOf(css, 'color'), 'property');
  assert.equal(kindOf(css, '/* note */'), 'comment');
  const js = tokens('const url = "https://example.com/#anchor";', 'js');
  assert.equal(kindOf(js, '"https://example.com/#anchor"'), 'string');
  const json = tokens('{ "command": "a\\nb", "exitCode": 0, "ok": true }', 'json');
  assert.equal(kindOf(json, '"command"'), 'property');
  assert.equal(kindOf(json, '"a\\nb"'), 'string');
  assert.equal(kindOf(json, 'true'), 'keyword');
});

test('successive diff lines retain multiline comment and string state', () => {
  const state = {};
  assert.equal(tokens('/* first line', 'java', state)[0].kind, 'comment');
  const next = tokens('second line */ public String value = "ok";', 'java', state);
  assert.equal(kindOf(next, 'second line */'), 'comment');
  assert.equal(kindOf(next, 'public'), 'keyword');
  assert.equal(state.commentEnd, undefined);
  const pyState = {};
  assert.equal(tokens('"""a note', 'python', pyState)[0].kind, 'string');
  const py = tokens('continues"""\nif ready: # continue', 'python', pyState);
  assert.equal(kindOf(py, 'continues"""'), 'string');
  assert.equal(kindOf(py, 'if'), 'control');
  assert.equal(py.at(-1).kind, 'comment');
  const ps = tokens('Get-Content -LiteralPath $path # log', 'powershell');
  assert.equal(kindOf(ps, 'Get-Content'), 'function');
});

test('unknown languages stay plain and file extensions resolve to known languages', () => {
  for (const [path, lang] of [['a.tsx', 'typescript'], ['a.py', 'python'], ['a.jsonc', 'json'], ['a.java', 'java'], ['a.css', 'css'], ['a.ps1', 'powershell'], ['a.md', '']]) assert.equal(api.languageForPath(path), lang);
  const value = '<script>danger()</script>\r\n & "quotes"';
  assert.deepEqual(tokens(value, 'unknown'), [{ kind: 'plain', text: value }]);
});

test('large and punctuation-heavy inputs have bounded visual work and preserve their complete source', () => {
  const value = 'x = "<img src=x onerror=bad()>"; '.repeat(30000);
  const started = performance.now();
  const parts = tokens(value, 'javascript');
  assert.ok(performance.now() - started < 2500);
  assert.ok(parts.length <= 12001);
  assert.equal(parts.map(part => part.text).join(''), value);
  assert.equal(parts.at(-1).kind, 'plain');
});

function documentFixture() {
  const doc = {};
  class Node {
    constructor(tag, value = '') { this.tag = tag; this.value = value; this.children = []; this.ownerDocument = doc; this.classList = { add() {} }; }
    appendChild(node) { this.children.push(node); return node; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    set textContent(value) { this.value = value; this.children = []; }
    get textContent() { return this.value + this.children.map(node => node.textContent).join(''); }
  }
  doc.createElement = tag => { assert.ok(['span', 'div', 'pre', 'code'].includes(tag), `Unexpected element: ${tag}`); return new Node(tag); };
  doc.createTextNode = value => new Node('#text', value);
  doc.createDocumentFragment = () => new Node('#fragment');
  return { doc, container: new Node('div') };
}

test('DOM rendering and Markdown fences preserve hostile source strictly as text with coloured spans', () => {
  const { doc, container } = documentFixture();
  const value = 'const example = "<img src=x onerror=bad()>";\n<script>bad()</script>\n';
  api.append(doc, container, value, 'javascript');
  assert.equal(container.textContent, value);
  assert.ok(container.children.some(node => node.className === 'syntax-token syntax-keyword'));
  assert.doesNotMatch(source, /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write/u);
  context.ForgeMarkdown.renderMarkdown(container, '```js\n' + value + '```');
  const fence = container.children[0].children[0];
  const code = fence.children[1].children[0];
  assert.equal(code.textContent, value);
  assert.ok(code.children.some(node => node.className === 'syntax-token syntax-keyword'));
});

test('a shared card budget bounds coloured DOM spans across hundreds of individually highlighted lines', () => {
  const { doc } = documentFixture();
  const budget = { remainingCharacters: 160000, remainingTokens: 12000 };
  const lines = Array.from({ length: 500 }, () => 'x+'.repeat(900) + '1;');
  let spans = 0;
  for (const line of lines) {
    const node = doc.createElement('code');
    api.append(doc, node, line, 'javascript', {}, budget);
    spans += node.children.filter(child => child.tag === 'span').length;
    assert.equal(node.textContent, line, 'Budget exhaustion must preserve every source character');
  }
  assert.equal(spans, 12000);
  assert.equal(budget.remainingTokens, 0);
});

test('shared character budget also prevents long strings from resetting work on each line', () => {
  const budget = { remainingCharacters: 100, remainingTokens: 12000 };
  const state = {};
  const first = tokens('"' + 'a'.repeat(200) + '"', 'javascript', state);
  assert.equal(first.map(part => part.text).join(''), '"' + 'a'.repeat(200) + '"');
  api.tokenize('"' + 'a'.repeat(200) + '"', 'javascript', {}, budget);
  assert.equal(budget.remainingCharacters, 0);
  const after = api.tokenize('const untouched = 5;', 'javascript', {}, budget);
  assert.equal(after.length, 1);
  assert.equal(after[0].kind, 'plain');
  assert.equal(after[0].text, 'const untouched = 5;');
});
