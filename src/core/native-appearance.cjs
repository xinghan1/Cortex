'use strict';

const palettes = Object.freeze({
  glass: Object.freeze({ background: '#101010', caption: '#0b0b0b', symbol: '#d6dde3', theme: 'dark' }),
  black: Object.freeze({ background: '#000000', caption: '#000000', symbol: '#ededed', theme: 'dark' }),
  white: Object.freeze({ background: '#e9ebee', caption: '#f2f3f5', symbol: '#1b2026', theme: 'light' }),
  industrial: Object.freeze({ background: '#16191d', caption: '#242a30', symbol: '#edb64c', theme: 'dark' }),
  deepseek: Object.freeze({ background: '#141414', caption: '#1c1c1c', symbol: '#91add6', theme: 'dark' }),
  codex: Object.freeze({ background: '#191919', caption: '#202123', symbol: '#e3e3e8', theme: 'dark' }),
});
const validColor = value => typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value);
const channels = color => [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
function luminance(color) {
  const linear = channels(color).map(channel => channel / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrastRatio(first, second) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function readableSymbol(color, background) {
  if (contrastRatio(color, background) >= 3) return color;
  const endpoint = contrastRatio('#000000', background) >= contrastRatio('#ffffff', background) ? 0 : 255;
  const original = channels(color);
  // Native caption symbols have a fixed material background. Adjust only a
  // low-contrast choice, retaining its hue as it moves towards readable ink.
  for (let step = 1; step <= 100; step++) {
    const fraction = step / 100;
    const candidate = '#' + original.map(channel => Math.round(channel + (endpoint - channel) * fraction).toString(16).padStart(2, '0')).join('');
    if (contrastRatio(candidate, background) >= 3) return candidate;
  }
  return endpoint ? '#ffffff' : '#000000';
}
function nativeAppearance(value) {
  const base = Object.hasOwn(palettes, value?.uiStyle) ? palettes[value.uiStyle] : palettes.glass;
  const color = validColor(value?.selectionColor) ? value.selectionColor.toLowerCase() : null;
  return { ...base, ...(color ? { symbol: readableSymbol(color, base.caption) } : {}) };
}

module.exports = { nativeAppearance, contrastRatio };
