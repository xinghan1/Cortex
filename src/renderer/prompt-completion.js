/* Completed rounds suggest a next question; only Tab can insert it into the draft. */
(() => {
  'use strict';
  function create({ input, hint, ghost, getContext, canSuggest = () => false, request, cancel }) {
    let active = null, suggestion = null, liveRound = null, composing = false, inserting = false, disposed = false, inputSerial = 0;
    const completedRounds = new Set();
    const doc = input.ownerDocument, listeners = [];
    const listen = (node, name, handler) => { node.addEventListener(name, handler); listeners.push(() => node.removeEventListener(name, handler)); };
    const context = () => getContext() || null;
    const identity = value => value && JSON.stringify(value);
    const available = () => !disposed && !composing && !input.disabled && !input.readOnly && !input.closest('[hidden],[inert]');
    const editable = () => available() && doc.activeElement === input;
    const automatic = () => available() && input.value === '' && !!context() && canSuggest();
    const validSuggestion = () => suggestion && automatic() && suggestion.identity === identity(context()) && suggestion.serial === inputSerial;
    const paintGhost = () => {
      const visible = !!validSuggestion();
      input.dataset.hasSuggestion = String(visible);
      if (!ghost) return;
      ghost.textContent = visible ? suggestion.text : '';
      ghost.hidden = !visible;
      if (visible && typeof getComputedStyle === 'function') {
        // Keep the overlay aligned with each theme's textarea typography and
        // padding without changing the textarea or its native editing history.
        const style = getComputedStyle(input);
        for (const name of ['padding', 'font', 'letterSpacing', 'textAlign', 'direction']) ghost.style[name] = style[name];
      }
    };
    const render = (status = 'idle', text = 'Tab 补全提示词') => {
      hint.dataset.status = status;
      hint.textContent = text;
      hint.hidden = !editable() || !context();
      input.setAttribute('aria-busy', String(status === 'loading'));
      paintGhost();
    };
    const stop = (text) => {
      const previous = active;
      active = null; suggestion = null;
      if (previous) Promise.resolve().then(() => cancel({ id: previous.id })).catch(() => {});
      render('idle', text || 'Tab 补全提示词');
    };
    const matches = value => active === value && (value.automatic ? automatic() : editable()) && value.draft === input.value
      && value.serial === inputSerial && (value.automatic || value.offset === input.selectionStart && value.offset === input.selectionEnd)
      && value.identity === identity(context());
    const sync = () => {
      if (active && !matches(active) || suggestion && !validSuggestion()) stop();
      else if (!active) render(suggestion ? 'suggested' : 'idle', suggestion ? 'Tab 接受建议 · Esc 取消' : undefined);
      else render('loading', '正在补全提示词… Esc 取消');
    };
    function insert(value, text) {
      const suffix = text.slice(value.draft.length);
      // Insert only the continuation; Chromium keeps it on the textarea's
      // native undo stack. The original draft is never rewritten.
      inserting = true;
      const serial = inputSerial;
      try {
        try { doc.execCommand('insertText', false, suffix); } catch { /* Plain textarea fallback. */ }
        if (input.value === value.draft) input.setRangeText(suffix, value.offset, value.offset, 'end');
        if (input.value !== text) throw new Error('输入内容已变化，请重新按 Tab。');
        input.setSelectionRange(input.value.length, input.value.length);
        if (inputSerial === serial) input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: suffix }));
      } finally { inserting = false; }
      render('completed', '已补全 · Ctrl+Z 撤销');
    }
    async function complete(auto = false) {
      if (active) return;
      const current = context();
      if (!(auto ? automatic() : editable()) || !current || !auto && (input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length)) return;
      const value = { ...current, id: globalThis.crypto.randomUUID(), draft: input.value, offset: auto ? 0 : input.selectionStart,
        identity: identity(current), serial: inputSerial, automatic: auto };
      active = value;
      render('loading', '正在补全提示词… Esc 取消');
      let applying = false;
      try {
        const response = await request({ id: value.id, sessionId: value.sessionId, workspaceId: value.workspaceId, draft: value.draft });
        if (!matches(value)) return;
        if (!response || response.id !== value.id || response.sessionId !== value.sessionId || response.workspaceId !== value.workspaceId
            || typeof response.text !== 'string' || !response.text.startsWith(value.draft) || response.text.length > 40_000) {
          throw new Error('未获得有效补全，请重新按 Tab。');
        }
        const suffix = response.text.slice(value.draft.length);
        active = null;
        if (!suffix) { render('empty', '暂无可补充内容'); return; }
        if (auto) {
          suggestion = { text: response.text, identity: value.identity, serial: value.serial };
          render('suggested', 'Tab 接受建议 · Esc 取消');
          return;
        }
        applying = true;
        insert(value, response.text);
      } catch (error) {
        if (!applying && active !== value) return;
        if (!applying && !matches(value)) { stop(); return; }
        active = null;
        if (auto) { render(); return; }
        const accountChanged = String(error?.message || '').includes('会话模型账号已变化，请新建会话后再补全提示词。');
        render('error', accountChanged ? '账号已变化 · 新建会话后补全' : '补全未完成，可重新按 Tab');
      } finally {
        if (active === value) { active = null; render(); }
      }
    }
    function startRound(round) {
      if (disposed || !round?.runId || completedRounds.has(round.runId) || liveRound?.runId === round.runId) return;
      stop();
      liveRound = { ...round };
    }
    function suggestAfterRound(round) {
      const started = liveRound;
      if (!started || started.runId !== round?.runId || completedRounds.has(round.runId)) return;
      liveRound = null;
      completedRounds.add(round.runId);
      if (completedRounds.size > 128) completedRounds.delete(completedRounds.values().next().value);
      const current = context();
      if (round.status !== 'completed' || started.kind !== 'agent' || started.demo || !current
          || started.sessionId !== current.sessionId || started.workspaceId !== current.workspaceId
          || round.sessionId !== current.sessionId || round.workspaceId !== current.workspaceId || !automatic()) return;
      return complete(true);
    }
    listen(input, 'keydown', event => {
      if (event.key === 'Escape' && (active || suggestion) && !event.isComposing && event.keyCode !== 229 && !composing) { event.preventDefault(); stop('补全已取消'); return; }
      if (event.key !== 'Tab' || event.defaultPrevented || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
          || event.isComposing || event.keyCode === 229 || composing || !editable() || !context()
          || input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length) return;
      event.preventDefault();
      if (event.repeat) return;
      if (validSuggestion()) {
        const text = suggestion.text;
        suggestion = null;
        insert({ draft: '', offset: 0 }, text);
      } else void complete();
    });
    listen(input, 'input', () => { inputSerial++; if (!inserting) stop(); });
    listen(input, 'compositionstart', () => { composing = true; stop(); });
    listen(input, 'compositionend', () => { composing = false; sync(); });
    listen(input, 'blur', () => { if (active && !active.automatic) stop(); else sync(); });
    listen(input, 'focus', sync);
    listen(doc, 'selectionchange', () => { if (active && !matches(active)) stop(); });
    if (doc.defaultView) listen(doc.defaultView, 'pagehide', () => { liveRound = null; stop(); });
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(paintGhost) : null;
    resize?.observe(input);
    render();
    return { sync, startRound, suggestAfterRound, cancel(text) { liveRound = null; stop(text); }, dispose() {
      liveRound = null; stop(); disposed = true; resize?.disconnect(); listeners.splice(0).forEach(remove => remove()); hint.hidden = true;
    } };
  }
  globalThis.ForgePromptCompletion = { create };
})();
