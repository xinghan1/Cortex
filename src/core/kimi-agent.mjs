import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { ExternalAcpClient, killAntigravityProcessTree } from './antigravity-agent.mjs';
import { externalAgentPrompt } from './external-agent-context.mjs';
import { officialReasoningValue, acpModelOption, acpModelsWithReasoning, updateAcpConfig, requestAcpConfig, needsAcpReasoningReset, setAcpReasoning } from './official-agent-reasoning.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 512) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const identifier = value => text(value) && value.length > 0;
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u.test(value);
const regions = ['mainland-cn', 'global'];
const fail = (code, message) => Object.assign(new Error(`[${code}] ${message}`), { name: 'KimiError', code });
const cancelled = () => Object.assign(fail('KIMI_CANCELLED', 'Kimi 操作已取消。'), { name: 'AbortError' });
const invalid = () => fail('KIMI_PROTOCOL_ERROR', '官方 Kimi 代理返回了无效协议数据。');
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
function safeError(error) {
  if (error?.name === 'AbortError') return cancelled();
  if (error?.name === 'KimiError') return error;
  if (error?.code === 'AGY_TIMEOUT') return fail('KIMI_TIMEOUT', '官方 Kimi 请求超时，已停止代理。');
  if (error?.code === 'AGY_RESPONSE_TOO_LARGE') return fail('KIMI_RESPONSE_TOO_LARGE', '官方 Kimi 单轮输出过大，已停止。');
  return fail('KIMI_REQUEST_FAILED', '官方 Kimi 请求未完成，请检查账号和网络后重试。');
}
function rpcError(method, error) {
  if (error?.code === -32000 && typeof error.message === 'string'
      && error.message.includes('current subscription does not have access to Kimi Code'))
    return fail('KIMI_SUBSCRIPTION_REQUIRED', '账号已登录，但当前订阅没有 Kimi Code 访问权限，请在官方账号中确认 Coding 套餐。');
  if (error?.code === -32000) return fail('KIMI_AUTH_REQUIRED', '请通过官方 Kimi 登录后重试。');
  if (error?.code === -32602) return fail(method.startsWith('session/') ? 'KIMI_SESSION_FAILED' : 'KIMI_REQUEST_FAILED', '官方 Kimi 未接受此会话或配置，请刷新目录或开始新会话。');
  // Never expose remote error data: it may contain official account diagnostics.
  return fail('KIMI_REQUEST_FAILED', '官方 Kimi 请求未完成，请检查账号、套餐额度和网络后重试。');
}
function sessionMetadata(session, supportsImages) {
  const configOptions = Array.isArray(session?.configOptions) ? session.configOptions : [];
  if (configOptions.length > 256 || JSON.stringify(configOptions).length > 1024 * 1024) throw invalid();
  let rows = session?.models?.availableModels;
  if (!Array.isArray(rows)) {
    const option = acpModelOption({ configOptions });
    rows = option?.options?.flatMap(row => Array.isArray(row?.options) ? row.options : [row])?.map(row => ({ modelId: row?.value, name: row?.name }));
  }
  if (!Array.isArray(rows) || rows.length > 256) rows = [];
  const seen = new Set(), models = [];
  for (const row of rows) {
    if (!object(row) || !identifier(row.modelId) || seen.has(row.modelId)) throw invalid(); seen.add(row.modelId);
    models.push({ id: row.modelId, displayName: text(row.name, 256) && row.name ? row.name : row.modelId,
      compatible: true, textCompatible: true, supportsTools: true, supportsImages: Boolean(supportsImages), reasoningEfforts: [] });
  }
  const modes = (Array.isArray(session?.modes?.availableModes) ? session.modes.availableModes : []).slice(0, 64)
    .filter(row => identifier(row?.id)).map(row => ({ id: row.id, name: text(row.name, 256) ? row.name : row.id }));
  const currentModelId = acpModelOption({ configOptions })?.currentValue ?? session?.models?.currentModelId;
  return { models: acpModelsWithReasoning(models, { configOptions, currentModelId }), modes, currentModelId, configOptions: structuredClone(configOptions) };
}
function promptBlocks(prompt, attachments, capabilities) {
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 4 * 1024 * 1024 || !Array.isArray(attachments) || attachments.length > 20)
    throw fail('KIMI_INVALID_INPUT', 'Kimi 任务或附件格式无效。');
  const blocks = [{ type: 'text', text: prompt }]; let bytes = Buffer.byteLength(prompt);
  for (const item of attachments) {
    if (!object(item)) throw fail('KIMI_INVALID_INPUT', 'Kimi 附件格式无效。');
    let { mimeType, data } = item;
    if (typeof item.dataUrl === 'string') { const match = /^data:([a-z\d.+-]+\/[a-z\d.+-]+);base64,([A-Za-z\d+/=\r\n]+)$/iu.exec(item.dataUrl); if (!match) throw fail('KIMI_INVALID_INPUT', 'Kimi 附件格式无效。'); [, mimeType, data] = match; }
    if (typeof mimeType !== 'string' || !mimeType.startsWith('image/') || !capabilities?.promptCapabilities?.image) throw fail('KIMI_IMAGES_UNSUPPORTED', '官方 Kimi 代理不支持此附件类型。');
    if (typeof data !== 'string' || !data || data.length > 24 * 1024 * 1024 || !/^[A-Za-z\d+/]*={0,2}$/u.test(data.replace(/[\r\n]/gu, ''))) throw fail('KIMI_INVALID_INPUT', 'Kimi 附件数据无效。');
    bytes += data.length; if (bytes > 32 * 1024 * 1024) throw fail('KIMI_INVALID_INPUT', 'Kimi 附件总大小过大。');
    blocks.push({ type: 'image', mimeType, data: data.replace(/[\r\n]/gu, '') });
  }
  return blocks;
}
export function kimiLoginPublicLine(line) {
  if (typeof line !== 'string' || line.length > 16384) return null;
  const urlMatch = /^Opening browser for Kimi device login: (\S+)$/u.exec(line.trim());
  if (urlMatch) {
    try {
      const url = new URL(urlMatch[1]);
      if (url.protocol === 'https:' && ['auth.kimi.com', 'auth.kimi.ai'].includes(url.hostname) && !url.username && !url.password && !url.port && !url.hash
          && url.href.length <= 2048 && ![...url.searchParams.keys()].some(key => /token|secret|password|credential/iu.test(key))) return { verificationUrl: url.href };
    } catch { /* Only documented public login output is exposed. */ }
  }
  const code = /^If the browser did not open, paste the URL above and enter code: ([A-Z\d-]{4,32})$/u.exec(line.trim());
  return code ? { userCode: code[1] } : null;
}

