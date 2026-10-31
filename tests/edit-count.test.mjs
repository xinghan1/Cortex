import test from 'node:test';
import assert from 'node:assert/strict';
await import('../src/renderer/edit-count.js');
const { animate } = globalThis.CortexEditCount;

function target(text) {
  return { textContent: text, isConnected: true, ownerDocument: { createElement: () => ({}) },
    replaceChildren(child) { this.textContent = child.textContent; this.child = child; } };
}
test('edit count transitions to the actual confirmed count and respects direction', () => {
  const previous = globalThis.requestAnimationFrame; const pending = [];
  globalThis.requestAnimationFrame = fn => pending.push(fn);
  try {
    const value = target('+374'); animate(value, 'up');
    assert.equal(value.textContent, '+0');
    pending.shift()(0); pending.shift()(600);
    assert.equal(value.textContent, '+187');
    assert.equal(value.child.className, 'tool-edit-number up');
    pending.shift()(1200); assert.equal(value.textContent, '+374'); assert.equal(pending.length, 0);
  } finally { globalThis.requestAnimationFrame = previous; }
});
test('reduced motion, unknown values, and zero counts leave displayed result unchanged', () => {
  const previousFrame = globalThis.requestAnimationFrame, previousMedia = globalThis.matchMedia;
  globalThis.requestAnimationFrame = () => { throw new Error('unexpected animation'); };
  try {
    globalThis.matchMedia = () => ({ matches: true });
    const value = target('-72'); animate(value, 'down'); assert.equal(value.textContent, '-72');
    globalThis.matchMedia = () => ({ matches: false });
    const zero = target('+0'), unknown = target('—'); animate(zero, 'up'); animate(unknown, 'up');
    assert.equal(zero.textContent, '+0'); assert.equal(unknown.textContent, '—');
  } finally { globalThis.requestAnimationFrame = previousFrame; globalThis.matchMedia = previousMedia; }
});
