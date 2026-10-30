const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const RELEASE_API = 'https://api.github.com/repos/xinghan1/Cortex/releases/latest';
const RELEASE_WEB = 'https://github.com/xinghan1/Cortex/releases/latest';
const RELEASE_TAG_PREFIX = 'https://github.com/xinghan1/Cortex/releases/tag/';
const DOWNLOAD_PREFIX = 'https://github.com/xinghan1/Cortex/releases/download/';
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 2 * 1024 * 1024, MAX_CHECKSUM_BYTES = 8192;
const CHECK_CACHE_MS = 60 * 1000, RATE_LIMIT_DEFAULT_MS = 5 * 60 * 1000, RATE_LIMIT_MAX_MS = 60 * 60 * 1000;
const failure = (message, code = 'UPDATE_FAILED') => Object.assign(new Error(message), { code, updaterSafe: true });
function networkFailure(error) {
  // Classify only known error identifiers; never expose signed CDN URLs,
  // proxy credentials, local paths or arbitrary transport messages.
  const parts = [];
  for (let value = error, depth = 0; value && depth < 4; value = value.cause, depth++) {
    if (typeof value.code === 'string') parts.push(value.code);
    if (typeof value.message === 'string') parts.push(value.message);
  }
  const detail = parts.join(' ');
  if (/UPDATE_BUFFER_LIMIT/u.test(detail))
    return failure('更新下载缓冲区已满，请稍后重试。', 'UPDATE_BUFFER_LIMIT');
  if (/UPDATE_INVALID_REDIRECT/u.test(detail))
    return failure('更新下载跳转无效，请重新检查更新后重试。', 'UPDATE_INVALID_REDIRECT');
  if (/ERR_(?:PROXY|TUNNEL|NO_SUPPORTED_PROXIES|MANDATORY_PROXY|PAC_SCRIPT)/u.test(detail))
    return failure('无法连接更新代理，请确认代理已运行并已启用系统代理，然后重试。', 'UPDATE_PROXY');
  if (/ERR_(?:CERT_|SSL_|TLS_)|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT|DEPTH_ZERO_SELF_SIGNED_CERT/u.test(detail))
    return failure('更新服务器的安全证书验证失败，请检查系统时间及代理的 HTTPS 设置后重试。', 'UPDATE_TLS');
  if (/ERR_(?:NAME_NOT_RESOLVED|DNS_)|ENOTFOUND|EAI_AGAIN/u.test(detail))
    return failure('无法解析更新服务器地址，请检查网络、DNS 或系统代理后重试。', 'UPDATE_DNS');
  if (/ERR_(?:CONNECTION_TIMED_OUT|TIMED_OUT)|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/u.test(detail))
    return failure('连接更新服务器超时，请检查网络或系统代理后重试。', 'UPDATE_NETWORK_TIMEOUT');
  if (/ERR_(?:CONNECTION_RESET|CONNECTION_CLOSED|NETWORK_CHANGED|INCOMPLETE_CHUNKED_ENCODING|CONTENT_LENGTH_MISMATCH)|ECONNRESET|UND_ERR_SOCKET/u.test(detail))
    return failure('更新下载连接已中断，请检查网络或系统代理后重试。', 'UPDATE_CONNECTION_LOST');
  return failure('无法连接更新服务器，请检查网络及系统代理后重试。', 'UPDATE_NETWORK');
}
function localFailure(error) {
  if (['ENOSPC', 'EDQUOT'].includes(error?.code)) return failure('更新缓存所在磁盘空间不足，请释放空间后重试。', 'UPDATE_STORAGE_FULL');
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return failure('无法写入更新缓存，请检查目录权限或文件是否被占用后重试。', 'UPDATE_STORAGE_ACCESS');
  if (['ENOENT', 'ENOTDIR', 'EISDIR', 'EEXIST'].includes(error?.code)) return failure('更新缓存目录不可用，请检查磁盘和目录后重试。', 'UPDATE_STORAGE_PATH');
  if (['EIO', 'EBUSY', 'EMFILE', 'ENFILE'].includes(error?.code)) return failure('更新缓存读写失败，请检查磁盘状态或文件占用后重试。', 'UPDATE_STORAGE_IO');
  return failure('无法处理更新文件，请重试。', 'UPDATE_FAILED');
}
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
function parseChecksum(text, name) {
  const match = /^([a-f\d]{64})(?:[ \t]+\*?([^\r\n]+))?$/iu.exec(text.trim());
  if (!match || match[2] !== undefined && match[2] !== name) throw failure('SHA-256 校验文件与安装包不匹配。');
  return match[1].toLowerCase();
}
function rateLimitDelay(headers, now) {
  const retry = headers.get('retry-after'), reset = headers.get('x-ratelimit-reset');
  const delays = [];
  if (retry !== null) {
    const delay = /^\d+$/u.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - now;
    if (Number.isFinite(delay) && delay >= 0) delays.push(delay);
  }
  if (reset !== null && /^\d+$/u.test(reset)) {
    const delay = Number(reset) * 1000 - now;
    if (Number.isFinite(delay) && delay >= 0) delays.push(delay);
  }
  return Math.max(CHECK_CACHE_MS, Math.min(RATE_LIMIT_MAX_MS, delays.length ? Math.max(...delays) : RATE_LIMIT_DEFAULT_MS));
}

