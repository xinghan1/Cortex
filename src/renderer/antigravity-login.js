'use strict';
(function (root) {
  const messages = Object.freeze({
    AGY_RUNTIME_UNSUPPORTED: '当前系统暂不支持 Antigravity 官方代理。',
    AGY_DOWNLOAD_FAILED: '官方代理下载失败，请检查网络后重试。',
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
    return typeof value?.code === 'string' && /^(?:AGY|KIMI|ZCODE)_[A-Z_]{1,64}$/u.test(value.code) ? value.code : encoded.match(/\[((?:AGY|KIMI|ZCODE)_[A-Z_]{1,64})\]/u)?.[1];
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
      if (spec.errorPrefix === 'AGY_') return errorMessage(value);
      const message = Object.hasOwn(messages, normalized) ? messages[normalized] : value ? '官方代理操作未完成，请重试。' : '';
      return message.replaceAll('Antigravity', spec.name).replaceAll('Google', spec.provider === 'kimi' ? 'Kimi' : '智谱 / Z.AI').replaceAll('Gemini API Key', `${spec.provider === 'kimi' ? 'Kimi' : 'GLM'} API Key`);
    };
    const $ = id => document.getElementById(id);
    const el = (tag, id, text) => { const value = document.createElement(tag); if (id) value.id = id; if (text !== undefined) value.textContent = text; return value; };
    const mode = $(spec.modeId), panel = el('section', spec.prefix + '-login-panel'); panel.className = 'antigravity-login-panel'; panel.hidden = true;
    panel.setAttribute('aria-label', `${spec.name} 官方代理`);
    const status = el('strong', spec.prefix + '-login-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const help = el('p', spec.prefix + '-login-help', `由 ${spec.name} 官方代理完整执行主会话任务。在官方页面连接${spec.provider === 'gemini' ? ' Google ' : ''}账号，可用模型与额度以官方账号为准。`); help.className = 'official-agent-help';
    const version = el('small', spec.prefix + '-runtime-version'); version.className = 'official-agent-version';
    const download = el('div', spec.prefix + '-download'), progress = el('progress', spec.prefix + '-download-progress'), downloadSize = el('span', spec.prefix + '-download-size');
    download.className = 'official-agent-download'; progress.className = 'official-agent-progress'; downloadSize.className = 'official-agent-download-size';
    progress.setAttribute('aria-label', '官方代理下载进度'); download.append(progress, downloadSize);
    const actions = el('div'); actions.className = 'antigravity-login-actions';
    const buttons = {}, add = (id, text, handler) => {
      const button = el('button', spec.prefix + '-' + id, text); button.type = 'button'; button.className = 'button'; button.addEventListener('click', handler); buttons[id] = button; actions.append(button);
    };
    add('install', '下载官方代理', () => run('install'));
    add('sign-in', spec.provider === 'gemini' ? '使用 Google 账号连接' : '使用官方账号连接', () => run('signin'));
    add('cancel-sign-in', '取消连接', cancel);
    add('disconnect', '断开本机连接', () => run('disconnect'));
    add('retry', '重试读取', () => run('retry'));
    add('models', '刷新模型目录', () => { if (!buttons.models.disabled) return onRefreshModels(); });
    const message = el('p', spec.prefix + '-login-message'); message.className = 'official-agent-message'; message.setAttribute('role', 'status');
    const verification = el('div', spec.prefix + '-verification'); verification.className = 'official-agent-verification'; verification.hidden = true;
    const verificationUrl = el('p', spec.prefix + '-verification-url'), userCode = el('code', spec.prefix + '-user-code'); verification.append(verificationUrl, userCode);
    const regionField = spec.regions.length ? el('label', spec.prefix + '-region-field') : null;
    const region = regionField ? el('select', spec.prefix + '-region') : null;
    if (regionField) {
      regionField.className = 'form-field'; regionField.append(el('span', '', '账号地区'));
      for (const [value, label] of spec.regions) { const option = el('option', '', label); option.value = value; region.append(option); }
      region.value = spec.regions[0][0]; regionField.append(region); $('base-url-field').before(regionField);
    }
    panel.append(status, help, version, download, verification, actions, message); $('base-url-field').before(panel);
    let action = null, cancelling = false, cancelled = false, localError = null, disposed = false;
    let regionDirty = false;
    const account = () => getScope()?.[spec.stateKey] || {};
    const validRegion = value => spec.regions.some(([id]) => id === value);
    const signing = () => action === 'signin' || account().session?.status === 'connecting';
    const busy = () => !!action || signing() || account().runtime?.status === 'downloading';
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
        'waiting-browser': spec.provider === 'gemini' ? '等待 Google 浏览器授权' : '等待官方浏览器授权', 'model-list': '正在读取模型目录…', committing: '正在保存本机连接…' };
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
      action = kind; localError = null; cancelled = false; onInvalidate(); render(); onChange();
      try { const next = await bridge[spec.bridgePrefix + methods[kind]](kind === 'signin' && region ? { region: region.value } : undefined); if (!disposed && next?.settings) onState(next); }
      catch (error) { if (!disposed && !cancelled) localError = { code: errorCode(error) }; }
      finally { action = null; cancelling = false; if (!disposed) { render(); onChange(); } }
    }
    async function cancel() {
      if (disposed || !signing() || cancelling) return;
      cancelling = true; cancelled = true; localError = null; render(); onChange();
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
      destroy() { if (disposed) return; disposed = true; mode?.removeEventListener('change', changed); region?.removeEventListener('change', regionChanged); regionField?.remove(); panel.remove(); },
    });
  }
  root.ForgeAntigravityLogin = Object.freeze({ create, errorMessage, formatBytes });
})(typeof globalThis === 'object' ? globalThis : this);
