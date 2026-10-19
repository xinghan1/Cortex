import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { ManualFileManager } from '../src/core/file-manager.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const samePath = (left, right) => process.platform === 'win32'
  ? left.toLowerCase() === right.toLowerCase() : left === right;

async function fixture(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'forgedesk-file-manager-test-'));
  const root = path.join(temp, 'project');
  const outside = path.join(temp, 'outside');
  const recycle = path.join(temp, 'recycle');
  await Promise.all([fs.mkdir(root), fs.mkdir(outside), fs.mkdir(recycle)]);
  const trashed = [];
  const trash = async absolute => {
    assert.ok(path.isAbsolute(absolute));
    const relative = path.relative(root, absolute);
    assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    const destination = path.join(recycle, `${trashed.length}-${path.basename(absolute)}`);
    assert.equal(path.dirname(destination), recycle);
    await fs.rename(absolute, destination);
    trashed.push({ absolute, destination });
  };
  t.after(async () => {
    const resolved = path.resolve(temp);
    assert.ok(path.isAbsolute(resolved));
    assert.ok(samePath(path.dirname(resolved), path.resolve(os.tmpdir())));
    assert.ok(path.basename(resolved).startsWith('forgedesk-file-manager-test-'));
    assert.ok(samePath(await fs.realpath(resolved), resolved));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { temp, root, outside, recycle, trashed, manager: new ManualFileManager(root, { trash, ...options }) };
}

async function missing(absolute) {
  await assert.rejects(fs.access(absolute), { code: 'ENOENT' });
}

test('manual file operations create, edit, rename, move and recycle within one project', async t => {
  const { root, manager, trashed } = await fixture(t);
  assert.ok(samePath(manager.root, await fs.realpath(root)));
  assert.deepEqual(await manager.create({ parent: '', name: 'src', type: 'directory' }), { path: 'src', type: 'directory' });
  assert.deepEqual(await manager.create({ parent: 'src', name: 'note.md', type: 'file' }), { path: 'src/note.md', type: 'file' });
  assert.deepEqual(await manager.list(), [{ name: 'src', path: 'src', type: 'directory' }]);
  assert.deepEqual(await manager.paths(), { absolute: manager.root, relative: '' });
  assert.deepEqual(await manager.paths({ path: 'src/note.md' }), { absolute: path.join(manager.root, 'src', 'note.md'), relative: 'src/note.md' });
  const initial = await manager.read({ path: 'src/note.md' });
  assert.deepEqual(initial, { path: 'src/note.md', content: '', version: digest(Buffer.alloc(0)) });
  const saved = await manager.save({ path: initial.path, content: '中文内容\r\n', expectedVersion: initial.version });
  assert.equal(saved.content, '中文内容\r\n');
  assert.equal(saved.version, digest(Buffer.from(saved.content)));
  assert.deepEqual(await manager.rename({ path: initial.path, name: 'renamed.md' }), { path: 'src/renamed.md', oldPath: initial.path, type: 'file' });
  await manager.create({ parent: '', name: 'archive', type: 'directory' });
  assert.deepEqual(await manager.copyOrMove({ source: 'src/renamed.md', destination: 'archive', mode: 'cut' }), { path: 'archive/renamed.md', source: 'src/renamed.md', mode: 'cut', type: 'file' });
  await missing(path.join(root, 'src', 'renamed.md'));
  assert.deepEqual(await manager.remove({ path: 'archive/renamed.md' }), { path: 'archive/renamed.md', deleted: true });
  assert.equal(trashed.length, 1);
  assert.equal(trashed[0].absolute, path.join(root, 'archive', 'renamed.md'));
  assert.equal(await fs.readFile(trashed[0].destination, 'utf8'), saved.content);
  await missing(path.join(root, 'archive', 'renamed.md'));
});

test('copy preserves binary bytes and nested directories without treating them as editable text', async t => {
  const { root, manager } = await fixture(t);
  const bytes = Buffer.alloc(512 * 1024 + 17, 0xff);
  bytes[0] = 0;
  await fs.mkdir(path.join(root, 'assets', 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'destination'));
  await fs.writeFile(path.join(root, 'assets', 'nested', 'data.bin'), bytes);
  await manager.copyOrMove({ source: 'assets', destination: 'destination', mode: 'copy' });
  assert.deepEqual(await fs.readFile(path.join(root, 'destination', 'assets', 'nested', 'data.bin')), bytes);
  assert.deepEqual(await fs.readFile(path.join(root, 'assets', 'nested', 'data.bin')), bytes);
  await assert.rejects(manager.read({ path: 'assets/nested/data.bin' }));
});

test('UTF-8 BOM and raw-byte versions survive a read and save round trip', async t => {
  const { root, manager } = await fixture(t);
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好\r\n')]);
  await fs.writeFile(path.join(root, 'bom.txt'), bytes);
  const snapshot = await manager.read({ path: 'bom.txt' });
  assert.equal(snapshot.content, '\ufeff你好\r\n');
  assert.match(snapshot.version, /^[a-f0-9]{64}$/);
  assert.equal(snapshot.version, digest(bytes));
  const saved = await manager.save({ path: 'bom.txt', content: snapshot.content, expectedVersion: snapshot.version });
  assert.equal(saved.version, snapshot.version);
  assert.deepEqual(await fs.readFile(path.join(root, 'bom.txt')), bytes);
});

test('text editing rejects malformed UTF-8, NUL and byte limits without changing files', async t => {
  const { root, manager } = await fixture(t);
  const invalid = new Map([
    ['invalid.txt', Buffer.from([0xc3, 0x28])],
    ['binary.txt', Buffer.from([65, 0, 66])],
    ['large.txt', Buffer.alloc(512 * 1024 + 1, 65)],
  ]);
  for (const [name, bytes] of invalid) {
    await fs.writeFile(path.join(root, name), bytes);
    await assert.rejects(manager.read({ path: name }));
    assert.deepEqual(await fs.readFile(path.join(root, name)), bytes);
  }
  await fs.writeFile(path.join(root, 'valid.txt'), 'original');
  const original = await manager.read({ path: 'valid.txt' });
  for (const content of ['bad\0content', '界'.repeat(Math.floor(512 * 1024 / 3) + 1)]) {
    await assert.rejects(manager.save({ path: original.path, content, expectedVersion: original.version }));
    assert.equal(await fs.readFile(path.join(root, 'valid.txt'), 'utf8'), 'original');
  }
  const exactLimit = 'a'.repeat(512 * 1024);
  const saved = await manager.save({ path: original.path, content: exactLimit, expectedVersion: original.version });
  assert.equal(saved.version, digest(Buffer.from(exactLimit)));
});

test('external edits and concurrent saves cannot silently overwrite a newer version', async t => {
  const { root, manager } = await fixture(t);
  await fs.writeFile(path.join(root, 'note.txt'), 'original');
  const original = await manager.read({ path: 'note.txt' });
  await fs.writeFile(path.join(root, 'note.txt'), 'external');
  await assert.rejects(manager.save({ path: 'note.txt', content: 'stale', expectedVersion: original.version }), { code: 'FILE_VERSION_CONFLICT' });
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'external');
  const current = await manager.read({ path: 'note.txt' });
  const attempts = await Promise.allSettled([
    manager.save({ path: 'note.txt', content: 'first', expectedVersion: current.version }),
    manager.save({ path: 'note.txt', content: 'second', expectedVersion: current.version }),
  ]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = attempts.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'FILE_VERSION_CONFLICT');
  const winner = attempts.find(result => result.status === 'fulfilled').value;
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), winner.content);
  const recovered = await manager.save({ path: 'note.txt', content: 'after failure', expectedVersion: winner.version });
  assert.equal(recovered.content, 'after failure');
});

