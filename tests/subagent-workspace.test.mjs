import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSubagentWorkspace } from '../src/core/subagent-workspace.mjs';
import { WorkspaceTools } from '../src/core/workspace.mjs';
import { SUBAGENT_LIMITS } from '../src/core/subagents.mjs';

async function fixture(t) {
  const parent = path.resolve('tests/.tmp'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'subagent-workspace-'));
  t.after(async () => { assert.equal(path.dirname(root), parent); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src/a.js'), 'original');
  return root;
}

test('readonly child can inspect but cannot write, execute, undo or use browser tools', async t => {
  const root = await fixture(t), requests = [];
  const child = createSubagentWorkspace({ root, id: 'child', name: '检查', approve: async request => { requests.push(request); return true; } });
  assert.match(await child.execute('read_file', { path: 'src/a.js' }), /original/);
  for (const [tool, args] of [['write_file', { path: 'src/a.js', content: 'changed' }], ['run_command', { command: 'Get-Location' }], ['undo_last_change', {}], ['browser_snapshot', {}]]) await assert.rejects(child.execute(tool, args));
  assert.equal(await fs.readFile(path.join(root, 'src/a.js'), 'utf8'), 'original'); assert.deepEqual(requests, []);
});

test('scoped child edits are approved, tagged, and available to ordinary project undo', async t => {
  const root = await fixture(t), requests = [], history = [], commits = [];
  const child = createSubagentWorkspace({ root, id: 'worker-A', name: '界面', writePaths: ['src/a.js'], history, onCommitted: value => commits.push(value), approve: async request => { requests.push(request); return true; } });
  await child.execute('read_file', { path: 'src/a.js' });
  assert.match(await child.execute('write_file', { path: 'src/a.js', content: 'new' }), /文件已保存/);
  assert.equal(requests[0].agentId, 'worker-A'); assert.equal(requests[0].agentName, '界面'); assert.ok(requests[0].title.startsWith('界面 ·'));
  assert.deepEqual(history, [{ path: 'src/a.js', before: 'original', after: 'new' }]); assert.equal(commits.length, 1);
  const parent = new WorkspaceTools(root, { approve: async () => true }); parent.history = history;
  assert.match(await parent.undoLastChange({}), /已撤销/); assert.equal(await fs.readFile(path.join(root, 'src/a.js'), 'utf8'), 'original');
});

test('directory scope preserves project guards and refuses sibling prefix tricks', async t => {
  const root = await fixture(t);
  const child = createSubagentWorkspace({ root, id: 'worker', name: '代码', writePaths: ['src/'], approve: async () => true });
  assert.match(await child.execute('write_file', { path: 'src/new.js', content: 'created' }), /已保存/);
  for (const candidate of ['other.js', 'src-other/a.js', 'src/../outside.js', 'src/.env', 'src/.git/config', 'C:/outside.js', '/outside.js']) await assert.rejects(child.execute('write_file', { path: candidate, content: 'no' }));
  assert.equal(await fs.readFile(path.join(root, 'src/new.js'), 'utf8'), 'created');
});

test('child observed versions are independent and refuse edits changed during approval', async t => {
  const root = await fixture(t);
  const child = createSubagentWorkspace({ root, id: 'worker', name: '修改', writePaths: ['src/a.js'], approve: async () => { await fs.writeFile(path.join(root, 'src/a.js'), 'manual edit'); return true; } });
  await child.execute('read_file', { path: 'src/a.js' });
  assert.match(await child.execute('write_file', { path: 'src/a.js', content: 'stale' }), /变化|改变/);
  assert.equal(await fs.readFile(path.join(root, 'src/a.js'), 'utf8'), 'manual edit');
});

test('invalid scopes and cancellation never start a write or approval', async t => {
  const root = await fixture(t); let approved = false;
  for (const scope of ['../x', 'src/../x', '.git/config', '.env', '/', 'C:/x', 'x//y', 'src/:bad']) assert.throws(() => createSubagentWorkspace({ root, id: 'x', name: 'x', writePaths: [scope], approve: async () => true }));
  const child = createSubagentWorkspace({ root, id: 'x', name: 'x', writePaths: ['src/a.js'], approve: async () => { approved = true; return true; } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(child.execute('write_file', { path: 'src/a.js', content: 'no' }, { signal: controller.signal })); assert.equal(approved, false);
});

test('workspace write scope limit agrees with the advertised runtime limit', async t => {
  const root = await fixture(t), writePaths = Array.from({ length: SUBAGENT_LIMITS.writePaths }, (_, index) => `src/file-${index}.js`);
  assert.equal(SUBAGENT_LIMITS.writePaths, 24);
  assert.doesNotThrow(() => createSubagentWorkspace({ root, id: 'limit', name: 'Limit', writePaths, approve: async () => true }));
  assert.throws(() => createSubagentWorkspace({ root, id: 'limit', name: 'Limit', writePaths: [...writePaths, 'extra.js'], approve: async () => true }));
});

function pendingApprovals(count) {
  let enteredResolve;
  const entered = new Promise(resolve => { enteredResolve = resolve; });
  const pending = new Map(), signals = new Map();
  let requests = 0;
  return { entered, pending, signals,
    approve(request, { signal } = {}) {
      const key = request.path || request.command;
      signals.set(key, signal);
      if (++requests === count) enteredResolve();
      if (!signal) return Promise.resolve(false);
      return new Promise(resolve => {
        const abort = () => done(false);
        const done = value => {
          if (!pending.delete(key)) return;
          signal.removeEventListener('abort', abort);
          resolve(value);
        };
        pending.set(key, done);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    },
    finish() { for (const done of [...pending.values()]) done(false); },
  };
}

test('stopping one child cancels its pending file approval without resolving its sibling approval', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'src/b.js'), 'sibling original');
  const approvals = pendingApprovals(2), first = new AbortController(), second = new AbortController();
  t.after(() => approvals.finish());
  const childA = createSubagentWorkspace({ root, id: 'a', name: 'A', writePaths: ['src/a.js'], approve: approvals.approve });
  const childB = createSubagentWorkspace({ root, id: 'b', name: 'B', writePaths: ['src/b.js'], approve: approvals.approve });
  const writeA = childA.execute('write_file', { path: 'src/a.js', content: 'cancelled draft' }, { signal: first.signal });
  const writeB = childB.execute('write_file', { path: 'src/b.js', content: 'approved sibling' }, { signal: second.signal });
  await approvals.entered;
  assert.equal(approvals.signals.get('src/a.js'), first.signal);
  assert.equal(approvals.signals.get('src/b.js'), second.signal);
  first.abort(new Error('Stop only A'));
  assert.match(await writeA, /取消/);
  assert.equal(await fs.readFile(path.join(root, 'src/a.js'), 'utf8'), 'original');
  assert.equal(approvals.pending.has('src/a.js'), false);
  assert.equal(approvals.pending.has('src/b.js'), true);
  assert.equal(second.signal.aborted, false);
  approvals.pending.get('src/b.js')(true);
  assert.match(await writeB, /文件已保存/);
  assert.equal(await fs.readFile(path.join(root, 'src/b.js'), 'utf8'), 'approved sibling');
});

test('approval cancellation follows the individual operation even for concurrent calls on one child workspace', async t => {
  const root = await fixture(t), approvals = pendingApprovals(2);
  t.after(() => approvals.finish());
  const child = createSubagentWorkspace({ root, id: 'one', name: 'One', writePaths: ['src/'], approve: approvals.approve });
  const first = new AbortController(), second = new AbortController();
  const writeA = child.execute('write_file', { path: 'src/a.js', content: 'no' }, { signal: first.signal });
  const writeB = child.execute('write_file', { path: 'src/b.js', content: 'yes' }, { signal: second.signal });
  await approvals.entered;
  assert.equal(approvals.signals.get('src/a.js'), first.signal);
  assert.equal(approvals.signals.get('src/b.js'), second.signal);
  second.abort();
  assert.match(await writeB, /取消/);
  assert.equal(approvals.pending.has('src/a.js'), true);
  approvals.pending.get('src/a.js')(true);
  assert.match(await writeA, /文件已保存/);
  assert.equal(await fs.readFile(path.join(root, 'src/a.js'), 'utf8'), 'no');
  await assert.rejects(fs.stat(path.join(root, 'src/b.js')), { code: 'ENOENT' });
});

test('stopping a child pending command approval returns without starting the command', async t => {
  const root = await fixture(t), approvals = pendingApprovals(1), controller = new AbortController(), output = [];
  t.after(() => approvals.finish());
  const child = createSubagentWorkspace({ root, id: 'command', name: 'Command', writePaths: ['src/'], approve: approvals.approve,
    onEvent: event => output.push(event) });
  const command = "[IO.File]::WriteAllText('src/should-not-exist.txt', 'command started')";
  const pendingCommand = child.execute('run_command', { command }, { signal: controller.signal });
  await approvals.entered;
  assert.equal(approvals.signals.get(command), controller.signal);
  controller.abort();
  assert.match(await pendingCommand, /取消/);
  assert.equal(approvals.pending.size, 0);
  assert.deepEqual(output, []);
  await assert.rejects(fs.stat(path.join(root, 'src/should-not-exist.txt')), { code: 'ENOENT' });
});
