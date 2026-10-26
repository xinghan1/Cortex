import fs from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLAUDE_BUNDLED_RELEASE } from '../src/core/claude-runtime.mjs';
import { createArkCliRuntime } from '../src/core/ark-account.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('请在 Windows x64 上准备账号组件。');
const filename = require.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe');
const info = await fs.lstat(filename);
if (!info.isFile() || info.isSymbolicLink() || info.size !== CLAUDE_BUNDLED_RELEASE.bytes) throw new Error('Claude 官方组件缺失，请重新安装锁定的 npm 依赖。');
const hash = createHash('sha256');
for await (const chunk of createReadStream(filename)) hash.update(chunk);
if (hash.digest('hex') !== CLAUDE_BUNDLED_RELEASE.sha256) throw new Error('Claude 官方组件 SHA-256 校验失败。');
const ark = createArkCliRuntime();
let runtime;
try { runtime = await ark.ensure(); }
catch {
  const postinstall = require.resolve('@volcengine/ark-cli/scripts/postinstall.js');
  // Upstream's non-CI lifecycle also installs skills into other agents. Only
  // prepare the verified native binary needed by this application.
  const child = spawnSync(process.execPath, [postinstall], { cwd: root, env: { ...process.env, CI: '1' },
    shell: false, windowsHide: true, stdio: 'inherit' });
  if (child.error || child.status !== 0) throw new Error('火山方舟官方组件准备失败。');
  runtime = await ark.ensure();
}
console.log(`账号组件校验完成：Claude Code ${CLAUDE_BUNDLED_RELEASE.version} / Ark CLI ${runtime.version}`);