class AppUpdater {
  #current; #dataDir; #dir; #enabled; #fetch; #onChange; #timeout; #now; #checkCacheMs;
  #checkCachedUntil = 0; #apiRetryAt = 0; #checkRetryAt = 0; #checkError = null;
  #state = { version: null, status: 'idle', progress: 0, downloadedBytes: 0, totalBytes: null, error: null };
  #release = null; #ready = null; #pending = null; #controller = null; #disposed = false;
  constructor({ currentVersion, dataDir, enabled = false, fetchImpl = globalThis.fetch, onChange = () => {}, timeoutMs,
    now = Date.now, checkCacheMs = CHECK_CACHE_MS } = {}) {
    this.#current = version(currentVersion);
    if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0') || typeof fetchImpl !== 'function'
      || typeof onChange !== 'function' || typeof now !== 'function' || !Number.isSafeInteger(checkCacheMs) || checkCacheMs < 0
      || timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1))
      throw failure('自动更新配置无效。');
    this.#dataDir = path.resolve(dataDir); this.#dir = path.join(this.#dataDir, 'updates');
    this.#enabled = enabled === true; this.#fetch = fetchImpl; this.#onChange = onChange; this.#timeout = timeoutMs;
    this.#now = now; this.#checkCacheMs = checkCacheMs;
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
        ? controller.signal.reason : localFailure(error);
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
  async #request(url, signal, { asset = false, method = 'GET', web = false } = {}) {
    signal.throwIfAborted();
    let response;
    try {
      response = await abortable(this.#fetch(url, { signal, method, redirect: 'manual', credentials: 'omit',
        headers: { Accept: web ? 'text/html' : asset ? 'application/octet-stream' : 'application/vnd.github+json',
          'User-Agent': 'Cortex-updater', ...(asset || web ? {} : { 'X-GitHub-Api-Version': '2022-11-28' }) } }), signal);
    } catch (error) {
      if (signal.aborted || error?.updaterSafe) throw error;
      throw networkFailure(error);
    }
    if (response.redirected || response.url && response.url !== url) {
      response.body?.cancel?.().catch(() => {});
      throw failure('更新请求出现了未经允许的重定向。');
    }
    return response;
  }
  async #httpFailure(response, signal, api = false) {
    let limited = response.status === 429;
    if (api && response.status === 403) {
      const retry = response.headers.get('retry-after');
      limited = response.headers.get('x-ratelimit-remaining') === '0'
        || retry !== null && (/^\d+$/u.test(retry) || Number.isFinite(Date.parse(retry)));
      if (!limited) {
        try {
          const body = JSON.parse(await this.#text(response, MAX_CHECKSUM_BYTES, signal));
          limited = typeof body?.message === 'string' && /^(?:API rate limit exceeded\b|You have exceeded a secondary rate limit\b)/iu.test(body.message);
        } catch (error) { if (signal.aborted) throw error; }
      }
    }
    response.body?.cancel?.().catch(() => {});
    if (limited) {
      if (api) this.#apiRetryAt = this.#now() + rateLimitDelay(response.headers, this.#now());
      throw Object.assign(failure('更新服务暂时限流，请稍后重试。', 'UPDATE_RATE_LIMIT'), { apiRateLimited: api });
    }
    if (response.status === 407) throw failure('更新代理需要身份验证，请完成代理登录后重试。', 'UPDATE_PROXY_AUTH');
    if (response.status === 403) throw failure('更新服务器拒绝访问，请检查网络或代理设置后重试。', 'UPDATE_ACCESS_DENIED');
    throw failure(response.status === 404 ? '官方仓库暂未提供可下载的发布版本。' : '更新服务器暂时不可用，请稍后重试。');
  }
  async #response(url, signal, { asset = false, method = 'GET', allow404 = false } = {}) {
    let current = url;
    for (let hop = 0; hop <= 2; hop++) {
      const response = await this.#request(current, signal, { asset, method });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        response.body?.cancel?.().catch(() => {});
        if (!asset || hop >= 2 || !trustedCDN(location)) throw failure('更新下载被重定向到非官方地址。');
        current = location;
        continue;
      }
      if (response.status !== 200 && !(allow404 && response.status === 404)) {
        await this.#httpFailure(response, signal, current === RELEASE_API);
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
        let chunk;
        try { chunk = await abortable(reader.read(), signal); }
        catch (error) {
          if (signal.aborted || error?.updaterSafe) throw error;
          throw networkFailure(error);
        }
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
  async #apiRelease(signal) {
      const response = await this.#response(RELEASE_API, signal);
      let release;
      try { release = JSON.parse(await this.#text(response, MAX_METADATA_BYTES, signal)); }
      catch (error) { if (error?.updaterSafe || signal.aborted) throw error; throw failure('官方发布信息格式无效。'); }
      if (!release || release.draft !== false || release.prerelease !== false) throw failure('仅支持官方稳定发布版本。');
      const nextVersion = version(release.tag_name);
      if (compare(nextVersion, this.#current) <= 0) {
        return null;
      }
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const names = [`Cortex-Setup-${nextVersion}-x64.exe`, `Synora-code-Setup-${nextVersion}-x64.exe`];
      const name = names.find(candidate => assets.some(value => value?.name === candidate));
      const matches = name ? assets.filter(value => value?.name === name) : [];
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
        sha256 = parseChecksum(await this.#text(checksumResponse, MAX_CHECKSUM_BYTES, signal, checksumSize), name);
      }
      return { version: nextVersion, name, size, url, sha256 };
  }
  async #webRelease(signal) {
    const latest = await this.#request(RELEASE_WEB, signal, { web: true });
    latest.body?.cancel?.().catch(() => {});
    if (![301, 302, 303, 307, 308].includes(latest.status)) {
      if (latest.status !== 200) await this.#httpFailure(latest, signal);
      throw failure('官方最新版本地址无效，请稍后重试。');
    }
    const location = latest.headers.get('location');
    if (!location?.startsWith(RELEASE_TAG_PREFIX)) throw failure('官方最新版本地址不属于指定仓库。');
    const tag = location.slice(RELEASE_TAG_PREFIX.length), nextVersion = version(tag);
    if (compare(nextVersion, this.#current) <= 0) return null;
    let name = `Cortex-Setup-${nextVersion}-x64.exe`, url = `${DOWNLOAD_PREFIX}${tag}/${name}`;
    let checksumResponse = await this.#response(`${url}.sha256`, signal, { asset: true, allow404: true });
    if (checksumResponse.status === 404) {
      checksumResponse.body?.cancel?.().catch(() => {});
      name = `Synora-code-Setup-${nextVersion}-x64.exe`; url = `${DOWNLOAD_PREFIX}${tag}/${name}`;
      checksumResponse = await this.#response(`${url}.sha256`, signal, { asset: true });
    }
    const sha256 = parseChecksum(await this.#text(checksumResponse, MAX_CHECKSUM_BYTES, signal), name);
    const head = await this.#response(url, signal, { asset: true, method: 'HEAD' });
    head.body?.cancel?.().catch(() => {});
    const length = head.headers.get('content-length');
    if (length === null || !/^\d+$/u.test(length)) throw failure('官方安装包未提供有效文件大小，请稍后重试。');
    const size = assetSize({ state: 'uploaded', size: Number(length) }, 64, MAX_INSTALLER_BYTES);
    return { version: nextVersion, name, size, url, sha256 };
  }
  check() {
    try { this.#requireEnabled(); } catch (error) { return Promise.reject(error); }
    if (this.#pending) return this.#pending.promise;
    if (this.#ready && this.#state.status === 'downloaded') return Promise.resolve(this.snapshot());
    if (['current', 'available'].includes(this.#state.status) && this.#now() < this.#checkCachedUntil) return Promise.resolve(this.snapshot());
    if (this.#checkError && this.#now() < this.#checkRetryAt) return Promise.reject(this.#checkError);
    this.#publish({ status: 'checking', progress: 0, downloadedBytes: 0, totalBytes: null, error: null });
    return this.#operation('check', async signal => {
      let release, fallback = this.#now() < this.#apiRetryAt;
      try {
        if (!fallback) {
          try { release = await this.#apiRelease(signal); }
          catch (error) { if (!error?.apiRateLimited) throw error; fallback = true; }
        }
        if (fallback) release = await this.#webRelease(signal);
      } catch (error) {
        if (fallback && error?.updaterSafe && !signal.aborted) {
          this.#checkError = error; this.#checkRetryAt = this.#now() + CHECK_CACHE_MS;
        }
        throw error;
      }
      this.#checkError = null; this.#checkRetryAt = 0; this.#checkCachedUntil = this.#now() + this.#checkCacheMs;
      this.#release = release; this.#ready = null;
      return this.#publish({ version: release?.version ?? null, status: release ? 'available' : 'current', progress: 0,
        downloadedBytes: 0, totalBytes: release?.size ?? null, error: null });
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
    this.#publish({ status: 'downloading', progress: 0, downloadedBytes: 0, totalBytes: release.size, error: null });
    return this.#operation('download', async signal => {
      const directory = await this.#cacheDirectory(), destination = path.join(directory, release.name);
      // Cache contents are never trusted merely because the filename exists.
      try {
        await this.#verify(destination, release, signal);
        this.#ready = { file: destination, release };
        return this.#publish({ status: 'downloaded', progress: 100, downloadedBytes: release.size, totalBytes: release.size, error: null });
      } catch { signal.throwIfAborted(); }
      const temporary = path.join(directory, `.download-${randomUUID()}.part`);
      let handle;
      try {
        const response = await this.#response(release.url, signal, { asset: true });
        handle = await fs.open(temporary, 'wx', 0o600);
        const hash = createHash('sha256'); let first = Buffer.alloc(0), lastBytePublish = 0;
        await this.#read(response, MAX_INSTALLER_BYTES, signal, async (chunk, bytes) => {
          if (first.length < 2) first = Buffer.concat([first, chunk]).subarray(0, 2);
          hash.update(chunk); await handle.writeFile(chunk);
          // Keep the exact count even when this chunk is below the UI event
          // throttle; a later error must report every successfully stored byte.
          this.#state.downloadedBytes = bytes;
          const progress = Math.min(99, Math.floor(bytes / release.size * 100));
          const now = Date.now();
          if (progress !== this.#state.progress || bytes === release.size || now - lastBytePublish >= 100) {
            lastBytePublish = now; this.#publish({ progress, downloadedBytes: bytes, totalBytes: release.size });
          }
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
        return this.#publish({ status: 'downloaded', progress: 100, downloadedBytes: release.size, totalBytes: release.size, error: null });
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
      this.#publish({ status: 'error', progress: 0, downloadedBytes: 0, totalBytes: ready.release.size, error: error.message });
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
