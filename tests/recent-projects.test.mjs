import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const { RecentProjects } = createRequire(import.meta.url)('../src/core/recent-projects.cjs');

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'forgedesk-recent-projects-'));
  t.after(async () => {
    const resolved = path.resolve(dir);
    assert.equal(path.dirname(resolved).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(resolved).startsWith('forgedesk-recent-projects-'));
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { dir, file: path.join(dir, 'projects.json') };
}

const clock = () => { let tick = 0; return () => new Date(Date.UTC(2026, 9, 19, 0, 0, tick++)); };

test('missing recent-project files stay absent until recording and persisted records survive restart', async t => {
  const { dir, file } = await fixture(t);
  const projects = new RecentProjects(dir, { now: () => new Date('2026-10-19T01:02:03Z') });
  assert.equal(await projects.init(), projects);
  assert.equal(projects.error, null);
  assert.equal(projects.writable, true);
  assert.deepEqual(projects.list(), []);
  assert.deepEqual(await fs.readdir(dir), []);
  const expected = [{ path: 'C:\\NotAnExistingProject\\Demo', name: 'Demo', lastOpenedAt: '2026-10-19T01:02:03.000Z' }];
  assert.deepEqual(await projects.record('C:\\NotAnExistingProject\\Demo'), expected);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { version: 1, projects: expected });
  assert.deepEqual((await new RecentProjects(dir).init()).list(), expected);
  assert.deepEqual(await fs.readdir(dir), ['projects.json']);
});

test('Windows case, separators and trailing separators deduplicate while equal basenames in different folders remain separate', async t => {
  const { dir } = await fixture(t);
  const projects = new RecentProjects(dir, { now: clock() });
  await projects.record('C:\\Work\\Demo\\');
  await projects.record('D:/Other/Demo');
  const list = await projects.record('c:/WORK//DEMO/');
  assert.equal(list.length, 2);
  assert.equal(list[0].path, 'c:\\WORK\\DEMO');
  assert.equal(list[0].name, 'DEMO');
  assert.equal(list[1].path, 'D:\\Other\\Demo');
  assert.ok(list[0].lastOpenedAt > list[1].lastOpenedAt);
});

test('drive roots and ordinary UNC roots have sensible names and require no access to project directories', async t => {
  const { dir } = await fixture(t);
  const projects = new RecentProjects(dir, { now: clock() });
  await projects.record('C:/');
  await projects.record('\\\\offline-server.invalid\\missing-share\\');
  await projects.record('//OFFLINE-SERVER.INVALID/missing-share/');
  const list = projects.list();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map(item => item.name), ['missing-share', 'C:']);
  assert.equal(list[0].path, '\\\\OFFLINE-SERVER.INVALID\\missing-share\\');
  assert.equal(list[1].path, 'C:\\');
});

test('relative, traversing, device, ADS, URI and ambiguous Windows paths are rejected before writing', async t => {
  const { dir } = await fixture(t);
  const projects = new RecentProjects(dir);
  for (const input of [undefined, null, {}, '', 'relative/project', 'C:relative', '\\root-relative', '../outside', 'C:/work/../outside', 'C:/work/./folder', '\\\\?\\C:\\work', '\\\\.\\C:\\work', '\\??\\C:\\work', '//?/UNC/server/share', 'file:///C:/work', 'https://example.com/project', 'C:/work:stream', 'C:/NUL', 'C:/folder./project', 'C:/folder /project', 'C:/bad\0name', 'C:/bad\nname']) {
    await assert.rejects(projects.record(input), { code: 'RECENT_PROJECTS_INVALID_PATH' }, String(input));
  }
  assert.deepEqual(projects.list(), []);
  assert.deepEqual(await fs.readdir(dir), []);
  assert.equal((await projects.record('C:/valid/project'))[0].name, 'project');
});

test('opening order is stable on equal timestamps, recents cap at 30 and reopening an old project promotes it', async t => {
  const { dir } = await fixture(t);
  const projects = new RecentProjects(dir, { now: clock() });
  for (let index = 0; index < 35; index++) await projects.record('C:/projects/project-' + index);
  assert.equal(projects.list().length, 30);
  assert.equal(projects.list()[0].name, 'project-34');
  assert.equal(projects.list().at(-1).name, 'project-5');
  await projects.record('c:/PROJECTS/project-10');
  assert.equal(projects.list()[0].name, 'project-10');
  assert.equal(projects.list().length, 30);
  const sameTime = new RecentProjects((await fixture(t)).dir, { now: () => '2026-10-19T00:00:00Z' });
  await sameTime.record('C:/one');
  await sameTime.record('C:/two');
  await sameTime.record('c:/ONE');
  assert.deepEqual(sameTime.list().map(item => item.name), ['ONE', 'two']);
});

