import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { WorkspaceTools } from '../src/core/workspace.mjs';
import { createPluginProjectAccess } from '../src/core/plugin-project.mjs';

async function fixture(t) {
  const parent = path.resolve('tests/.tmp'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'plugin-project-'));
  await fs.writeFile(path.join(root, 'sample.txt'), 'original\n');
  const control = { active: true, canWrite: true, confirmations: [], changes: [], confirm: async () => true, locks: 0 };
  const controller = new AbortController(), project = { root, workspaceId: 'workspace' };
  const request = { project, signal: controller.signal, plugin: { id: 'test.plugin', name: '测试插件' }, ownerWindow: {} };
  const access = createPluginProjectAccess({ WorkspaceTools,
    getContext: () => ({ root, workspaceId: control.active ? 'workspace' : 'other', canWrite: control.canWrite,
      runMutation: async operation => { control.locks++; try { return await operation(); } finally { control.locks--; } } }),
    confirmWrite: async input => { control.confirmations.push(input.operation); return control.confirm(input); },
    onFilesChanged: input => { control.changes.push(input.path); },
  });
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, control, controller, request, access };
}

test('plugin project reads return opaque versions and explicit writes preserve source and publish a file change', async t => {
  const f = await fixture(t), file = await f.access.readText({ ...f.request, path: 'sample.txt' });
  assert.equal(file.content, 'original\n'); assert.match(file.version, /^[a-f0-9]{64}$/u);
  const result = await f.access.writeText({ ...f.request, path: file.path, content: 'updated\n', expectedVersion: file.version });
  assert.equal(await fs.readFile(path.join(f.root, file.path), 'utf8'), 'updated\n');
  assert.notEqual(result.version, file.version); assert.equal(result.content, 'updated\n');
  assert.deepEqual(f.control.changes, ['sample.txt']); assert.equal(f.control.confirmations.length, 1); assert.equal(f.control.locks, 0);
  assert.equal(f.control.confirmations[0].before, 'original\n'); assert.equal(f.control.confirmations[0].after, 'updated\n');
  const listed = await f.access.listFiles(f.request); assert.equal(listed[0].path, 'sample.txt');
});

test('plugins cannot bypass project boundaries, credential protection or UTF-8 text limits', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, '.env'), 'API_KEY=private');
  await fs.writeFile(path.join(f.root, 'binary.bin'), Buffer.from([0, 255]));
  for (const file of ['../outside.txt', path.join(f.root, 'sample.txt'), '.env', 'binary.bin'])
    await assert.rejects(f.access.readText({ ...f.request, path: file }));
  const listed = await f.access.listFiles(f.request); assert.equal(listed.some(file => file.path === '.env'), false);
  await assert.rejects(f.access.writeText({ ...f.request, path: '../outside.txt', content: 'wrong', expectedVersion: null }));
  await assert.rejects(f.access.writeText({ ...f.request, path: 'too-big.txt', content: 'x'.repeat(512 * 1024 + 1), expectedVersion: null }));
  assert.equal(f.control.confirmations.length, 0);
});

test('stale versions and missing expected versions do not show approval or overwrite existing files', async t => {
  const f = await fixture(t), file = await f.access.readText({ ...f.request, path: 'sample.txt' });
  await fs.writeFile(path.join(f.root, 'sample.txt'), 'external');
  for (const version of [undefined, null, 'old', file.version])
    await assert.rejects(f.access.writeText({ ...f.request, path: 'sample.txt', content: 'wrong', expectedVersion: version }));
  assert.equal(await fs.readFile(path.join(f.root, 'sample.txt'), 'utf8'), 'external');
  assert.equal(f.control.confirmations.length, 0);
});

test('creating new plugin files requires a null version and an affirmative user decision', async t => {
  const f = await fixture(t); f.control.confirm = async () => false;
  const write = () => f.access.writeText({ ...f.request, path: 'new/fresh.txt', content: 'new file', expectedVersion: null });
  await assert.rejects(write(), /取消/u); await assert.rejects(fs.stat(path.join(f.root, 'new')));
  f.control.confirm = async () => true; const result = await write();
  assert.equal(result.path, 'new/fresh.txt'); assert.equal(await fs.readFile(path.join(f.root, result.path), 'utf8'), 'new file');
});

test('project changes, dirty editors and cancellation cannot turn a pending approval into a write', async t => {
  for (const outcome of ['project', 'editor', 'abort', 'external']) {
    const f = await fixture(t), file = await f.access.readText({ ...f.request, path: 'sample.txt' });
    f.control.confirm = async () => {
      if (outcome === 'project') f.control.active = false;
      if (outcome === 'editor') f.control.canWrite = false;
      if (outcome === 'abort') f.controller.abort();
      if (outcome === 'external') await fs.writeFile(path.join(f.root, file.path), 'external');
      return true;
    };
    await assert.rejects(f.access.writeText({ ...f.request, path: file.path, content: 'wrong', expectedVersion: file.version }));
    assert.equal(await fs.readFile(path.join(f.root, file.path), 'utf8'), outcome === 'external' ? 'external' : 'original\n');
    assert.deepEqual(f.control.changes, []); assert.equal(f.control.locks, 0);
  }
});
