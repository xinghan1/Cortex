'use strict';

// Remote access is explicitly enabled by the user; closing this dialog does not change it.
(() => {
  const bridge = window.forge;
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const dialog = el('dialog', 'settings-dialog mobile-remote-dialog');
  dialog.id = 'mobile-remote-dialog';
  dialog.setAttribute('aria-labelledby', 'mobile-remote-title');
  const header = el('div', 'dialog-header');
  const title = el('h2', '', '手机远程连接'); title.id = 'mobile-remote-title';
  const close = el('button', 'icon-button', '×'); close.type = 'button'; close.setAttribute('aria-label', '关闭手机远程连接');
  close.addEventListener('click', () => dialog.close()); header.append(title, close);
  const status = el('p', 'mobile-remote-status'); status.id = 'mobile-remote-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const error = el('p', 'form-error'); error.id = 'mobile-remote-error'; error.hidden = true; error.setAttribute('role', 'alert');
  const controls = el('div', 'mobile-remote-controls');
  const start = el('button', 'button solid', '开启远程连接'); start.type = 'button'; start.id = 'mobile-remote-start';
  const stop = el('button', 'button subtle', '停止远程连接'); stop.type = 'button'; stop.id = 'mobile-remote-stop';
  const refresh = el('button', 'button subtle', '刷新状态'); refresh.type = 'button'; refresh.id = 'mobile-remote-refresh';
  controls.append(start, stop, refresh);
  const info = el('section', 'mobile-remote-info'); info.id = 'mobile-remote-info'; info.hidden = true;
  const field = (label, id) => {
    const row = el('div', 'mobile-remote-field');
    const name = el('div', 'mobile-remote-label', label);
    const value = el('div', 'mobile-remote-value'); value.id = id;
    row.append(name, value); info.append(row); return value;
  };
  const addresses = field('连接地址', 'mobile-remote-addresses');
  const fingerprint = field('证书指纹', 'mobile-remote-fingerprint');
  const token = field('连接令牌', 'mobile-remote-token');
  const guidance = el('div', 'mobile-remote-guidance');
  guidance.append(el('p', '', '在手机端依次填写连接地址、证书指纹和连接令牌。请确认指纹与这里显示的一致。'),
    el('p', '', '局域网：手机与电脑连接同一网络，选择对应的电脑局域网地址。跨网络：先让手机和电脑加入同一 VPN，再使用电脑的 VPN 地址；VPN 和系统防火墙须允许设备间访问。'),
    el('p', '', '连接令牌相当于访问凭证，请只提供给可信设备。每次重新开启会生成新令牌；关闭此面板不会停止服务，请保持电脑上的 Cortex 窗口运行。'));
  dialog.append(header, status, error, controls, info, guidance); document.body.append(dialog);
  let pending = false, snapshot = null;
  function render() {
    const enabled = snapshot?.enabled === true;
    status.textContent = pending ? '正在处理…' : snapshot ? (enabled ? '远程连接已开启' : '远程连接已停止') : '无法读取远程连接状态';
    dialog.setAttribute('aria-busy', String(pending));
    refresh.disabled = pending;
    start.disabled = pending || !snapshot || enabled;
    stop.disabled = pending || !snapshot || !enabled;
    info.hidden = !enabled;
    addresses.replaceChildren();
    if (enabled) {
      const list = Array.isArray(snapshot.addresses) ? snapshot.addresses.filter(value => typeof value === 'string') : [];
      for (const address of list) addresses.append(el('div', '', address));
      if (!list.length) addresses.textContent = '未发现可用的网络地址';
      fingerprint.textContent = typeof snapshot.fingerprint === 'string' ? snapshot.fingerprint : '不可用';
      token.textContent = typeof snapshot.token === 'string' ? snapshot.token : '不可用';
    } else { fingerprint.textContent = ''; token.textContent = ''; }
  }
  async function perform(action) {
    if (pending) return;
    pending = true; error.hidden = true; error.textContent = ''; render();
    try {
      if (typeof bridge?.[action] !== 'function') throw new Error('unavailable');
      const result = await bridge[action]();
      if (!result || typeof result.enabled !== 'boolean') throw new Error('invalid status');
      snapshot = result;
    } catch {
      // Do not display or log service errors: they may contain connection credentials.
      error.textContent = '操作失败，请检查远程服务状态后重试。'; error.hidden = false;
      if (action !== 'mobileRemoteStatus') {
        try { snapshot = await bridge.mobileRemoteStatus(); } catch { snapshot = null; }
      }
    } finally { pending = false; render(); }
  }
  start.addEventListener('click', () => perform('mobileRemoteStart'));
  stop.addEventListener('click', () => perform('mobileRemoteStop'));
  refresh.addEventListener('click', () => perform('mobileRemoteStatus'));
  window.CortexMobileRemote = Object.freeze({ open() { if (!dialog.open) dialog.showModal(); return perform('mobileRemoteStatus'); } });
})();
