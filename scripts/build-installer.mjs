import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
if (process.platform !== 'win32') throw new Error('请在 Windows 上构建此安装版本。');

function run(script, args = []) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

run(path.join(root, 'scripts', 'prepare-chatgpt-sdk.mjs'));
run(require.resolve('electron-builder/cli.js'), [
  '--config', path.join(root, 'electron-builder.json'),
  '--win', 'nsis', '--x64', '--publish', 'never',
]);
