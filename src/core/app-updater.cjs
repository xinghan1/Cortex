const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const RELEASE_API = 'https://api.github.com/repos/xinghan1/Synora-code/releases/latest';
const DOWNLOAD_PREFIX = 'https://github.com/xinghan1/Synora-code/releases/download/';
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024, MAX_CHECKSUM_BYTES = 8192;
const failure = (message, code = 'UPDATE_FAILED') => Object.assign(new Error(message), { code, updaterSafe: true });
function version(value) {
  if (typeof value !== 'string' || !/^v?(?:0|[1-9]\d{0,6})\.(?:0|[1-9]\d{0,6})\.(?:0|[1-9]\d{0,6})$/u.test(value)) throw failure('更新版本信息无效。');
  return value.replace(/^v/u, '');
}
function compare(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason);
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}
function trustedCDN(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
      && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)
      && /^\/github-production-release-asset(?:-[^/]+)?\/.+/u.test(url.pathname);
  } catch { return false; }
}
function assetURL(asset, tag, name) {
  const expected = `${DOWNLOAD_PREFIX}${tag}/${name}`;
  if (asset?.browser_download_url !== expected) throw failure('更新文件下载地址不属于官方仓库。');
  return expected;
}
function assetSize(asset, minimum, maximum) {
  if (asset?.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size < minimum || asset.size > maximum)
    throw failure('更新文件大小或上传状态无效。');
  return asset.size;
}

