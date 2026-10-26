import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { classifyGeminiRpcError } from './gemini-auth-errors.mjs';
import { externalAgentPrompt } from './external-agent-context.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 512) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const identifier = value => text(value, 512) && value.length > 0;
const fail = (code, message) => Object.assign(new Error(`[${code}] ${message}`), { name: 'AntigravityError', code });
const cancelled = () => Object.assign(fail('AGY_CANCELLED', 'Antigravity 操作已取消。'), { name: 'AbortError' });
const invalid = () => fail('AGY_PROTOCOL_ERROR', '官方 Antigravity 代理返回了无效协议数据。');
const MAX_FRAME = 16 * 1024 * 1024, MAX_TURN = 128 * 1024 * 1024;
const REGION_DENIAL = /^User location is not supported for the API use\.?$/iu;
const REGION_ECHO_REQUEST = /^(?:请(?:你)?(?:原样|逐字)(?:复述|重复)|(?:please\s+)?(?:repeat|echo)(?:\s+(?:exactly|verbatim))?)\s*[:：]\s*User location is not supported for the API use\.?$/iu;
const normalizeReply = value => value.trim().replace(/\s+/gu, ' ');
function check(signal) { if (signal?.aborted) throw cancelled(); }
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
function rpcFailure(method, value) {
  const classified = classifyGeminiRpcError(method, value);
  const code = classified.code === 'GEMINI_SIGN_IN_REQUIRED' ? 'AGY_AUTH_REQUIRED' : classified.code.replace(/^GEMINI_/u, 'AGY_');
  const messages = {
    AGY_AUTH_REQUIRED: '请通过官方 Antigravity 登录后重试。',
    AGY_AUTH_FAILED: '官方 Antigravity 账号授权未完成，请重试。',
    AGY_CLIENT_UNSUPPORTED: 'Google 已拒绝此客户端，请检查官方代理的支持状态。',
    AGY_PROJECT_REQUIRED: '此账号需要 Google Cloud 项目配置，请按官方要求完成配置。',
    AGY_ACCOUNT_VALIDATION_REQUIRED: '此 Google 账号需要额外验证，请完成官方验证后重试。',
    AGY_ACCOUNT_ACTION_REQUIRED: '此 Google 账号需要在官方页面完成必要操作。',
    AGY_REGION_UNAVAILABLE: 'Google 服务未向当前账号所在地区提供此功能。',
    AGY_QUOTA_EXCEEDED: '官方 Antigravity 额度不足或请求受限。',
    AGY_ACCESS_DENIED: 'Google 拒绝了此账号的服务访问。',
    AGY_NETWORK_ERROR: '官方 Antigravity 网络连接失败，请检查代理后重试。',
    AGY_SERVICE_UNAVAILABLE: '官方 Antigravity 服务暂不可用，请稍后重试。',
    AGY_PROXY_FAILED: '官方代理无法连接当前网络代理，请检查代理设置。',
    AGY_TIMEOUT: '官方 Antigravity 请求超时，请重试。',
    AGY_SESSION_FAILED: '官方 Antigravity 会话无法建立，请重新开始会话。',
  };
  const result = fail(Object.hasOwn(messages, code) ? code : 'AGY_REQUEST_FAILED', messages[code] || '官方 Antigravity 请求未完成，请检查账号和网络后重试。');
  if (classified.diagnostic) result.diagnostic = classified.diagnostic;
  return result;
}

