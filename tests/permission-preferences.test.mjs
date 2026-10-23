import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const modulePath = require.resolve('../src/core/permission-preferences.cjs');
const { PermissionPreferences } = require(modulePath);
const runFile = promisify(execFile);
const testRoot = path.resolve('tests', '.tmp');
const project = 'C:\\Work\\Project';
const otherProject = 'C:\\Work\\Other';

async function fixture(t) {
  await fs.mkdir(testRoot, { recursive: true });
  const dir = await fs.mkdtemp(path.join(testRoot, 'permission-preferences-'));
  t.after(async () => {
    const target = path.resolve(dir);
    assert.equal(path.dirname(target).toLowerCase(), testRoot.toLowerCase());
    assert.ok(path.basename(target).startsWith('permission-preferences-'));
    await fs.rm(target, { recursive: true, force: true });
  });
  return { dir, file: path.join(dir, 'permission-preferences.json') };
}

test('all three explicit permission choices survive reopening without touching model settings', async t => {
  const { dir, file } = await fixture(t);
  const settings = path.join(dir, 'settings.json'), original = '{"provider":"relay","model":"test"}';
  await fs.writeFile(settings, original);
  const preferences = new PermissionPreferences(dir);
  assert.equal(preferences.get(), 'request'); assert.equal(preferences.get(project), 'request');
  assert.equal(await preferences.init(), preferences);
  assert.deepEqual(await fs.readdir(dir), ['settings.json']);
  for (const mode of ['assist', 'full', 'request']) {
    assert.equal(await preferences.set(project, mode), mode);
    assert.equal(preferences.get(project), mode);
    assert.equal((await new PermissionPreferences(dir).init()).get(project), mode);
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1, modes: [['c:\\work\\project', mode]] });
  }
  assert.equal(await fs.readFile(settings, 'utf8'), original);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['permission-preferences.json', 'settings.json']);
});

test('project and empty-window preferences are independent and existing instances retain their active snapshots', async t => {
  const { dir } = await fixture(t);
  const preferences = await new PermissionPreferences(dir).init();
  await preferences.set(project, 'assist');
  await preferences.set(otherProject, 'full');
  await preferences.set(null, 'request');
  const otherWindow = await new PermissionPreferences(dir).init();
  await preferences.set(null, 'assist');
  await preferences.set(project, 'request');
  assert.equal(otherWindow.get(), 'request'); assert.equal(otherWindow.get(project), 'assist');
  const reopened = await new PermissionPreferences(dir).init();
  assert.equal(reopened.get(), 'assist'); assert.equal(reopened.get(project), 'request');
  assert.equal(reopened.get(otherProject), 'full'); assert.equal(reopened.get('D:\\Unseen'), 'request');
});

test('Windows drive and UNC paths normalize case, separators, dot segments and trailing separators', async t => {
  const { dir, file } = await fixture(t);
  const preferences = await new PermissionPreferences(dir).init();
  await preferences.set('C:/WORK/temp/../Project/.//', 'assist');
  assert.equal(preferences.get('c:\\work\\project\\'), 'assist');
  await preferences.set('c:\\WORK\\project', 'full');
  assert.equal(preferences.get(project), 'full');
  await preferences.set('\\\\SERVER\\Share\\Folder\\', 'assist');
  assert.equal(preferences.get('//server/share/folder'), 'assist');
  await preferences.set('C:/', 'assist');
  assert.equal(preferences.get('c:\\'), 'assist');
  await preferences.set('\\\\SERVER\\Share\\', 'full');
  assert.equal(preferences.get('//server/share'), 'full');
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.modes.length, 4);
  assert.equal((await new PermissionPreferences(dir).init()).get('//server/share/folder/'), 'assist');
});

test('invalid modes, relative paths, devices and prototype keys cannot alter saved permissions', async t => {
  const { dir, file } = await fixture(t);
  const preferences = await new PermissionPreferences(dir).init();
  await preferences.set(project, 'assist');
  const original = await fs.readFile(file, 'utf8');
  for (const mode of [null, undefined, '', 'ASSIST', 'approve', '__proto__', 'constructor', {}, [], true, 0]) {
    await assert.rejects(preferences.set(project, mode), { code: 'PERMISSION_PREFERENCES_INVALID_MODE' });
  }
  for (const root of ['', 'relative', 'C:relative', '\\relative', '__proto__', 'constructor', {}, [], 0,
    'C:\\path\u0000bad', 'C:\\path\nwrong', '\\\\?\\C:\\project', '\\\\.\\pipe\\test', 'C:\\work\\file:stream',
    'C:\\work\\project.', 'C:\\work\\project ', 'C:\\con', '//server', 'https://example.com/project']) {
    await assert.rejects(preferences.set(root, 'full'), { code: 'PERMISSION_PREFERENCES_INVALID_PATH' });
    assert.throws(() => preferences.get(root), { code: 'PERMISSION_PREFERENCES_INVALID_PATH' });
  }
  assert.equal(preferences.get(project), 'assist'); assert.equal(await fs.readFile(file, 'utf8'), original);
  assert.equal(Object.prototype.full, undefined);
});

