import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { testTempRoot } from './helpers/temp-root.mjs';
import { ManualFileManager } from '../src/core/file-manager.mjs';
import { EditorFileTargets } from '../src/core/editor-file-targets.mjs';

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(testTempRoot, 'synora-external-editor-'));
  const root = path.join(temporary, 'client'), external = path.join(temporary, 'server');
  await fs.mkdir(root); await fs.mkdir(external);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temporary)).toLowerCase(), path.resolve(testTempRoot).toLowerCase());
    assert.ok(path.basename(temporary).startsWith('synora-external-editor-'));
    await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const manager = new ManualFileManager(root);
  return { root, external, temporary, manager, editor: new EditorFileTargets(manager) };
}

test('the editor opens and saves an absolute external file without changing its explorer root', async t => {
  const { root, external, manager, editor } = await fixture(t);
  const file = path.join(external, 'same.txt');
  await fs.writeFile(file, '\uFEFFserver original\n'); await fs.writeFile(path.join(root, 'same.txt'), 'client untouched');
  const value = await editor.read({ path: file });
  assert.equal(value.path, file.replace(/\\/g, '/'));
  assert.equal(value.content, '\uFEFFserver original\n');
  const updated = await editor.save({ path: value.path, content: '\uFEFFserver changed\n', expectedVersion: value.version });
  assert.equal(updated.path, value.path);
  assert.notEqual(updated.version, value.version);
  assert.equal(await fs.readFile(file, 'utf8'), '\uFEFFserver changed\n');
  assert.equal(await fs.readFile(path.join(root, 'same.txt'), 'utf8'), 'client untouched');
  assert.equal(manager.root, root);
  const revealed = await editor.paths({ path: value.path });
  assert.equal(revealed.absolute.toLowerCase(), file.toLowerCase());
  await assert.rejects(manager.read({ path: file }), 'The explorer manager itself must remain confined');
});

test('project-relative and in-project absolute editor references return the same relative path', async t => {
  const { root, editor } = await fixture(t);
  await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src', 'code.java'), 'class Code {}');
  const relative = await editor.read({ path: 'src/code.java' });
  const absolute = await editor.read({ path: path.join(root, 'src', 'code.java') });
  assert.deepEqual(absolute, relative);
  assert.equal(absolute.path, 'src/code.java');
});

test('external autosave refuses stale versions and retains changes made by another editor', async t => {
  const { external, editor } = await fixture(t);
  const file = path.join(external, 'code.java'); await fs.writeFile(file, 'before');
  const before = await editor.read({ path: file });
  await fs.writeFile(file, 'other editor');
  await assert.rejects(editor.save({ path: file, expectedVersion: before.version, content: 'stale' }), { code: 'FILE_VERSION_CONFLICT' });
  assert.equal(await fs.readFile(file, 'utf8'), 'other editor');
});

test('opening external editor files retains secret, traversal, device and linked-directory protections', async t => {
  const { external, temporary, editor } = await fixture(t);
  const file = path.join(external, 'regular.txt'); await fs.writeFile(file, 'regular');
  await fs.writeFile(path.join(external, '.env'), 'fixture only');
  for (const input of [path.join(external, '.env'), external + '/uncreated/../regular.txt', '../server/regular.txt',
    '\\\\server\\share\\file.txt', '\\\\?\\C:\\file.txt', file + ':data', path.join(external, 'NUL')]) {
    await assert.rejects(editor.read({ path: input }), undefined, input);
  }
  const link = path.join(temporary, 'redirect');
  await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(editor.read({ path: path.join(link, 'regular.txt') }));
  await assert.rejects(editor.save({ path: path.join(link, 'regular.txt'), content: 'wrong', expectedVersion: '0'.repeat(64) }));
  assert.equal(await fs.readFile(file, 'utf8'), 'regular');
});
