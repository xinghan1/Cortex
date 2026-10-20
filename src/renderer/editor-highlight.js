/* Visual syntax layer only: the native textarea owns editing and selection. */
(() => {
  'use strict';
  const editor = document.getElementById('file-content');
  const mirror = document.getElementById('file-highlight');
  const code = document.getElementById('file-highlight-code');
  const gutter = document.getElementById('file-line-numbers');
  const lineNumbers = document.getElementById('file-line-number-content');
  const host = editor?.closest('.file-code-editor');
  if (!editor || !mirror || !code || !host) return;
  const MAX_CHARACTERS = 160000;
  let path = '', frame = 0, lastValue = null, lastLanguage = null, composing = false;
  let countedValue = null, totalLines = 1, lineHeight = 21.6, paddingTop = 17, gutterFont = '', digitWidth = 8;
  const measure = document.createElement('canvas').getContext('2d');
  function syncGutter() {
    if (!gutter || !lineNumbers) return;
    const first = Math.min(totalLines, Math.max(1, Math.floor((editor.scrollTop - paddingTop) / lineHeight) - 1));
    const last = Math.min(totalLines, Math.ceil((editor.scrollTop + editor.clientHeight - paddingTop) / lineHeight) + 3);
    // Only viewport lines are materialized, including for large plain files.
    const text = Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => first + index).join('\n');
    if (lineNumbers.textContent !== text) lineNumbers.textContent = text;
    lineNumbers.style.transform = `translateY(${paddingTop + (first - 1) * lineHeight - editor.scrollTop}px)`;
    gutter.dataset.totalLines = String(totalLines);
    gutter.dataset.firstLine = String(first);
    gutter.dataset.lastLine = String(last);
  }
  function syncScroll() { mirror.scrollTop = editor.scrollTop; mirror.scrollLeft = editor.scrollLeft; syncGutter(); }
  function syncMetrics() {
    const style = getComputedStyle(editor);
    if (editor.value !== countedValue) {
      countedValue = editor.value; totalLines = 1;
      for (let index = 0; index < countedValue.length; index++) if (countedValue.charCodeAt(index) === 10) totalLines++;
    }
    lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.8;
    paddingTop = parseFloat(style.paddingTop) || 0;
    if (gutter && lineNumbers) {
      const font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
      if (font !== gutterFont) {
        gutterFont = font;
        if (measure) { measure.font = font; digitWidth = Math.max(...'0123456789'.split('').map(value => measure.measureText(value).width)); }
      }
      gutter.style.font = font; gutter.style.lineHeight = style.lineHeight;
      host.style.setProperty('--editor-gutter-width', Math.ceil(Math.max(2, String(totalLines).length) * digitWidth + 20) + 'px');
    }
    for (const key of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'textIndent', 'fontVariantLigatures']) mirror.style[key] = style[key];
    mirror.style.width = editor.clientWidth + 'px';
    mirror.style.height = editor.clientHeight + 'px';
    syncScroll();
  }
  function appendSource(value, language) {
    const fragment = document.createDocumentFragment();
    const budget = { remainingCharacters: MAX_CHARACTERS, remainingTokens: 12000 };
    if (language !== 'html') window.ForgeSyntax.append(document, fragment, value, language, {}, budget);
    else {
      // HTML script/style bodies use their own language while all text remains
      // literal DOM text; imported files never create executable elements.
      const opening = /<(script|style)\b[^>]*>/gi;
      let cursor = 0, match;
      while ((match = opening.exec(value))) {
        const close = new RegExp('</' + match[1] + '\\s*>', 'gi');
        close.lastIndex = opening.lastIndex;
        const ending = close.exec(value);
        window.ForgeSyntax.append(document, fragment, value.slice(cursor, opening.lastIndex), 'html', {}, budget);
        const end = ending ? ending.index : value.length;
        window.ForgeSyntax.append(document, fragment, value.slice(opening.lastIndex, end), match[1].toLowerCase() === 'script' ? 'javascript' : 'css', {}, budget);
        cursor = end;
        if (!ending) break;
        opening.lastIndex = close.lastIndex;
      }
      window.ForgeSyntax.append(document, fragment, value.slice(cursor), 'html', {}, budget);
    }
    fragment.appendChild(document.createTextNode('\u200b'));
    code.replaceChildren(fragment);
  }
  function render() {
    frame = 0;
    const value = editor.value, language = window.ForgeSyntax?.languageForPath(path);
    syncMetrics();
    if (composing || !language || value.length > MAX_CHARACTERS || !window.ForgeSyntax?.append) {
      host.classList.remove('syntax-ready');
      code.replaceChildren(); lastValue = null; lastLanguage = null;
      return;
    }
    try {
      if (value !== lastValue || language !== lastLanguage) {
        appendSource(value, language); lastValue = value; lastLanguage = language;
      }
      host.classList.add('syntax-ready');
      host.dataset.language = language;
    } catch {
      // Unsupported/oversized or failed highlighting always leaves readable,
      // editable native source rather than making the text transparent.
      host.classList.remove('syntax-ready'); lastValue = null;
    }
  }
  function refresh(nextPath) {
    if (typeof nextPath === 'string') path = nextPath;
    else if (nextPath === null) path = '';
    if (!frame) frame = requestAnimationFrame(render);
  }
  editor.addEventListener('input', () => refresh());
  editor.addEventListener('scroll', syncScroll, { passive: true });
  editor.addEventListener('compositionstart', () => { composing = true; host.classList.remove('syntax-ready'); });
  editor.addEventListener('compositionend', () => { composing = false; refresh(); });
  new MutationObserver(() => refresh()).observe(editor, { childList: true, characterData: true, subtree: true });
  const name = document.getElementById('preview-filename');
  if (name) new MutationObserver(() => refresh(name.title || '')).observe(name, { attributes: true, attributeFilter: ['title'], childList: true });
  new MutationObserver(() => refresh()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-text-scale'] });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => refresh()).observe(editor);
  window.addEventListener('resize', () => refresh());
  document.fonts?.ready.then(() => refresh());
  window.ForgeEditorHighlight = Object.freeze({ refresh });
  refresh(name?.title || '');
})();
