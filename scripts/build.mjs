import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electronExe = require('electron');
if (process.platform !== 'win32') throw new Error('请在 Windows 上构建此便携版本。');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
await fs.access(path.join(root, 'src', 'vendor', 'siwc', 'index.js')).catch(() => { throw new Error('请先运行 npm run prepare:sdk 构建官方登录组件。'); });
const destination = path.join(root, 'dist', `Synora-code-${pkg.version}-win32-x64`);
// Refuse to overwrite a running or older portable directory and its local user data.
try { await fs.access(destination); throw new Error(`${destination} 已存在，请将旧版本移走后再构建。`); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.cp(path.dirname(electronExe), destination, { recursive: true });
const resources = path.join(destination, 'resources', 'app');
await fs.mkdir(resources, { recursive: true });
await fs.cp(path.join(root, 'src'), path.join(resources, 'src'), { recursive: true });
// Include runtime dependencies only, without developer tooling or its caches.
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const runtime = Object.entries(lock.packages || {}).filter(([name, meta]) => name.startsWith('node_modules/') && !meta.dev).map(([name]) => name).sort((a,b)=>a.length-b.length);
const copied = [];
for (const relative of runtime) {
  if (copied.some(parent => relative.startsWith(parent + '/'))) continue;
  await fs.mkdir(path.dirname(path.join(resources, relative)), { recursive: true });
  await fs.cp(path.join(root, relative), path.join(resources, relative), { recursive: true });
  copied.push(relative);
}
await fs.writeFile(path.join(resources, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, type: 'module', main: 'src/main.cjs' }, null, 2));
await fs.rename(path.join(destination, 'electron.exe'), path.join(destination, 'Synora code.exe'));
await fs.copyFile(path.join(root, 'README.md'), path.join(destination, '使用说明.md'));
await fs.copyFile(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(destination, 'THIRD_PARTY_NOTICES.md'));
const developerDir = path.join(destination, '开发者插件');
await fs.mkdir(path.join(developerDir, 'sdk'), { recursive: true });
await fs.copyFile(path.join(root, 'docs', 'PLUGIN_DEVELOPMENT.md'), path.join(developerDir, 'PLUGIN_DEVELOPMENT.md'));
await fs.copyFile(path.join(root, 'sdk', 'plugin-api.d.ts'), path.join(developerDir, 'sdk', 'plugin-api.d.ts'));
await fs.cp(path.join(root, 'examples', 'hello-plugin'), path.join(developerDir, 'examples', 'hello-plugin'), { recursive: true });
console.log(`已生成 Windows 便携版：${destination}`);
