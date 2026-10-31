import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/renderer/mobile-remote.js', import.meta.url), 'utf8');
class Element {
  constructor(doc) { this.doc = doc; this.children = []; this.listeners = {}; this.attributes = {}; this.disabled = false; this.hidden = false; this.open = false; this.textContent = ''; }
  set id(value) { this.doc.nodes.set(value, this); }
  set innerHTML(_) { throw new Error('Untrusted values must stay text'); }
  setAttribute(key, value) { this.attributes[key] = value; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  getContext() { return { fillRect() {} }; }
  showModal() { this.open = true; }
  close() { this.open = false; this.listeners.close?.(); }
  click() { return this.disabled ? undefined : this.listeners.click?.(); }
}
function fixture(qr = async () => ({size:21,modules:Array.from({length:21},()=>Array(21).fill(false))})) {
  const document = { nodes: new Map(), createElement() { return new Element(document); } }; document.body = new Element(document);
  let state = { enabled: false, addresses: [], token: null, fingerprint: null }, fail = false;
  const calls = [], qrCalls = [], ports = [];
  const bridge = {
    async mobileRemoteStatus() { calls.push('status'); if (fail) throw Error('secret'); return state; },
    async mobileRemoteStart(arg) { calls.push('start'); ports.push(arg.port); state = { enabled: true, addresses: ['https://10.0.0.1:123', '<script>'], token: 'private-token', fingerprint: 'AA:BB' }; return state; },
    async mobileRemoteStop() { calls.push('stop'); state = { enabled: false, addresses: [], token: null, fingerprint: null }; return state; },
    async mobileRemoteQr(arg) { qrCalls.push(arg.url); return qr(arg); }
  };
  const window = { forge: bridge }; vm.runInNewContext(source, { window, document });
  return { ui: window.CortexMobileRemote, calls, qrCalls, ports, node: id => document.nodes.get(id), fail: value => { fail = value; }, setState: value => { state=value; } };
}

test('remote access is explicit, credentials are text, and close does not stop it', async () => {
  const f = fixture(); await f.ui.open();
  assert.deepEqual(f.calls, ['status']); assert.equal(f.node('mobile-remote-start').disabled, false); assert.equal(f.node('mobile-remote-stop').disabled, true);
  await f.node('mobile-remote-start').click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.node('mobile-remote-info').hidden, false); assert.equal(f.node('mobile-remote-token').textContent, 'private-token');
  assert.equal(f.node('mobile-remote-addresses').children[1].textContent, '<script>');
  assert.deepEqual(f.qrCalls, ['https://10.0.0.1:123']); assert.equal(f.node('mobile-remote-qr-image').hidden,false);
  f.node('mobile-remote-dialog').close(); assert.equal(f.node('mobile-remote-token').textContent,''); assert.equal(f.node('mobile-remote-qr-image').width,1); assert.deepEqual(f.calls, ['status', 'start']);
  await f.ui.open(); await f.node('mobile-remote-stop').click();
  assert.equal(f.node('mobile-remote-info').hidden, true); assert.equal(f.node('mobile-remote-token').textContent, '');
  assert.deepEqual(f.calls, ['status', 'start', 'status', 'stop']);
});

test('fixed port is validated before starting and passed to the service', async () => {
  const f=fixture(); await f.ui.open(); const port=f.node('mobile-remote-port');
  port.value='65536'; await f.node('mobile-remote-start').click();
  assert.deepEqual(f.calls,['status','status']); assert.match(f.node('mobile-remote-error').textContent,/端口/);
  port.value='47839'; await f.node('mobile-remote-start').click();
  assert.deepEqual(f.ports,[47839]); assert.equal(port.disabled,true);
});

test('late QR result after closing the panel cannot expose credentials', async () => {
  let finish; const f=fixture(()=>new Promise(resolve=>{finish=resolve;})); await f.ui.open(); await f.node('mobile-remote-start').click();
  f.node('mobile-remote-dialog').close(); finish({size:21,modules:Array.from({length:21},()=>Array(21).fill(true))}); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.node('mobile-remote-qr-image').hidden,true); assert.equal(f.node('mobile-remote-token').textContent,'');
});

test('selecting another network address refreshes the QR without external requests', async () => {
  const f=fixture(); f.setState({enabled:true,addresses:['https://192.168.1.5:1234','https://100.64.0.1:1234'],fingerprint:'AA:BB',token:'fake'});
  await f.ui.open(); await new Promise(resolve=>setImmediate(resolve));
  const selector=f.node('mobile-remote-qr-address'); selector.value='https://100.64.0.1:1234';selector.listeners.change();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.qrCalls,['https://192.168.1.5:1234','https://100.64.0.1:1234']); assert.deepEqual(f.calls,['status']);
});

test('a user supplied tunnel address can be used for pairing without replacing the local address', async () => {
  const f=fixture(); f.setState({enabled:true,addresses:['https://192.168.1.5:1234'],fingerprint:'AA:BB',token:'fake'});
  await f.ui.open(); await new Promise(resolve=>setImmediate(resolve));
  f.node('mobile-remote-tunnel-address').value='HTTPS://node.example.com:4567';
  f.node('mobile-remote-tunnel-apply').click(); await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.qrCalls,['https://192.168.1.5:1234','https://node.example.com:4567']);
  assert.equal(f.node('mobile-remote-qr-address').value,'https://node.example.com:4567');
  assert.equal(f.node('mobile-remote-qr-image').hidden,false);
  await f.node('mobile-remote-refresh').click(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.node('mobile-remote-qr-address').children.filter(option => option.value === 'https://node.example.com:4567').length, 1);
});

test('actual listening port remains visible with no network interface', async () => {
  const f=fixture(); f.setState({enabled:true,addresses:[],port:47839,fingerprint:'AA:BB',token:'fake'});
  await f.ui.open(); assert.equal(f.node('mobile-remote-listening-port').textContent,'47839');
  f.node('mobile-remote-dialog').close(); assert.equal(f.node('mobile-remote-listening-port').textContent,'');
});

test('status failure hides sensitive error and allows retry', async () => {
  const f = fixture(); f.fail(true); await f.ui.open();
  assert.equal(f.node('mobile-remote-error').hidden, false); assert.doesNotMatch(f.node('mobile-remote-error').textContent, /secret/);
  assert.equal(f.node('mobile-remote-start').disabled, true); assert.equal(f.node('mobile-remote-refresh').disabled, false);
  f.fail(false); await f.node('mobile-remote-refresh').click();
  assert.equal(f.node('mobile-remote-error').hidden, true); assert.equal(f.node('mobile-remote-start').disabled, false);
});

test('remote instructions are available on demand without starting or stopping the service', async () => {
  const f = fixture(); await f.ui.open();
  const main = f.node('mobile-remote-dialog'), help = f.node('mobile-remote-help-dialog');
  assert.equal(help.open, false); assert.equal(main.children.some(node => node.className === 'mobile-remote-guidance'), false);
  f.node('mobile-remote-help').click(); assert.equal(help.open, true); assert.deepEqual(f.calls, ['status']);
  const text = help.children.flatMap(node => node.children || []).map(node => node.textContent).join(' ');
  assert.match(text, /樱花内网穿透/); assert.match(text, /TCP/); assert.match(text, /证书指纹/); assert.match(text, /停止远程连接/);
  f.node('mobile-remote-help-close').click(); assert.equal(help.open, false); assert.equal(main.open, true); assert.deepEqual(f.calls, ['status']);
});
