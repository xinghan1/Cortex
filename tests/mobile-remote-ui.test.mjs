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
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { return this.disabled ? undefined : this.listeners.click?.(); }
}
function fixture() {
  const document = { nodes: new Map(), createElement() { return new Element(document); } }; document.body = new Element(document);
  let state = { enabled: false, addresses: [], token: null, fingerprint: null }, fail = false;
  const calls = [];
  const bridge = {
    async mobileRemoteStatus() { calls.push('status'); if (fail) throw Error('secret'); return state; },
    async mobileRemoteStart() { calls.push('start'); state = { enabled: true, addresses: ['https://10.0.0.1:123', '<script>'], token: 'private-token', fingerprint: 'AA:BB' }; return state; },
    async mobileRemoteStop() { calls.push('stop'); state = { enabled: false, addresses: [], token: null, fingerprint: null }; return state; }
  };
  const window = { forge: bridge }; vm.runInNewContext(source, { window, document });
  return { ui: window.CortexMobileRemote, calls, node: id => document.nodes.get(id), fail: value => { fail = value; } };
}

test('remote access is explicit, credentials are text, and close does not stop it', async () => {
  const f = fixture(); await f.ui.open();
  assert.deepEqual(f.calls, ['status']); assert.equal(f.node('mobile-remote-start').disabled, false); assert.equal(f.node('mobile-remote-stop').disabled, true);
  await f.node('mobile-remote-start').click();
  assert.equal(f.node('mobile-remote-info').hidden, false); assert.equal(f.node('mobile-remote-token').textContent, 'private-token');
  assert.equal(f.node('mobile-remote-addresses').children[1].textContent, '<script>');
  f.node('mobile-remote-dialog').close(); assert.deepEqual(f.calls, ['status', 'start']);
  await f.ui.open(); await f.node('mobile-remote-stop').click();
  assert.equal(f.node('mobile-remote-info').hidden, true); assert.equal(f.node('mobile-remote-token').textContent, '');
  assert.deepEqual(f.calls, ['status', 'start', 'status', 'stop']);
});

test('status failure hides sensitive error and allows retry', async () => {
  const f = fixture(); f.fail(true); await f.ui.open();
  assert.equal(f.node('mobile-remote-error').hidden, false); assert.doesNotMatch(f.node('mobile-remote-error').textContent, /secret/);
  assert.equal(f.node('mobile-remote-start').disabled, true); assert.equal(f.node('mobile-remote-refresh').disabled, false);
  f.fail(false); await f.node('mobile-remote-refresh').click();
  assert.equal(f.node('mobile-remote-error').hidden, true); assert.equal(f.node('mobile-remote-start').disabled, false);
});
