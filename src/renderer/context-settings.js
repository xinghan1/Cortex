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
  let metrics = null;
  const tokenCount = value => Number.isSafeInteger(value) && value >= 0;
  const compact = (value, approximate = false) => {
    if (!tokenCount(value)) return '—';
    const unit = value >= 1000000 ? 1000000 : value >= 1000 ? 1000 : 1;
    const rounded = unit === 1 ? value : Math.round(value / unit * 10) / 10;
    return `${approximate || rounded * unit !== value ? '~' : ''}${rounded.toLocaleString('en-US')}${unit === 1000000 ? 'M' : unit === 1000 ? 'K' : ''}`;
  };
  function updateMetrics(next) {
    metrics = next && typeof next === 'object' ? next : null;
    renderUsage();
  }
  function renderUsage() {
    const label = $('context-usage-label'), values = $('context-usage-tokens'), meter = $('context-composition-meter');
    if (!label || !values || !meter) return;
    const display = metrics?.contextDisplay || (metrics?.contextStatus === 'reported'
      ? { source: 'current', usedTokens: metrics.contextUsedTokens, limit: metrics.contextLimit } : { source: 'none' });
    const available = ['current', 'last-reported', 'estimated'].includes(display.source) && tokenCount(display.usedTokens);
    const estimated = display.source === 'estimated';
    const limit = currentState?.modelCapacity ? capacity(currentState.modelCapacity.capacityTokens) : capacity(display.limit);
    const percent = available && limit !== null ? Math.round(display.usedTokens / limit * 1000) / 10 : null;
    const percentText = percent === null ? '—' : `${estimated ? '~' : ''}${percent.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`;
    label.textContent = `上下文已用 ${percentText}`;
    values.textContent = `${available ? compact(display.usedTokens, estimated) : '—'} / ${compact(limit)}`;
    const breakdown = metrics?.contextBreakdown;
    const matching = available && breakdown && ['estimated-local', 'estimated-allocation'].includes(breakdown.source) && breakdown.displaySource === display.source;
    const fields = [['system', 'systemTokens'], ['tools', 'toolTokens'], ['messages', 'messageTokens']];
    const total = matching && tokenCount(breakdown.totalTokens) ? breakdown.totalTokens : null;
    let allocated = 0;
    for (const [name, field] of fields) {
      const count = matching && tokenCount(breakdown[field]) ? breakdown[field] : null;
      const node = $(`context-${name}-tokens`), segment = $(`context-segment-${name}`);
      if (node) node.textContent = compact(count, true);
      const width = percent !== null && total > 0 && count !== null
        ? Math.max(0, Math.min(Math.min(100, percent) - allocated, count / total * Math.min(100, percent))) : 0;
      allocated += width;
      if (segment) segment.style.width = `${width}%`;
    }
    const origin = !available ? '暂无上下文用量' : display.source === 'last-reported' ? '最近完整请求实测（新增内容待回报）'
      : estimated ? '本地估算' : '最近服务端实测';
    const explanation = `${origin} · 分项为估算`;
    const hint = $('context-usage-source');
    if (hint) {
      hint.textContent = explanation;
      hint.title = (matching && breakdown.source === 'estimated-allocation'
        ? '分项为本地估算，按服务端输入用量校准。' : '分项按本地文本估算；色条按总占用比例显示。')
        + (matching && breakdown.hasUnknownAttachmentCost ? '未包含准确的图像 Token 成本。' : '');
    }
    meter.dataset.known = String(percent !== null);
    meter.setAttribute('aria-valuetext', `${label.textContent}，${values.textContent} Token，${explanation}`);
    if (percent === null) meter.removeAttribute('aria-valuenow');
    else meter.setAttribute('aria-valuenow', String(Math.min(100, percent)));
  }
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
    popup.scrollTop = 0;
    $('context-settings-close').focus({ preventScroll: true });
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
      const label = state.modelCapacity?.sourceLabel || ({ catalog: '模型目录', manual: '手动设置' })[state.modelCapacity?.source] || '未知';
      source.textContent = `容量来源：${label}`;
      source.title = state.modelCapacity?.manualClamped ? '手动容量已按自动识别的容量上限调整。' : '';
    }
    const detail = $('context-capacity-detail');
    if (detail) {
      detail.textContent = typeof state.modelCapacity?.sourceDescription === 'string' ? state.modelCapacity.sourceDescription
        : state.modelCapacity?.source === 'manual' ? '使用为当前模型保存的手动容量。'
          : state.modelCapacity?.source === 'catalog' ? '使用当前模型目录提供的容量。' : '当前模型未提供容量，可手动填写。';
    }
    if (popup.hidden || !dirty) input.value = text(saved);
    updateMetrics(state.sessionMetrics);
    syncButtons();
  }
  async function save(value = input.value.trim() ? Number(input.value) : null) {
    if (saving || !scope) return;
    if (value !== null && !valid(value)) {
      error.textContent = '请输入 1,000 至 16,000,000 之间的整数 Token。'; error.hidden = false; input.focus(); return;
    }
    const advertised = capacity(currentState?.modelCapacity?.advertisedTokens);
    if (value !== null && advertised !== null && value > advertised) {
      error.textContent = `模型容量不能超过自动识别的容量上限 ${advertised.toLocaleString('en-US')} Token。`; error.hidden = false; input.focus(); return;
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
  window.ForgeContextSettings = Object.freeze({ update, updateMetrics, open, close });
})();
