import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { inflateRaw, crc32 } from 'node:zlib';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { retryAfterMilliseconds } from './request-retry.mjs';

// Downloaded on demand from Google's original distribution, never redistributed
// in the Synora installer. Registry digest checked on 2026-10-24:
// https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json
export const ANTIGRAVITY_RELEASE = Object.freeze({
  version: '1.4.3',
  url: 'https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-1.4.3-windows-x86_64.zip',
  sha256: '54c2e16378d9a4952e1da70e355f3c33c4f284308d6de48ab3e6e34a127bd325',
  files: Object.freeze({
    'agy_acp_server.exe': Object.freeze({ bytes: 87022872, sha256: '012c6ec50e11e4d452b43e3b68fbbe2e8c88af8b11d0766e4d2d8e75b447d8e2' }),
    'localharness_external.exe': Object.freeze({ bytes: 147843736, sha256: '4d10117211a26059be464eb427eb69bc948b4363a82729059560a705e11d6932' }),
  }),
});
const MAX_ZIP = 256 * 1024 * 1024, MAX_EXPANDED = 512 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 300000, MAX_DOWNLOAD_RETRIES = 2, MAX_RETRY_AFTER_MS = 10000;
const inflate = promisify(inflateRaw);
const hash = data => createHash('sha256').update(data).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => Object.assign(new Error(`[${code}] ${message}`), { name: 'AntigravityError', code });
const cancelled = () => Object.assign(fail('AGY_CANCELLED', 'Antigravity 操作已取消。'), { name: 'AbortError' });
const invalidArchive = () => fail('AGY_ARCHIVE_INVALID', '官方代理安装文件格式无效，请重新下载。');
function check(signal) { if (signal?.aborted) throw cancelled(); }
function networkFailure(error) {
  // Chromium and Node expose different transport errors. Inspect only bounded
  // local codes/text for classification; never publish an upstream URL, proxy
  // credentials, response body or the original exception.
  const details = [error?.code, error?.cause?.code, error?.message, error?.cause?.message]
    .filter(value => typeof value === 'string').map(value => value.slice(0, 2000)).join(' ');
  if (/ERR_CERT_|ERR_SSL_|CERT_HAS_EXPIRED|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_/u.test(details))
    return fail('AGY_DOWNLOAD_TLS', '官方代理下载的安全连接验证失败，请检查系统时间或代理证书。');
  if (/ERR_PROXY_|ERR_TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION/u.test(details))
    return Object.assign(fail('AGY_DOWNLOAD_PROXY', '无法连接下载代理，请检查代理设置及可用性。'), { retryable: true });
  if (/ENOTFOUND|EAI_AGAIN|ERR_NAME_NOT_RESOLVED|ERR_DNS_/u.test(details))
    return Object.assign(fail('AGY_DOWNLOAD_DNS', '无法解析官方下载地址，请检查网络和代理的 DNS 设置。'), { retryable: /EAI_AGAIN/u.test(details) });
  return Object.assign(fail('AGY_DOWNLOAD_FAILED', '下载官方 Antigravity 代理失败，请检查代理和网络。'), { retryable: true });
}
function discardResponse(response) {
  try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch {}
}
function waitFor(operation, signal) {
  check(signal);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => { if (done) return; done = true; signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => finish(cancelled()); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    Promise.resolve().then(operation).then(value => finish(null, value), error => finish(error));
  });
}
function releaseValid(value) {
  return object(value) && /^\d+\.\d+\.\d+$/u.test(value.version) && /^[a-f\d]{64}$/u.test(value.sha256)
    && value.url === `https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-${value.version}-windows-x86_64.zip`
    && object(value.files) && Object.keys(value.files).sort().join(',') === 'agy_acp_server.exe,localharness_external.exe'
    && Object.values(value.files).every(file => object(file) && /^[a-f\d]{64}$/u.test(file.sha256) && Number.isSafeInteger(file.bytes) && file.bytes > 0 && file.bytes <= MAX_EXPANDED);
}

