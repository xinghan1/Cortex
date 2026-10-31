(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ForgeSideChat = api;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  function create({ bridge, getWorkspaceId, notice, onOpen = () => {}, onLink = () => {} }) {
    const el = (tag, className, text) => {
      const node = document.createElement(tag); if (className) node.className = className;
      if (text) node.textContent = text; return node;
    };
    const panel = el('aside', 'side-chat-panel'); panel.id = 'side-chat-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', 'AI 临时问答');
    const resizer = el('div', 'side-chat-resizer'); resizer.id = 'side-chat-resizer';
    resizer.setAttribute('role', 'separator'); resizer.setAttribute('tabindex', '0');
    resizer.setAttribute('aria-label', '调整侧边问答宽度'); resizer.setAttribute('aria-orientation', 'vertical');
    resizer.title = '拖动调整宽度；左右键微调；双击恢复默认';
    const header = el('div', 'side-chat-header'), heading = el('div');
    const title = el('strong', '', '侧边问答'), model = el('button', 'text-button side-chat-model');
    model.type = 'button'; model.title = '配置侧边问答模型';
    model.addEventListener('click', () => window.synoraRoleModels?.open('sidebar'));
    heading.append(title, model);
    const closeButton = el('button', 'icon-button', '×'); closeButton.type = 'button';
    closeButton.id = 'side-chat-close'; closeButton.title = '收起侧边问答'; closeButton.setAttribute('aria-label', closeButton.title);
    header.append(heading, closeButton);
    const hint = el('p', 'side-chat-hint', '临时聊天 · 退出软件后删除'), messages = el('div', 'side-chat-messages');
    messages.id = 'side-chat-messages'; messages.setAttribute('aria-label', '临时问答记录');
    const form = el('form', 'side-chat-form'); form.id = 'side-chat-form';
    const quoteWrap = el('div', 'side-chat-quote-draft'); quoteWrap.hidden = true;
    const quoteText = el('blockquote'), removeQuote = el('button', 'icon-button small', '×');
    removeQuote.type = 'button'; removeQuote.setAttribute('aria-label', '移除引用'); quoteWrap.append(quoteText, removeQuote);
    const input = el('textarea'); input.id = 'side-chat-input'; input.rows = 3; input.maxLength = 20000;
    input.maxLength = 16000;
    input.placeholder = '针对这段内容提问…'; input.setAttribute('aria-label', '侧边问答问题');
    const error = el('p', 'form-error'); error.id = 'side-chat-error'; error.setAttribute('role', 'alert'); error.hidden = true;
    const actions = el('div', 'side-chat-actions'), keyboard = el('span', '', 'Enter 发送 · Shift+Enter 换行');
    const stop = el('button', 'button', '停止'); stop.id = 'side-chat-stop'; stop.type = 'button'; stop.hidden = true;
    const send = el('button', 'button solid', '发送'); send.id = 'side-chat-send'; send.type = 'submit';
    actions.append(keyboard, stop, send); form.append(quoteWrap, input, error, actions);
    panel.append(resizer, header, hint, messages, form);
    const layout = document.querySelector('.workspace-layout'); layout.append(panel);
    let preferredWidth = null, dragging = null;
    const limits = () => {
      const layoutWidth = layout.clientWidth || window.innerWidth || 1000;
      const sidebarWidth = document.querySelector('.sidebar')?.getBoundingClientRect?.().width || 0;
      return { min: 260, max: Math.max(260, Math.min(900, layoutWidth - sidebarWidth - 328)) };
    };
    const syncWidthAria = value => {
      const { min, max } = limits();
      resizer.setAttribute('aria-valuemin', String(min)); resizer.setAttribute('aria-valuemax', String(Math.round(max)));
      resizer.setAttribute('aria-valuenow', String(Math.round(value))); resizer.setAttribute('aria-valuetext', `${Math.round(value)} 像素`);
    };
    const setWidth = width => {
      const { min, max } = limits(); const value = Math.max(min, Math.min(max, width));
      const cssWidth = `${Math.round(value)}px`;
      if (document.documentElement.style?.getPropertyValue?.('--side-chat-width') !== cssWidth) document.documentElement.style?.setProperty('--side-chat-width', cssWidth);
      syncWidthAria(value);
      return value;
    };
    const currentWidth = () => panel.getBoundingClientRect?.().width || preferredWidth || 360;
    resizer.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      dragging = { id: event.pointerId, x: event.clientX, width: currentWidth() };
      resizer.setPointerCapture?.(event.pointerId); event.preventDefault();
    });
    resizer.addEventListener('pointermove', event => {
      if (!dragging || dragging.id !== event.pointerId) return;
      preferredWidth = setWidth(dragging.width + dragging.x - event.clientX);
    });
    const endDrag = event => { if (dragging?.id === event.pointerId) dragging = null; };
    resizer.addEventListener('pointerup', endDrag); resizer.addEventListener('pointercancel', endDrag);
    resizer.addEventListener('lostpointercapture', endDrag);
    resizer.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault(); preferredWidth = setWidth(currentWidth() + (event.key === 'ArrowLeft' ? 20 : -20));
    });
    resizer.addEventListener('dblclick', () => { preferredWidth = null; document.documentElement.style?.removeProperty('--side-chat-width'); syncWidthAria(currentWidth()); });
    window.addEventListener?.('resize', () => { if (preferredWidth !== null) setWidth(preferredWidth); });
    if (window.ResizeObserver) {
      const observer = new window.ResizeObserver(() => { if (preferredWidth !== null) setWidth(preferredWidth); else if (!panel.hidden) syncWidthAria(currentWidth()); });
      observer.observe(layout); const sidebar = document.querySelector('.sidebar'); if (sidebar) observer.observe(sidebar);
    }
    const trigger = el('button', 'icon-button side-chat-toggle'); trigger.type = 'button'; trigger.id = 'toggle-side-chat';
    trigger.title = '打开侧边临时问答'; trigger.setAttribute('aria-label', trigger.title); trigger.setAttribute('aria-expanded', 'false');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const iconPath = document.createElementNS('http://www.w3.org/2000/svg', 'path'); iconPath.setAttribute('d', 'M4 4h16v12H9l-5 4V4Zm4 5h8M8 12h5'); icon.append(iconPath); trigger.append(icon);
    document.querySelector('.conversation-controls').prepend(trigger);
    let state = { open: false, running: false, revision: -1, messages: [] }, workspaceId = null;
    let quote = '', pending = false, pendingRequest = null, generation = 0, collapsed = false;
    let previousRendered = new Map();
    const clearQuote = () => { quote = ''; quoteText.textContent = ''; quoteWrap.hidden = true; };
    const show = open => {
      panel.hidden = !open; document.documentElement.classList.toggle('side-chat-open', open);
      trigger.setAttribute('aria-expanded', String(open));
      if (open) syncWidthAria(currentWidth());
    };
    function render() {
      show(state.open);
      const follow = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60;
      const fragment = document.createDocumentFragment();
      const nextRendered = new Map();
      for (const message of state.messages || []) {
        const item = el('article', `side-chat-message ${message.role}`); item.dataset.messageId = message.id;
        item.append(el('div', 'side-chat-message-label', message.role === 'user' ? '你' : 'Cortex'));
        if (message.quote) item.append(el('blockquote', 'side-chat-quoted', message.quote));
        const content = el('div', 'side-chat-content');
        if (message.role === 'assistant' && message.content && window.ForgeMarkdown) window.ForgeMarkdown.renderMarkdown(content, message.content, {
          onLink, onCopy: text => bridge.copyText({ text }), onCopyError: cause => notice?.(cause.message, true),
        });
        else content.textContent = message.content || (state.running ? '正在思考…' : '');
        if (message.role === 'assistant' && window.CortexTextReveal) {
          const current = message.content ? window.CortexTextReveal.visibleText(content) : '';
          const previous = previousRendered.get(message.id);
          if (previous !== undefined && previous !== current) window.CortexTextReveal.animateNewText(content, previous);
          nextRendered.set(message.id, current);
        }
        item.append(content);
        if (message.status === 'stopped') item.append(el('small', 'side-chat-message-status', '已停止'));
        fragment.append(item);
      }
      messages.replaceChildren(fragment);
      previousRendered = nextRendered;
      if (follow) messages.scrollTop = messages.scrollHeight;
      error.textContent = state.error || ''; error.hidden = !state.error;
      stop.hidden = !state.running; send.hidden = state.running;
      input.disabled = pending; send.disabled = pending || !input.value.trim();
    }
    function apply(next, id = getWorkspaceId()) {
      if (id !== getWorkspaceId()) return;
      if (workspaceId !== id) {
        workspaceId = id; state = { open: false, running: false, revision: -1, messages: [] };
        clearQuote(); input.value = ''; pending = false; pendingRequest = null; collapsed = false; previousRendered.clear(); generation++;
      }
      if (!next || Number(next.revision) < Number(state.revision)) return;
      state = collapsed ? { ...next, open: false } : next; render();
    }
    async function open(selected) {
      const id = getWorkspaceId(), token = ++generation;
      collapsed = false;
      onOpen();
      try {
        const next = await bridge.sideChatOpen();
        if (id !== getWorkspaceId() || token !== generation) return;
        apply(next, id);
        if (typeof selected === 'string' && selected.trim()) {
          quote = selected.slice(0, 20000); quoteText.textContent = quote; quoteWrap.hidden = false;
        }
        input.focus();
      } catch (cause) { if (id === getWorkspaceId() && token === generation) notice?.(cause.message, true); }
    }
    async function close() {
      const id = getWorkspaceId(), token = ++generation;
      if (pendingRequest) pendingRequest.preserveDraft = true;
      collapsed = true;
      state = { ...state, open: false }; render(); trigger.focus();
      try {
        const next = await bridge.sideChatClose();
        if (id === getWorkspaceId() && token === generation) apply(next, id);
      } catch (cause) { if (id === getWorkspaceId() && token === generation) notice?.(cause.message, true); }
    }
    async function submit(event) {
      event.preventDefault(); if (pending || state.running || !input.value.trim()) return;
      const id = getWorkspaceId(), text = input.value, selected = quote, request = {};
      ++generation; pendingRequest = request; pending = true; render();
      const current = () => id === getWorkspaceId() && pendingRequest === request;
      try {
        const next = await bridge.sideChatSend({ text, ...(selected ? { quote: selected } : {}) });
        if (!current()) return;
        if (!request.preserveDraft && input.value === text) input.value = '';
        if (!request.preserveDraft && quote === selected) clearQuote();
        apply(next, id);
      } catch (cause) { if (current()) { state = { ...state, error: cause.message }; render(); } }
      finally {
        if (current()) {
          pending = false; pendingRequest = null; render();
          if (state.open && !request.preserveDraft) input.focus();
        }
      }
    }
    form.addEventListener('submit', submit);
    input.addEventListener('input', () => { send.disabled = pending || !input.value.trim(); });
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void submit(event); } });
    removeQuote.addEventListener('click', clearQuote); closeButton.addEventListener('click', close);
    trigger.addEventListener('click', () => state.open ? close() : open());
    stop.addEventListener('click', async () => {
      const id = getWorkspaceId(); try { apply(await bridge.sideChatStop(), id); } catch (cause) { notice?.(cause.message, true); }
    });
    return { open, close, toggle: () => state.open ? close() : open(), apply,
      update(appState) {
        apply(appState.sideChat, appState.workspaceId);
        const config = appState.roleModels?.sidebar;
        model.textContent = `${config?.enabled ? '独立模型' : '跟随当前模型'} · ${config?.effective?.model || appState.settings?.model || '未选择'}`;
      },
    };
  }
  return Object.freeze({ create });
});
