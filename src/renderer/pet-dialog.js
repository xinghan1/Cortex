(function (root) {
  'use strict';
  const boundedText = (value, limit = 4000) => typeof value === 'string' ? value.slice(0, limit) : '';
  const durationForText = text => Math.min(10000, 5000 + Array.from(String(text)).length * 80);
  const welcomedDocuments = new WeakSet();
  function contentAnchor(bounds, packId) {
    if (packId !== 'dsh-pet') return bounds;
    // Approximate the bundled 640×360 clips' stable character envelope. Other
    // packs retain the full box because their transparent margins are unknown.
    const scale = Math.min(bounds.width / 640, bounds.height / 360);
    const left = bounds.left + (bounds.width - 640 * scale) / 2 + 204 * scale;
    const top = bounds.top + (bounds.height - 360 * scale) / 2 + 40 * scale;
    const width = 220 * scale, height = 300 * scale;
    return { left, top, width, height, right: left + width, bottom: top + height };
  }
  const actionLines = Object.freeze({ clicks: '嘿嘿，摸摸头，干活更有劲啦！', drag: '搬家咯！这里的风景也不错。',
    turn: '转个身，换个角度看看。', actions: '小手准备好啦，陪你一起敲键盘。', thinking: '让我歪歪脑袋，想一想。',
    working: '认真模式开启，我就在这儿陪着你。', result: '探出脑袋，看看你在忙什么。', waiting: '我先乖乖坐好，等你呀。',
    success: '开心地转个圈，送你一朵小红花！', error: '皱皱眉，再拍拍小脑袋。' });
  function create({ document = root.document, bridge = root.forge } = {}) {
    const view = document.defaultView || root, composer = document.querySelector('.composer-area');
    const taskForm = document.getElementById('task-form'), draft = document.getElementById('task-input');
    const make = (tag, id, className, text) => {
      const node = document.createElement(tag); if (id) node.id = id; if (className) node.className = className;
      if (text !== undefined) node.textContent = text; return node;
    };
    const panel = make('aside', 'pet-dialog', 'pet-speech-bubble'); panel.hidden = true;
    panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', '大肥鱼说');
    const question = make('p', 'pet-dialog-question', 'pet-dialog-question'); question.setAttribute('aria-live', 'polite');
    const options = make('div', 'pet-dialog-options', 'pet-dialog-options'); options.setAttribute('role', 'group'); options.setAttribute('aria-label', '回答选项');
    const speechActions = make('div', '', 'pet-dialog-actions');
    const cancel = make('button', 'pet-dialog-cancel', 'pet-dialog-button', '取消提问'); cancel.type = 'button';
    const stop = make('button', 'pet-dialog-stop', 'pet-dialog-button', '停止任务'); stop.type = 'button';
    speechActions.append(cancel, stop); panel.append(question, options, speechActions);
    const inputBubble = make('div', 'pet-dialog-input-bubble', 'pet-input-bubble'); inputBubble.hidden = true;
    const form = make('form', 'pet-dialog-form', 'pet-dialog-form');
    const label = make('label', '', 'sr-only', '和大肥鱼聊天'); label.htmlFor = 'pet-dialog-input';
    const input = make('textarea', 'pet-dialog-input', 'pet-dialog-input'); input.rows = 2; input.maxLength = 4000;
    input.placeholder = '和大肥鱼说点什么…'; input.setAttribute('aria-describedby', 'pet-dialog-status pet-dialog-error');
    const error = make('p', 'pet-dialog-error', 'pet-dialog-error'); error.hidden = true; error.setAttribute('role', 'status');
    const status = make('span', 'pet-dialog-status', 'pet-dialog-status'); status.setAttribute('role', 'status');
    const footer = make('div', '', 'pet-dialog-actions');
    const close = make('button', 'pet-dialog-close', 'pet-dialog-button', '收起'); close.type = 'button'; close.setAttribute('aria-label', '收起聊天输入气泡');
    const send = make('button', 'pet-dialog-send', 'pet-dialog-button pet-dialog-send', '发送'); send.type = 'submit';
    footer.append(status, close, send); form.append(label, input, error, footer); inputBubble.append(form);
    const launcher = make('button', 'pet-dialog-launcher', 'pet-dialog-launcher', '和大肥鱼聊天'); launcher.type = 'button';
    launcher.setAttribute('aria-label', '和大肥鱼聊天'); launcher.setAttribute('aria-controls', 'pet-dialog-input-bubble');
    document.body.append(panel, inputBubble, launcher);
    let disposed = false, context = null, contextVersion = 0, stateVersion = 0, actionVersion = 0, frame = 0, initialized = false;
    let snapshot = { revision: -1, question: null, running: false, error: null };
    let busy = false, stopBusy = false, composing = false, draftComposing = false, selected = null, chatOpened = false, muted = false;
    let anchor = null, anchorObserver = null, savedFocus = null, speech = null, lastQuestionId = null, lastActionSequence = -1, pendingAction = null;
    let inputPhaseTimer = 0, inputOpen = false, reservation = '', lastActionAt = -Infinity, fallbackLatched = false, reservedOpen = false;
    const speechQueue = [], timers = new Set(), listeners = [];
    const contextKey = value => JSON.stringify([value?.workspaceId || '', value?.sessionId || '']);
    const listen = (node, type, callback) => { node?.addEventListener(type, callback); listeners.push(() => node?.removeEventListener(type, callback)); };
    const later = (callback, ms) => { const id = view.setTimeout(() => { timers.delete(id); callback(); }, ms); timers.add(id); return id; };
    const clearTimer = id => { if (id) { view.clearTimeout(id); timers.delete(id); } };
    const clearTimers = () => { for (const id of timers) view.clearTimeout(id); timers.clear(); inputPhaseTimer = 0; };
    const activeQuestion = () => snapshot.question, blocking = () => activeQuestion()?.blocking === true;
    const sameContext = value => context && contextKey(value) === contextKey(context);
    const setStyle = (node, name, value) => { if (node.style[name] !== value) node.style[name] = value; };
    const layoutHeight = node => node.offsetHeight || node.getBoundingClientRect().height;
    const now = () => view.performance?.now?.() ?? Date.now();
    function reserve(open, height = 0) {
      const next = JSON.stringify([open, height]); if (next === reservation) return; reservation = next; reservedOpen = open;
      if (view.CustomEvent) view.dispatchEvent(new view.CustomEvent('synora:pet-chat-layout', { detail: { open, height } }));
    }
    function schedule() {
      if (disposed || frame) return;
      frame = view.requestAnimationFrame(() => { frame = 0; layout(); });
    }
    function clearSpeech() {
      if (speech) for (const id of speech.timers) clearTimer(id);
      speech = null; panel.hidden = true; question.textContent = ''; options.replaceChildren();
    }
    function showSpeech(text, { persistent = false, local = false, id = null } = {}) {
      clearSpeech(); if (!text || disposed) return;
      const record = { text: boundedText(text), persistent, local, id, timers: [] }; speech = record;
      question.textContent = record.text; panel.hidden = false; panel.dataset.phase = 'entering';
      panel.dataset.duration = persistent ? '' : String(durationForText(record.text)); panel.dataset.startedAt = String(now());
      panel.dataset.blocking = String(persistent); schedule();
      record.timers.push(later(() => { if (speech === record) panel.dataset.phase = 'visible'; }, 500));
      if (!persistent) {
        const duration = durationForText(record.text);
        record.timers.push(later(() => { if (speech === record) panel.dataset.phase = 'leaving'; }, duration - 500));
        record.timers.push(later(() => {
          if (speech !== record) return;
          clearSpeech(); const next = speechQueue.shift(); if (next) showSpeech(next.text, next); render();
        }, duration));
      }
    }
    function enqueueSpeech(text, info = {}) {
      if (!text || blocking()) return;
      if (!speech) { showSpeech(text, info); return; }
      if (speech.text === text || speechQueue.some(entry => entry.text === text)) return;
      const entry = { text, ...info };
      if (!info.local) {
        // Keep only the latest queued model response; completed history remains in the backend.
        for (let index = speechQueue.length - 1; index >= 0; index--) if (!speechQueue[index].local) speechQueue.splice(index, 1);
        speechQueue.unshift(entry);
      } else speechQueue.push(entry);
      if (speechQueue.length > 4) speechQueue.pop();
    }
    function findAnchor() {
      const next = document.getElementById('pet-overlay'); if (next === anchor) return;
      anchorObserver?.disconnect(); if (anchor) resizeObserver?.unobserve(anchor); anchor = next;
      if (anchor && view.MutationObserver) { anchorObserver = new view.MutationObserver(schedule); anchorObserver.observe(anchor, { attributes: true, attributeFilter: ['hidden', 'style', 'class', 'data-pack-id'] }); }
      if (anchor) resizeObserver?.observe(anchor); schedule();
    }
    function rememberFocus() {
      if (savedFocus || !taskForm?.contains(document.activeElement)) return;
      savedFocus = { context: contextKey(context), node: document.activeElement, value: draft?.value, start: draft?.selectionStart, end: draft?.selectionEnd };
    }
    function restoreFocus() {
      const saved = savedFocus; savedFocus = null;
      if (!saved || saved.context !== contextKey(context) || !(inputBubble.contains(document.activeElement) || panel.contains(document.activeElement) || document.activeElement === document.body)) return;
      if (!saved.node?.isConnected || saved.node.disabled || saved.node.closest?.('[hidden]')) return;
      saved.node.focus({ preventScroll: true });
      if (saved.node === draft && draft.value === saved.value && Number.isInteger(saved.start)) draft.setSelectionRange(saved.start, saved.end);
    }
    function place(node, parent) {
      if (node.parentElement === parent || composing && node === inputBubble) return;
      const focused = node.contains(document.activeElement), start = input.selectionStart, end = input.selectionEnd;
      if (parent === composer && taskForm) parent.insertBefore(node, taskForm); else parent.append(node);
      if (focused) { input.focus({ preventScroll: true }); if (Number.isInteger(start)) input.setSelectionRange(start, end); }
    }
    function layout() {
      if (disposed) return;
      findAnchor();
      const bounds = anchor?.getBoundingClientRect(), style = anchor && view.getComputedStyle(anchor);
      const naturallyVisible = anchor && !anchor.hidden && bounds?.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      if (inputOpen && reservedOpen && !naturallyVisible) fallbackLatched = true;
      const visiblePet = naturallyVisible && !fallbackLatched;
      const fallback = !visiblePet, isBlocking = blocking();
      if (fallback && speech?.local) {
        clearSpeech();
        for (let index = speechQueue.length - 1; index >= 0; index--) if (speechQueue[index].local) speechQueue.splice(index, 1);
        const next = speechQueue.shift(); if (next) showSpeech(next.text, next);
      }
      if (visiblePet && initialized && context && !isBlocking && !speech && !snapshot.question && !welcomedDocuments.has(document)) {
        welcomedDocuments.add(document); showSpeech('Hello！我是大肥鱼，今天你要做些什么呢？', { local: true });
      }
      launcher.hidden = isBlocking || inputOpen; launcher.disabled = !context;
      launcher.setAttribute('aria-expanded', String(inputOpen)); launcher.dataset.mode = fallback ? 'composer' : 'bubble';
      const launchParent = fallback ? document.querySelector('.composer-context') || composer || document.body : document.body;
      if (launcher.parentElement !== launchParent) launchParent.append(launcher);
      if (visiblePet) {
        setStyle(launcher, 'left', `${Math.max(8, Math.min(view.innerWidth - launcher.offsetWidth - 8, bounds.right - launcher.offsetWidth))}px`);
        setStyle(launcher, 'top', `${Math.max(48, Math.min(view.innerHeight - 36, bounds.top + bounds.height * .35))}px`);
      } else { setStyle(launcher, 'left', ''); setStyle(launcher, 'top', ''); }
      const replaces = fallback && isBlocking && !draftComposing;
      if (replaces) rememberFocus();
      document.documentElement.classList.toggle('pet-dialog-replaces-composer', replaces);
      if (!replaces && savedFocus) restoreFocus();
      const parent = fallback && composer ? composer : document.body;
      place(panel, parent); place(inputBubble, parent);
      for (const node of [panel, inputBubble]) { node.dataset.mode = fallback ? 'composer' : 'bubble'; node.dataset.blocking = String(isBlocking); }
      const width = Math.max(1, Math.min(316, view.innerWidth - 16));
      if (!fallback) for (const node of [panel, inputBubble]) setStyle(node, 'width', `${width}px`);
      reserve(Boolean(visiblePet && !inputBubble.hidden), visiblePet && !inputBubble.hidden ? Math.ceil(layoutHeight(inputBubble)) + 8 : 0);
      if (fallback) {
        for (const node of [panel, inputBubble]) for (const name of ['left', 'top', 'width']) setStyle(node, name, '');
        return;
      }
      const character = contentAnchor(bounds, anchor.dataset.packId);
      for (const node of [panel, inputBubble]) node.dataset.anchor = anchor.dataset.packId === 'dsh-pet' ? 'character' : 'box';
      const speechHeight = layoutHeight(panel), inputHeight = layoutHeight(inputBubble);
      const speechLeft = Math.max(8, Math.min(view.innerWidth - width - 8, character.left + character.width * .6 - width));
      const inputLeft = Math.max(8, Math.min(view.innerWidth - width - 8, character.left + (character.width - width) / 2));
      setStyle(panel, 'left', `${speechLeft}px`);
      setStyle(panel, 'top', `${Math.max(48, Math.min(view.innerHeight - speechHeight - 8, character.top - speechHeight - 10))}px`);
      setStyle(inputBubble, 'left', `${inputLeft}px`);
      setStyle(inputBubble, 'top', `${Math.max(48, Math.min(view.innerHeight - inputHeight - 8, character.bottom + 8))}px`);
    }
    function renderInput(nextOpen) {
      if (nextOpen === inputOpen) return;
      inputOpen = nextOpen; clearTimer(inputPhaseTimer);
      if (!nextOpen) fallbackLatched = false;
      if (nextOpen) {
        inputBubble.hidden = false; inputBubble.dataset.phase = 'entering';
        inputPhaseTimer = later(() => { inputBubble.dataset.phase = 'visible'; }, 500);
      } else if (!inputBubble.hidden) {
        inputBubble.dataset.phase = 'leaving';
        inputPhaseTimer = later(() => { inputBubble.hidden = true; schedule(); }, 500);
      }
    }
    function render() {
      const current = activeQuestion(), isBlocking = blocking();
      renderInput(isBlocking || chatOpened); options.replaceChildren();
      if (isBlocking) for (const [index, choice] of (current.options || []).entries()) {
        const button = make('button', '', 'pet-dialog-choice', boundedText(choice, 160)); button.type = 'button';
        button.dataset.choiceIndex = String(index); button.disabled = busy; button.setAttribute('aria-pressed', String(selected === index));
        button.addEventListener('click', () => { selected = index; void answer({ choiceIndex: index }); }); options.append(button);
      }
      cancel.hidden = !isBlocking; cancel.disabled = busy; stop.hidden = !isBlocking; stop.disabled = stopBusy; speechActions.hidden = !isBlocking;
      input.disabled = busy || Boolean(snapshot.running && !isBlocking); send.disabled = input.disabled; close.hidden = isBlocking;
      send.textContent = isBlocking ? '回答' : '发送'; input.placeholder = isBlocking ? '也可以输入你的答复…' : '和大肥鱼说点什么…';
      status.textContent = busy ? '发送中…' : snapshot.running ? '正在回复…' : isBlocking ? '等待你的答复' : '';
      const failure = boundedText(snapshot.error?.message || snapshot.error, 1000);
      if (!error.textContent && failure) { error.textContent = failure; error.hidden = false; }
      layout();
    }
    function update(value) {
      if (disposed || !value || !sameContext(value)) return;
      const next = value.petDialog || value;
      if (!Number.isSafeInteger(next.revision) || next.revision < snapshot.revision) return;
      if (blocking() && next.question && !next.question.blocking && next.question.id !== snapshot.question.id) return;
      const previous = snapshot.question, different = previous?.id !== next.question?.id;
      if (different) {
        if (pendingAction?.method !== 'sendPetChat' || next.question?.blocking) { ++actionVersion; busy = false; }
        selected = null;
        if (previous?.blocking && !composing) input.value = '';
        error.textContent = ''; error.hidden = true;
      }
      snapshot = { revision: next.revision, question: next.question ? { ...next.question,
        options: Array.isArray(next.question.options) ? next.question.options.filter(choice => typeof choice === 'string').slice(0, 8) : [] } : null,
        running: next.running === true, error: next.error || null };
      const current = activeQuestion();
      if (current?.blocking && (speech?.id !== current.id || !speech?.persistent)) {
        speechQueue.length = 0; showSpeech(current.question, { persistent: true, id: current.id });
      } else if (current && !current.blocking && current.id !== lastQuestionId) {
        if (!muted) enqueueSpeech(current.question, { id: current.id });
      } else if (!current && speech?.persistent) clearSpeech();
      if (current) lastQuestionId = current.id; render();
    }
    async function refresh(version = contextVersion) {
      try { const next = await bridge.getPetDialog(); if (!disposed && version === contextVersion) update(next); }
      catch { /* A later scoped event can restore the temporary dialogue. */ }
      finally { if (!disposed && version === contextVersion) { initialized = true; schedule(); } }
    }
    function updateContext(state) {
      if (disposed || !state || typeof state.workspaceId !== 'string') return;
      ++stateVersion;
      if (context && contextKey(state) === contextKey(context)) { schedule(); return; }
      ++contextVersion; ++actionVersion; context = { workspaceId: state.workspaceId, sessionId: state.sessionId ?? null };
      clearTimers(); clearSpeech(); speechQueue.length = 0; initialized = false; savedFocus = null; busy = false; stopBusy = false; chatOpened = false; muted = false;
      composing = false; draftComposing = false;
      pendingAction = null;
      inputOpen = false; fallbackLatched = false; inputBubble.hidden = true; lastQuestionId = null; reserve(false);
      snapshot = { revision: -1, question: null, running: false, error: null };
      input.value = ''; error.textContent = ''; error.hidden = true; render(); return refresh();
    }
    async function act(method, payload) {
      const current = activeQuestion(); if (!context || (!current && method !== 'sendPetChat') || busy || disposed) return;
      const version = ++actionVersion, origin = contextVersion, submitted = method === 'sendPetChat' ? input.value : null;
      pendingAction = { method, version };
      busy = true; error.textContent = ''; error.hidden = true; render();
      try {
        const next = await bridge[method]({ ...context, ...(method === 'sendPetChat' ? {} : { id: current.id }), ...payload });
        if (disposed || version !== actionVersion || origin !== contextVersion) return;
        if (submitted !== null && input.value === submitted && !composing) input.value = '';
        if (next && sameContext(next)) update(next); else await refresh(origin);
      } catch (failure) {
        if (disposed || version !== actionVersion || origin !== contextVersion) return;
        error.textContent = boundedText(failure?.message, 1000) || '答复未能发送，请重试。'; error.hidden = false;
      } finally {
        if (pendingAction?.version === version) pendingAction = null;
        if (!disposed && version === actionVersion && origin === contextVersion) { busy = false; render(); }
      }
    }
    async function answer(payload = {}) {
      let method = 'answerPetDialog';
      if (payload.choiceIndex === undefined) {
        const text = input.value.trim();
        if (!text || text.length > 4000) { error.textContent = '请输入 1 至 4,000 字的答复。'; error.hidden = false; input.focus(); return; }
        payload = { text }; if (!blocking()) { method = 'sendPetChat'; chatOpened = true; muted = false; }
      }
      await act(method, payload);
    }
    function dismiss() {
      chatOpened = false; muted = true; speechQueue.length = 0;
      if (!blocking()) clearSpeech();
      if (activeQuestion()) return act('dismissPetDialog', {});
      render(); return Promise.resolve();
    }
    listen(form, 'submit', event => { event.preventDefault(); if (!composing) void answer(); });
    listen(input, 'input', () => { selected = null; error.textContent = ''; error.hidden = true; schedule(); });
    listen(input, 'compositionstart', () => { composing = true; }); listen(input, 'compositionend', () => { composing = false; schedule(); });
    listen(input, 'keydown', event => {
      if (composing || event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void answer(); }
    });
    const escape = event => { if (event.key === 'Escape' && !composing && !event.isComposing) { event.preventDefault(); event.stopPropagation(); void dismiss(); } };
    listen(panel, 'keydown', escape); listen(inputBubble, 'keydown', escape);
    listen(close, 'click', () => void dismiss()); listen(cancel, 'click', () => void dismiss());
    listen(launcher, 'click', () => {
      chatOpened = true; muted = false;
      if (!speech && activeQuestion() && !blocking()) enqueueSpeech(activeQuestion().question, { id: activeQuestion().id });
      render(); input.focus({ preventScroll: true });
    });
    listen(stop, 'click', async () => {
      if (stopBusy) return; const origin = contextVersion; stopBusy = true; render();
      try { await bridge.stopTask(); }
      catch { if (!disposed && origin === contextVersion) { error.textContent = '停止任务失败，请重试。'; error.hidden = false; } }
      finally { if (!disposed && origin === contextVersion) { stopBusy = false; render(); } }
    });
    listen(view, 'synora:pet-action', event => {
      const detail = event.detail;
      if (!detail || !Number.isSafeInteger(detail.sequence) || detail.sequence <= lastActionSequence) return;
      lastActionSequence = detail.sequence;
      if (!actionLines[detail.kind] || blocking() || snapshot.running || chatOpened || input.value || now() - lastActionAt < 2000) return;
      const bounds = anchor?.getBoundingClientRect(); if (!anchor || anchor.hidden || !(bounds?.width > 0 && bounds.height > 0)) return;
      lastActionAt = now(); enqueueSpeech(actionLines[detail.kind], { local: true }); render();
    });
    listen(draft, 'compositionstart', () => { draftComposing = true; schedule(); }); listen(draft, 'compositionend', () => { draftComposing = false; schedule(); });
    listen(view, 'resize', () => { fallbackLatched = false; schedule(); });
    const resizeObserver = view.ResizeObserver ? new view.ResizeObserver(schedule) : null;
    resizeObserver?.observe(panel); resizeObserver?.observe(inputBubble); if (composer) resizeObserver?.observe(composer);
    const bodyObserver = view.MutationObserver ? new view.MutationObserver(findAnchor) : null;
    bodyObserver?.observe(document.body, { childList: true, subtree: true }); findAnchor();
    const unsubscribe = bridge.onEvent?.(event => {
      if (event?.type === 'pet-dialog') update(event);
      else if (['state', 'workspace-activated'].includes(event?.type)) updateContext(event.state);
      else if (event?.type === 'pet-state') { fallbackLatched = false; schedule(); }
    });
    const initialVersion = stateVersion;
    const ready = Promise.resolve(bridge.getState()).then(value => { if (!disposed && initialVersion === stateVersion) return updateContext(value); }).catch(() => {});
    function destroy() {
      if (disposed) return;
      document.documentElement.classList.remove('pet-dialog-replaces-composer'); restoreFocus(); disposed = true; ++actionVersion;
      clearTimers(); speech = null; speechQueue.length = 0; reserve(false);
      if (frame) view.cancelAnimationFrame(frame); frame = 0;
      resizeObserver?.disconnect(); bodyObserver?.disconnect(); anchorObserver?.disconnect();
      for (const remove of listeners) remove(); if (typeof unsubscribe === 'function') unsubscribe(); panel.remove(); inputBubble.remove(); launcher.remove();
    }
    return Object.freeze({ ready, update, updateContext, refresh, destroy });
  }
  root.ForgePetDialog = Object.freeze({ create, durationForText, contentAnchor });
  if (root.document && root.forge?.getPetDialog && !root.document.getElementById('pet-dialog')) root.synoraPetDialog = create();
})(window);
