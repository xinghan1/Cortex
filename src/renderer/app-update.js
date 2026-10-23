'use strict';
(function (root) {
  const statuses = new Set(['idle', 'checking', 'current', 'available', 'downloading', 'downloaded', 'installing', 'error']);
  const unsupported = '此版本请从 GitHub Releases 下载新版；安装版支持应用内更新。';
  function create({ bridge, button, label, progress, notice = () => {}, isBusy = () => false }) {
    let snapshot = { enabled: false, status: 'idle', currentVersion: '', version: '', progress: 0, error: '' };
    let pending = null, disposed = false, eventRevision = 0;
    const cleanText = (value, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : '';
    const errorReason = value => cleanText(typeof value === 'string' ? value : value?.message)
      .replace(/^Error invoking remote method ['"]forge:(?:getAppUpdate|checkAppUpdate|downloadAppUpdate|installAppUpdate)['"]:\s*(?:Error:\s*)?/u, '').trim();
    function update(value) {
      if (disposed || !value || !statuses.has(value.status)) return;
      snapshot = { enabled: value.enabled === true, status: value.status,
        currentVersion: cleanText(value.currentVersion, 80), version: cleanText(value.version, 80),
        progress: Number.isFinite(value.progress) ? Math.min(100, Math.max(0, Math.floor(value.progress))) : 0,
        error: errorReason(value.error),
      };
      render();
    }
    function render() {
      const { status, version, enabled, error } = snapshot;
      const visible = enabled && (['available', 'downloading', 'downloaded', 'installing'].includes(status) || status === 'error' && !!version);
      const busyInstall = status === 'downloaded' && isBusy();
      button.hidden = !visible;
      button.disabled = !visible || !!pending || ['downloading', 'installing'].includes(status) || busyInstall;
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
    }
    function reportCheck() {
      if (!snapshot.enabled) { notice(unsupported); return; }
      const { status, version, currentVersion, error } = snapshot;
      if (status === 'error') { notice(`检查更新失败${error ? '：' + error : '，请稍后重试。'}`, true); return; }
      notice(status === 'available' ? `发现新版本${version ? ' v' + version : ''}，点击顶部“更新”下载。`
        : status === 'downloaded' ? '更新已下载，点击顶部“重启更新”。'
        : status === 'downloading' ? '正在下载更新，请稍候。'
        : status === 'installing' ? '正在准备重启更新…'
        : status === 'checking' ? '正在检查更新…'
        : status === 'current' ? `当前已是最新版本${currentVersion ? ' v' + currentVersion : ''}。`
        : '暂未发现可用更新。');
    }
    async function invoke(action, manual = false) {
      if (disposed || pending) return;
      if (action === 'install' && isBusy()) { notice('请等待当前任务或文件操作结束，再重启更新。'); render(); return; }
      const method = { check: 'checkAppUpdate', download: 'downloadAppUpdate', install: 'installAppUpdate' }[action];
      const revision = eventRevision;
      const retryingDownload = action === 'download' && snapshot.status === 'error';
      pending = action; render();
      if (retryingDownload) notice('正在重新下载更新…');
      try {
        if (typeof bridge?.[method] !== 'function') throw new Error('当前版本暂不支持应用内更新。');
        const value = await bridge[method]();
        if (disposed) return;
        // Events carry the newest progress. An earlier IPC return or initial
        // read must not rewind a download that has already advanced.
        if (eventRevision === revision) update(value);
        if (manual) reportCheck();
        else if (snapshot.error) notice(`${action === 'install' ? '重启更新失败' : '下载更新失败'}：${snapshot.error}`, true);
        else if (action === 'download' && snapshot.status === 'downloaded') notice('更新已下载，点击顶部“重启更新”。');
      } catch (error) {
        if (!disposed) notice(`${action === 'install' ? '重启更新失败' : action === 'download' ? '下载更新失败' : '检查更新失败'}：${errorReason(error) || '请稍后重试。'}`, true);
      } finally {
        pending = null;
        if (!disposed) render();
      }
    }
    const click = () => {
      if (button.disabled || !snapshot.enabled) return;
      if (snapshot.status === 'downloaded') return invoke('install');
      if (snapshot.status === 'available' || snapshot.status === 'error' && snapshot.version) return invoke('download');
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
      destroy() { disposed = true; unsubscribe?.(); button.removeEventListener('click', click); },
    });
  }
  root.ForgeAppUpdate = Object.freeze({ create });
})(typeof globalThis === 'object' ? globalThis : this);