// Strictly parse the two expected regular ZIP members. No shell extractor,
// path traversal, links, duplicates, ZIP64, encryption or unbounded expansion.
export async function unpackAntigravityArchive(bytes, release = ANTIGRAVITY_RELEASE, signal) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > MAX_ZIP || !releaseValid(release)) throw invalidArchive();
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
    if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) { end = index; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw invalidArchive();
  const count = bytes.readUInt16LE(end + 10), centralSize = bytes.readUInt32LE(end + 12), centralOffset = bytes.readUInt32LE(end + 16);
  if (count !== 2 || bytes.readUInt16LE(end + 8) !== count || centralOffset + centralSize !== end) throw invalidArchive();
  const members = [], names = new Set(); let offset = centralOffset, expanded = 0;
  for (let index = 0; index < count; index++) {
    check(signal);
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) throw invalidArchive();
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20), size = bytes.readUInt32LE(offset + 24);
    const length = bytes.readUInt16LE(offset + 28), extra = bytes.readUInt16LE(offset + 30), comment = bytes.readUInt16LE(offset + 32);
    const attrs = bytes.readUInt32LE(offset + 38), local = bytes.readUInt32LE(offset + 42), next = offset + 46 + length + extra + comment;
    const mode = attrs >>> 16 & 0xf000;
    if (next > end || bytes.readUInt16LE(offset + 34) || flags & ~0x0808 || ![0, 8].includes(method) || mode !== 0 && mode !== 0x8000 || attrs & 0x10) throw invalidArchive();
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + length), name = nameBytes.toString('utf8'), expected = release.files[name];
    if (!expected || !Buffer.from(name, 'utf8').equals(nameBytes) || names.has(name) || /[\\/:\x00-\x1f]/u.test(name) || size !== expected.bytes || !compressed) throw invalidArchive();
    if (local + 30 > centralOffset || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw invalidArchive();
    const localLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), data = local + 30 + localLength + localExtra;
    if (data + compressed > centralOffset || !bytes.subarray(local + 30, local + 30 + localLength).equals(nameBytes)) throw invalidArchive();
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size)) throw invalidArchive();
    if (members.some(member => local < member.end && data + compressed > member.local)) throw invalidArchive();
    expanded += size; if (expanded > MAX_EXPANDED) throw invalidArchive();
    names.add(name); members.push({ name, local, data, end: data + compressed, compressed, size, crc, method, expected }); offset = next;
  }
  if (offset !== end) throw invalidArchive();
  const output = new Map();
  for (const member of members) {
    check(signal); const compressed = bytes.subarray(member.data, member.end);
    let content;
    try { content = member.method === 0 ? Buffer.from(compressed) : await inflate(compressed, { maxOutputLength: member.size }); }
    catch { throw invalidArchive(); }
    check(signal);
    if (content.length !== member.size || crc32(content) !== member.crc || content.subarray(0, 2).toString('ascii') !== 'MZ' || hash(content) !== member.expected.sha256) throw invalidArchive();
    output.set(member.name, content);
  }
  return output;
}
async function fileHash(filename) {
  const digest = createHash('sha256'); for await (const bytes of createReadStream(filename)) digest.update(bytes); return digest.digest('hex');
}

