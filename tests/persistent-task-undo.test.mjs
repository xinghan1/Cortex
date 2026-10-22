import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { testTempRoot } from './helpers/temp-root.mjs';
import { WorkspaceTools } from '../src/core/workspace.mjs';
import { PersistentTaskUndo } from '../src/core/persistent-task-undo.mjs';

function cryptoFixture() {
  const key = randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(text) { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(text), cipher.final(), cipher.getAuthTag()]); },
    decryptString(bytes) { const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16)); return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8'); },
  };
}
async function fixture(t, extra = {}) {
  const dir = await fs.mkdtemp(path.join(testTempRoot, 'synora-persistent-undo-')), root = path.join(dir, 'project'); await fs.mkdir(root);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), path.resolve(testTempRoot).toLowerCase());
    assert.ok(path.basename(dir).startsWith('synora-persistent-undo-'));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const safeStorage = cryptoFixture(), session = { id: randomUUID(), workspace: root, messages: [], events: [] }, runId = randomUUID();
  const settings = { dataDir: dir, safeStorage, ...extra }, store = new PersistentTaskUndo(settings); await store.loadSession(session);
  const tools = new WorkspaceTools(root, { approve: async () => true });
  const record = change => store.record({ runId, sessionId: session.id, workspace: root, change });
  const write = async (relative, content) => {
    let pending;
    const result = await tools.execute('write_file', { path: relative, content }, { onFileChange: change => { pending = record(change); } });
    assert.equal(result.startsWith('错误：'), false, result); await pending;
  };
  const seal = () => store.seal(runId, session.id, root);
  const operate = async (direction = 'undo', source = store, selected = session) => JSON.parse(await source.operate({ sessionId: selected.id,
    workspace: root, runId, direction, workspaceTools: tools, signal: new AbortController().signal }));
  return { dir, root, session, runId, settings, store, tools, write, seal, operate, file: path.join(dir, 'task-undo', `${session.id}.json`) };
}

test('encrypted raw snapshots support undo, restart, redo and another restart without plaintext leakage', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'a.txt'), 'PRIVATE_RAW_original');
  await f.write('a.txt', 'middle'); await f.write('a.txt', 'final'); await f.write('new.txt', 'new'); await f.seal();
  assert.deepEqual(f.store.ids(f.session.id, f.root), [f.runId]);
  const outerText = await fs.readFile(f.file, 'utf8'), outer = JSON.parse(outerText);
  assert.equal(outer.version, 1); assert.equal(typeof outer.encrypted, 'string');
  assert.equal(outerText.includes('PRIVATE_RAW'), false); assert.equal(outerText.includes('a.txt'), false);
  assert.equal((await f.operate()).status, 'completed'); assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'PRIVATE_RAW_original');
  const restarted = new PersistentTaskUndo(f.settings); await restarted.loadSession(f.session);
  assert.deepEqual(restarted.ids(f.session.id, f.root), []); assert.deepEqual(restarted.ids(f.session.id, f.root, 'redo'), [f.runId]);
  assert.equal((await f.operate('redo', restarted)).status, 'completed'); assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'final');
  assert.equal(await fs.readFile(path.join(f.root, 'new.txt'), 'utf8'), 'new');
  const again = new PersistentTaskUndo(f.settings); await again.loadSession(f.session); assert.deepEqual(again.ids(f.session.id, f.root), [f.runId]);
});

test('partial approval persists independent path directions, exposing undo and redo for exactly committed paths', async t => {
  const f = await fixture(t); await f.write('a.txt', 'a'); await f.write('b.txt', 'b'); await f.seal();
  f.tools.approve = async request => request.path === 'a.txt';
  const result = await f.operate(); assert.equal(result.status, 'partial'); assert.deepEqual(result.completed, ['a.txt']);
  const restarted = new PersistentTaskUndo(f.settings); await restarted.loadSession(f.session);
  assert.deepEqual(restarted.ids(f.session.id, f.root), [f.runId]); assert.deepEqual(restarted.ids(f.session.id, f.root, 'redo'), [f.runId]);
  f.tools.approve = async () => true;
  assert.deepEqual((await f.operate('undo', restarted)).completed, ['b.txt']);
  assert.deepEqual(restarted.ids(f.session.id, f.root), []);
});

