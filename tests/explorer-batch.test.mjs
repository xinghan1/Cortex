import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ManualFileManager } from '../src/core/file-manager.mjs';
import { testTempRoot } from './helpers/temp-root.mjs';

const { createExplorerHandlers, selectionTargets, remapClipboard, removeClipboardPaths } = createRequire(import.meta.url)('../src/core/explorer-batch.cjs');

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(testTempRoot, 'synora-explorer-batch-'));
  const root = path.join(temp, 'project'), recycle = path.join(temp, 'recycle');
  await fs.mkdir(root); await fs.mkdir(recycle);
  t.after(async () => {
    const absolute = path.resolve(temp);
    assert.equal(path.dirname(absolute).toLowerCase(), path.resolve(testTempRoot).toLowerCase());
    assert.ok(path.basename(absolute).startsWith('synora-explorer-batch-'));
    assert.equal((await fs.realpath(absolute)).toLowerCase(), absolute.toLowerCase());
    await fs.rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const trashed = [], events = [], confirmations = [];
  const state = { clipboard: null, confirmed: true, written: null, broadcasts: 0 };
  const manager = new ManualFileManager(root, { trash: async absolute => {
    assert.ok(absolute.startsWith(root + path.sep));
    await fs.rename(absolute, path.join(recycle, String(trashed.length)));
    trashed.push(absolute);
  } });
  const handlers = createExplorerHandlers({ getManager: () => manager,
    getClipboard: () => state.clipboard, setClipboard: value => { state.clipboard = value; },
    onChange: (operation, result) => { events.push({ operation, ...result }); return result; },
    confirmDelete: async targets => { confirmations.push(targets); return state.confirmed; },
    broadcast: async () => { state.broadcasts++; }, writeText: text => { state.written = text; },
  });
  const write = async (relative, text = relative) => {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, text);
  };
  const exists = async relative => { try { await fs.stat(path.join(root, relative)); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
  return { root, manager, handlers, state, events, confirmations, trashed, write, exists };
}

test('selection validates every path, removes duplicates and removes descendants of selected parents', async t => {
  const f = await fixture(t);
  await f.write('src/a.txt'); await f.write('src/nested/b.txt'); await f.write('other.txt');
  const result = await selectionTargets(f.manager, { paths: ['src/nested/b.txt', 'src/a.txt', 'src', 'other.txt', 'src'] });
  assert.equal(result.batch, true);
  assert.deepEqual(result.targets.map(target => target.relative), ['src', 'other.txt']);
  await assert.rejects(selectionTargets(f.manager, { paths: ['src', '../outside'] }));
  await assert.rejects(selectionTargets(f.manager, { paths: [] }));
  await assert.rejects(selectionTargets(f.manager, { paths: new Array(501).fill('src') }));
  await assert.rejects(selectionTargets(f.manager, { paths: ['src', 1] }));
  await assert.rejects(selectionTargets(f.manager, { paths: [''] }));
});

test('copy and paste keeps binary bytes, prunes selected children, and reports every completed root', async t => {
  const f = await fixture(t), bytes = Buffer.from([0, 255, 81, 0]);
  await f.write('src/data.bin', bytes); await f.write('readme.md'); await fs.mkdir(path.join(f.root, 'dest'));
  assert.deepEqual(await f.handlers.fileClipboard({ paths: ['src/data.bin', 'src', 'readme.md'], mode: 'copy' }),
    { path: 'src', paths: ['src', 'readme.md'], mode: 'copy' });
  const result = await f.handlers.filePaste({ destination: 'dest' });
  assert.deepEqual(result.results.map(value => value.path), ['dest/src', 'dest/readme.md']);
  assert.deepEqual(await fs.readFile(path.join(f.root, 'dest/src/data.bin')), bytes);
  assert.equal(await f.exists('src/data.bin'), true);
  assert.equal(f.state.clipboard.paths.length, 2);
  assert.equal(f.events.length, 2);
});

test('a later invalid source is rejected before the first copy or delete starts', async t => {
  const f = await fixture(t); await f.write('a.txt');
  await assert.rejects(f.handlers.fileClipboard({ paths: ['a.txt', '.git/config'], mode: 'cut' }));
  assert.equal(f.state.clipboard, null);
  await assert.rejects(f.handlers.fileDelete({ paths: ['a.txt', '../outside'] }));
  assert.equal(f.confirmations.length, 0); assert.equal(f.trashed.length, 0); assert.equal(await f.exists('a.txt'), true);
});

test('one confirmation covers all selected delete roots and cancel leaves everything unchanged', async t => {
  const f = await fixture(t); await f.write('src/a.txt'); await f.write('b.txt');
  await f.handlers.fileClipboard({ paths: ['src/a.txt', 'b.txt'], mode: 'copy' });
  f.state.confirmed = false;
  assert.deepEqual(await f.handlers.fileDelete({ paths: ['src', 'src/a.txt', 'b.txt'] }), { canceled: true });
  assert.equal(f.confirmations.length, 1); assert.equal(f.confirmations[0].length, 2);
  assert.equal(f.trashed.length, 0); assert.equal(await f.exists('b.txt'), true);
  f.state.confirmed = true;
  const result = await f.handlers.fileDelete({ paths: ['src/a.txt', 'src', 'b.txt'] });
  assert.deepEqual(result.results.map(value => value.path), ['src', 'b.txt']);
  assert.equal(f.trashed.length, 2); assert.equal(f.state.clipboard, null);
});

test('copying selected paths keeps explicit descendants and writes newline separated paths', async t => {
  const f = await fixture(t); await f.write('src/a.txt'); await f.write('b.txt');
  const result = await f.handlers.fileCopyPath({ paths: ['src', 'src/a.txt', 'b.txt'], relative: true });
  assert.equal(result.text, 'src\r\nsrc/a.txt\r\nb.txt'); assert.equal(f.state.written, result.text);
  assert.equal((await f.handlers.fileCopyPath({ path: 'b.txt' })).text, path.join(f.root, 'b.txt'));
  await assert.rejects(f.handlers.fileCopyPath({ path: 'b.txt', relative: 'yes' }));
});

test('single-path callers retain the original result and clipboard shapes', async t => {
  const f = await fixture(t); await f.write('one.txt'); await fs.mkdir(path.join(f.root, 'dest'));
  assert.deepEqual(await f.handlers.fileClipboard({ path: 'one.txt', mode: 'copy' }), { path: 'one.txt', mode: 'copy' });
  assert.deepEqual(await f.handlers.filePaste({ destination: 'dest' }), { path: 'dest/one.txt', source: 'one.txt', mode: 'copy', type: 'file' });
  assert.deepEqual(await f.handlers.fileDelete({ path: 'dest/one.txt' }), { path: 'dest/one.txt', deleted: true });
  assert.deepEqual((await f.handlers.fileDelete({ paths: ['one.txt'] })).results, [{ path: 'one.txt', deleted: true }]);
});

test('a batch delete failure returns completed items and keeps uncompleted clipboard paths', async t => {
  const f = await fixture(t); await f.write('a.txt'); await f.write('b.txt'); await f.write('c.txt');
  await f.handlers.fileClipboard({ paths: ['a.txt', 'b.txt', 'c.txt'], mode: 'cut' });
  const original = f.manager.remove.bind(f.manager);
  f.manager.remove = async arg => { if (arg.path === 'b.txt') throw new Error('文件正被占用。'); return original(arg); };
  const result = await f.handlers.fileDelete({ paths: ['a.txt', 'b.txt', 'c.txt'] });
  assert.deepEqual(result, { results: [{ path: 'a.txt', deleted: true }], failedPath: 'b.txt', error: '文件正被占用。' });
  assert.deepEqual(f.state.clipboard.paths, ['b.txt', 'c.txt']);
  assert.equal(await f.exists('a.txt'), false); assert.equal(await f.exists('b.txt'), true); assert.equal(await f.exists('c.txt'), true);
});

test('moving a batch updates clipboard descendants and stops safely at a destination conflict', async t => {
  const f = await fixture(t); await f.write('src/a.txt'); await f.write('src/b.txt'); await f.write('dest/b.txt', 'existing');
  await f.handlers.fileClipboard({ paths: ['src/a.txt', 'src/b.txt'], mode: 'copy' });
  const result = await f.handlers.fileMove({ paths: ['src/a.txt', 'src/b.txt'], destination: 'dest' });
  assert.deepEqual(result.results.map(value => value.path), ['dest/a.txt']);
  assert.equal(result.failedPath, 'src/b.txt'); assert.match(result.error, /同名|存在/u);
  assert.deepEqual(f.state.clipboard.paths, ['dest/a.txt', 'src/b.txt']);
  assert.equal(await fs.readFile(path.join(f.root, 'dest/b.txt'), 'utf8'), 'existing');
  assert.equal(await f.exists('src/b.txt'), true);
});

test('a partially pasted cut retains only the remaining source paths for retry', async t => {
  const f = await fixture(t); await f.write('a.txt'); await f.write('b.txt'); await f.write('dest/b.txt', 'existing');
  await f.handlers.fileClipboard({ paths: ['a.txt', 'b.txt'], mode: 'cut' });
  const result = await f.handlers.filePaste({ destination: 'dest' });
  assert.equal(result.results.length, 1); assert.equal(result.failedPath, 'b.txt');
  assert.deepEqual(f.state.clipboard, { path: 'b.txt', paths: ['b.txt'], mode: 'cut' });
  await fs.mkdir(path.join(f.root, 'second'));
  assert.deepEqual((await f.handlers.filePaste({ destination: 'second' })).results.map(value => value.path), ['second/b.txt']);
  assert.equal(f.state.clipboard, null);
});

test('rename remaps selected clipboard roots and descendants without dropping unrelated entries', async t => {
  const f = await fixture(t); await f.write('src/a.txt'); await f.write('other.txt');
  await f.handlers.fileClipboard({ paths: ['src/a.txt', 'other.txt'], mode: 'copy' });
  assert.deepEqual(await f.handlers.fileRename({ path: 'src', name: 'renamed' }), { oldPath: 'src', path: 'renamed', type: 'directory' });
  assert.deepEqual(f.state.clipboard.paths, ['renamed/a.txt', 'other.txt']);
});

test('a selected ancestor blocks self-destination for the entire batch before any item moves', async t => {
  const f = await fixture(t); await f.write('src/nested/a.txt'); await f.write('other.txt');
  await assert.rejects(f.handlers.fileMove({ paths: ['other.txt', 'src'], destination: 'src/nested' }), /自身|子目录/u);
  assert.equal(await f.exists('other.txt'), true); assert.equal(await f.exists('src/nested/other.txt'), false);
});

test('clipboard transformations use path boundaries and keep single-path compatibility', () => {
  const value = { path: 'src/a.txt', paths: ['src/a.txt', 'srcish/b.txt'], mode: 'copy' };
  assert.deepEqual(remapClipboard(value, 'src', 'new').paths, ['new/a.txt', 'srcish/b.txt']);
  assert.deepEqual(removeClipboardPaths(value, ['src']).paths, ['srcish/b.txt']);
  assert.deepEqual(remapClipboard({ path: 'src/a.txt', mode: 'cut' }, 'src', 'new'), { path: 'new/a.txt', mode: 'cut' });
});
