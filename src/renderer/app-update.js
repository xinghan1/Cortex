'use strict';
(function (root) {
  const statuses = new Set(['idle', 'checking', 'current', 'available', 'downloading', 'downloaded', 'installing', 'error']);
  const unsupported = '此版本请从 GitHub Releases 下载新版；安装版支持应用内更新。';
  function create({ bridge, button, label, progress, notice = () => {}, isBusy = () => false }) {
    const ring = button.querySelector?.('.app-update-ring-value');
    let snapshot = { enabled: false, status: 'idle', currentVersion: '', version: '', progress: 0, error: '' };
    let pending = null, disposed = false, eventRevision = 0, actionError = '', dismissActionNotice = null;
    const cleanText = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : '';
    const errorReason = value => cleanText(typeof value === 'string' ? value : value?.message)
      .replace(/^Error invoking remote method ['"]forge:(?:getAppUpdate|checkAppUpdate|downloadAppUpdate|installAppUpdate)['"]:\s*(?:Error:\s*)?/u, '').trim();
    const document = button.ownerDocument || root.document;
    let dialog, dialogTitle, dialogStatus, dialogProgress, dialogPercent, dialogBytes, dialogError, dialogPrimary, dialogBackground;
    const formatBytes = bytes => {
      let value = Math.max(0, bytes) / 1024, unit = 0;
      const units = ['KB', 'MB', 'GB'];
      while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
      const digits = value > 0 && value < 1 ? 3 : value < 10 ? 2 : value < 100 ? 1 : 0;
      return `${Number(value.toFixed(digits))} ${units[unit]}`;
    };
    const hideDialog = () => { if (dialog?.open) dialog.close(); };
    const openDialog = () => {
      if (!dialog || disposed) return;
      renderDialog();
      if (!dialog.open) dialog.showModal();
    };
    if (document?.createElement && document.body) {
      const el = (tag, id, className, text) => {
        const node = document.createElement(tag);
        if (id) node.id = id;
        if (className) node.className = className;
        if (text) node.textContent = text;
        return node;
      };
      dialog = el('dialog', 'app-update-dialog', 'settings-dialog app-update-dialog');
      dialog.setAttribute('aria-labelledby', 'app-update-dialog-title');
      const header = el('div', '', 'dialog-header');
      dialogTitle = el('h2', 'app-update-dialog-title');
      const close = el('button', 'app-update-dialog-close', 'icon-button', '×');
      close.type = 'button'; close.title = '收起更新窗口'; close.setAttribute('aria-label', close.title);
      close.addEventListener('click', hideDialog); header.append(dialogTitle, close);
      dialogStatus = el('p', 'app-update-dialog-status', 'app-update-dialog-status');
      dialogStatus.setAttribute('role', 'status'); dialogStatus.setAttribute('aria-live', 'polite');
      dialogPercent = el('span', 'app-update-dialog-percent', 'app-update-dialog-percent');
      dialogPercent.setAttribute('role', 'status'); dialogPercent.setAttribute('aria-live', 'polite');
      dialogProgress = el('progress', 'app-update-dialog-progress', 'app-update-dialog-progress');
      dialogProgress.max = 100; dialogProgress.setAttribute('aria-label', '更新下载进度');
      dialogProgress.setAttribute('role', 'progressbar');
      dialogProgress.setAttribute('aria-valuemin', '0'); dialogProgress.setAttribute('aria-valuemax', '100');
      dialogBytes = el('p', 'app-update-dialog-bytes', 'app-update-dialog-bytes');
      dialogError = el('p', 'app-update-dialog-error', 'form-error'); dialogError.setAttribute('role', 'alert');
      const actions = el('div', '', 'app-update-dialog-actions');
      dialogBackground = el('button', 'app-update-dialog-background', 'button', '后台下载'); dialogBackground.type = 'button';
      dialogBackground.addEventListener('click', hideDialog);
      dialogPrimary = el('button', 'app-update-dialog-primary', 'button solid'); dialogPrimary.type = 'button';
      dialogPrimary.addEventListener('click', () => {
        if (dialogPrimary.disabled) return;
        return snapshot.status === 'downloaded' ? invoke('install') : invoke('download');
      });
      actions.append(dialogBackground, dialogPrimary);
      dialog.append(header, dialogStatus, dialogPercent, dialogProgress, dialogBytes, dialogError, actions);
      dialog.addEventListener('cancel', event => { event.preventDefault(); hideDialog(); });
      document.body.append(dialog);
    }
    function update(value) {
      if (disposed || !value || !statuses.has(value.status)) return;
      if (['downloading', 'installing'].includes(value.status) || value.version !== snapshot.version) actionError = '';
      snapshot = { enabled: value.enabled === true, status: value.status,
        currentVersion: cleanText(value.currentVersion, 80), version: cleanText(value.version, 80),
        progress: Number.isFinite(value.progress) ? Math.min(100, Math.max(0, Math.floor(value.progress))) : 0,
        progressKnown: Number.isFinite(value.progress),
        downloadedBytes: Number.isSafeInteger(value.downloadedBytes) && value.downloadedBytes >= 0 ? value.downloadedBytes : null,
        totalBytes: Number.isSafeInteger(value.totalBytes) && value.totalBytes > 0 ? value.totalBytes : null,
        error: errorReason(value.error),
      };
      render();
    }
    function renderDialog() {
      if (!dialog) return;
      const { status, totalBytes, downloadedBytes } = snapshot;
      const failure = !pending && (actionError || snapshot.error);
      const downloading = pending === 'download' || status === 'downloading';
      const installing = pending === 'install' || status === 'installing';
      const complete = status === 'downloaded';
      const percent = snapshot.progressKnown ? snapshot.progress
        : totalBytes && downloadedBytes !== null ? Math.min(100, Math.floor(downloadedBytes / totalBytes * 100)) : null;
      dialog.dataset.status = failure && !complete ? 'error' : installing ? 'installing' : downloading ? 'downloading' : status;
      dialogTitle.textContent = installing ? '正在重启更新' : complete ? '更新已准备就绪'
        : failure ? '下载更新失败' : downloading ? '正在下载更新' : '下载更新';
      dialogStatus.textContent = complete && isBusy() ? '请等待当前任务或文件操作结束，再重启更新。' : '';
      dialogStatus.hidden = !dialogStatus.textContent;
      if (dialogStatus.hidden) dialog.removeAttribute('aria-describedby');
      else dialog.setAttribute('aria-describedby', 'app-update-dialog-status');
      dialogPercent.textContent = complete ? '100%' : percent === null ? '等待下载进度…' : `${percent}%`;
      dialogPercent.hidden = !!failure || installing;
      dialogProgress.hidden = !!failure || installing;
      if (percent === null && !complete) {
        dialogProgress.removeAttribute('value'); dialogProgress.removeAttribute('aria-valuenow');
        dialogProgress.setAttribute('aria-valuetext', '正在下载，等待进度');
      } else {
        dialogProgress.value = complete ? 100 : percent;
        dialogProgress.setAttribute('aria-valuenow', String(dialogProgress.value));
        dialogProgress.setAttribute('aria-valuetext', `${dialogProgress.value}%`);
      }
      const received = downloadedBytes ?? (complete && totalBytes ? totalBytes : 0);
      dialogBytes.textContent = `已下载 ${formatBytes(received)}${totalBytes ? ' / 总大小 ' + formatBytes(totalBytes) : ' · 总大小未知'}`;
      dialogBytes.hidden = installing;
      dialogError.textContent = failure || ''; dialogError.hidden = !failure;
      dialogBackground.textContent = downloading && !failure ? '后台下载' : '关闭';
      dialogPrimary.textContent = complete ? isBusy() ? '任务结束后重启更新' : '重启更新'
        : installing ? '正在重启…' : downloading && !failure ? '正在下载…' : failure ? '重试下载' : '下载更新';
      dialogPrimary.disabled = !snapshot.enabled || !!pending || installing || downloading && !failure || complete && isBusy();
    }
    function render() {
      const { status, version, enabled, error } = snapshot;
      const visible = enabled && (['available', 'downloading', 'downloaded', 'installing'].includes(status) || status === 'error' && !!version);
      const busyInstall = status === 'downloaded' && isBusy();
      button.hidden = !visible;
      button.disabled = !visible || pending === 'install' || pending === 'check' || status === 'installing' || busyInstall;
      button.dataset.status = status;
      button.setAttribute('aria-busy', String(!!pending || ['downloading', 'installing'].includes(status)));
      label.textContent = status === 'downloading' ? `下载更新 ${snapshot.progress}%`
        : status === 'downloaded' ? busyInstall ? '任务结束后重启更新' : '重启更新'
        : status === 'installing' ? '正在重启…'
        : status === 'error' ? '更新失败 · 重试'
        : pending === 'download' ? '准备下载…' : '更新';
      const description = status === 'error' ? `${version ? '更新下载失败' : '检查更新失败'}${error ? '：' + error : ''}，点击重试。`
        : status === 'downloaded' ? busyInstall ? '请等待当前任务或文件操作结束，再重启安装更新。' : `新版${version ? ' v' + version : ''}已下载，点击重启并更新。`
        : status === 'available' ? `发现新版本${version ? ' v' + version : ''}，点击下载更新。`
        : label.textContent;
      button.title = description; button.setAttribute('aria-label', description);
      progress.hidden = status !== 'downloading';
      progress.value = snapshot.progress;
      progress.setAttribute('aria-valuenow', String(snapshot.progress));
      progress.setAttribute('aria-valuetext', `${snapshot.progress}%`);
      ring?.setAttribute('stroke-dashoffset', String(100 - snapshot.progress));
      renderDialog();
    }
    function reportCheck() {
      if (!snapshot.enabled) { notice(unsupported); return; }
      const { status, version, currentVersion, error } = snapshot;
      if (status === 'error') { notice(`检查更新失败${error ? '：' + error : '，请稍后重试。'}`, true); return; }
      notice(status === 'available' ? `发现新版本${version ? ' v' + version : ''}，点击“帮助”右侧的下载图标下载更新。`
        : status === 'downloaded' ? '更新已下载，点击“帮助”右侧的下载图标重启更新。'
        : status === 'downloading' ? '正在下载更新，请稍候。'
        : status === 'installing' ? '正在准备重启更新…'
        : status === 'checking' ? '正在检查更新…'
        : status === 'current' ? `当前已是最新版本${currentVersion ? ' v' + currentVersion : ''}。`
        : '暂未发现可用更新。');
    }
    function reportActionError(message) {
      const dismiss = notice(message, true);
      dismissActionNotice = typeof dismiss === 'function' ? dismiss : null;
    }
    async function invoke(action, manual = false) {
      if (disposed || pending) return;
      dismissActionNotice?.(); dismissActionNotice = null;
      if (action === 'install' && isBusy()) { notice('请等待当前任务或文件操作结束，再重启更新。'); render(); return; }
      const method = { check: 'checkAppUpdate', download: 'downloadAppUpdate', install: 'installAppUpdate' }[action];
      const revision = eventRevision;
      actionError = ''; pending = action; render();
      try {
        if (typeof bridge?.[method] !== 'function') throw new Error('当前版本暂不支持应用内更新。');
        const value = await bridge[method]();
        if (disposed) return;
        // Events carry the newest progress. An earlier IPC return or initial
        // read must not rewind a download that has already advanced.
        if (eventRevision === revision) update(value);
        if (manual) reportCheck();
        else if (snapshot.error) reportActionError(`${action === 'install' ? '重启更新失败' : '下载更新失败'}：${snapshot.error}`);
      } catch (error) {
        if (!disposed) {
          actionError = errorReason(error) || '请稍后重试。';
          reportActionError(`${action === 'install' ? '重启更新失败' : action === 'download' ? '下载更新失败' : '检查更新失败'}：${actionError}`);
        }
      } finally {
        pending = null;
        if (!disposed) render();
      }
    }
    const click = () => {
      if (button.disabled || !snapshot.enabled) return;
      if (snapshot.status === 'downloading' || pending === 'download') { openDialog(); return; }
      if (snapshot.status === 'downloaded') return invoke('install');
      if (snapshot.status === 'available' || snapshot.status === 'error' && snapshot.version) { openDialog(); return invoke('download'); }
      if (snapshot.status === 'error') return invoke('check', true);
    };
    button.addEventListener('click', click);
    const unsubscribe = bridge?.onEvent?.(event => {
      if (event?.type !== 'app-update') return;
      ++eventRevision; update(event.update);
    });
    const revision = eventRevision;
    const ready = Promise.resolve().then(() => bridge?.getAppUpdate?.()).then(value => {
      if (!disposed && eventRevision === revision) update(value);
    }).catch(() => {});
    render();
    return Object.freeze({ update, ready, check: () => invoke('check', true), sync: render,
      destroy() { disposed = true; unsubscribe?.(); button.removeEventListener('click', click); hideDialog(); dialog?.remove(); },
    });
  }
  root.ForgeAppUpdate = Object.freeze({ create });
})(typeof globalThis === 'object' ? globalThis : this);