test('conflicting user edits reject the complete redo preflight without changing any file or saved direction', async t => {
  const f = await fixture(t); await f.write('a.txt', 'a'); await f.write('b.txt', 'b'); await f.seal(); await f.operate();
  await fs.writeFile(path.join(f.root, 'a.txt'), 'user content');
  const original = await fs.readFile(f.file, 'utf8'), result = await f.operate('redo');
  assert.equal(result.status, 'failed'); assert.deepEqual(result.completed, []);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'user content'); await assert.rejects(fs.stat(path.join(f.root, 'b.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(f.file, 'utf8'), original); assert.deepEqual(f.store.ids(f.session.id, f.root, 'redo'), [f.runId]);
});

test('journal persistence failure before file commit stops the batch with no file modification', async t => {
  let fail = false;
  const f = await fixture(t, { filesystem: { ...fs, rename: async (...args) => { if (fail) throw new Error('disk full'); return fs.rename(...args); } } });
  await f.write('a.txt', 'a'); await f.seal(); fail = true;
  const result = await f.operate(); assert.equal(result.status, 'failed'); assert.deepEqual(result.completed, []);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'a'); assert.deepEqual(f.store.ids(f.session.id, f.root), []);
});

test('post-commit persistence failure reports actual partial success, stops later files, and disables uncertain journal after restart', async t => {
  let writes = 0, failAt = Infinity;
  const f = await fixture(t, { filesystem: { ...fs, rename: async (...args) => { writes++; if (writes === failAt) throw new Error('disk full'); return fs.rename(...args); } } });
  await f.write('a.txt', 'a'); await f.write('b.txt', 'b'); await f.seal(); failAt = writes + 2;
  const result = await f.operate(); assert.equal(result.status, 'partial'); assert.deepEqual(result.completed, ['a.txt']);
  await assert.rejects(fs.stat(path.join(f.root, 'a.txt')), { code: 'ENOENT' }); assert.equal(await fs.readFile(path.join(f.root, 'b.txt'), 'utf8'), 'b');
  const restarted = new PersistentTaskUndo(f.settings); await restarted.loadSession(f.session);
  assert.deepEqual(restarted.ids(f.session.id, f.root), []); assert.deepEqual(restarted.ids(f.session.id, f.root, 'redo'), []);
});

test('same-project undo operations are coordinated across windows and session/project identity remains strict', async t => {
  const f = await fixture(t); await f.write('a.txt', 'a'); await f.seal();
  let entered, release; const started = new Promise(resolve => { entered = resolve; }), barrier = new Promise(resolve => { release = resolve; });
  f.tools.approve = async () => { entered(); await barrier; return true; };
  const first = f.operate(); await started;
  assert.equal(f.store.isProjectBusy(f.root), true); await assert.rejects(f.operate(), /另一窗口/);
  assert.deepEqual(f.store.ids(randomUUID(), f.root), []); assert.deepEqual(f.store.ids(f.session.id, f.root + '-other'), []);
  release(); assert.equal((await first).status, 'completed'); assert.equal(f.store.isProjectBusy(f.root), false);
});

test('forks copy current directions independently and avoid importing stale source archive state over the encrypted snapshot', async t => {
  const f = await fixture(t); await f.write('a.txt', 'a'); await f.seal(); await f.operate();
  const fork = { ...f.session, id: randomUUID() }; let imports = 0;
  const store = new PersistentTaskUndo({ ...f.settings, legacyTaskUndoRuns: () => { imports++; return []; } });
  await store.loadSession(f.session); await store.copySession(f.session.id, fork);
  assert.equal(imports, 0); assert.deepEqual(store.ids(fork.id, f.root, 'redo'), [f.runId]);
  assert.equal((await f.operate('redo', store, fork)).status, 'completed');
  assert.deepEqual(store.ids(f.session.id, f.root, 'redo'), [f.runId]); assert.deepEqual(store.ids(fork.id, f.root, 'redo'), []);
  assert.equal((await f.operate('redo', store, f.session)).status, 'failed', 'The other branch retains direction but actual disk conflicts prevent overwrite');
});

test('legacy runs import once with proven undone directions; an existing encrypted marker prevents repeated inference', async t => {
  const dir = await fs.mkdtemp(path.join(testTempRoot, 'synora-persistent-undo-'));
  t.after(async () => { assert.equal(path.dirname(dir).toLowerCase(), testTempRoot.toLowerCase()); await fs.rm(dir, { recursive: true, force: true }); });
  const session = { id: randomUUID(), workspace: dir }, runId = randomUUID(), safeStorage = cryptoFixture(); let imports = 0;
  const settings = { dataDir: dir, safeStorage, legacyTaskUndoRuns: () => { imports++; return [{ runId,
    changes: [{ path: 'a.txt', before: null, after: 'a' }], undonePaths: ['a.txt'] }]; } };
  const first = new PersistentTaskUndo(settings); await first.loadSession(session); assert.deepEqual(first.ids(session.id, dir, 'redo'), [runId]);
  const second = new PersistentTaskUndo(settings); await second.loadSession(session); assert.equal(imports, 1);
  assert.deepEqual(second.ids(session.id, dir, 'redo'), [runId]);
});

test('damaged, identity-mismatched, or undecryptable journals remain untouched and never import over originals', async t => {
  for (const kind of ['corrupt', 'wrong-session', 'wrong-key']) {
    const f = await fixture(t); await f.write('a.txt', 'a'); await f.seal();
    if (kind === 'corrupt') await fs.writeFile(f.file, '{damaged');
    if (kind === 'wrong-session') { const value = JSON.parse(await fs.readFile(f.file)); value.sessionId = randomUUID(); await fs.writeFile(f.file, JSON.stringify(value)); }
    const original = await fs.readFile(f.file, 'utf8');
    const restarted = new PersistentTaskUndo({ ...f.settings, ...(kind === 'wrong-key' ? { safeStorage: cryptoFixture() } : {}),
      legacyTaskUndoRuns: () => assert.fail('Never overwrite a damaged encrypted journal') });
    await restarted.loadSession(f.session); assert.deepEqual(restarted.ids(f.session.id, f.root), []);
    assert.throws(() => restarted.record({ runId: randomUUID(), sessionId: f.session.id, workspace: f.root, change: { path: 'a.txt', before: 'a', after: 'b' } }));
    assert.equal(await fs.readFile(f.file, 'utf8'), original);
  }
});

test('temporary sessions retain in-process directions but never create persistent plaintext or encrypted history', async t => {
  const f = await fixture(t); const temporary = { id: randomUUID(), workspace: f.root, temporary: true }, runId = randomUUID();
  await f.store.loadSession(temporary);
  await f.store.record({ runId, sessionId: temporary.id, workspace: f.root, change: { path: 'temp.txt', before: null, after: 'temp' } });
  await f.store.seal(runId, temporary.id, f.root); assert.deepEqual(f.store.ids(temporary.id, f.root), [runId]);
  await assert.rejects(fs.stat(path.join(f.dir, 'task-undo', `${temporary.id}.json`)), { code: 'ENOENT' });
  const restarted = new PersistentTaskUndo(f.settings); await restarted.loadSession(temporary); assert.deepEqual(restarted.ids(temporary.id, f.root), []);
});

test('linked journal files are refused without overwriting their targets', async t => {
  const f = await fixture(t); const original = await fs.readFile(f.file, 'utf8'), link = path.join(f.dir, 'copy.json');
  await fs.link(f.file, link);
  const restarted = new PersistentTaskUndo(f.settings); await restarted.loadSession(f.session); assert.deepEqual(restarted.ids(f.session.id, f.root), []);
  assert.equal(await fs.readFile(link, 'utf8'), original);
});

test('unsealed encrypted snapshots are fully validated before becoming writable or eligible for later sealing', async t => {
  for (const change of [{ path: '../outside.txt', before: null, after: 'bad' }, { path: 'a.txt', before: 1, after: 'bad' },
    { path: 'a.txt', before: null, after: 'x'.repeat(512 * 1024 + 1) }]) {
    const f = await fixture(t), value = { version: 1, importedLegacy: true, sessionId: f.session.id, workspace: f.root,
      runs: [{ runId: f.runId, valid: true, sealed: false, changes: [change] }] };
    const contents = JSON.stringify({ version: 1, sessionId: f.session.id,
      encrypted: f.settings.safeStorage.encryptString(JSON.stringify(value)).toString('base64') });
    await fs.writeFile(f.file, contents);
    const restarted = new PersistentTaskUndo(f.settings); await restarted.loadSession(f.session);
    assert.deepEqual(restarted.ids(f.session.id, f.root), []);
    assert.throws(() => restarted.seal(f.runId, f.session.id, f.root)); assert.equal(await fs.readFile(f.file, 'utf8'), contents);
  }
});

test('cancellation after a durable pending marker but before file commit safely restores the original direction', async t => {
  let writes = 0, abortAt = Infinity; const controller = new AbortController();
  const f = await fixture(t, { filesystem: { ...fs, rename: async (...args) => {
    const result = await fs.rename(...args); if (++writes === abortAt) controller.abort(); return result;
  } } });
  await f.write('a.txt', 'a'); await f.seal(); abortAt = writes + 1;
  const result = JSON.parse(await f.store.operate({ sessionId: f.session.id, workspace: f.root, runId: f.runId,
    workspaceTools: f.tools, signal: controller.signal }));
  assert.equal(result.status, 'stopped'); assert.deepEqual(result.completed, []);
  assert.equal(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8'), 'a');
  const restarted = new PersistentTaskUndo(f.settings); await restarted.loadSession(f.session);
  assert.deepEqual(restarted.ids(f.session.id, f.root), [f.runId]); assert.deepEqual(restarted.ids(f.session.id, f.root, 'redo'), []);
});
