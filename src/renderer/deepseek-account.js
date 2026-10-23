(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const bridge = window.forge, dialog = $('settings-dialog'), form = $('settings-form');
  const provider = $('provider-select'), baseURL = $('base-url-input'), anchor = $('settings-error');
  if (!bridge || !dialog || !form || !provider || !baseURL || !anchor || $('deepseek-account')) return;
  const node = (tag, className, text) => {
    const value = document.createElement(tag);
    if (className) value.className = className;
    if (text !== undefined) value.textContent = text;
    return value;
  };
  const panel = node('section', 'deepseek-account'); panel.id = 'deepseek-account'; panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'deepseek-account-title');
  const heading = node('div', 'deepseek-account-heading'), title = node('strong', '', '账户余额'); title.id = 'deepseek-account-title';
  const actions = node('div', 'deepseek-account-actions');
  const query = node('button', 'text-button', '查询余额'); query.id = 'deepseek-balance-query'; query.type = 'button';
  const official = node('button', 'text-button', '打开官方账号'); official.id = 'deepseek-account-open'; official.type = 'button';
  actions.append(query, official); heading.append(title, actions);
  const status = node('p', 'deepseek-account-status'); status.id = 'deepseek-balance-status'; status.setAttribute('role', 'status');
  const values = node('div', 'deepseek-account-values'); values.id = 'deepseek-balance-values'; values.hidden = true;
  panel.append(heading, status, values); anchor.before(panel);
  let state = null, generation = 0, stateVersion = 0, loading = false, opening = false, keyEdited = false;

  function officialURL(raw) {
    if (typeof raw !== 'string' || /[\s\\\x00-\x1f\x7f]/u.test(raw)) return false;
    const parts = raw.match(/^https:\/\/([^/]+)(.*)$/iu);
    return !!parts && parts[1].toLowerCase() === 'api.deepseek.com' && ['', '/', '/v1', '/v1/'].includes(parts[2]);
  }
  function unavailable() {
    if (!state) return '正在读取连接状态…';
    const saved = state.settings?.providers?.deepseek;
    if (!saved?.hasKey) return '请先保存 DeepSeek API Key。';
    if (!officialURL(saved.baseUrl)) return '当前连接为自定义服务，无法查询官方账户余额。';
    const draftURL = baseURL.value.trim();
    if (keyEdited || !officialURL(draftURL)
        || new URL(draftURL).href.replace(/\/$/u, '') !== new URL(saved.baseUrl).href.replace(/\/$/u, '')) return '请先保存连接配置。';
    if (typeof bridge.getDeepSeekBalance !== 'function') return '当前版本不支持余额查询。';
    return '';
  }
  function render(message) {
    panel.hidden = provider.value !== 'deepseek' || dialog.classList.contains('role-model-settings');
    const reason = unavailable();
    query.disabled = panel.hidden || !dialog.open || loading || !!reason;
    query.textContent = loading ? '查询中…' : '查询余额';
    official.disabled = opening || typeof bridge.openDeepSeekAccount !== 'function';
    if (message !== undefined) status.textContent = message;
    else if (reason) status.textContent = reason;
    status.hidden = !status.textContent;
  }
  function clear() {
    ++generation; loading = false;
    values.replaceChildren(); values.hidden = true;
    status.classList.remove('error'); status.textContent = '';
    render('');
    if (!panel.hidden) render();
  }
  function update(next) {
    if (!next || typeof next !== 'object') return;
    state = next; ++stateVersion;
    // Public hasKey cannot identify a replacement key, so every new saved-state
    // snapshot invalidates a displayed or pending account result.
    clear();
  }
  function showBalance(result) {
    if (!result || typeof result.is_available !== 'boolean' || !Array.isArray(result.balance_infos)) throw new Error('Invalid balance');
    const available = node('span', 'deepseek-account-availability', result.is_available ? '可用' : '不可用');
    available.dataset.available = String(result.is_available);
    values.append(available);
    if (!result.balance_infos.length) values.append(node('span', 'deepseek-balance-empty', '暂无余额数据'));
    for (const info of result.balance_infos) {
      const row = node('div', 'deepseek-balance-row');
      row.append(node('strong', 'deepseek-balance-total', `${info.currency} ${info.total_balance}`));
      const details = node('details', 'deepseek-balance-details'); details.append(node('summary', '', '余额明细'));
      const list = node('dl');
      list.append(node('dt', '', '赠送余额'), node('dd', '', `${info.currency} ${info.granted_balance}`),
        node('dt', '', '充值余额'), node('dd', '', `${info.currency} ${info.topped_up_balance}`));
      details.append(list); row.append(details); values.append(row);
    }
    values.hidden = false;
  }
  const errors = {
    DEEPSEEK_BALANCE_KEY: '请先保存有效的 DeepSeek API Key。',
    DEEPSEEK_BALANCE_UNOFFICIAL: '当前连接为自定义服务，无法查询官方账户余额。',
    DEEPSEEK_BALANCE_AUTH: 'DeepSeek 密钥无效或已失效，请更新后重试。',
    DEEPSEEK_BALANCE_FORBIDDEN: '当前 DeepSeek 密钥无权查询余额。',
    DEEPSEEK_BALANCE_BUSY: '查询过于频繁，请稍后重试。',
    DEEPSEEK_BALANCE_TIMEOUT: '余额查询超时，请重试。',
    DEEPSEEK_BALANCE_NETWORK: '无法读取余额，请检查网络后重试。',
  };
  query.addEventListener('click', async () => {
    if (loading || panel.hidden || !dialog.open || unavailable()) { render(); return; }
    const token = ++generation;
    loading = true; values.replaceChildren(); values.hidden = true; status.classList.remove('error'); render('正在查询…');
    try {
      const result = await bridge.getDeepSeekBalance();
      if (token !== generation || provider.value !== 'deepseek' || !dialog.open) return;
      showBalance(result); render('');
    } catch (error) {
      if (token !== generation || provider.value !== 'deepseek' || !dialog.open) return;
      const code = error?.code || String(error?.message || '').match(/\bDEEPSEEK_BALANCE_[A-Z_]+\b/u)?.[0];
      status.classList.add('error'); render(errors[code] || '余额查询失败，请重试。');
    } finally { if (token === generation) { loading = false; render(); } }
  });
  official.addEventListener('click', async () => {
    if (opening || typeof bridge.openDeepSeekAccount !== 'function') return;
    const token = generation;
    opening = true; render();
    try { await bridge.openDeepSeekAccount(); }
    catch { if (token === generation && dialog.open && !panel.hidden) { status.classList.add('error'); render('暂时无法打开官方账号。'); } }
    finally { opening = false; render(); }
  });
  provider.addEventListener('change', () => { keyEdited = false; clear(); });
  const draftChanged = event => {
    if (event.target === provider) return;
    if (event.target?.id === 'api-key-input') keyEdited = true;
    clear();
  };
  form.addEventListener('input', draftChanged); form.addEventListener('change', draftChanged);
  dialog.addEventListener('close', () => { keyEdited = false; clear(); });
  new MutationObserver(() => { keyEdited = false; clear(); }).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  bridge.onEvent?.(event => {
    if (['state', 'workspace-activated'].includes(event?.type)) update(event.state);
  });
  const version = stateVersion;
  if (typeof bridge.getState === 'function') void bridge.getState().then(value => { if (stateVersion === version) update(value); }).catch(() => { render('暂时无法读取连接状态。'); });
  render();
})();
