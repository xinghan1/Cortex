import { createHash } from 'node:crypto';

// Compatibility change to Apache-2.0 ZCode, made by Synora on 2026-10-25.
// Baseline: https://github.com/zai-org/ZCode/tree/3c5b227649371507ddc4eb46ac5133afe6db1cab
// Only connect the existing standalone account runtime to app-server. No model,
// entitlement, credentials, OAuth identity or tool permission rules are changed.
export const ZCODE_STANDALONE_PATCH = Object.freeze({
  id: 'synora-zcode-standalone-account-v1',
  sourcePath: 'apps/zcode-cli/packages/bootstrap/src/zcode-protocol-entrypoint.ts',
  baselineSha256: 'e45d5cdc4f9f90640ef93d89e4b87aa0e40c2a459946b954daa772b7d5594d9d',
  resultSha256: 'b992107fcde46f9df89bcd4ce33af742ed6c7823978f4f60fdaec56169d34d95',
  changedAt: '2026-10-25',
});
const changes = [
  {
    before: '      create: () => startProcessProviderRegistryRuntime(runtimeEnv),',
    after: `      // Synora compatibility: the standalone CLI owns account material in its isolated home.
      create: () =>
        startProcessProviderRegistryRuntime(
          runtimeEnv,
          runtimeEnv.SYNORA_ZCODE_STANDALONE_ACCOUNT === "1" ? { standalone: {} } : {},
        ),`,
  },
  {
    before: '          // 只读同进程已应用快照；不为子任务另发 Host RPC，也不在 ModelFactory 偷换模型。',
    after: `          // Keep account request credentials inside the official standalone runtime.
          ...(activeProviderRegistryRuntime.providerRuntimeHeadersPort
            ? { providerRuntimeHeadersPort: activeProviderRegistryRuntime.providerRuntimeHeadersPort }
            : {}),
          // 只读同进程已应用快照；不为子任务另发 Host RPC，也不在 ModelFactory 偷换模型。`,
  },
];
const sha = text => createHash('sha256').update(text).digest('hex');
export function applyZCodeStandalonePatch(source) {
  if (typeof source !== 'string') throw new TypeError('ZCode 补丁输入必须是源码文本。');
  let output = source.replace(/\r\n/gu, '\n');
  const current = sha(output);
  if (current === ZCODE_STANDALONE_PATCH.resultSha256) return output;
  if (current !== ZCODE_STANDALONE_PATCH.baselineSha256) throw new Error('ZCode 官方源码基线不匹配，拒绝应用兼容补丁。');
  for (const { before, after } of changes) {
    if (output.split(before).length !== 2) throw new Error('ZCode 兼容补丁定位不唯一。');
    output = output.replace(before, after);
  }
  if (sha(output) !== ZCODE_STANDALONE_PATCH.resultSha256) throw new Error('ZCode 兼容补丁结果校验失败。');
  return output;
}