test('same-directory copies receive distinct suffixes and same-directory cuts are harmless', async t => {
  const { root, manager } = await fixture(t);
  await fs.writeFile(path.join(root, 'report.txt'), 'keep');
  const first = await manager.copyOrMove({ source: 'report.txt', destination: '', mode: 'copy' });
  const second = await manager.copyOrMove({ source: 'report.txt', destination: '', mode: 'copy' });
  assert.equal(first.path, 'report - 副本.txt');
  assert.equal(second.path, 'report - 副本 (2).txt');
  const moved = await manager.copyOrMove({ source: 'report.txt', destination: '', mode: 'cut' });
  assert.equal(moved.path, 'report.txt');
  for (const name of ['report.txt', first.path, second.path]) assert.equal(await fs.readFile(path.join(root, name), 'utf8'), 'keep');
  assert.equal((await fs.readdir(root)).length, 3);
});

test('create, rename and cut conflicts never overwrite existing data and the queue remains usable', async t => {
  const { root, manager } = await fixture(t);
  await fs.writeFile(path.join(root, 'one.txt'), 'one');
  await fs.writeFile(path.join(root, 'two.txt'), 'two');
  await fs.mkdir(path.join(root, 'target'));
  await fs.writeFile(path.join(root, 'target', 'one.txt'), 'target');
  await assert.rejects(manager.create({ parent: '', name: 'one.txt', type: 'file' }), { code: 'FILE_EXISTS' });
  await assert.rejects(manager.rename({ path: 'one.txt', name: 'two.txt' }), { code: 'FILE_EXISTS' });
  await assert.rejects(manager.copyOrMove({ source: 'one.txt', destination: 'target', mode: 'cut' }), { code: 'FILE_EXISTS' });
  assert.equal(await fs.readFile(path.join(root, 'one.txt'), 'utf8'), 'one');
  assert.equal(await fs.readFile(path.join(root, 'two.txt'), 'utf8'), 'two');
  assert.equal(await fs.readFile(path.join(root, 'target', 'one.txt'), 'utf8'), 'target');
  assert.equal((await manager.create({ parent: '', name: 'after.txt', type: 'file' })).path, 'after.txt');
});

