import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

// Public account protocol, verified against DeepSeek's MIT-licensed Harness on
// 2026-10-24. This implementation identifies itself as Synora code and never
// reads another application's credentials or the browser's cookies.
// https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/credentials/deepseek-account-platform
export const DEEPSEEK_ACCOUNT_BASE = 'https://api.deepseek.com/anthropic/v1';
const PLATFORM = 'https://platform.deepseek.com';
const API = 'https://api.deepseek.com';
const FILE = 'deepseek-account.json';
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 500) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const error = (code, message) => Object.assign(new Error(message), { name: 'DeepSeekConnectionError', code });
const aborted = () => Object.assign(error('DEEPSEEK_CANCELLED', 'DeepSeek 登录已取消。'), { name: 'AbortError' });
const unavailable = () => error('DEEPSEEK_SIGN_IN_REQUIRED', '请先登录 DeepSeek 账号。');
const wireError = () => error('DEEPSEEK_INVALID_RESPONSE', 'DeepSeek 返回了无效的授权响应，请重试。');

function wait(operation, signal, onLateValue) {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (failure, value) => {
      if (done) { if (!failure) onLateValue?.(value); return; }
      done = true; signal?.removeEventListener('abort', cancel);
      if (failure) reject(failure); else resolve(value);
    };
    const cancel = () => finish(aborted());
    signal?.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => { if (signal?.aborted) throw aborted(); return operation(); })
      .then(value => finish(null, value), failure => finish(failure));
  });
}
function cancelBody(response) { try { Promise.resolve(response?.body?.cancel()).catch(() => {}); } catch {} }
async function json(response, signal, maxBytes) {
  if (!response.body) throw wireError();
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    for (;;) {
      const part = await wait(() => reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) throw wireError();
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw wireError(); }
  } finally { try { Promise.resolve(reader.cancel()).catch(() => {}); reader.releaseLock(); } catch {} }
}
function browserUrl(value, pathname) {
  let url; try { url = new URL(value); } catch { throw wireError(); }
  if (url.origin !== PLATFORM || url.pathname !== pathname || url.username || url.password || url.hash) throw wireError();
  return url.href;
}
function projectProfile(value) {
  if (!object(value)) return null;
  const name = value.id_profile?.name, contact = value.mobile || value.mobile_number || value.email;
  return { ...(text(name, 200) ? { name } : {}), ...(text(contact, 320) ? { contact } : {}) };
}
function validGrant(value) {
  return object(value) && value.issuer === PLATFORM && UUID.test(value.profileId)
    && typeof value.token === 'string' && /^[\x21-\x7e]{1,8192}$/u.test(value.token);
}

/** Main-process account owner. All public snapshots are credential-free. */
export class DeepSeekConnection {
  #file; #safeStorage; #openExternal; #onChange; #fetch; #version;
  #deviceId = randomUUID(); #grant = null; #attempt = null; #failure = null;
  #storageError = false; #initialized = false; #closed = false; #removing = null;
  #queue = Promise.resolve(); #knownSecrets = new Set(); #modelCache = null;
  #requestTimeout; #attemptTimeout;

  constructor({ dataDir, safeStorage, openExternal, onChange = () => {}, version = '0.0.0',
    fetchImpl = globalThis.fetch, requestTimeoutMs = 30_000, attemptTimeoutMs = 600_000 } = {}) {
    if (!path.isAbsolute(dataDir || '') || typeof fetchImpl !== 'function' || typeof onChange !== 'function'
        || !text(version, 80) || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 120_000
        || !Number.isInteger(attemptTimeoutMs) || attemptTimeoutMs < 1 || attemptTimeoutMs > 3_600_000)
      throw error('DEEPSEEK_INVALID_CONFIG', 'DeepSeek 账号配置无效。');
    this.#file = path.join(dataDir, FILE); this.#safeStorage = safeStorage;
    this.#openExternal = openExternal; this.#onChange = onChange; this.#fetch = fetchImpl; this.#version = version;
    this.#requestTimeout = requestTimeoutMs; this.#attemptTimeout = attemptTimeoutMs;
  }

