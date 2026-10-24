import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Original Moonshot distribution, downloaded on demand rather than bundled.
// SHA-256: https://code.kimi.com/kimi-code/binaries/2.3.1/manifest.json
export const KIMI_RELEASE = Object.freeze({ version: '2.3.1',
  url: 'https://code.kimi.com/kimi-code/binaries/2.3.1/kimi-code-win32-x64.exe',
  sha256: '93878ac2bd12a8cf21b4e148e7f7705a7a6252c1398fd34eb50f8998ba0bf795' });
const MAX_BYTES = 256 * 1024 * 1024;
const fail = (code, message) => Object.assign(new Error(`[${code}] ${message}`), { name: 'KimiError', code });
const cancelled = () => Object.assign(fail('KIMI_CANCELLED', 'Kimi 操作已取消。'), { name: 'AbortError' });
function check(signal) { if (signal?.aborted) throw cancelled(); }
function wait(operation, signal) {
  check(signal);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => { if (done) return; done = true; signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => finish(cancelled()); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    Promise.resolve().then(operation).then(value => finish(null, value), error => finish(error));
  });
}
function validRelease(release) {
  return release && /^\d+\.\d+\.\d+$/u.test(release.version) && /^[a-f\d]{64}$/u.test(release.sha256)
    && release.url === `https://code.kimi.com/kimi-code/binaries/${release.version}/kimi-code-win32-x64.exe`;
}
function allowedUrl(value, release) {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && ['code.kimi.com', 'cdn.kimi.com'].includes(url.hostname)
    && url.pathname === `/kimi-code/binaries/${release.version}/kimi-code-win32-x64.exe` && !url.search && !url.hash; }
  catch { return false; }
}
async function fileHash(filename) { const digest = createHash('sha256'); for await (const bytes of createReadStream(filename)) digest.update(bytes); return digest.digest('hex'); }

