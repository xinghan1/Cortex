import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { applyZCodeStandalonePatch, ZCODE_STANDALONE_PATCH } from '../scripts/patches/zcode-standalone-account.mjs';

// Exact Apache-2.0 upstream source, not a hand-built protocol/mock shape.
// https://github.com/zai-org/ZCode/blob/3c5b227649371507ddc4eb46ac5133afe6db1cab/apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts
const baseline = (await fs.readFile(new URL('./fixtures/zcode-protocol-entrypoint-v0170.ts', import.meta.url), 'utf8')).replace(/\r\n/gu, '\n');
const patched = applyZCodeStandalonePatch(baseline);
const digest = value => createHash('sha256').update(value).digest('hex');

function registryFactory(source, runtimeEnv) {
  const start = source.indexOf('    providerRegistryRuntime = await acquireProtocolStartupResource({');
  const create = source.indexOf('      create:', start), end = source.indexOf('\n      disposeLate:', create);
  assert.ok(start >= 0 && create > start && end > create);
  const expression = source.slice(create, end).trim().slice('create:'.length).replace(/,$/u, '');
  let received;
  const factory = vm.runInNewContext(`(${expression})`, { runtimeEnv,
    startProcessProviderRegistryRuntime: (...args) => { received = args; return { marker: 'official-runtime' }; } });
  assert.equal(factory().marker, 'official-runtime'); return received;
}
function appFactory(source, nativePort) {
  const start = source.indexOf('      createZCodeApp: (appOptions = {}) =>');
  const end = source.indexOf('\n      cwd: options.cwd,', start);
  assert.ok(start >= 0 && end > start);
  // The pinned factory has one TypeScript-only non-null assertion in the
  // unchanged MCP lease branch; erase that assertion to evaluate its JS logic.
  const expression = source.slice(start, end).trim().slice('createZCodeApp:'.length).replace(/,$/u, '').replace(/\bmcpConnectionPool!/gu, 'mcpConnectionPool');
  const registry = {}, defaultSelection = { providerId: 'official-account', modelId: 'official-model' };
  return vm.runInNewContext(`(${expression})`, {
    createZCodeApp: options => options,
    presentationSurface: 'terminal',
    applyProtocolPresentationSurface: options => options,
    applyProtocolProviderRegistry: options => options,
    activeProviderRegistryRuntime: { runtime: { registryService: registry }, configuredDefaultModelSelection: defaultSelection,
      ...(nativePort ? { providerRuntimeHeadersPort: nativePort } : {}) },
    modelSelectionFacade: { getView: () => ({ effectiveSelection: defaultSelection }) },
    telemetryEnv: {}, telemetryDeviceMid: undefined, nodeReplBrowserBroker: undefined, mcpConnectionPool: undefined,
    providerEndpointRoutingPort: {}, connection: { send: () => {} }, zcodeProtocolNotifications: { toolExecResource: 'resource' },
  });
}

test('compatibility patch is pinned to the actual upstream file and rejects all undeclared source changes', () => {
  assert.equal(digest(baseline), ZCODE_STANDALONE_PATCH.baselineSha256);
  assert.equal(digest(patched), ZCODE_STANDALONE_PATCH.resultSha256);
  assert.equal(applyZCodeStandalonePatch(patched), patched);
  assert.equal(applyZCodeStandalonePatch(baseline.replace(/\n/gu, '\r\n')), patched);
  assert.throws(() => applyZCodeStandalonePatch(baseline + '\n// unrelated source change\n'), /基线不匹配/u);
});

test('the real upstream startup factory enables its existing standalone service only under the component-specific switch', () => {
  const originalEnv = { SYNORA_ZCODE_STANDALONE_ACCOUNT: '1' };
  const original = registryFactory(baseline, originalEnv);
  assert.equal(original[0], originalEnv); assert.equal(original.length, 1, 'unpatched app-server never asks for the account service');
  for (const value of [undefined, '0', 'true']) {
    const received = registryFactory(patched, { SYNORA_ZCODE_STANDALONE_ACCOUNT: value });
    assert.deepEqual(Object.keys(received[1]), []);
  }
  const env = { SYNORA_ZCODE_STANDALONE_ACCOUNT: '1' }, received = registryFactory(patched, env);
  assert.equal(received[0], env); assert.deepEqual(Object.keys(received[1]), ['standalone']);
  assert.deepEqual(Object.keys(received[1].standalone), []);
});

test('the actual app factory keeps credentials inside the upstream standalone port while preserving the native permission broker', () => {
  const nativePort = {}, reversePort = {}, permissionBroker = {}, options = { providerRuntimeHeadersPort: reversePort, permissionBroker };
  assert.equal(appFactory(baseline, nativePort)(options).providerRuntimeHeadersPort, reversePort);
  const standalone = appFactory(patched, nativePort)(options);
  assert.equal(standalone.providerRuntimeHeadersPort, nativePort);
  assert.equal(standalone.permissionBroker, permissionBroker);
  const desktop = appFactory(patched)(options);
  assert.equal(desktop.providerRuntimeHeadersPort, reversePort);
  assert.equal(desktop.permissionBroker, permissionBroker);
  assert.equal(standalone.sourceTitle, 'electron');
});
