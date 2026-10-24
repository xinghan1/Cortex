import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

test('UI subscriptions share one IPC listener, isolate failures and release it after the final unsubscribe', async () => {
  const ipc = new EventEmitter(), errors = [];
  let api;
  vm.runInNewContext(await fs.readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return { ipcRenderer: ipc, contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'forge'); api = value; } } };
    },
    console: { error: (...args) => errors.push(args) },
  });
  const received = [], cleanup = [];
  const removeBroken = api.onEvent(() => { throw new Error('failed component'); });
  for (let index = 0; index < 15; index++) cleanup.push(api.onEvent(value => received.push([index, value.type])));
  assert.equal(ipc.listenerCount('forge:event'), 1);
  ipc.emit('forge:event', {}, { type: 'pet-state' });
  assert.equal(received.length, 15); assert.equal(errors.length, 1);
  cleanup[0](); cleanup[0](); removeBroken();
  received.length = 0;
  ipc.emit('forge:event', {}, { type: 'app-update' });
  assert.equal(received.length, 14); assert.equal(errors.length, 1);
  for (const remove of cleanup) remove();
  assert.equal(ipc.listenerCount('forge:event'), 0);
  const repeated = value => received.push(value.type), first = api.onEvent(repeated), second = api.onEvent(repeated);
  first(); received.length = 0;
  ipc.emit('forge:event', {}, { type: 'extensions' });
  assert.deepEqual(received, ['extensions']);
  second(); assert.equal(ipc.listenerCount('forge:event'), 0);
});
