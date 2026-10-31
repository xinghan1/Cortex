import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('preload forwards the fixed port to the mobile remote IPC handler', async () => {
  const calls = [];
  let bridge;
  vm.runInNewContext(await fs.readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8'), {
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(name, api) { assert.equal(name, 'forge'); bridge = api; } },
        ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve(); } },
      };
    },
    console,
  });
  const requested = { port: 36696 };
  await bridge.mobileRemoteStart(requested);
  assert.deepEqual(calls[0], ['forge:mobileRemoteStart', requested]);
  await bridge.mobileRemoteStart();
  assert.deepEqual(calls[1], ['forge:mobileRemoteStart', undefined]);
});
