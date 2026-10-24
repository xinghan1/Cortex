(() => {
  'use strict';
  const bridge = window.forge;
  const $ = id => document.getElementById(id);
  const control = $('session-context-control'), trigger = $('session-context-trigger'), popup = $('context-settings-popup');
  const input = $('context-trigger-input'), error = $('context-trigger-error');
  if (!bridge || !control || !popup) return;
  const valid = value => Number.isSafeInteger(value) && value >= 1000 && value <= 16000000;
  const capacity = value => Number.isSafeInteger(value) && value > 0 ? value : null;
  let currentState = null, saved = null, scope = null, dirty = false, saving = false, editVersion = 0, stateVersion = 0;
  const source = $('context-capacity-source');
  const text = value => value === null ? '' : String(value);
  const syncButtons = () => {
    $('context-trigger-save').disabled = saving || !scope;
    $('context-trigger-reset').disabled = saving || !scope;
  };

  function close(restoreFocus = false) {
    popup.hidden = true; trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }
  function open() {
    input.value = text(saved); dirty = false; error.hidden = true;
    popup.hidden = false; trigger.setAttribute('aria-expanded', 'true');
    input.focus({ preventScroll: true }); input.select();
  }
  function update(state) {
    if (!state || typeof state !== 'object') return;
    ++stateVersion;
    const nextScope = typeof state.modelCapacity?.scope === 'string' && state.modelCapacity.scope ? state.modelCapacity.scope : null;
    const changedScope = currentState && (scope !== nextScope || currentState.workspaceId !== state.workspaceId);
    currentState = state;
    scope = nextScope; saved = capacity(state.modelCapacity?.capacityTokens);
    if (changedScope) { ++editVersion; dirty = false; error.hidden = true; close(); }
    const advertised = capacity(state.modelCapacity?.advertisedTokens);
    input.max = String(Math.min(16000000, advertised ?? 16000000));
    input.disabled = !scope;
    if (source) {
      source.textContent = `来源：${({ catalog: '模型目录', manual: '手动设置' })[state.modelCapacity?.source] || '未提供'}`;
      source.title = state.modelCapacity?.manualClamped ? '手动容量已按当前模型目录上限调整。' : '';
    }
    if (popup.hidden || !dirty) input.value = text(saved);
    syncButtons();
  }
  async function save(value = input.value.trim() ? Number(input.value) : null) {
    if (saving || !scope) return;
    if (value !== null && !valid(value)) {
      error.textContent = '请输入 1,000 至 16,000,000 之间的整数 Token。'; error.hidden = false; input.focus(); return;
    }
    const advertised = capacity(currentState?.modelCapacity?.advertisedTokens);
    if (value !== null && advertised !== null && value > advertised) {
      error.textContent = `模型容量不能超过目录提供的 ${advertised.toLocaleString('en-US')} Token。`; error.hidden = false; input.focus(); return;
    }
    const version = editVersion, requestScope = scope;
    saving = true; error.hidden = true;
    syncButtons();
    try {
      const next = await bridge.setModelCapacity({ capacityTokens: value, scope: requestScope });
      if (requestScope !== scope) return;
      if (version === editVersion) dirty = false;
      update(next);
      if (version === editVersion) close(true);
    } catch (failure) {
      if (requestScope !== scope || version !== editVersion) return;
      error.textContent = failure?.message || '模型容量保存失败，请重试。'; error.hidden = false;
    } finally {
      saving = false; syncButtons();
    }
  }

  trigger.addEventListener('click', () => { if (popup.hidden) open(); else close(); });
  $('context-settings-close').addEventListener('click', () => close(true));
  input.addEventListener('input', () => { ++editVersion; dirty = true; error.hidden = true; });
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void save(); } });
  $('context-trigger-save').addEventListener('click', () => void save());
  $('context-trigger-reset').addEventListener('click', () => { ++editVersion; void save(null); });
  document.addEventListener('pointerdown', event => { if (!control.contains(event.target)) close(); });
  document.addEventListener('keydown', event => {
    if (!popup.hidden && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
  }, true);
  bridge.onEvent(event => {
    if (event.type === 'workspace-activated') update(event.state);
    else if (event.type === 'state' && (!currentState?.workspaceId || !event.workspaceId || currentState.workspaceId === event.workspaceId)) update(event.state);
  });
  const initialVersion = stateVersion;
  void bridge.getState().then(value => { if (initialVersion === stateVersion) update(value); }).catch(() => {});
  window.ForgeContextSettings = Object.freeze({ update, open, close });
})();
