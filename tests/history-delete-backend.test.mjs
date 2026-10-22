import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { testTempRoot } from './helpers/temp-root.mjs';
import { PersistentTaskUndo } from '../src/core/persistent-task-undo.mjs';
const require = createRequire(import.meta.url);
const { Store } = require('../src/core/store.cjs');
const { RecentProjects } = require('../src/core/recent-projects.cjs');
const { SessionRestore } = require('../src/core/session-restore.cjs');
const crypto = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() };
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(testTempRoot, 'history-delete-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dir)).toLowerCase(), path.resolve(testTempRoot).toLowerCase());
    assert.ok(path.basename(dir).startsWith('history-delete-'));
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const store = new Store(dir, crypto); await store.init();
  const session = store.createSession('C:/Projects/Delete');
  session.messages.push({ role: 'user', content: '删除测试', attachments: [{ dataUrl: 'data:image/png;base64,UElDVFVSRQ==' }] });
  await store.saveSession(session);
  return { dir, store, session, file: path.join(dir, 'sessions', session.id + '.json') };
}
test('deleting a session removes its transcript and inline images while preserving usage and other histories', async t => {
  const { dir, store, session, file } = await fixture(t);
  const other = store.createSession(session.workspace); other.messages.push({ role: 'user', content: '保留的会话' }); await store.saveSession(other);
  const usage = await fs.readFile(path.join(dir, 'usage.json'));
  await store.deleteSession(session.id, 'c:\\Projects\\Delete\\');
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  assert.deepEqual(await fs.readFile(path.join(dir, 'usage.json')), usage);
  assert.equal((await store.getSession(other.id)).id, other.id);
  assert.deepEqual((await store.listProjectSessions(session.workspace)).map(row => row.id), [other.id]);
  await assert.rejects(store.saveSession(session), /已删除/);
  await assert.rejects(store.renameSession(session, '不能复活'), /已删除/);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});
test('deletion drains an accepted save and rejects a late stale save instead of resurrecting the deleted id', async t => {
  const { store, session, file } = await fixture(t);
  const originalWrite = store.write.bind(store); let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  store.write = async (relative, value) => { if (relative === path.join('sessions', session.id + '.json')) { entered(); await gate; } return originalWrite(relative, value); };
  const saving = store.saveSession(session); await started;
  const deleting = store.deleteSession(session.id, session.workspace);
  await new Promise(resolve => setImmediate(resolve)); release(); await saving; await deleting;
  await assert.rejects(store.saveSession({ ...session }), /已删除/);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});
test('invalid ids, another project, and a hard-linked session are rejected before deletion', async t => {
  const { dir, store, session, file } = await fixture(t);
  await assert.rejects(store.deleteSession('../sessions/outside', session.workspace), /ID/);
  await assert.rejects(store.deleteSession(session.id, 'D:/Different'), /当前项目/);
  const alias = path.join(dir, 'linked-session.json'); await fs.link(file, alias);
  const bytes = await fs.readFile(file);
  await assert.rejects(store.validateSessionDeletion(session.id, session.workspace), /路径无效/);
  await assert.rejects(store.deleteSession(session.id, session.workspace), /路径无效/);
  assert.deepEqual(await fs.readFile(file), bytes); assert.deepEqual(await fs.readFile(alias), bytes);
});
test('undo deletion purges encrypted bytes and cached runs and supports rollback when transcript deletion fails', async t => {
  const { dir, session } = await fixture(t);
  const manager = new PersistentTaskUndo({ dataDir: dir, safeStorage: crypto });
  await manager.loadSession(session); const runId = randomUUID();
  await manager.record({ sessionId: session.id, workspace: session.workspace, runId, change: { path: 'a.txt', before: 'before', after: 'after' } });
  await manager.seal(runId, session.id, session.workspace);
  const undoFile = path.join(dir, 'task-undo', session.id + '.json'), bytes = await fs.readFile(undoFile);
  const receipt = await manager.deleteSession(session.id);
  await assert.rejects(fs.stat(undoFile), { code: 'ENOENT' }); assert.deepEqual(manager.ids(session.id, session.workspace), []);
  await assert.rejects(manager.loadSession(session), /持久撤销/);
  await receipt.rollback(); assert.deepEqual(await fs.readFile(undoFile), bytes); assert.deepEqual(manager.ids(session.id, session.workspace), [runId]);
  await manager.deleteSession(session.id); await assert.rejects(manager.loadSession(session), /持久撤销/);
  await assert.rejects(fs.stat(undoFile), { code: 'ENOENT' });
});
test('failed encrypted snapshot deletion leaves the current undo capability available', async t => {
  const { dir, session } = await fixture(t); let deny = false;
  const filesystem = { ...fs, unlink: async filename => { if (deny && filename === path.join(dir, 'task-undo', session.id + '.json')) throw Object.assign(new Error('locked fixture'), { code: 'EACCES' }); return fs.unlink(filename); } };
  const manager = new PersistentTaskUndo({ dataDir: dir, safeStorage: crypto, filesystem });
  await manager.loadSession(session); const runId = randomUUID();
  await manager.record({ sessionId: session.id, workspace: session.workspace, runId, change: { path: 'b.txt', before: null, after: 'created' } });
  await manager.seal(runId, session.id, session.workspace); deny = true;
  await assert.rejects(manager.deleteSession(session.id), { code: 'EACCES' });
  assert.deepEqual(manager.ids(session.id, session.workspace), [runId]);
});
test('forgetting startup selection serializes with queued records and prevents late focus restoring deleted ids', async t => {
  const { dir, session } = await fixture(t), restore = new SessionRestore(dir);
  const other = { ...session, id: randomUUID(), workspace: 'D:/Other' };
  const first = restore.record(session), second = restore.record(other, { active: false }), forgotten = restore.forgetSession(session.id);
  assert.equal(await restore.record(session), false); await Promise.all([first, second, forgotten]);
  assert.equal(restore.snapshot().current, null); assert.deepEqual(restore.snapshot().projects.map(row => row.sessionId), [other.id]);
  await restore.record(other); await restore.flush();
  const reloaded = await new SessionRestore(dir).init();
  assert.equal(reloaded.snapshot().current.sessionId, other.id); assert.ok(!JSON.stringify(reloaded.snapshot()).includes(session.id));
});
test('removing recent projects hides history-derived roots persistently and explicit reopening restores them', async t => {
  const { dir } = await fixture(t), projects = await new RecentProjects(dir).init();
  await projects.record('C:/Keep'); await projects.record('D:/Remove');
  await projects.remove('d:\\REMOVE\\');
  assert.deepEqual(projects.list().map(item => item.path), ['C:\\Keep']); assert.equal(projects.isHidden('D:/Remove'), true);
  let reloaded = await new RecentProjects(dir).init(); assert.equal(reloaded.isHidden('d:/remove'), true);
  await reloaded.record('D:/Remove'); assert.equal(reloaded.isHidden('D:/Remove'), false);
  reloaded = await new RecentProjects(dir).init(); assert.equal(reloaded.isHidden('D:/Remove'), false); assert.equal(reloaded.list().length, 2);
  assert.equal(Object.hasOwn(JSON.parse(await fs.readFile(path.join(dir, 'projects.json'), 'utf8')), 'hidden'), false);
});
