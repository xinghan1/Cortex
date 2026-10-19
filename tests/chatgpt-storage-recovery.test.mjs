import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatGPTConnection } from '../src/core/chatgpt.mjs';
import { preserveUnreadableChatGPTCredentials } from '../src/core/chatgpt-storage-recovery.mjs';
import { createChatGPT } from '../src/vendor/siwc/index.js';
import { ConnectionStore } from '../src/vendor/siwc/storage.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function savedState() {
  return {
    version: 2, activeProfileId: 'synthetic-profile', pendingRegistrations: [],
    profiles: [{ version: 1, id: 'synthetic-profile', label: 'Synthetic profile', clientId: 'synthetic_client',
      status: 'connected', scopes: ['openid', 'chatgpt.tokens.use.direct'], savedAt: '2026-01-01T00:00:00.000Z',
      credentials: { accessToken: 'synthetic-test-token-never-valid', expiresAt: 4102444800000 } }],
  };
}

async function fixture(t, wrapClient = client => client) {
  let networkCalls = 0, browserCalls = 0;
  t.mock.method(globalThis, 'fetch', () => { networkCalls++; throw new Error('Network disabled for synthetic credential tests'); });
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'synora-chatgpt-recovery-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dataDir)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(dataDir).startsWith('synora-chatgpt-recovery-'));
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const key = randomBytes(32);
  const crypto = {
    available: true, broken: false,
    isEncryptionAvailable() { return this.available; },
    encryptString(value) {
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return Buffer.concat([nonce, encrypted, cipher.getAuthTag()]);
    },
    decryptString(value) {
      if (this.broken) throw new Error('Synthetic OS credential store failure');
      const bytes = Buffer.from(value), decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
    },
  };
  const encryption = {
    id: 'forgedesk-electron-safe-storage-v1', isAvailable: () => crypto.isEncryptionAvailable(),
    encrypt: text => crypto.encryptString(text), decrypt: bytes => crypto.decryptString(bytes),
  };
  const directory = path.join(dataDir, 'chatgpt'), filename = path.join(directory, 'chatgpt-auth.json');
  const store = new ConnectionStore(directory, encryption);
  await store.withLock(() => store.write(savedState()));
  const host = '{"version":1,"id":"synthetic-runtime-id-preserved"}';
  await fs.writeFile(path.join(directory, 'chatgpt-host.json'), host);
  const clients = [], calls = { signIn: 0, listModels: 0, withAccessToken: 0 };
  const connection = new ChatGPTConnection({ dataDir, safeStorage: crypto,
    openExternal: () => { browserCalls++; throw new Error('Browser disabled for synthetic credential tests'); },
    createClient: config => {
      const client = wrapClient(createChatGPT(config), clients.length);
      for (const name of Object.keys(calls)) {
        const method = client[name];
        client[name] = (...args) => { calls[name]++; return method.apply(client, args); };
      }
      clients.push(client); return client;
    },
  });
  return { connection, crypto, encryption, directory, filename, store, host, clients, calls,
    get networkCalls() { return networkCalls; }, get browserCalls() { return browserCalls; },
    backups: async () => (await fs.readdir(directory)).filter(name => name.startsWith('.chatgpt-preserved-')),
  };
}

test('local retry restores a readable saved account without OAuth, quota probes or credential replacement', async t => {
  const h = await fixture(t);
  h.crypto.broken = true;
  const original = await fs.readFile(h.filename);
  assert.equal((await h.connection.init()).session.error.code, 'storage_decryption_failed');
  assert.equal((await h.connection.retryLocalRead()).session.error.code, 'storage_decryption_failed');
  assert.deepEqual(await fs.readFile(h.filename), original);
  assert.deepEqual(await h.backups(), []);
  h.crypto.broken = false;
  const state = await h.connection.retryLocalRead();
  assert.equal(state.session.status, 'connected');
  assert.equal(state.session.sharing, true);
  assert.equal(state.session.error, undefined);
  assert.equal(state.profiles.length, 1);
  assert.equal(h.clients.length, 3);
  assert.deepEqual(h.calls, { signIn: 0, listModels: 0, withAccessToken: 0 });
  assert.equal(h.networkCalls, 0); assert.equal(h.browserCalls, 0);
  assert.deepEqual(await fs.readFile(h.filename), original);
});