  #encryption() {
    try { return this.#safeStorage?.isEncryptionAvailable() === true
      && typeof this.#safeStorage.encryptString === 'function' && typeof this.#safeStorage.decryptString === 'function'
      && this.#safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; } catch { return false; }
  }
  #requireEncryption() {
    if (!this.#encryption()) throw error('DEEPSEEK_ENCRYPTION_UNAVAILABLE', '系统安全加密暂不可用，无法保存或使用 DeepSeek 登录凭据。');
  }
  #changed() { try { Promise.resolve(this.#onChange()).catch(() => {}); } catch {} }
  #setFailure(value) { this.#failure = value ? { code: value.code || 'DEEPSEEK_CONNECTION_FAILED',
    message: this.redact(value.message || 'DeepSeek 连接失败，请重试。').slice(0, 1000) } : null; }
  #headers() { return { 'user-agent': `Synora-code/${this.#version}`, 'x-client-bundle-id': '',
    'x-client-platform': process.platform === 'win32' ? 'desktop-win' : process.platform === 'darwin' ? 'desktop-mac' : 'web',
    'x-client-version': this.#version, 'x-client-locale': 'zh_CN',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60) }; }
  #enqueue(operation) {
    const task = this.#queue.catch(() => {}).then(operation); this.#queue = task.catch(() => {}); return task;
  }
  async #save(grant) {
    this.#requireEncryption();
    const data = { version: 1, deviceId: this.#deviceId,
      ...(grant ? { encryptedGrant: this.#safeStorage.encryptString(JSON.stringify(grant)).toString('base64') } : {}) };
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(data), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, this.#file);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  async init() {
    if (this.#initialized) return this;
    this.#initialized = true;
    try {
      const stat = await fs.lstat(this.#file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw wireError();
      const stored = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      if (!object(stored) || stored.version !== 1 || !UUID.test(stored.deviceId)
          || Object.keys(stored).some(key => !['version', 'deviceId', 'encryptedGrant'].includes(key))) throw wireError();
      this.#deviceId = stored.deviceId;
      if (stored.encryptedGrant !== undefined) {
        this.#requireEncryption();
        if (typeof stored.encryptedGrant !== 'string' || !stored.encryptedGrant.length
            || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(stored.encryptedGrant)) throw wireError();
        const grant = JSON.parse(this.#safeStorage.decryptString(Buffer.from(stored.encryptedGrant, 'base64')));
        if (!validGrant(grant)) throw wireError();
        this.#grant = { issuer: PLATFORM, token: grant.token, profileId: grant.profileId,
          identity: object(grant.identity) ? Object.fromEntries(['name', 'contact'].filter(key => text(grant.identity[key], 320)).map(key => [key, grant.identity[key]])) : null };
        this.#knownSecrets.add(grant.token);
      }
      this.#failure = null; this.#storageError = false;
    } catch (failure) {
      if (failure.code !== 'ENOENT') {
        this.#storageError = true;
        this.#setFailure(error('DEEPSEEK_STORAGE_UNREADABLE', 'DeepSeek 本机登录信息无法读取。请解锁系统密钥存储后重试，原文件已保留。'));
      }
    }
    return this;
  }
  async retryLocalRead() {
    if (this.#attempt || this.#removing) throw error('DEEPSEEK_BUSY', '请等待当前账号操作完成。');
    this.#initialized = false; this.#grant = null; this.#modelCache = null;
    await this.init(); this.#changed(); return this.publicState();
  }
  redact(value) {
    let result = String(value);
    for (const secret of this.#knownSecrets) result = result.split(secret).join('[已隐藏 DeepSeek 凭据]');
    return result;
  }
  async publicState() {
    const status = this.#attempt ? 'connecting' : this.#grant ? 'connected' : this.#storageError ? 'reauth_required' : 'disconnected';
    return { session: { status, sharing: Boolean(this.#grant) && !this.#removing,
      profileId: this.#grant?.profileId || null, ...(this.#grant?.identity ? {
        identity: Object.fromEntries(Object.entries(this.#grant.identity).map(([key, value]) => [key, this.redact(value)])) } : {}) },
      attempt: this.#attempt ? { phase: this.#attempt.phase, expiresAt: this.#attempt.expiresAt } : null,
      error: this.#failure ? { ...this.#failure } : null, storageRecovery: this.#storageError,
      models: this.#modelCache && this.#grant && this.#modelCache.profileId === this.#grant.profileId ? structuredClone(this.#modelCache.models) : [] };
  }

  async #response(url, init, signal, limit = 65_536) {
    const deadline = AbortSignal.timeout(this.#requestTimeout), lifetime = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let response;
    try { response = await wait(() => this.#fetch(url, { ...init, redirect: 'error', signal: lifetime }), lifetime, cancelBody); }
    catch {
      if (signal?.aborted) throw aborted();
      throw error('DEEPSEEK_NETWORK_ERROR', '无法连接 DeepSeek，请检查网络或代理后重试。');
    }
    if (!response.ok) {
      cancelBody(response);
      if (response.status === 401 && new Headers(init.headers).has('x-dsh-auth-token')) throw unavailable();
      throw error(`DEEPSEEK_HTTP_${response.status}`, `DeepSeek 请求失败（HTTP ${response.status}），请稍后重试。`);
    }
    try { return await json(response, lifetime, limit); }
    catch (failure) { if (signal?.aborted) throw aborted(); if (deadline.aborted) throw error('DEEPSEEK_NETWORK_ERROR', 'DeepSeek 请求超时，请重试。'); throw failure; }
  }
  async #platform(pathname, body, { signal, token, method = 'POST' } = {}) {
    const value = await this.#response(`${PLATFORM}${pathname}`, { method,
      headers: { ...this.#headers(), ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { 'x-dsh-auth-token': token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, signal);
    if (value?.code === 40003 && token) throw unavailable();
    if (!object(value) || value.code !== 0 || value.data?.biz_code !== 0 || !Object.hasOwn(value.data, 'biz_data')) throw wireError();
    return value.data.biz_data;
  }

  signIn() {
    if (this.#closed) return Promise.reject(error('DEEPSEEK_CLOSED', 'DeepSeek 账号连接已关闭。'));
    if (this.#attempt) return this.#attempt.done;
    if (this.#removing) return Promise.reject(error('DEEPSEEK_BUSY', '请等待退出登录完成。'));
    if (this.#storageError) return Promise.reject(error('DEEPSEEK_STORAGE_UNREADABLE', '请先恢复 DeepSeek 本机登录信息，再重新登录。'));
    try { this.#requireEncryption(); } catch (failure) { return Promise.reject(failure); }
    const attempt = { controller: new AbortController(), phase: 'initializing', expiresAt: Date.now() + this.#attemptTimeout,
      server: null, callback: null, authorizeId: null, verifier: randomBytes(32).toString('base64url'), state: randomBytes(32).toString('base64url') };
    this.#attempt = attempt; this.#failure = null; this.#changed();
    attempt.done = this.#runSignIn(attempt).finally(() => {
      clearTimeout(attempt.timer);
      if (attempt.callback && !attempt.callback.writableEnded) attempt.callback.writeHead(400, { 'cache-control': 'no-store' }).end('登录未完成，可以关闭此页面。');
      attempt.server?.close(); attempt.server?.closeAllConnections();
      if (this.#attempt === attempt) this.#attempt = null;
      this.#changed();
    }).then(() => this.publicState());
    return attempt.done;
  }
  async #runSignIn(attempt) {
    const signal = attempt.controller.signal;
    attempt.timer = setTimeout(() => { attempt.expired = true; attempt.controller.abort(); }, this.#attemptTimeout);
    let resolveCode;
    const receivedCode = new Promise(resolve => { resolveCode = resolve; });
    try {
      await this.#enqueue(() => this.#save(this.#grant));
      signal.throwIfAborted();
      const server = http.createServer((req, res) => {
        res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer');
        res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
        res.setHeader('x-content-type-options', 'nosniff');
        let url; try { url = new URL(req.url || '/', attempt.redirectUri); } catch { res.writeHead(400).end(); return; }
        const state = url.searchParams.get('state') || '', code = url.searchParams.get('code');
        const matches = Buffer.byteLength(state) === Buffer.byteLength(attempt.state)
          && timingSafeEqual(Buffer.from(state), Buffer.from(attempt.state));
        if (req.method !== 'GET' || req.headers.host !== new URL(attempt.redirectUri).host || url.origin !== new URL(attempt.redirectUri).origin
            || url.pathname !== '/oauth/callback' || !matches || !text(code, 8192) || !code
            || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) { res.writeHead(400).end(); return; }
        if (signal.aborted || attempt.callback || attempt.phase !== 'waiting-browser') { res.writeHead(410).end(); return; }
        attempt.callback = res; resolveCode(code);
      });
      attempt.server = server; server.requestTimeout = 10_000; server.headersTimeout = 10_000;
      await wait(() => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }), signal,
        () => { server.close(); server.closeAllConnections(); });
      attempt.redirectUri = `http://127.0.0.1:${server.address().port}/oauth/callback`;
      const init = await this.#platform('/auth-api/v0/dsh/auth_init', {
        code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'), code_challenge_method: 'S256',
        state: attempt.state, redirect_uri: attempt.redirectUri, locale: 'zh_CN', login_source: 'desktop',
      }, { signal });
      if (!object(init) || !text(init.authorize_id, 1000) || !init.authorize_id || !Number.isFinite(init.expires_in) || init.expires_in <= 0) throw wireError();
      const authorizeUrl = browserUrl(init.authorize_url, '/dsh/authorize');
      attempt.authorizeId = init.authorize_id;
      if (signal.aborted) throw aborted();
      attempt.expiresAt = Math.min(attempt.expiresAt, Date.now() + init.expires_in * 1000);
      clearTimeout(attempt.timer);
      attempt.timer = setTimeout(() => { attempt.expired = true; attempt.controller.abort(); }, Math.max(1, attempt.expiresAt - Date.now()));
      attempt.phase = 'waiting-browser'; this.#changed();
      if (typeof this.#openExternal !== 'function') throw error('DEEPSEEK_BROWSER_FAILED', '无法打开系统浏览器，请重试。');
      try { await wait(() => this.#openExternal(authorizeUrl), signal); }
      catch (failure) { if (signal.aborted) throw aborted(); throw error('DEEPSEEK_BROWSER_FAILED', '无法打开系统浏览器，请重试。'); }
      const code = await wait(() => receivedCode, signal);
      attempt.phase = 'exchanging'; this.#changed();
      const result = await this.#platform('/auth-api/v0/dsh/auth_exchange', {
        code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri,
        device_id: this.#deviceId, device_model: `${process.platform}-${os.arch()}`, os_version: `${process.platform} ${os.release()}`,
      }, { signal });
      if (!object(result) || typeof result.token !== 'string' || !/^[\x21-\x7e]{1,8192}$/u.test(result.token)) throw wireError();
      this.#knownSecrets.add(result.token);
      const completionUrl = new URL(browserUrl(result.authorized_url, '/dsh/authorized'));
      completionUrl.searchParams.set('login_source', 'desktop');
      if (signal.aborted || Date.now() >= attempt.expiresAt) throw aborted();
      const grant = { issuer: PLATFORM, token: result.token, profileId: randomUUID(), identity: projectProfile(result.user) };
      // Once persistence is admitted, cancellation waits for this commit. A late
      // exchange result after a locally cancelled attempt can never enter it.
      attempt.phase = 'committing'; clearTimeout(attempt.timer); this.#changed();
      try { await this.#enqueue(() => this.#save(grant)); }
      catch { throw error('DEEPSEEK_STORAGE_FAILED', 'DeepSeek 登录信息保存失败，请重试。'); }
      this.#grant = grant; this.#modelCache = null; this.#failure = null;
      attempt.callback.writeHead(303, { location: completionUrl.href }).end();
      return this.publicState();
    } catch (failure) {
      if (signal.aborted && attempt.authorizeId) {
        // Remote cleanup is best effort and does not delay local cancellation.
        void this.#platform('/auth-api/v0/dsh/auth_cancel', { authorize_id: attempt.authorizeId, code_verifier: attempt.verifier }).catch(() => {});
      }
      const safe = attempt.expired ? error('DEEPSEEK_LOGIN_EXPIRED', 'DeepSeek 登录已超时，请重新登录。')
        : signal.aborted ? aborted() : failure?.name === 'DeepSeekConnectionError' ? failure : error('DEEPSEEK_CONNECTION_FAILED', 'DeepSeek 登录失败，请重试。');
      this.#setFailure(safe); throw safe;
    }
  }
  async cancelSignIn() {
    const attempt = this.#attempt; if (!attempt) return this.publicState();
    if (attempt.phase !== 'committing') attempt.controller.abort();
    await attempt.done.catch(() => {}); return this.publicState();
  }
  async disconnect() {
    if (this.#removing) return this.#removing;
    this.#removing = (async () => {
      await this.cancelSignIn();
      const old = this.#grant;
      await this.#enqueue(() => this.#save(null));
      this.#grant = null; this.#modelCache = null; this.#failure = null; this.#storageError = false; this.#changed();
      if (old) void this.#platform('/auth-api/v0/users/logout', undefined, { token: old.token }).catch(() => {});
    })().finally(() => { this.#removing = null; this.#changed(); });
    await this.#removing; return this.publicState();
  }
  async #reject(grant) {
    if (!grant || this.#grant !== grant) return;
    await this.#enqueue(async () => {
      if (this.#grant !== grant) return;
      await this.#save(null); this.#grant = null; this.#modelCache = null;
      this.#setFailure(error('DEEPSEEK_SIGN_IN_REQUIRED', 'DeepSeek 登录已失效，请重新登录。')); this.#changed();
    });
  }
  #activeGrant() { this.#requireEncryption(); if (!this.#grant || this.#removing) throw unavailable(); return this.#grant; }
  async listModels({ force = false } = {}) {
    const grant = this.#activeGrant();
    if (!force && this.#modelCache?.profileId === grant.profileId && Date.now() - this.#modelCache.at < 300_000) return structuredClone(this.#modelCache.models);
    try {
      const body = await this.#response(`${API}/models`, { method: 'GET', headers: {
        'user-agent': `Synora-code/${this.#version}`, accept: 'application/json', 'x-dsh-auth-token': grant.token,
      } }, undefined, 2 * 1024 * 1024);
      if (this.#grant !== grant || this.#removing) throw unavailable();
      if (!Array.isArray(body?.data)) throw wireError();
      const models = [], seen = new Set();
      for (const row of body.data) {
        if (!text(row?.id, 200) || !row.id || seen.has(row.id)) continue;
        seen.add(row.id);
        const messages = row.api_capabilities?.anthropic_messages;
        const compatible = object(messages) && (row.output_modalities === undefined || Array.isArray(row.output_modalities) && row.output_modalities.includes('text'))
          && (row.input_modalities === undefined || Array.isArray(row.input_modalities) && row.input_modalities.includes('text'));
        const metadata = { id: this.redact(row.id), displayName: this.redact(text(row.name, 200) && row.name ? row.name : row.id),
          compatible: Boolean(compatible), textCompatible: Boolean(compatible), supportsTools: Boolean(compatible),
          supportsImages: Array.isArray(row.input_modalities) && row.input_modalities.includes('image'),
          ...(compatible ? {} : { compatibilityReason: '此模型目录未声明支持当前账号的 Messages 文本接口。' }),
          reasoningEfforts: ['none', 'low', 'high', 'max'] };
        if (Number.isSafeInteger(row.context_window) && row.context_window > 0) metadata.contextWindow = row.context_window;
        if (Number.isSafeInteger(row.max_output_tokens) && row.max_output_tokens > 0) metadata.maxOutputTokens = row.max_output_tokens;
        models.push(metadata);
      }
      if (!models.length) throw wireError();
      this.#modelCache = { profileId: grant.profileId, models, at: Date.now() }; this.#changed(); return structuredClone(models);
    } catch (failure) { if (failure.code === 'DEEPSEEK_SIGN_IN_REQUIRED') await this.#reject(grant); throw failure; }
  }
  async requestModel({ requestModel, ...config }) {
    const grant = this.#activeGrant();
    if (config.provider !== 'deepseek' || config.authMode !== 'deepseek-account' || typeof requestModel !== 'function')
      throw error('DEEPSEEK_INVALID_CONFIG', 'DeepSeek 账号调用配置无效。');
    if (config.deepseekProfileId && config.deepseekProfileId !== grant.profileId) throw error('DEEPSEEK_ACCOUNT_CHANGED', 'DeepSeek 账号已变化，请重新开始任务。');
    try { return await requestModel({ ...config, apiKey: grant.token, baseUrl: DEEPSEEK_ACCOUNT_BASE, fetchImpl: this.#fetch }); }
    catch (failure) {
      if (failure.code === 'PROVIDER_HTTP_401' || failure.status === 401) await this.#reject(grant);
      throw failure;
    }
  }
  async dispose() { this.#closed = true; await this.cancelSignIn(); await this.#queue; }
}
