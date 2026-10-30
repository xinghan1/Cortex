'use strict';

const qrcode = require('qrcode-generator');

// The pairing secret stays in memory and is encoded locally. Never log or persist it.
function mobilePairingQr(status, address) {
  if (!status || status.enabled !== true || !Array.isArray(status.addresses) || typeof address !== 'string' || !status.addresses.includes(address)) throw new Error('远程连接未开启或地址不可用。');
  const match = /^https:\/\/(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(address);
  if (!match || match[1].split('.').some(part => Number(part) > 255 || (part.length > 1 && part[0] === '0')) || Number(match[2]) < 1 || Number(match[2]) > 65535) throw new Error('连接地址无效。');
  if (typeof status.fingerprint !== 'string' || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/i.test(status.fingerprint) || typeof status.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(status.token)) throw new Error('配对信息无效。');
  const payload = JSON.stringify({ v: 1, url: address, fingerprint: status.fingerprint.toUpperCase(), token: status.token });
  const qr = qrcode(0, 'M'); qr.addData(payload, 'Byte'); qr.make();
  const size = qr.getModuleCount(), modules = [];
  for (let y=0; y<size; y++) { const row=[]; for (let x=0; x<size; x++) row.push(qr.isDark(y,x)); modules.push(row); }
  return { size, modules };
}
module.exports = { mobilePairingQr };