test('local retry clears the SDK sticky storage error on the same connected profile without reauthorization', async t => {
  const h = await fixture(t);
  const initial = await h.connection.init(), original = await fs.readFile(h.filename);
  h.crypto.broken = true;
  await assert.rejects(h.connection.requestModel({ requestModel: () => assert.fail('Provider must not run when local credentials cannot be read') }), { code: 'storage_decryption_failed' });
  const broken = await h.connection.publicState();
  assert.equal(broken.session.status, 'connected');
  assert.equal(broken.session.profileId, initial.session.profileId);
  assert.equal(broken.session.error.code, 'storage_decryption_failed');
  h.crypto.broken = false;
  // This exact SDK behavior makes merely repeating getSession insufficient.
  assert.equal((await h.clients[0].getSession()).error.code, 'storage_decryption_failed');
  const repaired = await h.connection.retryLocalRead();
  assert.equal(repaired.session.status, 'connected');
  assert.equal(repaired.session.profileId, initial.session.profileId);
  assert.equal(repaired.session.error, undefined);
  assert.equal(repaired.profiles.length, 1); assert.equal(h.clients.length, 2);
  assert.equal(h.calls.signIn, 0); assert.equal(h.calls.listModels, 0);
  assert.equal(h.networkCalls, 0); assert.equal(h.browserCalls, 0);
  assert.deepEqual(await h.backups(), []); assert.deepEqual(await fs.readFile(h.filename), original);
});

for (const code of ['storage_decryption_failed', 'storage_provider_mismatch', 'storage_encrypted_invalid', 'storage_invalid']) {
  test(`explicit logout preserves the exact unreadable file and host for ${code}`, async t => {
    const h = await fixture(t);
    if (code === 'storage_decryption_failed') h.crypto.broken = true;
    else if (code === 'storage_invalid') await fs.writeFile(h.filename, '{synthetic malformed JSON');
    else {
      const envelope = JSON.parse(await fs.readFile(h.filename, 'utf8'));
      if (code === 'storage_provider_mismatch') envelope.provider = 'synthetic-other-provider';
      else envelope.ciphertext = 'not-base64!';
      await fs.writeFile(h.filename, JSON.stringify(envelope));
    }
    const original = await fs.readFile(h.filename);
    assert.equal((await h.connection.init()).session.error.code, code);
    assert.deepEqual(await h.backups(), []);
    const result = await h.connection.disconnect();
    assert.deepEqual(result.recovery, { backupCreated: true });
    assert.equal(result.session.status, 'disconnected'); assert.equal(result.session.sharing, false);
    assert.match(result.warning, /已退出本机.*保留为备份.*不能确认远程撤销/);
    assert.equal(result.session.error.code, 'local_disconnect_only');
    assert.deepEqual((await h.connection.publicState()).session.error, result.session.error);
    assert.deepEqual(result.profiles, []); assert.deepEqual(result.models, []);
    assert.equal(result.usage.status, 'not_connected');
    const backups = await h.backups(); assert.equal(backups.length, 1);
    assert.deepEqual(await fs.readFile(path.join(h.directory, backups[0], 'chatgpt-auth.json')), original);
    await assert.rejects(fs.access(h.filename), { code: 'ENOENT' });
    assert.equal(await fs.readFile(path.join(h.directory, 'chatgpt-host.json'), 'utf8'), h.host);
    const restarted = await h.connection.retryLocalRead();
    assert.equal(restarted.session.status, 'disconnected'); assert.equal(restarted.session.error, undefined);
    assert.equal(h.clients.length, 2);
    assert.equal(h.networkCalls, 0); assert.equal(h.browserCalls, 0);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-test-token|ciphertext|backupDirectory|dataDir|synora-chatgpt-recovery-/);
  });
}

test('SDK locking serializes recovery and a healthy reread never quarantines usable credentials', async t => {
  const h = await fixture(t);
  const original = await fs.readFile(h.filename), gate = deferred(), locked = deferred();
  const held = h.store.withLock(async () => { locked.resolve(); await gate.promise; });
  await locked.promise;
  let settled = false;
  const pending = preserveUnreadableChatGPTCredentials({ directory: h.directory, encryption: h.encryption }).then(value => { settled = true; return value; });
  await tick(); assert.equal(settled, false);
  gate.resolve(); await held;
  assert.deepEqual(await pending, { backupCreated: false });
  assert.deepEqual(await fs.readFile(h.filename), original); assert.deepEqual(await h.backups(), []);
});

test('failed recovery rename leaves original credentials, public state and host intact', async t => {
  const h = await fixture(t); h.crypto.broken = true;
  const state = await h.connection.init(), original = await fs.readFile(h.filename);
  t.mock.method(fs, 'rename', async () => { throw Object.assign(new Error('Synthetic denied rename'), { code: 'EPERM' }); });
  await assert.rejects(h.connection.disconnect(), { code: 'storage_recovery_failed' });
  assert.deepEqual(await fs.readFile(h.filename), original);
  assert.deepEqual(await h.connection.publicState(), state);
  assert.deepEqual(await h.backups(), []);
  assert.equal(await fs.readFile(path.join(h.directory, 'chatgpt-host.json'), 'utf8'), h.host);
  assert.equal(h.clients.length, 1);
});

