import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { classifyGeminiRpcError } from './gemini-auth-errors.mjs';

export const GEMINI_CLI_VERSION = '0.65.0';
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 512) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
// Electron invoke preserves Error.message but drops custom fields such as code.
// Only local, fixed text is allowed into these errors; never forward CLI data.
const failure = (code, message) => Object.assign(new Error(`[${code}] ${message}`), { name: 'GeminiConnectionError', code, retryable: false });
const aborted = () => Object.assign(failure('GEMINI_CANCELLED', 'Gemini 账号操作已取消。'), { name: 'AbortError' });
const unavailable = () => failure('GEMINI_SIGN_IN_REQUIRED', '请先通过官方 Gemini CLI 登录 Google 账号。');
const invalid = () => failure('GEMINI_INVALID_RESPONSE', 'Gemini CLI 返回了无效响应，工具调用未执行。');
const MAX_LINE = 16 * 1024 * 1024, MAX_WIRE = 64 * 1024 * 1024, MAX_INPUT = 16 * 1024 * 1024;
const PROFILE_FILE = 'gemini-connection.json';

function rpcFailure(method, error) {
  const { code, diagnostic } = classifyGeminiRpcError(method, error);
  const messages = {
    GEMINI_CLIENT_UNSUPPORTED: 'Google 已停止个人、AI Pro 和 Ultra 账号使用旧 Gemini CLI。Cortex 可改用 Gemini API Key；个人订阅请使用 Google 官方 Antigravity。',
    GEMINI_SIGN_IN_REQUIRED: '请先通过官方 Gemini CLI 登录 Google 账号。',
    GEMINI_PROJECT_REQUIRED: '此 Google 账号需要配置 Google Cloud 项目，请按官方认证要求配置。',
    GEMINI_ACCOUNT_VALIDATION_REQUIRED: 'Google 要求额外验证此账号，请先完成官方账号验证后重试。',
    GEMINI_ACCOUNT_ACTION_REQUIRED: '请先在 Google 官方页面完成账号条款确认，再重新连接。',
    GEMINI_SERVICE_UNAVAILABLE: 'Google 账号服务暂不可用，请稍后重试。',
    GEMINI_QUOTA_EXCEEDED: 'Google 账号当前额度不足或请求受限，请稍后重试。',
    GEMINI_NETWORK_ERROR: '连接 Google 服务失败，请检查软件代理和网络后重试。',
    GEMINI_PROXY_FAILED: '代理服务未接受当前连接，请检查代理配置后重试。',
    GEMINI_ACCESS_DENIED: 'Google 拒绝了当前账号的服务访问，请核对账号服务权限。',
    GEMINI_REGION_UNAVAILABLE: 'Google 服务返回当前地区不可用，请查看官方服务可用范围。',
    GEMINI_TIMEOUT: 'Google 服务连接超时，请稍后重试。',
    GEMINI_AUTH_FAILED: '浏览器授权后，Gemini CLI 未能完成账号服务验证，请检查账号可用性和网络后重试。',
    GEMINI_SESSION_FAILED: 'Google 账号已连接，但 Gemini 会话创建失败，请刷新模型目录后重试。',
    GEMINI_CLI_REQUEST_FAILED: 'Gemini CLI 请求未完成，请检查登录状态、套餐额度或网络后重试。',
  };
  return Object.assign(failure(code, messages[code]), diagnostic ? { diagnostic } : {});
}

function abortable(operation, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (caught, value) => {
      if (done) return; done = true; signal?.removeEventListener('abort', cancel);
      if (caught) reject(caught); else resolve(value);
    };
    const cancel = () => finish(aborted()); signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) return cancel();
    Promise.resolve().then(operation).then(value => finish(null, value), caught => finish(caught));
  });
}

// Official CLI manages its own credentials, exclusively inside this profile's
// GEMINI_CLI_HOME. Synora never opens, parses, copies or supplies CLI tokens.
// https://geminicli.com/docs/cli/acp-mode/
// https://github.com/google-gemini/gemini-cli/tree/v0.65.0/packages/cli/src/acp
const SETTINGS = Object.freeze({
  // Do not preselect auth: the official CLI otherwise logs in before starting
  // ACP, consuming stdin as a manual auth code. Select it through ACP instead.
  security: { auth: { enforcedType: 'oauth-personal' }, disableYoloMode: true, disableAlwaysAllow: true },
  tools: { core: [], useRipgrep: false },
  hooksConfig: { enabled: false }, hooks: {}, skills: { enabled: false }, mcpServers: {},
  admin: { secureModeEnabled: true, extensions: { enabled: false }, mcp: { enabled: false }, skills: { enabled: false } },
  context: { fileName: [], includeDirectoryTree: false, includeDirectories: [], memoryBoundaryMarkers: [], discoveryMaxDirs: 0 },
  experimental: { enableAgents: false, autoMemory: false, contextManagement: false, taskTracker: false },
  general: { enableAutoUpdate: false, topicUpdateNarration: false, maxAttempts: 1 },
  advanced: { autoConfigureMemory: false },
  billing: { overageStrategy: 'never' }, telemetry: { enabled: false, logPrompts: false }, privacy: { usageStatisticsEnabled: false }, ide: { enabled: false },
  model: { maxSessionTurns: 1 },
});

