import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { testTempRoot } from './helpers/temp-root.mjs';
import { WorkspaceTools } from '../src/core/workspace.mjs';
import { TaskChangeUndo, taskUndoPlan } from '../src/core/task-change-undo.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(testTempRoot, 'synora-run-undo-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)).toLowerCase(), path.resolve(testTempRoot).toLowerCase());
    assert.ok(path.basename(root).startsWith('synora-run-undo-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const tools = new WorkspaceTools(root, { approve: async () => true }), changes = [];
  const write = async (relative, content) => {
    const result = await tools.execute('write_file', { path: relative, content }, { onFileChange: change => changes.push(change) });
    assert.equal(result.startsWith('错误：'), false, result);
  };
  return { root, tools, changes, write, read: relative => fs.readFile(path.join(root, relative), 'utf8') };
}
const undo = async (tools, changes, options) => JSON.parse(await tools.undoChanges(changes, options));

test('undo plans keep project-relative and external absolute same-name files separate', () => {
  const external = path.join(path.parse(testTempRoot).root, 'external', 'same.txt').replace(/\\/gu, '/');
  const plan = taskUndoPlan([{ path: 'same.txt', before: 'client-before', after: 'client-after' },
    { path: external, before: 'server-before', after: 'server-middle' }, { path: external, before: 'server-middle', after: 'server-after' }]);
  assert.deepEqual(plan, [{ path: external, before: 'server-before', after: 'server-after' },
    { path: 'same.txt', before: 'client-before', after: 'client-after' }]);
});

test('repeated writes collapse to original raw contents, new files are removed, and unrelated undo history retains its order', async t => {
  const { root, tools, changes, write, read } = await fixture(t);
  await fs.writeFile(path.join(root, 'original.txt'), 'PRIVATE_original_key_text');
  await write('unrelated.txt', 'unrelated'); changes.length = 0;
  await write('original.txt', 'middle'); await write('original.txt', 'final'); await write('created.txt', 'created');
  const committed = [], result = await undo(tools, changes, { onFileChange: change => committed.push(change) });
  assert.equal(result.status, 'completed'); assert.deepEqual(result.completed, ['created.txt', 'original.txt']);
  assert.equal(await read('original.txt'), 'PRIVATE_original_key_text');
  await assert.rejects(read('created.txt'), { code: 'ENOENT' });
  assert.equal(committed[1].after, 'PRIVATE_original_key_text');
  assert.deepEqual(tools.history.map(change => change.path), ['unrelated.txt']);
  await tools.undoLastChange(); await assert.rejects(read('unrelated.txt'), { code: 'ENOENT' });
});

test('noncontinuous chains and unsafe paths fail all preflight before approving or changing any file', async t => {
  const { tools, write, changes, read } = await fixture(t); await write('a.txt', 'after');
  let approved = 0; tools.approve = async () => { approved++; return true; };
  const broken = await undo(tools, [changes[0], { path: 'a.txt', before: 'different', after: 'after' }]);
  assert.equal(broken.status, 'failed'); assert.match(broken.error, /不连续/);
  const unsafe = await undo(tools, [{ path: '../outside.txt', before: 'before', after: null }, ...changes]);
  assert.equal(unsafe.status, 'failed'); assert.equal(approved, 0); assert.equal(await read('a.txt'), 'after');
  const aliases = await undo(tools, [changes[0], { path: './a.txt', before: 'unrelated', after: 'after' }]);
  assert.equal(aliases.status, 'failed'); assert.match(aliases.error, /不连续/); assert.deepEqual(aliases.completed, []);
  assert.equal(approved, 0);
});

test('any current-file conflict rejects the entire batch before even its otherwise valid files are approved', async t => {
  const { root, tools, write, changes, read } = await fixture(t);
  await write('a.txt', 'a'); await write('b.txt', 'b'); await fs.writeFile(path.join(root, 'a.txt'), 'user content');
  let approvals = 0; tools.approve = async () => { approvals++; return true; };
  const result = await undo(tools, changes);
  assert.equal(result.status, 'failed'); assert.deepEqual(result.completed, []); assert.equal(approvals, 0);
  assert.equal(await read('b.txt'), 'b'); assert.equal(await read('a.txt'), 'user content');
});

test('partial denial lists exactly committed files and the remaining raw changes can be retried', async t => {
  const { tools, write, changes, read } = await fixture(t); await write('a.txt', 'a'); await write('b.txt', 'b');
  const ledger = new TaskChangeUndo(), runId = randomUUID(), sessionId = randomUUID();
  changes.forEach(change => ledger.record({ runId, sessionId, workspace: tools.root, change })); ledger.seal(runId);
  tools.approve = async request => request.path !== 'a.txt';
  const partial = await undo(tools, ledger.changes(runId, sessionId, tools.root));
  assert.equal(partial.status, 'partial'); assert.equal(partial.denied, true); assert.deepEqual(partial.completed, ['b.txt']);
  assert.deepEqual(partial.remaining, ['a.txt']); assert.equal(await read('a.txt'), 'a'); await assert.rejects(read('b.txt'), { code: 'ENOENT' });
  ledger.completed(runId, partial.completed); assert.deepEqual(ledger.ids(sessionId, tools.root), [runId]);
  tools.approve = async () => true;
  const finished = await undo(tools, ledger.changes(runId, sessionId, tools.root)); ledger.completed(runId, finished.completed);
  assert.equal(finished.status, 'completed'); assert.deepEqual(ledger.ids(sessionId, tools.root), []);
});

test('cancellation during a later approval preserves completed files and reports remaining work without claiming atomic rollback', async t => {
  const { tools, write, changes, read } = await fixture(t); await write('a.txt', 'a'); await write('b.txt', 'b');
  const controller = new AbortController();
  tools.approve = async request => { if (request.path === 'a.txt') controller.abort(); return true; };
  const result = await undo(tools, changes, { signal: controller.signal });
  assert.equal(result.status, 'partial'); assert.equal(result.stopped, true); assert.deepEqual(result.completed, ['b.txt']);
  assert.equal(await read('a.txt'), 'a'); await assert.rejects(read('b.txt'), { code: 'ENOENT' });
});

test('new files edited while deletion approval is pending are retained and not marked completed', async t => {
  const { root, tools, write, changes, read } = await fixture(t); await write('new.txt', 'created');
  tools.approve = async () => { await fs.writeFile(path.join(root, 'new.txt'), 'user edited'); return true; };
  const result = await undo(tools, changes);
  assert.equal(result.status, 'failed'); assert.deepEqual(result.completed, []); assert.equal(await read('new.txt'), 'user edited');
  assert.equal(tools.history.length, 1);
});

test('a later file changed during an earlier approval is rechecked and left untouched after a partial undo', async t => {
  const { root, tools, write, changes, read } = await fixture(t); await write('a.txt', 'a'); await write('b.txt', 'b');
  tools.approve = async request => { if (request.path === 'b.txt') await fs.writeFile(path.join(root, 'a.txt'), 'user replacement'); return true; };
  const result = await undo(tools, changes);
  assert.equal(result.status, 'partial'); assert.deepEqual(result.completed, ['b.txt']); assert.equal(await read('a.txt'), 'user replacement');
});

test('symlinks and hardlinks, including links added while approval is pending, cannot escape batch undo guards', async t => {
  const { root, tools, write, changes, read } = await fixture(t); await write('original.txt', 'created');
  await fs.link(path.join(root, 'original.txt'), path.join(root, 'hardlink.txt'));
  tools.approve = async () => assert.fail('Hardlinks must fail before approval');
  assert.equal((await undo(tools, changes)).status, 'failed'); assert.equal(await read('hardlink.txt'), 'created');
  await fs.unlink(path.join(root, 'hardlink.txt'));
  tools.approve = async () => true;
  await fs.writeFile(path.join(root, 'existing.txt'), 'before'); await write('existing.txt', 'after');
  tools.approve = async () => { await fs.link(path.join(root, 'existing.txt'), path.join(root, 'pending-link.txt')); return true; };
  const result = await undo(tools, [changes.at(-1)]); assert.equal(result.status, 'failed'); assert.equal(await read('pending-link.txt'), 'after');
  await fs.symlink(root, path.join(root, 'junction'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await undo(tools, [{ path: 'junction/original.txt', before: null, after: 'created' }])).status, 'failed');
});

test('a model undo inside the same round contributes a reverse change and net no-op is not advertised', async t => {
  const { tools, write, changes } = await fixture(t); await write('new.txt', 'new');
  await tools.undoLastChange({ onFileChange: change => changes.push(change) });
  assert.deepEqual(taskUndoPlan(changes), []);
  const ledger = new TaskChangeUndo(), runId = randomUUID(), sessionId = randomUUID();
  changes.forEach(change => ledger.record({ runId, sessionId, workspace: tools.root, change })); ledger.seal(runId);
  assert.deepEqual(ledger.ids(sessionId, tools.root), []);
});

test('process-local raw ledgers are sealed and bound to the exact session/project, reject gaps and expire on clear or restart', () => {
  const ledger = new TaskChangeUndo(), runId = randomUUID(), sessionId = randomUUID(), workspace = 'fixture';
  ledger.record({ runId, sessionId, workspace, change: { path: 'a.txt', before: 'PRIVATE_RAW', after: 'changed' } });
  assert.deepEqual(ledger.ids(sessionId, workspace), []); ledger.seal(runId); assert.deepEqual(ledger.ids(sessionId, workspace), [runId]);
  assert.equal(ledger.changes(runId, sessionId, workspace)[0].before, 'PRIVATE_RAW');
  assert.throws(() => ledger.changes(runId, 'other-session', workspace)); assert.throws(() => ledger.changes(runId, sessionId, 'other-project'));
  assert.deepEqual(new TaskChangeUndo().ids(sessionId, workspace), []); ledger.clear(); assert.deepEqual(ledger.ids(sessionId, workspace), []);
  const broken = randomUUID(); ledger.record({ runId: broken, sessionId, workspace, change: { path: 'a.txt', before: 'a', after: 'b' } });
  ledger.record({ runId: broken, sessionId, workspace, change: { path: 'a.txt', before: 'gap', after: 'c' } }); ledger.seal(broken);
  assert.deepEqual(ledger.ids(sessionId, workspace), []);
});

test('oversized or incomplete raw run history disables the whole run rather than exposing a partial undo', () => {
  const ledger = new TaskChangeUndo(), runId = randomUUID(), sessionId = randomUUID(), workspace = 'fixture';
  for (let index = 0; index < 20; index++) ledger.record({ runId, sessionId, workspace,
    change: { path: `${index}.txt`, before: 'a'.repeat(512 * 1024), after: 'b'.repeat(512 * 1024) } });
  ledger.seal(runId); assert.deepEqual(ledger.ids(sessionId, workspace), []); assert.throws(() => ledger.changes(runId, sessionId, workspace));
});
