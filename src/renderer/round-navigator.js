'use strict';

// This rail observes the rendered conversation only. Selecting a round never
// replays a prompt or invokes a model, file, or task action.
(() => {
  const rail = document.getElementById('round-navigator');
  const messages = document.getElementById('messages');
  const viewport = document.getElementById('message-scroll');
  const conversation = rail?.closest('.conversation');
  if (!rail || !messages || !viewport || !conversation) return;

  const list = document.createElement('div');
  list.className = 'round-navigator-list';
  const tooltip = document.createElement('div');
  tooltip.id = 'round-navigator-tooltip';
  tooltip.className = 'round-navigator-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  const tooltipHeading = document.createElement('strong');
  const tooltipPreview = document.createElement('span');
  tooltip.append(tooltipHeading, tooltipPreview);
  rail.replaceChildren(list, tooltip);

  let anchors = [];
  let buttons = [];
  let active = -1;
  let hovered = null;
  let focused = null;
  let frame = 0;
  let rebuildRequested = true;
  let positionStyle;

  function ruleStyle() {
    if (positionStyle) return positionStyle;
    for (const sheet of document.styleSheets) {
      try {
        const rule = [...sheet.cssRules].find(item => item.selectorText === '#round-navigator');
        if (rule) { positionStyle = rule.style; return positionStyle; }
      } catch { /* Use only the application's own readable stylesheet. */ }
    }
    return null;
  }

  function isTaskPrompt(message) {
    return message.matches('.message.user') && !message.hidden
      && message.parentElement === messages
      && message.dataset.messageSource !== 'steering' && message.dataset.source !== 'steering'
      && !message.querySelector('.user-message-source')
      && !message.closest('.task-activity-events');
  }

  function previewFor(message) {
    const content = message.querySelector('.message-body')?.textContent || '';
    const text = content.replace(/\s+/gu, ' ').trim();
    if (text) {
      const characters = Array.from(text);
      return characters.slice(0, 100).join('') + (characters.length > 100 ? '…' : '');
    }
    const image = message.querySelector('.user-message-image');
    return image ? `图片：${image.alt || '图片消息'}` : '用户消息';
  }

  function schedule(rebuild = false) {
    rebuildRequested ||= rebuild;
    if (!frame) frame = requestAnimationFrame(render);
  }

  function ensureTickVisible(button) {
    if (!button || rail.hidden) return;
    const bounds = list.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    if (rect.top < bounds.top) list.scrollTop -= bounds.top - rect.top;
    else if (rect.bottom > bounds.bottom) list.scrollTop += rect.bottom - bounds.bottom;
  }

  function setActive(index) {
    if (active === index) return;
    active = index;
    buttons.forEach((button, ordinal) => {
      if (ordinal === index) button.setAttribute('aria-current', 'step');
      else button.removeAttribute('aria-current');
      button.tabIndex = ordinal === index ? 0 : -1;
    });
    ensureTickVisible(buttons[index]);
  }

  function updateActive() {
    if (!anchors.length || rail.hidden) return;
    const bounds = viewport.getBoundingClientRect();
    const threshold = bounds.top + viewport.clientTop + 18;
    let index = 0;
    for (let ordinal = 0; ordinal < anchors.length; ordinal++) {
      if (anchors[ordinal].getBoundingClientRect().top <= threshold) index = ordinal;
      else break;
    }
    // The final prompt can be too close to the document end to align at the
    // viewport top; it is still the current round once the bottom is reached.
    if (viewport.scrollHeight > viewport.clientHeight
        && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 2) index = anchors.length - 1;
    setActive(index);
  }

  function updateTooltip() {
    const button = hovered || focused;
    const index = buttons.indexOf(button);
    for (const item of buttons) item.removeAttribute('aria-describedby');
    if (rail.hidden || index < 0 || !button.isConnected) { tooltip.hidden = true; return; }
    const bounds = list.getBoundingClientRect();
    const rect = button.getBoundingClientRect();
    if (rect.bottom <= bounds.top || rect.top >= bounds.bottom) { tooltip.hidden = true; return; }
    tooltipHeading.textContent = `第 ${index + 1} 轮`;
    tooltipPreview.textContent = previewFor(anchors[index]);
    button.setAttribute('aria-describedby', tooltip.id);
    tooltip.hidden = false;
    const railRect = rail.getBoundingClientRect();
    const height = tooltip.getBoundingClientRect().height;
    const top = Math.max(0, Math.min(rail.clientHeight - height, rect.top - railRect.top + rect.height / 2 - height / 2));
    ruleStyle()?.setProperty('--round-tooltip-top', `${Math.round(top)}px`);
  }

  function rebuild() {
    const next = [...messages.children].filter(isTaskPrompt);
    if (next.length === anchors.length && next.every((message, index) => message === anchors[index])) {
      buttons.forEach((button, index) => button.setAttribute('aria-label', `第 ${index + 1} 轮：${previewFor(anchors[index])}`));
      return;
    }
    const focusedAnchor = anchors[buttons.indexOf(document.activeElement)];
    hovered = null;
    focused = null;
    tooltip.hidden = true;
    anchors = next;
    buttons = next.map((message, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'round-navigator-tick';
      button.dataset.round = String(index + 1);
      button.tabIndex = -1;
      button.setAttribute('aria-label', `第 ${index + 1} 轮：${previewFor(message)}`);
      const mark = document.createElement('span');
      mark.setAttribute('aria-hidden', 'true');
      button.append(mark);
      return button;
    });
    list.replaceChildren(...buttons);
    active = -1;
    const retained = anchors.indexOf(focusedAnchor);
    if (retained >= 0) buttons[retained].focus({ preventScroll: true });
  }

  function render() {
    frame = 0;
    if (rebuildRequested) { rebuildRequested = false; rebuild(); }
    const style = ruleStyle();
    const visible = anchors.length > 0 && document.getElementById('welcome')?.hidden !== false
      && !viewport.classList.contains('usage-view-open') && viewport.clientHeight > 0 && !!style;
    rail.hidden = !visible;
    conversation.classList.toggle('has-round-navigator', visible);
    if (!visible) { tooltip.hidden = true; return; }
    const parentRect = conversation.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const top = viewportRect.top - parentRect.top - conversation.clientTop + viewport.clientTop;
    const left = viewportRect.left - parentRect.left - conversation.clientLeft + viewport.clientLeft;
    style.setProperty('--round-rail-top', `${Math.round(top)}px`);
    style.setProperty('--round-rail-left', `${Math.round(left)}px`);
    style.setProperty('--round-rail-height', `${viewport.clientHeight}px`);
    style.setProperty('--round-tooltip-width', `${Math.max(40, Math.min(280, viewport.clientWidth - 44))}px`);
    updateActive();
    updateTooltip();
  }

  function navigate(button) {
    const index = buttons.indexOf(button);
    const target = anchors[index];
    if (!target?.isConnected || rail.hidden) return;
    // The app handles this synchronously to suspend live output following and
    // cancel an in-progress disclosure reveal before this scroll is applied.
    document.dispatchEvent(new CustomEvent('forge:round-navigate', {
      detail: { round: index + 1, messageId: target.dataset.messageId || null },
    }));
    const bounds = viewport.getBoundingClientRect();
    const top = target.getBoundingClientRect().top - bounds.top - viewport.clientTop + viewport.scrollTop - 12;
    const behavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
    viewport.scrollTo({ top: Math.max(0, top), behavior });
    setActive(index);
    ensureTickVisible(button);
  }

  list.addEventListener('click', event => {
    const button = event.target.closest('.round-navigator-tick');
    if (button && list.contains(button)) navigate(button);
  });
  list.addEventListener('keydown', event => {
    const button = event.target.closest('.round-navigator-tick');
    const index = buttons.indexOf(button);
    if (index < 0) return;
    let next;
    if (event.key === 'ArrowUp') next = Math.max(0, index - 1);
    else if (event.key === 'ArrowDown') next = Math.min(buttons.length - 1, index + 1);
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else return;
    event.preventDefault();
    event.stopPropagation();
    buttons[next].focus({ preventScroll: true });
    navigate(buttons[next]);
  });
  list.addEventListener('pointerover', event => {
    const button = event.target.closest('.round-navigator-tick');
    if (buttons.includes(button)) { hovered = button; updateTooltip(); }
  });
  list.addEventListener('pointerout', event => {
    if (hovered && !hovered.contains(event.relatedTarget)) { hovered = null; updateTooltip(); }
  });
  list.addEventListener('focusin', event => {
    const button = event.target.closest('.round-navigator-tick');
    if (buttons.includes(button)) { focused = button; ensureTickVisible(button); updateTooltip(); }
  });
  list.addEventListener('focusout', () => { focused = null; updateTooltip(); });
  list.addEventListener('scroll', updateTooltip, { passive: true });
  viewport.addEventListener('scroll', () => schedule(), { passive: true });
  window.addEventListener('resize', () => schedule(), { passive: true });

  new MutationObserver(records => {
    // Assistant token streaming does not change round anchors. Avoid rebuilding
    // all ticks for every new token while still handling history replacement.
    const changed = records.some(record => record.target === messages
      || record.target.nodeType === Node.ELEMENT_NODE && record.target.closest('.message.user')
      || record.target.parentElement?.closest('.message.user'));
    if (changed) schedule(true);
  }).observe(messages, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'data-message-source', 'data-source'] });
  const visibility = new MutationObserver(() => schedule());
  visibility.observe(viewport, { attributes: true, attributeFilter: ['class', 'hidden'] });
  const welcome = document.getElementById('welcome');
  if (welcome) visibility.observe(welcome, { attributes: true, attributeFilter: ['hidden'] });
  const sizes = new ResizeObserver(() => schedule());
  sizes.observe(viewport);
  sizes.observe(conversation);
  sizes.observe(messages);
  schedule(true);
})();
