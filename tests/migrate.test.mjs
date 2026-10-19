import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const { migrateLegacyData, findLegacyData, prepareLegacyEncryptionState } = createRequire(import.meta.url)('../src/core/migrate.cjs');

test('portable upgrade copies existing encrypted settings and sessions once without caches', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forgedesk-migration-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temp).startsWith('forgedesk-migration-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const oldData = path.join(temp, 'old', 'data'), newData = path.join(temp, 'new', 'data');
  const id = randomUUID();
  await fs.mkdir(path.join(oldData, 'sessions'), { recursive: true });
  await fs.writeFile(path.join(oldData, 'settings.json'), '{"encryptedKey":"encrypted bytes"}');
  await fs.writeFile(path.join(oldData, 'preferences.json'), '{"version":1,"textScale":130}');
  await fs.writeFile(path.join(oldData, 'projects.json'), '{"version":1,"projects":[]}');
  await fs.writeFile(path.join(oldData, 'sessions', id + '.json'), '{}');
  await fs.writeFile(path.join(oldData, 'sessions', 'not-a-session.txt'), 'ignore');
  await fs.mkdir(path.join(oldData, 'chromium')); await fs.writeFile(path.join(oldData, 'chromium', 'cookie'), 'ignore');
  const cryptoState = { audit_enabled: true, encrypted_key: 'synthetic-os-protected-key' };
  await fs.writeFile(path.join(oldData, 'chromium', 'Local State'), JSON.stringify({ os_crypt: cryptoState, unrelated_browser_state: 'do not copy' }));
  await fs.mkdir(path.join(oldData, 'chatgpt'));
  await fs.writeFile(path.join(oldData, 'chatgpt', 'chatgpt-host.json'), '{"id":"same-runtime"}');
  await fs.writeFile(path.join(oldData, 'chatgpt', 'chatgpt-auth.json'), '{"encrypted":"fake-encrypted-account"}');
  await fs.writeFile(path.join(oldData, 'chatgpt', '.chatgpt-auth.lock'), 'ignore');
  assert.equal(await migrateLegacyData(newData, oldData), true);
  assert.equal(await fs.readFile(path.join(newData, 'settings.json'), 'utf8'), '{"encryptedKey":"encrypted bytes"}');
  assert.equal(await fs.readFile(path.join(newData, 'preferences.json'), 'utf8'), '{"version":1,"textScale":130}');
  assert.equal(await fs.readFile(path.join(newData, 'projects.json'), 'utf8'), '{"version":1,"projects":[]}');
  assert.deepEqual(await fs.readdir(path.join(newData, 'sessions')), [id + '.json']);
  assert.deepEqual(await fs.readdir(path.join(newData, 'chromium')), ['Local State']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(newData, 'chromium', 'Local State'), 'utf8')), { os_crypt: cryptoState });
  assert.deepEqual((await fs.readdir(path.join(newData, 'chatgpt'))).sort(), ['chatgpt-auth.json', 'chatgpt-host.json']);
  assert.equal(await fs.readFile(path.join(newData, 'chatgpt', 'chatgpt-auth.json'), 'utf8'), '{"encrypted":"fake-encrypted-account"}');
  await fs.writeFile(path.join(oldData, 'settings.json'), 'changed');
  assert.equal(await migrateLegacyData(newData, oldData), false);
  assert.match(await fs.readFile(path.join(newData, 'settings.json'), 'utf8'), /encrypted bytes/);
  assert.equal(await migrateLegacyData(newData, path.join(temp, 'absent')), false);
});