test('concurrent records serialize, retain all updates and cannot be overwritten by in-flight initialization', async t => {
  const { dir, file } = await fixture(t);
  await fs.writeFile(file, JSON.stringify({ version: 1, projects: [{ path: 'C:/seed', name: 'untrusted title', lastOpenedAt: '2026-01-01T00:00:00Z' }] }));
  const projects = new RecentProjects(dir, { now: clock() });
  const initializing = projects.init();
  const writes = Array.from({ length: 18 }, (_, index) => projects.record('D:/queued/project-' + index));
  await Promise.all([initializing, ...writes]);
  assert.equal(projects.list().length, 19);
  assert.equal(projects.list()[0].name, 'project-17');
  assert.equal(projects.list().at(-1).name, 'seed');
  assert.deepEqual((await new RecentProjects(dir).init()).list(), projects.list());
  assert.deepEqual(await fs.readdir(dir), ['projects.json']);
});

test('list and record results are copies that cannot modify later writes', async t => {
  const { dir } = await fixture(t);
  const projects = new RecentProjects(dir, { now: clock() });
  const first = await projects.record('C:/alpha');
  first[0].path = 'C:/malicious';
  first.push({ path: 'C:/extra' });
  const snapshot = projects.list();
  snapshot[0].name = 'wrong';
  snapshot.length = 0;
  await projects.record('C:/beta');
  assert.deepEqual(projects.list().map(item => item.name), ['beta', 'alpha']);
});

test('corrupt or unsupported data is reported and cannot be silently replaced by record', async t => {
  const { dir, file } = await fixture(t);
  for (const raw of ['{', 'null', '[]', '{"version":2,"projects":[]}', '{"version":1,"projects":{}}', '{"version":1,"projects":[{"path":"relative","lastOpenedAt":"2026-10-19T00:00:00Z"}]}', '{"version":1,"projects":[{"path":"C:/valid","lastOpenedAt":"not-a-date"}]}']) {
    await fs.writeFile(file, raw);
    const projects = await new RecentProjects(dir).init();
    assert.equal(projects.writable, false);
    assert.match(projects.error, /原文件已保留/);
    assert.deepEqual(projects.list(), []);
    await assert.rejects(projects.record('C:/new-project'), { code: 'RECENT_PROJECTS_READ_ONLY' });
    assert.equal(await fs.readFile(file, 'utf8'), raw);
  }
});

test('loading normalizes and deduplicates valid records without rewriting or trusting stored titles', async t => {
  const { dir, file } = await fixture(t);
  const raw = JSON.stringify({ version: 1, projects: [
    { path: 'C:/Work/Name/', name: 'incorrect old title', lastOpenedAt: '2026-10-18T23:00:00Z' },
    { path: 'c:\\WORK\\NAME', name: 'incorrect title', lastOpenedAt: '2026-10-19T08:00:00+08:00' },
  ] });
  await fs.writeFile(file, raw);
  const projects = await new RecentProjects(dir).init();
  assert.deepEqual(projects.list(), [{ path: 'c:\\WORK\\NAME', name: 'NAME', lastOpenedAt: '2026-10-19T00:00:00.000Z' }]);
  assert.equal(await fs.readFile(file, 'utf8'), raw);
});

test('a junction at the data file is not read, followed or overwritten', async t => {
  const { dir, file } = await fixture(t);
  const outside = path.join(dir, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'sentinel'), 'preserved');
  await fs.symlink(outside, file, process.platform === 'win32' ? 'junction' : 'dir');
  const projects = await new RecentProjects(dir).init();
  assert.equal(projects.writable, false);
  await assert.rejects(projects.record('C:/project'), { code: 'RECENT_PROJECTS_READ_ONLY' });
  assert.equal((await fs.lstat(file)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'preserved');
});

test('failed atomic writes retain prior state, remove temporary files and allow a later retry', async t => {
  const { dir, file } = await fixture(t);
  const projects = await new RecentProjects(dir, { now: clock() }).init();
  await projects.record('C:/first');
  const before = projects.list();
  await fs.unlink(file);
  await fs.mkdir(file);
  await assert.rejects(projects.record('C:/second'), { code: 'RECENT_PROJECTS_SAVE_FAILED' });
  assert.deepEqual(projects.list(), before);
  assert.match(projects.error, /保存失败/);
  assert.equal(projects.writable, true);
  assert.deepEqual(await fs.readdir(dir), ['projects.json']);
  await fs.rmdir(file);
  await projects.record('C:/third');
  assert.equal(projects.error, null);
  assert.deepEqual(projects.list().map(item => item.name), ['third', 'first']);
  assert.deepEqual(await fs.readdir(dir), ['projects.json']);
});

test('invalid configuration and injected clocks cannot produce broken persistence', async t => {
  for (const value of [undefined, null, '', {}, 'bad\0dir']) assert.throws(() => new RecentProjects(value), { code: 'RECENT_PROJECTS_INVALID_CONFIG' });
  const { dir } = await fixture(t);
  const projects = new RecentProjects(dir, { now: () => NaN });
  await assert.rejects(projects.record('C:/test'), { code: 'RECENT_PROJECTS_INVALID_TIME' });
  assert.deepEqual(await fs.readdir(dir), []);
});