test('unsafe paths and Windows aliases are rejected before creating anything', async t => {
  const { root, manager } = await fixture(t);
  const unsafe = ['../escape.txt', '..\\escape.txt', '/absolute.txt', 'C:\\Windows\\test', 'C:relative.txt', '\\\\server\\share\\x', '\\\\?\\C:\\x', 'name:stream', 'sub/../x', 'end.', 'end ', 'NUL', 'con.txt', 'COM1.log', 'LPT9', 'CONIN$', 'CONOUT$.txt', 'COM¹', 'LPT².txt', 'bad\x7fname', 'bad\nname'];
  for (const input of unsafe) {
    await assert.rejects(manager.paths({ path: input }), undefined, input);
    await assert.rejects(manager.create({ parent: '', name: input, type: 'file' }), undefined, input);
  }
  await assert.rejects(manager.remove({ path: '' }));
  await assert.rejects(manager.rename({ path: '', name: 'changed' }));
  assert.deepEqual(await fs.readdir(root), []);
});

test('protected names are hidden and cannot be opened, copied, renamed, removed or created', async t => {
  const { root, manager, trashed } = await fixture(t);
  const names = ['.git', '.codex', '.aws', '.ssh', '.azure', '.gnupg', '.npm', '.npm-cache', 'node_modules', '.env', '.ENV.local', '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials.json', 'secret.txt', 'secrets.json', 'id_ed25519.pub', 'private.KEY', 'client.p12', 'client.pfx', 'store.keystore'];
  await fs.mkdir(path.join(root, 'destination'));
  for (const name of names) {
    await fs.writeFile(path.join(root, name), 'protected');
    await assert.rejects(manager.read({ path: name }), undefined, name);
    await assert.rejects(manager.paths({ path: name }), undefined, name);
    await assert.rejects(manager.rename({ path: name, name: 'renamed.txt' }), undefined, name);
    await assert.rejects(manager.copyOrMove({ source: name, destination: 'destination', mode: 'copy' }), undefined, name);
    await assert.rejects(manager.remove({ path: name }), undefined, name);
    assert.equal(await fs.readFile(path.join(root, name), 'utf8'), 'protected');
  }
  for (const name of names) await assert.rejects(manager.create({ parent: 'destination', name, type: 'file' }), undefined, name);
  assert.deepEqual((await manager.list()).map(entry => entry.name), ['destination']);
  assert.deepEqual(await fs.readdir(path.join(root, 'destination')), []);
  assert.equal(trashed.length, 0);
});

