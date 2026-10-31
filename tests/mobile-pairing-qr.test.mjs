import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { mobilePairingQr } = createRequire(import.meta.url)('../src/core/mobile-pairing-qr.cjs');
const fake = () => ({ enabled:true, addresses:['https://192.168.10.2:51234','https://100.64.0.1:51234'], fingerprint:Array(32).fill('AB').join(':'), token:'a'.repeat(43) });

test('pairing QR uses the active address and returns only a local boolean matrix', () => {
  const status=fake(), a=mobilePairingQr(status,status.addresses[0]), b=mobilePairingQr(status,status.addresses[1]);
  assert.ok(a.size>=21 && a.size<=177); assert.equal(a.modules.length,a.size);
  assert.ok(a.modules.every(row=>row.length===a.size && row.every(value=>typeof value==='boolean')));
  assert.notDeepEqual(a.modules,b.modules); assert.ok(!JSON.stringify(a).includes(status.token));
});
test('pairing QR rejects stopped services, unknown addresses and malformed credentials', () => {
  const status=fake(); assert.throws(()=>mobilePairingQr({...status,enabled:false},status.addresses[0]));
  assert.throws(()=>mobilePairingQr(status,'https://evil.example:443'));
  assert.throws(()=>mobilePairingQr({...status,addresses:['https://999.0.0.1:123']},'https://999.0.0.1:123'));
  assert.throws(()=>mobilePairingQr({...status,token:'token'},status.addresses[0]));
  assert.throws(()=>mobilePairingQr({...status,fingerprint:'AA:BB'},status.addresses[0]));
});

test('explicit external pairing accepts a TCP tunnel hostname or IPv4 without weakening the default', () => {
  const status=fake();
  for (const address of ['https://cn-hk-1.natfrp.cloud:45678','https://203.0.113.42:12345']) {
    assert.throws(()=>mobilePairingQr(status,address));
    const qr=mobilePairingQr(status,address,{allowExternal:true});
    assert.ok(qr.modules.length===qr.size && qr.size>=21);
    assert.throws(()=>mobilePairingQr({...status,enabled:false},address,{allowExternal:true}));
  }
});

test('external pairing rejects malformed and ambiguous URLs', () => {
  const status=fake();
  for (const address of [
    'http://node.example:1234','https://node.example','https://node.example:0',
    'https://node.example:65536','https://user@node.example:1234',
    'https://node.example:1234/path','https://node.example:1234?x=1',
    'https://node.example:1234#x','https://-bad.example:1234',
    'https://bad..example:1234','https://999.0.0.1:1234',
    'https://127.01.0.1:1234','https://node.example:1234\n',
    'https://[::1]:1234','https://node.example:1234\\evil'
  ]) assert.throws(()=>mobilePairingQr(status,address,{allowExternal:true}),address);
});
