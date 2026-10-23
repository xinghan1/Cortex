import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { testTempRoot } from './helpers/temp-root.mjs';
import { WorkspaceTools } from '../src/core/workspace.mjs';
import { normalizeWorkspaceReference, validStoredWorkspaceReference, safeWorkspacePath } from '../src/core/workspace-path.cjs';

const display = value => value.replace(/\\/gu, '/').replace(/^[a-z]:/u, value => value.toUpperCase());
const result = async promise => {
  const value = await promise;
  assert.ok(!value.startsWith('错误：'), value);
  return JSON.parse(value);
};

async function fixture(t, options = {}) {
  const temp = await fs.mkdtemp(path.join(testTempRoot, 'synora-external-workspace-'));
  const root = path.join(temp, 'client'), outside = path.join(temp, 'server');
  await fs.mkdir(root); await fs.mkdir(outside);
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(temp)).toLowerCase(), path.resolve(testTempRoot).toLowerCase());
    assert.ok(path.basename(temp).startsWith('synora-external-workspace-'));
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { temp, root, outside, tools: new WorkspaceTools(root, { allowExternalPaths: true, approve: async () => true, ...options }) };
}

test('Windows references distinguish project paths, other drives, and cancelled path components', () => {
  const opts = { allowExternalPaths: true, platform: 'win32' };
  assert.equal(normalizeWorkspaceReference('E:/work/client', 'E:\\work\\client\\src\\a.java', opts).relative, 'src/a.java');
  const external = normalizeWorkspaceReference('E:/work/client', '../server/src/a.java', opts);
  assert.equal(external.relative, 'E:/work/server/src/a.java');
  assert.equal(external.base, 'E:\\');
  assert.equal(external.external, true);
  const otherDrive = normalizeWorkspaceReference('E:/work/client', 'g:\\plugin\\Server\\src\\a.java', opts);
  assert.equal(otherDrive.relative, 'G:/plugin/Server/src/a.java');
  assert.ok(normalizeWorkspaceReference('E:/work/client', '../server/old/../a.java', opts).walks.includes('E:\\work\\server\\old'));
  assert.throws(() => normalizeWorkspaceReference('E:/work/client', 'G:/plugin/a.java', { platform: 'win32' }));
});

test('path validation rejects devices, UNC, ADS, drive-relative and protected cancelled segments', () => {
  const unsafe = ['//server/share/a.txt', '\\\\?\\G:\\a.txt', '\\\\.\\C:', 'G:a.txt', '/rooted.txt', '\\rooted.txt',
    'G:/a.txt:stream', 'G:/server/NUL.txt', 'G:/server/folder./a.txt', 'G:/server/folder /a.txt',
    'G:/server/.git/../a.txt', 'G:/server/.env/../a.txt', 'G:/server/node_modules/../a.txt', 'G:/server/private.pem'];
  for (const input of unsafe) {
    assert.throws(() => normalizeWorkspaceReference('E:/client', input, { allowExternalPaths: true, platform: 'win32' }), undefined, input);
    assert.equal(safeWorkspacePath(input, { platform: 'win32' }), false, input);
    assert.equal(validStoredWorkspaceReference(input, { platform: 'win32' }), false, input);
  }
  assert.equal(validStoredWorkspaceReference('G:/server/src/main.java', { platform: 'win32' }), true);
  assert.equal(validStoredWorkspaceReference('g:/server/src/main.java', { platform: 'win32' }), false);
  assert.equal(validStoredWorkspaceReference('G:\\server\\src\\main.java', { platform: 'win32' }), false);
  assert.equal(validStoredWorkspaceReference('src/main.java', { platform: 'win32' }), true);
});