test('encryption preflight selects the newest real installation and preserves an existing key', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forgedesk-migration-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temp).startsWith('forgedesk-migration-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const source = path.join(temp, 'source'), target = path.join(temp, 'target'), empty = path.join(temp, 'empty');
  await fs.mkdir(path.join(source, 'chromium'), { recursive: true });
  await fs.mkdir(empty);
  await fs.writeFile(path.join(source, 'settings.json'), '{}');
  const crypt = { encrypted_key: 'protected-key', audit_enabled: true };
  await fs.writeFile(path.join(source, 'chromium', 'Local State'), JSON.stringify({ os_crypt: crypt, cookies: 'unrelated' }));
  assert.equal(findLegacyData(target, [empty, source]), source);
  assert.equal(prepareLegacyEncryptionState(target, source), true);
  const stateFile = path.join(target, 'chromium', 'Local State');
  const nativeState = JSON.stringify({ os_crypt: { ...crypt, native_extra: true }, native_only: 'retained' });
  await fs.writeFile(stateFile, nativeState);
  assert.equal(prepareLegacyEncryptionState(target, source), false);
  assert.equal(await fs.readFile(stateFile, 'utf8'), nativeState);
  await fs.writeFile(stateFile, JSON.stringify({ os_crypt: { encrypted_key: 'newer-key' } }));
  const differentKey = await fs.readFile(stateFile);
  await assert.rejects(migrateLegacyData(target, source), /不同的加密状态/);
  assert.deepEqual(await fs.readFile(stateFile), differentKey);
  await assert.rejects(fs.access(path.join(target, 'settings.json')), { code: 'ENOENT' });
  await fs.writeFile(path.join(target, 'settings.json'), '{}');
  assert.equal(findLegacyData(target, [source]), null);
  assert.equal(prepareLegacyEncryptionState(target, source), false);
  assert.deepEqual(await fs.readFile(stateFile), differentKey);
});

test('unreadable encryption state cannot cause a partial credential migration', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forgedesk-migration-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temp).startsWith('forgedesk-migration-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const source = path.join(temp, 'source'), target = path.join(temp, 'target');
  await fs.mkdir(path.join(source, 'chromium'), { recursive: true });
  await fs.mkdir(path.join(source, 'chatgpt'));
  await fs.writeFile(path.join(source, 'settings.json'), '{}');
  await fs.writeFile(path.join(source, 'chatgpt', 'chatgpt-auth.json'), 'synthetic encrypted credentials');
  await fs.writeFile(path.join(source, 'chromium', 'Local State'), '{broken native state');
  await assert.rejects(migrateLegacyData(target, source), /加密状态无法读取/);
  await assert.rejects(fs.access(path.join(target, 'chatgpt', 'chatgpt-auth.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(target, 'settings.json')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(source, 'chatgpt', 'chatgpt-auth.json'), 'utf8'), 'synthetic encrypted credentials');
});

test('existing recent projects mark a destination as initialized and are not overwritten during migration', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forgedesk-migration-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temp).startsWith('forgedesk-migration-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  const oldData = path.join(temp, 'old'), newData = path.join(temp, 'new');
  await fs.mkdir(oldData); await fs.mkdir(newData);
  await fs.writeFile(path.join(oldData, 'settings.json'), '{"legacy":true}');
  await fs.writeFile(path.join(newData, 'projects.json'), '{"version":1,"projects":[]}');
  assert.equal(await migrateLegacyData(newData, oldData), false);
  assert.equal(await fs.readFile(path.join(newData, 'projects.json'), 'utf8'), '{"version":1,"projects":[]}');
  await assert.rejects(fs.access(path.join(newData, 'settings.json')), { code: 'ENOENT' });
});

test('encrypted credentials without their encryption context are never migrated silently', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forgedesk-migration-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(temp).startsWith('forgedesk-migration-'));
    await fs.rm(temp, { recursive: true, force: true });
  });
  for (const kind of ['account', 'api-key']) {
    const source = path.join(temp, kind), target = path.join(temp, kind + '-target');
    await fs.mkdir(source);
    if (kind === 'account') {
      await fs.mkdir(path.join(source, 'chatgpt'));
      await fs.writeFile(path.join(source, 'chatgpt', 'chatgpt-auth.json'), 'synthetic encrypted account');
    } else await fs.writeFile(path.join(source, 'settings.json'), JSON.stringify({ providers: { openai: { encryptedKey: 'synthetic encrypted key' } } }));
    await assert.rejects(migrateLegacyData(target, source), /缺少配套的本机加密状态/);
    await assert.rejects(fs.access(path.join(target, 'settings.json')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(target, 'chatgpt', 'chatgpt-auth.json')), { code: 'ENOENT' });
    await fs.mkdir(path.join(source, 'chromium'));
    await fs.writeFile(path.join(source, 'chromium', 'Local State'), '{}');
    assert.throws(() => prepareLegacyEncryptionState(target, source), /缺少配套的本机加密状态/);
  }
});