export class AntigravityRuntime {
  #root; #directory; #release; #fetch; #onChange; #platform; #arch; #pending = null; #controller = null;
  #state; #initialized = false; #downloadTimeoutMs;
  constructor({ dataDir, fetchImpl = globalThis.fetch, onChange = () => {}, platform = process.platform, arch = process.arch, release = ANTIGRAVITY_RELEASE, downloadTimeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof fetchImpl !== 'function' || typeof onChange !== 'function' || !releaseValid(release)
      || !Number.isSafeInteger(downloadTimeoutMs) || downloadTimeoutMs < 1 || downloadTimeoutMs > DOWNLOAD_TIMEOUT_MS) throw fail('AGY_INVALID_INPUT', 'Antigravity 安装配置无效。');
    this.#root = path.join(path.resolve(dataDir), 'antigravity-runtime'); this.#release = structuredClone(release);
    this.#directory = path.join(this.#root, `${release.version}-win32-x64`); this.#fetch = fetchImpl; this.#onChange = onChange;
    this.#platform = platform; this.#arch = arch; this.#downloadTimeoutMs = downloadTimeoutMs;
    this.#state = { status: 'missing', version: release.version, download: null, error: null };
  }
  #change(value) { Object.assign(this.#state, value); try { Promise.resolve(this.#onChange()).catch(() => {}); } catch {} }
  async #directorySafe(directory) { await fs.mkdir(directory, { recursive: true }); const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('AGY_STORAGE_ERROR', 'Antigravity 安装目录不可用。'); }
  async #installed() {
    try {
      for (const directory of [this.#root, this.#directory]) { const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) return false; }
      for (const [name, expected] of Object.entries(this.#release.files)) {
        const filename = path.join(this.#directory, name), stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expected.bytes || await fileHash(filename) !== expected.sha256) return false;
      }
      return true;
    } catch { return false; }
  }
  async init() { if (!this.#initialized) { this.#initialized = true; if (await this.#installed()) this.#change({ status: 'ready', error: null }); } return this; }
  async publicState() { await this.init(); return structuredClone(this.#state); }
  async #remove(directory) {
    const parent = await fs.realpath(this.#root), stat = await fs.lstat(directory).catch(() => null); if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(await fs.realpath(directory)).toLowerCase() !== parent.toLowerCase()) throw fail('AGY_STORAGE_ERROR', 'Antigravity 临时目录无法安全清理。');
    await fs.rm(directory, { recursive: true, force: true });
  }
  async #download(signal, progress) {
    let chunks = [], received = 0, total = null, etag = null, resumable = false;
    for (let attempt = 0; ; attempt++) {
      check(signal);
      const resume = resumable && received > 0 && total !== null && received < total;
      if (!resume) { chunks = []; received = 0; total = null; etag = null; }
      progress(received, total, true);
      try {
        const headers = { 'Accept-Encoding': 'identity', ...(resume ? { Range: 'bytes=' + received + '-', ...(etag ? { 'If-Range': etag } : {}) } : {}) };
        const response = await waitFor(async () => {
          const value = await this.#fetch(this.#release.url, { signal, redirect: 'error', headers });
          if (signal.aborted) { discardResponse(value); throw cancelled(); }
          return value;
        }, signal);
        if (!response?.ok) {
          discardResponse(response);
          if (response?.status === 407) throw fail('AGY_DOWNLOAD_PROXY', '下载代理要求身份验证，请检查代理设置。');
          const retryable = [408, 429].includes(response?.status) || response?.status >= 500 && response?.status <= 599;
          const retryAfterMs = retryAfterMilliseconds(response?.headers?.get?.('retry-after'));
          throw Object.assign(fail('AGY_DOWNLOAD_FAILED', retryable ? '官方下载服务暂时不可用，请稍后重试。' : '官方代理下载响应无效，请稍后重试。'),
            { retryable, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });
        }
        const sizeHeader = response.headers?.get?.('content-length');
        const responseBytes = sizeHeader && /^\d+$/u.test(sizeHeader) ? Number(sizeHeader) : null;
        if (!response.body || typeof response.body.getReader !== 'function' || sizeHeader !== null && sizeHeader !== undefined && responseBytes === null
          || responseBytes !== null && (!Number.isSafeInteger(responseBytes) || responseBytes <= 0 || responseBytes > MAX_ZIP)) {
          discardResponse(response); throw fail('AGY_DOWNLOAD_FAILED', '官方代理下载响应无效，请稍后重试。');
        }
        const encoding = response.headers?.get?.('content-encoding')?.trim().toLowerCase();
        if (response.status === 206) {
          const range = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(response.headers?.get?.('content-range') || '');
          if (!resume || !range || Number(range[1]) !== received || Number(range[2]) !== total - 1 || Number(range[3]) !== total
            || responseBytes !== null && responseBytes !== total - received || encoding && encoding !== 'identity'
            || etag && response.headers?.get?.('etag') && response.headers.get('etag') !== etag) {
            discardResponse(response); throw fail('AGY_DOWNLOAD_FAILED', '官方代理续传响应无效，请重新下载。');
          }
        } else if (response.status === 200) {
          // A server may ignore Range or reject If-Range with a fresh complete
          // response. Restart the buffer rather than append incompatible bytes.
          // Chromium/Fetch transparently decompress HTTP content encoding, but
          // Content-Length still describes compressed wire bytes. Comparing
          // it to the decoded ZIP falsely rejects Google's gzip response near
          // completion. Bound decoded bytes independently, verify the pinned
          // ZIP digest, and only resume identity transfers with byte offsets.
          chunks = []; received = 0; total = encoding && encoding !== 'identity' ? null : responseBytes;
          const value = response.headers?.get?.('etag');
          etag = typeof value === 'string' && /^"[^"\x00-\x20\x7f]{1,1024}"$/u.test(value) ? value : null;
          resumable = !encoding || encoding === 'identity';
        } else {
          discardResponse(response); throw fail('AGY_DOWNLOAD_FAILED', '官方代理下载响应无效，请稍后重试。');
        }
        progress(received, total, true);
        const reader = response.body.getReader();
        try {
          while (true) {
            const item = await waitFor(() => reader.read(), signal); if (item.done) break;
            const bytes = Buffer.from(item.value); received += bytes.length;
            if (received > MAX_ZIP || total !== null && received > total) throw fail('AGY_DOWNLOAD_FAILED', '官方代理下载文件大小异常。');
            chunks.push(bytes); progress(received, total);
          }
        } catch (error) {
          // Some transports fail while closing a fully delivered body. The
          // pinned full archive digest still decides whether these bytes count.
          check(signal);
          if (total === null || received !== total || error?.name === 'AntigravityError') throw error;
        } finally {
          try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
          try { reader.releaseLock(); } catch {}
        }
        check(signal);
        if (total !== null && received !== total)
          throw Object.assign(fail('AGY_DOWNLOAD_FAILED', '官方代理下载不完整，请重试。'), { retryable: true });
        progress(received, total, true); return Buffer.concat(chunks);
      } catch (error) {
        check(signal);
        const safe = error?.name === 'AntigravityError' ? error : networkFailure(error);
        if (safe.retryable !== true || attempt >= MAX_DOWNLOAD_RETRIES || safe.retryAfterMs > MAX_RETRY_AFTER_MS) throw safe;
        await delay(safe.retryAfterMs ?? 250 * 2 ** attempt, undefined, { signal });
      }
    }
  }
  ensure({ signal, onProgress } = {}) {
    if (this.#pending) return waitFor(() => this.#pending, signal);
    const controller = new AbortController(); this.#controller = controller;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    this.#pending = (async () => {
      let staging, timer, timedOut = false, phase = 'storage';
      try {
        await this.init(); check(controller.signal);
        if (this.#platform !== 'win32' || this.#arch !== 'x64') throw fail('AGY_RUNTIME_UNSUPPORTED', '官方 Antigravity 代理目前仅支持 Windows x64。');
        if (await this.#installed()) { this.#change({ status: 'ready', download: null, error: null }); return { entry: path.join(this.#directory, 'agy_acp_server.exe'), version: this.#release.version }; }
        let progressAt = 0;
        const progress = (receivedBytes, totalBytes, force = false) => {
          const value = { status: 'downloading', error: null, download: { receivedBytes, totalBytes } };
          Object.assign(this.#state, value);
          if (!force && Date.now() - progressAt < 100) return;
          progressAt = Date.now(); this.#change(value);
          if (typeof onProgress === 'function') { try { onProgress({ receivedBytes, totalBytes }); } catch {} }
        };
        phase = 'download'; timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#downloadTimeoutMs);
        const archive = await this.#download(controller.signal, progress);
        check(controller.signal);
        if (hash(archive) !== this.#release.sha256) throw fail('AGY_INTEGRITY_FAILED', '官方代理文件校验失败，未安装或运行。');
        const files = await unpackAntigravityArchive(archive, this.#release, controller.signal); phase = 'storage';
        await this.#directorySafe(this.#root); staging = path.join(this.#root, `.install-${randomUUID()}`); await this.#directorySafe(staging);
        for (const [name, bytes] of files) { check(controller.signal); await fs.writeFile(path.join(staging, name), bytes, { flag: 'wx', mode: 0o600 }); }
        check(controller.signal);
        if (await fs.lstat(this.#directory).catch(() => null)) await this.#remove(this.#directory);
        await fs.rename(staging, this.#directory); staging = null;
        this.#change({ status: 'ready', download: null, error: null });
        return { entry: path.join(this.#directory, 'agy_acp_server.exe'), version: this.#release.version };
      } catch (error) {
        const safe = signal?.aborted ? cancelled() : timedOut ? fail('AGY_DOWNLOAD_TIMEOUT', '官方代理下载超时，请检查代理速度和网络后重试。')
          : controller.signal.aborted ? cancelled() : error?.name === 'AntigravityError' ? error : phase === 'download'
          ? fail('AGY_DOWNLOAD_FAILED', '官方代理下载未完成，请检查网络后重试。') : fail('AGY_STORAGE_ERROR', '官方代理无法保存或读取，请检查软件数据目录。');
        this.#change({ status: safe.name === 'AbortError' ? 'missing' : 'error', download: null,
          error: safe.name === 'AbortError' ? null : { code: safe.code, message: safe.message } }); throw safe;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (staging) await this.#remove(staging).catch(() => {}); this.#pending = null; this.#controller = null; }
    })();
    return this.#pending;
  }
  cancel() { this.#controller?.abort(); }
  async dispose() { this.cancel(); await this.#pending?.catch(() => {}); }
}
