import path from 'node:path';
import { isUnreadableChatGPTStorage, preserveUnreadableChatGPTCredentials } from './chatgpt-storage-recovery.mjs';
import { deriveModelCapabilities } from './model-catalog.mjs';

const AUTH_ORIGIN = 'https://auth.openai.com';
const AUTH_PATH = '/api/accounts/authorize';
const API_BASE = 'https://api.openai.com/v1';
const MODEL_CACHE_MS = 5 * 60 * 1000;
const USAGE_OBSERVATION_MS = 5 * 60 * 1000;
const STATUSES = new Set(['disconnected', 'connecting', 'connected', 'reauth_required']);
const USAGE_ERROR_STATUSES = Object.freeze({
  CHATGPT_USAGE_LIMIT_EXCEEDED: 'limit_reached',
  subscription_sharing_usage_limit_exceeded: 'limit_reached',
  CHATGPT_USAGE_UNAVAILABLE: 'unavailable',
  subscription_sharing_usage_unavailable: 'unavailable',
  CHATGPT_NOT_ELIGIBLE: 'not_eligible',
  subscription_sharing_user_not_eligible: 'not_eligible',
  subscription_sharing_v2_user_not_eligible: 'not_eligible',
});

function connectionError(code, message, retryable = false) {
  const error = new Error(message);
  error.name = 'ChatGPTConnectionError'; error.code = code; error.retryable = retryable;
  return error;
}

function safeString(value, redact, limit = 200) {
  return typeof value === 'string' ? redact(value).slice(0, limit) : undefined;
}

function safeIdentity(value, redact) {
  if (!value || typeof value !== 'object') return undefined;
  const name = safeString(value.name, redact);
  const email = safeString(value.email, redact, 320);
  return { ...(name !== undefined ? { name } : {}), ...(email !== undefined ? { email } : {}) };
}