test('a protected descendant rejects whole-directory operations without partial copies or trash calls', async t => {
  const { root, manager, trashed } = await fixture(t);
  await fs.mkdir(path.join(root, 'tree', 'nested'), { recursive: true });
  await fs.mkdir(path.join(root, 'destination'));
  await fs.writeFile(path.join(root, 'tree', 'allowed.txt'), 'visible');
  await fs.writeFile(path.join(root, 'tree', 'nested', '.env.local'), 'protected');
  for (const mode of ['copy', 'cut']) await assert.rejects(manager.copyOrMove({ source: 'tree', destination: 'destination', mode }));
  await assert.rejects(manager.rename({ path: 'tree', name: 'renamed' }));
  await assert.rejects(manager.remove({ path: 'tree' }));
  assert.deepEqual(await fs.readdir(path.join(root, 'destination')), []);
  await missing(path.join(root, 'renamed'));
  assert.equal(await fs.readFile(path.join(root, 'tree', 'allowed.txt'), 'utf8'), 'visible');
  assert.equal(await fs.readFile(path.join(root, 'tree', 'nested', '.env.local'), 'utf8'), 'protected');
  assert.equal(trashed.length, 0);
});

test('copy entry, byte and depth budgets are preflighted before destination creation', async t => {
  for (const options of [{ maxCopyEntries: 1 }, { maxCopyBytes: 3 }, { maxDepth: 1 }]) {
    const { root, manager } = await fixture(t, options);
    await fs.mkdir(path.join(root, 'tree', 'nested', 'deeper'), { recursive: true });
    await fs.mkdir(path.join(root, 'destination'));
    await fs.writeFile(path.join(root, 'tree', 'first.txt'), '1234');
    await fs.writeFile(path.join(root, 'tree', 'nested', 'deeper', 'last.txt'), 'last');
    await assert.rejects(manager.copyOrMove({ source: 'tree', destination: 'destination', mode: 'copy' }));
    assert.deepEqual(await fs.readdir(path.join(root, 'destination')), []);
    assert.equal(await fs.readFile(path.join(root, 'tree', 'first.txt'), 'utf8'), '1234');
    assert.equal((await manager.create({ parent: 'destination', name: 'after.txt', type: 'file' })).path, 'destination/after.txt');
  }
});

test('copying or cutting a directory into itself or a descendant leaves the source intact', async t => {
  const { root, manager } = await fixture(t);
  await fs.mkdir(path.join(root, 'tree', 'nested'), { recursive: true });
  await fs.writeFile(path.join(root, 'tree', 'note.txt'), 'keep');
  for (const mode of ['copy', 'cut']) {
    await assert.rejects(manager.copyOrMove({ source: 'tree', destination: 'tree/nested', mode }));
    await assert.rejects(manager.copyOrMove({ source: 'tree', destination: 'tree', mode }));
  }
  assert.deepEqual(await fs.readdir(path.join(root, 'tree', 'nested')), []);
  assert.equal(await fs.readFile(path.join(root, 'tree', 'note.txt'), 'utf8'), 'keep');
});

