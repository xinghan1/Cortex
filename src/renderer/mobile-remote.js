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
  const portLabel = el('label', 'mobile-remote-label', '本地端口（留空自动分配；穿透时建议固定）'); portLabel.htmlFor = 'mobile-remote-port';
  const localPort = el('input', 'mobile-remote-qr-address'); localPort.id = 'mobile-remote-port'; localPort.type = 'number'; localPort.min = '1'; localPort.max = '65535'; localPort.placeholder = '例如 47839';
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
  const tunnelLabel = el('label', 'mobile-remote-label', '樱花穿透地址（域名或 IP：端口）'); tunnelLabel.htmlFor = 'mobile-remote-tunnel-address';
  const tunnelAddress = el('input', 'mobile-remote-qr-address'); tunnelAddress.id = 'mobile-remote-tunnel-address'; tunnelAddress.type = 'text'; tunnelAddress.placeholder = '例如 example.natfrp.cloud:12345';
  const tunnelApply = el('button', 'button subtle', '生成穿透配对码'); tunnelApply.type = 'button'; tunnelApply.id = 'mobile-remote-tunnel-apply';
  const canvas = el('canvas', 'mobile-remote-qr-image'); canvas.id = 'mobile-remote-qr-image'; canvas.hidden = true; canvas.setAttribute('aria-label', '手机配对二维码');
  const qrStatus = el('p', 'mobile-remote-qr-status'); qrStatus.setAttribute('role', 'status');
  qrSection.append(qrLabel, qrAddress, tunnelLabel, tunnelAddress, tunnelApply, canvas, qrStatus); info.append(qrSection);
  const listeningPort = field('本地监听端口', 'mobile-remote-listening-port');
  const addresses = field('连接地址', 'mobile-remote-addresses');
  const fingerprint = field('证书指纹', 'mobile-remote-fingerprint');
  const token = field('连接令牌', 'mobile-remote-token');
  const help = el('button', 'button subtle mobile-remote-help-button', '需要帮助？'); help.type = 'button'; help.id = 'mobile-remote-help';
  dialog.append(header, status, error, portLabel, localPort, controls, info, help); document.body.append(dialog);
  const helpDialog = el('dialog', 'settings-dialog mobile-remote-help-dialog'); helpDialog.id = 'mobile-remote-help-dialog'; helpDialog.setAttribute('aria-labelledby', 'mobile-remote-help-title');
  const helpHeader = el('div', 'dialog-header');
  const helpTitle = el('h2', '', '远程连接帮助'); helpTitle.id = 'mobile-remote-help-title';
  const helpClose = el('button', 'icon-button', '×'); helpClose.type = 'button'; helpClose.id = 'mobile-remote-help-close'; helpClose.setAttribute('aria-label', '关闭帮助');
  helpClose.addEventListener('click', () => helpDialog.close()); helpHeader.append(helpTitle, helpClose);
  const helpBody = el('div', 'mobile-remote-help-content');
  const section = (title, paragraphs) => { helpBody.append(el('h3', '', title)); for (const paragraph of paragraphs) helpBody.append(el('p', '', paragraph)); };
  section('开始连接', [
    '在电脑上点击“开启远程连接”，并保持 Cortex 运行。打开手机 Cortex 的设置，进入“电脑连接设置”。',
    '选择手机能够访问的地址，扫描电脑上的配对二维码，核对信息后保存；也可以手动填写 HTTPS 地址、证书指纹和连接令牌。保存后在会话界面选择“连接电脑”。'
  ]);
  section('同一局域网', [
    '手机和电脑连接同一网络时，选择电脑的局域网地址。如果无法连接，请检查网络隔离和电脑防火墙是否允许 Cortex 远程服务。'
  ]);
  section('跨网络：樱花内网穿透', [
    '在电脑上运行樱花内网穿透并建立 TCP 隧道，本地地址填写 127.0.0.1，本地端口填写连接窗口中的本地监听端口。启动隧道后，在樱花启动器的日志或隧道列表复制公网地址和远程端口，填入连接窗口并生成穿透配对码。',
    '保留 Cortex 自身的 HTTPS，使用 TCP 直通，不要启用自动 HTTPS、Proxy Protocol 或替换证书。手机填写的证书指纹和令牌以电脑 Cortex 显示为准。为避免重启后端口变化，可在开启服务前填写固定本地端口，并在樱花隧道中使用相同端口。',
    '手机和电脑也可以加入同一个组网 VPN，并选择电脑的 VPN 地址。是否能够连接取决于网络和防火墙设置。'
  ]);
  section('连接安全', [
    '配对二维码和连接令牌可用于访问电脑，只提供给可信设备。每次重新开启远程服务会生成新令牌；关闭连接窗口不会停止服务，不再使用时请点击“停止远程连接”。'
  ]);
  helpDialog.append(helpHeader, helpBody); document.body.append(helpDialog);
  help.addEventListener('click', () => { if (!helpDialog.open) helpDialog.showModal(); });
  let pending = false, snapshot = null, selectedAddress = '', qrSequence = 0;
  let tunnel = '';
  try { tunnel = window.localStorage?.getItem('cortex.mobileRemoteTunnel') || ''; localPort.value = window.localStorage?.getItem('cortex.mobileRemotePort') || ''; } catch {}
  tunnelAddress.value = tunnel;
  function clearQr() { ++qrSequence; canvas.width = 1; canvas.height = 1; canvas.hidden = true; qrStatus.textContent = ''; }
  async function drawQr(address) {
    clearQr(); const sequence = qrSequence;
    if (!address || typeof bridge?.mobileRemoteQr !== 'function') { qrStatus.textContent = '无法生成二维码，请使用手动配对。'; return; }
    qrStatus.textContent = '正在生成配对码…';
    try {
      const external = !snapshot?.addresses?.includes(address);
      const result = await bridge.mobileRemoteQr({ url: address, external });
      if (sequence !== qrSequence || !dialog.open || !snapshot?.enabled || pending) return;
      const size = result?.size, modules = result?.modules;
      if (!Number.isInteger(size) || size < 21 || size > 177 || !Array.isArray(modules) || modules.length !== size || modules.some(row => !Array.isArray(row) || row.length !== size || row.some(value => typeof value !== 'boolean'))) throw new Error('invalid matrix');
      const scale = 4, quiet = 4; canvas.width = (size + quiet * 2) * scale; canvas.height = canvas.width;
      const context = canvas.getContext('2d'); if (!context) throw new Error('canvas unavailable');
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = '#000';
      for (let y=0; y<size; y++) for (let x=0; x<size; x++) if (modules[y][x]) context.fillRect((x+quiet)*scale, (y+quiet)*scale, scale, scale);
      canvas.hidden = false; qrStatus.textContent = '请使用手机端扫码，并确认地址和指纹。';
      if (external) {
        tunnel = address;
        if (!Array.from(qrAddress.children).some(option => option.value === address)) { const option = el('option', '', address); option.value = address; qrAddress.append(option); }
        qrAddress.value = address;
        try { window.localStorage?.setItem('cortex.mobileRemoteTunnel', tunnel); } catch {}
      }
    } catch { if (sequence === qrSequence) { clearQr(); qrStatus.textContent = '二维码生成失败，请检查穿透地址格式或使用手动配对。'; } }
  }
  qrAddress.addEventListener('change', () => { selectedAddress = qrAddress.value; void drawQr(selectedAddress); });
  tunnelApply.addEventListener('click', () => {
    let address = tunnelAddress.value.trim();
    if (/^https:\/\//i.test(address)) address = address.replace(/^https:\/\//i, 'https://');
    else address = `https://${address}`;
    tunnelAddress.value = address; selectedAddress = address;
    void drawQr(address);
  });
  dialog.addEventListener('close', () => { snapshot = null; selectedAddress = ''; clearQr(); addresses.replaceChildren(); listeningPort.textContent = ''; fingerprint.textContent = ''; token.textContent = ''; info.hidden = true; qrSection.hidden = true; });
  function render() {
    if (!dialog.open) { snapshot = null; selectedAddress = ''; clearQr(); addresses.replaceChildren(); fingerprint.textContent = ''; token.textContent = ''; info.hidden = true; qrSection.hidden = true; return; }
    const enabled = snapshot?.enabled === true;
    status.textContent = pending ? '正在处理…' : snapshot ? (enabled ? '远程连接已开启' : '远程连接已停止') : '无法读取远程连接状态';
    dialog.setAttribute('aria-busy', String(pending));
    refresh.disabled = pending;
    start.disabled = pending || !snapshot || enabled;
    stop.disabled = pending || !snapshot || !enabled;
    localPort.disabled = pending || enabled;
    info.hidden = !enabled;
    addresses.replaceChildren();
    if (enabled) {
      const list = Array.isArray(snapshot.addresses) ? snapshot.addresses.filter(value => typeof value === 'string') : [];
      for (const address of list) addresses.append(el('div', '', address));
      if (!list.length) addresses.textContent = '未发现可用的网络地址';
      listeningPort.textContent = Number.isInteger(snapshot.port) && snapshot.port > 0 ? String(snapshot.port) : '不可用';
      fingerprint.textContent = typeof snapshot.fingerprint === 'string' ? snapshot.fingerprint : '不可用';
      token.textContent = typeof snapshot.token === 'string' ? snapshot.token : '不可用';
      const valid = list.filter(value => /^https:\/\/(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}$/.test(value));
      qrSection.hidden = pending;
      if (tunnel && !valid.includes(tunnel)) valid.push(tunnel);
      if (!valid.includes(selectedAddress)) selectedAddress = valid[0] || '';
      qrAddress.replaceChildren();
      for (const address of valid) { const option = el('option', '', address); option.value = address; qrAddress.append(option); }
      qrAddress.value = selectedAddress;
      if (!qrSection.hidden) void drawQr(selectedAddress); else clearQr();
    } else { listeningPort.textContent = ''; fingerprint.textContent = ''; token.textContent = ''; selectedAddress = ''; qrSection.hidden = true; clearQr(); }
  }
  async function perform(action) {
    if (pending) return;
    pending = true; error.hidden = true; error.textContent = ''; render();
    try {
      if (typeof bridge?.[action] !== 'function') throw new Error('unavailable');
      let result;
      if (action === 'mobileRemoteStart') {
        const rawPort = String(localPort.value || '').trim();
        if (rawPort && (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535)) throw new Error('invalid port');
        result = await bridge[action]({ port: rawPort ? Number(rawPort) : 0 });
        try { window.localStorage?.setItem('cortex.mobileRemotePort', rawPort); } catch {}
      } else result = await bridge[action]();
      if (!result || typeof result.enabled !== 'boolean') throw new Error('invalid status');
      snapshot = result;
    } catch {
      // Do not display or log service errors: they may contain connection credentials.
      error.textContent = action === 'mobileRemoteStart' ? '开启失败，请检查本地端口是否有效或已被占用。' : '操作失败，请检查远程服务状态后重试。'; error.hidden = false;
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
