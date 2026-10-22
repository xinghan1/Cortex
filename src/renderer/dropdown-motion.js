/* Keep native select values/forms and enhance only their option presentation. */
(() => {
  'use strict';
  const surfaces = '.project-dropdown,.session-dropdown,.permission-popup,.reasoning-popup,.model-list-panel,.app-menu-popup,.file-context-menu,.context-settings-popup';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const tracked = new Map(), enhanced = new WeakSet(), ghosts = new Set();
  let active = null, serial = 0, typeBuffer = '', typedAt = 0;
  const ignored = element => element?.closest?.('[data-dropdown-ghost],.dropdown-select-popup');
  const visible = element => element.isConnected && !element.hidden && (element.tagName !== 'DIALOG' || element.open)
    && element.checkVisibility({ checkVisibilityCSS: true });
  const motion = (element, frames, duration, fill = 'none') => {
    if (reduced.matches || typeof element.animate !== 'function') return null;
    const animation = element.animate(frames, { duration, easing: 'cubic-bezier(.2,.75,.25,1)', fill });
    animation.finished.catch(() => {});
    return animation;
  };

  const anchors = {
    'project-dropdown': '#project-switcher', 'session-dropdown': '#session-menu-button',
    'permission-popup': '#permission-trigger', 'reasoning-popup': '#model-reasoning-trigger',
    'model-list-panel': '#model-reasoning-trigger', 'context-settings-popup': '#session-context-trigger',
    'app-menu-popup': '#app-menu-bar [aria-expanded="true"]',
    'app-menu-submenu': '#app-menu-popup [aria-haspopup="menu"][aria-expanded="true"]',
    'file-context-menu': '#file-tree .file-row.selected',
  };
  function directionFor(element) {
    const rect = element.getBoundingClientRect(), anchor = document.querySelector(anchors[element.id] || '.__dropdown_anchor_missing__');
    const target = anchor?.getBoundingClientRect();
    if (target?.height && target.bottom > 0 && target.top < innerHeight) {
      if (rect.bottom <= target.top + 12) return 'up';
      if (rect.top >= target.bottom - 12) return 'down';
      return rect.top + rect.height / 2 < target.top + target.height / 2 ? 'up' : 'down';
    }
    return rect.top + rect.height / 2 > innerHeight / 2 ? 'up' : 'down';
  }
  function reveal(element, direction, opening, fromClip, fromOpacity = 1) {
    const height = element.getBoundingClientRect().height;
    const radius = getComputedStyle(element).borderRadius || '0px';
    const full = `inset(0px 0px 0px 0px round ${radius})`;
    const cut = Math.max(0, height - 1);
    const collapsed = direction === 'up' ? `inset(${cut}px 0px 0px 0px round ${radius})`
      : `inset(0px 0px ${cut}px 0px round ${radius})`;
    element.dataset.dropdownDirection = direction;
    element.dataset.dropdownRevealHeight = String(height);
    // Insets change the actual revealed height from one pixel to the complete
    // surface. Text keeps its original layout and never scales or compresses.
    return motion(element, opening ? [{ clipPath: fromClip && fromClip !== 'none' ? fromClip : collapsed, opacity: fromClip ? fromOpacity : .7 }, { clipPath: full, opacity: 1 }]
      : [{ clipPath: fromClip && fromClip !== 'none' ? fromClip : full, opacity: fromOpacity }, { clipPath: collapsed, opacity: 0 }], opening ? 260 : 220, opening ? 'none' : 'forwards');
  }
  function revealedHeight(element, previousHeight) {
    const clip = getComputedStyle(element).clipPath;
    if (!clip || clip === 'none') return previousHeight;
    const inset = clip.match(/^inset\(([^)]*?)(?:\s+round\s|\))/u)?.[1]?.trim().split(/\s+/u).map(Number.parseFloat);
    if (!inset?.length || inset.some(value => !Number.isFinite(value))) return Math.min(1, previousHeight);
    const top = inset[0], bottom = inset.length > 2 ? inset[2] : top;
    return Math.max(0, Math.min(previousHeight, previousHeight - top - bottom));
  }
  function beginReveal(element, state, direction, retarget = false) {
    const height = element.getBoundingClientRect().height;
    let fromClip, opacity = 1;
    if (retarget) {
      // The DOM already has its new height. The old clip still uses pixels
      // from the preceding height, so recover that preceding visible region
      // before cancelling it, then express the same region in the new box.
      const visibleHeight = Math.min(height, revealedHeight(element, state.height));
      const cut = Math.max(0, height - visibleHeight), radius = getComputedStyle(element).borderRadius || '0px';
      fromClip = direction === 'up' ? `inset(${cut}px 0px 0px 0px round ${radius})`
        : `inset(0px 0px ${cut}px 0px round ${radius})`;
      opacity = Number(getComputedStyle(element).opacity);
    }
    state.animation?.cancel();
    state.height = height; state.revealDirection = direction;
    state.animation = reveal(element, direction, true, fromClip, opacity);
  }
  function retargetReveal(element, state, direction) {
    if (state.animation?.playState === 'running' && (Math.abs(element.getBoundingClientRect().height - state.height) > .5 || direction !== state.revealDirection))
      beginReveal(element, state, direction, true);
  }

  function snapshot(element) {
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const clone = element.cloneNode(true);
    for (const part of [clone, ...clone.querySelectorAll('*')]) {
      for (const attribute of [...part.attributes]) if (['id', 'name', 'for', 'form', 'autofocus', 'popover', 'popovertarget', 'popovertargetaction', 'open'].includes(attribute.name)
          || attribute.name.startsWith('aria-') || attribute.name.startsWith('data-') || attribute.name.startsWith('on')) part.removeAttribute(attribute.name);
    }
    clone.hidden = false; clone.inert = true; clone.dataset.dropdownGhost = 'true'; clone.setAttribute('aria-hidden', 'true');
    const style = clone.style;
    style.position = 'fixed'; style.inset = 'auto'; style.left = rect.left + 'px'; style.top = rect.top + 'px';
    style.width = rect.width + 'px'; style.height = rect.height + 'px'; style.margin = '0'; style.boxSizing = 'border-box';
    style.pointerEvents = 'none'; style.overflow = 'hidden'; style.zIndex = '2147483000'; style.display = 'block';
    return { clone, owner: element.closest('dialog[open]') || document.body,
      direction: element.dataset.dropdownDirection || directionFor(element),
      clipPath: getComputedStyle(element).clipPath, opacity: getComputedStyle(element).opacity };
  }
  function exit(saved) {
    if (!saved || reduced.matches) return;
    const ghost = saved.clone, owner = saved.owner?.isConnected ? saved.owner : document.body;
    owner.append(ghost); ghosts.add(ghost);
    // A top-layer popover can escape a modal dialog's clipping while remaining
    // in that dialog's subtree. It is inert and never receives user input.
    if (typeof ghost.showPopover === 'function') {
      ghost.setAttribute('popover', 'manual');
      try { ghost.showPopover(); } catch { /* The fixed fallback remains noninteractive. */ }
    }
    const remove = () => { ghosts.delete(ghost); ghost.remove(); };
    const animation = reveal(ghost, saved.direction, false, saved.clipPath, Number(saved.opacity));
    if (animation) animation.finished.then(remove, remove); else remove();
  }
  function watchSurface(element) {
    if (ignored(element)) return;
    let item = tracked.get(element);
    if (!item) { item = { shown: false, saved: null, animation: null }; tracked.set(element, item); element.classList.add('dropdown-motion-surface'); }
    const shown = visible(element);
    if (shown && !item.shown) {
      beginReveal(element, item, directionFor(element)); item.saved = snapshot(element);
    } else if (!shown && item.shown) {
      if (item.saved && item.animation?.playState === 'running') {
        item.saved.clipPath = getComputedStyle(element).clipPath; item.saved.opacity = getComputedStyle(element).opacity;
      } else if (item.saved) { item.saved.clipPath = 'none'; item.saved.opacity = 1; }
      item.animation?.cancel();
      const parent = element.parentElement?.closest(surfaces);
      if (!parent || visible(parent)) exit(item.saved);
      item.saved = null;
    }
    else if (shown) { retargetReveal(element, item, directionFor(element)); item.saved = snapshot(element); }
    item.shown = shown;
    if (!element.isConnected) { item.animation?.cancel(); tracked.delete(element); }
  }

  const selectReady = select => select instanceof HTMLSelectElement && !select.multiple && select.size <= 1
    && !select.matches(':disabled') && visible(select);
  const disabled = option => option.disabled || option.parentElement?.tagName === 'OPTGROUP' && option.parentElement.disabled;
  const usable = select => [...select.options].map((option, index) => ({ option, index })).filter(({ option }) => !option.hidden && !option.parentElement?.hidden && !disabled(option));
  function position() {
    if (!active) return;
    const { select, popup } = active, rect = select.getBoundingClientRect();
    const width = Math.min(Math.max(rect.width, 180), innerWidth - 16);
    popup.style.width = width + 'px'; popup.style.maxHeight = Math.max(60, Math.min(300, innerHeight - 24)) + 'px';
    const height = Math.min(popup.scrollHeight, 300, innerHeight - 24);
    const below = innerHeight - rect.bottom - 12, above = rect.top - 12;
    const downward = below >= Math.min(height, 150) || below >= above;
    active.direction = downward ? 'down' : 'up'; popup.dataset.dropdownDirection = active.direction;
    const top = downward ? rect.bottom + 5 : rect.top - height - 5;
    popup.style.left = Math.max(8, Math.min(rect.left, innerWidth - width - 8)) + 'px';
    popup.style.top = Math.max(8, Math.min(top, innerHeight - height - 8)) + 'px';
  }
  function highlight(index, scroll = true) {
    if (!active) return;
    const row = active.popup.querySelector(`[data-option-index="${index}"]`);
    if (!row || row.getAttribute('aria-disabled') === 'true') return;
    active.index = index;
    for (const other of active.popup.querySelectorAll('.dropdown-select-option')) other.dataset.active = String(other === row);
    active.select.setAttribute('aria-activedescendant', row.id);
    if (scroll) {
      const { popup } = active, top = row.offsetTop, bottom = top + row.offsetHeight;
      if (top < popup.scrollTop) popup.scrollTop = top;
      else if (bottom > popup.scrollTop + popup.clientHeight) popup.scrollTop = bottom - popup.clientHeight;
    }
  }
  function renderOptions() {
    if (!active) return;
    const { select, popup } = active, oldIndex = active.index;
    popup.replaceChildren();
    let group = null;
    [...select.options].forEach((option, index) => {
      if (option.hidden || option.parentElement?.hidden) return;
      if (option.parentElement?.tagName === 'OPTGROUP' && option.parentElement !== group) {
        group = option.parentElement;
        const label = document.createElement('div'); label.className = 'dropdown-select-group'; label.textContent = group.label; label.setAttribute('role', 'presentation'); popup.append(label);
      }
      const row = document.createElement('div'); row.className = 'dropdown-select-option'; row.id = `${popup.id}-option-${index}`;
      row.dataset.optionIndex = String(index); row.dataset.value = option.value; row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', String(option.selected)); row.setAttribute('aria-disabled', String(disabled(option)));
      row.textContent = option.label || option.textContent; row.title = option.title || '';
      row.addEventListener('pointermove', () => { if (!disabled(option)) highlight(index, false); });
      row.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); commit(index); });
      popup.append(row);
    });
    const available = usable(select);
    const index = available.some(value => value.index === oldIndex) ? oldIndex
      : available.some(value => value.index === select.selectedIndex) ? select.selectedIndex : available[0]?.index;
    if (index !== undefined) highlight(index, false); else select.removeAttribute('aria-activedescendant');
    position();
    retargetReveal(popup, active, active.direction);
  }
  function close(restore = false) {
    if (!active) return;
    const { select, popup, animation } = active, saved = visible(popup) ? snapshot(popup) : null;
    animation?.cancel();
    active = null; typeBuffer = '';
    select.setAttribute('aria-expanded', 'false'); select.removeAttribute('aria-activedescendant'); select.removeAttribute('aria-controls');
    if (popup.matches(':popover-open')) popup.hidePopover();
    popup.remove(); exit(saved);
    if (restore && select.isConnected && !select.matches(':disabled')) select.focus({ preventScroll: true });
  }
  function open(select) {
    if (!selectReady(select)) return;
    if (active?.select === select) return;
    close();
    const popup = document.createElement('div'); popup.className = 'dropdown-select-popup'; popup.id = `dropdown-select-listbox-${++serial}`;
    popup.dataset.selectId = select.id; popup.setAttribute('role', 'listbox'); popup.setAttribute('tabindex', '-1');
    popup.setAttribute('aria-label', select.getAttribute('aria-label') || select.labels?.[0]?.textContent?.trim() || '选项');
    popup.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
    const owner = select.closest('dialog[open]') || document.body; owner.append(popup);
    active = { select, popup, index: select.selectedIndex };
    select.focus({ preventScroll: true }); select.setAttribute('aria-expanded', 'true'); select.setAttribute('aria-controls', popup.id);
    if (typeof popup.showPopover === 'function') { popup.setAttribute('popover', 'manual'); popup.showPopover(); }
    renderOptions(); highlight(active.index);
    beginReveal(popup, active, active.direction);
  }
  function commit(index) {
    if (!active) return;
    const { select } = active, option = select.options[index];
    if (!selectReady(select) || !option || option.hidden || option.parentElement?.hidden || disabled(option)) return;
    const changed = select.selectedIndex !== index;
    close(true);
    if (changed) {
      select.selectedIndex = index;
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  function enhance(select) {
    if (enhanced.has(select) || ignored(select) || select.multiple || select.size > 1) return;
    enhanced.add(select); select.dataset.dropdownEnhanced = 'true'; select.setAttribute('aria-haspopup', 'listbox'); select.setAttribute('aria-expanded', 'false');
    select.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !selectReady(select)) return;
      event.preventDefault();
      if (active?.select === select) close(true); else open(select);
    });
    select.addEventListener('mousedown', event => { if (selectReady(select) && event.button === 0) event.preventDefault(); });
    select.addEventListener('click', event => {
      if (!selectReady(select)) return;
      event.preventDefault();
      if (event.detail === 0 && !active) open(select);
    });
    select.addEventListener('change', () => { if (active?.select === select) renderOptions(); });
  }
  function discover(root) {
    if (!(root instanceof Element) || ignored(root)) return;
    if (root.matches('select')) enhance(root);
    for (const select of root.querySelectorAll('select')) enhance(select);
    if (root.matches(surfaces)) watchSurface(root);
    for (const surface of root.querySelectorAll(surfaces)) watchSurface(surface);
  }
  document.addEventListener('keydown', event => {
    const select = event.target;
    if (!(select instanceof HTMLSelectElement) || !enhanced.has(select) || !selectReady(select) || event.isComposing) return;
    if (active?.select !== select) {
      // Closed Home/End and text search retain native select behavior.
      if (['ArrowDown', 'ArrowUp', 'F4', 'Enter', ' '].includes(event.key) && !event.ctrlKey && !event.metaKey) {
        event.preventDefault(); event.stopImmediatePropagation(); open(select);
      }
      return;
    }
    if (event.key === 'Tab') { close(); return; }
    if (event.key === 'Escape' || event.key === 'F4' || event.altKey && event.key === 'ArrowUp') {
      event.preventDefault(); event.stopImmediatePropagation(); close(true); return;
    }
    const choices = usable(select), current = choices.findIndex(value => value.index === active.index);
    const steps = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 };
    if (Object.hasOwn(steps, event.key) || ['Home', 'End'].includes(event.key)) {
      event.preventDefault(); event.stopImmediatePropagation();
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : Math.max(0, Math.min(choices.length - 1, current + steps[event.key]));
      if (choices[index]) highlight(choices[index].index); return;
    }
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopImmediatePropagation(); commit(active.index); return; }
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopImmediatePropagation();
      const now = Date.now(); typeBuffer = now - typedAt > 700 ? event.key : typeBuffer + event.key; typedAt = now;
      const needle = typeBuffer.toLocaleLowerCase(), repeated = [...needle].every(char => char === needle[0]);
      const sequence = [...choices.slice(current + 1), ...choices.slice(0, current + 1)];
      const match = sequence.find(({ option }) => (option.label || option.textContent).toLocaleLowerCase().startsWith(repeated ? needle[0] : needle));
      if (match) highlight(match.index);
    }
  }, true);
  document.addEventListener('pointerdown', event => { if (active && event.target !== active.select && !active.popup.contains(event.target)) close(); }, true);
  document.addEventListener('focusin', event => { if (active && event.target !== active.select && !active.popup.contains(event.target)) close(); });
  document.addEventListener('close', event => { if (active && event.target.contains(active.select)) close(); }, true);
  window.addEventListener('resize', () => close());
  window.addEventListener('blur', () => close());
  document.addEventListener('scroll', event => {
    if (!active || active.popup.contains(event.target)) return;
    const target = event.target;
    if (target === document || target === document.documentElement || target === document.body
        || target instanceof Element && target.contains(active.select)) close();
  }, true);
  new MutationObserver(records => {
    let updateOptions = false, checkSurfaces = false;
    for (const record of records) {
      const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (ignored(target)) continue;
      if (record.type === 'childList') for (const added of record.addedNodes) if (added.nodeType === 1) discover(added);
      if (active && (target === active.select || target?.closest?.('select') === active.select)) updateOptions = true;
      if (record.type === 'attributes' || target?.closest?.(surfaces)) checkSurfaces = true;
    }
    if (active && !selectReady(active.select)) close(); else if (updateOptions) renderOptions();
    if (checkSurfaces) for (const surface of [...tracked.keys()]) watchSurface(surface);
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['hidden', 'open', 'disabled', 'selected', 'label', 'value', 'multiple', 'size'] });
  reduced.addEventListener('change', () => { if (reduced.matches) { active?.animation?.cancel(); for (const ghost of ghosts) { for (const animation of ghost.getAnimations()) animation.cancel(); ghost.remove(); } ghosts.clear(); for (const item of tracked.values()) item.animation?.cancel(); } });
  discover(document.documentElement);
  window.ForgeDropdownMotion = Object.freeze({ open, close, refresh: () => discover(document.documentElement) });
})();
