import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const context = vm.createContext({});
vm.runInContext(await fs.readFile(new URL('../src/renderer/chat-selection-menu.js', import.meta.url), 'utf8'), context);
const { searchUrl, selectionWithin } = context.ForgeChatSelectionMenu;

test('search treats selected keywords as one encoded query, including Chinese and URL syntax', () => {
  const keywords = 'Synora 中文 & a=b #tag ? "test"';
  const url = new URL(searchUrl(`  ${keywords}\n`));
  assert.equal(url.origin, 'https://www.bing.com');
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('q'), keywords);
  assert.equal([...url.searchParams].length, 1);
  assert.equal(url.hash, '');
  for (const empty of ['', ' \n ', undefined, null, 123]) assert.equal(searchUrl(empty), null);
});

test('chat copying accepts only a nonempty single range entirely within this conversation', () => {
  const start = {}, end = {}, outside = {};
  const container = { contains: node => node === start || node === end };
  const clone = {};
  const selection = { isCollapsed: false, rangeCount: 1, toString: () => ' selected text ',
    getRangeAt: () => ({ startContainer: start, endContainer: end, cloneRange: () => clone }) };
  const result = selectionWithin(selection, container);
  assert.equal(result.text, ' selected text ');
  assert.equal(result.range, clone);
  for (const change of [{ isCollapsed: true }, { rangeCount: 0 }, { rangeCount: 2 }, { toString: () => ' \n ' },
    { getRangeAt: () => ({ startContainer: outside, endContainer: end }) },
    { getRangeAt: () => ({ startContainer: start, endContainer: outside }) }]) {
    assert.equal(selectionWithin({ ...selection, ...change }, container), null);
  }
  assert.equal(selectionWithin(null, container), null);
});
