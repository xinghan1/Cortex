import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { ExternalAcpClient, killAntigravityProcessTree } from './antigravity-agent.mjs';
import { externalAgentPrompt } from './external-agent-context.mjs';

// Official ZCode app-server protocol, pinned source contract:
// https://github.com/zai-org/ZCode/tree/3c5b227649371507ddc4eb46ac5133afe6db1cab
// It is NOT ACP or a model API. The small wire adapter below shares only the
// bounded NDJSON process lifecycle with the ACP clients; native wire has no
// jsonrpc property and all task execution stays inside the official agent.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value);
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
const fail = (code, message) => Object.assign(new Error(`[${code}] ${message}`), { name: 'ZCodeAgentError', code });
const cancelled = () => Object.assign(fail('ZCODE_CANCELLED', 'ZCode 操作已取消。'), { name: 'AbortError' });
const invalid = () => fail('ZCODE_PROTOCOL_ERROR', '官方 ZCode 代理返回了无效协议数据。');
const MAX_FRAME = 16 * 1024 * 1024;
function officialAuthorizationUrl(raw, region) {
  const bad = () => fail('ZCODE_AUTH_URL_INVALID', '官方 ZCode 未返回有效的授权页面，请重试登录。');
  if (typeof raw !== 'string' || raw.length > 8192 || /\s|[\x00-\x1f\x7f]/u.test(raw)) throw bad();
  let url; try { url = new URL(raw); } catch { throw bad(); }
  const allowed = region === 'bigmodel' ? url.hostname === 'bigmodel.cn' && url.pathname === '/login'
    : url.hostname === 'chat.z.ai' && ['/api/oauth/authorize', '/oauth/authorize'].includes(url.pathname);
  if (!allowed || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw bad();
  return raw;
}
function safeError(error) {
  if (error?.name === 'ZCodeAgentError') return error;
  if (error?.name === 'AbortError') return cancelled();
  const suffix = typeof error?.code === 'string' ? error.code.replace(/^AGY_/u, '') : '';
  return fail(['TIMEOUT', 'EXITED', 'START_FAILED', 'RESPONSE_TOO_LARGE', 'CALLBACK_FAILED', 'PROTOCOL_ERROR'].includes(suffix) ? 'ZCODE_' + suffix : 'ZCODE_REQUEST_FAILED', '官方 ZCode 代理请求未完成，请检查账号或重试。');
}
function check(signal) { if (signal?.aborted) throw cancelled(); }
function waitFor(operation, signal) {
  check(signal);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => { if (done) return; done = true; signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => finish(cancelled()); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) return abort();
    Promise.resolve().then(operation).then(value => finish(null, value), error => finish(error));
  });
}
function rpcError(_method, error) {
  const code = error?.data?.code || error?.code;
  return fail(['auth_required', 'unauthorized', 'account-connection-unavailable'].includes(code) || /\b(?:unauthenticated|login required|not logged in)\b/iu.test(String(error?.message || '').slice(0, 8192))
    ? 'ZCODE_AUTH_REQUIRED' : 'ZCODE_REQUEST_FAILED', '官方 ZCode 账号或任务请求未完成，请检查登录状态后重试。');
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function lineTransform(convert) {
  const decoder = new StringDecoder('utf8'); let buffer = '';
  return new Transform({ transform(chunk, _encoding, callback) {
    try {
      buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); let split;
      while ((split = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); if (!line.trim()) continue;
        if (Buffer.byteLength(line) > MAX_FRAME) throw invalid();
        const value = JSON.parse(line); if (!object(value)) throw invalid();
        this.push(JSON.stringify(convert(value)) + '\n');
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME) throw invalid(); callback();
    } catch { callback(invalid()); }
  }, flush(callback) { if (buffer.trim()) callback(invalid()); else callback(); } });
}
function adaptProcess(child) {
  const input = lineTransform(value => { const copy = { ...value }; delete copy.jsonrpc; return copy; });
  const output = lineTransform(value => ({ ...value, jsonrpc: '2.0', ...(value.method === 'session/event' ? { method: 'session/update' } : {}) }));
  input.pipe(child.stdin); child.stdout.pipe(output);
  // Route transform failures through the real process emitter so the shared
  // lifecycle closes the entire process tree; do not leave a stuck prompt.
  input.on('error', () => child.emit('error', invalid())); output.on('error', () => child.emit('error', invalid()));
  child.stdin.on('error', () => input.destroy()); child.stdout.on('error', () => output.destroy());
  return { pid: child.pid, stdin: input, stdout: output, stderr: child.stderr,
    on: child.on.bind(child), once: child.once.bind(child), kill: child.kill.bind(child),
    get exitCode() { return child.exitCode; } };
}
function selectionId(ref) { return `${ref.providerId}/${ref.modelId}${ref.options?.reasoningLevel ? '$' + ref.options.reasoningLevel : ''}`; }
function executableModelRef(row, current) {
  const ref = structuredClone(row.ref), explicit = ref.options?.reasoningLevel;
  if (ref.options !== undefined && (!object(ref.options) || Object.keys(ref.options).some(key => key !== 'reasoningLevel'))
      || explicit !== undefined && !id(explicit)) return null;
  if (row.reasoning === undefined) return ref; // Legacy protocol metadata: do not invent an option.
  const reasoning = row.reasoning;
  if (!object(reasoning) || !Array.isArray(reasoning.levels) || !reasoning.levels.length || reasoning.levels.length > 128) return null;
  const levels = reasoning.levels.map(level => level?.value);
  if (levels.some(value => !id(value)) || new Set(levels).size !== levels.length) return null;
  if (explicit !== undefined) return levels.includes(explicit) ? ref : null;
  let selected = reasoning.defaultLevel;
  if (selected === undefined && current?.providerId === ref.providerId && current?.modelId === ref.modelId) selected = current.options?.reasoningLevel;
  if (!id(selected) || !levels.includes(selected)) return null;
  return { ...ref, options: { reasoningLevel: selected } };
}
function readCatalog(snapshot, providerId) {
  const rows = snapshot?.settings?.model?.available;
  if (!Array.isArray(rows) || rows.length > 512) return new Map();
  const result = new Map();
  for (const row of rows) {
    const ref = row?.ref;
    if (!object(ref) || !id(ref.providerId) || !id(ref.modelId) || ref.providerId !== providerId || row.disabledReason) continue;
    const executionRef = executableModelRef(row, snapshot.settings.model.current); if (!executionRef) continue;
    const key = selectionId(ref); if (!id(key) || result.has(key)) throw invalid();
    result.set(key, { ref: executionRef, model: { id: key, displayName: id(row.label) ? row.label : key,
      compatible: true, textCompatible: true, supportsTools: true,
      // This first app-server bridge accepts text content only. Do not advertise
      // the native model's image ability before attachment transport is wired.
      supportsImages: false, reasoningEfforts: [],
      ...(Number.isSafeInteger(row.contextWindow) && row.contextWindow > 0 ? { contextWindow: row.contextWindow } : {}),
      ...(Number.isSafeInteger(row.maxOutputTokens) && row.maxOutputTokens > 0 ? { maxOutputTokens: row.maxOutputTokens } : {}) } });
  }
  return result;
}