// The original executable owns authentication and tools. This controller never
// reads its credentials, invokes a model API, or supplies Synora tool schemas.
export class KimiAgent {
  #dir; #profiles; #work; #file; #runtime; #spawn; #kill; #proxy; #onChange; #onEvent; #permission; #version; #platform;
  #client = null; #starting = null; #startup = null; #closing = new Set(); #capabilities = {}; #catalogCollectors = new Set();
  #profile = null; #region = 'mainland-cn'; #models = []; #modes = []; #sessions = new Map(); #active = null; #attempt = null;
  #epoch = 0; #closed = false; #state = 'idle'; #error = null; #storageError = false; #initialized = null; #writes = Promise.resolve();
  #timeout; #startTimeout; #loginTimeout; #stopGrace;
  constructor({ dataDir, runtime, spawnImpl = spawn, killTreeImpl, getProxyEnv = () => ({}), onChange = () => {}, onEvent = () => {}, onPermission = async () => null,
    version = '0.0.0', platform = process.platform, requestTimeoutMs = 3600000, startTimeoutMs = 60000, loginTimeoutMs = 600000, stopGraceMs = 1500 } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || !runtime?.ensure || !runtime?.publicState || typeof spawnImpl !== 'function'
        || typeof getProxyEnv !== 'function' || typeof onChange !== 'function' || typeof onEvent !== 'function' || typeof onPermission !== 'function' || !text(version, 80)
        || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 86400000
        || ![startTimeoutMs, loginTimeoutMs, stopGraceMs].every(value => Number.isInteger(value) && value > 0 && value <= 600000)
        || killTreeImpl !== undefined && typeof killTreeImpl !== 'function') throw fail('KIMI_INVALID_INPUT', 'Kimi 代理配置无效。');
    this.#dir = path.join(path.resolve(dataDir), 'kimi-agent'); this.#profiles = path.join(this.#dir, 'profiles'); this.#work = path.join(this.#dir, 'catalog-workspace'); this.#file = path.join(this.#dir, 'profiles.json');
    this.#runtime = runtime; this.#spawn = spawnImpl; this.#platform = platform; this.#kill = killTreeImpl || (child => killAntigravityProcessTree(child, { platform }));
    this.#proxy = getProxyEnv; this.#onChange = onChange; this.#onEvent = onEvent; this.#permission = onPermission; this.#version = version;
    this.#timeout = requestTimeoutMs; this.#startTimeout = startTimeoutMs; this.#loginTimeout = loginTimeoutMs; this.#stopGrace = stopGraceMs;
  }
  #changed() { try { Promise.resolve(this.#onChange()).catch(() => {}); } catch {} }
  #setError(error, phase) { const safe = safeError(error); this.#error = { code: safe.code, message: safe.message, phase }; this.#changed(); return safe; }
  async #mkdir(directory) { await fs.mkdir(directory, { recursive: true }); const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('KIMI_STORAGE_ERROR', 'Kimi 数据目录不可用。'); }
  async #read() {
    try {
      await this.#mkdir(this.#dir); await this.#mkdir(this.#profiles); await this.#mkdir(this.#work);
      const stat = await fs.lstat(this.#file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!stat) { this.#storageError = false; return; }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw invalid();
      const raw = await fs.readFile(this.#file, 'utf8'); if (Buffer.byteLength(raw) > 1024 * 1024) throw invalid();
      const value = JSON.parse(raw);
      if (!object(value) || value.version !== 1 || !(value.profileId === null || uuid(value.profileId)) || !regions.includes(value.region)
          || !Array.isArray(value.sessions) || value.sessions.length > 256) throw invalid();
      const sessions = new Map();
      for (const row of value.sessions) {
        if (!object(row) || !identifier(row.localSessionId) || !identifier(row.id) || typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd) || /[\x00\r\n]/u.test(row.cwd)
            || row.profile !== value.profileId || !uuid(row.profile) || sessions.has(row.localSessionId)) throw invalid();
        sessions.set(row.localSessionId, { id: row.id, cwd: row.cwd, profile: row.profile, live: false });
      }
      if (value.profileId) { const home = await fs.lstat(path.join(this.#profiles, value.profileId)); if (!home.isDirectory() || home.isSymbolicLink()) throw invalid(); }
      this.#profile = value.profileId; this.#region = value.region; this.#sessions = sessions; this.#storageError = false; this.#error = null;
    } catch { this.#storageError = true; this.#profile = null; this.#sessions.clear(); this.#error = { code: 'KIMI_STORAGE_UNREADABLE', message: '[KIMI_STORAGE_UNREADABLE] 无法读取 Kimi 连接记录，请重试读取或退出此连接。', phase: 'storage' }; }
  }
  async init() { if (!this.#initialized) this.#initialized = (async () => { await this.#runtime.init?.(); await this.#read(); return this; })(); return this.#initialized; }
  #save(signal) {
    this.#writes = this.#writes.catch(() => {}).then(async () => {
      const temporary = path.join(this.#dir, `.profiles-${randomUUID()}.json`);
      try {
        check(signal);
        await this.#mkdir(this.#dir);
        const value = { version: 1, profileId: this.#profile, region: this.#region, sessions: [...this.#sessions].slice(-256).map(([localSessionId, session]) => ({ localSessionId, id: session.id, cwd: session.cwd, profile: session.profile })) };
        const stat = await fs.lstat(this.#file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw invalid();
        await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); check(signal); await fs.rename(temporary, this.#file); this.#storageError = false;
      } catch (error) { if (error?.name === 'AbortError') throw cancelled(); this.#storageError = true; throw fail('KIMI_STORAGE_ERROR', '无法保存 Kimi 连接记录。'); }
      finally { await fs.unlink(temporary).catch(() => {}); }
    });
    return this.#writes;
  }
  async publicState() {
    await this.init();
    return { runtime: await this.#runtime.publicState(), region: this.#attempt?.region || this.#region,
      session: { status: this.#attempt ? 'connecting' : this.#storageError || this.#error?.code === 'KIMI_AUTH_REQUIRED' ? 'reauth_required' : this.#profile ? 'connected' : 'disconnected',
        sharing: Boolean(this.#profile) && !this.#storageError && this.#error?.code !== 'KIMI_AUTH_REQUIRED', profileId: this.#profile },
      attempt: this.#attempt ? { phase: this.#attempt.phase, ...(this.#attempt.verificationUrl ? { verificationUrl: this.#attempt.verificationUrl } : {}), ...(this.#attempt.userCode ? { userCode: this.#attempt.userCode } : {}) } : null,
      error: this.#error ? structuredClone(this.#error) : null, storageRecovery: this.#storageError,
      storage: { owner: 'official-agent', homeIsolated: true, credentialScope: 'app-isolated', identityVerified: false },
      status: this.#state, models: structuredClone(this.#models), modes: structuredClone(this.#modes), agent: { name: 'Kimi Code CLI', version: '2.3.1' } };
  }
  async #options(home, signal) {
    for (const directory of [this.#dir, this.#profiles, this.#work, home]) await this.#mkdir(directory);
    const proxy = await wait(() => this.#proxy(), signal); check(signal);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata|lang|lc_all|node_extra_ca_certs)$/iu.test(key) && typeof value === 'string'));
    if (object(proxy)) for (const [key, value] of Object.entries(proxy)) if (/^(?:https?_proxy|all_proxy|no_proxy)$/iu.test(key) && text(value, 4096)) env[key] = value;
    env.KIMI_CODE_HOME = home; env.KIMI_DISABLE_TELEMETRY = '1';
    return { cwd: this.#work, env, windowsHide: true, shell: false, detached: this.#platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] };
  }
  async initialize({ signal } = {}) {
    await this.init(); if (this.#closed) throw fail('KIMI_CLOSED', 'Kimi 代理已关闭。'); check(signal);
    if (this.#storageError) throw fail('KIMI_STORAGE_UNREADABLE', '无法读取 Kimi 连接记录，请先重试或退出连接。');
    if (this.#client?.alive) return this.#client;
    if (this.#starting) return wait(() => this.#starting, signal);
    const profile = this.#attempt?.profileId || this.#profile; if (!uuid(profile)) throw fail('KIMI_AUTH_REQUIRED', '请先连接官方 Kimi 账号。');
    const epoch = this.#epoch, controller = new AbortController(), abort = () => controller.abort(); this.#startup = controller;
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); this.#state = 'starting'; this.#changed();
    this.#starting = (async () => {
      let client;
      try {
        await wait(() => Promise.allSettled([...this.#closing]), controller.signal);
        const runtime = await this.#runtime.ensure({ signal: controller.signal }), options = await this.#options(path.join(this.#profiles, profile), controller.signal); check(controller.signal);
        client = new ExternalAcpClient({ entry: runtime.entry, args: ['acp'], options, spawnImpl: this.#spawn, killTree: this.#kill, rpcError,
          onUpdate: value => this.#update(value), onRequest: (method, value) => this.#request(method, value), onFailure: error => {
            if (client) { const closing = client.close(error); this.#closing.add(closing); closing.finally(() => this.#closing.delete(closing)).catch(() => {}); }
            if (this.#client === client) { this.#client = null; for (const session of this.#sessions.values()) session.live = false; this.#setError(error, 'connection'); }
          } });
        const initialized = await client.request('initialize', { protocolVersion: 1, clientInfo: { name: 'Cortex', version: this.#version },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: true } } }, { signal: controller.signal, timeoutMs: this.#startTimeout });
        check(controller.signal); if (epoch !== this.#epoch || this.#closed) throw cancelled();
        if (initialized?.protocolVersion !== 1 || initialized.agentInfo?.name !== 'Kimi Code CLI' || initialized.agentInfo?.version !== runtime.version
            || !Array.isArray(initialized.authMethods) || !initialized.authMethods.some(method => method?.id === 'login' && method?.type === 'terminal')) throw invalid();
        this.#capabilities = initialized.agentCapabilities || {}; this.#client = client; this.#state = 'ready'; this.#changed(); return client;
      } catch (error) { await client?.close(error).catch(() => {}); const safe = controller.signal.aborted ? cancelled() : safeError(error); if (safe.name !== 'AbortError') this.#setError(safe, 'initialize'); throw safe; }
      finally { signal?.removeEventListener('abort', abort); this.#starting = null; this.#startup = null; if (this.#state === 'starting') this.#state = 'idle'; this.#changed(); }
    })();
    return this.#starting;
  }
  async #login(attempt) {
    const { controller } = attempt, runtime = await this.#runtime.ensure({ signal: controller.signal }), options = await this.#options(path.join(this.#profiles, attempt.profileId), controller.signal); check(controller.signal);
    await new Promise((resolve, reject) => {
      let child, timer, done = false, count = 0, buffer = ''; const decoder = new StringDecoder('utf8');
      const finish = (error) => { if (done) return; done = true; clearTimeout(timer); controller.signal.removeEventListener('abort', abort); void this.#kill(child).catch(() => {}).then(() => { for (const stream of [child?.stdin, child?.stdout, child?.stderr]) { try { stream?.destroy?.(); } catch {} } error ? reject(error) : resolve(); }); };
      const abort = () => finish(cancelled());
      try { child = this.#spawn(runtime.entry, ['acp', '--login', '--region', attempt.region], options); }
      catch { return finish(fail('KIMI_START_FAILED', '无法启动官方 Kimi 登录。')); }
      if (!child?.stderr?.on || !child?.stdout?.on || !child?.once) return finish(fail('KIMI_START_FAILED', '官方 Kimi 登录进程不可用。'));
      const consume = (bytes, visible) => {
        count += bytes.length; if (count > 2 * 1024 * 1024) return finish(fail('KIMI_AUTH_FAILED', '官方 Kimi 登录输出异常，已停止。'));
        if (!visible) return;
        buffer += decoder.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)); if (buffer.length > 16384 && !buffer.includes('\n')) return finish(fail('KIMI_AUTH_FAILED', '官方 Kimi 登录输出异常，已停止。'));
        let split; while ((split = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, split); buffer = buffer.slice(split + 1); const fields = kimiLoginPublicLine(line); if (fields && this.#attempt === attempt && !controller.signal.aborted) { Object.assign(attempt, fields); attempt.phase = 'waiting-browser'; this.#changed(); } }
      };
      child.stderr.on('data', bytes => consume(bytes, true)); child.stdout.on('data', bytes => consume(bytes, false));
      child.once('error', () => finish(fail('KIMI_START_FAILED', '官方 Kimi 登录进程无法运行。')));
      child.once('close', code => finish(controller.signal.aborted ? cancelled() : code === 0 ? null : fail('KIMI_AUTH_FAILED', '官方 Kimi 登录未完成，请重试。')));
      controller.signal.addEventListener('abort', abort, { once: true }); if (controller.signal.aborted) abort();
      timer = setTimeout(() => finish(fail('KIMI_TIMEOUT', 'Kimi 登录等待超时，请重新登录。')), this.#loginTimeout);
    });
  }
  async signIn({ signal, region = this.#region } = {}) {
    const epoch = this.#epoch;
    await this.init(); check(signal); if (this.#closed) throw fail('KIMI_CLOSED', 'Kimi 代理已关闭。');
    if (!regions.includes(region)) throw fail('KIMI_INVALID_INPUT', '请选择 Kimi 中国大陆或国际账号区域。');
    if (this.#storageError) throw fail('KIMI_STORAGE_UNREADABLE', '无法读取 Kimi 连接记录，请先重试或退出连接。');
    if (this.#attempt) return this.#attempt.done;
    if (epoch !== this.#epoch) throw cancelled();
    if (this.#active) throw fail('KIMI_BUSY', '请先停止正在运行的 Kimi 任务。');
    const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const previous = { profile: this.#profile, region: this.#region, sessions: this.#sessions };
    const attempt = { controller, profileId: randomUUID(), region, phase: 'starting' }; this.#attempt = attempt; this.#models = []; this.#modes = []; this.#error = null; this.#changed();
    attempt.done = (async () => {
      let committed = false, staged = false;
      try {
        ++this.#epoch; await this.#shutdown(); check(controller.signal);
        // Validate the unmodified runtime and official terminal auth contract.
        await this.initialize({ signal: controller.signal }); await this.#shutdown(); check(controller.signal);
        this.#state = 'authenticating'; await this.#login(attempt); check(controller.signal);
        const client = await this.initialize({ signal: controller.signal });
        await client.request('authenticate', { methodId: 'login' }, { signal: controller.signal, timeoutMs: this.#startTimeout }); check(controller.signal);
        if (this.#attempt !== attempt || this.#closed) throw cancelled();
        this.#profile = attempt.profileId; this.#region = region; ++this.#epoch; this.#sessions = new Map(); staged = true;
        await this.#save(controller.signal); check(controller.signal); if (this.#attempt !== attempt || this.#closed) throw cancelled();
        committed = true; this.#error = null;
      } catch (error) {
        await this.#shutdown(); let rollbackError;
        if (!committed) { this.#profile = previous.profile; this.#region = previous.region; this.#sessions = previous.sessions;
          // Cancellation can land while the atomic rename itself is pending.
          // Restore the old on-disk pointer as well as the visible generation.
          if (staged) { try { await this.#save(); } catch (failure) { rollbackError = failure; } }
        }
        const safe = rollbackError ? safeError(rollbackError) : controller.signal.aborted ? cancelled() : safeError(error); if (safe.name !== 'AbortError') this.#setError(safe, 'authenticate'); throw safe;
      }
      finally { signal?.removeEventListener('abort', abort); if (this.#attempt === attempt) this.#attempt = null; this.#state = this.#client?.alive ? 'ready' : 'idle'; this.#changed(); }
      return this.publicState();
    })();
    return attempt.done;
  }
  async cancelSignIn() { ++this.#epoch; this.#attempt?.controller.abort(); this.#startup?.abort(); await this.#attempt?.done.catch(() => {}); return this.publicState(); }
  #usable() { if (this.#closed) throw fail('KIMI_CLOSED', 'Kimi 代理已关闭。'); if (!this.#profile || this.#storageError || this.#error?.code === 'KIMI_AUTH_REQUIRED') throw fail('KIMI_AUTH_REQUIRED', '请先连接官方 Kimi 账号。'); if (this.#attempt) throw fail('KIMI_BUSY', '请等待 Kimi 登录完成。'); return this.#profile; }
  async #session(client, cwd, signal, existing) {
    let response; const updates = new Map();
    const collect = params => { if (identifier(params?.sessionId) && params.update?.sessionUpdate === 'config_option_update' && (updates.has(params.sessionId) || updates.size < 8)) updates.set(params.sessionId, params.update.configOptions); };
    this.#catalogCollectors.add(collect);
    try {
      if (existing) {
        try { response = await client.request('session/resume', { sessionId: existing.id, cwd, mcpServers: [] }, { signal, timeoutMs: this.#startTimeout }); }
        catch (error) { if (error?.code !== 'KIMI_SESSION_FAILED' || signal?.aborted) throw error; existing = null; }
      }
      if (!existing) response = await client.request('session/new', { cwd, mcpServers: [] }, { signal, timeoutMs: this.#startTimeout });
      const id = existing?.id || response?.sessionId; if (!identifier(id)) throw invalid();
      if (updates.has(id)) response = { ...response, configOptions: updates.get(id) };
      return { id, cwd, profile: this.#profile, live: true, fresh: !existing, resumed: Boolean(existing), ...sessionMetadata(response, this.#capabilities?.promptCapabilities?.image) };
    } finally { this.#catalogCollectors.delete(collect); }
  }
  async #selectModel(client, session, modelId, signal) {
    if (!session.models.some(model => model.id === modelId)) throw fail('KIMI_MODEL_UNAVAILABLE', 'Kimi 账号未提供所选模型，请刷新目录。');
    const option = acpModelOption(session);
    await requestAcpConfig({ client, session, method: option?.id ? 'session/set_config_option' : 'session/set_model',
      params: option?.id ? { sessionId: session.id, configId: option.id, value: modelId } : { sessionId: session.id, modelId },
      options: { signal, timeoutMs: this.#startTimeout }, collectors: this.#catalogCollectors, modelId });
  }
  async listModels({ cwd = this.#work, modelId, signal } = {}) {
    await this.init(); const profile = this.#usable(), epoch = this.#epoch; check(signal);
    if (this.#active) return structuredClone(this.#models);
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || /[\x00\r\n]/u.test(cwd) || modelId !== undefined && !identifier(modelId)) throw fail('KIMI_INVALID_INPUT', 'Kimi 工作目录或模型无效。');
    let session, client;
    try {
      client = await this.initialize({ signal }); await client.request('authenticate', { methodId: 'login' }, { signal, timeoutMs: this.#startTimeout });
      session = await this.#session(client, cwd, signal); if (modelId) await this.#selectModel(client, session, modelId, signal);
      check(signal); if (profile !== this.#profile || epoch !== this.#epoch) throw cancelled();
      this.#models = session.models; this.#modes = session.modes; this.#error = null; this.#changed(); return structuredClone(this.#models);
    } catch (error) { const safe = safeError(error); if (safe.name !== 'AbortError') this.#setError(safe, 'model-list'); throw safe; }
    finally { if (session && client?.alive) await client.request('session/close', { sessionId: session.id }, { timeoutMs: this.#startTimeout }).catch(() => {}); }
  }
  #update(params) {
    for (const collect of this.#catalogCollectors) collect(params);
    const active = this.#active;
    if (!active || active.controller.signal.aborted || active.profile !== this.#profile || params?.sessionId !== active.session?.id || !object(params.update)) return;
    if (!identifier(params.update.sessionUpdate)) throw invalid();
    if (params.update.sessionUpdate === 'config_option_update') { updateAcpConfig(active.session, params.update.configOptions); this.#models = active.session.models; this.#changed(); }
    const event = { localSessionId: active.localSessionId, sessionId: active.session.id, update: structuredClone(params.update) };
    for (const callback of [active.onUpdate, this.#onEvent]) if (callback) {
      try { Promise.resolve(callback(event)).catch(() => this.#client?.fail(fail('KIMI_CALLBACK_FAILED', 'Kimi 会话显示失败，已停止。'))); }
      catch { throw fail('KIMI_CALLBACK_FAILED', 'Kimi 会话显示失败，已停止。'); }
    }
  }
  async #request(method, params) {
    if (method !== 'session/request_permission') return { error: { code: -32601, message: 'Client capability unavailable' } };
    const active = this.#active, denied = { result: { outcome: { outcome: 'cancelled' } } };
    if (!active || active.controller.signal.aborted || active.profile !== this.#profile || params?.sessionId !== active.session?.id || !object(params.toolCall)
        || !Array.isArray(params.options) || !params.options.length || params.options.length > 64) return denied;
    const options = params.options.filter(option => object(option) && identifier(option.optionId) && ['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind))
      .map(option => ({ optionId: option.optionId, kind: option.kind, name: text(option.name, 1024) ? option.name : option.kind }));
    if (options.length !== params.options.length || new Set(options.map(option => option.optionId)).size !== options.length) return denied;
    try {
      const selected = await wait(() => (active.onPermission || this.#permission)({ localSessionId: active.localSessionId, sessionId: active.session.id,
        toolCall: structuredClone(params.toolCall), options, signal: active.controller.signal }), active.controller.signal);
      if (active !== this.#active || active.controller.signal.aborted || active.profile !== this.#profile || !options.some(option => option.optionId === selected)) return denied;
      return { result: { outcome: { outcome: 'selected', optionId: selected } } };
    } catch { return denied; }
  }
  async runTask({ localSessionId, cwd, prompt, contextMessages, attachments = [], modelId, reasoningEffort = 'default', modeId, signal, onUpdate, onPermission } = {}) {
    await this.init(); const profile = this.#usable(); check(signal);
    if (this.#active) throw fail('KIMI_BUSY', 'Kimi 代理已有任务正在运行。');
    if (!identifier(localSessionId) || typeof cwd !== 'string' || !path.isAbsolute(cwd) || /[\x00\r\n]/u.test(cwd) || modelId !== undefined && !identifier(modelId) || !officialReasoningValue(reasoningEffort)
        || modeId !== undefined && !identifier(modeId) || onUpdate !== undefined && typeof onUpdate !== 'function' || onPermission !== undefined && typeof onPermission !== 'function') throw fail('KIMI_INVALID_INPUT', 'Kimi 任务配置无效。');
    promptBlocks(prompt, attachments, { promptCapabilities: { image: true } });
    const controller = new AbortController(), active = { profile, controller, localSessionId, onUpdate, onPermission, session: null, done: null, stopping: null };
    const abort = () => { controller.abort(); void this.stop(); }; signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) controller.abort();
    this.#active = active; this.#state = 'running'; this.#error = null; this.#changed();
    active.done = (async () => {
      try {
        const client = await this.initialize({ signal: controller.signal });
        await client.request('authenticate', { methodId: 'login' }, { signal: controller.signal, timeoutMs: this.#startTimeout }); check(controller.signal);
        if (profile !== this.#profile || active !== this.#active) throw cancelled();
        let session = this.#sessions.get(localSessionId), fresh = false;
        if (session && (session.profile !== profile || session.cwd !== cwd)) throw fail('KIMI_SESSION_CHANGED', 'Kimi 会话所属账号或项目已改变，请开始新会话。');
        if (!session?.live) { session = await this.#session(client, cwd, controller.signal, session); fresh = session.fresh; check(controller.signal); if (profile !== this.#profile) throw cancelled(); this.#sessions.set(localSessionId, session); if (this.#sessions.size > 256) this.#sessions.delete(this.#sessions.keys().next().value); await this.#save(); }
        if (needsAcpReasoningReset(session, reasoningEffort)) {
          await client.request('session/close', { sessionId: session.id }, { signal: controller.signal, timeoutMs: this.#startTimeout });
          session = await this.#session(client, cwd, controller.signal); fresh = true; this.#sessions.set(localSessionId, session); await this.#save();
        }
        active.session = session; this.#models = session.models; this.#modes = session.modes;
        if (modelId) await this.#selectModel(client, session, modelId, controller.signal);
        if (modeId) { if (!session.modes.some(mode => mode.id === modeId)) throw fail('KIMI_MODE_UNAVAILABLE', 'Kimi 代理未提供所选执行模式。'); await client.request('session/set_mode', { sessionId: session.id, modeId }, { signal: controller.signal, timeoutMs: this.#startTimeout }); }
        await setAcpReasoning({ client, session, effort: reasoningEffort, options: { signal: controller.signal, timeoutMs: this.#startTimeout }, collectors: this.#catalogCollectors,
          unavailable: () => fail('KIMI_REASONING_UNAVAILABLE', '官方 Kimi 未提供或未接受所选推理档位，请刷新模型目录。') });
        this.#models = session.models; this.#changed();
        const blocks = promptBlocks(fresh ? externalAgentPrompt(prompt, contextMessages) : prompt, attachments, this.#capabilities); check(controller.signal); client.resetTurnLimit();
        const result = await client.request('session/prompt', { sessionId: session.id, prompt: blocks }, { timeoutMs: this.#timeout });
        check(controller.signal); if (active !== this.#active || profile !== this.#profile) throw cancelled();
        if (!identifier(result?.stopReason)) throw invalid();
        const raw = result.usage, usage = object(raw) && Number.isSafeInteger(raw.inputTokens) && raw.inputTokens >= 0 && Number.isSafeInteger(raw.outputTokens) && raw.outputTokens >= 0
          ? { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens } : null;
        return { sessionId: session.id, stopReason: result.stopReason, usage, usageReported: Boolean(usage) };
      } catch (error) { const safe = controller.signal.aborted ? cancelled() : safeError(error); if (safe.name !== 'AbortError') this.#setError(safe, 'task'); throw safe; }
      finally { signal?.removeEventListener('abort', abort); if (this.#active === active) this.#active = null; this.#state = this.#client?.alive ? 'ready' : 'idle'; this.#changed(); }
    })();
    return active.done;
  }
  async stop() {
    const active = this.#active; if (!active) { this.#startup?.abort(); return; } if (active.stopping) return active.stopping;
    active.controller.abort(); this.#state = 'stopping'; this.#changed();
    active.stopping = (async () => {
      try { if (active.session?.id) this.#client?.notify('session/cancel', { sessionId: active.session.id }); } catch {}
      let timer; await Promise.race([active.done?.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, this.#stopGrace); })]); clearTimeout(timer);
      if (this.#active === active) await this.#shutdown(); await active.done?.catch(() => {});
    })(); return active.stopping;
  }
  async #shutdown() { this.#startup?.abort(); const client = this.#client; this.#client = null; for (const session of this.#sessions.values()) session.live = false; if (client) await client.close(); await Promise.allSettled([...this.#closing]); }
  async disconnect() {
    await this.init(); ++this.#epoch; this.#attempt?.controller.abort(); this.#startup?.abort(); await this.stop(); await this.#attempt?.done.catch(() => {});
    const profile = this.#profile;
    // Official logout is best effort; the old isolated home is never reused.
    if (this.#client?.alive) await this.#client.request('logout', {}, { timeoutMs: this.#startTimeout }).catch(() => {});
    await this.#shutdown(); this.#profile = null; this.#sessions.clear(); this.#models = []; this.#modes = []; this.#error = null; this.#state = 'idle';
    try {
      await this.#save();
      if (uuid(profile)) { const directory = path.join(this.#profiles, profile), stat = await fs.lstat(directory).catch(() => null); if (stat) {
        await this.#mkdir(this.#dir); await this.#mkdir(this.#profiles);
        const parent = await fs.realpath(this.#profiles); if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(await fs.realpath(directory)).toLowerCase() !== parent.toLowerCase()) throw invalid();
        await fs.rm(directory, { recursive: true, force: true });
      } }
    } catch (error) { this.#setError(error, 'storage'); throw safeError(error); }
    this.#changed(); return this.publicState();
  }
  async retryLocalRead() { if (this.#active || this.#attempt) throw fail('KIMI_BUSY', '请先停止 Kimi 任务或登录。'); await this.#shutdown(); ++this.#epoch; this.#profile = null; this.#sessions.clear(); await this.#read(); this.#changed(); return this.publicState(); }
  async dispose() { if (this.#closed) return; this.#closed = true; ++this.#epoch; this.#attempt?.controller.abort(); this.#startup?.abort(); await this.stop(); await this.#attempt?.done.catch(() => {}); await this.#shutdown(); await this.#writes.catch(() => {}); }
}
