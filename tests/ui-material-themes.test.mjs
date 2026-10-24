import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/renderer/ui-styles.css', import.meta.url), 'utf8');
function palette(theme) {
  const block = source.match(new RegExp(`html\\[data-ui-style='${theme}'\\] \\{([^}]+)\\}`, 'u'))?.[1];
  assert.ok(block, `Missing theme ${theme}`);
  return Object.fromEntries([...block.matchAll(/(--[a-z-]+):\s*(#[a-f0-9]{3,8})\s*;/giu)].map(match => [match[1], match[2]]));
}
function luminance(hex) {
  const expanded = hex.length === 4 ? '#' + [...hex.slice(1)].map(value => value + value).join('') : hex;
  const channels = [1, 3, 5].map(start => parseInt(expanded.slice(start, start + 2), 16) / 255)
    .map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);

for (const theme of ['deepseek', 'codex']) {
  test(`${theme} normal and muted text, semantic states and accent button retain readable contrast`, () => {
    const p = palette(theme);
    for (const surface of ['--ui-root', '--ui-rail', '--ui-control', '--ui-raised', '--ui-code']) {
      assert.ok(contrast(p['--ui-text'], p[surface]) >= 7, `${surface} body text must have strong contrast`);
      assert.ok(contrast(p['--ui-muted'], p[surface]) >= 4.5, `${surface} muted labels must remain readable`);
    }
    for (const semantic of ['--ui-info', '--ui-good', '--ui-bad', '--ui-warning'])
      assert.ok(contrast(p[semantic], p['--ui-control']) >= 4.5, `${semantic} must remain readable on task surfaces`);
    assert.ok(contrast(p['--ui-accent'], p['--ui-accent-ink']) >= 7);
    assert.notEqual(p['--ui-accent'], p['--ui-good']); assert.notEqual(p['--ui-accent'], p['--ui-bad']);
  });
}

test('new materials share the complete solid surface, code-mirror, popup and custom-palette protections', () => {
  const groups = [...source.matchAll(/html:is\((\[data-ui-style='black'\][^)]*)\)/gu)].map(match => match[1]);
  const materialGroups = groups.filter(group => group.includes("[data-ui-style='industrial']"));
  assert.ok(materialGroups.length > 60);
  for (const group of materialGroups) {
    assert.ok(group.includes("[data-ui-style='deepseek']")); assert.ok(group.includes("[data-ui-style='codex']"));
  }
  assert.match(source, /\.file-code-editor\.syntax-ready > #file-content\s*\{\s*color: transparent !important;/u);
  assert.match(source, /html\[data-selection-color='custom'\]\s*\{[^}]*--ui-accent: var\(--custom-selection-color\);/u);
  assert.match(source, /\.style-swatch-deepseek\s*\{/u); assert.match(source, /\.style-swatch-codex\s*\{/u);
  assert.notEqual(palette('deepseek')['--ui-root'], palette('codex')['--ui-root']);
  assert.notEqual(palette('deepseek')['--ui-accent'], palette('codex')['--ui-accent']);
});
