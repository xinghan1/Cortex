'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ForgeExplorerSelection = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  function range(paths, anchor, target) {
    const end = paths.indexOf(target), start = paths.indexOf(anchor);
    return end < 0 ? [] : paths.slice(Math.min(start < 0 ? end : start, end), Math.max(start < 0 ? end : start, end) + 1);
  }
  function create(tree, { onChange = () => {}, onMarquee = () => {} } = {}) {
    const panel = tree.closest('.sidebar-panel') || tree;
    const rows = () => [...tree.querySelectorAll('.file-row')];
    const visible = () => rows().filter(row => row.getClientRects().length);
    const entry = row => row ? { path: row.dataset.path, type: row.dataset.type, name: row.querySelector('.file-name')?.textContent || row.dataset.path.split('/').at(-1) } : null;
    let chosen = new Map(), activePath = null, anchor = null, revision = 0, focusing = false;
    let gesture = null, frame = 0, suppressClick = false, box = null, boxStyle = null;
    tree.setAttribute('aria-multiselectable', 'true');
    function refresh() {
      for (const row of rows()) {
        const selected = chosen.has(row.dataset.path);
        row.classList.toggle('selected', selected);
        row.setAttribute('aria-selected', String(selected));
      }
    }
    function set(entries, options = {}) {
      const next = new Map(entries.filter(value => value && typeof value.path === 'string').map(value => [value.path, { ...value }]));
      const nextActive = options.activePath ?? [...next.keys()].at(-1) ?? null;
      const changed = nextActive !== activePath || next.size !== chosen.size || [...next.keys()].some(path => !chosen.has(path));
      chosen = next; activePath = nextActive;
      if (!options.preserveAnchor) anchor = nextActive;
      refresh();
      if (changed) { revision++; onChange({ entries: [...chosen.values()], activePath, revision }); }
    }
    function focus(row) {
      if (!row) return;
      focusing = true; row.focus({ preventScroll: true }); focusing = false;
    }
    function select(row, { toggle = false, extend = false } = {}) {
      const value = entry(row);
      if (!value) return;
      if (extend) {
        const list = visible(), paths = range(list.map(item => item.dataset.path), anchor, value.path);
        const next = toggle ? new Map(chosen) : new Map();
        for (const item of list) if (paths.includes(item.dataset.path)) next.set(item.dataset.path, entry(item));
        set([...next.values()], { activePath: value.path, preserveAnchor: true });
        if (!anchor) anchor = value.path;
      } else if (toggle) {
        const next = new Map(chosen);
        if (next.has(value.path)) next.delete(value.path); else next.set(value.path, value);
        set([...next.values()], { activePath: value.path });
      } else set([value], { activePath: value.path });
    }
    function rectangleStyle() {
      if (boxStyle) return boxStyle;
      for (const sheet of document.styleSheets) {
        try { boxStyle = [...sheet.cssRules].find(rule => rule.selectorText === '.explorer-selection-box')?.style; } catch {}
        if (boxStyle) break;
      }
      return boxStyle;
    }
    function paint() {
      if (!gesture?.active) return;
      const g = gesture, bounds = panel.getBoundingClientRect(), treeBounds = tree.getBoundingClientRect();
      const left = Math.max(bounds.left, treeBounds.left), right = Math.min(bounds.right, treeBounds.right);
      const top = Math.max(bounds.top, treeBounds.top), bottom = bounds.bottom;
      const x = Math.max(left, Math.min(right, g.x)), y = Math.max(top, Math.min(bottom, g.y));
      const endX = x - bounds.left + panel.scrollLeft, endY = y - bounds.top + panel.scrollTop;
      const rect = { left: Math.min(g.startX, endX), right: Math.max(g.startX, endX), top: Math.min(g.startY, endY), bottom: Math.max(g.startY, endY) };
      const next = new Map(g.additive ? g.initial : []);
      for (const row of visible()) {
        const r = row.getBoundingClientRect(), rowLeft = r.left - bounds.left + panel.scrollLeft, rowTop = r.top - bounds.top + panel.scrollTop;
        if (rowLeft <= rect.right && rowLeft + r.width >= rect.left && rowTop <= rect.bottom && rowTop + r.height >= rect.top) next.set(row.dataset.path, entry(row));
      }
      set([...next.values()], { activePath: [...next.keys()].at(-1), preserveAnchor: true });
      const style = rectangleStyle();
      if (style) {
        const x1 = Math.max(left, bounds.left + rect.left - panel.scrollLeft), x2 = Math.min(right, bounds.left + rect.right - panel.scrollLeft);
        const y1 = Math.max(top, bounds.top + rect.top - panel.scrollTop), y2 = Math.min(bottom, bounds.top + rect.bottom - panel.scrollTop);
        style.left = `${x1}px`; style.top = `${y1}px`; style.width = `${Math.max(1, x2 - x1)}px`; style.height = `${Math.max(1, y2 - y1)}px`;
      }
    }
    function scrollFrame() {
      if (!gesture?.active) return;
      const bounds = panel.getBoundingClientRect(), y = gesture.y;
      const speed = y < bounds.top + 28 ? -Math.min(16, (bounds.top + 28 - y) / 2) : y > bounds.bottom - 28 ? Math.min(16, (y - bounds.bottom + 28) / 2) : 0;
      if (speed) panel.scrollTop += speed;
      paint(); frame = requestAnimationFrame(scrollFrame);
    }
    function activate() {
      if (!gesture || gesture.active) return;
      gesture.active = true; clearTimeout(gesture.timer);
      onMarquee();
      tree.classList.add('marquee-selecting');
      box = document.createElement('div'); box.className = 'explorer-selection-box'; box.setAttribute('aria-hidden', 'true'); document.body.append(box);
      tree.setPointerCapture?.(gesture.pointerId);
      focus(tree); paint(); frame = requestAnimationFrame(scrollFrame);
    }
    function finish(cancel = false) {
      if (!gesture) return;
      const g = gesture; gesture = null; clearTimeout(g.timer); cancelAnimationFrame(frame); frame = 0;
      box?.remove(); box = null; tree.classList.remove('marquee-selecting');
      if (g.active) {
        suppressClick = true; setTimeout(() => { suppressClick = false; }, 400);
        if (cancel) set([...g.initial.values()], { activePath: g.initialActive });
        if (tree.hasPointerCapture?.(g.pointerId)) tree.releasePointerCapture(g.pointerId);
      }
    }
    tree.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.pointerType && event.pointerType !== 'mouse' || event.target.closest('button:not(.file-row),input')) return;
      suppressClick = false;
      finish();
      const row = event.target.closest('.file-row'), bounds = panel.getBoundingClientRect();
      gesture = { pointerId: event.pointerId, row, x: event.clientX, y: event.clientY, startClientX: event.clientX, startClientY: event.clientY,
        startX: event.clientX - bounds.left + panel.scrollLeft, startY: event.clientY - bounds.top + panel.scrollTop,
        initial: new Map(chosen), initialActive: activePath, additive: event.ctrlKey || event.metaKey || event.shiftKey, active: false };
      if (row) gesture.timer = setTimeout(activate, 350);
    }, true);
    window.addEventListener('pointermove', event => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      gesture.x = event.clientX; gesture.y = event.clientY;
      if (!gesture.active && Math.hypot(event.clientX - gesture.startClientX, event.clientY - gesture.startClientY) >= 5) {
        if (!gesture.row || gesture.additive) activate();
        else { clearTimeout(gesture.timer); gesture = null; return; } // Quick row drag retains file movement.
      }
      if (gesture?.active) { event.preventDefault(); paint(); }
    }, { passive: false });
    window.addEventListener('pointerup', event => { if (gesture?.pointerId === event.pointerId) finish(); });
    window.addEventListener('pointercancel', () => finish(true));
    tree.addEventListener('lostpointercapture', () => finish(true));
    window.addEventListener('blur', () => finish(true));
    tree.addEventListener('dragstart', event => {
      if (gesture?.active) { event.preventDefault(); event.stopImmediatePropagation(); }
      else finish();
    }, true);
    tree.addEventListener('click', event => {
      if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      const row = event.target.closest('.file-row');
      if (row?.hasAttribute('data-restoring-expansion')) return;
      if (row) {
        select(row, { toggle: event.ctrlKey || event.metaKey, extend: event.shiftKey });
        focus(row);
        if (event.ctrlKey || event.metaKey || event.shiftKey) { event.preventDefault(); event.stopImmediatePropagation(); }
      } else if (!event.target.closest('button') && !event.ctrlKey && !event.metaKey && !event.shiftKey) set([]);
    }, true);
    tree.addEventListener('contextmenu', event => {
      finish();
      const row = event.target.closest('.file-row');
      if (row) {
        if (!chosen.has(row.dataset.path)) select(row);
        else set([...chosen.values()], { activePath: row.dataset.path, preserveAnchor: true });
        focus(row);
      }
    }, true);
    tree.addEventListener('focusin', event => {
      const row = event.target.closest('.file-row');
      if (row && !focusing && !gesture && !chosen.has(row.dataset.path)) select(row);
    });
    tree.addEventListener('keydown', event => {
      if (event.altKey || event.isComposing || event.defaultPrevented) return;
      const toggle = event.ctrlKey || event.metaKey, list = visible();
      if (toggle && event.key.toLowerCase() === 'a') { event.preventDefault(); set(list.map(entry), { activePath: document.activeElement?.dataset.path || list.at(-1)?.dataset.path }); return; }
      if (event.key === 'Escape') { event.preventDefault(); if (gesture?.active) finish(true); else set([]); return; }
      const row = document.activeElement.closest?.('.file-row');
      if (event.key === ' ' && row) { event.preventDefault(); select(row, { toggle, extend: event.shiftKey }); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !list.length) return;
      event.preventDefault();
      const index = list.indexOf(row), next = event.key === 'Home' ? 0 : event.key === 'End' ? list.length - 1 : Math.max(0, Math.min(list.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
      if (!toggle || event.shiftKey) select(list[next], { toggle, extend: event.shiftKey });
      focus(list[next]); list[next].scrollIntoView({ block: 'nearest' });
    });
    return Object.freeze({ entries: () => [...chosen.values()], has: path => chosen.has(path), set, refresh,
      get revision() { return revision; }, get selecting() { return Boolean(gesture?.active); },
      clear() { finish(); set([]); }, cancelGesture() { finish(true); },
      collapse(path) { set([...chosen.values()].filter(value => !value.path.startsWith(path + '/')), { activePath: path, preserveAnchor: true }); },
      reconcile(directory, files) {
        const prefix = directory ? directory + '/' : '', known = new Set(files.map(file => file.path.toLowerCase()));
        const next = [...chosen.values()].filter(value => {
          if (!value.path.startsWith(prefix) || value.path === directory) return true;
          const immediate = prefix + value.path.slice(prefix.length).split('/')[0];
          return known.has(immediate.toLowerCase());
        });
        set(next, { activePath: next.some(value => value.path === activePath) ? activePath : next.at(-1)?.path, preserveAnchor: true });
      },
    });
  }
  return Object.freeze({ create, range });
});