test('recovery refuses hard linked credential files and does not overwrite an earlier backup', async t => {
  const h = await fixture(t); h.crypto.broken = true;
  const original = await fs.readFile(h.filename);
  const link = path.join(h.directory, 'synthetic-hardlink');
  await fs.link(h.filename, link);
  await assert.rejects(preserveUnreadableChatGPTCredentials({ directory: h.directory, encryption: h.encryption }), { code: 'storage_recovery_failed' });
  assert.deepEqual(await fs.readFile(h.filename), original); assert.deepEqual(await h.backups(), []);
  await fs.unlink(link);
  assert.deepEqual(await preserveUnreadableChatGPTCredentials({ directory: h.directory, encryption: h.encryption }), { backupCreated: true });
  const first = (await h.backups())[0];
  await fs.writeFile(h.filename, original);
  assert.deepEqual(await preserveUnreadableChatGPTCredentials({ directory: h.directory, encryption: h.encryption }), { backupCreated: true });
  const backups = await h.backups(); assert.equal(backups.length, 2);
  assert.ok(backups.includes(first));
  for (const backup of backups) assert.deepEqual(await fs.readFile(path.join(h.directory, backup, 'chatgpt-auth.json')), original);
});

test('a credential file changed before the recovery commit remains untouched at its original path', async t => {
  const h = await fixture(t); h.crypto.broken = true;
  const replacement = 'synthetic external replacement must remain untouched';
  const mkdir = fs.mkdtemp.bind(fs);
  t.mock.method(fs, 'mkdtemp', async (...args) => {
    const created = await mkdir(...args);
    await fs.writeFile(h.filename, replacement);
    return created;
  });
  await assert.rejects(preserveUnreadableChatGPTCredentials({ directory: h.directory, encryption: h.encryption }), { code: 'storage_recovery_failed' });
  assert.equal(await fs.readFile(h.filename, 'utf8'), replacement);
  assert.deepEqual(await h.backups(), []);
  assert.equal(await fs.readFile(path.join(h.directory, 'chatgpt-host.json'), 'utf8'), h.host);
});

test('encryption unavailability, ordinary storage errors and network errors never trigger backup logout', async t => {
  for (const code of ['storage_error', 'storage_busy', 'storage_lock_lost', 'network_error', 'storage_encryption_unavailable']) {
    const h = await fixture(t, client => ({ ...client, disconnect: async () => { throw Object.assign(new Error('Synthetic non-recovery error'), { code }); } }));
    await h.connection.init();
    const state = await h.connection.publicState(), original = await fs.readFile(h.filename);
    await assert.rejects(h.connection.disconnect(), { code });
    assert.deepEqual(await h.connection.publicState(), state);
    assert.deepEqual(await fs.readFile(h.filename), original); assert.deepEqual(await h.backups(), []);
  }
  const h = await fixture(t);
  const initial = await h.connection.init(), original = await fs.readFile(h.filename);
  h.crypto.available = false;
  await assert.rejects(h.connection.disconnect(), { code: 'storage_encryption_unavailable' });
  assert.deepEqual(await h.connection.publicState(), initial);
  assert.deepEqual(await fs.readFile(h.filename), original); assert.deepEqual(await h.backups(), []);
});

test('reset isolates late profile callbacks, catalogs and requests from the retired SDK client', async t => {
  const profiles = deferred(), models = deferred(), response = deferred(), providerEntered = deferred();
  const listeners = []; let holdProfiles = false;
  const h = await fixture(t, (client, index) => index ? client : ({ ...client,
    subscribe(listener) { listeners.push(listener); return client.subscribe(listener); },
    listProfiles() { return holdProfiles ? profiles.promise : client.listProfiles(); },
    listModels() { return models.promise; },
  }));
  const initial = await h.connection.init();
  await h.connection.requestModel({ requestModel: async () => ({ content: 'synthetic success' }) });
  assert.equal((await h.connection.publicState()).usage.status, 'request_succeeded');
  const pendingCatalog = h.connection.listModels();
  const pendingResponse = h.connection.requestModel({ requestModel: async () => { providerEntered.resolve(); return response.promise; } });
  // Install rejection handlers before deliberately retiring these operations.
  const rejectedCatalog = assert.rejects(pendingCatalog, { code: 'cancelled' });
  const rejectedResponse = assert.rejects(pendingResponse, { code: 'cancelled' });
  await providerEntered.promise;
  holdProfiles = true; listeners[0]({ ...initial.session, profileLabel: 'Synthetic late old label' });
  await tick();
  h.crypto.broken = true;
  await h.connection.disconnect();
  h.crypto.broken = false;
  await h.connection.retryLocalRead();
  listeners[0](initial.session);
  profiles.resolve(initial.profiles);
  models.resolve([{ slug: 'synthetic-old-model', displayName: 'Synthetic old model' }]);
  response.resolve({ content: 'late synthetic response' });
  await Promise.all([rejectedCatalog, rejectedResponse]); await tick();
  const current = await h.connection.publicState();
  assert.equal(current.session.status, 'disconnected'); assert.equal(current.session.sharing, false);
  assert.equal(current.session.error, undefined);
  assert.deepEqual(current.profiles, []); assert.deepEqual(current.models, []);
  assert.equal(current.usage.status, 'not_connected'); assert.equal(h.clients.length, 2);
  assert.equal(h.networkCalls, 0); assert.equal(h.browserCalls, 0);
});
