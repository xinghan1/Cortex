'use strict';
(function (root) {
  const messages = Object.freeze({
    GEMINI_STORAGE_UNREADABLE: '无法读取本机保存的 Google 连接信息，原信息已保留，请重试读取。',
    GEMINI_CLI_UNAVAILABLE: 'Gemini 登录组件暂不可用，请重新检测或更新软件。',
    GEMINI_CLI_INCOMPATIBLE: 'Gemini 登录组件版本不匹配，请更新软件。',
    GEMINI_LOGIN_EXPIRED: '本次 Google 登录已过期，请重新登录。',
    GEMINI_NETWORK_ERROR: '无法连接 Google，请检查网络后重试。',
    GEMINI_AUTH_REQUIRED: 'Google 账号需要重新授权，请重新连接。',
    GEMINI_SIGN_IN_REQUIRED: 'Google 账号需要重新授权，请重新连接。',
    GEMINI_TIMEOUT: 'Google 连接超时，请检查网络后重试。',
    GEMINI_INVALID_RESPONSE: 'Gemini 未返回有效回复，请刷新模型目录后重试。',
    GEMINI_PROJECT_REQUIRED: '该账号需要 Google 官方的项目配置，请按官方认证要求完成配置后重试。',
    GEMINI_CANCELLED: '',
  });
  function errorMessage(value) {
    const code = typeof value?.code === 'string' ? value.code : String(value?.message || value || '').match(/\bGEMINI_[A-Z_]+\b/u)?.[0];
    return Object.hasOwn(messages, code) ? messages[code] : value ? 'Google 账号连接未完成，请重试。' : '';
  }
  function create({ document = root.document, bridge, getScope, getRole = () => null, isBusy = () => false,
    onState = () => {}, onChange = () => {}, onInvalidate = () => {}, onModeChange = () => {}, onRefreshModels = () => {} }) {
    const $ = id => document.getElementById(id);
    const el = (tag, id, className, text) => {
      const node = document.createElement(tag); if (id) node.id = id; if (className) node.className = className;
      if (text !== undefined) node.textContent = text; return node;
    };
    const modeField = el('label', 'gemini-auth-mode-field', 'form-field'); modeField.hidden = true;
    const mode = el('select', 'gemini-auth-mode'); mode.name = 'geminiAuthMode';
    for (const [value, label] of [['apiKey', 'API Key'], ['gemini-account', 'Google 账号 · Gemini CLI']]) {
      const option = el('option', '', '', label); option.value = value; mode.append(option);
    }
    mode.value = 'apiKey'; modeField.append(el('span', '', '', '连接方式'), mode); $('openai-auth-mode-field').after(modeField);
    const panel = el('section', 'gemini-login-panel', 'gemini-login-panel'); panel.hidden = true; panel.setAttribute('aria-label', 'Google 账号连接');
    const status = el('strong', 'gemini-login-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const help = el('p', 'gemini-login-help', 'gemini-login-help', '使用官方 Gemini CLI 账号额度。可用模型与额度以当前账号为准。');
    const actions = el('div', '', 'gemini-login-actions'), buttons = {};
    const addButton = (name, label, callback, className = 'button') => {
      const button = el('button', 'gemini-login-' + name, className, label); button.type = 'button'; button.addEventListener('click', callback); actions.append(button); buttons[name] = button;
    };
    addButton('sign-in', '使用 Google 账号登录', () => run('signin'), 'button solid');
    addButton('cancel', '取消登录', cancel);
    addButton('reconnect', '重新连接', () => run('signin'));
    addButton('disconnect', '退出账号', () => run('disconnect'));
    addButton('retry', '重试读取', () => run('retry'));
    addButton('models', '刷新模型目录', () => { if (!buttons.models.disabled) return onRefreshModels(); }, 'text-button');
    const message = el('p', 'gemini-login-message', 'gemini-login-message'); message.hidden = true; message.setAttribute('role', 'status');
    panel.append(status, help, actions, message); $('base-url-field').before(panel);
    let action = null, activeRole = null, cancelling = false, cancelRequested = false, localError = '', disposed = false;
    const account = () => getScope()?.gemini || {};
    const signing = () => action === 'signin' || account().session?.status === 'connecting';
    const busy = () => !!action || account().session?.status === 'connecting';
    function render() {
      if (disposed) return;
      const value = account(), session = value.session || {}, connecting = signing();
      const unavailable = value.cli?.available === false;
      const storage = value.storageRecovery === true || /^GEMINI_(?:STORAGE|ENCRYPTION)_/u.test(value.error?.code || '');
      const connected = session.status === 'connected' && session.sharing === true, locked = isBusy() || busy();
      modeField.hidden = $('provider-select').value !== 'gemini'; panel.hidden = modeField.hidden || mode.value !== 'gemini-account'; mode.disabled = locked;
      const phases = { initializing: '正在准备 Google 登录…', starting: '正在准备 Google 登录…', 'waiting-browser': '等待 Google 浏览器授权',
        authenticating: '正在完成 Google 授权…', exchanging: '正在完成 Google 授权…', committing: '正在保存连接…' };
      status.textContent = connecting ? phases[value.attempt?.phase] || '等待 Google 浏览器授权'
        : storage ? '本机连接信息读取失败' : unavailable ? 'Gemini 登录组件暂不可用' : connected ? 'Google 账号已连接'
        : session.status === 'reauth_required' ? 'Google 账号需要重新授权' : '尚未连接 Google 账号';
      buttons['sign-in'].hidden = connecting || connected || storage;
      buttons['sign-in'].disabled = locked || unavailable;
      buttons.cancel.hidden = !connecting; buttons.cancel.disabled = cancelling;
      buttons.reconnect.hidden = connecting || storage || !['connected', 'reauth_required'].includes(session.status);
      buttons.reconnect.disabled = locked || unavailable;
      buttons.disconnect.hidden = connecting || !(session.profileId || storage || ['connected', 'reauth_required'].includes(session.status));
      buttons.disconnect.disabled = locked;
      buttons.retry.hidden = !storage && !unavailable; buttons.retry.disabled = locked;
      buttons.retry.textContent = action === 'retry' ? '检测中…' : unavailable ? '重新检测' : '重试读取';
      buttons.models.disabled = locked || unavailable || !connected;
      message.textContent = localError || errorMessage(value.error || session.error); message.hidden = !message.textContent;
    }
    function invoke(name, role) {
      const methods = { signin: ['geminiSignIn', 'roleGeminiSignIn'], cancel: ['geminiCancelSignIn', 'roleGeminiCancelSignIn'],
        disconnect: ['geminiDisconnect', 'roleGeminiDisconnect'], retry: ['geminiRetryStorage', 'roleGeminiRetryStorage'] };
      const method = methods[name]?.[role == null ? 0 : 1];
      if (typeof bridge[method] !== 'function') throw new Error('Google 账号连接暂不可用。');
      return role == null ? bridge[method]() : bridge[method]({ role });
    }
    async function run(name) {
      if (disposed || isBusy() || busy()) return;
      if (name === 'signin' && (account().storageRecovery === true || account().cli?.available === false)) return;
      const role = getRole(); activeRole = role; action = name; cancelRequested = false; localError = ''; onInvalidate(role); render(); onChange();
      try { const next = await invoke(name, role); if (!disposed && next?.settings) onState(next); }
      catch (failure) { if (!disposed && !cancelRequested) localError = errorMessage(failure); }
      finally { action = null; activeRole = null; cancelling = false; if (!disposed) { render(); onChange(); } }
    }
    async function cancel() {
      if (disposed || cancelling || !signing()) return;
      cancelling = true; cancelRequested = true; localError = ''; render(); onChange();
      try {
        const next = await invoke('cancel', action ? activeRole : getRole());
        if (!disposed && next?.settings) onState(next);
        else if (!disposed && typeof bridge.getState === 'function') onState(await bridge.getState());
      } catch (failure) { if (!disposed) localError = errorMessage(failure); }
      finally { cancelling = false; if (!disposed) { render(); onChange(); } }
    }
    const changed = () => { localError = ''; onModeChange(); render(); };
    mode.addEventListener('change', changed); render();
    return Object.freeze({ render, isBusy: busy, isCancelling: () => cancelling,
      fill(value = 'apiKey') { mode.value = value === 'gemini-account' ? value : 'apiKey'; localError = ''; render(); },
      clearError() { localError = ''; render(); },
      destroy() { if (disposed) return; disposed = true; mode.removeEventListener('change', changed); modeField.remove(); panel.remove(); },
    });
  }
  root.ForgeGeminiLogin = Object.freeze({ create, errorMessage });
})(typeof globalThis === 'object' ? globalThis : this);