// The Windows distribution uses a bootloader plus a same-name child. Killing
// only ChildProcess.pid leaves that child (and its native tools) running.
export async function killAntigravityProcessTree(child, { platform = process.platform, spawnImpl = spawn } = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0) { try { child?.kill?.('SIGKILL'); } catch {} return; }
  if (platform === 'win32') {
    await new Promise(resolve => {
      let killer, timer, done = false;
      const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(); };
      try {
        const system = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
        killer = spawnImpl(path.join(system, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.once('error', finish); killer.once('close', finish);
        timer = setTimeout(() => { try { killer.kill('SIGKILL'); } catch {} finish(); }, 2500);
      } catch { finish(); }
    });
  } else { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  try { child.kill('SIGKILL'); } catch {}
}

export class ExternalAcpClient {
  #child; #kill; #pending = new Map(); #id = 0; #buffer = ''; #decoder = new StringDecoder('utf8');
  #error = null; #closing = null; #onUpdate; #onRequest; #onFailure; #turnBytes = 0; #rpcError;
  constructor({ entry, args = [], options, spawnImpl, killTree, onUpdate, onRequest, onFailure, rpcError = rpcFailure }) {
    this.#kill = killTree; this.#onUpdate = onUpdate; this.#onRequest = onRequest; this.#onFailure = onFailure; this.#rpcError = rpcError;
    try { this.#child = spawnImpl(entry, args, options); } catch { throw fail('AGY_START_FAILED', '无法启动官方 Antigravity 代理，请重新安装代理。'); }
    const child = this.#child;
    if (!child?.stdout?.on || !child?.stdin?.write || !child?.on || typeof child.kill !== 'function') throw fail('AGY_START_FAILED', '官方代理进程不可用。');
    child.stdout.on('data', bytes => {
      if (this.#error || this.#closing) return;
      this.#turnBytes += bytes.length;
      if (this.#turnBytes > MAX_TURN) return this.fail(fail('AGY_RESPONSE_TOO_LARGE', '官方代理单轮输出过大，已停止。'));
      this.#buffer += this.#decoder.write(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
      let split;
      while ((split = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, split); this.#buffer = this.#buffer.slice(split + 1);
        if (Buffer.byteLength(line) > MAX_FRAME) return this.fail(invalid());
        if (!line.trim()) continue;
        let value; try { value = JSON.parse(line); } catch { return this.fail(invalid()); }
        this.#receive(value); if (this.#error || this.#closing) return;
      }
      if (Buffer.byteLength(this.#buffer) > MAX_FRAME) this.fail(invalid());
    });
    // Original agent owns OAuth URLs and credential diagnostics. They are never
    // copied into Synora state, transcript, logs or errors.
    child.stderr?.on('data', () => {});
    child.on('error', () => this.fail(fail('AGY_START_FAILED', '官方 Antigravity 代理无法运行。')));
    child.stdin.on?.('error', () => this.fail(fail('AGY_EXITED', '官方 Antigravity 连接已关闭。')));
    child.once('exit', () => { if (!this.#closing) this.fail(fail('AGY_EXITED', '官方 Antigravity 代理已退出。')); });
    child.once('close', () => { if (!this.#closing) this.fail(fail('AGY_EXITED', '官方 Antigravity 代理已退出。')); });
  }
  get alive() { return !this.#error && !this.#closing; }
  resetTurnLimit() { this.#turnBytes = 0; }
  #send(value) {
    if (!this.alive) throw this.#error || cancelled();
    try { this.#child.stdin.write(JSON.stringify(value) + '\n'); }
    catch { this.fail(fail('AGY_EXITED', '官方 Antigravity 连接已关闭。')); throw this.#error; }
  }
  #receive(value) {
    if (!object(value) || value.jsonrpc !== '2.0') return this.fail(invalid());
    if (typeof value.method === 'string') {
      if (value.id !== undefined) {
        if (!['string', 'number'].includes(typeof value.id)) return this.fail(invalid());
        Promise.resolve().then(() => this.#onRequest(value.method, value.params)).then(
          response => { if (this.alive) this.#send({ jsonrpc: '2.0', id: value.id, ...response }); },
          () => { if (this.alive) this.#send({ jsonrpc: '2.0', id: value.id, error: { code: -32603, message: 'Client capability unavailable' } }); },
        ).catch(() => {});
      } else if (value.method === 'session/update') {
        try { this.#onUpdate(value.params); } catch { this.fail(fail('AGY_CALLBACK_FAILED', '官方代理会话显示失败，已停止。')); }
      }
      return;
    }
    const pending = this.#pending.get(value.id); if (!pending) return;
    this.#pending.delete(value.id); pending.cleanup();
    if (object(value.error)) pending.reject(this.#rpcError(pending.method, value.error));
    else if (!Object.hasOwn(value, 'result')) pending.reject(invalid());
    else pending.resolve(value.result);
  }
  request(method, params, { signal, timeoutMs = 60000 } = {}) {
    check(signal); if (!this.alive) return Promise.reject(this.#error || cancelled());
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      const abort = () => this.fail(cancelled());
      const timer = setTimeout(() => this.fail(fail('AGY_TIMEOUT', '官方 Antigravity 请求超时，已停止代理。')), timeoutMs);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.#pending.set(id, { resolve, reject, method, cleanup }); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) return abort();
      try { this.#send({ jsonrpc: '2.0', id, method, params }); } catch (error) { this.#pending.delete(id); cleanup(); reject(error); }
    });
  }
  notify(method, params) { if (this.alive) this.#send({ jsonrpc: '2.0', method, params }); }
  fail(error) {
    if (this.#error || this.#closing) return; this.#error = error;
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(error); } this.#pending.clear();
    try { this.#onFailure?.(error); } catch {} void this.close(error);
  }
  close(error = cancelled()) {
    if (this.#closing) return this.#closing;
    this.#error ||= error;
    for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(this.#error); } this.#pending.clear();
    this.#closing = (async () => {
      // Keep the bootloader alive until taskkill has addressed its whole tree.
      // Ending stdin/killing just the root first can orphan the Python child.
      await this.#kill(this.#child);
      try { this.#child.stdin.end(); } catch {}
      for (const stream of [this.#child.stdin, this.#child.stdout, this.#child.stderr]) { try { stream?.destroy?.(); } catch {} }
    })();
    return this.#closing;
  }
}

function modelConfigOption(session) {
  if (!Array.isArray(session?.configOptions)) return null;
  // ACP categories are optional semantic hints. Antigravity also uses the
  // canonical id without a category; an empty legacy list must not hide it.
  return session.configOptions.find(option => option?.type === 'select' && option.category === 'model')
    || session.configOptions.find(option => option?.type === 'select' && option.id === 'model') || null;
}
function catalog(session) {
  const setting = modelConfigOption(session);
  const configured = Array.isArray(setting?.options) ? setting.options.flatMap(option => Array.isArray(option?.options) ? option.options : [option])
    .map(option => ({ modelId: option?.value, name: option?.name })) : null;
  const rows = configured?.length ? configured : session?.models?.availableModels;
  if (!Array.isArray(rows) || rows.length > 256) return [];
  const seen = new Set(), models = [];
  for (const row of rows) {
    if (!object(row) || !identifier(row.modelId) || seen.has(row.modelId)) throw invalid(); seen.add(row.modelId);
    models.push({ id: row.modelId, displayName: text(row.name, 256) && row.name ? row.name : row.modelId,
      compatible: true, textCompatible: true, supportsTools: true, supportsImages: true, reasoningEfforts: [] });
  }
  return models;
}
function modes(session) {
  if (!Array.isArray(session?.modes?.availableModes)) return [];
  return session.modes.availableModes.slice(0, 64).filter(row => object(row) && identifier(row.id)).map(row => ({ id: row.id, name: text(row.name, 256) ? row.name : row.id }));
}
function promptBlocks(prompt, attachments, capabilities) {
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 4 * 1024 * 1024 || !Array.isArray(attachments) || attachments.length > 20) throw fail('AGY_INVALID_INPUT', '官方代理任务或附件格式无效。');
  const blocks = [{ type: 'text', text: prompt }]; let bytes = Buffer.byteLength(prompt);
  for (const attachment of attachments) {
    if (!object(attachment)) throw fail('AGY_INVALID_INPUT', '官方代理附件格式无效。');
    let mimeType = attachment.mimeType, data = attachment.data;
    if (typeof attachment.dataUrl === 'string') { const match = /^data:([a-z\d.+-]+\/[a-z\d.+-]+);base64,([A-Za-z\d+/=\r\n]+)$/iu.exec(attachment.dataUrl); if (!match) throw fail('AGY_INVALID_INPUT', '官方代理附件格式无效。'); [, mimeType, data] = match; }
    const type = typeof mimeType === 'string' && mimeType.startsWith('image/') ? 'image' : typeof mimeType === 'string' && mimeType.startsWith('audio/') ? 'audio' : null;
    if (!type || !capabilities?.promptCapabilities?.[type]) throw fail('AGY_IMAGES_UNSUPPORTED', '官方代理不支持此附件类型。');
    if (typeof data !== 'string' || !data || data.length > 24 * 1024 * 1024 || !/^[A-Za-z\d+/]*={0,2}$/u.test(data.replace(/[\r\n]/gu, ''))) throw fail('AGY_INVALID_INPUT', '官方代理附件数据无效。');
    bytes += data.length; if (bytes > 32 * 1024 * 1024) throw fail('AGY_INVALID_INPUT', '官方代理附件总大小过大。');
    blocks.push({ type, mimeType, data: data.replace(/[\r\n]/gu, '') });
  }
  return blocks;
}

export class AntigravityAgent {
  #dir; #home; #work; #runtime; #spawn; #kill; #proxy; #onChange; #onEvent; #permission; #version;
  #client = null; #starting = null; #startup = null; #capabilities = {}; #authMethods = []; #profile = null;
  #models = []; #modes = []; #sessions = new Map(); #active = null; #attempt = null; #epoch = 0; #closed = false;
  #state = 'idle'; #error = null; #timeout; #startTimeout; #stopGrace; #closing = new Set(); #catalogCollectors = new Set();
  constructor({ dataDir, runtime, spawnImpl = spawn, killTreeImpl, getProxyEnv = () => ({}), onChange = () => {}, onEvent = () => {}, onPermission = async () => null,
    version = '0.0.0', platform = process.platform, requestTimeoutMs = 3600000, startTimeoutMs = 60000, stopGraceMs = 1500 } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || !runtime?.ensure || !runtime?.publicState || typeof spawnImpl !== 'function'
        || typeof getProxyEnv !== 'function' || typeof onChange !== 'function' || typeof onEvent !== 'function' || typeof onPermission !== 'function'
        || !text(version, 80) || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 86400000
        || ![startTimeoutMs, stopGraceMs].every(value => Number.isInteger(value) && value > 0 && value <= 600000)
        || killTreeImpl !== undefined && typeof killTreeImpl !== 'function') throw fail('AGY_INVALID_INPUT', '官方代理配置无效。');
    this.#dir = path.join(path.resolve(dataDir), 'antigravity-agent'); this.#home = path.join(this.#dir, 'home'); this.#work = path.join(this.#dir, 'catalog-workspace');
    this.#runtime = runtime; this.#spawn = spawnImpl; this.#kill = killTreeImpl || (child => killAntigravityProcessTree(child, { platform }));
    this.#proxy = getProxyEnv; this.#onChange = onChange; this.#onEvent = onEvent; this.#permission = onPermission; this.#version = version;
    this.#timeout = requestTimeoutMs; this.#startTimeout = startTimeoutMs; this.#stopGrace = stopGraceMs;
  }
  #changed() { try { Promise.resolve(this.#onChange()).catch(() => {}); } catch {} }
  #setError(error, phase) { const local = error?.name === 'AntigravityError'; this.#error = { code: local ? error.code : 'AGY_REQUEST_FAILED', message: local ? error.message : '[AGY_REQUEST_FAILED] 官方代理请求未完成。', phase,
    ...(local && error.diagnostic ? { diagnostic: error.diagnostic } : {}) }; this.#changed(); }
  async init() { await this.#runtime.init?.(); return this; }
  async publicState() {
    return { runtime: await this.#runtime.publicState(),
      session: { status: this.#attempt ? 'connecting' : this.#error?.code === 'AGY_AUTH_REQUIRED' ? 'reauth_required' : this.#profile ? 'connected' : 'disconnected', sharing: Boolean(this.#profile) && this.#error?.code !== 'AGY_AUTH_REQUIRED', profileId: this.#profile },
      attempt: this.#attempt ? { phase: this.#attempt.phase } : null, error: this.#error ? structuredClone(this.#error) : null,
      storage: { owner: 'official-agent', homeIsolated: true, credentialScope: 'official-shared', identityVerified: false },
      status: this.#state, models: structuredClone(this.#models), modes: structuredClone(this.#modes),
      agent: { name: 'antigravity-acp', version: '1.4.3' } };
  }
  async #mkdir(directory) { await fs.mkdir(directory, { recursive: true }); const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('AGY_STORAGE_ERROR', '官方代理数据目录不可用。'); }
  async initialize({ signal } = {}) {
    if (this.#closed) throw fail('AGY_CLOSED', '官方代理已关闭。'); check(signal);
    if (this.#client?.alive) return this.#client;
    if (this.#starting) return waitFor(() => this.#starting, signal);
    const epoch = this.#epoch, controller = new AbortController(); this.#startup = controller;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    this.#state = 'starting'; this.#changed();
    this.#starting = (async () => {
      let client;
      try {
        await waitFor(() => Promise.allSettled([...this.#closing]), controller.signal);
        const runtime = await this.#runtime.ensure({ signal: controller.signal }); check(controller.signal);
        await this.#mkdir(this.#dir); await this.#mkdir(this.#home); await this.#mkdir(this.#work);
        const proxy = await waitFor(() => this.#proxy(), controller.signal); check(controller.signal);
        const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata|lang|lc_all|https?_proxy|all_proxy|no_proxy|node_extra_ca_certs)$/iu.test(key) && typeof value === 'string'));
        if (object(proxy)) for (const [key, value] of Object.entries(proxy)) if (/^(?:https?_proxy|all_proxy|no_proxy)$/iu.test(key) && text(value, 4096)) env[key] = value;
        env.GEMINI_HOME = this.#home;
        client = new ExternalAcpClient({ entry: runtime.entry, options: { cwd: this.#work, env, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] },
          spawnImpl: this.#spawn, killTree: this.#kill, onUpdate: value => this.#update(value), onRequest: (method, value) => this.#request(method, value),
          onFailure: error => {
            if (client) { const closing = client.close(error); this.#closing.add(closing); closing.finally(() => this.#closing.delete(closing)).catch(() => {}); }
            if (this.#client === client) { this.#client = null; this.#sessions.clear(); this.#setError(error, 'connection'); }
          } });
        const initialized = await client.request('initialize', { protocolVersion: 1, clientInfo: { name: 'Synora code', version: this.#version },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }, { signal: controller.signal, timeoutMs: this.#startTimeout });
        check(controller.signal); if (epoch !== this.#epoch || this.#closed) throw cancelled();
        if (initialized?.protocolVersion !== 1 || initialized.agentInfo?.name !== 'antigravity-acp' || initialized.agentInfo?.version !== runtime.version || !Array.isArray(initialized.authMethods)) throw invalid();
        this.#capabilities = initialized.agentCapabilities || {};
        this.#authMethods = initialized.authMethods.filter(method => object(method) && identifier(method.id) && (!method.type || method.type === 'agent')).map(method => method.id);
        this.#client = client; this.#sessions.clear(); this.#state = 'ready'; this.#changed(); return client;
      } catch (error) { await client?.close(error).catch(() => {}); const safe = controller.signal.aborted ? cancelled() : error?.name === 'AntigravityError' ? error : fail('AGY_START_FAILED', '官方 Antigravity 代理启动失败。'); if (safe.name !== 'AbortError') this.#setError(safe, 'initialize'); throw safe; }
      finally { signal?.removeEventListener('abort', abort); this.#starting = null; this.#startup = null; if (this.#state === 'starting') this.#state = 'idle'; this.#changed(); }
    })();
    return this.#starting;
  }
  signIn({ signal, methodId = 'oauth-personal' } = {}) {
    if (this.#attempt) return this.#attempt.done;
    if (this.#active) return Promise.reject(fail('AGY_BUSY', '请先停止正在运行的官方代理任务。'));
    if (!['oauth-personal', 'oauth-business'].includes(methodId)) return Promise.reject(fail('AGY_INVALID_INPUT', '请选择官方 Google 账号登录方式。'));
    const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    ++this.#epoch; this.#sessions.clear(); this.#profile = null; this.#models = []; this.#modes = [];
    const attempt = { controller, phase: 'initializing' }; this.#attempt = attempt; this.#error = null; this.#changed();
    attempt.done = (async () => {
      try {
        const client = await this.initialize({ signal: controller.signal });
        if (!this.#authMethods.includes(methodId)) throw fail('AGY_AUTH_FAILED', '官方代理未提供所选账号登录方式。');
        attempt.phase = 'waiting-browser'; this.#state = 'authenticating'; this.#changed();
        await client.request('authenticate', { methodId }, { signal: controller.signal, timeoutMs: Math.min(this.#timeout, 600000) }); check(controller.signal);
        this.#profile = randomUUID(); ++this.#epoch; this.#sessions.clear(); this.#models = []; this.#modes = []; this.#error = null;
      } catch (error) { if (!controller.signal.aborted) this.#setError(error, 'authenticate'); throw controller.signal.aborted ? cancelled() : error; }
      finally { signal?.removeEventListener('abort', abort); if (this.#attempt === attempt) this.#attempt = null; this.#state = this.#client?.alive ? 'ready' : 'idle'; this.#changed(); }
      return this.publicState();
    })();
    return attempt.done;
  }
  async cancelSignIn() { const attempt = this.#attempt; attempt?.controller.abort(); this.#startup?.abort(); if (attempt) await attempt.done.catch(() => {}); if (!this.#profile) await this.#shutdown(); return this.publicState(); }
  #usable() { if (this.#closed) throw fail('AGY_CLOSED', '官方代理已关闭。'); if (!this.#profile || this.#error?.code === 'AGY_AUTH_REQUIRED') throw fail('AGY_AUTH_REQUIRED', '请先连接官方 Antigravity 账号。'); if (this.#attempt) throw fail('AGY_BUSY', '请等待官方代理登录完成。'); return this.#profile; }
  async #newSession(client, cwd, signal) {
    const updates = new Map(); let sessionId, wake;
    const collect = params => {
      if (!identifier(params?.sessionId) || params.update?.sessionUpdate !== 'config_option_update') return;
      if (sessionId && params.sessionId !== sessionId) return;
      const config = params.update.configOptions;
      if (!Array.isArray(config) || config.length > 256 || JSON.stringify(config).length > 1024 * 1024) throw invalid();
      if (!updates.has(params.sessionId) && updates.size >= 8) return;
      updates.set(params.sessionId, structuredClone(config)); wake?.();
    };
    this.#catalogCollectors.add(collect);
    try {
      const response = await client.request('session/new', { cwd, mcpServers: [] }, { signal, timeoutMs: this.#startTimeout });
      if (!identifier(response?.sessionId)) throw invalid(); sessionId = response.sessionId;
      for (const key of updates.keys()) if (key !== sessionId) updates.delete(key);
      const snapshot = () => ({ ...response, ...(updates.has(sessionId) ? { configOptions: updates.get(sessionId) } : {}) });
      let current = snapshot(), models = catalog(current);
      const deadline = Date.now() + Math.min(this.#startTimeout, 2000);
      while (!models.length && Date.now() < deadline) {
        let timer;
        try { await waitFor(() => new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, Math.max(1, deadline - Date.now())); }), signal); }
        finally { clearTimeout(timer); wake = null; }
        current = snapshot(); models = catalog(current);
      }
      check(signal);
      if (!models.length) throw fail('AGY_CATALOG_EMPTY', 'Antigravity 已连接，但官方会话没有返回可选模型，请刷新目录或检查账号权限。');
      return { id: sessionId, cwd, profile: this.#profile, models, modes: modes(current), configOptions: current.configOptions || [] };
    } finally { this.#catalogCollectors.delete(collect); wake?.(); }
  }
  async listModels({ cwd = this.#work, signal } = {}) {
    this.#usable(); if (this.#active) return structuredClone(this.#models);
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail('AGY_INVALID_INPUT', '官方代理工作目录无效。');
    const profile = this.#profile, epoch = this.#epoch;
    try { const client = await this.initialize({ signal }); const session = await this.#newSession(client, cwd, signal); if (profile !== this.#profile || epoch !== this.#epoch) throw cancelled(); this.#models = session.models; this.#modes = session.modes; this.#error = null; this.#changed(); return structuredClone(this.#models); }
    catch (error) { if (error.name !== 'AbortError') this.#setError(error, 'model-list'); throw error; }
  }
  #update(params) {
    for (const collect of this.#catalogCollectors) collect(params);
    const active = this.#active;
    if (!active || active.controller.signal.aborted || active.profile !== this.#profile || params?.sessionId !== active.session?.id || !object(params.update)) return;
    const update = params.update;
    if (!identifier(update.sessionUpdate)) throw invalid();
    if (update.sessionUpdate === 'agent_message_chunk') {
      if (update.content?.type !== 'text' || typeof update.content.text !== 'string') active.otherReplyContent = true;
      else if (active.replyText !== null) {
        // Google can return its fixed service refusal as ordinary ACP text and
        // still end the turn successfully. Inspect only a short, current-turn
        // reply; never classify arbitrary history, quotes, code or explanations.
        active.replyText = active.replyText.length + update.content.text.length <= 512
          ? active.replyText + update.content.text : null;
      }
    }
    // Only actual session updates after authenticated task creation are exposed.
    // Authentication diagnostics and arbitrary process notifications never are.
    const copy = structuredClone(update), event = { localSessionId: active.localSessionId, sessionId: active.session.id, update: copy };
    for (const callback of [active.onUpdate, this.#onEvent]) {
      if (!callback) continue;
      try { Promise.resolve(callback(event)).catch(() => this.#client?.fail(fail('AGY_CALLBACK_FAILED', '官方代理会话显示失败，已停止。'))); }
      catch { throw fail('AGY_CALLBACK_FAILED', '官方代理会话显示失败，已停止。'); }
    }
  }
  async #request(method, params) {
    const active = this.#active;
    if (method !== 'session/request_permission') return { error: { code: -32601, message: 'Client capability unavailable' } };
    const denied = { result: { outcome: { outcome: 'cancelled' } } };
    if (!active || active.controller.signal.aborted || active.profile !== this.#profile || params?.sessionId !== active.session?.id
        || !object(params.toolCall) || !Array.isArray(params.options) || !params.options.length || params.options.length > 64) return denied;
    const options = params.options.filter(option => object(option) && identifier(option.optionId) && ['allow_once', 'allow_always', 'reject_once', 'reject_always'].includes(option.kind))
      .map(option => ({ optionId: option.optionId, kind: option.kind, name: text(option.name, 1024) ? option.name : option.kind }));
    if (options.length !== params.options.length || new Set(options.map(option => option.optionId)).size !== options.length) return denied;
    try {
      const selected = await waitFor(() => (active.onPermission || this.#permission)({ localSessionId: active.localSessionId, sessionId: active.session.id,
        toolCall: structuredClone(params.toolCall), options, signal: active.controller.signal }), active.controller.signal);
      if (active !== this.#active || active.controller.signal.aborted || active.profile !== this.#profile || !options.some(option => option.optionId === selected)) return denied;
      return { result: { outcome: { outcome: 'selected', optionId: selected } } };
    } catch { return denied; }
  }
  async runTask({ localSessionId, cwd, prompt, contextMessages, attachments = [], modelId, modeId, signal, onUpdate, onPermission } = {}) {
    const profile = this.#usable(); check(signal);
    if (this.#active) throw fail('AGY_BUSY', '官方代理已有任务正在运行。');
    if (!identifier(localSessionId) || typeof cwd !== 'string' || !path.isAbsolute(cwd) || /[\x00\r\n]/u.test(cwd)
        || modelId !== undefined && !identifier(modelId) || modeId !== undefined && !identifier(modeId)
        || onUpdate !== undefined && typeof onUpdate !== 'function' || onPermission !== undefined && typeof onPermission !== 'function') throw fail('AGY_INVALID_INPUT', '官方代理任务配置无效。');
    const originalBlocks = promptBlocks(prompt, attachments, { promptCapabilities: { image: true, audio: true } });
    const controller = new AbortController();
    const active = { profile, controller, localSessionId, onUpdate, onPermission, session: null, done: null, stopping: false,
      replyText: '', otherReplyContent: false,
      quotesRegionDenial: prompt.length <= 512 && REGION_ECHO_REQUEST.test(normalizeReply(prompt)) };
    const abort = () => { controller.abort(); void this.stop(); }; signal?.addEventListener('abort', abort, { once: true });
    this.#active = active; this.#state = 'running'; this.#error = null; this.#changed();
    active.done = (async () => {
      try {
        const client = await this.initialize({ signal: controller.signal }); check(controller.signal);
        if (profile !== this.#profile) throw fail('AGY_SESSION_CHANGED', '官方代理账号已改变，请重新开始任务。');
        let session = this.#sessions.get(localSessionId);
        const fresh = !session || session.profile !== profile || session.cwd !== cwd;
        if (fresh) { session = await this.#newSession(client, cwd, controller.signal); this.#sessions.set(localSessionId, session); }
        check(controller.signal); active.session = session;
        if (modelId) {
          if (!session.models.some(model => model.id === modelId)) throw fail('AGY_MODEL_UNAVAILABLE', '官方账号未提供所选模型，请刷新目录。');
          const option = modelConfigOption(session);
          if (option?.id) await client.request('session/set_config_option', { sessionId: session.id, configId: option.id, value: modelId }, { signal: controller.signal, timeoutMs: this.#startTimeout });
          else await client.request('session/set_model', { sessionId: session.id, modelId }, { signal: controller.signal, timeoutMs: this.#startTimeout });
        }
        if (modeId) {
          if (!session.modes.some(mode => mode.id === modeId)) throw fail('AGY_MODE_UNAVAILABLE', '官方代理未提供所选执行模式。');
          await client.request('session/set_mode', { sessionId: session.id, modeId }, { signal: controller.signal, timeoutMs: this.#startTimeout });
        }
        // The caller supplies only history authorized for this account/profile.
        // Existing native sessions already own their history; do not replay it.
        const remainingBytes = Math.min(4 * 1024 * 1024 - Buffer.byteLength(prompt),
          32 * 1024 * 1024 - originalBlocks.reduce((sum, block) => sum + (block.type === 'text' ? Buffer.byteLength(block.text) : block.data.length), 0));
        const maxContextChars = Math.min(131072, Math.floor(remainingBytes / 3));
        const continuedPrompt = fresh && maxContextChars >= 512 ? externalAgentPrompt(prompt, contextMessages, { maxContextChars }) : prompt;
        const blocks = promptBlocks(continuedPrompt, attachments, this.#capabilities); check(controller.signal);
        client.resetTurnLimit();
        const result = await client.request('session/prompt', { sessionId: session.id, prompt: blocks }, { timeoutMs: this.#timeout });
        check(controller.signal); if (active !== this.#active || profile !== this.#profile) throw cancelled();
        if (!identifier(result?.stopReason)) throw invalid();
        const raw = result.usage, usage = object(raw) && Number.isSafeInteger(raw.inputTokens) && raw.inputTokens >= 0 && Number.isSafeInteger(raw.outputTokens) && raw.outputTokens >= 0
          ? { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens } : null;
        if (result.stopReason === 'end_turn' && !active.otherReplyContent && !active.quotesRegionDenial
          && active.replyText !== null && REGION_DENIAL.test(normalizeReply(active.replyText)))
          throw Object.assign(fail('AGY_REGION_UNAVAILABLE', 'Google 服务明确提示当前地区无法使用该模型，本轮任务未完成；请在官方页面核对账号和地区可用性。'),
            { usage, usageReported: Boolean(usage) });
        return { sessionId: session.id, stopReason: result.stopReason, usage, usageReported: Boolean(usage) };
      } catch (error) { if (!controller.signal.aborted && error.name !== 'AbortError') this.#setError(error, 'task'); throw controller.signal.aborted ? cancelled() : error; }
      finally { signal?.removeEventListener('abort', abort); if (this.#active === active) this.#active = null; this.#state = this.#client?.alive ? 'ready' : 'idle'; this.#changed(); }
    })();
    return active.done;
  }
  async stop() {
    const active = this.#active; if (!active) { this.#startup?.abort(); return; }
    if (active.stopping) return active.stopping;
    active.controller.abort(); this.#state = 'stopping'; this.#changed();
    active.stopping = (async () => {
      try { if (active.session?.id) this.#client?.notify('session/cancel', { sessionId: active.session.id }); } catch {}
      let timer;
      await Promise.race([active.done?.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, this.#stopGrace); })]); clearTimeout(timer);
      if (this.#active === active) await this.#shutdown();
      await active.done?.catch(() => {}); await Promise.allSettled([...this.#closing]);
    })();
    return active.stopping;
  }
  async #shutdown() { this.#startup?.abort(); const client = this.#client; this.#client = null; this.#sessions.clear(); if (client) await client.close(); await Promise.allSettled([...this.#closing]); }
  async disconnect() { ++this.#epoch; this.#attempt?.controller.abort(); this.#startup?.abort(); await this.stop(); await this.#attempt?.done.catch(() => {}); await this.#shutdown(); this.#profile = null; this.#models = []; this.#modes = []; this.#error = null; this.#state = 'idle'; this.#changed(); return this.publicState(); }
  async retryLocalRead() { await this.disconnect(); await this.#runtime.init?.(); return this.publicState(); }
  async dispose() { if (this.#closed) return; this.#closed = true; await this.disconnect(); }
}
