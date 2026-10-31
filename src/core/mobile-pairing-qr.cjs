'use strict';

const qrcode = require('qrcode-generator');

// The pairing secret stays in memory and is encoded locally. Never log or persist it.
function mobilePairingQr(status, address, options = {}) {
  if (!status || status.enabled !== true || !Array.isArray(status.addresses) || typeof address !== 'string' || (!status.addresses.includes(address) && options?.allowExternal !== true)) throw new Error('远程连接未开启或地址不可用。');
  // Accept a literal IPv4 or DNS hostname only; never allow URL paths, credentials,
  // fragments, query parameters, or characters that need URL normalization.
  const match = /^https:\/\/([A-Za-z0-9.-]+):(\d{1,5})$/.exec(address);
  const host = match?.[1] || '';
  const labels = host.split('.');
  const isNumericHost = /^[0-9.]+$/.test(host);
  const validHost = host.length <= 253 && labels.every(label => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)) &&
    (!isNumericHost || (labels.length === 4 && labels.every(part => Number(part) <= 255 && (part.length === 1 || part[0] !== '0'))));
  if (!match || match[0] !== address || !validHost || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error('连接地址无效。');
  if (typeof status.fingerprint !== 'string' || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(status.fingerprint) || typeof status.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(status.token)) throw new Error('配对信息无效。');
  const payload = JSON.stringify({ v: 1, url: address, fingerprint: status.fingerprint.toUpperCase(), token: status.token });
  const qr = qrcode(0, 'M'); qr.addData(payload, 'Byte'); qr.make();
  const size = qr.getModuleCount(), modules = [];
  for (let y=0; y<size; y++) { const row=[]; for (let x=0; x<size; x++) row.push(qr.isDark(y,x)); modules.push(row); }
  return { size, modules };
}
module.exports = { mobilePairingQr };
