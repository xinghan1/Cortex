'use strict';

// Synthetic pairing data only; stdout can be saved as the fixture consumed by
// PairingPayloadTest. It does not contain a real network address or token.
const { mobilePairingQr } = require('../../src/core/mobile-pairing-qr.cjs');
const address = 'https://192.168.1.10:3456';
process.stdout.write(JSON.stringify(mobilePairingQr({
  enabled: true,
  addresses: [address],
  fingerprint: Array(32).fill('AA').join(':'),
  token: 'A'.repeat(43),
}, address)));
