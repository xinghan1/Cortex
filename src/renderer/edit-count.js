'use strict';
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.CortexEditCount = api;
})(typeof window === 'object' ? window : globalThis, function (root) {
  function animate(target, direction) {
    const original = target?.textContent || '';
    if (!/^[+-]\d+$/.test(original) || !root.requestAnimationFrame || root.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const sign = original[0], final = Number(original.slice(1));
    if (!Number.isSafeInteger(final) || final === 0) return;
    const doc = target.ownerDocument;
    target.title = '实际统计结果的数字动画';
    let start = null, last = -Infinity;
    const draw = value => {
      const span = doc.createElement('span'); span.className = `tool-edit-number ${direction}`;
      span.textContent = `${sign}${value}`; target.replaceChildren(span);
    };
    draw(0);
    const tick = now => {
      if (!target.isConnected) return;
      if (start === null) start = now;
      const elapsed = now - start;
      if (elapsed - last >= 140 || elapsed >= 1200) {
        last = elapsed; draw(Math.round(final * Math.min(1, elapsed / 1200)));
      }
      if (elapsed < 1200) root.requestAnimationFrame(tick);
    };
    root.requestAnimationFrame(tick);
  }
  return Object.freeze({ animate });
});
