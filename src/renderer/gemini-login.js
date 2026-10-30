'use strict';
(function (root) {
  const messages = Object.freeze({
    GEMINI_STORAGE_UNREADABLE: '无法读取本机保存的 Google 连接信息，原信息已保留，请重试读取。',
    GEMINI_CLI_UNAVAILABLE: 'Gemini 登录组件暂不可用，请重新检测或更新软件。',
    GEMINI_CLI_INCOMPATIBLE: 'Gemini 登录组件版本不匹配，请更新软件。',
    GEMINI_CLIENT_UNSUPPORTED: 'Google 已停止个人及 Google AI Pro/Ultra 账号的旧 Gemini CLI 服务。请使用官方 Antigravity，或在 Cortex 中改用 Gemini API Key。',
    GEMINI_REGION_UNAVAILABLE: 'Google 服务明确提示当前地区不可用，请按 Google 官方要求使用可用服务。',
    GEMINI_ACCESS_DENIED: '当前 Google 账号被拒绝访问 Gemini 服务，请检查账号权限。',
    GEMINI_CLI_REQUEST_FAILED: 'Gemini 账号服务请求失败，请检查当前账号额度或网络后重试。',
    GEMINI_CLI_EXITED: 'Gemini 登录组件意外退出，请重新连接。',
    GEMINI_PROXY_FAILED: '无法读取或应用当前网络代理，请检查代理设置后重试。',
    GEMINI_SIGN_IN_FAILED: 'Google 账号登录未完成，请重新连接。',
    GEMINI_AUTH_FAILED: '浏览器授权后，Gemini 未能完成账号服务验证，请检查账号可用性和网络后重试。',
    GEMINI_SESSION_FAILED: 'Google 账号已连接，但 Gemini 会话创建失败，请刷新模型目录后重试。',
    GEMINI_ACCOUNT_VALIDATION_REQUIRED: 'Google 要求额外验证此账号，请先在 Google 官方页面完成账号验证后重试。',
    GEMINI_SERVICE_UNAVAILABLE: 'Google 授权后，Gemini 服务初始化未返回有效结果，请检查代理后重试。',
    GEMINI_ACCOUNT_ACTION_REQUIRED: '请先在 Google 官方页面完成账号条款确认，再重新连接。',
    GEMINI_QUOTA_EXCEEDED: 'Google 账号当前额度不足或请求受限，请稍后重试。',
    GEMINI_LOGIN_EXPIRED: '本次 Google 登录已过期，请重新登录。',
    GEMINI_NETWORK_ERROR: '无法连接 Google，请检查网络后重试。',
    GEMINI_AUTH_REQUIRED: 'Google 账号需要重新授权，请重新连接。',
    GEMINI_SIGN_IN_REQUIRED: 'Google 账号需要重新授权，请重新连接。',
    GEMINI_TIMEOUT: 'Google 连接超时，请检查网络后重试。',
    GEMINI_INVALID_RESPONSE: 'Gemini 登录组件返回的数据格式无效，请更新软件或重新连接。',
    GEMINI_ACCOUNT_CHANGED: 'Google 账号已变化，请重新选择模型后重试。',
    GEMINI_MODEL_UNAVAILABLE: '当前 Google 账号未列出所选模型，请刷新模型目录。',
    GEMINI_UNEXPECTED_TOOL: 'Gemini 登录组件请求了不受支持的操作，连接已停止。',
    GEMINI_INVALID_CONFIG: 'Gemini 连接配置无效，请重新选择模型后重试。',
    GEMINI_INVALID_INPUT: 'Gemini 请求内容格式无效，请重新输入后重试。',
    GEMINI_IMAGES_UNSUPPORTED: 'Google 账号模式暂不支持图片，请改用 Gemini API Key。',
    GEMINI_REASONING_UNSUPPORTED: 'Google 账号模式使用模型默认思考设置，请恢复默认后重试。',
    GEMINI_INPUT_TOO_LARGE: '本次对话过长，请压缩上下文后重试。',
    GEMINI_RESPONSE_TOO_LARGE: 'Gemini 回复过长，请缩小问题后重试。',
    GEMINI_BUSY: '另一项 Google 账号操作正在进行，请稍后重试。',
    GEMINI_CLOSED: 'Google 连接已关闭，请重新打开模型设置后连接。',
    GEMINI_PROJECT_REQUIRED: '该账号需要 Google Cloud 项目配置，请按官方认证要求完成配置后重试。',
    GEMINI_CANCELLED: '',
  });
  const errorPhases = Object.freeze({ initialize: '初始化登录组件', authenticate: 'Google 授权',
    'session-new': '建立账号会话', 'model-list': '读取模型目录', storage: '保存连接', prompt: '发送模型请求' });
  function errorDetails(value) {
    // Electron invoke retains Error.message but can remove custom code/phase.
    // Read only the bounded code marker; OAuth/CLI text is never displayed.
    const encoded = typeof value === 'string' ? value.slice(0, 8192) : typeof value?.message === 'string' ? value.message.slice(0, 8192) : '';
    const code = typeof value?.code === 'string' && /^GEMINI_[A-Z_]{1,64}$/u.test(value.code) ? value.code
      : encoded.match(/\[(GEMINI_[A-Z_]{1,64})\]/u)?.[1] || encoded.match(/\bGEMINI_[A-Z_]{1,64}\b/u)?.[0];
    const recognized = Object.hasOwn(messages, code);
    const phase = typeof value?.phase === 'string' && Object.hasOwn(errorPhases, value.phase) ? value.phase : null;
    const message = recognized ? messages[code] : value ? 'Google 账号连接未完成，请重试。' : '';
    return { code, phase, recognized, message: message && phase ? `${errorPhases[phase]}失败：${message}` : message };
  }
  const errorMessage = value => errorDetails(value).message;
  function create({ document = root.document, bridge, getScope, getRole = () => null, isBusy = () => false,
    onState = () => {}, onChange = () => {}, onInvalidate = () => {}, onModeChange = () => {}, onRefreshModels = () => {} }) {
    const $ = id => document.getElementById(id);
    const el = (tag, id, className, text) => {
      const node = document.createElement(tag); if (id) node.id = id; if (className) node.className = className;
      if (text !== undefined) node.textContent = text; return node;
    };
    const modeField = el('label', 'gemini-auth-mode-field', 'form-field'); modeField.hidden = true;
    const mode = el('select', 'gemini-auth-mode'); mode.name = 'geminiAuthMode';
    for (const [value, label] of [['apiKey', 'API Key'], ['antigravity-agent', '账号登录']]) {
      const option = el('option', '', '', label); option.value = value; mode.append(option);
    }
    mode.value = 'apiKey'; modeField.append(el('span', '', '', '连接方式'), mode); $('openai-auth-mode-field').after(modeField);
    const panel = el('section', 'gemini-login-panel', 'gemini-login-panel'); panel.hidden = true; panel.setAttribute('aria-label', 'Google 账号连接');
    const status = el('strong', 'gemini-login-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const help = el('p', 'gemini-login-help', 'gemini-login-help', '个人及 Google AI Pro/Ultra 账号的旧 Gemini CLI 服务已停用，请使用官方 Antigravity。Cortex 可通过 Gemini API Key 连接。');
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
    addButton('use-api-key', '使用 API Key', () => {
      if (disposed || buttons['use-api-key'].disabled) return;
      mode.value = 'apiKey'; changed();
    });
    const message = el('p', 'gemini-login-message', 'gemini-login-message'); message.hidden = true; message.setAttribute('role', 'status');
    panel.append(status, help, actions, message); $('base-url-field').before(panel);
    let action = null, activeRole = null, cancelling = false, cancelRequested = false, localError = null, disposed = false;
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
      for (const option of mode.children) if (option.value === 'antigravity-agent') { option.disabled = getRole() != null; option.title = getRole() != null ? '官方代理仅用于主会话；请为此功能配置 API 模型。' : ''; }
      const phases = { initializing: '正在准备 Google 登录…', starting: '正在准备 Google 登录…', 'waiting-browser': '等待 Google 浏览器授权',
        authenticating: '正在完成 Google 授权…', exchanging: '正在完成 Google 授权…', committing: '正在保存连接…',
        initialize: '正在准备 Google 登录…', authenticate: '正在完成 Google 授权…',
        'session-new': '正在建立账号会话…', 'model-list': '正在读取账号模型目录…', storage: '正在保存连接…' };
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
      const published = errorDetails(value.error || session.error);
      // An unencoded IPC error must not hide the structured phase/code sent by
      // the account state event after a failed authorization attempt.
      const richerPublished = (published.recognized || published.phase) && (!localError?.recognized || published.code === localError.code);
      const displayError = richerPublished ? published : localError || published;
      message.textContent = displayError.message;
      message.hidden = !message.textContent;
      buttons['use-api-key'].hidden = panel.hidden || displayError.code !== 'GEMINI_CLIENT_UNSUPPORTED';
      buttons['use-api-key'].disabled = locked;
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
      const role = getRole(); activeRole = role; action = name; cancelRequested = false; localError = null; onInvalidate(role); render(); onChange();
      try { const next = await invoke(name, role); if (!disposed && next?.settings) onState(next); }
      catch (failure) { if (!disposed && !cancelRequested) localError = errorDetails(failure); }
      finally { action = null; activeRole = null; cancelling = false; if (!disposed) { render(); onChange(); } }
    }
    async function cancel() {
      if (disposed || cancelling || !signing()) return;
      cancelling = true; cancelRequested = true; localError = null; render(); onChange();
      try {
        const next = await invoke('cancel', action ? activeRole : getRole());
        if (!disposed && next?.settings) onState(next);
        else if (!disposed && typeof bridge.getState === 'function') onState(await bridge.getState());
      } catch (failure) { if (!disposed) localError = errorDetails(failure); }
      finally { cancelling = false; if (!disposed) { render(); onChange(); } }
    }
    const changed = () => { localError = null; onModeChange(); render(); };
    mode.addEventListener('change', changed); render();
    return Object.freeze({ render, isBusy: busy, isCancelling: () => cancelling,
      // A saved legacy connection remains on disk. Opening this form only
      // chooses an editable draft; it never migrates credentials or signs in.
      fill(value = 'apiKey') { mode.value = value === 'antigravity-agent' && getRole() == null ? value : 'apiKey'; localError = null; render(); },
      clearError() { localError = null; render(); },
      destroy() { if (disposed) return; disposed = true; mode.removeEventListener('change', changed); modeField.remove(); panel.remove(); },
    });
  }
  root.ForgeGeminiLogin = Object.freeze({ create, errorMessage });
})(typeof globalThis === 'object' ? globalThis : this);
