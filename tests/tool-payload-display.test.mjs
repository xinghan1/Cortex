import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function toolPayload('), end = source.indexOf('\nfunction ', start + 1);
const syntaxSource = await fs.readFile(new URL('../src/renderer/syntax-highlight.js', import.meta.url), 'utf8');
const syntaxContext = vm.createContext({}); vm.runInContext(syntaxSource, syntaxContext);
const syntax = syntaxContext.ForgeSyntax;
function element(tag) { return { tag, children: [], textContent: '', appendChild(child) { this.children.push(child); } }; }
const document = { createElement: element, createTextNode: text => ({ textContent: text }) };
const context = vm.createContext({ element, document, window: { ForgeSyntax: syntax }, safeString: value => typeof value === 'string' ? value : JSON.stringify(value, null, 2) });
vm.runInContext(source.slice(start, end), context);
test('tool payload preserves literal JSON and highlights tokens without parsing HTML', () => {
  const source = '{"selector":"<img src=x>","clicked":true}', result = context.toolPayload(source);
  assert.equal(result.children.map(child => child.textContent).join(''), source);
  assert.ok(result.children.some(child => child.className?.includes('syntax-string')));
  assert.ok(result.children.every(child => !child.tag || child.tag === 'span'));
});
test('tool payload highlights recognized file content and leaves unknown logs as literal text', () => {
  const source = 'const value = 42;', code = context.toolPayload(source, 'src/example.js');
  assert.equal(code.children.map(child => child.textContent).join(''), source);
  assert.ok(code.children.some(child => child.className?.includes('syntax-keyword')));
  const plain = context.toolPayload('<script>log</script>', 'output.log');
  assert.equal(plain.textContent, '<script>log</script>');
  assert.equal(plain.children.length, 0);
});
