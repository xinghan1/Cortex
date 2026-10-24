'use strict';
(function (root) {
  const OFFICIAL_URL = 'https://api.deepseek.com/anthropic/v1';
  const messages = Object.freeze({
    DEEPSEEK_STORAGE_UNREADABLE: '无法读取本机保存的 DeepSeek 登录信息。原信息已保留，可重试读取。',
    DEEPSEEK_ENCRYPTION_UNAVAILABLE: '系统安全存储暂不可用，请解锁后重试读取。',
    DEEPSEEK_LOGIN_EXPIRED: '本次登录已过期，请重新登录。',
    DEEPSEEK_NETWORK_ERROR: '无法连接 DeepSeek，请检查网络后重试。',
    DEEPSEEK_CANCELLED: '',
  });
  const clean = (value, limit = 300) => typeof value === 'string' ? value.slice(0, limit) : '';
  function errorMessage(value) {
    const code = typeof value?.code === 'string' ? value.code : String(value?.message || value || '').match(/\bDEEPSEEK_[A-Z_]+\b/u)?.[0];
    return Object.hasOwn(messages, code) ? messages[code] : value ? 'DeepSeek 连接操作未完成，请重试。' : '';
  }
  function create({ document = root.document, bridge, getScope, getRole = () => null, isBusy = () => false,
    onState = () => {}, onChange = () => {}, onInvalidate = () => {}, onModeChange = () => {}, onRefreshModels = () => {} }) {
    const $ = id => document.getElementById(id);
    const el = (tag, id, className, value) => {
      const node = document.createElement(tag); if (id) node.id = id; if (className) node.className = className;
      if (value !== undefined) node.textContent = value; return node;
    };
    const modeField = el('label', 'deepseek-auth-mode-field', 'form-field'); modeField.hidden = true;
    const mode = el('select', 'deepseek-auth-mode'); mode.name = 'deepseekAuthMode';
    for (const [value, label] of [['apiKey', 'API Key'], ['deepseek-account', 'DeepSeek 账号登录']]) {
      const option = el('option', '', '', label); option.value = value; mode.append(option);
    }
    mode.value = 'apiKey'; modeField.append(el('span', '', '', '连接方式'), mode); $('openai-auth-mode-field').after(modeField);
    const panel = el('section', 'deepseek-login-panel', 'deepseek-login-panel'); panel.hidden = true; panel.setAttribute('aria-label', 'DeepSeek 账号授权');
    const statusRow = el('div', '', 'deepseek-login-status-row');
    const status = el('strong', 'deepseek-login-status'), identity = el('span', 'deepseek-login-identity'); statusRow.append(status, identity);
    const sharing = el('p', 'deepseek-login-sharing', 'deepseek-login-sharing');
    const url = el('code', 'deepseek-login-url', 'deepseek-login-url', OFFICIAL_URL);
    const actions = el('div', '', 'deepseek-login-actions'), buttons = {};
    const addButton = (name, label, action, className = 'button') => {
      const button = el('button', `deepseek-login-${name}`, className, label); button.type = 'button'; button.addEventListener('click', action); actions.append(button); buttons[name] = button;
    };
    addButton('sign-in', '登录 DeepSeek', () => run('signin'), 'button solid');
    addButton('cancel', '取消登录', cancel);
    addButton('reconnect', '重新连接', () => run('signin'));
    addButton('disconnect', '退出账号', () => run('disconnect'));
    addButton('retry', '重试读取', () => run('retry'));
    addButton('models', '刷新模型目录', () => { if (!buttons.models.disabled) return onRefreshModels(); }, 'text-button');
    const message = el('p', 'deepseek-login-message', 'deepseek-login-message'); message.hidden = true; message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
    panel.append(statusRow, sharing, url, actions, message); $('base-url-field').before(panel);
    let action = null, cancelling = false, localError = '', activeRole = null, disposed = false;
    const account = () => getScope()?.deepseek || {};
    const signing = () => action === 'signin' || account().session?.status === 'connecting';
    const busy = () => !!action || account().session?.status === 'connecting';
    function render() {
      if (disposed) return;
      const provider = $('provider-select').value, value = account(), session = value.session || {};
      const storage = value.storageRecovery === true || /^DEEPSEEK_(?:STORAGE|ENCRYPTION)_/u.test(value.error?.code || '');
      const connecting = signing(), locked = isBusy() || busy(), connected = session.status === 'connected' && session.sharing === true;
      modeField.hidden = provider !== 'deepseek'; panel.hidden = provider !== 'deepseek' || mode.value !== 'deepseek-account';
      mode.disabled = locked;
      const phases = { initializing: '正在准备登录…', 'waiting-browser': '等待官方浏览器授权', exchanging: '正在完成授权…', committing: '正在保存登录信息…' };
      status.textContent = connecting ? phases[value.attempt?.phase] || '等待官方浏览器授权'
        : storage ? '本机登录信息读取失败' : connected ? '已登录' : session.status === 'reauth_required' ? '需要重新授权' : '未连接';
      identity.textContent = [session.identity?.name, session.identity?.contact].filter(item => typeof item === 'string').map(item => clean(item, 160)).join(' · ');
      sharing.textContent = connected ? '官方账号连接已授权' : connecting ? '请在打开的官方页面完成登录和授权。' : '登录官方账号后获取可用模型。';
      buttons['sign-in'].hidden = connecting || storage || connected;
      buttons.cancel.hidden = !connecting; buttons.cancel.disabled = cancelling;
      buttons.reconnect.hidden = connecting || storage || !['connected', 'reauth_required'].includes(session.status);
      buttons.disconnect.hidden = connecting || !(session.profileId || storage || ['connected', 'reauth_required'].includes(session.status));
      buttons.retry.hidden = !storage; buttons.retry.textContent = action === 'retry' ? '读取中…' : '重试读取';
      for (const name of ['sign-in', 'reconnect', 'disconnect', 'retry']) buttons[name].disabled = locked;
      buttons.models.disabled = locked || !connected;
      const publicError = errorMessage(value.error || session.error);
      message.textContent = localError || publicError; message.hidden = !message.textContent;
    }
    function invoke(name, role) {
      const methods = { signin: ['deepseekSignIn', 'roleDeepseekSignIn'], cancel: ['deepseekCancelSignIn', 'roleDeepseekCancelSignIn'],
        disconnect: ['deepseekDisconnect', 'roleDeepseekDisconnect'], retry: ['deepseekRetryStorage', 'roleDeepseekRetryStorage'] };
      const method = methods[name]?.[role == null ? 0 : 1];
      if (typeof bridge[method] !== 'function') throw new Error('当前版本暂不支持 DeepSeek 账号登录。');
      return role == null ? bridge[method]() : bridge[method]({ role });
    }
    async function run(name) {
      if (disposed || isBusy() || busy()) return;
      if (name === 'signin' && account().storageRecovery === true) { render(); return; }
      const role = getRole(); activeRole = role; action = name; localError = ''; onInvalidate(role); render(); onChange();
      try {
        const next = await invoke(name, role);
        if (!disposed && next?.settings) onState(next);
      } catch (error) { if (!disposed) localError = errorMessage(error); }
      finally { action = null; cancelling = false; activeRole = null; if (!disposed) { render(); onChange(); } }
    }
    async function cancel() {
      if (disposed || cancelling || !signing()) return;
      cancelling = true; localError = ''; render(); onChange();
      try {
        const next = await invoke('cancel', action ? activeRole : getRole());
        if (!disposed && next?.settings) onState(next);
        else if (!disposed && typeof bridge.getState === 'function') onState(await bridge.getState());
      } catch (error) { if (!disposed) localError = errorMessage(error); }
      finally { cancelling = false; if (!disposed) { render(); onChange(); } }
    }
    const changed = () => { localError = ''; onModeChange(); render(); };
    mode.addEventListener('change', changed); render();
    return Object.freeze({ render, isBusy: busy, isCancelling: () => cancelling,
      fill(value = 'apiKey') { mode.value = value === 'deepseek-account' ? value : 'apiKey'; localError = ''; render(); },
      clearError() { localError = ''; render(); },
      destroy() { if (disposed) return; disposed = true; mode.removeEventListener('change', changed); modeField.remove(); panel.remove(); },
    });
  }
  root.ForgeDeepSeekLogin = Object.freeze({ create, errorMessage, officialURL: OFFICIAL_URL });
})(typeof globalThis === 'object' ? globalThis : this);
