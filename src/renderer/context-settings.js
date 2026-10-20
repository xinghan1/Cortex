(() => {
  'use strict';
  const bridge = window.forge;
  const $ = id => document.getElementById(id);
  const control = $('session-context-control'), trigger = $('session-context-trigger'), popup = $('context-settings-popup');
  const input = $('context-trigger-input'), error = $('context-trigger-error');
  if (!bridge || !control || !popup) return;
  const DEFAULT = 850000;
  const valid = value => Number.isSafeInteger(value) && value >= 1000 && value <= 16000000;
  let currentState = null, saved = DEFAULT, dirty = false, saving = false, editVersion = 0;

  function close(restoreFocus = false) {
    popup.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }
  function open() {
    input.value = String(saved); dirty = false; error.hidden = true;
    popup.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    input.focus({ preventScroll: true }); input.select();
  }
  function update(state) {
    if (!state || typeof state !== 'object') return;
    const changedWorkspace = currentState?.workspaceId && currentState.workspaceId !== state.workspaceId;
    currentState = state;
    if (valid(state.contextCompressionTriggerTokens)) saved = state.contextCompressionTriggerTokens;
    if (changedWorkspace) close();
    if (popup.hidden || !dirty) input.value = String(saved);
  }
  async function save(value = Number(input.value)) {
    if (saving) return;
    if (!valid(value)) {
      error.textContent = '请输入 1,000 至 16,000,000 之间的整数 Token。'; error.hidden = false; input.focus(); return;
    }
    const version = editVersion;
    saving = true; error.hidden = true;
    $('context-trigger-save').disabled = true; $('context-trigger-reset').disabled = true;
    try {
      const next = await bridge.setContextCompression({ triggerTokens: value });
      saved = value;
      if (version === editVersion) { dirty = false; input.value = String(value); }
      update(next);
      if (version === editVersion) close(true);
    } catch (failure) {
      error.textContent = failure?.message || '上下文压缩设置保存失败，请重试。'; error.hidden = false;
    } finally {
      saving = false; $('context-trigger-save').disabled = false; $('context-trigger-reset').disabled = false;
    }
  }

  trigger.addEventListener('click', () => { if (popup.hidden) open(); else close(); });
  $('context-settings-close').addEventListener('click', () => close(true));
  input.addEventListener('input', () => { ++editVersion; dirty = true; error.hidden = true; });
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void save(); } });
  $('context-trigger-save').addEventListener('click', () => void save());
  $('context-trigger-reset').addEventListener('click', () => { ++editVersion; input.value = String(DEFAULT); dirty = true; void save(DEFAULT); });
  document.addEventListener('pointerdown', event => { if (!control.contains(event.target)) close(); });
  document.addEventListener('keydown', event => {
    if (!popup.hidden && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
  }, true);
  bridge.onEvent(event => {
    if (event.type === 'workspace-activated') update(event.state);
    else if (event.type === 'state' && (!currentState?.workspaceId || !event.workspaceId || currentState.workspaceId === event.workspaceId)) update(event.state);
  });
  void bridge.getState().then(update).catch(() => {});
  window.ForgeContextSettings = Object.freeze({ update, open, close });
})();
