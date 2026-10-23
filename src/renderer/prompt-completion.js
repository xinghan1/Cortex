/* Explicit composer completion. Nothing is requested until the user presses Tab. */
(() => {
  'use strict';
  function create({ input, hint, getContext, request, cancel }) {
    let active = null, composing = false, inserting = false, disposed = false, inputSerial = 0;
    const doc = input.ownerDocument, listeners = [];
    const listen = (node, name, handler) => { node.addEventListener(name, handler); listeners.push(() => node.removeEventListener(name, handler)); };
    const context = () => getContext() || null;
    const identity = value => value && JSON.stringify(value);
    const editable = () => !disposed && !composing && !input.disabled && !input.readOnly
      && doc.activeElement === input && !input.closest('[hidden],[inert]');
    const render = (status = 'idle', text = 'Tab 补全提示词') => {
      hint.dataset.status = status;
      hint.textContent = text;
      hint.hidden = !editable() || !context();
      input.setAttribute('aria-busy', String(status === 'loading'));
    };
    const stop = (text) => {
      const previous = active;
      active = null;
      if (previous) Promise.resolve().then(() => cancel({ id: previous.id })).catch(() => {});
      render('idle', text || 'Tab 补全提示词');
    };
    const matches = value => active === value && editable() && value.draft === input.value
      && value.offset === input.selectionStart && value.offset === input.selectionEnd
      && value.identity === identity(context());
    const sync = () => {
      if (active && !matches(active)) stop();
      else if (!active) render();
    };
    async function complete() {
      if (active) return;
      const current = context();
      if (!editable() || !current || input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length) return;
      const value = { id: globalThis.crypto.randomUUID(), draft: input.value, offset: input.selectionStart, identity: identity(current), ...current };
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
        // Insert only the continuation; Chromium keeps it on the textarea's
        // native undo stack. The original draft is never rewritten.
        inserting = true;
        applying = true;
        const serial = inputSerial;
        try {
          try { doc.execCommand('insertText', false, suffix); } catch { /* Plain textarea fallback. */ }
          if (input.value === value.draft) input.setRangeText(suffix, value.offset, value.offset, 'end');
          if (input.value !== response.text) throw new Error('输入内容已变化，请重新按 Tab。');
          input.setSelectionRange(input.value.length, input.value.length);
          if (inputSerial === serial) input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: suffix }));
        } finally { inserting = false; }
        render('completed', '已补全 · Ctrl+Z 撤销');
      } catch (error) {
        if (!applying && active !== value) return;
        if (!applying && !matches(value)) { stop(); return; }
        active = null;
        const accountChanged = String(error?.message || '').includes('会话模型账号已变化，请新建会话后再补全提示词。');
        render('error', accountChanged ? '账号已变化 · 新建会话后补全' : '补全未完成，可重新按 Tab');
      } finally {
        if (active === value) { active = null; render(); }
      }
    }
    listen(input, 'keydown', event => {
      if (event.key === 'Escape' && active) { event.preventDefault(); stop('补全已取消'); return; }
      if (event.key !== 'Tab' || event.defaultPrevented || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey
          || event.isComposing || event.keyCode === 229 || composing || !editable() || !context()
          || input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length) return;
      event.preventDefault();
      if (!event.repeat) void complete();
    });
    listen(input, 'input', () => { inputSerial++; if (!inserting) stop(); });
    listen(input, 'compositionstart', () => { composing = true; stop(); });
    listen(input, 'compositionend', () => { composing = false; sync(); });
    listen(input, 'blur', () => stop());
    listen(input, 'focus', sync);
    listen(doc, 'selectionchange', () => { if (active && !matches(active)) stop(); });
    render();
    return { sync, cancel: stop, dispose() { stop(); disposed = true; listeners.splice(0).forEach(remove => remove()); hint.hidden = true; } };
  }
  globalThis.ForgePromptCompletion = { create };
})();