test('external support remains opt in and the default workspace rejects absolute paths and traversal', async t => {
  const { root, outside } = await fixture(t);
  await fs.writeFile(path.join(outside, 'a.txt'), 'server');
  const strict = new WorkspaceTools(root, { approve: async () => true });
  await assert.rejects(strict.readFile({ path: path.join(outside, 'a.txt') }));
  await assert.rejects(strict.readFile({ path: '../server/a.txt' }));
  await assert.rejects(strict.listFiles({ path: outside }));
});

test('list, read and search can inspect another project with full canonical external paths', async t => {
  const { outside, tools } = await fixture(t);
  await fs.mkdir(path.join(outside, 'src'));
  await fs.writeFile(path.join(outside, 'src', 'main.java'), 'class Server {\n  String name = "needle";\n}\n');
  await fs.writeFile(path.join(outside, '.env'), 'needle-secret');
  const listing = await tools.listFiles({ path: outside });
  assert.deepEqual(listing, [{ name: 'src', path: display(path.join(outside, 'src')), type: 'directory' }]);
  const read = await tools.readFile({ path: '../server/src/main.java' });
  assert.equal(read.path, display(path.join(outside, 'src', 'main.java')));
  const search = await result(tools.execute('search_files', { path: outside, query: 'needle' }));
  assert.deepEqual(search.matches.map(match => [match.path, match.line]), [[read.path, 2]]);
});

test('external writes and replacements publish the actual path while internal absolute paths stay relative', async t => {
  const approvals = [], changes = [];
  const { root, outside, tools } = await fixture(t, { approve: async request => { approvals.push(request); return true; } });
  const absolute = path.join(outside, 'main.txt');
  await fs.writeFile(absolute, 'server old');
  const read = await tools.readFile({ path: absolute });
  const write = await result(tools.execute('write_file', { path: '../server/main.txt', content: 'server new' }, { onFileChange: change => changes.push(change) }));
  assert.equal(write.path, display(absolute));
  await result(tools.execute('replace_in_file', { path: absolute, old_text: 'new', new_text: 'final' }, { onFileChange: change => changes.push(change) }));
  assert.equal(await fs.readFile(absolute, 'utf8'), 'server final');
  assert.equal(read.path, display(absolute));
  assert.deepEqual(approvals.map(item => item.path), [display(absolute), display(absolute)]);
  assert.deepEqual(changes.map(item => item.path), [display(absolute), display(absolute)]);
  const internal = await result(tools.execute('write_file', { path: path.join(root, 'local.txt'), content: 'local' }));
  assert.equal(internal.path, 'local.txt');
});

test('explicit external search does not exclude a project because of its ancestor directory name', async t => {
  const { outside, tools } = await fixture(t);
  for (const ancestor of ['build', 'dist', '.workspace']) {
    const directory = path.join(outside, ancestor, 'Server', 'src');
    await fs.mkdir(path.join(directory, 'build'), { recursive: true });
    await fs.writeFile(path.join(directory, 'main.java'), 'external-needle');
    await fs.writeFile(path.join(directory, 'build', 'ignored.java'), 'external-needle');
    const search = await result(tools.execute('search_files', { path: directory, query: 'external-needle' }));
    assert.deepEqual(search.matches.map(match => match.path), [display(path.join(directory, 'main.java'))]);
  }
});

test('new external nested parents are created only after approval and denied operations leave no directories', async t => {
  let approved = false;
  const { outside, tools } = await fixture(t, { approve: async () => approved });
  const filename = path.join(outside, 'new', 'src', 'main.txt');
  assert.equal((await result(tools.execute('write_file', { path: filename, content: 'created' }))).denied, true);
  await assert.rejects(fs.access(path.dirname(filename)));
  approved = true;
  assert.equal((await result(tools.execute('write_file', { path: filename, content: 'created' }))).path, display(filename));
  assert.equal(await fs.readFile(filename, 'utf8'), 'created');
});