function childEnvironment(overrides, home, browser) {
  const allow = /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|appdata|localappdata|lang|lc_all|http_proxy|https_proxy|all_proxy|no_proxy|node_extra_ca_certs)$/iu;
  const env = Object.fromEntries(Object.entries({ ...process.env, ...overrides }).filter(([key, value]) => allow.test(key) && typeof value === 'string'));
  return { ...env, ELECTRON_RUN_AS_NODE: '1', GEMINI_CLI_NO_RELAUNCH: '1', GEMINI_CLI_HOME: home,
    // This embedded runtime has no system-wide configuration. In particular,
    // a machine's CLI MCP/hooks must not supplement this text-only transport.
    // User-writable settings must never masquerade as trusted system settings.
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(home, 'no-system-settings.json'),
    GEMINI_CLI_SYSTEM_DEFAULTS_PATH: path.join(home, 'no-system-defaults.json'),
    GEMINI_CLI_SURFACE: 'synora-code', ...(browser ? {} : { NO_BROWSER: 'true' }) };
}

function safeJson(value, depth = 0) {
  if (depth > 40) throw invalid();
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const child of value) safeJson(child, depth + 1); return; }
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw invalid();
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw invalid();
    safeJson(child, depth + 1);
  }
}

function modelList(value) {
  const list = value?.models?.availableModels;
  if (!Array.isArray(list) || !list.length || list.length > 256) throw invalid();
  const seen = new Set(), result = [];
  for (const row of list) {
    if (!object(row) || !text(row.modelId, 200) || !/^[a-z\d][a-z\d_.:/-]*$/iu.test(row.modelId) || seen.has(row.modelId)) throw invalid();
    seen.add(row.modelId);
    result.push({ id: row.modelId, displayName: text(row.name, 200) && row.name ? row.name : row.modelId,
      compatible: true, textCompatible: true, supportsTools: true, supportsImages: false, reasoningEfforts: [] });
  }
  return result;
}

function modelInput(messages, tools) {
  if (!Array.isArray(messages) || !messages.length || !Array.isArray(tools) || tools.length > 128) throw failure('GEMINI_INVALID_INPUT', 'Gemini 对话或工具定义无效。');
  const names = new Set();
  const functions = tools.map(tool => {
    if (!object(tool) || !/^[a-z\d_-]{1,64}$/iu.test(tool.name) || typeof tool.description !== 'string'
        || !object(tool.parameters) || names.has(tool.name)) throw failure('GEMINI_INVALID_INPUT', 'Gemini 工具定义无效或名称重复。');
    names.add(tool.name); safeJson(tool.parameters);
    return { name: tool.name, description: tool.description, parameters: tool.parameters };
  });
  const conversation = messages.filter(message => !(message?.role === 'assistant' && message.localOnly === true)).map(message => {
    if (!object(message) || !['system', 'user', 'assistant', 'tool'].includes(message.role) || typeof message.content !== 'string')
      throw failure('GEMINI_INVALID_INPUT', 'Gemini 对话消息格式无效。');
    if (message.attachments?.length) throw failure('GEMINI_IMAGES_UNSUPPORTED', 'Gemini CLI 账号模式暂不支持图片，请改用 Gemini API Key。');
    const result = { role: message.role, content: message.content };
    if (message.role === 'tool') {
      if (!text(message.toolCallId, 200) || !message.toolCallId) throw failure('GEMINI_INVALID_INPUT', 'Gemini 工具结果缺少标识。');
      result.toolCallId = message.toolCallId;
    }
    if (message.toolCalls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.toolCalls)) throw failure('GEMINI_INVALID_INPUT', 'Gemini 工具调用历史无效。');
      result.toolCalls = message.toolCalls.map(call => {
        if (!object(call) || !text(call.id, 200) || !call.id || !text(call.name, 64) || !object(call.arguments)) throw failure('GEMINI_INVALID_INPUT', 'Gemini 工具调用历史无效。');
        safeJson(call.arguments); return { id: call.id, name: call.name, arguments: call.arguments };
      });
    }
    return result;
  });
  let encoded;
  try { encoded = JSON.stringify({ messages: conversation, tools: functions }); } catch { throw failure('GEMINI_INVALID_INPUT', 'Gemini 对话无法序列化。'); }
  if (Buffer.byteLength(encoded) > MAX_INPUT) throw failure('GEMINI_INPUT_TOO_LARGE', 'Gemini 对话过长，请压缩上下文。');
  // Fixed prefix prevents ACP slash/$ commands. Text ContentBlocks, rather
  // than resource links, prevent CLI @file expansion and local file reads.
  return { names, prompt: 'SYNORA_MODEL_REQUEST\n你是 Cortex 的模型传输层。处理下面 messages 中的对话，遵守其中 system 指令。'
    + '这是纯文本推理：禁止调用 Gemini CLI 自带工具。需要本机操作时，仅在最终 JSON 中声明下面 tools 列出的调用，交给 Cortex 的审批与执行器。'
    + '只输出一个完整、严格 JSON 对象，精确结构 {"content":"给用户的答复","toolCalls":[{"id":"唯一标识，可省略","name":"提供的工具名","arguments":{}}]}。'
    + 'toolCalls 无调用时为 []，arguments 必须是 JSON 对象。不要 Markdown 围栏，不要附加字段，不输出私有思考；不要声称未执行的操作已完成。\n'
    + encoded };
}