function safeError(error, redact) {
  if (!error || typeof error !== 'object') return undefined;
  const result = {
    code: safeString(error.code, redact, 160) || (error.name === 'AbortError' ? 'cancelled' : 'connection_error'),
    message: safeString(error.message, redact, 2000) || 'ChatGPT 连接暂不可用，请稍后重试。',
    retryable: error.retryable === true,
  };
  if (Number.isInteger(error.status)) result.status = error.status;
  for (const key of ['requestId', 'param', 'responseShape']) {
    const value = safeString(error[key], redact, 500);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function safeSession(value, redact) {
  const status = STATUSES.has(value?.status) ? value.status : 'disconnected';
  const result = { status, sharing: status === 'connected' && value?.sharing === true };
  for (const key of ['profileId', 'profileLabel']) {
    const item = safeString(value?.[key], redact);
    if (item !== undefined) result[key] = item;
  }
  const identity = safeIdentity(value?.identity, redact);
  const error = safeError(value?.error, redact);
  if (identity) result.identity = identity;
  if (error) result.error = error;
  return result;
}

function safeProfiles(profiles, redact) {
  if (!Array.isArray(profiles)) throw connectionError('invalid_profiles', 'ChatGPT 返回了无效的本机账号列表。');
  return profiles.map(profile => {
    if (!profile || typeof profile.id !== 'string' || typeof profile.label !== 'string' || !STATUSES.has(profile.status)) {
      throw connectionError('invalid_profiles', 'ChatGPT 返回了无效的本机账号信息。');
    }
    const result = {
      id: safeString(profile.id, redact), label: safeString(profile.label, redact), status: profile.status,
      sharing: profile.status === 'connected' && profile.sharing === true,
    };
    const identity = safeIdentity(profile.identity, redact);
    if (identity) result.identity = identity;
    if (profile.requiresNewRegistration === true) result.requiresNewRegistration = true;
    if (profile.pending === true) result.pending = true;
    return result;
  });
}

function safeModels(models, redact, normalized = false) {
  if (!Array.isArray(models)) throw connectionError('invalid_model_catalog', 'ChatGPT 返回了无效的模型列表，请稍后重试。', true);
  const result = [];
  const seen = new Set();
  for (const model of models) {
    if (!model || typeof model.slug !== 'string' || !model.slug.trim() || model.slug.length > 200
        || typeof model.displayName !== 'string' || !model.displayName.trim() || model.displayName.length > 200) {
      throw connectionError('invalid_model_catalog', 'ChatGPT 返回了不完整的模型信息，请稍后重试。', true);
    }
    if (seen.has(model.slug)) continue;
    seen.add(model.slug);
    const capacity = deriveModelCapabilities('openai', model.slug, { ...model, officialSource: true,
      // The SDK's raw metadata comes from this account. Only our own cached
      // allowlisted models may preserve a derived official fallback marker.
      contextWindowOrigin: normalized ? model.contextWindowOrigin : 'account' });
    result.push({ slug: redact(model.slug), displayName: redact(model.displayName),
      ...(Number.isSafeInteger(capacity.contextWindow) && capacity.contextWindow > 0
        ? { contextWindow: capacity.contextWindow, contextWindowKind: capacity.contextWindowKind,
          contextWindowOrigin: capacity.contextWindowOrigin } : {}) });
  }
  return result;
}

/** Main-process-only bridge. It never exposes SDK credentials through publicState or onChange. */
export class ChatGPTConnection {
  #dataDir; #safeStorage; #openExternal; #onChange; #createClient;
  #client; #clientPromise; #unsubscribe;
  #clientGeneration = 0;
  #storageRecovery = false;
  #initialized = false;
  #session = { status: 'disconnected', sharing: false };
  #profiles = [];
  #localError = null;
  #modelCache = new Map();
  #modelRequests = new Map();
  #tokens = new Set();
  #pendingSignIn;
  #profilesRefresh;
  #notifyQueued = false;
  #usageByProfile = new Map();
  #usageEpoch = 0;
  #clock;

  constructor({ dataDir, safeStorage, openExternal, onChange, createClient, clock = Date.now } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw connectionError('invalid_config', 'ChatGPT 数据目录必须是绝对路径。');
    if (typeof clock !== 'function') throw connectionError('invalid_config', 'ChatGPT 时间组件无效。');
    this.#dataDir = dataDir;
    this.#safeStorage = safeStorage;
    this.#openExternal = openExternal;
    this.#onChange = typeof onChange === 'function' ? onChange : () => {};
    this.#createClient = createClient;
    this.#clock = clock;
  }

  redact(value) {
    let text = String(value);
    for (const token of [...this.#tokens].sort((a, b) => b.length - a.length)) text = text.split(token).join('[已隐藏 ChatGPT 凭据]');
    return text;
  }

  #encryptionAvailable() {
    try {
      return this.#safeStorage?.isEncryptionAvailable() === true
        && typeof this.#safeStorage.encryptString === 'function'
        && typeof this.#safeStorage.decryptString === 'function'
        && this.#safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
    } catch { return false; }
  }

  #requireEncryption() {
    if (!this.#encryptionAvailable()) throw connectionError('storage_encryption_unavailable', '系统安全加密暂不可用，无法保存或使用 ChatGPT 登录凭据。请解锁系统密钥存储后重试。', true);
  }

  #credentialEncryption() {
    return {
      id: 'forgedesk-electron-safe-storage-v1',
      isAvailable: () => this.#encryptionAvailable(),
      encrypt: plaintext => { this.#requireEncryption(); return this.#safeStorage.encryptString(plaintext); },
      decrypt: ciphertext => { this.#requireEncryption(); return this.#safeStorage.decryptString(Buffer.from(ciphertext)); },
    };
  }

  #assertClient(generation, client = this.#client) {
    if (generation !== this.#clientGeneration || client !== this.#client) throw connectionError('cancelled', 'ChatGPT 连接已更新，此次操作已取消。');
  }

  #resetClient() {
    this.#clientGeneration++;
    this.#pendingSignIn?.abort();
    this.#pendingSignIn = undefined;
    try { this.#unsubscribe?.(); } catch {}
    this.#unsubscribe = undefined;
    this.#client = undefined;
    this.#clientPromise = undefined;
    this.#initialized = false;
    this.#profilesRefresh = undefined;
    this.#modelRequests.clear();
    this.#modelCache.clear();
    this.#usageByProfile.clear();
    this.#usageEpoch++;
    this.#profiles = [];
    this.#updateSession({ status: 'disconnected', sharing: false });
  }

  #notify() {
    if (this.#notifyQueued) return;
    this.#notifyQueued = true;
    queueMicrotask(() => {
      this.#notifyQueued = false;
      try { Promise.resolve(this.#onChange()).catch(() => {}); } catch {}
    });
  }

  #profileKey() { return this.#session.profileId || '__selected__'; }

  #usageNow() {
    try {
      const value = this.#clock();
      return Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? value : null;
    } catch { return null; }
  }

  #usageState(session) {
    const empty = { source: 'unavailable', checkedAt: null, stale: false };
    if (session.status !== 'connected') return { status: 'not_connected', ...empty };
    if (!session.sharing) return { status: 'not_authorized', ...empty };
    const observation = session.profileId ? this.#usageByProfile.get(session.profileId) : null;
    if (!observation) return { status: 'unknown', ...empty };
    const now = this.#usageNow();
    return {
      status: observation.status, source: 'official_response',
      checkedAt: new Date(observation.checkedAt).toISOString(),
      stale: now === null || now < observation.checkedAt || now - observation.checkedAt >= USAGE_OBSERVATION_MS,
    };
  }

  #observeUsage(profileId, epoch, succeeded, error) {
    // The SIWC SDK exposes no percentage/reset API. Record only completed
    // official requests or exact official machine codes, never local token
    // totals, arbitrary error text, a generic 429, or an invented balance.
    // Observing status must never change the result of a model request.
    try {
      if (!profileId || epoch !== this.#usageEpoch || profileId !== this.#session.profileId || !this.#session.sharing) return;
      let status = succeeded ? 'request_succeeded' : undefined;
      if (!succeeded) {
        for (const code of [error?.code, error?.serviceCode]) {
          if (typeof code === 'string' && Object.hasOwn(USAGE_ERROR_STATUSES, code)) { status = USAGE_ERROR_STATUSES[code]; break; }
        }
      }
      const checkedAt = this.#usageNow();
      if (!status || checkedAt === null) return;
      const previous = this.#usageByProfile.get(profileId);
      if (previous?.status === status && previous.checkedAt === checkedAt) return;
      this.#usageByProfile.delete(profileId);
      this.#usageByProfile.set(profileId, { status, checkedAt });
      if (this.#usageByProfile.size > 100) this.#usageByProfile.delete(this.#usageByProfile.keys().next().value);
      this.#notify();
    } catch { /* Quota observation cannot interrupt a task or disclose an error. */ }
  }

  #updateSession(value) {
    const next = safeSession(value, text => this.redact(text));
    if (JSON.stringify(next) === JSON.stringify(this.#session)) return;
    const previous = this.#profileKey();
    if (this.#session.profileId !== next.profileId || this.#session.status !== next.status || this.#session.sharing !== next.sharing) this.#usageEpoch++;
    if (!next.sharing && (previous === (next.profileId || '__selected__') || (!next.profileId && next.status === 'disconnected'))) this.#usageByProfile.delete(previous);
    this.#session = next;
    if (previous !== this.#profileKey() || !next.sharing) this.#localError = null;
    this.#notify();
  }

  #updateError(error) {
    const next = safeError(error, text => this.redact(text)) || null;
    if (JSON.stringify(next) === JSON.stringify(this.#localError)) return;
    this.#localError = next; this.#notify();
  }

  #refreshProfiles() {
    if (this.#profilesRefresh) return this.#profilesRefresh;
    const client = this.#client, generation = this.#clientGeneration;
    const refresh = Promise.resolve().then(async () => {
      if (!client) return;
      const profiles = safeProfiles(await client.listProfiles(), text => this.redact(text));
      this.#assertClient(generation, client);
      if (JSON.stringify(profiles) !== JSON.stringify(this.#profiles)) { this.#profiles = profiles; this.#notify(); }
    });
    this.#profilesRefresh = refresh;
    refresh.finally(() => { if (this.#profilesRefresh === refresh) this.#profilesRefresh = undefined; }).catch(() => {});
    return refresh;
  }

  async #getClient() {
    if (this.#storageRecovery) throw connectionError('connection_busy', '正在安全退出本机 ChatGPT 连接，请稍后重试。');
    this.#requireEncryption();
    if (this.#client) return this.#client;
    if (!this.#clientPromise) {
      const generation = this.#clientGeneration;
      const pending = Promise.resolve().then(async () => {
        const factory = this.#createClient || (await import('../vendor/siwc/index.js')).createChatGPT;
        if (typeof factory !== 'function') throw connectionError('invalid_sdk', 'ChatGPT 登录组件尚未正确安装。');
        const client = await factory({
          appName: 'Cortex', appId: 'forgedesk', sendHostId: true, redirectPort: 0,
          storageDir: path.join(this.#dataDir, 'chatgpt'),
          credentialEncryption: this.#credentialEncryption(),
          openBrowser: async value => {
            let url;
            try { url = new URL(value); } catch { throw connectionError('invalid_authorization_url', '已拒绝打开无效的 ChatGPT 授权地址。'); }
            if (url.origin !== AUTH_ORIGIN || url.pathname !== AUTH_PATH || url.username || url.password || url.hash) {
              throw connectionError('invalid_authorization_url', '已拒绝打开非官方的 ChatGPT 授权地址。');
            }
            if (typeof this.#openExternal !== 'function') throw connectionError('browser_unavailable', '无法打开系统浏览器，请检查应用设置。');
            await this.#openExternal(url.href);
          },
        });
        for (const method of ['getSession', 'listProfiles', 'subscribe', 'signIn', 'cancelSignIn', 'selectProfile', 'disconnect', 'listModels', 'withAccessToken']) {
          if (typeof client?.[method] !== 'function') throw connectionError('invalid_sdk', 'ChatGPT 登录组件接口不兼容，请重新安装应用。');
        }
        if (generation !== this.#clientGeneration) {
          client.cancelSignIn();
          throw connectionError('cancelled', 'ChatGPT 连接已更新，此次操作已取消。');
        }
        this.#client = client;
        this.#unsubscribe = client.subscribe(session => {
          if (generation !== this.#clientGeneration || client !== this.#client) return;
          this.#updateSession(session);
          this.#refreshProfiles().catch(error => { if (generation === this.#clientGeneration) this.#updateError(error); });
        });
        return client;
      });
      this.#clientPromise = pending;
      pending.catch(() => { if (this.#clientPromise === pending) this.#clientPromise = undefined; });
    }
    return this.#clientPromise;
  }

  async #refreshSafeState() {
    const generation = this.#clientGeneration;
    const client = await this.#getClient();
    this.#assertClient(generation, client);
    const session = await client.getSession();
    this.#assertClient(generation, client);
    this.#updateSession(session);
    await this.#refreshProfiles();
    this.#assertClient(generation, client);
    this.#initialized = true;
    this.#updateError(null);
  }

  async init() {
    const generation = this.#clientGeneration;
    try { await this.#refreshSafeState(); }
    catch (error) {
      if (generation !== this.#clientGeneration) return this.publicState();
      if (error?.code === 'storage_encryption_unavailable') this.#updateSession({ status: 'reauth_required', sharing: false });
      this.#updateError(error);
    }
    return this.publicState();
  }

  // Re-read existing local credentials. This never starts OAuth or a model request.
  async retryLocalRead() {
    if (this.#storageRecovery) throw connectionError('connection_busy', '正在安全退出本机 ChatGPT 连接，请稍后重试。');
    this.cancelSignIn();
    // The SDK intentionally retains its previous error for the same profile.
    // A fresh local client lets a successful reread clear a repaired storage error.
    this.#resetClient();
    return this.init();
  }

  // This method deliberately has no SDK reads, publication or network side effects.
  async publicState() {
    const session = safeSession(this.#session, text => this.redact(text));
    if (this.#localError && (!session.error || (session.status === 'disconnected' && this.#localError.code === 'revocation_failed'))) {
      session.error = safeError(this.#localError, text => this.redact(text));
    }
    const models = session.sharing ? this.#modelCache.get(this.#profileKey())?.models || [] : [];
    return {
      session, profiles: safeProfiles(this.#profiles, text => this.redact(text)),
      models: safeModels(models, text => this.redact(text), true),
      usage: this.#usageState(session),
    };
  }

  async signIn(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw connectionError('invalid_config', 'ChatGPT 登录选项无效。');
    if (this.#pendingSignIn) throw connectionError('connection_busy', '请先完成或取消正在进行的 ChatGPT 登录。');
    if (options.profileId !== undefined && (typeof options.profileId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(options.profileId))) {
      throw connectionError('invalid_config', 'ChatGPT 账号标识无效。');
    }
    const controller = new AbortController();
    const generation = this.#clientGeneration;
    this.#pendingSignIn = controller;
    this.#updateError(null);
    try {
      const client = await this.#getClient();
      controller.signal.throwIfAborted();
      const session = await client.signIn({
        ...(options.newProfile === true ? { newProfile: true } : {}),
        ...(options.profileId !== undefined ? { profileId: options.profileId } : {}),
        ...(options.reconsent === true ? { reconsent: true } : {}),
        signal: controller.signal,
      });
      this.#assertClient(generation, client);
      this.#updateSession(session);
      await this.#refreshSafeState();
      return this.publicState();
    } catch (error) {
      if (generation === this.#clientGeneration) {
        try { await this.#refreshSafeState(); } catch {}
        if (error?.name !== 'AbortError' && error?.code !== 'cancelled') this.#updateError(error);
      }
      throw error;
    } finally { if (this.#pendingSignIn === controller) this.#pendingSignIn = undefined; }
  }

  cancelSignIn() {
    this.#pendingSignIn?.abort();
    this.#client?.cancelSignIn();
  }

  async selectProfile(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw connectionError('invalid_config', 'ChatGPT 账号标识无效。');
    const client = await this.#getClient();
    const generation = this.#clientGeneration;
    this.#assertClient(generation, client);
    this.#updateError(null);
    const session = await client.selectProfile(id);
    this.#assertClient(generation, client);
    this.#updateSession(session);
    await this.#refreshSafeState();
    return this.publicState();
  }

  async disconnect() {
    this.cancelSignIn();
    const client = await this.#getClient();
    const key = this.#profileKey();
    let warning;
    try { await client.disconnect(); }
    catch (error) {
      if (isUnreadableChatGPTStorage(error)) {
        this.#storageRecovery = true;
        let recovery;
        try {
          recovery = await preserveUnreadableChatGPTCredentials({ directory: path.join(this.#dataDir, 'chatgpt'), encryption: this.#credentialEncryption() });
          if (recovery.backupCreated) this.#resetClient();
        } finally { this.#storageRecovery = false; }
        if (recovery.backupCreated) {
          warning = '已退出本机 ChatGPT 连接，原凭据文件已保留为备份。因无法读取凭据，不能确认远程撤销；请到 ChatGPT 设置中管理并断开此应用。';
          this.#updateError({ code: 'local_disconnect_only', message: warning, retryable: false });
          return { ...await this.publicState(), warning, recovery };
        }
        // The local read recovered while waiting for the lock. Do not quarantine
        // healthy credentials; perform the normal SDK revocation and local logout.
        try { await client.disconnect(); }
        catch (retryError) { if (retryError?.code !== 'revocation_failed') throw retryError; warning = '本机 ChatGPT 凭据已移除，但未能确认远程撤销。请在 ChatGPT 设置中检查并断开此应用。'; }
      } else {
        if (error?.code !== 'revocation_failed') throw error;
        warning = '本机 ChatGPT 凭据已移除，但未能确认远程撤销。请在 ChatGPT 设置中检查并断开此应用。';
      }
    }
    this.#modelCache.delete(key);
    this.#usageByProfile.delete(key);
    await this.#refreshSafeState();
    if (warning) this.#updateError({ code: 'revocation_failed', message: warning, retryable: true });
    return { ...await this.publicState(), ...(warning ? { warning } : {}) };
  }

  async listModels({ force = false, signal } = {}) {
    const client = await this.#getClient();
    const generation = this.#clientGeneration;
    this.#assertClient(generation, client);
    if (!this.#initialized) await this.#refreshSafeState();
    this.#assertClient(generation, client);
    if (!this.#session.sharing) return [];
    const key = this.#profileKey();
    const cached = this.#modelCache.get(key);
    if (!force && cached && cached.expiresAt > Date.now()) return safeModels(cached.models, text => this.redact(text), true);
    if (this.#modelRequests.has(key)) return this.#modelRequests.get(key);
    const request = Promise.resolve().then(async () => {
      try {
        const models = safeModels(await client.listModels({ signal }), text => this.redact(text));
        this.#assertClient(generation, client);
        if (key !== this.#profileKey() || !this.#session.sharing) throw connectionError('cancelled', '当前 ChatGPT 账号已切换，模型列表请求已取消。');
        this.#modelCache.set(key, { models, expiresAt: Date.now() + MODEL_CACHE_MS });
        this.#updateError(null); this.#notify();
        return safeModels(models, text => this.redact(text), true);
      } catch (error) {
        if (generation === this.#clientGeneration && key === this.#profileKey()) this.#updateError(error);
        throw error;
      } finally { if (this.#modelRequests.get(key) === request) this.#modelRequests.delete(key); }
    });
    this.#modelRequests.set(key, request);
    return request;
  }

  async requestModel(options = {}) {
    if (typeof options.requestModel !== 'function') throw connectionError('invalid_config', '缺少主进程模型请求函数。');
    const client = await this.#getClient();
    const generation = this.#clientGeneration;
    this.#assertClient(generation, client);
    if (!this.#initialized) await this.#refreshSafeState();
    this.#assertClient(generation, client);
    if (!this.#session.sharing) {
      throw connectionError(this.#session.status === 'connected' ? 'sharing_not_enabled' : 'sign_in_required',
        this.#session.status === 'connected' ? '当前 ChatGPT 连接尚未授权 Token 共享，请先在账号设置中启用。' : '请先登录 ChatGPT 并授权 Token 共享。');
    }
    const { requestModel, ...requestOptions } = options;
    const usageProfile = this.#session.profileId, usageEpoch = this.#usageEpoch;
    let result;
    try {
      result = await client.withAccessToken(async (token, sdkSignal) => {
        this.#assertClient(generation, client);
        if (typeof token !== 'string' || !token) throw connectionError('sign_in_required', 'ChatGPT 连接没有可用凭据，请重新登录。');
        this.#tokens.add(token);
        // Provider errors remain intact. Returning them avoids the SDK's generic
        // OAuth error wrapper; only authenticated supplies credentials and refreshes.
        try {
          return { value: await requestModel({ ...requestOptions,
            provider: 'openai', baseUrl: API_BASE, authMode: 'chatgpt', apiKey: token, signal: sdkSignal,
          }) };
        } catch (error) { return { error }; }
      }, options.signal);
    } catch (error) { this.#observeUsage(usageProfile, usageEpoch, false, error); throw error; }
    this.#assertClient(generation, client);
    if (Object.hasOwn(result, 'error')) {
      const error = result.error;
      this.#observeUsage(usageProfile, usageEpoch, false, error);
      if (error && typeof error === 'object') {
        try { if (typeof error.message === 'string') error.message = this.redact(error.message); } catch {}
        try { if (typeof error.stack === 'string') error.stack = this.redact(error.stack); } catch {}
      }
      throw error;
    }
    this.#observeUsage(usageProfile, usageEpoch, true);
    return result.value;
  }
}
