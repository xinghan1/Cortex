/* Local completion UI. The original textarea still owns selection and undo. */
(() => {
  'use strict';
  const editor = document.getElementById('file-content');
  const name = document.getElementById('preview-filename');
  const host = editor?.closest('.file-code-editor');
  if (!editor || !host || !window.ForgeCompletion) return;
  const popup = document.createElement('div');
  popup.id = 'editor-completion-list';
  popup.className = 'editor-completion-list';
  popup.hidden = true;
  popup.setAttribute('role', 'listbox');
  popup.setAttribute('aria-label', '代码补全');
  host.append(popup);
  editor.setAttribute('aria-autocomplete', 'list');
  editor.setAttribute('aria-controls', popup.id);
  editor.setAttribute('aria-expanded', 'false');
  const measure = document.createElement('canvas').getContext('2d');
  let result = null, chosen = 0, timer = null, composing = false, inserting = false;
  let path = name?.title || '', snapshot = null, snippet = null, beforeEdit = null, inputSerial = 0;
  const badges = { keyword: 'K', snippet: 'S', function: 'ƒ', method: 'ƒ', variable: 'V', property: 'P', tag: '<>', attribute: 'A', value: 'V', class: 'C' };

  function hidePopup() {
    clearTimeout(timer); timer = null;
    if (!popup.hidden) popup.hidden = true;
    if (popup.childNodes.length) popup.replaceChildren();
    result = null; snapshot = null;
    if (editor.getAttribute('aria-expanded') !== 'false') editor.setAttribute('aria-expanded', 'false');
    if (editor.hasAttribute('aria-activedescendant')) editor.removeAttribute('aria-activedescendant');
  }
  function close() { hidePopup(); snippet = null; beforeEdit = null; }
  function usable() {
    return !composing && !editor.readOnly && !editor.disabled && document.activeElement === editor
      && !!name?.title && !editor.closest('[hidden]') && editor.getClientRects().length > 0;
  }
  function currentSnapshot() { return { value: editor.value, offset: editor.selectionStart, end: editor.selectionEnd, path: name?.title || '' }; }
  function snapshotMatches() {
    return snapshot && snapshot.value === editor.value && snapshot.offset === editor.selectionStart
      && snapshot.end === editor.selectionEnd && snapshot.path === (name?.title || '');
  }
  function choose(index, scroll = false) {
    if (!result) return;
    chosen = Math.max(0, Math.min(result.items.length - 1, index));
    [...popup.querySelectorAll('[role="option"]')].forEach((node, position) => {
      node.setAttribute('aria-selected', String(position === chosen));
      if (position === chosen) {
        editor.setAttribute('aria-activedescendant', node.id);
        if (scroll) node.scrollIntoView({ block: 'nearest' });
      }
    });
  }
  function positionPopup() {
    const style = getComputedStyle(editor);
    const value = editor.value.slice(0, editor.selectionStart);
    const lastBreak = value.lastIndexOf('\n');
    const row = value.split('\n').length - 1;
    let column = 0;
    const tabSize = parseInt(style.tabSize, 10) || 2;
    const line = value.slice(lastBreak + 1).replace(/\t|[^\t]/gu, character => {
      if (character !== '\t') { column++; return character; }
      const spaces = tabSize - column % tabSize; column += spaces; return ' '.repeat(spaces);
    });
    if (measure) measure.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(' ');
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.8;
    const caretX = editor.offsetLeft + (parseFloat(style.paddingLeft) || 0) + (measure?.measureText(line).width || 0) - editor.scrollLeft;
    const caretY = (parseFloat(style.paddingTop) || 0) + row * lineHeight - editor.scrollTop;
    const width = Math.max(100, Math.min(400, host.clientWidth - 16));
    const below = host.clientHeight - caretY - lineHeight - 8;
    const above = Math.max(0, caretY - 8);
    const openAbove = below < 130 && above > below;
    const height = Math.max(35, Math.min(245, openAbove ? above : below));
    popup.style.width = width + 'px';
    popup.style.maxHeight = height + 'px';
    popup.style.left = Math.max(8, Math.min(caretX, host.clientWidth - width - 8)) + 'px';
    popup.style.top = Math.max(4, openAbove ? caretY - Math.min(popup.scrollHeight, height) : caretY + lineHeight) + 'px';
  }
  function show(explicit = false) {
    clearTimeout(timer); timer = null;
    if (!usable() || editor.selectionStart !== editor.selectionEnd) { hidePopup(); return; }
    const request = currentSnapshot();
    const next = window.ForgeCompletion.suggest({ path: request.path, value: request.value, offset: request.offset, explicit });
    if (!next?.items?.length) { hidePopup(); return; }
    result = next; snapshot = request; chosen = 0;
    const fragment = document.createDocumentFragment();
    next.items.forEach((item, index) => {
      const option = document.createElement('div');
      option.id = 'editor-completion-option-' + index;
      option.className = 'editor-completion-option';
      option.setAttribute('role', 'option');
      const badge = document.createElement('span');
      badge.className = 'completion-kind';
      badge.dataset.kind = item.kind;
      badge.textContent = badges[item.kind] || 'V';
      badge.setAttribute('aria-hidden', 'true');
      const label = document.createElement('span');
      label.className = 'completion-label'; label.textContent = item.label;
      const detail = document.createElement('span');
      detail.className = 'completion-detail'; detail.textContent = item.detail || '';
      option.title = item.label + (item.detail ? ' · ' + item.detail : '');
      option.append(badge, label, detail);
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('pointermove', () => choose(index));
      option.addEventListener('click', () => { choose(index); accept(); });
      fragment.append(option);
    });
    const help = document.createElement('div');
    help.className = 'completion-help'; help.setAttribute('role', 'presentation');
    help.textContent = '↑↓ 选择  ·  Tab / Enter 补全  ·  Esc 关闭';
    fragment.append(help);
    popup.replaceChildren(fragment); popup.hidden = false;
    editor.setAttribute('aria-expanded', 'true');
    choose(0); positionPopup();
  }
  function schedule() {
    clearTimeout(timer);
    if (!usable()) return;
    timer = setTimeout(() => show(false), 70);
  }
  function selectStop(index) {
    if (!snippet) return;
    snippet.active = index;
    const stop = snippet.stops[index];
    editor.setSelectionRange(stop.start, stop.end);
    if (stop.index === 0) snippet = null;
  }
  function accept() {
    if (!result || !usable() || !snapshotMatches()) { hidePopup(); return; }
    const item = result.items[chosen];
    const { from, to } = result;
    const oldValue = editor.value;
    const lineStart = oldValue.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
    const indent = oldValue.slice(lineStart, from).match(/^[\t ]*/u)?.[0] || '';
    const expanded = window.ForgeCompletion.expandSnippet(item.insertText, indent, '\n');
    const expected = oldValue.slice(0, from) + expanded.text + oldValue.slice(to);
    const priorSerial = inputSerial;
    hidePopup(); snippet = null;
    inserting = true;
    try {
      editor.focus({ preventScroll: true });
      editor.setSelectionRange(from, to);
      // Chromium records this as an edit in the textarea's native undo stack.
      try { document.execCommand('insertText', false, expanded.text); } catch { /* Native fallback below. */ }
      if (editor.value === oldValue && expected !== oldValue) editor.setRangeText(expanded.text, from, to, 'end');
      if (editor.value !== expected) return;
      if (inputSerial === priorSerial && expected !== oldValue) editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: expanded.text }));
      const stops = expanded.stops.map(stop => ({ ...stop, start: from + stop.start, end: from + stop.end }));
      if (stops.length) {
        snippet = { value: editor.value, stops, active: 0 };
        selectStop(0);
      } else editor.setSelectionRange(from + expanded.text.length, from + expanded.text.length);
      window.ForgeEditorHighlight?.refresh(name.title);
    } finally { inserting = false; beforeEdit = null; }
  }
  function trackSnippet() {
    if (!snippet || editor.value === snippet.value) return;
    const previous = snippet.value, value = editor.value, active = snippet.stops[snippet.active];
    // Measure the actual changed range, including word deletion, IME and paste.
    let from = 0, to = previous.length, end = value.length;
    while (from < Math.min(previous.length, value.length) && previous[from] === value[from]) from++;
    while (to > from && end > from && previous[to - 1] === value[end - 1]) { to--; end--; }
    if (beforeEdit?.value === previous && (beforeEdit.from < active.start || beforeEdit.to > active.end)) { snippet = null; return; }
    // Equal text beside the caret (notably consecutive newlines) can make a
    // minimal string diff drift outside an empty stop. Prefer a recorded range
    // whenever it exactly explains the new value; deletions still use the diff.
    if (beforeEdit?.value === previous) {
      const inserted = value.length - previous.length + beforeEdit.to - beforeEdit.from;
      if (inserted >= 0 && value.slice(0, beforeEdit.from) === previous.slice(0, beforeEdit.from)
        && value.slice(beforeEdit.from + inserted) === previous.slice(beforeEdit.to)) {
        from = beforeEdit.from; to = beforeEdit.to;
      }
    }
    if (from < active.start || to > active.end) { snippet = null; return; }
    const delta = value.length - previous.length;
    active.end += delta;
    for (const stop of snippet.stops) if (stop !== active && stop.start >= to) { stop.start += delta; stop.end += delta; }
    snippet.value = value;
  }
  editor.addEventListener('beforeinput', event => {
    beforeEdit = { value: editor.value, from: editor.selectionStart, to: editor.selectionEnd, type: event.inputType };
  });
  editor.addEventListener('input', event => {
    inputSerial++;
    if (inserting) return;
    if (event.inputType?.startsWith('history')) snippet = null;
    else trackSnippet();
    beforeEdit = null;
    hidePopup();
    if (!composing && !event.isComposing && !event.inputType?.startsWith('delete') && !event.inputType?.startsWith('history')) schedule();
  });
  editor.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || composing || event.keyCode === 229 || editor.readOnly || editor.disabled) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && (event.code === 'Space' || event.key === ' ')) {
      event.preventDefault(); show(true); return;
    }
    if (!popup.hidden && !snapshotMatches()) hidePopup();
    if (!popup.hidden) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); choose((chosen + (event.key === 'ArrowDown' ? 1 : -1) + result.items.length) % result.items.length, true); return;
      }
      if ((event.key === 'Tab' && !event.shiftKey || event.key === 'Enter') && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); accept(); return;
      }
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Tab'].includes(event.key)) hidePopup();
    }
    if (snippet && event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const active = snippet.stops[snippet.active];
      if (editor.selectionStart < active.start || editor.selectionEnd > active.end) { snippet = null; return; }
      event.preventDefault();
      const index = event.shiftKey ? Math.max(0, snippet.active - 1) : snippet.active + 1;
      if (index < snippet.stops.length) selectStop(index); else snippet = null;
      return;
    }
    if (snippet && event.key === 'Escape') { event.preventDefault(); close(); }
  }, true);
  editor.addEventListener('compositionstart', () => { composing = true; hidePopup(); });
  editor.addEventListener('compositionend', () => { composing = false; beforeEdit = null; });
  editor.addEventListener('scroll', () => { if (!popup.hidden) hidePopup(); }, { passive: true });
  editor.addEventListener('blur', close);
  editor.addEventListener('pointerdown', close);
  document.addEventListener('selectionchange', () => {
    if (!popup.hidden && document.activeElement === editor && !snapshotMatches()) hidePopup();
  });
  document.addEventListener('pointerdown', event => { if (!host.contains(event.target)) close(); });
  new MutationObserver(() => {
    const nextPath = name?.title || '';
    if (nextPath !== path) { path = nextPath; close(); }
    if (editor.readOnly || editor.disabled || !editor.getClientRects().length) close();
    if (snippet && editor.value !== snippet.value) snippet = null;
    if (!popup.hidden && !snapshotMatches()) hidePopup();
  }).observe(host.closest('#preview-panel') || host, { attributes: true, attributeFilter: ['title', 'readonly', 'disabled', 'hidden'], childList: true, subtree: true });
  window.addEventListener('resize', hidePopup);
  if (typeof ResizeObserver === 'function') new ResizeObserver(hidePopup).observe(editor);
  window.ForgeEditorCompletion = Object.freeze({ close, refresh: () => { close(); path = name?.title || ''; } });
})();
