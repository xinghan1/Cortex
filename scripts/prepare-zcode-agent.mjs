import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

// Build the complete official CLI from this immutable upstream revision. Never
// replace its SEA collectors, remove plugins, or introduce a model/API wrapper.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceCommit = '3c5b227649371507ddc4eb46ac5133afe6db1cab';
const repository = 'https://github.com/zai-org/ZCode.git';
const version = '0.17.0';
const nodeVersion = '24.14.0';
const nodeSource = `https://nodejs.org/dist/v${nodeVersion}/win-x64/node.exe`;
const nodeSha256 = '63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088';
const pnpmVersion = '10.33.2';
const pnpmSource = `https://registry.npmjs.org/pnpm/-/pnpm-${pnpmVersion}.tgz`;
const pnpmIntegrity = 'qQ+vb+6rca1sblf5Tg/hoS9dzCLNdU20CulZPraj4LaxLjVAIYuzeuCDQEsfLObbKkEh6XmCm0r/lLmfSdoc+A==';
const source = path.join(root, 'artifacts', 'zcode-source-v0170');
const tools = path.join(root, 'artifacts', 'zcode-build-tools');
const destination = path.join(root, 'src', 'vendor', 'zcode-agent');
const binaryName = 'zcode-windows-x64.exe';
const retained = [binaryName, 'LICENSE', 'NOTICE.md', 'THIRD-PARTY-NOTICES.md', 'NODE-LICENSE.txt'];
const sha = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);
const args = process.argv.slice(2);
if (args.some(value => value !== '--rebuild')) throw new Error('用法：node scripts/prepare-zcode-agent.mjs [--rebuild]');
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('官方 ZCode SEA 构建目前固定 Windows x64。');

// The generated files are independently checked before every fast path.
async function prepared() {
  try {
    const metadata = JSON.parse(await fs.readFile(path.join(destination, 'provenance.json'), 'utf8'));
    if (metadata.formatVersion !== 1 || metadata.sourceCommit !== sourceCommit || metadata.version !== version || metadata.environment !== 'production'
        || metadata.node?.sha256 !== nodeSha256 || metadata.pnpm?.integrity !== `sha512-${pnpmIntegrity}`
        || metadata.license !== 'Apache-2.0' || JSON.stringify(Object.keys(metadata.files || {}).sort()) !== JSON.stringify([...retained].sort())) return false;
    for (const name of retained) {
      const target = path.join(destination, name), stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || metadata.files[name] !== sha(await fs.readFile(target))) return false;
    }
    return true;
  } catch { return false; }
}
await directory(destination);
if (!args.includes('--rebuild') && await prepared()) { console.log(`官方 ZCode ${version} 原版 SEA 已准备好。`); process.exit(0); }

