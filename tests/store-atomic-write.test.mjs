import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { testTempRoot } from './helpers/temp-root.mjs';

const { Store } = createRequire(import.meta.url)('../src/core/store.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(testTempRoot, 'synora-atomic-store-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)).toLowerCase(), path.resolve(testTempRoot).toLowerCase());
    assert.ok(path.basename(directory).startsWith('synora-atomic-store-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const destination = path.join(directory, 'session.json');
  await fs.writeFile(destination, JSON.stringify({ preserved: 'original session' }));
  return { directory, destination, store: new Store(directory, {}) };
}

test('Windows atomic JSON replacement retries temporary locks without rewriting or removing the destination', { skip: process.platform !== 'win32' }, async t => {
  const { directory, destination, store } = await fixture(t);
  const rename = fs.rename, writes = [], renames = [];
  const writeFile = fs.writeFile;
  t.mock.method(fs, 'writeFile', async (target, ...args) => { writes.push(target); return writeFile(target, ...args); });
  t.mock.method(fs, 'rename', async (source, target) => {
    assert.equal(target, destination);
    renames.push({ source, target });
    if (renames.length <= 3) {
      assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), { preserved: 'original session' });
      throw Object.assign(new Error('temporary scanner lock'), { code: ['EPERM', 'EACCES', 'EBUSY'][renames.length - 1], syscall: 'rename' });
    }
    return rename(source, target);
  });
  await store.write('session.json', { saved: 'new session' });
  assert.equal(renames.length, 4);
  assert.equal(writes.length, 1, 'Retries must reuse the same fully written temporary file');
  assert.equal(new Set(renames.map(value => value.source)).size, 1);
  assert.notEqual(writes[0], destination);
  assert.deepEqual(JSON.parse(await fs.readFile(destination, 'utf8')), { saved: 'new session' });
  assert.deepEqual(await fs.readdir(directory), ['session.json']);
});

test('persistent Windows replacement locks preserve the old JSON, bound retries and surface the original error', { skip: process.platform !== 'win32' }, async t => {
  const { directory, destination, store } = await fixture(t);
  const original = await fs.readFile(destination, 'utf8');
  const firstError = Object.assign(new Error('persistent original sharing violation'), { code: 'EPERM', syscall: 'rename' });
  let attempts = 0;
  t.mock.method(fs, 'rename', async (source, target) => {
    attempts++;
    assert.equal(target, destination);
    assert.equal(await fs.readFile(target, 'utf8'), original);
    throw attempts === 1 ? firstError : Object.assign(new Error('later lock'), { code: 'EBUSY', syscall: 'rename' });
  });
  await assert.rejects(store.write('session.json', { mustNotReplace: true }), error => error === firstError);
  assert.equal(attempts, 6, 'Retry budget is exactly five delays totaling 620 ms');
  assert.equal(await fs.readFile(destination, 'utf8'), original);
  assert.deepEqual(await fs.readdir(directory), ['session.json']);
});

test('non-lock rename errors surface immediately and remove only this write temporary file', async t => {
  const { directory, destination, store } = await fixture(t);
  const original = await fs.readFile(destination, 'utf8');
  const sentinel = path.join(directory, 'unrelated.tmp');
  await fs.writeFile(sentinel, 'must survive');
  const error = Object.assign(new Error('non-lock filesystem failure'), { code: 'ENOSPC', syscall: 'rename' });
  let attempts = 0;
  t.mock.method(fs, 'rename', async () => { attempts++; throw error; });
  await assert.rejects(store.write('session.json', { mustNotReplace: true }), received => received === error);
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(destination, 'utf8'), original);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['session.json', 'unrelated.tmp']);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'must survive');
});

test('a temporary-file write failure never tries replacement and retains the previous JSON', async t => {
  const { directory, destination, store } = await fixture(t);
  const original = await fs.readFile(destination, 'utf8');
  const error = Object.assign(new Error('temporary write failure'), { code: 'ENOSPC', syscall: 'write' });
  let attempts = 0;
  t.mock.method(fs, 'writeFile', async () => { throw error; });
  t.mock.method(fs, 'rename', async () => { attempts++; });
  await assert.rejects(store.write('session.json', { mustNotReplace: true }), received => received === error);
  assert.equal(attempts, 0);
  assert.equal(await fs.readFile(destination, 'utf8'), original);
  assert.deepEqual(await fs.readdir(directory), ['session.json']);
});


test('queued session saves capture their original IDs and messages, and flush waits for every write', async t => {
  const { store } = await fixture(t), writes = [];
  let release; const gate = new Promise(resolve => { release = resolve; });
  store.write = async (relative, snapshot) => { writes.push({ relative, snapshot: structuredClone(snapshot) }); if (writes.length === 1) await gate; };
  const session = store.createSession('C:/snapshot-fixture'), originalId = session.id;
  session.messages.push({ role: 'user', content: 'first captured message' });
  const first = store.saveSession(session);
  session.messages[0].content = 'second captured message';
  const second = store.saveSession(session);
  session.id = store.createSession().id; session.messages[0].content = 'must not leak into either queued write';
  let settled = false; const flushing = store.flushSessions().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(writes.length, 1);
  release(); await Promise.all([first, second, flushing]);
  assert.equal(settled, true); assert.equal(writes.length, 2);
  assert.ok(writes.every(value => value.relative === path.join('sessions', originalId + '.json') && value.snapshot.id === originalId));
  assert.deepEqual(writes.map(value => value.snapshot.messages[0].content), ['first captured message', 'second captured message']);
});

test('Store itself never persists a temporary conversation even when called directly', async t => {
  const { directory, store } = await fixture(t);
  const before = await fs.readdir(directory), session = store.createSession('C:/temporary-fixture');
  session.temporary = true; session.messages.push({ role: 'user', content: 'temporary private content' });
  await store.saveSession(session); await store.flushSessions();
  assert.deepEqual(await fs.readdir(directory), before);
});
