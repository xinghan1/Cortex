/* Animate only newly rendered model text; Markdown remains DOM-generated. */
(() => {
  'use strict';
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  function textNodes(root) {
    const walker = root.ownerDocument.createTreeWalker(root, 4);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.parentElement?.closest('button, .message-code-label')) nodes.push(node);
    }
    return nodes;
  }
  function visibleText(root) { return textNodes(root).map(node => node.data).join(''); }
  function commonPrefix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    if (i && i < b.length && /[\uDC00-\uDFFF]/u.test(b[i])) i--;
    return i;
  }
  function animateNewText(root, previous) {
    if (globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const nodes = textNodes(root), current = nodes.map(node => node.data).join('');
    let offset = commonPrefix(previous, current);
    if (offset < current.length && /[\uDC00-\uDFFF]/u.test(current[offset])) offset--;
    // Bound DOM churn and total delay for unusually large, non-streaming chunks.
    const groupSize = Math.max(1, Math.ceil((current.length - offset) / 1024));
    const delayStep = Math.min(8, 1200 / Math.max(1, Math.ceil((current.length - offset) / groupSize)));
    let position = 0, index = 0;
    for (const node of nodes) {
      const start = Math.max(0, offset - position), value = node.data;
      position += value.length;
      if (start >= value.length) continue;
      const fragment = root.ownerDocument.createDocumentFragment();
      if (start) fragment.append(root.ownerDocument.createTextNode(value.slice(0, start)));
      const suffix = value.slice(start);
      const characters = segmenter ? Array.from(segmenter.segment(suffix), part => part.segment) : Array.from(suffix);
      for (let i = 0; i < characters.length; i += groupSize) {
        const span = root.ownerDocument.createElement('span');
        span.className = 'stream-reveal';
        span.style.animationDelay = `${Math.round(index++ * delayStep)}ms`;
        span.textContent = characters.slice(i, i + groupSize).join('');
        fragment.append(span);
      }
      node.replaceWith(fragment);
    }
  }
  globalThis.CortexTextReveal = { visibleText, animateNewText, commonPrefix };
})();
