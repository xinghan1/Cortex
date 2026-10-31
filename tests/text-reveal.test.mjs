import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const code = await fs.readFile(new URL('../src/renderer/text-reveal.js', import.meta.url), 'utf8');
function setup(text, reduce = false) {
  const context = vm.createContext({ Intl, matchMedia: () => ({ matches: reduce }) });
  vm.runInContext(code, context);
  const doc = {
    createTreeWalker: root => ({ index: -1, currentNode: null, nextNode() { this.currentNode = root.nodes[++this.index]; return !!this.currentNode; } }),
    createDocumentFragment: () => ({ children: [], append(node) { this.children.push(node); } }),
    createTextNode: data => ({ data }),
    createElement: () => ({ style: {}, textContent: '' }),
  };
  const root = { ownerDocument: doc, nodes: [], replacement: [] };
  root.nodes = [{ data: text, parentElement: { closest: () => null }, replaceWith(fragment) { root.replacement.push(...fragment.children); } }];
  return { api: context.CortexTextReveal, root };
}

test('only newly streamed characters animate, in order, including complete emoji', () => {
  const { api, root } = setup('原有新👨‍👩‍👧');
  api.animateNewText(root, '原有');
  assert.equal(root.replacement[0].data, '原有');
  assert.equal(root.replacement[1].textContent, '新');
  assert.equal(root.replacement[2].textContent, '👨‍👩‍👧');
  assert.equal(root.replacement[1].style.animationDelay, '0ms');
  assert.equal(root.replacement[2].style.animationDelay, '8ms');
});

test('large batches animate all text with bounded node count and duration', () => {
  const text = '字'.repeat(10000), { api, root } = setup(text);
  api.animateNewText(root, '');
  assert.ok(root.replacement.length <= 1024);
  assert.equal(root.replacement.map(node => node.textContent).join(''), text);
  assert.ok(parseInt(root.replacement.at(-1).style.animationDelay, 10) <= 1200);
});

test('reduced motion skips wrapping, and unchanged text does not replay', () => {
  const reduced = setup('文字', true); reduced.api.animateNewText(reduced.root, '');
  assert.equal(reduced.root.replacement.length, 0);
  const unchanged = setup('文字'); unchanged.api.animateNewText(unchanged.root, '文字');
  assert.equal(unchanged.root.replacement.length, 0);
});
