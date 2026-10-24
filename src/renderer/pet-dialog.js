(function (root) {
  'use strict';
  const boundedText = (value, limit = 4000) => typeof value === 'string' ? value.slice(0, limit) : '';
  function create({ document = root.document, bridge = root.forge } = {}) {
    const view = document.defaultView || root, composer = document.querySelector('.composer-area');
    const taskForm = document.getElementById('task-form'), draft = document.getElementById('task-input');
    const make = (tag, id, className, text) => {
      const node = document.createElement(tag); if (id) node.id = id; if (className) node.className = className;
      if (text !== undefined) node.textContent = text; return node;
    };
    const panel = make('aside', 'pet-dialog', 'pet-dialog'); panel.hidden = true;
    const launcher = make('button', 'pet-dialog-launcher', 'pet-dialog-launcher', '和宠物聊天'); launcher.type = 'button';
    launcher.setAttribute('aria-label', '和宠物聊天'); launcher.setAttribute('aria-controls', 'pet-dialog');
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', '宠物问答');
    const header = make('div', '', 'pet-dialog-header');
    const toggle = make('button', 'pet-dialog-toggle', 'pet-dialog-toggle', '宠物问答'); toggle.type = 'button';
    const close = make('button', 'pet-dialog-close', 'pet-dialog-close', '×'); close.type = 'button';
    const details = make('div', 'pet-dialog-details', 'pet-dialog-details');
    const content = make('div', '', 'pet-dialog-content');
    const history = make('div', 'pet-dialog-messages', 'pet-dialog-messages');
    const question = make('p', 'pet-dialog-question', 'pet-dialog-question'); question.setAttribute('aria-live', 'polite');
    const options = make('div', 'pet-dialog-options', 'pet-dialog-options'); options.setAttribute('role', 'group'); options.setAttribute('aria-label', '回答选项');
    const form = make('form', 'pet-dialog-form', 'pet-dialog-form');
    const label = make('label', '', 'sr-only', '输入你的答复'); label.htmlFor = 'pet-dialog-input';
    const input = make('textarea', 'pet-dialog-input', 'pet-dialog-input'); input.rows = 2; input.maxLength = 4000;
    input.placeholder = '也可以输入你的答复…'; input.setAttribute('aria-describedby', 'pet-dialog-status pet-dialog-error');
    const error = make('p', 'pet-dialog-error', 'pet-dialog-error'); error.hidden = true; error.setAttribute('role', 'status');
    const status = make('span', 'pet-dialog-status', 'pet-dialog-status'); status.setAttribute('role', 'status');
    const footer = make('div', '', 'pet-dialog-actions');
    const cancel = make('button', 'pet-dialog-cancel', 'pet-dialog-button', '取消提问'); cancel.type = 'button';
    const stop = make('button', 'pet-dialog-stop', 'pet-dialog-button', '停止任务'); stop.type = 'button';
    const send = make('button', 'pet-dialog-send', 'pet-dialog-button pet-dialog-send', '回答'); send.type = 'submit';
    header.append(toggle, close); content.append(history, question, options); footer.append(status, cancel, stop, send);
    form.append(label, input, error, footer); details.append(content, form); panel.append(header, details); document.body.append(panel, launcher);
    let disposed = false, context = null, contextVersion = 0, stateVersion = 0, actionVersion = 0, frame = 0;
    let snapshot = { revision: -1, question: null, messages: [], running: false, error: null };
    let busy = false, stopBusy = false, composing = false, draftComposing = false, expanded = false, selected = null, chatOpened = false, muted = false;
    let anchor = null, anchorObserver = null, savedFocus = null;
    const listeners = [], contextKey = value => JSON.stringify([value?.workspaceId || '', value?.sessionId || '']);
    const listen = (node, type, callback, capture) => { node?.addEventListener(type, callback, capture); listeners.push(() => node?.removeEventListener(type, callback, capture)); };
    const hasDraft = () => Boolean(draft?.value?.trim() || document.getElementById('attachment-drafts')?.children.length);
    const activeQuestion = () => snapshot.question;
    const sameContext = value => context && contextKey(value) === contextKey(context);
    const setStyle = (name, value) => { if (panel.style[name] !== value) panel.style[name] = value; };
    function schedule() {
      if (disposed || frame) return;
      frame = view.requestAnimationFrame(() => { frame = 0; layout(); });
    }
    function findAnchor() {
      const next = document.getElementById('pet-overlay');
      if (next === anchor) return;
      anchorObserver?.disconnect(); if (anchor) resizeObserver?.unobserve(anchor); anchor = next;
      if (anchor && view.MutationObserver) {
        anchorObserver = new view.MutationObserver(schedule);
        anchorObserver.observe(anchor, { attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
      }
      resizeObserver?.observe(anchor || panel); schedule();
    }
    function rememberFocus() {
      if (savedFocus || !taskForm?.contains(document.activeElement)) return;
      savedFocus = { context: contextKey(context), node: document.activeElement, value: draft?.value,
        start: draft?.selectionStart, end: draft?.selectionEnd };
    }
    function restoreFocus() {
      const saved = savedFocus; savedFocus = null;
      if (!saved || saved.context !== contextKey(context) || !(panel.contains(document.activeElement) || document.activeElement === document.body)) return;
      if (!saved.node?.isConnected || saved.node.disabled || saved.node.closest?.('[hidden]')) return;
      saved.node.focus({ preventScroll: true });
      if (saved.node === draft && draft.value === saved.value && Number.isInteger(saved.start)) draft.setSelectionRange(saved.start, saved.end);
    }
    function layout() {
      if (disposed) return;
      findAnchor();
      const bounds = anchor?.getBoundingClientRect(), style = anchor && view.getComputedStyle(anchor);
      const visiblePet = anchor && !anchor.hidden && bounds?.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      const fallback = !visiblePet, blocking = activeQuestion()?.blocking === true;
      launcher.hidden = blocking; launcher.disabled = !context;
      launcher.setAttribute('aria-expanded', String(!panel.hidden)); launcher.dataset.mode = fallback ? 'composer' : 'bubble';
      const launchParent = fallback ? document.querySelector('.composer-context') || composer || document.body : document.body;
      if (launcher.parentElement !== launchParent) launchParent.append(launcher);
      if (visiblePet) {
        launcher.style.left = `${Math.max(8, Math.min(view.innerWidth - launcher.offsetWidth - 8, bounds.right - launcher.offsetWidth))}px`;
        launcher.style.top = `${Math.max(48, Math.min(view.innerHeight - 36, bounds.top + bounds.height * .35))}px`;
      } else { launcher.style.left = ''; launcher.style.top = ''; }
      const replaces = !panel.hidden && fallback && blocking && !draftComposing;
      if (replaces) rememberFocus();
      document.documentElement.classList.toggle('pet-dialog-replaces-composer', replaces);
      if (!replaces && savedFocus) restoreFocus();
      if (panel.hidden) return;
      const parent = fallback && composer ? composer : document.body;
      if (composing && panel.parentElement !== parent) return;
      if (panel.parentElement !== parent) {
        const focused = panel.contains(document.activeElement), start = input.selectionStart, end = input.selectionEnd;
        if (parent === composer && taskForm) parent.insertBefore(panel, taskForm); else parent.append(panel);
        if (focused) { input.focus({ preventScroll: true }); if (Number.isInteger(start)) input.setSelectionRange(start, end); }
      }
      panel.dataset.mode = fallback ? 'composer' : 'bubble';
      panel.dataset.blocking = String(blocking);
      if (fallback) { setStyle('left', ''); setStyle('top', ''); setStyle('width', ''); return; }
      const width = Math.max(1, Math.min(340, view.innerWidth - 16)); setStyle('width', `${width}px`);
      const height = panel.getBoundingClientRect().height, maxTop = Math.max(48, view.innerHeight - height - 8);
      const left = Math.max(8, Math.min(view.innerWidth - width - 8, bounds.right - width));
      let top = bounds.top - height - 8;
      if (top < 48) top = Math.max(48, Math.min(maxTop, bounds.top + (bounds.height - height) / 2));
      setStyle('left', `${left}px`); setStyle('top', `${Math.max(48, Math.min(maxTop, top))}px`);
    }
    function render() {
      const current = activeQuestion(), blocking = current?.blocking === true;
      panel.hidden = !current && !chatOpened;
      const collapsed = Boolean(!blocking && !expanded && (hasDraft() || muted));
      details.hidden = collapsed; panel.dataset.collapsed = String(collapsed);
      toggle.textContent = blocking ? '需要你的答复' : collapsed ? '宠物有话要说' : '和宠物聊一聊';
      toggle.setAttribute('aria-expanded', String(!collapsed)); toggle.setAttribute('aria-controls', 'pet-dialog-details');
      close.hidden = blocking; close.setAttribute('aria-label', '忽略宠物消息');
      question.textContent = boundedText(current?.question); question.hidden = !question.textContent;
      const previousScroll = content.scrollTop, stickToBottom = content.scrollHeight - content.clientHeight - previousScroll < 24;
      history.replaceChildren(); history.hidden = blocking;
      if (!blocking) for (const message of (snapshot.messages || []).slice(-8)) {
        if (!['user', 'assistant'].includes(message?.role) || typeof message.content !== 'string' || message.content === current?.question) continue;
        const row = make('p', '', `pet-dialog-message ${message.role}`, boundedText(message.content)); history.append(row);
      }
      options.replaceChildren();
      for (const [index, choice] of (current?.options || []).entries()) {
        const button = make('button', '', 'pet-dialog-choice', boundedText(choice, 160)); button.type = 'button';
        button.dataset.choiceIndex = String(index); button.disabled = busy || snapshot.running && !blocking;
        button.setAttribute('aria-pressed', String(selected === index));
        button.addEventListener('click', () => { selected = index; void answer({ choiceIndex: index }); }); options.append(button);
      }
      form.hidden = !current && !chatOpened; input.disabled = busy || Boolean(snapshot.running && !blocking);
      send.disabled = input.disabled; cancel.disabled = busy; cancel.textContent = blocking ? '取消提问' : '忽略';
      send.textContent = blocking ? '回答' : '发送';
      stop.hidden = !blocking; stop.disabled = stopBusy;
      status.textContent = busy ? '发送中…' : snapshot.running ? '正在回复…' : blocking ? '等待你的答复' : '';
      const failure = boundedText(snapshot.error?.message || snapshot.error, 1000);
      if (!error.textContent && failure) { error.textContent = failure; error.hidden = false; }
      if (stickToBottom) content.scrollTop = content.scrollHeight; else content.scrollTop = previousScroll;
      layout();
    }
    function update(value) {
      if (disposed || !value || !sameContext(value)) return;
      const next = value.petDialog || value;
      if (!Number.isSafeInteger(next.revision) || next.revision < snapshot.revision) return;
      if (snapshot.question?.blocking && next.question && !next.question.blocking && next.question.id !== snapshot.question.id) return;
      const different = snapshot.question?.id !== next.question?.id;
      if (different) { ++actionVersion; busy = false; selected = null; if (!chatOpened) expanded = false; input.value = ''; error.textContent = ''; error.hidden = true; }
      snapshot = { revision: next.revision, question: next.question ? { ...next.question,
        options: Array.isArray(next.question.options) ? next.question.options.filter(choice => typeof choice === 'string').slice(0, 8) : [] } : null,
        messages: Array.isArray(next.messages) ? next.messages : [], running: next.running === true, error: next.error || null };
      render();
    }
    async function refresh(version = contextVersion) {
      try { const next = await bridge.getPetDialog(); if (!disposed && version === contextVersion) update(next); }
      catch { /* A later scoped state event can restore the temporary dialogue. */ }
    }
    function updateContext(state) {
      if (disposed || !state || typeof state.workspaceId !== 'string') return;
      ++stateVersion;
      if (context && contextKey(state) === contextKey(context)) { schedule(); return; }
      ++contextVersion; ++actionVersion; context = { workspaceId: state.workspaceId, sessionId: state.sessionId ?? null };
      savedFocus = null; busy = false; chatOpened = false; muted = false; expanded = false;
      snapshot = { revision: -1, question: null, messages: [], running: false, error: null };
      input.value = ''; error.textContent = ''; error.hidden = true; render(); return refresh();
    }
    async function act(method, payload) {
      const current = activeQuestion(); if (!context || (!current && method !== 'sendPetChat') || busy || disposed) return;
      const version = ++actionVersion, origin = contextVersion;
      busy = true; error.textContent = ''; error.hidden = true; render();
      try {
        const next = await bridge[method]({ ...context, ...(method === 'sendPetChat' ? {} : { id: current.id }), ...payload });
        if (disposed || version !== actionVersion || origin !== contextVersion) return;
        if (next && sameContext(next)) update(next); else await refresh(origin);
      } catch (failure) {
        if (disposed || version !== actionVersion || origin !== contextVersion) return;
        error.textContent = boundedText(failure?.message, 1000) || '答复未能发送，请重试。'; error.hidden = false;
      } finally { if (!disposed && version === actionVersion && origin === contextVersion) { busy = false; render(); } }
    }
    async function answer(payload = {}) {
      let method = 'answerPetDialog';
      if (payload.choiceIndex === undefined) {
        const text = input.value.trim();
        if (!text || text.length > 4000) { error.textContent = '请输入 1 至 4,000 字的答复。'; error.hidden = false; input.focus(); return; }
        payload = { text };
        if (!activeQuestion()?.blocking) { method = 'sendPetChat'; chatOpened = true; expanded = true; muted = false; }
      }
      await act(method, payload);
    }
    const dismiss = () => {
      chatOpened = false; muted = true; expanded = false;
      if (activeQuestion()) return act('dismissPetDialog', {});
      render(); return Promise.resolve();
    };
    listen(form, 'submit', event => { event.preventDefault(); if (!composing) void answer(); });
    listen(input, 'input', () => { selected = null; error.textContent = ''; error.hidden = true; });
    listen(input, 'compositionstart', () => { composing = true; });
    listen(input, 'compositionend', () => { composing = false; schedule(); });
    listen(input, 'keydown', event => {
      if (composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void answer(); }
    });
    listen(panel, 'keydown', event => { if (event.key === 'Escape' && !composing && !event.isComposing) { event.preventDefault(); event.stopPropagation(); void dismiss(); } });
    listen(close, 'click', () => void dismiss()); listen(cancel, 'click', () => void dismiss());
    listen(toggle, 'click', () => { if (!activeQuestion()?.blocking) { expanded = !expanded; render(); } });
    listen(launcher, 'click', () => { chatOpened = true; muted = false; expanded = true; render(); input.focus({ preventScroll: true }); });
    listen(stop, 'click', async () => {
      if (stopBusy) return; stopBusy = true; render();
      try { await bridge.stopTask(); }
      catch { if (!disposed) { error.textContent = '停止任务失败，请重试。'; error.hidden = false; } }
      finally { stopBusy = false; if (!disposed) render(); }
    });
    listen(draft, 'input', () => { if (!activeQuestion()?.blocking) render(); });
    listen(draft, 'compositionstart', () => { draftComposing = true; schedule(); });
    listen(draft, 'compositionend', () => { draftComposing = false; schedule(); });
    listen(view, 'resize', schedule);
    const resizeObserver = view.ResizeObserver ? new view.ResizeObserver(schedule) : null;
    resizeObserver?.observe(panel); if (composer) resizeObserver?.observe(composer);
    const bodyObserver = view.MutationObserver ? new view.MutationObserver(findAnchor) : null;
    bodyObserver?.observe(document.body, { childList: true, subtree: true }); findAnchor();
    const unsubscribe = bridge.onEvent?.(event => {
      if (event?.type === 'pet-dialog') update(event);
      else if (['state', 'workspace-activated'].includes(event?.type)) updateContext(event.state);
      else if (event?.type === 'pet-state') schedule();
    });
    const initialVersion = stateVersion;
    const ready = Promise.resolve(bridge.getState()).then(value => { if (!disposed && initialVersion === stateVersion) return updateContext(value); }).catch(() => {});
    function destroy() {
      if (disposed) return;
      document.documentElement.classList.remove('pet-dialog-replaces-composer'); restoreFocus(); disposed = true; ++actionVersion;
      if (frame) view.cancelAnimationFrame(frame); frame = 0;
      resizeObserver?.disconnect(); bodyObserver?.disconnect(); anchorObserver?.disconnect();
      for (const remove of listeners) remove(); if (typeof unsubscribe === 'function') unsubscribe(); panel.remove(); launcher.remove();
    }
    return Object.freeze({ ready, update, updateContext, refresh, destroy });
  }
  root.ForgePetDialog = Object.freeze({ create });
  if (root.document && root.forge?.getPetDialog && !root.document.getElementById('pet-dialog')) root.synoraPetDialog = create();
})(window);