test('observations share identity across absolute, traversal and Windows case aliases', async t => {
  let approvals = 0;
  const { outside, tools } = await fixture(t, { approve: async () => { approvals++; return true; } });
  const filename = path.join(outside, 'main.txt');
  await fs.writeFile(filename, 'first');
  await tools.readFile({ path: '../server/main.txt' });
  await fs.writeFile(filename, 'manual change');
  const alias = process.platform === 'win32' ? filename.toUpperCase() : filename;
  assert.match(await tools.execute('write_file', { path: alias, content: 'overwritten' }), /^错误：.*重新读取/u);
  assert.equal(approvals, 0);
  assert.equal(await fs.readFile(filename, 'utf8'), 'manual change');
});

test('a concurrent external edit during approval is preserved', async t => {
  let filename;
  const { outside, tools } = await fixture(t, { approve: async () => { await fs.writeFile(filename, 'user edit'); return true; } });
  filename = path.join(outside, 'main.txt');
  await fs.writeFile(filename, 'before');
  assert.match(await tools.execute('write_file', { path: filename, content: 'model edit' }), /^错误：.*审批.*变化/u);
  assert.equal(await fs.readFile(filename, 'utf8'), 'user edit');
  assert.equal(tools.history.length, 0);
});

test('external junctions, cancelled junction segments and a project inside a junction are rejected', async t => {
  const { temp, root, outside, tools } = await fixture(t);
  const actual = path.join(temp, 'actual'); await fs.mkdir(actual);
  await fs.writeFile(path.join(outside, 'main.txt'), 'server');
  await fs.symlink(actual, path.join(outside, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const input of [path.join(outside, 'link', 'new.txt'), `${outside}/link/../main.txt`]) {
    await assert.rejects(tools.readFile({ path: input }), /符号链接|联接/u);
    assert.match(await tools.execute('write_file', { path: input, content: 'unsafe' }), /^错误：/u);
  }
  await fs.mkdir(path.join(actual, 'nested'));
  assert.throws(() => new WorkspaceTools(path.join(outside, 'link', 'nested'), { allowExternalPaths: true }), /符号链接|联接|重定向/u);
  assert.throws(() => new WorkspaceTools(`${outside}/link/..`, { allowExternalPaths: true }), /符号链接|联接|重定向/u);
  assert.throws(() => new WorkspaceTools(`${root}/.git/..`, { allowExternalPaths: true }), /受保护/u);
  await fs.symlink(outside, path.join(root, 'shortcut'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match(await tools.execute('write_file', { path: 'shortcut/main.txt', content: 'unsafe' }), /^错误：/u);
  assert.equal(await fs.readFile(path.join(outside, 'main.txt'), 'utf8'), 'server');
});

test('external protected files and cancelled protected directories fail before approval', async t => {
  let approvals = 0;
  const { outside, tools } = await fixture(t, { approve: async () => { approvals++; return true; } });
  for (const suffix of ['.env', '.git/config', '.aws/credentials', 'node_modules/pkg.js', 'key.pem', 'safe/../.ssh/id_rsa', '.git/../main.txt']) {
    const filename = `${outside}/${suffix}`;
    await assert.rejects(tools.readFile({ path: filename }));
    assert.match(await tools.execute('write_file', { path: filename, content: 'unsafe' }), /^错误：/u);
  }
  assert.equal(approvals, 0);
});

test('single step undo restores or removes the original external file', async t => {
  const { outside, tools } = await fixture(t);
  const existing = path.join(outside, 'main.txt'), created = path.join(outside, 'created.txt');
  await fs.writeFile(existing, 'before');
  await result(tools.execute('write_file', { path: existing, content: 'after' }));
  await result(tools.undoLastChange());
  assert.equal(await fs.readFile(existing, 'utf8'), 'before');
  await result(tools.execute('write_file', { path: created, content: 'created' }));
  await result(tools.undoLastChange());
  await assert.rejects(fs.access(created));
  assert.equal(tools.history.length, 0);
});

test('batch undo coalesces path aliases and restores both projects, with redo preserving external identity', async t => {
  const { root, outside, tools } = await fixture(t);
  const external = path.join(outside, 'main.txt');
  await fs.writeFile(path.join(root, 'local.txt'), 'local after');
  await fs.writeFile(external, 'server final');
  const changes = [
    { path: path.join(root, 'local.txt'), before: 'local before', after: 'local after' },
    { path: '../server/main.txt', before: 'server before', after: 'server middle' },
    { path: external, before: 'server middle', after: 'server final' },
  ];
  const undone = await result(tools.undoChanges(changes));
  assert.equal(undone.status, 'completed');
  assert.deepEqual(undone.completed, [display(external), 'local.txt']);
  assert.equal(await fs.readFile(external, 'utf8'), 'server before');
  assert.equal(await fs.readFile(path.join(root, 'local.txt'), 'utf8'), 'local before');
  const redo = await result(tools.undoChanges([
    { path: 'local.txt', before: 'local after', after: 'local before' },
    { path: display(external), before: 'server final', after: 'server before' },
  ], { operationLabel: '恢复' }));
  assert.equal(redo.status, 'completed');
  assert.equal(await fs.readFile(external, 'utf8'), 'server final');
  assert.equal(await fs.readFile(path.join(root, 'local.txt'), 'utf8'), 'local after');
});

test('batch undo preflights every internal and external file before modifying any file', async t => {
  const { root, outside, tools } = await fixture(t);
  const external = path.join(outside, 'main.txt');
  await fs.writeFile(external, 'server after');
  await fs.writeFile(path.join(root, 'local.txt'), 'user changed');
  const undo = await result(tools.undoChanges([
    { path: 'local.txt', before: 'before', after: 'expected after' },
    { path: external, before: 'server before', after: 'server after' },
  ]));
  assert.equal(undo.status, 'failed');
  assert.deepEqual(undo.completed, []);
  assert.equal(await fs.readFile(external, 'utf8'), 'server after');
});

test('batch undo cannot normalize a cancelled external junction out of its preflight', async t => {
  let approvals = 0;
  const { root, outside, tools } = await fixture(t, { approve: async () => { approvals++; return true; } });
  const target = path.join(outside, 'main.txt');
  await fs.writeFile(target, 'server after');
  await fs.writeFile(path.join(root, 'local.txt'), 'local after');
  await fs.symlink(root, path.join(outside, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const undo = await result(tools.undoChanges([
    { path: `${outside}/link/../main.txt`, before: 'server before', after: 'server after' },
    { path: 'local.txt', before: 'local before', after: 'local after' },
  ]));
  assert.equal(undo.status, 'failed');
  assert.deepEqual(undo.completed, []);
  assert.equal(approvals, 0);
  assert.match(undo.error, /符号链接|联接/u);
  assert.equal(await fs.readFile(target, 'utf8'), 'server after');
  assert.equal(await fs.readFile(path.join(root, 'local.txt'), 'utf8'), 'local after');
});

test('an external parent replaced by a junction while approval is pending cannot redirect the write', async t => {
  let outside, actual;
  const context = await fixture(t, { approve: async () => {
    await fs.rename(path.join(outside, 'src'), path.join(outside, 'src-original'));
    await fs.symlink(actual, path.join(outside, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } });
  outside = context.outside; actual = path.join(context.temp, 'redirect');
  await fs.mkdir(actual); await fs.mkdir(path.join(outside, 'src'));
  await fs.writeFile(path.join(outside, 'src', 'main.txt'), 'before');
  assert.match(await context.tools.execute('write_file', { path: path.join(outside, 'src', 'main.txt'), content: 'unsafe' }), /^错误：/u);
  await assert.rejects(fs.access(path.join(actual, 'main.txt')));
  assert.equal(await fs.readFile(path.join(outside, 'src-original', 'main.txt'), 'utf8'), 'before');
});