async function directory(target) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('构建目录超出项目目录。');
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part); await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('构建目录不能是符号链接。');
  }
}
async function download(url, limit) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(180000) });
  if (!response.ok || Number(response.headers.get('content-length')) > limit) throw new Error('固定构建工具下载失败。');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) { size += chunk.length; if (size > limit) throw new Error('构建工具超过大小上限。'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function command(executable, values, options = {}) {
  const result = spawnSync(executable, values, { cwd: source, env: buildEnv, windowsHide: true, shell: false,
    encoding: 'utf8', timeout: 1800000, maxBuffer: 32 * 1024 * 1024, stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) throw new Error(`官方构建命令未完成：${path.basename(executable)} ${values.join(' ')}`);
  return result.stdout?.trim() || '';
}
await directory(tools);
const node = path.join(tools, 'node.exe');
const nodeStat = await fs.lstat(node).catch(() => null);
if (nodeStat && (!nodeStat.isFile() || nodeStat.isSymbolicLink())) throw new Error('Node 构建工具文件无效。');
let nodeBytes = await fs.readFile(node).catch(() => null);
if (!nodeBytes || sha(nodeBytes) !== nodeSha256) {
  nodeBytes = await download(nodeSource, 160 * 1024 * 1024);
  if (sha(nodeBytes) !== nodeSha256 || nodeBytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('官方 Node 二进制校验失败。');
  await fs.writeFile(node, nodeBytes);
}
const pnpmDirectory = path.join(tools, 'pinned-pnpm');
const pnpm = path.join(pnpmDirectory, 'bin', 'pnpm.cjs');
const archiveFile = path.join(tools, `pnpm-${pnpmVersion}.tgz`);
const archiveStat = await fs.lstat(archiveFile).catch(() => null);
if (archiveStat && (!archiveStat.isFile() || archiveStat.isSymbolicLink())) throw new Error('pnpm 发布包缓存文件无效。');
let compressed = await fs.readFile(archiveFile).catch(() => null);
if (!compressed || sha(compressed, 'sha512', 'base64') !== pnpmIntegrity) {
  compressed = await download(pnpmSource, 32 * 1024 * 1024);
  if (sha(compressed, 'sha512', 'base64') !== pnpmIntegrity) throw new Error('固定 pnpm 发布包校验失败。');
  await fs.writeFile(archiveFile, compressed);
}
// Extract only the integrity-checked npm package, with bounded tar framing and
// no links, absolute paths or parent traversal. Existing files are overwritten.
const tar = gunzipSync(compressed, { maxOutputLength: 160 * 1024 * 1024 });
const extracted = new Set();
for (let offset = 0; offset + 512 <= tar.length;) {
  const header = tar.subarray(offset, offset + 512); if (header.every(value => value === 0)) break;
  const clean = bytes => bytes.toString('utf8').split('\0')[0];
  const prefix = clean(header.subarray(345, 500)), basename = clean(header.subarray(0, 100)), name = prefix ? `${prefix}/${basename}` : basename;
  const length = clean(header.subarray(124, 136)).trim(), size = Number.parseInt(length || '0', 8);
  const checksum = Number.parseInt(clean(header.subarray(148, 156)).trim(), 8);
  if (!/^[0-7]*$/u.test(length) || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length
      || checksum !== header.reduce((sum, value, index) => sum + (index >= 148 && index < 156 ? 32 : value), 0)) throw new Error('pnpm 发布包格式无效。');
  if ([0, 48].includes(header[156])) {
    if (!name.startsWith('package/') || name.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f]/u.test(name) || extracted.has(name)) throw new Error('pnpm 发布包路径无效。');
    extracted.add(name); const target = path.join(pnpmDirectory, name.slice(8)); await directory(path.dirname(target));
    const stat = await fs.lstat(target).catch(() => null); if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('pnpm 构建工具文件无效。');
    await fs.writeFile(target, tar.subarray(offset + 512, offset + 512 + size));
  } else if (header[156] !== 53) throw new Error('pnpm 发布包包含不支持的条目。');
  offset += 512 + Math.ceil(size / 512) * 512;
}
if (JSON.parse(await fs.readFile(path.join(pnpmDirectory, 'package.json'), 'utf8')).version !== pnpmVersion) throw new Error('pnpm 版本不匹配。');
const buildEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:GEMINI_|GOOGLE_|ANTHROPIC_|OPENAI_|ZCODE_|MOONSHOT_|KIMI_|ZHIPU_|GLM_|DEEPSEEK_|NODE_OPTIONS$|ELECTRON_RUN_AS_NODE$|NPM_CONFIG_USERCONFIG$|NPM_CONFIG_GLOBALCONFIG$)/iu.test(key)));
Object.assign(buildEnv, { PATH: tools + path.delimiter + (buildEnv.PATH || buildEnv.Path || ''),
  ZCODE_ENV: 'production', NODE_ENV: 'production', NODE_OPTIONS: '--max-old-space-size=8192',
  PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false', npm_config_userconfig: path.join(tools, 'empty.npmrc'), npm_config_globalconfig: path.join(tools, 'empty-global.npmrc'),
  HUSKY: '0' });
const buildHome = path.join(tools, 'build-home'); await directory(buildHome);
Object.assign(buildEnv, { HOME: buildHome, USERPROFILE: buildHome, ZCODE_DATA_BASE_DIR: buildHome,
  ZCODE_HOME: path.join(buildHome, '.zcode'), ZCODE_STORAGE_DIR: path.join(buildHome, '.zcode') });