test('damaged or noncanonical persisted data defaults entirely to request and is not rewritten by initialization', async t => {
  const { dir, file } = await fixture(t);
  const valid = ['c:\\work\\project', 'full'];
  const values = ['{', 'null', '[]', '{}', '{"version":2,"modes":[]}',
    JSON.stringify({ version: 1, modes: [valid], unexpected: true }),
    JSON.stringify({ version: 1, modes: { '__proto__': 'full' } }),
    ...[
      [valid, ['__proto__', 'full']], [valid, ['constructor', 'full']], [valid, ['relative', 'full']],
      [valid, [null, 'unknown']], [valid, [project, 'assist']], [valid, valid],
      [valid, [null, 'full', 'unexpected']], [valid, null], Array(513).fill(valid),
    ].map(modes => JSON.stringify({ version: 1, modes }))];
  for (const encoded of values) {
    await fs.writeFile(file, encoded);
    const preferences = await new PermissionPreferences(dir).init();
    assert.equal(preferences.get(project), 'request'); assert.equal(preferences.get(), 'request');
    await preferences.settled();
    assert.equal(await fs.readFile(file, 'utf8'), encoded, 'loading must preserve the original damaged file');
  }
  const preferences = await new PermissionPreferences(dir).init();
  await preferences.set(project, 'assist');
  assert.equal((await new PermissionPreferences(dir).init()).get(project), 'assist', 'an explicit new choice can replace damaged data');
});

test('concurrent changes serialize without losing other projects and settled waits for the final persisted mode', async t => {
  const { dir, file } = await fixture(t);
  await fs.writeFile(file, JSON.stringify({ version: 1, modes: [['c:\\work\\project', 'full']] }));
  const preferences = new PermissionPreferences(dir), completed = [], writes = [], expected = new Map();
  for (let index = 0; index < 36; index++) {
    const root = [project, otherProject, null][index % 3], mode = ['request', 'assist', 'full'][Math.floor(index / 3) % 3];
    expected.set(root, mode);
    writes.push(preferences.set(root, mode).then(value => { completed.push(index); return value; }));
  }
  await preferences.settled();
  await Promise.all(writes);
  assert.deepEqual(completed, Array.from({ length: 36 }, (_, index) => index));
  const reopened = await new PermissionPreferences(dir).init();
  for (const [root, mode] of expected) {
    assert.equal(preferences.get(root), mode); assert.equal(reopened.get(root), mode);
  }
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).modes.length, 3);
  assert.deepEqual(await fs.readdir(dir), ['permission-preferences.json']);
});

test('failed saves retain previous modes, clean temporary files and allow a subsequent retry', async t => {
  const { dir, file } = await fixture(t);
  const preferences = await new PermissionPreferences(dir).init();
  await preferences.set(project, 'assist'); await preferences.set(otherProject, 'request');
  await fs.unlink(file); await fs.mkdir(file);
  await assert.rejects(preferences.set(project, 'full'), error => {
    assert.equal(error.code, 'PERMISSION_PREFERENCES_SAVE_FAILED'); assert.equal(error.message.includes(dir), false);
    assert.equal(error.cause, undefined); return true;
  });
  await preferences.settled();
  assert.equal(preferences.get(project), 'assist'); assert.equal(preferences.get(otherProject), 'request');
  assert.deepEqual(await fs.readdir(dir), ['permission-preferences.json']);
  await fs.rmdir(file);
  await preferences.set(otherProject, 'full');
  const reopened = await new PermissionPreferences(dir).init();
  assert.equal(reopened.get(project), 'assist'); assert.equal(reopened.get(otherProject), 'full');
  assert.deepEqual(await fs.readdir(dir), ['permission-preferences.json']);
});

test('retention evicts the oldest saved choice while refreshing an existing project', async t => {
  const { dir, file } = await fixture(t);
  const modes = Array.from({ length: 512 }, (_, index) => [`c:\\project-${index}`, 'assist']);
  await fs.writeFile(file, JSON.stringify({ version: 1, modes }));
  const preferences = await new PermissionPreferences(dir).init();
  await preferences.set('C:\\project-0', 'full');
  await preferences.set(null, 'assist');
  assert.equal(preferences.get('c:\\project-0'), 'full'); assert.equal(preferences.get('c:\\project-1'), 'request');
  assert.equal(preferences.get('c:\\project-2'), 'assist');
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).modes.length, 512);
  const reopened = await new PermissionPreferences(dir).init();
  assert.equal(reopened.get(), 'assist'); assert.equal(reopened.get('c:\\project-0'), 'full');
});

test('an independent Node process restores assist from disk rather than the writing instance', async t => {
  const { dir } = await fixture(t);
  const preferences = await new PermissionPreferences(dir).init();
  await preferences.set(project, 'assist'); await preferences.settled();
  const script = "const {PermissionPreferences}=require(process.argv[1]); new PermissionPreferences(process.argv[2]).init().then(p=>process.stdout.write(JSON.stringify({mode:p.get(process.argv[3]),empty:p.get()}))).catch(()=>process.exit(1));";
  const { stdout, stderr } = await runFile(process.execPath, ['-e', script, modulePath, dir, project], { windowsHide: true, timeout: 10000 });
  assert.equal(stderr, ''); assert.deepEqual(JSON.parse(stdout), { mode: 'assist', empty: 'request' });
});

test('missing directories are created only on save and invalid construction is rejected', async t => {
  const { dir } = await fixture(t);
  const nested = path.join(dir, 'not-created'), preferences = await new PermissionPreferences(nested).init();
  assert.equal(preferences.get(), 'request'); await assert.rejects(fs.stat(nested), { code: 'ENOENT' });
  await preferences.set(null, 'assist'); assert.equal((await new PermissionPreferences(nested).init()).get(), 'assist');
  for (const value of [undefined, null, {}, '', ' ', 1, 'a\0b', 'a\nb']) {
    assert.throws(() => new PermissionPreferences(value), { code: 'PERMISSION_PREFERENCES_INVALID_CONFIG' });
  }
});
