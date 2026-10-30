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
  const qrSection = el('section', 'mobile-remote-qr'); qrSection.id = 'mobile-remote-qr'; qrSection.hidden = true;
  const qrLabel = el('label', 'mobile-remote-label', '扫码配对：选择手机可访问的电脑地址'); qrLabel.htmlFor = 'mobile-remote-qr-address';
  const qrAddress = el('select', 'mobile-remote-qr-address'); qrAddress.id = 'mobile-remote-qr-address';
  const canvas = el('canvas', 'mobile-remote-qr-image'); canvas.id = 'mobile-remote-qr-image'; canvas.hidden = true; canvas.setAttribute('aria-label', '手机配对二维码');
  const qrStatus = el('p', 'mobile-remote-qr-status'); qrStatus.setAttribute('role', 'status');
  qrSection.append(qrLabel, qrAddress, canvas, qrStatus); info.append(qrSection);
  const addresses = field('连接地址', 'mobile-remote-addresses');
  const fingerprint = field('证书指纹', 'mobile-remote-fingerprint');
  const token = field('连接令牌', 'mobile-remote-token');
  const guidance = el('div', 'mobile-remote-guidance');
  guidance.append(el('p', '', '使用手机扫描二维码并核对连接信息；也可以手动填写连接地址、证书指纹和连接令牌。'),
    el('p', '', '局域网：手机与电脑连接同一网络，选择对应的电脑局域网地址。跨网络：先让手机和电脑加入同一 VPN，再使用电脑的 VPN 地址；VPN 和系统防火墙须允许设备间访问。'),
    el('p', '', '连接令牌相当于访问凭证，请只提供给可信设备。每次重新开启会生成新令牌；关闭此面板不会停止服务，请保持电脑上的 Cortex 窗口运行。'));
  dialog.append(header, status, error, controls, info, guidance); document.body.append(dialog);
  let pending = false, snapshot = null, selectedAddress = '', qrSequence = 0;
  function clearQr() { ++qrSequence; canvas.width = 1; canvas.height = 1; canvas.hidden = true; qrStatus.textContent = ''; }
  async function drawQr(address) {
    clearQr(); const sequence = qrSequence;
    if (!address || typeof bridge?.mobileRemoteQr !== 'function') { qrStatus.textContent = '无法生成二维码，请使用手动配对。'; return; }
    qrStatus.textContent = '正在生成配对码…';
    try {
      const result = await bridge.mobileRemoteQr({ url: address });
      if (sequence !== qrSequence || !dialog.open || !snapshot?.enabled || pending) return;
      const size = result?.size, modules = result?.modules;
      if (!Number.isInteger(size) || size < 21 || size > 177 || !Array.isArray(modules) || modules.length !== size || modules.some(row => !Array.isArray(row) || row.length !== size || row.some(value => typeof value !== 'boolean'))) throw new Error('invalid matrix');
      const scale = 4, quiet = 4; canvas.width = (size + quiet * 2) * scale; canvas.height = canvas.width;
      const context = canvas.getContext('2d'); if (!context) throw new Error('canvas unavailable');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#000';
      for (let y=0; y<size; y++) for (let x=0; x<size; x++) if (modules[y][x]) context.fillRect((x+quiet)*scale, (y+quiet)*scale, scale, scale);
      canvas.hidden = false; qrStatus.textContent = '请使用手机端扫码，并确认地址和指纹。';
    } catch { if (sequence === qrSequence) { clearQr(); qrStatus.textContent = '二维码生成失败，请使用手动配对。'; } }
  }
  qrAddress.addEventListener('change', () => { selectedAddress = qrAddress.value; void drawQr(selectedAddress); });
  dialog.addEventListener('close', () => { snapshot = null; selectedAddress = ''; clearQr(); addresses.replaceChildren(); fingerprint.textContent = ''; token.textContent = ''; info.hidden = true; qrSection.hidden = true; });
  function render() {
    if (!dialog.open) { snapshot = null; selectedAddress = ''; clearQr(); addresses.replaceChildren(); fingerprint.textContent = ''; token.textContent = ''; info.hidden = true; qrSection.hidden = true; return; }
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
      const valid = list.filter(value => /^https:\/\/(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(value));
      qrSection.hidden = !valid.length || pending;
      if (!valid.includes(selectedAddress)) selectedAddress = valid[0] || '';
      qrAddress.replaceChildren();
      for (const address of valid) { const option = el('option', '', address); option.value = address; qrAddress.append(option); }
      qrAddress.value = selectedAddress;
      if (!qrSection.hidden) void drawQr(selectedAddress); else clearQr();
    } else { fingerprint.textContent = ''; token.textContent = ''; selectedAddress = ''; qrSection.hidden = true; clearQr(); }
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
