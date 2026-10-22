import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { testTempRoot } from './helpers/temp-root.mjs';
const { SessionRestore } = createRequire(import.meta.url)('../src/core/session-restore.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(testTempRoot, 'synora-session-restore-'));
  t.after(async () => {
    const absolute = path.resolve(dir);
    assert.equal(path.dirname(absolute).toLowerCase(), path.resolve(testTempRoot).toLowerCase());
    assert.ok(path.basename(absolute).startsWith('synora-session-restore-'));
    await fs.rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const project = path.join(dir, 'project'); await fs.mkdir(project);
  return { dir, project, file: path.join(dir, 'startup-session.json') };
}
const session = (workspace, extra = {}) => ({ id: randomUUID(), workspace, title: 'Fixture', messages: [], events: [], ...extra });
const readers = values => ({ readSession: async id => {
  const value = values.find(item => item.id === id);
  if (!value || value.damaged) throw new Error('Missing or damaged fixture');
  return structuredClone(value);
}, listProjectSessions: async workspace => values.filter(value => value.workspace === workspace).toReversed() });

test('first installation with no selection and no history opens welcome without creating a restore file', async t => {
  const { dir, file } = await fixture(t);
  const restore = await new SessionRestore(dir).init();
  assert.equal(await restore.resolve({ ...readers([]), listSessions: async () => [] }), null);
  assert.equal(restore.error, null);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('upgrades without a selection file restore meaningful history once, then respect explicitly chosen older IDs', async t => {
  const { dir, project } = await fixture(t), older = session(project), latest = session(project);
  const restore = new SessionRestore(dir), options = { ...readers([older, latest]), listSessions: async () => [{ id: latest.id, workspace: project }] };
  assert.equal((await restore.resolve(options)).session.id, latest.id);
  await restore.record(older);
  const restarted = new SessionRestore(dir);
  assert.equal((await restarted.resolve({ ...options, listSessions: () => assert.fail('Explicit selection must not infer the newest history') })).session.id, older.id);
});

test('upgrade recovery skips inaccessible projects and damaged or temporary entries without running anything', async t => {
  const { dir, project } = await fixture(t), valid = session(project), damaged = session(project, { damaged: true }), temporary = session(project, { temporary: true });
  const options = { ...readers([valid, damaged, temporary]), listSessions: async () => [
    { id: randomUUID(), workspace: path.join(dir, 'deleted') }, { id: temporary.id, workspace: project },
  ] };
  const restored = await new SessionRestore(dir).resolve(options);
  assert.equal(restored.session.id, valid.id);
  assert.equal(await new SessionRestore(dir).resolve({ ...options, listSessions: async () => { throw new Error('Unavailable legacy index'); } }), null);
});

test('existing malformed or explicit empty recovery data never invokes the upgrade history fallback', async t => {
  for (const value of ['{broken', JSON.stringify({ version: 1, current: null, projects: [] })]) {
    const { dir, file } = await fixture(t); await fs.writeFile(file, value);
    const restore = new SessionRestore(dir);
    assert.equal(await restore.resolve({ ...readers([]), listSessions: () => assert.fail('Existing restore file is not a first upgrade') }), null);
    assert.equal(await fs.readFile(file, 'utf8'), value);
  }
});

test('an explicitly selected older session and its project survive restart independently of modification timestamps', async t => {
  const { dir, project } = await fixture(t);
  const older = session(project, { updatedAt: '2020-01-01', messages: [{ role: 'user', content: 'Old chosen goal.' }] });
  const newer = session(project, { updatedAt: '2030-01-01' });
  const restore = await new SessionRestore(dir).init();
  await restore.record(newer); await restore.record(older);
  const next = await new SessionRestore(dir).init(), resolved = await next.resolve(readers([older, newer]));
  assert.equal(resolved.workspace, await fs.realpath(project)); assert.equal(resolved.session.id, older.id);
  assert.equal(resolved.session.messages[0].content, 'Old chosen goal.');
  assert.equal((await next.resolveProject(project, readers([older, newer]))).session.id, older.id);
});

test('project selections remain distinct while temporary sessions never replace persistent recovery', async t => {
  const { dir, project } = await fixture(t), other = path.join(dir, 'other'); await fs.mkdir(other);
  const a = session(project), b = session(other), temporary = session(other, { temporary: true });
  const restore = new SessionRestore(dir);
  await restore.record(a); await restore.record(b); assert.equal(await restore.record(temporary), false);
  const restarted = new SessionRestore(dir);
  assert.equal((await restarted.resolve(readers([a, b, temporary]))).session.id, b.id);
  assert.equal((await restarted.resolveProject(project, readers([a, b]))).session.id, a.id);
  assert.equal((await restarted.resolveProject(other, readers([a, b, temporary]))).session.id, b.id);
  assert.equal(JSON.stringify(restarted.snapshot()).includes(temporary.id), false);
});

test('background window activity cannot overwrite the foreground selection and later focus selects that window explicitly', async t => {
  const { dir, project } = await fixture(t), other = path.join(dir, 'other'); await fs.mkdir(other);
  const first = session(project), second = session(other), background = session(project);
  const restore = new SessionRestore(dir);
  await Promise.all([restore.record(first), restore.record(second), restore.record(background, { active: false })]);
  await restore.flush(); assert.equal(restore.snapshot().current.sessionId, second.id);
  await restore.record(first); assert.equal(restore.snapshot().current.sessionId, first.id);
  assert.equal(restore.snapshot().projects.find(value => value.workspace === other).sessionId, second.id);
});

test('deleted or unreadable project directories return welcome without reading sessions or changing user data', async t => {
  const { dir, project, file } = await fixture(t), chosen = session(project), restore = new SessionRestore(dir);
  await restore.record(chosen); const original = await fs.readFile(file, 'utf8');
  const unavailable = new SessionRestore(dir, { filesystem: { ...fs, opendir: async () => { throw Object.assign(new Error('ACL fixture'), { code: 'EACCES' }); } } });
  assert.equal(await unavailable.resolve({ readSession: () => assert.fail('Unreadable project must not be opened'), listProjectSessions: () => [] }), null);
  await fs.rmdir(project);
  assert.equal(await new SessionRestore(dir).resolve({ readSession: () => assert.fail('Missing project must not be opened'), listProjectSessions: () => [] }), null);
  assert.equal(await fs.readFile(file, 'utf8'), original);
});

test('a damaged selected session falls back to valid same-project history and never restores temporary or unrelated history', async t => {
  const { dir, project } = await fixture(t), chosen = session(project, { damaged: true }), valid = session(project);
  const unrelated = session(path.join(dir, 'other')), temporary = session(project, { temporary: true });
  const restore = new SessionRestore(dir); await restore.record(chosen);
  const resolved = await new SessionRestore(dir).resolve({ ...readers([chosen, valid, unrelated, temporary]),
    listProjectSessions: async () => [temporary, unrelated, chosen, valid] });
  assert.equal(resolved.session.id, valid.id);
  const noValid = await restore.resolve(readers([chosen, temporary]));
  assert.equal(noValid.workspace, await fs.realpath(project)); assert.equal(noValid.session, null);
});

test('a persistent welcome conversation restores safely while invalid and temporary selections are ignored', async t => {
  const { dir } = await fixture(t), welcome = session(null), restore = new SessionRestore(dir);
  assert.equal(await restore.record(session('relative-project')), false);
  assert.equal(await restore.record({ id: '../../bad', workspace: null }), false);
  await restore.record(welcome);
  assert.equal((await new SessionRestore(dir).resolve(readers([welcome]))).session.id, welcome.id);
  assert.equal(await new SessionRestore(dir).resolve(readers([{ ...welcome, temporary: true }])), null);
});

test('malformed and oversized restore files remain byte-for-byte intact and never replace ordinary session data', async t => {
  for (const contents of ['{broken', JSON.stringify({ version: 1, current: { workspace: 'relative', sessionId: randomUUID() }, projects: [] }), 'x'.repeat(128 * 1024 + 1)]) {
    const { dir, project, file } = await fixture(t); await fs.writeFile(file, contents);
    const restore = await new SessionRestore(dir).init();
    assert.equal(await restore.resolve(readers([])), null); assert.match(restore.error, /原文件已保留/);
    await assert.rejects(restore.record(session(project)), /原文件已保留/);
    assert.equal(await fs.readFile(file, 'utf8'), contents);
    assert.equal((await fs.readdir(dir)).some(name => name.endsWith('.tmp')), false);
  }
});

test('a failed atomic save retains the previous selection and a later queued change can succeed', async t => {
  const { dir, project, file } = await fixture(t), first = session(project), second = session(project);
  const restore = new SessionRestore(dir); await restore.record(first);
  const original = await fs.readFile(file, 'utf8'); let fail = true;
  const restarted = new SessionRestore(dir, { filesystem: { ...fs, rename: async (...args) => {
    if (fail) { fail = false; throw new Error('Simulated rename failure'); } return fs.rename(...args);
  } } });
  await assert.rejects(restarted.record(second), /保存失败/);
  assert.equal(await fs.readFile(file, 'utf8'), original); assert.equal(restarted.snapshot().current.sessionId, first.id);
  await restarted.record(second); await restarted.flush(); assert.equal(restarted.pending, false);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).current.sessionId, second.id);
});

test('flush waits for in-flight atomic persistence so a rapid application quit does not lose the last selection', async t => {
  const { dir, project, file } = await fixture(t), chosen = session(project);
  let release, entered; const barrier = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const restore = new SessionRestore(dir, { filesystem: { ...fs, rename: async (...args) => { entered(); await barrier; return fs.rename(...args); } } });
  const recording = restore.record(chosen); await started;
  assert.equal(restore.pending, true); let finished = false;
  const flushing = restore.flush().then(() => { finished = true; }); await Promise.resolve(); assert.equal(finished, false);
  const focusedLater = session(project), later = restore.record(focusedLater);
  release(); await recording; await flushing;
  assert.equal(restore.pending, false, 'flush includes a selection queued after it began');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).current.sessionId, focusedLater.id);
  await later;
});
