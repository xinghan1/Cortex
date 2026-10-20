import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/renderer/conversation-colors.js', import.meta.url), 'utf8');
const context = { module:{exports:{}} };
vm.runInNewContext(source, context);
const colors = context.module.exports;

test('conversation color choices map to the six supported readable palette values', () => {
  const expected = {white:'#fff',black:'#000',red:'#ff6b6b',yellow:'#ffd86b',green:'#79e6a2',blue:'#86b9ff'};
  assert.deepEqual({...colors.choices}, expected);
  for (const [name, value] of Object.entries(expected)) {
    assert.equal(colors.normalize(name), name);
    assert.equal(colors.color(name), value);
  }
  assert.equal(Object.isFrozen(colors.choices), true);
});

test('unknown or unsafe values use the default white and never enter CSS', () => {
  for (const value of [undefined,null,'','WHITE','transparent','url(https://invalid.test)','__proto__','constructor',{},[]]) {
    assert.equal(colors.normalize(value), 'white');
    assert.equal(colors.color(value), '#fff');
  }
});
