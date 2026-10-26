'use strict';
(function (root) {
  const messages = Object.freeze({
    CLAUDE_RUNTIME_MISSING: 'Claude 官方组件不可用，请重新安装新版，或安装官方 Claude Code 后重试。',
    CLAUDE_RUNTIME_OUTDATED: '本机 Claude Code 版本过旧，请更新官方组件后重试。',
    CLAUDE_SDK_MISSING: 'Claude 组件不完整，请重新安装新版。',
    CLAUDE_AUTH_FAILED: 'Claude 官方账号授权未完成，请重新登录。',
    CLAUDE_AUTH_REQUIRED: 'Claude 账号需要重新授权，请重新登录。',
    CLAUDE_USAGE_LIMIT: 'Claude 官方额度不足或请求受限，请在官方账号中核对套餐与计费。',
    CLAUDE_EFFORT_UNSUPPORTED: '官方 Claude 未提供所选推理档位，请刷新模型目录。',
    CLAUDE_STORAGE_UNREADABLE: '无法读取本机 Claude 连接，请重试读取。',
    CLAUDE_TASK_INCOMPLETE: 'Claude 官方任务未完成，请查看会话流程后重试。',
    CLAUDE_CANCELLED: '',
    ARK_RUNTIME_MISSING: '火山方舟登录组件不可用，请重新安装新版。',
    ARK_SIGN_IN_REQUIRED: '请重新登录火山方舟并连接可用配置。',
    ARK_AUTH_FAILED: '火山方舟官方授权未完成，请重新登录。',
    ARK_AUTH_CODE_INVALID: '授权码无效或已失效，请从当前官方授权页面重新复制授权码后提交。',
    ARK_AUTH_EXCHANGE_FAILED: '授权码验证未完成，请检查网络后重新提交；如授权码已失效，请从当前官方页面重新复制。',
    ARK_AUTH_EXPIRED: '本次授权已过期，请重新登录火山方舟。',
    ARK_BROWSER_OPEN_FAILED: '无法打开官方授权页面，请检查默认浏览器后点击“打开授权页面”重试。',
    ARK_RUNTIME_KEY_UNAVAILABLE: '账号已授权，但当前配置没有可用的模型调用密钥，请在官方控制台开通对应 API 或 Plan。',
    ARK_PROFILE_UNSUPPORTED: '当前火山方舟配置暂不支持，请选择北京区域的 API、Agent Plan 或 Coding Plan。',
    ARK_CATALOG_EMPTY: '当前配置未提供可调用的文本模型或接入点，请核对官方套餐与模型配置。',
    ARK_STORAGE_LOCKED: '本机安全加密不可用，账号连接未保存，请重试。',
    ARK_STORAGE_UNREADABLE: '无法读取本机火山方舟连接，请重试读取。',
    ARK_ACCOUNT_CHANGED: '火山方舟账号或套餐配置已改变，请重新连接。',
    ARK_CANCELLED: '',

    ZCODE_RUNTIME_MISSING: 'GLM 组件准备失败，请点击“准备组件”重试，或重新安装新版；账号连接已保留。',
    KIMI_SUBSCRIPTION_REQUIRED: '账号已登录，但当前订阅没有 Kimi Code 访问权限，请在官方账号中确认 Coding 套餐。',
    ZCODE_AUTH_URL_INVALID: '官方代理返回的授权地址无效，请重试登录。',
    ZCODE_BROWSER_OPEN_FAILED: '无法打开官方授权页面，请检查默认浏览器后重试。',
    ZCODE_CATALOG_EMPTY: 'ZCode 已连接，但官方会话没有返回可选模型，请刷新目录或检查账号权限。',
    ZCODE_QUOTA_UNAVAILABLE: 'GLM 官方返回余额或可用资源包不足（1113），请在官方账号页面核对当前套餐与余额。',
    ZCODE_PLAN_EXPIRED: 'GLM 官方返回套餐已到期或失效，请在官方账号页面检查套餐状态。',
    ZCODE_PLAN_LIMIT: 'GLM 官方返回套餐用量已达到上限，请在官方账号页面查看额度与重置时间。',
    ZCODE_MODEL_ACCESS_REQUIRED: 'GLM 官方账号当前没有所选模型或调用方式的权限，请检查套餐权益或选择其他可用模型。',
    ZCODE_RATE_LIMITED: 'GLM 官方当前限制请求频率或模型繁忙，请稍后重试；持续受限时请在官方账号页面检查限制。',
    ZCODE_REQUEST_LIMITED: 'GLM 官方暂时限制了本次请求（429），请检查账号额度或稍后重试。',
    ZCODE_CONTEXT_EXCEEDED: '官方 ZCode 请求超过模型上下文容量，请缩短本次内容或新建会话。',
    ZCODE_NETWORK_ERROR: '官方 ZCode 无法完成网络连接，请检查代理与网络后重试。',
    ZCODE_SERVICE_UNAVAILABLE: 'GLM 官方服务暂时不可用，请稍后重试。',
    AGY_RUNTIME_UNSUPPORTED: '当前系统暂不支持 Antigravity 官方代理。',
    AGY_DOWNLOAD_FAILED: '官方代理下载失败，请检查网络后重试。',
    AGY_DOWNLOAD_TIMEOUT: '官方代理下载超时，请检查代理节点后重试。',
    AGY_DOWNLOAD_PROXY: '无法通过当前系统代理下载，请检查代理节点和系统代理设置后重试。',
    AGY_DOWNLOAD_TLS: '下载连接的安全证书校验失败，请检查代理或系统证书后重试。',
    AGY_DOWNLOAD_DNS: '无法解析官方下载地址，请检查代理或 DNS 设置后重试。',
    AGY_INTEGRITY_FAILED: '官方代理校验失败，请重新下载。',
    AGY_ARCHIVE_INVALID: '官方代理安装包无效，请重新下载。',
    AGY_STORAGE_ERROR: '无法读取或保存本机代理配置，请重试读取。',
    AGY_RUNTIME_MISSING: '请先下载 Antigravity 官方代理。',
    AGY_PROTOCOL_ERROR: '官方代理响应格式不匹配，请更新软件或重试。',
    AGY_START_FAILED: '无法启动官方代理，请重试或重新下载。',
    AGY_EXITED: '官方代理意外退出，请重新连接。',
    AGY_TIMEOUT: '官方代理等待超时，请检查网络后重试。',
    AGY_AUTH_REQUIRED: '请在官方页面连接 Google 账号。',
    AGY_AUTH_FAILED: '官方代理未能完成账号授权，请检查账号后重试。',
    AGY_BUSY: '另一项官方代理操作正在进行，请稍后重试。',
    AGY_SESSION_CHANGED: '官方代理连接已变化，请重新选择模型。',
    AGY_MODEL_UNAVAILABLE: '此账号暂未提供所选模型，请刷新模型目录。',
    AGY_CATALOG_EMPTY: 'Antigravity 已连接，但官方会话没有返回可选模型，请刷新目录或检查账号权限。',
    AGY_MODE_UNAVAILABLE: '官方代理仅用于主会话，请为其他功能单独配置 API 模型。',
    AGY_INVALID_INPUT: '任务内容格式无效，请检查后重试。',
    AGY_IMAGES_UNSUPPORTED: '当前官方代理模式暂不支持图片，请改用 Gemini API Key。',
    AGY_RESPONSE_TOO_LARGE: '官方代理回复过长，请缩小任务后重试。',
    AGY_CLOSED: '官方代理连接已关闭，请重新连接。',
    AGY_PROXY_FAILED: '无法使用当前网络代理，请检查代理设置后重试。',
    AGY_REQUEST_FAILED: '官方代理请求未完成，请检查账号和网络后重试。',
    AGY_CALLBACK_FAILED: '官方代理界面连接中断，本次操作已停止，请重试。',
    AGY_ACCESS_DENIED: 'Google 拒绝了当前账号的访问，请检查账号权限。',
    AGY_CLIENT_UNSUPPORTED: 'Google 服务不再支持此代理版本，请更新软件。',
    AGY_PROJECT_REQUIRED: '此账号需要 Google 官方项目配置，请按官方要求配置后重试。',
    AGY_ACCOUNT_VALIDATION_REQUIRED: 'Google 要求验证当前账号，请先在官方页面完成验证。',
    AGY_QUOTA_EXCEEDED: '当前账号额度不足或请求受限，请稍后重试。',
    AGY_NETWORK_ERROR: '无法连接 Google 服务，请检查网络后重试。',
    AGY_SERVICE_UNAVAILABLE: 'Google 服务暂不可用，请稍后重试。',
    AGY_REGION_UNAVAILABLE: 'Google 服务明确提示当前地区不可用，请按官方要求使用可用服务。',
    AGY_ACCOUNT_ACTION_REQUIRED: '请先在 Google 官方页面完成账号条款确认。',
    AGY_CANCELLED: '',
  });
  function errorCode(value) {
    const encoded = typeof value === 'string' ? value.slice(0, 8192) : typeof value?.message === 'string' ? value.message.slice(0, 8192) : '';
    return typeof value?.code === 'string' && /^(?:AGY|KIMI|ZCODE|CLAUDE|ARK)_[A-Z_]{1,64}$/u.test(value.code) ? value.code : encoded.match(/\[((?:AGY|KIMI|ZCODE|CLAUDE|ARK)_[A-Z_]{1,64})\]/u)?.[1];
  }
  function errorMessage(value) { const code = errorCode(value); return Object.hasOwn(messages, code) ? messages[code] : value ? '官方代理操作未完成，请重试。' : ''; }
  function formatBytes(value) {
    if (!Number.isSafeInteger(value) || value < 0) return '—';
    const units = ['B', 'KB', 'MB', 'GB']; let size = value, index = 0;
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
    return `${index ? size.toFixed(size < 10 ? 1 : 0) : size} ${units[index]}`;
  }
  function create({ document = root.document, bridge, getScope, getRole = () => null, isBusy = () => false, descriptor = {},
    onState = () => {}, onChange = () => {}, onInvalidate = () => {}, onModeChange = () => {}, onRefreshModels = () => {} }) {
    const spec = { provider: 'gemini', authMode: 'antigravity-agent', stateKey: 'antigravity', prefix: 'antigravity', name: 'Antigravity',
      modeId: 'gemini-auth-mode', bridgePrefix: 'antigravity', errorPrefix: 'AGY_', regions: [], ...descriptor };
    const messageFor = value => {
      const code = errorCode(value), normalized = code?.startsWith(spec.errorPrefix) ? 'AGY_' + code.slice(spec.errorPrefix.length) : null;
      if (code?.startsWith(spec.errorPrefix) && Object.hasOwn(messages, code)) return messages[code];
      if (spec.errorPrefix === 'AGY_') return errorMessage(value);
      const message = Object.hasOwn(messages, normalized) ? messages[normalized] : value ? '官方代理操作未完成，请重试。' : '';
      return message.replaceAll('Antigravity', spec.name).replaceAll('Google', spec.name).replaceAll('Gemini API Key', `${spec.name} API Key`);
    };
    const $ = id => document.getElementById(id);
    const el = (tag, id, text) => { const value = document.createElement(tag); if (id) value.id = id; if (text !== undefined) value.textContent = text; return value; };
    const mode = $(spec.modeId), panel = el('section', spec.prefix + '-login-panel'); panel.className = 'antigravity-login-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', `${spec.name} 官方代理`);
    const status = el('strong', spec.prefix + '-login-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const help = el('p', spec.prefix + '-login-help', spec.help || `由 ${spec.name} 官方代理完整执行主会话任务。在官方页面连接${spec.provider === 'gemini' ? ' Google ' : ''}账号，可用模型与额度以官方账号为准。`); help.className = 'official-agent-help';
    const version = el('small', spec.prefix + '-runtime-version'); version.className = 'official-agent-version';
    const download = el('div', spec.prefix + '-download'), progress = el('progress', spec.prefix + '-download-progress'), downloadSize = el('span', spec.prefix + '-download-size');
    download.className = 'official-agent-download'; progress.className = 'official-agent-progress'; downloadSize.className = 'official-agent-download-size';
    progress.setAttribute('aria-label', '官方代理下载进度'); download.append(progress, downloadSize);
    const actions = el('div'); actions.className = 'antigravity-login-actions';
    const buttons = {}, add = (id, text, handler) => {
      const button = el('button', spec.prefix + '-' + id, text); button.type = 'button'; button.className = 'button'; button.addEventListener('click', handler); buttons[id] = button; actions.append(button);
    };
    add('install', spec.installLabel || '准备登录组件', () => run('install'));
    add('sign-in', spec.provider === 'gemini' ? '使用 Google 账号登录' : '账号登录', () => run('signin'));
    add('cancel-sign-in', '取消连接', cancel);
    add('disconnect', '断开本机连接', () => run('disconnect'));
    add('retry', '重试读取', () => run('retry'));
    add('models', '刷新模型目录', () => { if (!buttons.models.disabled) return onRefreshModels(); });
    const message = el('p', spec.prefix + '-login-message'); message.className = 'official-agent-message'; message.setAttribute('role', 'status');
    const verification = el('div', spec.prefix + '-verification'); verification.className = 'official-agent-verification'; verification.hidden = true;
    const verificationUrl = el('p', spec.prefix + '-verification-url'), userCode = el('code', spec.prefix + '-user-code'); verification.append(verificationUrl, userCode);
    const authorizationField = spec.provider === 'doubao' ? el('div', 'ark-authorization-field') : null;
    const codeInput = authorizationField ? el('input', 'ark-code-input') : null;
    const codeSubmit = authorizationField ? el('button', 'ark-code-submit', '提交授权码') : null;
    const authorizationOpen = authorizationField ? el('button', 'ark-open-authorization', '打开授权页面') : null;
    if (authorizationField) {
      authorizationField.className = 'form-field'; authorizationField.hidden = true;
      codeInput.type = 'password'; codeInput.autocomplete = 'off'; codeInput.spellcheck = false; codeInput.maxLength = 16384;
      codeInput.setAttribute('autocapitalize', 'none'); codeInput.setAttribute('aria-label', '火山方舟官方授权码'); codeInput.placeholder = '粘贴官方页面返回的授权码';
      codeSubmit.type = 'button'; codeSubmit.className = 'button solid'; authorizationOpen.type = 'button'; authorizationOpen.className = 'button';
      authorizationField.append(el('p', '', '在官方页面完成登录后，复制授权码并粘贴到下方。授权码仅用于本次连接。'), authorizationOpen, codeInput, codeSubmit);
      codeInput.addEventListener('input', () => { localError = null; render(); });
      codeInput.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); void submitAuthorizationCode(); } });
      codeSubmit.addEventListener('click', submitAuthorizationCode); authorizationOpen.addEventListener('click', openAuthorization);
    }
    const regionField = spec.regions.length ? el('label', spec.prefix + '-region-field') : null;
    const region = regionField ? el('select', spec.prefix + '-region') : null;
    if (regionField) {
      regionField.className = 'form-field'; regionField.append(el('span', '', '账号地区'));
      for (const [value, label] of spec.regions) { const option = el('option', '', label); option.value = value; region.append(option); }
      region.value = spec.regions[0][0]; regionField.append(region); $('base-url-field').before(regionField);
    }
    const profileField = spec.provider === 'doubao' ? el('div', 'ark-profile-field') : null;
    const profileSelect = profileField ? el('select', 'ark-profile-select') : null;
    const profileConfirm = profileField ? el('button', 'ark-profile-confirm', '连接此配置') : null;
    if (profileField) {
      profileField.className = 'form-field'; profileSelect.setAttribute('aria-label', '火山方舟 API 或套餐配置');
      profileConfirm.type = 'button'; profileConfirm.className = 'button solid';
      profileField.append(el('span', '', '选择账号配置'), profileSelect, profileConfirm);
      profileSelect.addEventListener('change', () => render());
      profileConfirm.addEventListener('click', chooseProfile);
    }
    panel.append(status, help, version, download, verification, ...(authorizationField ? [authorizationField] : []), ...(profileField ? [profileField] : []), actions, message); $('base-url-field').before(panel);
    let action = null, cancelling = false, cancelled = false, localError = null, disposed = false;
    let regionDirty = false, choosingProfile = false, profileSnapshot = '', submittingCode = false, openingAuthorization = false, authorizationSnapshot = '';
    const account = () => getScope()?.[spec.stateKey] || {};
    const validRegion = value => spec.regions.some(([id]) => id === value);
    const signing = () => action === 'signin' || account().session?.status === 'connecting';
    const busy = () => !!action || signing() || account().runtime?.status === 'downloading';
    const waitingForCode = () => !!authorizationField && !disposed && getRole() == null && $('provider-select').value === spec.provider
      && mode?.value === spec.authMode && account().session?.status === 'connecting' && account().attempt?.phase === 'waiting-authorization-code';
    function render() {
      if (disposed) return;
      const value = account(), runtime = value.runtime || {}, session = value.session || {};
      if (region && !regionDirty) region.value = validRegion(value.region) ? value.region : spec.regions[0][0];
      const regionMismatch = !!region && value.region !== region.value;
      const downloading = runtime.status === 'downloading', connecting = signing(), connected = session.status === 'connected' && session.sharing === true && !regionMismatch;
      const locked = isBusy() || busy();
      const selected = $('provider-select').value === spec.provider;
      panel.hidden = !selected || mode?.value !== spec.authMode || getRole() != null;
      if (regionField) { regionField.hidden = panel.hidden; region.disabled = locked; }
      if (spec.provider !== 'gemini') {
        if ($(spec.modeId + '-field')) $(spec.modeId + '-field').hidden = !selected;
        mode.disabled = locked;
        for (const option of mode.children) if (option.value === spec.authMode) option.disabled = getRole() != null;
      }
      const phases = { initialize: '正在启动官方代理…', initializing: '正在启动官方代理…', authenticate: spec.provider === 'gemini' ? '等待 Google 浏览器授权' : '等待官方浏览器授权',
        'waiting-browser': spec.provider === 'gemini' ? '等待 Google 浏览器授权' : '等待官方浏览器授权', 'waiting-authorization-code': '等待粘贴官方页面返回的授权码',
        'exchanging-authorization-code': '正在验证官方授权码…', 'validating-authorization-code': '正在验证官方授权码…',
        'choosing-profile': '请选择要连接的 API 或套餐配置', 'model-list': '正在读取模型目录…', committing: '正在保存本机连接…' };
      status.textContent = downloading ? `正在下载 ${spec.name} 官方代理…` : connecting ? phases[value.attempt?.phase] || '正在连接官方代理…'
        : connected ? `${spec.name} 官方代理已连接` : session.status === 'connected' && regionMismatch ? '请连接所选地区账号'
          : session.status === 'reauth_required' ? '请重新连接账号' : runtime.status === 'ready' ? '官方代理已安装，尚未连接账号' : '尚未安装官方代理';
      version.textContent = typeof runtime.version === 'string' && /^[\da-z.+-]{1,48}$/iu.test(runtime.version) ? `版本 ${runtime.version}` : '';
      version.hidden = !version.textContent;
      download.hidden = !downloading;
      const received = runtime.download?.receivedBytes, total = runtime.download?.totalBytes;
      downloadSize.textContent = `${formatBytes(received)} / ${formatBytes(total)}`;
      if (Number.isSafeInteger(total) && total > 0 && Number.isSafeInteger(received) && received >= 0) { progress.max = total; progress.value = Math.min(total, received); }
      else progress.removeAttribute('value');
      buttons.install.hidden = runtime.status === 'ready'; buttons.install.disabled = locked;
      buttons['sign-in'].hidden = connecting || connected; buttons['sign-in'].disabled = locked;
      buttons['cancel-sign-in'].hidden = !connecting; buttons['cancel-sign-in'].disabled = cancelling;
      buttons.disconnect.hidden = connecting || !(session.profileId || connected || session.status === 'reauth_required'); buttons.disconnect.disabled = locked;
      buttons.retry.hidden = !value.error && runtime.status !== 'error'; buttons.retry.disabled = locked;
      buttons.models.hidden = !connected; buttons.models.disabled = locked || runtime.status !== 'ready';
      if (authorizationField) {
        const waiting = waitingForCode(), snapshot = waiting ? JSON.stringify([value.attempt.verificationUrl || '', value.attempt.expiresAt || '']) : '';
        if (!waiting || snapshot !== authorizationSnapshot) codeInput.value = '';
        authorizationSnapshot = snapshot; authorizationField.hidden = panel.hidden || !waiting;
        const processing = submittingCode || openingAuthorization || cancelling;
        codeInput.disabled = !waiting || processing; codeSubmit.disabled = !waiting || processing || !codeInput.value.trim();
        authorizationOpen.disabled = !waiting || processing || typeof value.attempt.verificationUrl !== 'string' || !value.attempt.verificationUrl;
      }
      if (profileField) {
        const waiting = connecting && value.attempt?.phase === 'choosing-profile';
        const profiles = Array.isArray(value.profiles) ? value.profiles : [];
        const snapshot = JSON.stringify(profiles);
        if (snapshot !== profileSnapshot) {
          const previous = profileSelect.value; profileSelect.replaceChildren();
          const placeholder = el('option', '', '请选择 API 或套餐配置'); placeholder.value = ''; profileSelect.append(placeholder);
          const names = { platform: '按量 API（独立计费）', 'agent-plan': 'Agent Plan', 'agent-plan-team': '团队 Agent Plan', 'coding-plan': 'Coding Plan', 'coding-plan-team': '团队 Coding Plan' };
          for (const profile of profiles) if (typeof profile?.name === 'string' && profile.name.length <= 128) {
            const option = el('option', '', `${names[profile.type] || profile.type} · ${profile.name} · ${profile.region || ''}`);
            option.value = profile.name; profileSelect.append(option);
          }
          profileSelect.value = profiles.some(profile => profile.name === previous) ? previous : ''; profileSnapshot = snapshot;
        }
        profileField.hidden = panel.hidden || !waiting;
        profileSelect.disabled = !waiting || choosingProfile || cancelling;
        profileConfirm.disabled = !waiting || choosingProfile || cancelling || !profileSelect.value;
      }
      const published = value.error || runtime.error, localCode = errorCode(localError), publishedCode = errorCode(published);
      message.textContent = messageFor(publishedCode && (!localCode || localCode === publishedCode) ? published : localError || published);
      message.hidden = !message.textContent;
      let url = null;
      if (spec.allowDeviceCode && connecting && typeof value.attempt?.verificationUrl === 'string' && value.attempt.verificationUrl.length <= 2048) {
        try { const parsed = new URL(value.attempt.verificationUrl); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && spec.verificationHosts?.some(host => parsed.hostname === host || parsed.hostname.endsWith('.' + host))) url = parsed.href; } catch {}
      }
      verificationUrl.textContent = url || ''; userCode.textContent = spec.allowDeviceCode && connecting && typeof value.attempt?.userCode === 'string' && /^[A-Z\d -]{2,64}$/iu.test(value.attempt.userCode) ? value.attempt.userCode : '';
      verification.hidden = !url && !userCode.textContent;
    }
    const methods = { install: 'Install', signin: 'SignIn', disconnect: 'Disconnect', retry: 'RetryStorage' };
    async function run(kind) {
      if (disposed || getRole() != null || isBusy() || busy() || $('provider-select').value !== spec.provider || mode?.value !== spec.authMode) return;
      if (kind === 'signin' && profileSelect) { profileSelect.value = ''; profileSnapshot = ''; }
      action = kind; localError = null; cancelled = false; onInvalidate(); render(); onChange();
      try { const next = await bridge[spec.bridgePrefix + methods[kind]](kind === 'signin' && region ? { region: region.value } : undefined); if (!disposed && next?.settings) onState(next); }
      catch (error) { if (!disposed && !cancelled) localError = { code: errorCode(error) }; }
      finally { action = null; cancelling = false; if (!disposed) { render(); onChange(); } }
    }
    async function chooseProfile() {
      if (disposed || choosingProfile || !profileSelect?.value || account().attempt?.phase !== 'choosing-profile') return;
      choosingProfile = true; localError = null; render();
      try { const next = await bridge.arkSelectProfile({ profileName: profileSelect.value }); if (!disposed && next?.settings) onState(next); }
      catch (error) { if (!disposed) localError = { code: errorCode(error) }; }
      finally { choosingProfile = false; if (!disposed) render(); }
    }
    async function openAuthorization() {
      if (!waitingForCode() || openingAuthorization || submittingCode || cancelling || authorizationOpen.disabled) return;
      openingAuthorization = true; localError = null; render(); onChange();
      try { const next = await bridge.arkOpenAuthorization(); if (!disposed && !cancelled && next?.settings) onState(next); }
      catch (error) { if (!disposed && !cancelled) localError = { code: errorCode(error) }; }
      finally { openingAuthorization = false; if (!disposed) { render(); onChange(); } }
    }
    async function submitAuthorizationCode() {
      if (!waitingForCode() || submittingCode || openingAuthorization || cancelling) { if (codeInput) codeInput.value = ''; return; }
      let code = codeInput.value.trim(); codeInput.value = '';
      if (!code || code.length > 16384 || !/^[A-Za-z\d+/_-]+={0,2}$/u.test(code)) { localError = { code: 'ARK_AUTH_CODE_INVALID' }; code = ''; render(); return; }
      submittingCode = true; localError = null; render(); onChange();
      try { const pending = bridge.arkSubmitAuthorizationCode({ code }); code = ''; const next = await pending; if (!disposed && !cancelled && next?.settings) onState(next); }
      catch (error) { if (!disposed && !cancelled) localError = { code: errorCode(error) }; }
      finally { code = ''; codeInput.value = ''; submittingCode = false; if (!disposed) { render(); onChange(); } }
    }
    async function cancel() {
      if (disposed || !signing() || cancelling) return;
      cancelling = true; cancelled = true; localError = null;
      if (codeInput) codeInput.value = '';
      if (profileSelect) { profileSelect.value = ''; profileSnapshot = ''; } render(); onChange();
      try {
        const next = await bridge[spec.bridgePrefix + 'CancelSignIn']();
        if (!disposed && next?.settings) onState(next);
        else if (!disposed && typeof bridge.getState === 'function') onState(await bridge.getState());
      } catch (error) { if (!disposed) localError = { code: errorCode(error) }; }
      finally { cancelling = false; if (!disposed) { render(); onChange(); } }
    }
    const changed = () => { localError = null; if (spec.provider !== 'gemini') { onInvalidate(); onModeChange(); } render(); };
    const regionChanged = () => { if (busy() || isBusy()) return; regionDirty = true; localError = null; onInvalidate(); render(); onChange(); };
    region?.addEventListener('change', regionChanged);
    mode?.addEventListener('change', changed); render();
    return Object.freeze({ render, isBusy: busy, isCancelling: () => cancelling,
      clearError() { localError = null; render(); },
      getRegion: () => region?.value,
      fill(value = 'apiKey', selectedRegion) { if (spec.provider !== 'gemini') mode.value = value === spec.authMode && getRole() == null ? value : 'apiKey'; regionDirty = validRegion(selectedRegion); if (regionDirty) region.value = selectedRegion; localError = null; render(); },
      destroy() { if (disposed) return; if (codeInput) codeInput.value = ''; disposed = true; mode?.removeEventListener('change', changed); region?.removeEventListener('change', regionChanged); regionField?.remove(); panel.remove(); },
    });
  }
  root.ForgeAntigravityLogin = Object.freeze({ create, errorMessage, formatBytes });
})(typeof globalThis === 'object' ? globalThis : this);