await fs.writeFile(buildEnv.npm_config_userconfig, '');
await fs.writeFile(buildEnv.npm_config_globalconfig, '');
if (!await fs.stat(source).catch(() => null)) {
  command('git', ['clone', '--no-checkout', '--filter=blob:none', repository, source], { cwd: root });
  command('git', ['fetch', '--depth=1', 'origin', sourceCommit]); command('git', ['checkout', '--detach', sourceCommit]);
}
await directory(source);
if (command('git', ['rev-parse', 'HEAD'], { stdio: 'pipe' }) !== sourceCommit
    || !['https://github.com/zai-org/ZCode.git', 'https://github.com/zai-org/ZCode'].includes(command('git', ['remote', 'get-url', 'origin'], { stdio: 'pipe' }))
    || command('git', ['diff', 'HEAD', '--name-only'], { stdio: 'pipe' })) throw new Error('ZCode 源码必须是干净的官方固定提交。');
if (JSON.parse(await fs.readFile(path.join(source, 'apps', 'zcode-cli', 'package.json'), 'utf8')).version !== version) throw new Error('ZCode CLI 版本不匹配。');
const filters = ['@zcode/cli...', '@zcode/node-repl-host...', '@zcode/android-emulator-plugin...', '@zcode/ios-simulator-plugin...',
  '@zcode/browser-use-plugin...', '@zcode/documents-plugin...', '@zcode/pdf-plugin...', '@zcode/presentations-plugin...', '@zcode/spreadsheets-plugin...'];
// All native optional packages are supplied by the immutable pnpm lock. Root
// lifecycle scripts (Husky/desktop installers) are intentionally not invoked.
command(node, [pnpm, ...filters.flatMap(filter => ['--filter', filter]), 'install', '--frozen-lockfile', '--ignore-scripts', '--prod=false']);
command(node, [pnpm, '-r', ...filters.flatMap(filter => ['--filter', filter]), 'build']);
command(node, ['node_modules/typescript/bin/tsc', '-b', 'packages/shared/tsconfig.json']);
const cli = path.join(source, 'apps', 'zcode-cli', 'packages', 'cli');
command(node, ['scripts/build-sea.mjs', '--target', 'win-x64', '--node-binary', `win-x64=${node}`], { cwd: cli });
if (command('git', ['diff', 'HEAD', '--name-only'], { stdio: 'pipe' })) throw new Error('官方构建修改了跟踪源码，停止生成 vendor。');
await directory(destination); const files = {};
for (const name of retained) {
  const bytes = await fs.readFile(name === binaryName ? path.join(cli, 'dist', name)
    : name === 'NODE-LICENSE.txt' ? path.join(source, 'third-party', 'runtime', `node-${nodeVersion}-LICENSE.txt`) : path.join(source, name));
  if (name === 'NODE-LICENSE.txt' && sha(bytes) !== '4573185d56580da2b890ba34a85a409257640f1c5632eade4300137266194d18') throw new Error('Node 许可证校验失败。');
  const target = path.join(destination, name), stat = await fs.lstat(target).catch(() => null);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('生成组件目标无效。');
  await fs.writeFile(target, bytes); files[name] = sha(bytes);
}
const seaConfig = JSON.parse(await fs.readFile(path.join(cli, 'dist', 'sea-config-win-x64.json'), 'utf8'));
const assets = Object.keys(seaConfig.assets || {});
if (!['zcode-provider/zcode-builtin.json', 'zcode-official-plugins/manifest.json', 'zcode-tui-runtime/manifest.json',
  'zcode-playwright-runtime/manifest.json', 'zcode-runtime-tools/manifest.json'].every(name => assets.includes(name))) throw new Error('官方 SEA 缺少必需运行资源。');
await fs.writeFile(path.join(destination, 'provenance.json'), JSON.stringify({ formatVersion: 1, name: 'ZCode CLI', version,
  repository, sourceCommit, license: 'Apache-2.0', environment: 'production', target: 'win32-x64',
  sourceBuilt: true, officialSourceUnmodified: true, assetCount: assets.length,
  node: { version: nodeVersion, source: nodeSource, sha256: nodeSha256 },
  pnpm: { version: pnpmVersion, source: pnpmSource, integrity: `sha512-${pnpmIntegrity}` },
  lockfileSha256: sha(await fs.readFile(path.join(source, 'pnpm-lock.yaml'))), files }, null, 2) + '\n');
console.log(`已从官方固定源码构建 ZCode ${version}：${assets.length} 项原版 SEA 资源，保留许可证及第三方声明。`);
