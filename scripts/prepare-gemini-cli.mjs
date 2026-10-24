import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = '0.65.0';
const source = `https://registry.npmjs.org/@google/gemini-cli/-/gemini-cli-${version}.tgz`;
const integrity = 'B+flaYBNqX2zO71I5/gu7ZsnI38NlpOl654HWz+bK8I/P5sGILQsbkTOQ5a9V+w1Q6QO3wf9PlqtuMsl7XxpNQ==';
const destination = path.join(root, 'src', 'vendor', 'gemini-cli');
const required = new Map([['package/bundle/gemini.js', 'bundle/gemini.js'], ['package/LICENSE', 'LICENSE'], ['package/package.json', 'package.json']]);
const sha = data => createHash('sha256').update(data).digest('hex');
try {
  const manifest = JSON.parse(await fs.readFile(path.join(destination, 'provenance.json'), 'utf8'));
  if (manifest.formatVersion === 3 && manifest.version === version && manifest.integrity === `sha512-${integrity}` && manifest.source === source
      && Object.keys(manifest.files || {}).length > required.size
      && (await Promise.all(Object.entries(manifest.files || {}).map(async ([name, hash]) => !name.split('/').some(part => !part || part === '.' || part === '..') && !/[\\\x00-\x1f]/u.test(name) && /^(?:bundle\/|LICENSE$|NOTICE$|THIRD_PARTY|package\.json$)/u.test(name) && hash === sha(await fs.readFile(path.join(destination, name)))))).every(Boolean)) {
    console.log(`官方 Gemini CLI ${version} 已准备好。`); process.exit(0);
  }
} catch { /* A missing/incomplete generated runtime is rebuilt from the pinned tarball. */ }
const response = await fetch(source, { redirect: 'error', signal: AbortSignal.timeout(120000) });
if (!response.ok || Number(response.headers.get('content-length')) > 32 * 1024 * 1024) throw new Error('下载官方 Gemini CLI 失败。');
const chunks = []; let bytes = 0;
for await (const chunk of response.body) { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) throw new Error('Gemini CLI 发布包超过大小上限。'); chunks.push(chunk); }
const compressed = Buffer.concat(chunks);
if (createHash('sha512').update(compressed).digest('base64') !== integrity) throw new Error('Gemini CLI 官方发布包完整性校验失败。');
const archive = gunzipSync(compressed, { maxOutputLength: 160 * 1024 * 1024 }), extracted = new Map();
for (let offset = 0; offset + 512 <= archive.length;) {
  const header = archive.subarray(offset, offset + 512); if (header.every(value => value === 0)) break;
  const basename = header.subarray(0, 100).toString('utf8').split('\0')[0];
  const prefix = header.subarray(345, 500).toString('utf8').split('\0')[0];
  const name = prefix ? `${prefix}/${basename}` : basename;
  const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
  const size = Number.parseInt(sizeText || '0', 8);
  if (!/^[0-7]*$/u.test(sizeText) || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > archive.length) throw new Error('Gemini CLI 发布包格式无效。');
  const checksum = Number.parseInt(header.subarray(148, 156).toString('ascii').replace(/\0.*$/u, '').trim(), 8);
  const sum = header.reduce((total, value, index) => total + (index >= 148 && index < 156 ? 32 : value), 0);
  if (checksum !== sum) throw new Error('Gemini CLI 发布包头校验失败。');
  if ((name.startsWith('package/bundle/') || /^package\/(?:NOTICE|THIRD_PARTY[^/]*)$/u.test(name)) && [0, 48].includes(header[156])) {
    if (name.split('/').some(part => !part || part === '.' || part === '..') || /[\\\x00-\x1f]/u.test(name)) throw new Error('Gemini CLI 发布包路径无效。');
    required.set(name, name.slice('package/'.length));
  }
  if (required.has(name)) {
    if (extracted.has(name) || ![0, 48].includes(header[156])) throw new Error('Gemini CLI 发布包条目无效。');
    extracted.set(name, Buffer.from(archive.subarray(offset + 512, offset + 512 + size)));
  }
  offset += 512 + Math.ceil(size / 512) * 512;
}
if (extracted.size !== required.size) throw new Error('Gemini CLI 发布包缺少运行文件。');
const metadata = JSON.parse(extracted.get('package/package.json').toString('utf8'));
if (metadata.name !== '@google/gemini-cli' || metadata.version !== version) throw new Error('Gemini CLI 发布包身份不匹配。');
const files = {};
for (const [name, relative] of required) {
  const target = path.join(destination, relative); await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, extracted.get(name)); files[relative] = sha(extracted.get(name));
}
await fs.writeFile(path.join(destination, 'provenance.json'), JSON.stringify({ formatVersion: 3, name: metadata.name, version, source,
  integrity: `sha512-${integrity}`, license: 'Apache-2.0', repository: 'https://github.com/google-gemini/gemini-cli', files }, null, 2) + '\n');
console.log(`已准备官方 Gemini CLI ${version}，保留原版运行文件和许可证。`);