class AppUpdater {
  #current; #dataDir; #dir; #enabled; #fetch; #onChange; #timeout;
  #state = { version: null, status: 'idle', progress: 0, error: null };
  #release = null; #ready = null; #pending = null; #controller = null; #disposed = false;
  constructor({ currentVersion, dataDir, enabled = false, fetchImpl = globalThis.fetch, onChange = () => {}, timeoutMs } = {}) {
    this.#current = version(currentVersion);
    if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0') || typeof fetchImpl !== 'function'
      || typeof onChange !== 'function' || timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1))
      throw failure('自动更新配置无效。');
    this.#dataDir = path.resolve(dataDir); this.#dir = path.join(this.#dataDir, 'updates');
    this.#enabled = enabled === true; this.#fetch = fetchImpl; this.#onChange = onChange; this.#timeout = timeoutMs;
  }
  snapshot() { return { ...this.#state }; }
  #publish(patch) {
    this.#state = { ...this.#state, ...patch };
    if (!this.#disposed) { try { this.#onChange(this.snapshot()); } catch { /* UI observers cannot interrupt a download. */ } }
    return this.snapshot();
  }
  #requireEnabled() {
    if (this.#disposed) throw failure('更新服务已关闭。', 'UPDATE_DISPOSED');
    if (!this.#enabled) throw failure('当前版本不支持程序内安装更新。', 'UPDATE_UNSUPPORTED');
  }
  #operation(kind, work) {
    const controller = new AbortController(); this.#controller = controller;
    const timer = setTimeout(() => controller.abort(failure('检查或下载更新超时，请重试。', 'UPDATE_TIMEOUT')),
      this.#timeout ?? (kind === 'check' ? 30000 : 10 * 60 * 1000));
    const operation = Promise.resolve().then(() => work(controller.signal)).catch(error => {
      const safe = error?.updaterSafe ? error : controller.signal.aborted && controller.signal.reason?.updaterSafe
        ? controller.signal.reason : failure('无法完成更新，请检查网络后重试。');
      if (!controller.signal.aborted) controller.abort(safe);
      if (kind === 'download') this.#ready = null;
      this.#publish({ status: 'error', error: safe.message });
      throw safe;
    }).finally(() => {
      clearTimeout(timer);
      if (this.#pending?.promise === operation) this.#pending = null;
      if (this.#controller === controller) this.#controller = null;
    });
    this.#pending = { kind, promise: operation };
    return operation;
  }
  async #response(url, signal, { asset = false } = {}) {
    let current = url;
    for (let hop = 0; hop <= 2; hop++) {
      const response = await abortable(this.#fetch(current, { signal, redirect: 'manual', credentials: 'omit',
        headers: { Accept: asset ? 'application/octet-stream' : 'application/vnd.github+json',
          'User-Agent': 'Synora-code-updater', ...(asset ? {} : { 'X-GitHub-Api-Version': '2022-11-28' }) } }), signal);
      if (response.redirected || response.url && response.url !== current) {
        response.body?.cancel?.().catch(() => {});
        throw failure('更新请求出现了未经允许的重定向。');
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        response.body?.cancel?.().catch(() => {});
        if (!asset || hop >= 2 || !trustedCDN(location)) throw failure('更新下载被重定向到非官方地址。');
        current = location;
        continue;
      }
      if (response.status !== 200) {
        response.body?.cancel?.().catch(() => {});
        throw failure(response.status === 404 ? '官方仓库暂未提供可下载的发布版本。'
          : response.status === 403 || response.status === 429 ? '更新服务暂时限流，请稍后重试。' : '更新服务器暂时不可用，请稍后重试。');
      }
      return response;
    }
    throw failure('更新下载重定向次数过多。');
  }
  async #read(response, maximum, signal, onChunk, expected) {
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > maximum
      || expected !== undefined && Number(length) !== expected)) throw failure('更新下载的文件大小与发布信息不符。');
    if (!response.body || typeof response.body.getReader !== 'function') throw failure('更新服务器未返回有效文件。');
    const reader = response.body.getReader();
    let bytes = 0, complete = false;
    try {
      for (;;) {
        const chunk = await abortable(reader.read(), signal);
        if (chunk.done) break;
        const data = Buffer.from(chunk.value);
        bytes += data.length;
        if (bytes > maximum || expected !== undefined && bytes > expected) throw failure('更新文件超过允许大小。');
        await onChunk(data, bytes);
      }
      if (expected !== undefined && bytes !== expected) throw failure('更新文件下载不完整，请重新下载。');
      signal.throwIfAborted(); complete = true;
      return bytes;
    } finally {
      if (!complete) reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async #text(response, maximum, signal, expected) {
    const chunks = [];
    await this.#read(response, maximum, signal, chunk => { chunks.push(chunk); }, expected);
    return Buffer.concat(chunks).toString('utf8');
  }
  check() {
    try { this.#requireEnabled(); } catch (error) { return Promise.reject(error); }
    if (this.#pending) return this.#pending.promise;
    if (this.#ready && this.#state.status === 'downloaded') return Promise.resolve(this.snapshot());
    this.#publish({ status: 'checking', error: null });
    return this.#operation('check', async signal => {
      const response = await this.#response(RELEASE_API, signal);
      let release;
      try { release = JSON.parse(await this.#text(response, MAX_METADATA_BYTES, signal)); }
      catch (error) { if (error?.updaterSafe || signal.aborted) throw error; throw failure('官方发布信息格式无效。'); }
      if (!release || release.draft !== false || release.prerelease !== false) throw failure('仅支持官方稳定发布版本。');
      const nextVersion = version(release.tag_name);
      if (compare(nextVersion, this.#current) <= 0) {
        this.#release = null; this.#ready = null;
        return this.#publish({ version: null, status: 'current', progress: 0, error: null });
      }
      const name = `Synora-code-Setup-${nextVersion}-x64.exe`;
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const matches = assets.filter(value => value?.name === name);
      if (matches.length !== 1) throw failure('此版本缺少匹配的 Windows x64 安装包。');
      const asset = matches[0], size = assetSize(asset, 64, MAX_INSTALLER_BYTES), url = assetURL(asset, release.tag_name, name);
      let sha256;
      if (asset.digest !== undefined && asset.digest !== null && asset.digest !== '') {
        if (typeof asset.digest !== 'string' || !/^sha256:[a-f\d]{64}$/iu.test(asset.digest)) throw failure('安装包的 SHA-256 校验信息无效。');
        sha256 = asset.digest.slice(7).toLowerCase();
      } else {
        const checksumName = `${name}.sha256`, checksums = assets.filter(value => value?.name === checksumName);
        if (checksums.length !== 1) throw failure('此版本缺少 SHA-256 校验文件，暂不能更新。');
        const checksum = checksums[0], checksumSize = assetSize(checksum, 64, MAX_CHECKSUM_BYTES);
        const checksumResponse = await this.#response(assetURL(checksum, release.tag_name, checksumName), signal, { asset: true });
        const text = (await this.#text(checksumResponse, MAX_CHECKSUM_BYTES, signal, checksumSize)).trim();
        const match = /^([a-f\d]{64})(?:[ \t]+\*?([^\r\n]+))?$/iu.exec(text);
        if (!match || match[2] !== undefined && match[2] !== name) throw failure('SHA-256 校验文件与安装包不匹配。');
        sha256 = match[1].toLowerCase();
      }
      this.#release = { version: nextVersion, name, size, url, sha256 }; this.#ready = null;
      return this.#publish({ version: nextVersion, status: 'available', progress: 0, error: null });
    });
  }
  async #cacheDirectory() {
    await fs.mkdir(this.#dataDir, { recursive: true });
    if ((await fs.lstat(this.#dataDir)).isSymbolicLink()) throw failure('更新缓存目录无效。');
    await fs.mkdir(this.#dir, { recursive: true });
    const stat = await fs.lstat(this.#dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('更新缓存目录无效。');
    const canonical = await fs.realpath(this.#dir), parent = await fs.realpath(this.#dataDir);
    if (path.relative(parent, canonical) !== 'updates') throw failure('更新缓存目录超出程序数据目录。');
    return canonical;
  }
  async #verify(file, release, signal) {
    const directory = await this.#cacheDirectory();
    if (path.dirname(file) !== directory || path.basename(file) !== release.name) throw failure('更新安装包路径无效。');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== release.size) throw failure('更新安装包已变化，请重新下载。');
    const handle = await fs.open(file, 'r');
    const hash = createHash('sha256'), chunk = Buffer.alloc(256 * 1024);
    let total = 0;
    try {
      const opened = await handle.stat();
      // Windows path-based stats can report dev=0 while handle-based stats
      // expose the volume serial. Compare volume IDs only when both exist.
      if (!opened.isFile() || opened.size !== release.size || opened.ino !== stat.ino
        || opened.dev && stat.dev && opened.dev !== stat.dev) throw failure('更新安装包已变化，请重新下载。');
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        if (total === 0 && (chunk[0] !== 77 || chunk[1] !== 90)) throw failure('下载文件不是有效的 Windows 安装包。');
        total += bytesRead;
        if (total > release.size) throw failure('更新安装包已变化，请重新下载。');
        hash.update(chunk.subarray(0, bytesRead));
      }
    } finally { await handle.close(); }
    if (total !== release.size || hash.digest('hex') !== release.sha256) throw failure('安装包 SHA-256 校验失败，请重新下载。');
    return file;
  }
  download() {
    try { this.#requireEnabled(); } catch (error) { return Promise.reject(error); }
    if (this.#pending?.kind === 'download') return this.#pending.promise;
    if (this.#pending) return this.#pending.promise.then(() => this.download());
    if (!this.#release) return Promise.reject(failure('请先检查并找到可用的新版本。'));
    if (this.#ready && this.#state.status === 'downloaded') return Promise.resolve(this.snapshot());
    const release = this.#release;
    this.#publish({ status: 'downloading', progress: 0, error: null });
    return this.#operation('download', async signal => {
      const directory = await this.#cacheDirectory(), destination = path.join(directory, release.name);
      // Cache contents are never trusted merely because the filename exists.
      try {
        await this.#verify(destination, release, signal);
        this.#ready = { file: destination, release };
        return this.#publish({ status: 'downloaded', progress: 100, error: null });
      } catch { signal.throwIfAborted(); }
      const temporary = path.join(directory, `.download-${randomUUID()}.part`);
      let handle;
      try {
        const response = await this.#response(release.url, signal, { asset: true });
        handle = await fs.open(temporary, 'wx', 0o600);
        const hash = createHash('sha256'); let first = Buffer.alloc(0);
        await this.#read(response, MAX_INSTALLER_BYTES, signal, async (chunk, bytes) => {
          if (first.length < 2) first = Buffer.concat([first, chunk]).subarray(0, 2);
          hash.update(chunk); await handle.writeFile(chunk);
          const progress = Math.min(99, Math.floor(bytes / release.size * 100));
          if (progress !== this.#state.progress) this.#publish({ progress });
        }, release.size);
        if (first[0] !== 77 || first[1] !== 90) throw failure('下载文件不是有效的 Windows 安装包。');
        if (hash.digest('hex') !== release.sha256) throw failure('安装包 SHA-256 校验失败，请重新下载。');
        await handle.sync(); await handle.close(); handle = null;
        signal.throwIfAborted();
        await this.#cacheDirectory();
        const existing = await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw failure('更新安装包路径无效。');
        await fs.rename(temporary, destination);
        await this.#verify(destination, release, signal);
        this.#ready = { file: destination, release };
        return this.#publish({ status: 'downloaded', progress: 100, error: null });
      } finally {
        await handle?.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
      }
    });
  }
  async verifiedInstaller() {
    this.#requireEnabled();
    if (!this.#ready || this.#state.status !== 'downloaded') throw failure('请先下载并校验更新安装包。');
    const ready = this.#ready;
    try { return await this.#verify(ready.file, ready.release); }
    catch {
      this.#ready = null;
      const error = failure('更新安装包已损坏或变化，请重新下载。');
      this.#publish({ status: 'error', progress: 0, error: error.message });
      throw error;
    }
  }
  async dispose() {
    this.#disposed = true;
    this.#controller?.abort(failure('更新已取消。', 'UPDATE_CANCELLED'));
    await this.#pending?.promise.catch(() => {});
  }
}

module.exports = { AppUpdater };