function modelReply(content, names) {
  let value; try { value = JSON.parse(content); } catch { throw invalid(); }
  if (!object(value) || Object.keys(value).some(key => !['content', 'toolCalls'].includes(key))
      || typeof value.content !== 'string' || !Array.isArray(value.toolCalls) || value.toolCalls.length > 32) throw invalid();
  const ids = new Set();
  const toolCalls = value.toolCalls.map(call => {
    if (!object(call) || Object.keys(call).some(key => !['id', 'name', 'arguments'].includes(key))
        || !names.has(call.name) || !object(call.arguments)) throw invalid();
    const id = call.id === undefined ? randomUUID() : call.id;
    if (!text(id, 200) || !id || ids.has(id)) throw invalid();
    ids.add(id); safeJson(call.arguments); return { id, name: call.name, arguments: call.arguments };
  });
  if (!value.content.trim() && !toolCalls.length) throw invalid();
  return { role: 'assistant', content: value.content, toolCalls };
}

class AcpProcess {
  #child; #pending = new Map(); #nextId = 0; #decoder = new StringDecoder('utf8'); #buffer = ''; #wire = 0;
  #failure = null; #closed; #resolveClosed; #signal; #onAbort; #onUpdate; #timer; #disposing = false;
  constructor({ launch, args, options, signal, timeoutMs, onUpdate }) {
    signal?.throwIfAborted(); this.#signal = signal; this.#onUpdate = onUpdate;
    this.#closed = new Promise(resolve => { this.#resolveClosed = resolve; });
    try { this.#child = launch(options.nodeExecutable, args, options.spawn); }
    catch { throw failure('GEMINI_CLI_UNAVAILABLE', '无法启动内置 Gemini CLI，请重新安装软件。'); }
    const child = this.#child;
    if (!child?.stdin?.write || !child?.stdout?.on || !child?.on || typeof child.kill !== 'function') throw failure('GEMINI_CLI_UNAVAILABLE', 'Gemini CLI 进程不可用。');
    child.stdout.on('data', chunk => {
      if (this.#failure || this.#disposing) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.#wire += bytes.length;
      if (this.#wire > MAX_WIRE) return this.#fail(failure('GEMINI_RESPONSE_TOO_LARGE', 'Gemini CLI 响应过大，工具调用未执行。'));
      this.#buffer += this.#decoder.write(bytes);
      let split;
      while ((split = this.#buffer.indexOf('\n')) >= 0) {
        const line = this.#buffer.slice(0, split); this.#buffer = this.#buffer.slice(split + 1);
        if (Buffer.byteLength(line) > MAX_LINE) return this.#fail(invalid());
        if (!line.trim()) continue;
        let value; try { value = JSON.parse(line); } catch {
          return this.#fail([...this.#pending.values()].some(item => item.method === 'authenticate') ? unavailable() : invalid());
        }
        this.#receive(value);
      }
      if (Buffer.byteLength(this.#buffer) > MAX_LINE) this.#fail(invalid());
    });
    // Stderr can contain account URLs or credentials from upstream diagnostics.
    // Drain it without retaining, logging, parsing or publishing it.
    child.stderr?.on('data', () => {});
    child.on('error', () => this.#fail(failure('GEMINI_CLI_UNAVAILABLE', '无法运行内置 Gemini CLI，请重新安装软件。')));
    child.stdin.on?.('error', () => this.#fail(failure('GEMINI_CLI_EXITED', 'Gemini CLI 连接已关闭，请重试。')));
    child.once('close', () => {
      if (!this.#disposing) this.#fail(failure('GEMINI_CLI_EXITED', 'Gemini CLI 提前退出，工具调用未执行。'));
      this.#resolveClosed();
    });
    this.#onAbort = () => this.#fail(aborted()); signal?.addEventListener('abort', this.#onAbort, { once: true });
    this.#timer = setTimeout(() => this.#fail(failure('GEMINI_TIMEOUT', 'Gemini CLI 等待超时，请重试。')), timeoutMs);
    if (signal?.aborted) this.#onAbort();
  }
  #send(value) {
    if (this.#failure || this.#disposing) throw this.#failure || aborted();
    try { this.#child.stdin.write(JSON.stringify(value) + '\n'); }
    catch { this.#fail(failure('GEMINI_CLI_EXITED', 'Gemini CLI 连接已关闭，请重试。')); throw this.#failure; }
  }
  #receive(value) {
    if (!object(value) || value.jsonrpc !== '2.0') return this.#fail(invalid());
    if (typeof value.method === 'string') {
      if (value.id !== undefined) {
        // No filesystem, terminal, MCP or approval capability is delegated to
        // the child. Even an unexpected reverse request is always denied.
        const reply = value.method === 'session/request_permission'
          ? { jsonrpc: '2.0', id: value.id, result: { outcome: { outcome: 'cancelled' } } }
          : { jsonrpc: '2.0', id: value.id, error: { code: -32601, message: 'Capability unavailable' } };
        try { this.#send(reply); } catch {}
        return this.#fail(failure('GEMINI_UNEXPECTED_TOOL', 'Gemini CLI 请求了未授权的内置操作，已停止。'));
      }
      if (value.method === 'session/update') {
        try { this.#onUpdate?.(value.params); } catch (caught) { this.#fail(caught); }
      }
      return;
    }
    const pending = this.#pending.get(value.id); if (!pending) return;
    this.#pending.delete(value.id);
    if (object(value.error)) pending.reject(rpcFailure(pending.method, value.error));
    else if (!Object.hasOwn(value, 'result')) pending.reject(invalid());
    else pending.resolve(value.result);
  }
  #fail(caught) {
    if (this.#failure) return; this.#failure = caught;
    for (const pending of this.#pending.values()) pending.reject(caught);
    this.#pending.clear(); try { this.#child.kill(); } catch {}
  }
  request(method, params) {
    if (this.#failure || this.#disposing) return Promise.reject(this.#failure || aborted());
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId; this.#pending.set(id, { resolve, reject, method });
      try { this.#send({ jsonrpc: '2.0', id, method, params }); } catch (caught) { this.#pending.delete(id); reject(caught); }
    });
  }
  async dispose() {
    if (this.#disposing) return; this.#disposing = true;
    clearTimeout(this.#timer); this.#signal?.removeEventListener('abort', this.#onAbort);
    for (const pending of this.#pending.values()) pending.reject(aborted()); this.#pending.clear();
    try { this.#child.stdin.end(); this.#child.kill(); } catch {}
    let timer;
    await Promise.race([this.#closed, new Promise(resolve => { timer = setTimeout(resolve, 500); })]); clearTimeout(timer);
    try { if (this.#child.exitCode == null) this.#child.kill('SIGKILL'); } catch {}
  }
}

export class GeminiConnection {
  #dir; #file; #entry; #executable; #spawn; #env; #getProxyEnv; #onChange; #version; #initPromise;
  #profile = null; #models = null; #attempt = null; #failure = null; #storageError = false; #available = false;
  #closed = false; #generation = 0; #operations = new Set(); #pending = new Set(); #queue = Promise.resolve(); #removing = null;
  #bootstrap = Promise.resolve();
  #timeout; #signInTimeout;
  constructor({ dataDir, cliEntry, nodeExecutable = process.execPath, spawnImpl = spawn, env = {}, getProxyEnv = () => ({}), onChange = () => {},
    version = '0.0.0', requestTimeoutMs = 600_000, attemptTimeoutMs = 600_000 } = {}) {
    if (!path.isAbsolute(dataDir || '') || !path.isAbsolute(cliEntry || '') || !path.isAbsolute(nodeExecutable || '')
        || typeof spawnImpl !== 'function' || typeof onChange !== 'function' || typeof getProxyEnv !== 'function' || !object(env) || !text(version, 80)
        || ![requestTimeoutMs, attemptTimeoutMs].every(value => Number.isInteger(value) && value >= 1 && value <= 3_600_000))
      throw failure('GEMINI_INVALID_CONFIG', 'Gemini CLI 账号配置无效。');
    this.#dir = path.resolve(dataDir); this.#file = path.join(this.#dir, PROFILE_FILE); this.#entry = cliEntry;
    this.#executable = nodeExecutable; this.#spawn = spawnImpl; this.#env = { ...env }; this.#getProxyEnv = getProxyEnv; this.#onChange = onChange;
    this.#version = version; this.#timeout = requestTimeoutMs; this.#signInTimeout = attemptTimeoutMs;
  }
  #changed() { try { Promise.resolve(this.#onChange()).catch(() => {}); } catch {} }
  #track(pending) { this.#pending.add(pending); pending.then(() => this.#pending.delete(pending), () => this.#pending.delete(pending)); return pending; }
  #enqueue(operation) { const pending = this.#queue.then(operation); this.#queue = pending.catch(() => {}); return pending; }
  #home(id) {
    if (!UUID.test(id)) throw invalid();
    const home = path.join(this.#dir, 'gemini-cli-profiles', id);
    if (!home.startsWith(this.#dir + path.sep)) throw invalid(); return home;
  }
  async #directory(directory) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('GEMINI_STORAGE_UNREADABLE', 'Gemini 独立登录目录不可用。');
  }
  async #save(profile) {
    await this.#directory(this.#dir);
    const stat = await fs.lstat(this.#file).catch(caught => { if (caught.code === 'ENOENT') return null; throw caught; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw failure('GEMINI_STORAGE_UNREADABLE', 'Gemini 本机连接信息无法保存。');
    const temporary = path.join(this.#dir, `.gemini-connection-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, profileId: profile }) + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, this.#file);
    } finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  init() {
    return this.#initPromise ??= (async () => {
      this.#available = await fs.stat(this.#entry).then(stat => stat.isFile(), () => false);
      try {
        const stat = await fs.lstat(this.#file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw invalid();
        const value = JSON.parse(await fs.readFile(this.#file, 'utf8'));
        if (!object(value) || Object.keys(value).length !== 2 || value.version !== 1 || !Object.hasOwn(value, 'profileId')
            || value.profileId !== null && !UUID.test(value.profileId)) throw invalid();
        this.#profile = value.profileId; this.#failure = null; this.#storageError = false;
      } catch (caught) {
        if (caught.code !== 'ENOENT') { this.#storageError = true; this.#failure = { code: 'GEMINI_STORAGE_UNREADABLE', message: 'Gemini 本机连接信息无法读取，原文件已保留。' }; }
      }
      return this;
    })();
  }
  async publicState() {
    await this.init();
    const reauth = this.#storageError || this.#failure?.code === 'GEMINI_SIGN_IN_REQUIRED';
    return { cli: { available: this.#available, version: GEMINI_CLI_VERSION },
      session: { status: this.#attempt ? 'connecting' : reauth ? 'reauth_required' : this.#profile ? 'connected' : 'disconnected',
        sharing: Boolean(this.#profile) && !reauth && !this.#removing && !this.#closed, profileId: this.#profile },
      attempt: this.#attempt ? { phase: this.#attempt.phase, expiresAt: this.#attempt.expiresAt } : null,
      error: this.#failure ? { ...this.#failure } : null, storageRecovery: this.#storageError,
      storage: { owner: 'official-cli', isolated: true } };
  }
  redact(value) { return String(value); }
  #cancelOperations() { ++this.#generation; for (const operation of this.#operations) operation.abort(); }
  async #prepareHome(id) {
    const home = this.#home(id), work = path.join(home, 'work');
    await this.#directory(this.#dir);
    await this.#directory(path.join(this.#dir, 'gemini-cli-profiles')); await this.#directory(home); await this.#directory(work);
    await this.#directory(path.join(work, '.git')); await this.#directory(path.join(home, '.gemini'));
    const writeSettings = async filename => {
      const stat = await fs.lstat(filename).catch(caught => { if (caught.code === 'ENOENT') return null; throw caught; });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw failure('GEMINI_STORAGE_UNREADABLE', 'Gemini 独立配置无法写入。');
      await fs.writeFile(filename, JSON.stringify(SETTINGS), { mode: 0o600 });
    };
    // Explicit, isolated settings outrank untrusted project settings. No user
    // or project GEMINI.md, hooks, .env, tool discovery or MCP server is loaded.
    await writeSettings(path.join(home, '.gemini', 'settings.json'));
    return { home, work };
  }
  async #removeHome(id) {
    const home = this.#home(id), stat = await fs.lstat(home).catch(caught => { if (caught.code === 'ENOENT') return null; throw caught; });
    if (!stat) return; if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('GEMINI_STORAGE_UNREADABLE', 'Gemini 独立登录目录无法清理。');
    const real = await fs.realpath(home), parent = await fs.realpath(path.join(this.#dir, 'gemini-cli-profiles'));
    if (path.dirname(real).toLowerCase() !== parent.toLowerCase() || path.basename(real) !== id) throw invalid();
    await fs.rm(home, { recursive: true, force: true });
  }
  async #run(id, { signal, browser = false, model, timeoutMs = this.#timeout, onUpdate, sessionRequired = true, onPhase, operationPhase = 'prompt' } = {}, operation) {
    await this.init(); signal?.throwIfAborted();
    if (!this.#available) throw failure('GEMINI_CLI_UNAVAILABLE', '内置 Gemini CLI 不可用，请重新安装软件。');
    // Only startup is serialized: two live prompts can still generate in
    // parallel, but cannot reset selectedType while a peer creates its session.
    const previous = this.#bootstrap; let release;
    const gate = new Promise(resolve => { release = resolve; });
    this.#bootstrap = previous.then(() => gate, () => gate);
    let client, session, phase = 'initialize';
    const reportPhase = value => { phase = value; onPhase?.(value); };
    try {
      try {
        await abortable(() => previous, signal);
        const directories = await this.#prepareHome(id); signal?.throwIfAborted();
        let proxy;
        try { proxy = await abortable(() => this.#getProxyEnv(), signal); }
        catch (caught) { if (signal?.aborted) throw aborted(); throw failure('GEMINI_PROXY_FAILED', '无法读取当前网络代理，请稍后重试。'); }
        signal?.throwIfAborted();
        const proxyEnv = object(proxy) ? Object.fromEntries(Object.entries(proxy).filter(([key, value]) =>
          /^(?:https?_proxy|all_proxy|no_proxy)$/iu.test(key) && text(value, 4096))) : {};
        const args = [this.#entry, '--acp', '-e', 'none', '--approval-mode', 'default', ...(model ? ['--model', model] : [])];
        client = new AcpProcess({ launch: this.#spawn, args, signal, timeoutMs, onUpdate,
          options: { nodeExecutable: this.#executable, spawn: { cwd: directories.work,
            env: childEnvironment({ ...this.#env, ...proxyEnv }, directories.home, browser), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] } } });
        reportPhase('initialize');
        const initialized = await client.request('initialize', { protocolVersion: 1,
          clientInfo: { name: 'Cortex', version: this.#version }, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
        if (initialized?.protocolVersion !== 1 || initialized.agentInfo?.name !== 'gemini-cli'
            || initialized.agentInfo?.version !== GEMINI_CLI_VERSION || !initialized.authMethods?.some(value => value.id === 'oauth-personal'))
          throw failure('GEMINI_CLI_INCOMPATIBLE', '内置 Gemini CLI 版本或登录协议不匹配，请更新软件。');
        reportPhase('authenticate');
        await client.request('authenticate', { methodId: 'oauth-personal' });
        if (sessionRequired) {
          reportPhase('session-new');
          session = await client.request('session/new', { cwd: directories.work, mcpServers: [] });
          if (!text(session?.sessionId, 200) || !session.sessionId) throw invalid();
        }
      } finally { release(); }
      if (sessionRequired) reportPhase(operationPhase);
      return await operation(client, session);
    } catch (caught) {
      if (caught?.name === 'GeminiConnectionError') caught.phase ??= phase;
      throw caught;
    } finally { await client?.dispose(); }
  }
  signIn({ signal } = {}) {
    if (this.#closed) return Promise.reject(failure('GEMINI_CLOSED', 'Gemini 账号连接已关闭。'));
    if (this.#attempt) return this.#attempt.done;
    if (this.#removing) return Promise.reject(failure('GEMINI_BUSY', '请等待退出 Google 登录完成。'));
    const controller = new AbortController(), id = randomUUID(); this.#cancelOperations();
    const attempt = { controller, id, phase: 'initializing', expiresAt: Date.now() + this.#signInTimeout };
    let phase = 'initialize';
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    this.#attempt = attempt; this.#failure = null; this.#changed();
    attempt.done = this.#track((async () => {
      try {
        await this.init(); controller.signal.throwIfAborted();
        if (this.#storageError) throw failure('GEMINI_STORAGE_UNREADABLE', '请先恢复 Gemini 本机连接信息。');
        attempt.phase = 'waiting-browser'; this.#changed();
        // An official authenticate ACK completes login. Creating a model
        // session/catalog is a separate operation and must never roll back
        // already-confirmed Google authorization on a transient failure.
        await this.#run(id, { signal: controller.signal, browser: true, timeoutMs: this.#signInTimeout, sessionRequired: false,
          onPhase: value => { phase = value; } }, async () => {});
        controller.signal.throwIfAborted(); phase = 'storage'; attempt.phase = 'committing'; this.#changed();
        await this.#enqueue(async () => {
          controller.signal.throwIfAborted(); const previous = this.#profile;
          await this.#save(id);
          if (controller.signal.aborted || this.#closed) { await this.#save(previous); throw aborted(); }
          this.#profile = id; this.#models = null; this.#failure = null;
          if (previous && previous !== id) await this.#removeHome(previous).catch(() => {});
        });
      } catch (caught) {
        let safe = caught;
        if (!controller.signal.aborted) {
          safe = caught?.name === 'GeminiConnectionError' ? caught
            : phase === 'storage' ? failure('GEMINI_STORAGE_UNREADABLE', 'Google 授权已确认，但无法保存本机连接信息，请检查软件数据目录后重试。')
              : failure('GEMINI_SIGN_IN_FAILED', 'Google 账号登录未完成，请重试。');
          this.#failure = { code: safe.code, message: safe.message, phase, ...(safe.diagnostic ? { diagnostic: safe.diagnostic } : {}) };
        }
        if (this.#profile !== id) await this.#removeHome(id).catch(() => {});
        throw controller.signal.aborted ? aborted() : safe;
      } finally {
        signal?.removeEventListener('abort', abort); if (this.#attempt === attempt) this.#attempt = null; this.#changed();
      }
      return this.publicState();
    })());
    return attempt.done;
  }
  async cancelSignIn() { const attempt = this.#attempt; attempt?.controller.abort(); if (attempt) await attempt.done.catch(() => {}); return this.publicState(); }
  disconnect() {
    if (this.#removing) return this.#removing;
    this.#cancelOperations(); this.#attempt?.controller.abort();
    this.#removing = this.#track((async () => {
      await this.init(); await this.cancelSignIn();
      const previous = this.#profile; this.#profile = null; this.#models = null; this.#failure = null; this.#changed();
      await this.#enqueue(() => this.#save(null));
      if (previous) await this.#removeHome(previous); this.#storageError = false;
      return this.publicState();
    })().finally(() => { this.#removing = null; this.#changed(); }));
    return this.#removing;
  }
  async retryLocalRead() {
    if (this.#attempt || this.#removing) throw failure('GEMINI_BUSY', '请等待当前 Google 账号操作完成。');
    this.#cancelOperations(); this.#profile = null; this.#models = null; this.#initPromise = null;
    await this.init(); this.#changed(); return this.publicState();
  }
  #usable() { if (this.#closed || this.#attempt || this.#removing || !this.#profile || this.#storageError || this.#failure?.code === 'GEMINI_SIGN_IN_REQUIRED') throw unavailable(); return this.#profile; }
  async #accountOperation(signal, operation) {
    await this.init(); const id = this.#usable(), generation = this.#generation, controller = new AbortController();
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    this.#operations.add(controller);
    const current = () => {
      controller.signal.throwIfAborted();
      if (this.#profile !== id || generation !== this.#generation || this.#closed) throw aborted();
    };
    try { current(); const result = await operation({ id, signal: controller.signal, current }); current(); return result; }
    catch (caught) {
      if (caught?.name === 'GeminiConnectionError' && /^GEMINI_/u.test(caught.code) && id === this.#profile && generation === this.#generation) {
        this.#failure = { code: caught.code, message: caught.message, ...(caught.phase ? { phase: caught.phase } : {}), ...(caught.diagnostic ? { diagnostic: caught.diagnostic } : {}) }; this.#changed();
      }
      throw controller.signal.aborted ? aborted() : caught;
    } finally { this.#operations.delete(controller); signal?.removeEventListener('abort', abort); }
  }
  listModels({ force = false, signal } = {}) {
    return this.#track(this.#accountOperation(signal, async ({ id, signal, current }) => {
      if (!force && this.#models?.id === id && Date.now() - this.#models.at < 300_000) return structuredClone(this.#models.models);
      const models = await this.#run(id, { signal, operationPhase: 'model-list' }, async (_client, session) => modelList(session)); current();
      this.#models = { id, at: Date.now(), models }; this.#failure = null; return structuredClone(models);
    }));
  }
  requestModel(config = {}) {
    return this.#track(this.#accountOperation(config.signal, async ({ id, signal, current }) => {
      if (config.provider !== 'gemini' || config.authMode !== 'gemini-account' || !text(config.model, 200) || !/^[a-z\d][a-z\d_.:/-]*$/iu.test(config.model))
        throw failure('GEMINI_INVALID_CONFIG', 'Gemini 账号模型配置无效。');
      if (config.geminiProfileId && config.geminiProfileId !== id) throw failure('GEMINI_ACCOUNT_CHANGED', 'Google 账号已变化，请重新开始任务。');
      if (config.reasoningEffort && config.reasoningEffort !== 'default') throw failure('GEMINI_REASONING_UNSUPPORTED', 'Gemini CLI 账号模式使用官方模型的默认思考设置。');
      const timeoutMs = config.timeoutMs ?? this.#timeout;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw failure('GEMINI_INVALID_CONFIG', 'Gemini 请求超时配置无效。');
      const limit = config.maxModelPayloadBytes ?? 16 * 1024 * 1024;
      if (!Number.isInteger(limit) || limit < 1 || limit > 32 * 1024 * 1024) throw failure('GEMINI_INVALID_CONFIG', 'Gemini 响应限制配置无效。');
      if (['onTextDelta', 'onProgress'].some(key => config[key] !== undefined && typeof config[key] !== 'function'))
        throw failure('GEMINI_INVALID_CONFIG', 'Gemini 响应回调配置无效。');
      const input = modelInput(config.messages, config.tools || []); let content = '', sessionId;
      const notify = value => {
        current(); try { config.onProgress?.(value); }
        catch { throw failure('PROVIDER_CALLBACK_ERROR', 'Gemini 响应回调失败，工具调用未执行。'); }
      };
      return this.#run(id, { signal, model: config.model, timeoutMs, onUpdate: event => {
        current(); if (!sessionId || event?.sessionId !== sessionId) return;
        const update = event.update;
        if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) throw failure('GEMINI_UNEXPECTED_TOOL', 'Gemini CLI 请求了内置操作，工具调用未执行。');
        if (update?.sessionUpdate === 'agent_thought_chunk') notify({ phase: 'thinking' });
        if (update?.sessionUpdate === 'agent_message_chunk') {
          if (update.content?.type !== 'text' || typeof update.content.text !== 'string') throw invalid();
          content += update.content.text;
          if (Buffer.byteLength(content) > limit) throw failure('GEMINI_RESPONSE_TOO_LARGE', 'Gemini 回复过大，工具调用未执行。');
          notify({ phase: 'generating' });
        }
      } }, async (client, session) => {
        sessionId = session.sessionId;
        if (!modelList(session).some(model => model.id === config.model)) throw failure('GEMINI_MODEL_UNAVAILABLE', '此 Google 账号未列出所选模型，请刷新模型目录。');
        const result = await client.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: input.prompt }] }); current();
        const raw = result?.usage, reported = count(raw?.inputTokens) && count(raw?.outputTokens)
          && (raw.thoughtTokens === undefined || count(raw.thoughtTokens)) && Number.isSafeInteger(raw.outputTokens + (raw.thoughtTokens || 0));
        const usage = reported ? { inputTokens: raw.inputTokens, outputTokens: raw.outputTokens + (raw.thoughtTokens || 0),
          ...(count(raw.cachedReadTokens) && raw.cachedReadTokens <= raw.inputTokens ? { cachedInputTokens: raw.cachedReadTokens } : {}) } : null;
        if (usage) notify({ phase: 'generating', usage });
        if (result?.stopReason === 'cancelled') throw aborted();
        if (result?.stopReason !== 'end_turn') throw failure('PROVIDER_TRUNCATED', 'Gemini 响应未完整结束，工具调用未执行。');
        const message = modelReply(content, input.names); current();
        try { if (message.content) config.onTextDelta?.(message.content); }
        catch { throw failure('PROVIDER_CALLBACK_ERROR', 'Gemini 响应回调失败，工具调用未执行。'); }
        this.#failure = null;
        return { message, usage: usage || { inputTokens: 0, outputTokens: 0 }, usageReported: reported };
      });
    }));
  }
  async settled() { await this.#queue; await Promise.allSettled([...this.#pending]); }
  async dispose() { if (this.#closed) return; this.#closed = true; this.#cancelOperations(); this.#attempt?.controller.abort(); await this.settled(); }
}
