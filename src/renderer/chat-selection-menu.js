(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ForgeChatSelectionMenu = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';

  function searchUrl(text) {
    const query = typeof text === 'string' ? text.trim() : '';
    return query ? `https://www.bing.com/search?q=${encodeURIComponent(query)}` : null;
  }

  function selectionWithin(selection, container) {
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1 || !container) return null;
    const range = selection.getRangeAt(0);
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;
    const text = selection.toString();
    return text.trim() ? { text, range: range.cloneRange() } : null;
  }

  function create({ container, scrollContainer, menu, copy, search, ask, notice, getContextKey = () => '' }) {
    let snapshot = null;
    const buttons = [...menu.querySelectorAll('button[data-chat-action]')];
    const positioning = [...document.styleSheets].flatMap(sheet => {
      try { return [...sheet.cssRules]; } catch { return []; }
    }).find(rule => rule.selectorText === '#chat-selection-menu');
    const close = () => { menu.hidden = true; snapshot = null; };
    const valid = () => snapshot && snapshot.context === getContextKey()
      && container.isConnected && (!snapshot.range || (container.contains(snapshot.range.startContainer)
        && container.contains(snapshot.range.endContainer) && snapshot.range.toString() === snapshot.rangeText));

    function show(event) {
      if (event.target.closest('input,textarea,select,button,[contenteditable="true"]')) return;
      event.preventDefault();
      const selected = selectionWithin(window.getSelection(), container);
      snapshot = { text: selected?.text || '', range: selected?.range || null,
        rangeText: selected?.range.toString() || '', context: getContextKey() };
      buttons.forEach(button => { button.disabled = button.dataset.chatAction !== 'select-all' && !snapshot.text; });
      menu.hidden = false;
      const bounds = menu.getBoundingClientRect();
      const selectionBounds = selected?.range.getBoundingClientRect();
      const keyboard = event.clientX === 0 && event.clientY === 0;
      const anchor = selectionBounds?.height ? selectionBounds : container.getBoundingClientRect();
      const x = keyboard ? anchor.left + 8 : event.clientX;
      const y = keyboard ? anchor.bottom : event.clientY;
      positioning?.style.setProperty('left', `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`);
      positioning?.style.setProperty('top', `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`);
      buttons.find(button => !button.disabled)?.focus({ preventScroll: true });
    }

    async function activate(action) {
      if (!valid()) { close(); return; }
      const text = snapshot.text;
      close();
      try {
        if (action === 'select-all') {
          const range = document.createRange();
          range.selectNodeContents(container);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        } else if (action === 'ask' && text) await ask?.(text);
        else if (action === 'copy' && text) await copy(text);
        else if (action === 'search' && text) {
          const url = searchUrl(text);
          if (url) await search(url);
        }
      } catch (error) { notice?.(error?.message || String(error), true); }
    }

    container.addEventListener('contextmenu', show);
    // Keep the selected range while the menu receives pointer or keyboard input.
    menu.addEventListener('pointerdown', event => event.preventDefault());
    menu.addEventListener('click', event => {
      const button = event.target.closest('button[data-chat-action]');
      if (button && !button.disabled) void activate(button.dataset.chatAction);
    });
    menu.addEventListener('keydown', event => {
      const enabled = buttons.filter(button => !button.disabled);
      const index = enabled.indexOf(document.activeElement);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
          : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
        enabled[next]?.focus({ preventScroll: true });
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        if (event.key === 'Escape') event.preventDefault();
        close();
      }
    });
    document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) close(); }, true);
    (scrollContainer || container).addEventListener('scroll', close, { passive: true });
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return { close };
  }

  return { create, searchUrl, selectionWithin };
});
