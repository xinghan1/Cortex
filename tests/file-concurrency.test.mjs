import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceTools } from '../src/core/workspace.mjs';
import { ManualFileManager } from '../src/core/file-manager.mjs';

async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'synora-file-concurrency-'));
  const root = path.join(temporary, 'project');
  await fs.mkdir(root);
  t.after(async () => {
    const resolved = path.resolve(temporary);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('synora-file-concurrency-'));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, temporary, manager: new ManualFileManager(root), tools: new WorkspaceTools(root, options) };
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function saved(result) {
  const text = await result;
  assert.ok(!text.startsWith('错误：'), text);
  return JSON.parse(text);
}

test('manual autosave during model approval completes and the stale model diff cannot overwrite it', { timeout: 5000 }, async t => {
  let manager;
  const context = await fixture(t, { approve: async () => {
    const opened = await manager.read({ path: 'note.txt' });
    await manager.save({ path: opened.path, expectedVersion: opened.version, content: 'manual change during approval' });
    return true;
  } });
  manager = context.manager;
  await fs.writeFile(path.join(context.root, 'note.txt'), 'original');
  await context.tools.readFile({ path: 'note.txt' });
  const result = await context.tools.execute('write_file', { path: 'note.txt', content: 'stale model change' });
  assert.match(result, /错误：.*等待审批时已变化/u);
  assert.equal(await fs.readFile(path.join(context.root, 'note.txt'), 'utf8'), 'manual change during approval');
});

test('manual autosave after a model read is rejected before approval until the model rereads', async t => {
  let approvals = 0;
  const { root, manager, tools } = await fixture(t, { approve: async () => { approvals++; return true; } });
  await fs.writeFile(path.join(root, 'note.txt'), 'original');
  await tools.readFile({ path: 'note.txt' });
  const opened = await manager.read({ path: 'note.txt' });
  await manager.save({ path: opened.path, expectedVersion: opened.version, content: 'new user text' });
  assert.match(await tools.execute('write_file', { path: 'note.txt', content: 'stale model change' }), /错误：.*读取后已发生变化/u);
  assert.equal(approvals, 0);
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'new user text');
  await tools.readFile({ path: 'note.txt' });
  await saved(tools.execute('write_file', { path: 'note.txt', content: 'fresh model change' }));
  await saved(tools.execute('write_file', { path: 'note.txt', content: 'next model change' }));
  assert.equal(approvals, 2, 'Successful model commits advance their own read observation');
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'next model change');
});

test('a manually removed observed file is not silently recreated by a stale model write', async t => {
  let approvals = 0;
  const { root, temporary, tools } = await fixture(t, { approve: async () => { approvals++; return true; } });
  const recycled = path.join(temporary, 'isolated-trash-note.txt');
  const manager = new ManualFileManager(root, { trash: absolute => fs.rename(absolute, recycled) });
  await fs.writeFile(path.join(root, 'note.txt'), 'keep this user file');
  await tools.readFile({ path: 'note.txt' });
  await manager.remove({ path: 'note.txt' });
  assert.match(await tools.execute('write_file', { path: 'note.txt', content: 'stale replacement' }), /错误：.*读取后已发生变化/u);
  assert.equal(approvals, 0);
  await assert.rejects(fs.access(path.join(root, 'note.txt')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(recycled, 'utf8'), 'keep this user file');
});

test('a pending model create cannot replace a manual file created during approval', { timeout: 5000 }, async t => {
  let manager;
  const context = await fixture(t, { approve: async () => {
    await manager.create({ name: 'new.txt', type: 'file' });
    const opened = await manager.read({ path: 'new.txt' });
    await manager.save({ path: opened.path, expectedVersion: opened.version, content: 'manual creation' });
    return true;
  } });
  manager = context.manager;
  assert.match(await context.tools.execute('write_file', { path: 'new.txt', content: 'model creation' }), /错误：.*已创建或删除/u);
  assert.equal(await fs.readFile(path.join(context.root, 'new.txt'), 'utf8'), 'manual creation');
});

test('model commit and manual atomic save serialize across overlapping project roots', { timeout: 5000 }, async t => {
  const { root, manager } = await fixture(t);
  const child = path.join(root, 'child');
  await fs.mkdir(child);
  const filename = path.join(child, 'note.txt');
  await fs.writeFile(filename, 'original');
  const opened = await manager.read({ path: 'child/note.txt' });
  const tools = new WorkspaceTools(child, { approve: async () => true });
  const entered = deferred(), release = deferred();
  const originalOpen = fs.open;
  fs.open = async (target, flags, ...rest) => {
    const handle = await originalOpen(target, flags, ...rest);
    if (path.resolve(String(target)).toLowerCase() === filename.toLowerCase() && Number.isInteger(flags) && (flags & constants.O_RDWR) === constants.O_RDWR) {
      entered.resolve();
      await release.promise;
    }
    return handle;
  };
  let modelWrite, userSave;
  try {
    modelWrite = tools.execute('write_file', { path: 'note.txt', content: 'model committed text' });
    await entered.promise;
    let userFinished = false;
    userSave = manager.save({ path: opened.path, expectedVersion: opened.version, content: 'stale manual draft' })
      .then(value => { userFinished = true; return { value }; }, error => { userFinished = true; return { error }; });
    await delay(25);
    assert.equal(userFinished, false, 'Manual save waits until the model finishes its filesystem commit');
    release.resolve();
    await saved(modelWrite);
    const outcome = await userSave;
    assert.equal(outcome.error?.code, 'FILE_VERSION_CONFLICT');
    assert.equal(await fs.readFile(filename, 'utf8'), 'model committed text');
  } finally {
    release.resolve();
    fs.open = originalOpen;
    await Promise.allSettled([modelWrite, userSave]);
  }
  const refreshed = await manager.read({ path: 'child/note.txt' });
  await manager.save({ path: refreshed.path, expectedVersion: refreshed.version, content: 'merged user text' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'merged user text', 'A conflict must not poison the shared commit queue');
});