export class ZCodeAgent {
  #dir; #file; #runtime; #spawn; #kill; #proxy; #onChange; #onEvent; #permission; #userInput; #openExternal;
  #profile = null; #region = 'bigmodel'; #providerId = null; #initialized = null; #storageError = false; #error = null;
  #client = null; #starting = null; #startup = null; #attempt = null; #epoch = 0; #closed = false;
  #sessions = new Map(); #models = new Map(); #active = null; #closing = new Set(); #timeout; #startTimeout; #stopGrace;
  constructor({ dataDir, runtime, spawnImpl = spawn, killTreeImpl, getProxyEnv = () => ({}), openExternal, onChange = () => {}, onEvent = () => {}, onPermission = async () => null, onUserInput = async () => ({ action: 'cancel' }),
    platform = process.platform, requestTimeoutMs = 3600000, startTimeoutMs = 60000, stopGraceMs = 1500 } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || !runtime?.ensure || !runtime?.publicState || typeof spawnImpl !== 'function'
        || ![getProxyEnv, onChange, onEvent, onPermission, onUserInput].every(value => typeof value === 'function') || openExternal !== undefined && typeof openExternal !== 'function'
        || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 86400000
        || ![startTimeoutMs, stopGraceMs].every(value => Number.isInteger(value) && value > 0 && value <= 600000)) throw fail('ZCODE_INVALID_INPUT', 'ZCode 代理配置无效。');
    this.#dir = path.join(path.resolve(dataDir), 'zcode-agent'); this.#file = path.join(this.#dir, 'connection.json'); this.#runtime = runtime;
    this.#spawn = spawnImpl; this.#kill = killTreeImpl || (child => killAntigravityProcessTree(child, { platform })); this.#proxy = getProxyEnv;
    this.#onChange = onChange; this.#onEvent = onEvent; this.#permission = onPermission; this.#userInput = onUserInput; this.#openExternal = openExternal;
    this.#timeout = requestTimeoutMs; this.#startTimeout = startTimeoutMs; this.#stopGrace = stopGraceMs;
  }
  #changed() { try { Promise.resolve(this.#onChange()).catch(() => {}); } catch {} }
  #publishError(error, phase) { const safe = safeError(error); this.#error = { code: safe.code, message: safe.message, phase }; this.#changed(); return safe; }
  async #mkdir(directory) { await fs.mkdir(directory, { recursive: true }); const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('ZCODE_STORAGE_ERROR', 'ZCode 本机目录不可用。'); }
  #home(profile = this.#profile) { if (!UUID.test(profile || '')) throw fail('ZCODE_AUTH_REQUIRED', '请先连接官方 ZCode 账号。'); return path.join(this.#dir, 'profiles', profile); }
  init() {
    return this.#initialized ??= (async () => {
      await this.#runtime.init?.();
      try {
        const stat = await fs.lstat(this.#file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw invalid();
        const value = JSON.parse(await fs.readFile(this.#file, 'utf8'));
        if (!object(value) || value.version !== 1 || !Object.hasOwn(value, 'profileId') || value.profileId !== null && !UUID.test(value.profileId)
            || !['bigmodel', 'zai'].includes(value.region) || ![3, 4].includes(Object.keys(value).length)
            || value.providerId !== undefined && value.providerId !== null && !id(value.providerId)) throw invalid();
        if (value.profileId) { const home = await fs.lstat(this.#home(value.profileId)); if (!home.isDirectory() || home.isSymbolicLink()) throw invalid(); }
        this.#profile = value.profileId; this.#region = value.region; this.#providerId = value.providerId || null;
      } catch (error) { if (error.code !== 'ENOENT') { this.#storageError = true; this.#publishError(fail('ZCODE_STORAGE_ERROR', 'ZCode 连接信息无法读取，原文件已保留。'), 'storage'); } }
      if (this.#profile && !this.#storageError) {
        // Upgrades replace the bundled component digest. Restore that local
        // component before the UI checks readiness of an existing account.
        // This only copies verified bundled files; it never starts the agent.
        const signal = AbortSignal.timeout(30000);
        try { await waitFor(() => this.#runtime.ensure({ signal }), signal); }
        catch { this.#publishError(fail('ZCODE_RUNTIME_MISSING', 'ZCode 本机组件未准备完成，请点击“准备组件”后重试。'), 'runtime'); }
      }
      return this;
    })();
  }
  async publicState() { await this.init(); return { runtime: await this.#runtime.publicState(), region: this.#attempt?.region || this.#region,
    session: { status: this.#attempt ? 'connecting' : this.#storageError || this.#error?.code === 'ZCODE_AUTH_REQUIRED' ? 'reauth_required' : this.#profile ? 'connected' : 'disconnected', sharing: Boolean(this.#profile) && !this.#storageError && this.#error?.code !== 'ZCODE_AUTH_REQUIRED', profileId: this.#profile },
    attempt: this.#attempt ? { phase: this.#attempt.phase } : null, error: this.#error ? { ...this.#error } : null, storageRecovery: this.#storageError,
    storage: { owner: 'official-agent', homeIsolated: true, credentialScope: 'isolated-official-store', identityVerified: false }, models: [...this.#models.values()].map(row => structuredClone(row.model)) }; }
  async #save(profile, region, providerId = this.#providerId) {
    await this.#mkdir(this.#dir); const stat = await fs.lstat(this.#file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw fail('ZCODE_STORAGE_ERROR', 'ZCode 连接信息无法保存。');
    const temporary = path.join(this.#dir, `.connection-${randomUUID()}.tmp`);
    try { await fs.writeFile(temporary, JSON.stringify({ version: 1, profileId: profile, region, providerId: profile ? providerId : null }) + '\n', { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, this.#file); }
    catch { throw fail('ZCODE_STORAGE_ERROR', 'ZCode 连接信息无法保存，请检查软件数据目录。'); }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  async #environment(profile, runtime, signal) {
    const home = this.#home(profile), work = path.join(home, 'work'); await this.#mkdir(this.#dir); await this.#mkdir(path.join(this.#dir, 'profiles')); await this.#mkdir(home); await this.#mkdir(work);
    // The official login command searches ancestors for .env. An empty owned
    // sentinel prevents importing any unrelated project/account environment.
    const sentinel = path.join(work, '.env'), stat = await fs.lstat(sentinel).catch(() => null);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw fail('ZCODE_STORAGE_ERROR', 'ZCode 登录工作目录不可用。');
    await fs.writeFile(sentinel, '', { mode: 0o600 });
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|appdata|localappdata|lang|lc_all|https?_proxy|all_proxy|no_proxy|node_extra_ca_certs)$/iu.test(key) && typeof value === 'string'));
    const proxy = await waitFor(() => this.#proxy(), signal); check(signal);
    if (object(proxy)) for (const [key, value] of Object.entries(proxy)) if (/^(?:https?_proxy|all_proxy|no_proxy)$/iu.test(key) && typeof value === 'string' && value.length <= 4096 && !/[\x00-\x1f]/u.test(value)) env[key] = value;
    // The official CLI intentionally removes standard shell proxy variables.
    // Its public runtime contract uses these app-controlled dedicated names.
    const selectedProxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy;
    if (selectedProxy) env.ZCODE_HTTP_PROXY = selectedProxy;
    const noProxy = env.NO_PROXY || env.no_proxy; if (noProxy) env.ZCODE_NO_PROXY = noProxy;
    Object.assign(env, { HOME: home, USERPROFILE: home, ZCODE_HOME: path.join(home, '.zcode'), ZCODE_DATA_BASE_DIR: home,
      ZCODE_STORAGE_DIR: path.join(home, '.zcode'), ZCODE_RUNTIME_ENV: 'production', SYNORA_ZCODE_STANDALONE_ACCOUNT: '1' });
    if (object(runtime.env)) for (const key of ['ELECTRON_RUN_AS_NODE', 'GEMINI_CLI_NO_RELAUNCH']) if (runtime.env[key] === '1') env[key] = '1';
    if (typeof runtime.env?.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE === 'string' && path.isAbsolute(runtime.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE)) {
      env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = runtime.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
      env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path.join(home, '.zcode', 'v2', 'provider_config.json');
      if (typeof runtime.env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE === 'string' && path.isAbsolute(runtime.env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE)) env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE = runtime.env.ZCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE;
    }
    return { env, cwd: work, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] };
  }
  async #removeProfile(profile) {
    const home = this.#home(profile), stat = await fs.lstat(home).catch(() => null); if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(await fs.realpath(home)).toLowerCase() !== (await fs.realpath(path.join(this.#dir, 'profiles'))).toLowerCase()) throw fail('ZCODE_STORAGE_ERROR', 'ZCode 临时账号目录无法安全清理。');
    await fs.rm(home, { recursive: true, force: true });
  }
  async initialize({ signal } = {}) {
    await this.init(); check(signal); if (this.#closed) throw fail('ZCODE_CLOSED', 'ZCode 代理已关闭。');
    if (this.#client?.alive) return this.#client; if (this.#starting) return waitFor(() => this.#starting, signal);
    if (!this.#profile) throw fail('ZCODE_AUTH_REQUIRED', '请先登录官方 ZCode 账号。');
    const profile = this.#profile, epoch = this.#epoch, controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); this.#startup = controller;
    this.#starting = (async () => {
      let client;
      try {
        await waitFor(() => Promise.allSettled([...this.#closing]), controller.signal);
        const runtime = await this.#runtime.ensure({ signal: controller.signal }), options = await this.#environment(profile, runtime, controller.signal);
        client = new ExternalAcpClient({ entry: runtime.entry, args: [...runtime.args || [], 'app-server'], options,
          spawnImpl: (entry, args, spawnOptions) => adaptProcess(this.#spawn(entry, args, spawnOptions)), killTree: this.#kill, rpcError,
          onUpdate: event => this.#event(event), onRequest: (method, params) => this.#reverse(method, params), onFailure: error => {
            if (client) { const closing = client.close(error); this.#closing.add(closing); closing.finally(() => this.#closing.delete(closing)).catch(() => {}); }
            this.#active?.completion.reject(safeError(error)); if (this.#client === client) { this.#client = null; this.#sessions.clear(); }
          } });
        const result = await client.request('runtime/capabilities', {}, { signal: controller.signal, timeoutMs: this.#startTimeout });
        if (!object(result) || result.independentPlanState !== true || result.historyFirst !== true) throw invalid();
        check(controller.signal); if (profile !== this.#profile || epoch !== this.#epoch || this.#closed) throw cancelled();
        this.#client = client; this.#sessions.clear(); return client;
      } catch (error) { await client?.close(error).catch(() => {}); throw safeError(error); }
      finally { signal?.removeEventListener('abort', abort); this.#starting = null; this.#startup = null; }
    })(); return this.#starting;
  }
  signIn({ region = 'bigmodel', signal } = {}) {
    if (this.#attempt) return this.#attempt.done; if (this.#active) return Promise.reject(fail('ZCODE_BUSY', '请先停止 ZCode 代理任务。'));
    if (!['bigmodel', 'zai'].includes(region)) return Promise.reject(fail('ZCODE_INVALID_INPUT', '请选择智谱或 Z.AI 账号。'));
    const controller = new AbortController(), abort = () => controller.abort(), profile = randomUUID();
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const attempt = { controller, region, phase: 'initializing' }; this.#attempt = attempt; const epoch = ++this.#epoch; this.#models.clear(); this.#sessions.clear(); this.#error = null; this.#changed();
    attempt.done = (async () => {
      let child;
      try {
        await this.init(); check(controller.signal); if (this.#closed) throw fail('ZCODE_CLOSED', 'ZCode 代理已关闭。');
        if (this.#storageError) throw fail('ZCODE_STORAGE_ERROR', '请先恢复 ZCode 连接信息。');
        await this.#shutdown(); const runtime = await this.#runtime.ensure({ signal: controller.signal }), options = await this.#environment(profile, runtime, controller.signal);
        attempt.phase = 'waiting-browser'; this.#changed();
        let buffer = '', urlSeen = false, opening = null; const decoder = new StringDecoder('utf8');
        const acknowledged = new Promise((resolve, reject) => {
          try { child = this.#spawn(runtime.entry, [...runtime.args || [], 'login', region, '--json', ...(this.#openExternal ? ['--no-browser'] : [])], options); } catch { reject(fail('ZCODE_START_FAILED', '无法启动官方 ZCode 登录。')); return; }
          child.stdout.on('data', bytes => { buffer += decoder.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)); if (Buffer.byteLength(buffer) > 1024 * 1024) { reject(invalid()); void this.#kill(child); } });
          if (this.#openExternal) {
            // Official --json --no-browser prints this exact two-line banner to
            // stderr. Use the original URL instead of cmd.exe's START parser,
            // which can split an unquoted OAuth query at '&' on Windows.
            const stderrDecoder = new StringDecoder('utf8'); let pendingLine = '', expectingUrl = false;
            const line = value => {
              if (urlSeen || controller.signal.aborted || this.#attempt !== attempt || this.#epoch !== epoch || this.#closed) return;
              if (value === 'Open this URL to sign in:') { expectingUrl = true; return; }
              if (!expectingUrl || !value) return; expectingUrl = false;
              try {
                const target = officialAuthorizationUrl(value, region); urlSeen = true;
                opening = Promise.resolve().then(async () => {
                  check(controller.signal); if (this.#attempt !== attempt || this.#epoch !== epoch || this.#closed) throw cancelled();
                  try { await this.#openExternal(target); } catch { throw fail('ZCODE_BROWSER_OPEN_FAILED', '无法打开官方授权页面，请检查默认浏览器后重试。'); }
                });
                opening.catch(reject);
              } catch (error) { urlSeen = true; reject(error); }
            };
            child.stderr?.on('data', bytes => {
              if (controller.signal.aborted || this.#attempt !== attempt || urlSeen) return;
              pendingLine += stderrDecoder.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)); let split;
              while ((split = pendingLine.indexOf('\n')) >= 0) { const value = pendingLine.slice(0, split).replace(/\r$/u, ''); pendingLine = pendingLine.slice(split + 1); line(value); }
              if (pendingLine.length > 8192) { pendingLine = ''; reject(fail('ZCODE_AUTH_URL_INVALID', '官方 ZCode 未返回有效的授权页面，请重试登录。')); }
            });
            child.stderr?.once('end', () => { if (pendingLine) line(pendingLine.replace(/\r$/u, '')); });
          } else child.stderr?.on('data', () => {});
          child.on('error', () => reject(fail('ZCODE_START_FAILED', '官方 ZCode 登录程序无法运行。')));
          child.once('close', code => {
            if (code !== 0) return reject(fail('ZCODE_AUTH_FAILED', '官方 ZCode 账号授权未完成，请重试。'));
            try { const result = JSON.parse(buffer); if (result.status !== 'ready' || result.provider !== region || !id(result.user?.user_id) || !id(result.model) || result.model.indexOf('/') < 1) throw invalid(); resolve(result.model.slice(0, result.model.indexOf('/'))); } catch { reject(invalid()); }
          });
        });
        const timer = setTimeout(() => controller.abort(), 600000);
        let providerId; try {
          providerId = await waitFor(() => acknowledged, controller.signal);
          if (this.#openExternal) {
            if (!urlSeen) throw fail('ZCODE_AUTH_URL_INVALID', '官方 ZCode 未返回有效的授权页面，请重试登录。');
            await waitFor(() => opening, controller.signal);
          }
        } finally { clearTimeout(timer); }
        check(controller.signal); attempt.phase = 'committing'; this.#changed();
        const previousProfile = this.#profile, previousRegion = this.#region, previousProvider = this.#providerId;
        await this.#save(profile, region, providerId);
        if (controller.signal.aborted || this.#closed) { try { await this.#save(previousProfile, previousRegion, previousProvider); } catch { this.#storageError = true; throw fail('ZCODE_STORAGE_ERROR', '取消授权后无法恢复本机连接记录，请重试读取。'); } throw cancelled(); }
        this.#profile = profile; this.#region = region; this.#providerId = providerId; this.#error = null;
      } catch (error) { if (child && child.exitCode == null) await this.#kill(child); if (!controller.signal.aborted || this.#storageError) this.#publishError(error, attempt.phase === 'committing' ? 'storage' : 'authenticate'); if (this.#profile !== profile) await this.#removeProfile(profile).catch(() => {}); throw controller.signal.aborted && !this.#storageError ? cancelled() : safeError(error); }
      finally { if (child && child.exitCode == null) await this.#kill(child); signal?.removeEventListener('abort', abort); if (this.#attempt === attempt) this.#attempt = null; this.#changed(); }
      return this.publicState();
    })(); return attempt.done;
  }
  async cancelSignIn() { const attempt = this.#attempt; attempt?.controller.abort(); this.#startup?.abort(); await attempt?.done.catch(() => {}); return this.publicState(); }
  #usable() { if (this.#closed) throw fail('ZCODE_CLOSED', 'ZCode 代理已关闭。'); if (!this.#profile || this.#storageError || this.#error?.code === 'ZCODE_AUTH_REQUIRED') throw fail('ZCODE_AUTH_REQUIRED', '请先连接官方 ZCode 账号。'); if (this.#attempt) throw fail('ZCODE_BUSY', '请等待 ZCode 登录完成。'); return this.#profile; }
  async #newSession(client, cwd, signal) {
    const workspace = { workspacePath: cwd, workspaceKey: cwd };
    const snapshot = await client.request('session/create', { workspace, mode: 'guarded', persistence: 'deferred', titleGenerationEnabled: false }, { signal, timeoutMs: this.#startTimeout });
    if (snapshot?.protocol?.name !== 'ZCode Protocol' || snapshot.protocol.version !== 1 || !id(snapshot.session?.sessionId)) throw invalid();
    const providerId = this.#providerId || snapshot.settings?.model?.current?.providerId;
    const session = { id: snapshot.session.sessionId, cwd, profile: this.#profile, models: readCatalog(snapshot, providerId), mode: 'guarded', seq: 0 };
    if (!session.models.size) { this.#models.clear(); throw fail('ZCODE_CATALOG_EMPTY', 'ZCode 已连接，但官方会话没有返回可选模型，请刷新目录或检查账号权限。'); }
    const subscribed = await client.request('session/subscribe', { sessionId: session.id, deliveryKind: 'desktop-continuous', includeSnapshot: false }, { signal, timeoutMs: this.#startTimeout });
    if (subscribed?.sessionId !== session.id || !Array.isArray(subscribed.events) || !Number.isSafeInteger(subscribed.eventSeq)) throw invalid();
    session.seq = subscribed.eventSeq; return session;
  }
  async listModels({ cwd, signal } = {}) {
    await this.init(); const profile = this.#usable(), epoch = this.#epoch;
    if (this.#active) return [...this.#models.values()].map(row => structuredClone(row.model));
    cwd ||= path.join(this.#home(), 'work'); if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail('ZCODE_INVALID_INPUT', 'ZCode 工作目录无效。');
    try { const client = await this.initialize({ signal }), session = await this.#newSession(client, cwd, signal); if (profile !== this.#profile || epoch !== this.#epoch) throw cancelled(); this.#models = session.models; this.#error = null; this.#changed(); return [...this.#models.values()].map(row => structuredClone(row.model)); }
    catch (error) { if (error.name !== 'AbortError') this.#publishError(error, 'model-list'); throw safeError(error); }
  }
  #emit(update) {
    const active = this.#active; if (!active || active.controller.signal.aborted) return;
    const event = { localSessionId: active.localSessionId, sessionId: active.session.id, update };
    for (const callback of [active.onUpdate, this.#onEvent]) if (callback) { try { Promise.resolve(callback(event)).catch(() => { const error = fail('ZCODE_CALLBACK_FAILED', 'ZCode 会话显示失败，已停止。'); active.completion.reject(error); this.#client?.fail(error); }); } catch { const error = fail('ZCODE_CALLBACK_FAILED', 'ZCode 会话显示失败，已停止。'); active.completion.reject(error); this.#client?.fail(error); } }
  }
  #event(event) {
    const active = this.#active;
    if (!active || active.profile !== this.#profile || event?.sessionId !== active.session?.id || !active.sent || !object(event.payload)) return;
    if (!Number.isSafeInteger(event.seq) || event.seq <= active.session.seq) return; active.session.seq = event.seq;
    const payload = event.payload;
    if (event.type === 'turn.started') { if (payload.inputId && payload.inputId !== active.inputId) return; active.turnId = event.turnId; return; }
    if (!active.turnId || event.turnId && event.turnId !== active.turnId || payload.inputId && payload.inputId !== active.inputId) return;
    if (active.controller.signal.aborted) { if (['turn.completed', 'turn.failed'].includes(event.type)) active.completion.reject(cancelled()); return; }
    if (event.type === 'part.delta' && typeof payload.delta === 'string' && ['text', 'reasoning'].includes(payload.field || 'text')) {
      const thinking = payload.field === 'reasoning'; if (!thinking) active.text += payload.delta;
      this.#emit({ sessionUpdate: thinking ? 'agent_thought_chunk' : 'agent_message_chunk', content: { type: 'text', text: payload.delta } });
    } else if (event.type === 'tool.updated' && id(payload.toolCallId)) {
      const first = payload.kind === 'scheduled', kind = /read|glob|grep|search/iu.test(payload.toolName || '') ? 'read' : /write|edit|patch/iu.test(payload.toolName || '') ? 'edit' : /bash|shell|command/iu.test(payload.toolName || '') ? 'execute' : 'other';
      this.#emit({ sessionUpdate: first ? 'tool_call' : 'tool_call_update', toolCallId: payload.toolCallId,
        ...(payload.toolName ? { title: payload.toolName, kind } : {}), status: payload.kind === 'result' ? 'completed' : payload.kind === 'error' ? 'failed' : 'in_progress',
        ...(first ? { rawInput: payload.input } : {}), ...(payload.kind === 'result' ? { rawOutput: payload.result } : {}),
        ...(payload.kind === 'progress' && (payload.stdoutTail || payload.stderrTail) ? { rawOutput: [payload.stdoutTail, payload.stderrTail].filter(Boolean).join('\n') } : {}) });
    } else if (event.type === 'turn.completed') {
      const response = typeof payload.response === 'string' ? payload.response : '';
      if (response && (!active.text || response.startsWith(active.text))) { const remaining = response.slice(active.text.length); if (remaining) this.#emit({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: remaining } }); }
      const raw = payload.usage, usage = object(raw) && Number.isSafeInteger(raw.inputTokens) && raw.inputTokens >= 0 && Number.isSafeInteger(raw.outputTokens) && raw.outputTokens >= 0 ? { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens } : null;
      if (payload.resultType === 'cancelled') active.completion.reject(cancelled());
      else if (payload.resultType !== 'success') active.completion.reject(fail('ZCODE_TASK_FAILED', '官方 ZCode 任务未完整完成。'));
      else active.completion.resolve({ sessionId: active.session.id, stopReason: 'end_turn', usage, usageReported: Boolean(usage) });
    } else if (event.type === 'turn.failed') active.completion.reject(fail('ZCODE_TASK_FAILED', '官方 ZCode 任务执行失败，请检查任务流程后重试。'));
  }
  async #reverse(method, params) {
    const active = this.#active, valid = active && !active.controller.signal.aborted && active.profile === this.#profile && params?.sessionId === active.session?.id
      && (!params.turnId || params.turnId === active.turnId);
    if (method === 'interaction/requestPermission') {
      const denied = { result: { decision: 'deny', reason: 'Request was cancelled or not approved' } };
      if (!valid || !Array.isArray(params.options) || !params.options.length || params.options.length > 64) return denied;
      const options = params.options.filter(option => object(option) && id(option.optionId) && object(option.response) && ['allow', 'deny'].includes(option.response.decision));
      if (options.length !== params.options.length || new Set(options.map(option => option.optionId)).size !== options.length) return denied;
      try {
        const selected = await waitFor(() => (active.onPermission || this.#permission)({ localSessionId: active.localSessionId, sessionId: active.session.id,
          toolCall: { toolCallId: params.toolCallId, title: params.toolName, kind: 'other', rawInput: params.input, reason: params.reason },
          options: options.map(option => ({ optionId: option.optionId, kind: option.response.decision === 'deny' ? 'reject_once' : option.kind === 'allow_once' ? 'allow_once' : 'allow_always', name: id(option.name) ? option.name : option.optionId })), signal: active.controller.signal }), active.controller.signal);
        if (active !== this.#active || active.controller.signal.aborted || active.profile !== this.#profile) return denied;
        const choice = options.find(option => option.optionId === selected); return choice ? { result: structuredClone(choice.response) } : denied;
      } catch { return denied; }
    }
    if (method === 'interaction/requestUserInput') {
      const denied = { result: { action: 'cancel' } }; if (!valid) return denied;
      try { const result = await waitFor(() => (active.onUserInput || this.#userInput)({ localSessionId: active.localSessionId, sessionId: active.session.id,
        questions: structuredClone(params.questions || []), prompt: typeof params.prompt === 'string' ? params.prompt : '', input: structuredClone(params.input), schema: structuredClone(params.schema), signal: active.controller.signal }), active.controller.signal);
        if (active !== this.#active || active.controller.signal.aborted || !object(result) || !['accept', 'decline', 'cancel'].includes(result.action)) return denied;
        if (result.action !== 'accept') return { result: { action: result.action } };
        if (!object(result.content) || Buffer.byteLength(JSON.stringify(result.content)) > 65536) return denied;
        return { result: { action: 'accept', content: structuredClone(result.content) } };
      } catch { return denied; }
    }
    // Credential/header providers and browser execution are NOT delegated to
    // Synora. The complete standalone official agent must own its own account.
    return { error: { code: -32601, message: 'Client capability unavailable' } };
  }
  async runTask({ localSessionId, cwd, prompt, contextMessages, attachments = [], modelId, modeId = 'guarded', signal, onUpdate, onPermission, onUserInput } = {}) {
    await this.init(); const profile = this.#usable(); check(signal);
    if (this.#active) throw fail('ZCODE_BUSY', 'ZCode 代理已有任务正在运行。');
    if (!id(localSessionId) || typeof cwd !== 'string' || !path.isAbsolute(cwd) || /[\x00\r\n]/u.test(cwd) || typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 4 * 1024 * 1024
        || !Array.isArray(attachments) || attachments.length || !['guarded', 'build', 'edit', 'plan'].includes(modeId)
        || [onUpdate, onPermission, onUserInput].some(value => value !== undefined && typeof value !== 'function')) throw fail('ZCODE_INVALID_INPUT', 'ZCode 任务或附件配置无效；当前官方代理仅支持文字任务。');
    const controller = new AbortController(), completion = deferred(); completion.promise.catch(() => {});
    const active = { localSessionId, profile, controller, completion, inputId: randomUUID(), onUpdate, onPermission, onUserInput, session: null, text: '', sent: false, turnId: null, done: null, stopping: null };
    const abort = () => { controller.abort(); void this.stop(); }; signal?.addEventListener('abort', abort, { once: true }); this.#active = active; this.#error = null; this.#changed();
    active.done = (async () => {
      let timer;
      try {
        const client = await this.initialize({ signal: controller.signal }); check(controller.signal);
        let session = this.#sessions.get(localSessionId);
        const fresh = !session || session.cwd !== cwd || session.profile !== profile;
        if (fresh) { session = await this.#newSession(client, cwd, controller.signal); this.#sessions.set(localSessionId, session); }
        check(controller.signal); if (profile !== this.#profile) throw cancelled(); active.session = session;
        if (modeId !== session.mode) { await client.request('session/setMode', { sessionId: session.id, mode: modeId }, { signal: controller.signal, timeoutMs: this.#startTimeout }); session.mode = modeId; }
        let selected; if (modelId) { selected = session.models.get(modelId)?.ref; if (!selected) throw fail('ZCODE_MODEL_UNAVAILABLE', '当前 ZCode 账号未提供所选模型，请刷新目录。'); }
        client.resetTurnLimit(); active.sent = true;
        timer = setTimeout(() => { completion.reject(fail('ZCODE_TIMEOUT', '官方 ZCode 任务超时，已停止。')); client.fail(fail('ZCODE_TIMEOUT', '官方 ZCode 任务超时，已停止。')); }, this.#timeout);
        const maxContextChars = Math.min(131072, Math.floor((4 * 1024 * 1024 - Buffer.byteLength(prompt)) / 3));
        const continuedPrompt = fresh && maxContextChars >= 512 ? externalAgentPrompt(prompt, contextMessages, { maxContextChars }) : prompt;
        const accepted = await client.request('session/send', { sessionId: session.id, inputId: active.inputId, content: continuedPrompt, ...(selected ? { modelSelection: selected } : {}) }, { timeoutMs: this.#startTimeout });
        if (accepted?.accepted !== true || accepted.sessionId !== session.id) throw invalid();
        const result = await completion.promise; check(controller.signal); return result;
      } catch (error) { if (!controller.signal.aborted && error.name !== 'AbortError') this.#publishError(error, 'task'); throw controller.signal.aborted ? cancelled() : safeError(error); }
      finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (this.#active === active) this.#active = null; this.#changed(); }
    })(); return active.done;
  }
  async stop() {
    const active = this.#active; if (!active) { this.#startup?.abort(); return; } if (active.stopping) return active.stopping;
    active.controller.abort(); active.stopping = (async () => {
      try { if (active.session?.id) void this.#client?.request('session/stop', { sessionId: active.session.id }, { timeoutMs: this.#stopGrace }).catch(() => {}); } catch {}
      let timer; await Promise.race([active.done?.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, this.#stopGrace); })]); clearTimeout(timer);
      if (this.#active === active) { active.completion.reject(cancelled()); await this.#shutdown(); }
      await active.done?.catch(() => {}); await Promise.allSettled([...this.#closing]);
    })(); return active.stopping;
  }
  async #shutdown() { this.#startup?.abort(); const client = this.#client; this.#client = null; this.#sessions.clear(); if (client) await client.close(); await Promise.allSettled([...this.#closing]); }
  async disconnect() { await this.init(); ++this.#epoch; this.#attempt?.controller.abort(); await this.stop(); await this.#attempt?.done.catch(() => {}); await this.#shutdown(); this.#profile = null; this.#providerId = null; this.#models.clear(); this.#error = null; if (!this.#storageError) await this.#save(null, this.#region); this.#changed(); return this.publicState(); }
  async retryLocalRead() { if (this.#active || this.#attempt) throw fail('ZCODE_BUSY', '请先停止 ZCode 任务或登录。'); await this.#shutdown(); this.#initialized = null; this.#profile = null; this.#storageError = false; this.#error = null; await this.init(); return this.publicState(); }
  async dispose() { if (this.#closed) return; this.#closed = true; this.#attempt?.controller.abort(); await this.stop(); await this.#attempt?.done.catch(() => {}); await this.#shutdown(); }
}
