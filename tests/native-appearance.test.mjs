import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { nativeAppearance, contrastRatio } = require('../src/core/native-appearance.cjs');
const defaults = {
  glass: { background: '#101010', caption: '#0b0b0b', symbol: '#d6dde3', theme: 'dark' },
  black: { background: '#000000', caption: '#000000', symbol: '#ededed', theme: 'dark' },
  white: { background: '#e9ebee', caption: '#f2f3f5', symbol: '#1b2026', theme: 'light' },
  industrial: { background: '#16191d', caption: '#242a30', symbol: '#edb64c', theme: 'dark' },
  deepseek: { background: '#141414', caption: '#1c1c1c', symbol: '#91add6', theme: 'dark' },
  codex: { background: '#191919', caption: '#202123', symbol: '#e3e3e8', theme: 'dark' },
};

test('native title bars preserve every material default and safe fallback', () => {
  for (const [uiStyle, palette] of Object.entries(defaults)) assert.deepEqual(nativeAppearance({ uiStyle }), palette);
  for (const value of [undefined, null, {}, { uiStyle: 'unknown' }, { uiStyle: '__proto__' }, { uiStyle: 'toString' }]) assert.deepEqual(nativeAppearance(value), defaults.glass);
});

test('readable custom accent replaces native symbols for every material without recoloring the caption', () => {
  for (const [uiStyle, palette] of Object.entries(defaults)) {
    // A medium blue is readable on both the dark and light title bars.
    const selected = nativeAppearance({ uiStyle, selectionColor: '#5781B8' });
    assert.deepEqual(selected, { ...palette, symbol: '#5781b8' });
    assert.ok(contrastRatio(selected.symbol, selected.caption) >= 3);
  }
});

test('native symbols derived from extreme low-contrast choices remain visible across all materials', () => {
  for (const [uiStyle, palette] of Object.entries(defaults)) for (const color of [palette.caption, '#000000', '#ffffff', '#112233', '#fefefe']) {
    const selected = nativeAppearance({ uiStyle, selectionColor: color });
    assert.ok(contrastRatio(selected.symbol, selected.caption) >= 3, `${uiStyle}: ${color} is unreadable`);
    assert.equal(selected.caption, palette.caption);
    assert.equal(selected.background, palette.background);
    if (contrastRatio(color, palette.caption) >= 3) assert.equal(selected.symbol, color);
  }
  assert.notEqual(nativeAppearance({ uiStyle: 'industrial', selectionColor: '#242a30' }).symbol, defaults.industrial.symbol,
    'Low-contrast customization must not silently restore the former amber accent');
});

test('reset and invalid values restore each style default without retaining another window palette', () => {
  const source = { uiStyle: 'industrial', selectionColor: '#6b9eff' };
  const first = nativeAppearance(source);
  first.symbol = '#ff0000';
  assert.equal(source.selectionColor, '#6b9eff');
  assert.equal(nativeAppearance(source).symbol, '#6b9eff');
  for (const [uiStyle, palette] of Object.entries(defaults)) for (const selectionColor of [null, undefined, '#fff', 'red', '#12345678', '#12zz34', 42]) {
    assert.deepEqual(nativeAppearance({ uiStyle, selectionColor }), palette);
  }
});