test('junctions and hard links cannot expose or mutate external files', async t => {
  const { root, outside, manager, trashed } = await fixture(t);
  await fs.writeFile(path.join(outside, 'outside.txt'), 'outside remains');
  await fs.mkdir(path.join(root, 'destination'));
  await fs.symlink(outside, path.join(root, 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir');
  await fs.link(path.join(outside, 'outside.txt'), path.join(root, 'hard.txt'));
  for (const relative of ['shortcut/outside.txt', 'hard.txt']) {
    await assert.rejects(manager.read({ path: relative }));
    await assert.rejects(manager.paths({ path: relative }));
    await assert.rejects(manager.save({ path: relative, content: 'bad', expectedVersion: digest(Buffer.from('outside remains')) }));
    await assert.rejects(manager.copyOrMove({ source: relative, destination: 'destination', mode: 'copy' }));
    await assert.rejects(manager.rename({ path: relative, name: 'changed.txt' }));
    await assert.rejects(manager.remove({ path: relative }));
  }
  await assert.rejects(manager.create({ parent: 'shortcut', name: 'new.txt', type: 'file' }));
  assert.deepEqual((await manager.list()).map(entry => entry.name), ['destination']);
  assert.equal(await fs.readFile(path.join(outside, 'outside.txt'), 'utf8'), 'outside remains');
  await missing(path.join(outside, 'new.txt'));
  assert.deepEqual(await fs.readdir(path.join(root, 'destination')), []);
  assert.equal(trashed.length, 0);
});

test('nested links reject directory copy, move, rename and remove as a whole', async t => {
  const { root, outside, manager, trashed } = await fixture(t);
  await fs.writeFile(path.join(outside, 'outside.txt'), 'outside');
  await fs.mkdir(path.join(root, 'tree'));
  await fs.mkdir(path.join(root, 'destination'));
  await fs.writeFile(path.join(root, 'tree', 'allowed.txt'), 'keep');
  await fs.symlink(outside, path.join(root, 'tree', 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const mode of ['copy', 'cut']) await assert.rejects(manager.copyOrMove({ source: 'tree', destination: 'destination', mode }));
  await assert.rejects(manager.rename({ path: 'tree', name: 'renamed' }));
  await assert.rejects(manager.remove({ path: 'tree' }));
  assert.deepEqual(await fs.readdir(path.join(root, 'destination')), []);
  assert.equal(await fs.readFile(path.join(root, 'tree', 'allowed.txt'), 'utf8'), 'keep');
  assert.equal(trashed.length, 0);
});

test('removal requires an available trash implementation and never falls back to unlink', async t => {
  const { root, manager } = await fixture(t, { trash: undefined });
  await fs.writeFile(path.join(root, 'note.txt'), 'keep');
  await assert.rejects(manager.remove({ path: 'note.txt' }), { code: 'TRASH_UNAVAILABLE' });
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'keep');
});

test('a selected root replaced with a junction invalidates all later access', async t => {
  const { root, outside, manager } = await fixture(t);
  await fs.writeFile(path.join(outside, 'outside.txt'), 'keep');
  await fs.rename(root, `${root}-original`);
  await fs.symlink(outside, root, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(manager.list());
  await assert.rejects(manager.paths());
  await assert.rejects(manager.read({ path: 'outside.txt' }));
  await assert.rejects(manager.create({ parent: '', name: 'new.txt', type: 'file' }));
  assert.equal(await fs.readFile(path.join(outside, 'outside.txt'), 'utf8'), 'keep');
  await missing(path.join(outside, 'new.txt'));
});

test('two managers for one project serialize competing renames and versioned saves without losing files', async t => {
  const { root, manager } = await fixture(t);
  const otherWindow = new ManualFileManager(root);
  await fs.writeFile(path.join(root, 'one.txt'), 'first source');
  await fs.writeFile(path.join(root, 'two.txt'), 'second source');
  const renamed = await Promise.allSettled([
    manager.rename({ path: 'one.txt', name: 'chosen.txt' }),
    otherWindow.rename({ path: 'two.txt', name: 'chosen.txt' }),
  ]);
  assert.equal(renamed.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(renamed.find(result => result.status === 'rejected').reason.code, 'FILE_EXISTS');
  const winner = renamed[0].status === 'fulfilled' ? 0 : 1;
  assert.equal(await fs.readFile(path.join(root, 'chosen.txt'), 'utf8'), winner === 0 ? 'first source' : 'second source');
  assert.equal(await fs.readFile(path.join(root, winner === 0 ? 'two.txt' : 'one.txt'), 'utf8'), winner === 0 ? 'second source' : 'first source');
  const opened = await manager.read({ path: 'chosen.txt' });
  const saved = await Promise.allSettled([
    manager.save({ path: opened.path, content: 'first window edit', expectedVersion: opened.version }),
    otherWindow.save({ path: opened.path, content: 'second window edit', expectedVersion: opened.version }),
  ]);
  assert.equal(saved.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(saved.find(result => result.status === 'rejected').reason.code, 'FILE_VERSION_CONFLICT');
  assert.equal(await fs.readFile(path.join(root, opened.path), 'utf8'), saved.find(result => result.status === 'fulfilled').value.content);
});

test('saving invalid Unicode does not silently substitute characters and case-only rename preserves content', async t => {
  const { root, manager } = await fixture(t);
  await fs.writeFile(path.join(root, 'note.txt'), 'unchanged');
  const opened = await manager.read({ path: 'note.txt' });
  await assert.rejects(manager.save({ path: opened.path, content: 'invalid \ud800', expectedVersion: opened.version }), { code: 'FILE_ENCODING_UNSUPPORTED' });
  assert.equal(await fs.readFile(path.join(root, opened.path), 'utf8'), 'unchanged');
  assert.deepEqual(await manager.rename({ path: opened.path, name: 'NOTE.TXT' }), { path: 'NOTE.TXT', oldPath: 'note.txt', type: 'file' });
  assert.equal((await manager.read({ path: 'NOTE.TXT' })).content, 'unchanged');
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.manual-save-')), false);
});

test('Windows manual rename and cut reject destinations created immediately before the native move', { skip: process.platform !== 'win32' }, async t => {
  const { root, manager } = await fixture(t);
  const originalExecFile = childProcess.execFile;
  const pendingTargets = [];
  let launches = 0;
  t.mock.method(childProcess, 'execFile', (executable, args, options, callback) => {
    const pending = pendingTargets.shift();
    assert.ok(pending, 'Unexpected process launch');
    launches++;
    assert.equal(executable.toLowerCase(), path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe').toLowerCase());
    assert.equal(options.windowsHide, true);
    assert.equal(options.shell, undefined);
    assert.ok(args.includes('-NoProfile') && args.includes('-NonInteractive'));
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    assert.ok(!script.includes(root), 'Paths must be encoded data rather than script source');
    (async () => {
      if (pending.directory) {
        await fs.mkdir(pending.path);
        await fs.writeFile(path.join(pending.path, 'external-marker.txt'), 'external directory');
      } else await fs.writeFile(pending.path, 'external file', { flag: 'wx' });
      originalExecFile(executable, args, options, callback);
    })().catch(error => callback(error, '', ''));
  });
  for (const operation of ['rename', 'cut']) for (const directory of [false, true]) for (const targetDirectory of [false, true]) {
    const label = `${operation}-${directory ? 'directory' : 'file'}-${targetDirectory ? 'directory' : 'file'}`;
    const source = `${label}-source`, destination = `${label}-destination`;
    if (directory) { await fs.mkdir(path.join(root, source)); await fs.writeFile(path.join(root, source, 'source-marker.txt'), 'source directory'); }
    else await fs.writeFile(path.join(root, source), 'source file');
    let target;
    let moving;
    if (operation === 'rename') {
      target = path.join(root, destination);
      pendingTargets.push({ path: target, directory: targetDirectory });
      moving = manager.rename({ path: source, name: destination });
    } else {
      await fs.mkdir(path.join(root, destination));
      target = path.join(root, destination, source);
      pendingTargets.push({ path: target, directory: targetDirectory });
      moving = manager.copyOrMove({ source, destination, mode: 'cut' });
    }
    await assert.rejects(moving, { code: 'FILE_EXISTS' }, label);
    assert.equal(await fs.readFile(directory ? path.join(root, source, 'source-marker.txt') : path.join(root, source), 'utf8'), directory ? 'source directory' : 'source file');
    assert.equal(await fs.readFile(targetDirectory ? path.join(target, 'external-marker.txt') : target, 'utf8'), targetDirectory ? 'external directory' : 'external file');
  }
  assert.equal(launches, 8);
  assert.equal(pendingTargets.length, 0);
  assert.equal((await manager.create({ name: 'queue-recovered.txt', type: 'file' })).path, 'queue-recovered.txt');
});

test('manual Windows moves preserve unusual Unicode names without shell interpolation', { skip: process.platform !== 'win32' }, async t => {
  const { root, manager } = await fixture(t);
  const original = "中文 ' apostrophe ` $().txt";
  const renamed = "另一个 ' ` $() 名称.txt";
  await fs.writeFile(path.join(root, original), 'literal filename');
  await manager.rename({ path: original, name: renamed });
  await fs.mkdir(path.join(root, '目标 目录'));
  await manager.copyOrMove({ source: renamed, destination: '目标 目录', mode: 'cut' });
  assert.equal(await fs.readFile(path.join(root, '目标 目录', renamed), 'utf8'), 'literal filename');
  await missing(path.join(root, original));
  await missing(path.join(root, renamed));
});

test('move preflight still rejects source changes and failed helpers reveal no raw output', { skip: process.platform !== 'win32' }, async t => {
  const { root, manager } = await fixture(t);
  const source = path.join(root, 'source.txt');
  await fs.writeFile(source, 'original');
  const originalLstat = fs.lstat;
  let reads = 0, changed = false;
  const lstatMock = t.mock.method(fs, 'lstat', async (...args) => {
    const stat = await originalLstat(...args);
    if (samePath(String(args[0]), source) && ++reads === 2) {
      await fs.writeFile(source, 'external source changed'); changed = true;
    }
    return stat;
  });
  await assert.rejects(manager.rename({ path: 'source.txt', name: 'target.txt' }), { code: 'FILE_CHANGED' });
  assert.equal(changed, true);
  assert.equal(await fs.readFile(source, 'utf8'), 'external source changed');
  await missing(path.join(root, 'target.txt'));
  lstatMock.mock.restore();
  const processMock = t.mock.method(childProcess, 'execFile', (_executable, _args, _options, callback) => {
    queueMicrotask(() => callback(new Error('sensitive ' + root), 'unexpected sensitive ' + root, 'stderr sensitive ' + root));
  });
  await assert.rejects(manager.rename({ path: 'source.txt', name: 'target.txt' }), error => {
    assert.equal(error.code, 'FILE_MOVE_UNAVAILABLE');
    assert.ok(!error.message.includes(root));
    assert.ok(!error.message.includes('sensitive'));
    return true;
  });
  assert.equal(await fs.readFile(source, 'utf8'), 'external source changed');
  await missing(path.join(root, 'target.txt'));
  processMock.mock.restore();
  await manager.rename({ path: 'source.txt', name: 'recovered.txt' });
  assert.equal(await fs.readFile(path.join(root, 'recovered.txt'), 'utf8'), 'external source changed');
});

test('Windows atomic autosave retries only transient replacement failures and retains the pinned version', { skip: process.platform !== 'win32' }, async t => {
  const { root, manager } = await fixture(t);
  const filename = path.join(root, 'note.txt');
  await fs.writeFile(filename, 'original');
  const opened = await manager.read({ path: 'note.txt' });
  const rename = fs.rename;
  let attempts = 0;
  const replacements = [];
  t.mock.method(fs, 'rename', async (source, destination) => {
    assert.equal(destination, filename);
    assert.equal(await fs.readFile(filename, 'utf8'), 'original');
    replacements.push(source);
    const code = ['EPERM', 'EACCES', 'EBUSY'][attempts++];
    if (code) throw Object.assign(new Error('transient fixture rename lock'), { code, syscall: 'rename' });
    return rename(source, destination);
  });
  const result = await manager.save({ path: opened.path, expectedVersion: opened.version, content: 'latest editor buffer' });
  assert.equal(attempts, 4);
  assert.equal(new Set(replacements).size, 1, 'Retries reuse the already written and validated temporary file');
  assert.equal(result.version, digest(Buffer.from('latest editor buffer')));
  assert.equal(await fs.readFile(filename, 'utf8'), 'latest editor buffer');
  assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('.manual-save-')), []);
});

test('Windows autosave stops retrying when the target changes between replacement attempts', { skip: process.platform !== 'win32' }, async t => {
  const { root, manager } = await fixture(t);
  const filename = path.join(root, 'note.txt');
  await fs.writeFile(filename, 'original');
  const opened = await manager.read({ path: 'note.txt' });
  let attempts = 0;
  t.mock.method(fs, 'rename', async () => {
    attempts++;
    await fs.writeFile(filename, 'external edit during replacement wait');
    throw Object.assign(new Error('transient fixture rename lock'), { code: 'EPERM', syscall: 'rename' });
  });
  await assert.rejects(manager.save({ path: opened.path, expectedVersion: opened.version, content: 'stale editor draft' }), { code: 'FILE_VERSION_CONFLICT' });
  assert.equal(attempts, 1, 'An intervening version change is rejected before another replacement');
  assert.equal(await fs.readFile(filename, 'utf8'), 'external edit during replacement wait');
  assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('.manual-save-')), []);
});

test('Windows autosave rejects a replaced temporary file between commit retries without deleting it', { skip: process.platform !== 'win32' }, async t => {
  const { root, manager } = await fixture(t);
  const filename = path.join(root, 'note.txt');
  await fs.writeFile(filename, 'original');
  const opened = await manager.read({ path: 'note.txt' });
  let attempts = 0, replacedTemporary;
  t.mock.method(fs, 'rename', async source => {
    attempts++;
    replacedTemporary = source;
    await fs.unlink(source);
    await fs.writeFile(source, 'unrelated replacement temporary content');
    throw Object.assign(new Error('transient fixture rename lock'), { code: 'EBUSY', syscall: 'rename' });
  });
  await assert.rejects(manager.save({ path: opened.path, expectedVersion: opened.version, content: 'editor draft' }), { code: 'FILE_CHANGED' });
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(filename, 'utf8'), 'original');
  assert.equal(await fs.readFile(replacedTemporary, 'utf8'), 'unrelated replacement temporary content');
});

test('Windows persistent replacement denial has a strict retry limit and preserves the target', { skip: process.platform !== 'win32' }, async t => {
  const { root, manager } = await fixture(t);
  const filename = path.join(root, 'note.txt');
  await fs.writeFile(filename, 'original');
  const opened = await manager.read({ path: 'note.txt' });
  let attempts = 0;
  t.mock.method(fs, 'rename', async () => {
    attempts++;
    throw Object.assign(new Error('persistent fixture rename denial'), { code: 'EPERM', syscall: 'rename' });
  });
  await assert.rejects(manager.save({ path: opened.path, expectedVersion: opened.version, content: 'unsaved editor draft' }), { code: 'FILE_PERMISSION_DENIED' });
  assert.equal(attempts, 4);
  assert.equal(await fs.readFile(filename, 'utf8'), 'original');
  assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith('.manual-save-')), []);
});