export class KimiRuntime {
  #root; #directory; #release; #fetch; #onChange; #platform; #arch; #pending = null; #controller = null; #state; #initialized = false;
  constructor({ dataDir, fetchImpl = globalThis.fetch, onChange = () => {}, platform = process.platform, arch = process.arch, release = KIMI_RELEASE } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof fetchImpl !== 'function' || typeof onChange !== 'function' || !validRelease(release))
      throw fail('KIMI_INVALID_INPUT', 'Kimi 安装配置无效。');
    this.#root = path.join(path.resolve(dataDir), 'kimi-runtime'); this.#release = structuredClone(release);
    this.#directory = path.join(this.#root, `${release.version}-win32-x64`); this.#fetch = fetchImpl; this.#onChange = onChange;
    this.#platform = platform; this.#arch = arch; this.#state = { status: 'missing', version: release.version, download: null, error: null };
  }
  #change(value) { Object.assign(this.#state, value); try { Promise.resolve(this.#onChange()).catch(() => {}); } catch {} }
  async #mkdir(directory) { await fs.mkdir(directory, { recursive: true }); const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('KIMI_STORAGE_ERROR', 'Kimi 安装目录不可用。'); }
  async #installed() {
    try {
      for (const directory of [this.#root, this.#directory]) { const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) return false; }
      const filename = path.join(this.#directory, 'kimi.exe'), stat = await fs.lstat(filename);
      return stat.isFile() && !stat.isSymbolicLink() && stat.size > 2 && stat.size <= MAX_BYTES && await fileHash(filename) === this.#release.sha256;
    } catch { return false; }
  }
  async init() { if (!this.#initialized) { this.#initialized = true; if (await this.#installed()) this.#change({ status: 'ready', error: null }); } return this; }
  async publicState() { await this.init(); return structuredClone(this.#state); }
  async #remove(directory) {
    const root = await fs.lstat(this.#root); if (!root.isDirectory() || root.isSymbolicLink()) throw fail('KIMI_STORAGE_ERROR', 'Kimi 安装目录无法安全清理。');
    const parent = await fs.realpath(this.#root), stat = await fs.lstat(directory).catch(() => null); if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(await fs.realpath(directory)).toLowerCase() !== parent.toLowerCase()) throw fail('KIMI_STORAGE_ERROR', 'Kimi 安装目录无法安全清理。');
    await fs.rm(directory, { recursive: true, force: true });
  }
  ensure({ signal, onProgress } = {}) {
    if (this.#pending) return wait(() => this.#pending, signal);
    const controller = new AbortController(), abort = () => controller.abort(); this.#controller = controller;
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    this.#pending = (async () => {
      let staging, file, reader, timer, phase = 'storage', timedOut = false;
      try {
        await this.init(); check(controller.signal);
        if (this.#platform !== 'win32' || this.#arch !== 'x64') throw fail('KIMI_RUNTIME_UNSUPPORTED', '官方 Kimi 代理目前支持 Windows x64。');
        if (await this.#installed()) { this.#change({ status: 'ready', download: null, error: null }); return { entry: path.join(this.#directory, 'kimi.exe'), version: this.#release.version }; }
        await this.#mkdir(this.#root); staging = path.join(this.#root, `.install-${randomUUID()}`); await this.#mkdir(staging);
        file = await fs.open(path.join(staging, 'kimi.exe'), 'wx', 0o600);
        const progress = (receivedBytes, totalBytes) => { this.#change({ status: 'downloading', error: null, download: { receivedBytes, totalBytes } }); try { onProgress?.({ receivedBytes, totalBytes }); } catch {} };
        phase = 'download'; progress(0, null); timer = setTimeout(() => { timedOut = true; controller.abort(); }, 300000);
        let response, url = this.#release.url;
        for (let redirect = 0; redirect <= 3; redirect++) {
          response = await wait(async () => {
            const result = await this.#fetch(url, { signal: controller.signal, redirect: 'manual' });
            if (controller.signal.aborted) { void result.body?.cancel?.().catch(() => {}); throw cancelled(); }
            return result;
          }, controller.signal);
          if (![301, 302, 303, 307, 308].includes(response?.status)) break;
          const location = response.headers?.get?.('location'); await response.body?.cancel?.().catch(() => {});
          let next; try { next = new URL(location, url).href; } catch { /* validated below */ }
          if (redirect === 3 || !location || !allowedUrl(next, this.#release)) throw fail('KIMI_DOWNLOAD_FAILED', '官方 Kimi 下载跳转无效。');
          url = next;
        }
        const sizeHeader = response?.headers?.get?.('content-length'), total = sizeHeader && /^\d+$/u.test(sizeHeader) ? Number(sizeHeader) : null;
        if (!response?.ok || !response.body || total !== null && (!Number.isSafeInteger(total) || total <= 2 || total > MAX_BYTES)) throw fail('KIMI_DOWNLOAD_FAILED', '官方 Kimi 下载响应无效。');
        reader = response.body.getReader(); const digest = createHash('sha256'); let received = 0, magic = Buffer.alloc(0);
        while (true) {
          const item = await wait(() => reader.read(), controller.signal); if (item.done) break;
          const bytes = Buffer.from(item.value); received += bytes.length;
          if (received > MAX_BYTES || total !== null && received > total) throw fail('KIMI_DOWNLOAD_FAILED', '官方 Kimi 文件大小异常。');
          if (magic.length < 2) magic = Buffer.concat([magic, bytes]).subarray(0, 2);
          digest.update(bytes); await file.writeFile(bytes); progress(received, total);
        }
        check(controller.signal);
        if (received <= 2 || total !== null && received !== total) throw fail('KIMI_DOWNLOAD_FAILED', '官方 Kimi 下载不完整。');
        if (magic.toString('ascii') !== 'MZ' || digest.digest('hex') !== this.#release.sha256) throw fail('KIMI_INTEGRITY_FAILED', '官方 Kimi 文件校验失败，未安装或运行。');
        clearTimeout(timer); await file.sync(); await file.close(); file = null; phase = 'storage'; check(controller.signal);
        if (await fs.lstat(this.#directory).catch(() => null)) await this.#remove(this.#directory);
        await fs.rename(staging, this.#directory); staging = null;
        this.#change({ status: 'ready', download: null, error: null }); return { entry: path.join(this.#directory, 'kimi.exe'), version: this.#release.version };
      } catch (error) {
        const safe = timedOut ? fail('KIMI_DOWNLOAD_FAILED', '官方 Kimi 下载超时，请检查网络后重试。') : controller.signal.aborted ? cancelled() : error?.name === 'KimiError' ? error
          : phase === 'download' ? fail('KIMI_DOWNLOAD_FAILED', '下载官方 Kimi 失败，请检查代理和网络。') : fail('KIMI_STORAGE_ERROR', '无法保存或读取 Kimi 安装文件。');
        this.#change({ status: safe.name === 'AbortError' ? 'missing' : 'error', download: null, error: safe.name === 'AbortError' ? null : { code: safe.code, message: safe.message } }); throw safe;
      } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch {} }
        await file?.close().catch(() => {}); if (staging) await this.#remove(staging).catch(() => {}); this.#pending = null; this.#controller = null;
      }
    })();
    return this.#pending;
  }
  cancel() { this.#controller?.abort(); }
  async dispose() { this.cancel(); await this.#pending?.catch(() => {}); }
}
