import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { killAntigravityProcessTree } from './antigravity-agent.mjs';
import { externalAgentPrompt } from './external-agent-context.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 512) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const id = value => text(value) && value.length > 0;
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u.test(value);
const toolKind = name => /bash|shell/iu.test(name) ? 'execute' : /write|edit|notebook/iu.test(name) ? 'edit' : /read|glob|grep|search/iu.test(name) ? 'read' : 'other';
const fail = (code, message) => Object.assign(new Error(`[${code}] ${message}`), { name: 'ClaudeError', code });
const cancelled = () => Object.assign(fail('CLAUDE_CANCELLED', 'Claude 操作已取消。'), { name: 'AbortError' });
const invalid = () => fail('CLAUDE_PROTOCOL_ERROR', '官方 Claude 代理返回了无效数据。');
const check = signal => { if (signal?.aborted) throw cancelled(); };
function wait(operation, signal, timeoutMs = 0) {
  check(signal);
  return new Promise((resolve, reject) => {
    let done = false, timer;
    const finish = (error, value) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => finish(cancelled()); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    if (timeoutMs) timer = setTimeout(() => finish(fail('CLAUDE_TIMEOUT', '官方 Claude 请求超时，请重试。')), timeoutMs);
    Promise.resolve().then(operation).then(value => finish(null, value), error => finish(error));
  });
}
function safeError(error) {
  if (error?.name === 'AbortError') return cancelled();
  if (error?.name === 'ClaudeError') return error;
  // Inspect only bounded diagnostics for classification; never expose the SDK's
  // raw errors, stderr, paths, headers, account identity or credentials.
  const detail = typeof error?.message === 'string' ? error.message.slice(0, 4096) : '';
  if (/not logged in|authentication|unauthorized|invalid.*token|expired.*token|\b401\b/iu.test(detail)) return fail('CLAUDE_AUTH_REQUIRED', '请通过官方 Claude 程序重新登录。');
  if (/credit|quota|rate.?limit|\b429\b|usage.?limit/iu.test(detail)) return fail('CLAUDE_USAGE_LIMIT', 'Claude 官方额度不足或请求受限，请在官方账号中确认套餐、使用额度及计费。');
  if (/cli_version_too_old|unsupported.*version/iu.test(detail)) return fail('CLAUDE_RUNTIME_OUTDATED', '官方 Claude 程序版本过旧，请更新后重试。');
  return fail('CLAUDE_REQUEST_FAILED', '官方 Claude 请求未完成，请检查账号、访问权限和网络后重试。');
}
function modelsFrom(rows) {
  if (!Array.isArray(rows) || rows.length > 256) throw invalid();
  const seen = new Set();
  return rows.map(row => {
    if (!object(row) || !id(row.value) || seen.has(row.value)) throw invalid(); seen.add(row.value);
    const efforts = Array.isArray(row.supportedEffortLevels) ? [...new Set(row.supportedEffortLevels)] : [];
    if (efforts.some(value => !['low', 'medium', 'high', 'xhigh', 'max'].includes(value))) throw invalid();
    return { id: row.value, displayName: text(row.displayName, 256) && row.displayName ? row.displayName : row.value,
      compatible: true, textCompatible: true, supportsTools: true, supportsImages: true, reasoningEfforts: efforts,
      reasoningOptions: efforts.map(value => ({ value, label: value })) };
  });
}
function blocks(prompt, attachments) {
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 4 * 1024 * 1024 || !Array.isArray(attachments) || attachments.length > 20)
    throw fail('CLAUDE_INVALID_INPUT', 'Claude 任务或附件格式无效。');
  const content = [{ type: 'text', text: prompt }]; let bytes = Buffer.byteLength(prompt);
  for (const item of attachments) {
    let { mimeType, data } = object(item) ? item : {};
    if (typeof item?.dataUrl === 'string') { const match = /^data:([a-z\d.+-]+\/[a-z\d.+-]+);base64,([A-Za-z\d+/=\r\n]+)$/iu.exec(item.dataUrl); if (!match) throw fail('CLAUDE_INVALID_INPUT', 'Claude 图片格式无效。'); [, mimeType, data] = match; }
    if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mimeType) || typeof data !== 'string' || !data || !/^[A-Za-z\d+/]*={0,2}$/u.test(data.replace(/[\r\n]/gu, '')))
      throw fail('CLAUDE_INVALID_INPUT', 'Claude 图片格式无效。');
    bytes += data.length; if (bytes > 32 * 1024 * 1024) throw fail('CLAUDE_INVALID_INPUT', 'Claude 附件总大小过大。');
    content.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data: data.replace(/[\r\n]/gu, '') } });
  }
  return content;
}
function inputQueue() {
  const rows = [], readers = []; let closed = false;
  return { push(value) { if (closed) throw cancelled(); if (readers.length) readers.shift()({ value, done: false }); else rows.push(value); },
    close() { closed = true; for (const resolve of readers.splice(0)) resolve({ done: true }); },
    [Symbol.asyncIterator]() { return this; }, next() { return rows.length ? Promise.resolve({ value: rows.shift(), done: false }) : closed ? Promise.resolve({ done: true }) : new Promise(resolve => readers.push(resolve)); },
    return() { this.close(); return Promise.resolve({ done: true }); } };
}

// The unchanged official SDK drives the unchanged official CLI, agent loop,
// authentication and tools. Synora never obtains an OAuth client/token or calls
// the Messages API using subscription credentials. Anthropic decides access and
// billing. Product use remains subject to Anthropic's SDK authentication terms.
export class ClaudeAgent {
  #root; #dir; #profiles; #work; #file; #runtime; #spawn; #kill; #proxy; #onChange; #onEvent; #permission; #userInput; #sdkLoader; #platform;
  #profile = null; #models = []; #sessions = new Map(); #error = null; #storageError = false; #init; #writes = Promise.resolve();
  #attempt = null; #active = null; #closed = false; #epoch = 0; #catalog = null; #children = new Set();
  #startTimeout; #loginTimeout; #timeout; #stopGrace;
  constructor({ dataDir, runtime, spawnImpl = spawn, killTreeImpl, getProxyEnv = () => ({}), onChange = () => {}, onEvent = () => {},
    onPermission = async () => null, onUserInput = async () => ({ action: 'cancel' }), sdkLoader = () => import('@anthropic-ai/claude-agent-sdk'),
    platform = process.platform, startTimeoutMs = 60000, loginTimeoutMs = 600000, requestTimeoutMs = 3600000, stopGraceMs = 1500 } = {}) {
    if (!path.isAbsolute(dataDir || '') || !runtime?.ensure || !runtime?.publicState || [spawnImpl, getProxyEnv, onChange, onEvent, onPermission, onUserInput, sdkLoader].some(value => typeof value !== 'function')
        || killTreeImpl !== undefined && typeof killTreeImpl !== 'function' || ![startTimeoutMs, loginTimeoutMs, stopGraceMs].every(value => Number.isInteger(value) && value > 0 && value <= 600000)
        || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs <= 0 || requestTimeoutMs > 86400000) throw fail('CLAUDE_INVALID_INPUT', 'Claude 代理配置无效。');
    this.#root = path.resolve(dataDir); this.#dir = path.join(this.#root, 'claude-agent'); this.#profiles = path.join(this.#dir, 'profiles'); this.#work = path.join(this.#dir, 'catalog-workspace'); this.#file = path.join(this.#dir, 'profiles.json');
    this.#runtime = runtime; this.#spawn = spawnImpl; this.#platform = platform; this.#kill = killTreeImpl || (child => killAntigravityProcessTree(child, { platform }));
    this.#proxy = getProxyEnv; this.#onChange = onChange; this.#onEvent = onEvent; this.#permission = onPermission; this.#userInput = onUserInput; this.#sdkLoader = sdkLoader;
    this.#startTimeout = startTimeoutMs; this.#loginTimeout = loginTimeoutMs; this.#timeout = requestTimeoutMs; this.#stopGrace = stopGraceMs;
  }
  #changed() { try { Promise.resolve(this.#onChange()).catch(() => {}); } catch {} }
  #publish(error, phase) { const safe = safeError(error); this.#error = { code: safe.code, message: safe.message, phase }; this.#changed(); return safe; }
  async #directory(directory) {
    const relative = path.relative(this.#root, directory); if (relative.startsWith('..') || path.isAbsolute(relative)) throw invalid();
    let current = this.#root;
    for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      await fs.mkdir(current, { recursive: current === this.#root }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    }
  }
  async #read() {
    try {
      await this.#directory(this.#profiles); await this.#directory(this.#work);
      const stat = await fs.lstat(this.#file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (!stat) return;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw invalid();
      const raw = await fs.readFile(this.#file, 'utf8'); if (Buffer.byteLength(raw) > 1024 * 1024) throw invalid();
      const value = JSON.parse(raw);
      if (!object(value) || value.version !== 1 || !(value.profileId === null || uuid(value.profileId)) || !Array.isArray(value.sessions) || value.sessions.length > 256) throw invalid();
      const sessions = new Map();
      for (const row of value.sessions) {
        if (!object(row) || !id(row.localSessionId) || !uuid(row.id) || row.profile !== value.profileId || !uuid(row.profile) || typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd) || /[\x00\r\n]/u.test(row.cwd) || sessions.has(row.localSessionId)) throw invalid();
        sessions.set(row.localSessionId, { id: row.id, cwd: row.cwd, profile: row.profile });
      }
      if (value.profileId) { const profile = await fs.lstat(path.join(this.#profiles, value.profileId)); if (!profile.isDirectory() || profile.isSymbolicLink()) throw invalid(); }
      this.#profile = value.profileId; this.#sessions = sessions;
    } catch { this.#storageError = true; this.#profile = null; this.#sessions.clear(); this.#error = { code: 'CLAUDE_STORAGE_UNREADABLE', message: '[CLAUDE_STORAGE_UNREADABLE] 无法读取 Claude 连接记录，请重试读取或退出连接。', phase: 'storage' }; }
  }
  init() { return this.#init ||= (async () => { await this.#runtime.init?.(); await this.#read(); return this; })(); }
  #save(signal) {
    this.#writes = this.#writes.catch(() => {}).then(async () => {
      const temporary = path.join(this.#dir, `.profiles-${randomUUID()}.json`);
      try {
        check(signal); await this.#directory(this.#dir);
        const stat = await fs.lstat(this.#file).catch(error => { if (error.code === 'ENOENT') return null; throw error; }); if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw invalid();
        const value = { version: 1, profileId: this.#profile, sessions: [...this.#sessions].slice(-256).map(([localSessionId, session]) => ({ localSessionId, ...session })) };
        await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); check(signal); await fs.rename(temporary, this.#file);
      } catch (error) { if (error.name === 'AbortError') throw error; this.#storageError = true; throw fail('CLAUDE_STORAGE_ERROR', '无法保存 Claude 连接记录。'); }
      finally { await fs.unlink(temporary).catch(() => {}); }
    }); return this.#writes;
  }
  async publicState() {
    await this.init();
    return { runtime: await this.#runtime.publicState(),
      session: { status: this.#attempt ? 'connecting' : this.#storageError || this.#error?.code === 'CLAUDE_AUTH_REQUIRED' ? 'reauth_required' : this.#profile ? 'connected' : 'disconnected',
        sharing: Boolean(this.#profile) && !this.#storageError && this.#error?.code !== 'CLAUDE_AUTH_REQUIRED', profileId: this.#profile },
      attempt: this.#attempt ? { phase: this.#attempt.phase } : null, error: this.#error ? structuredClone(this.#error) : null, storageRecovery: this.#storageError,
      storage: { owner: 'official-agent', homeIsolated: true, credentialScope: 'app-isolated', identityVerified: false }, status: this.#active ? 'running' : 'idle',
      models: structuredClone(this.#models), modes: [{ id: 'default', name: '需要时审批' }, { id: 'plan', name: '规划' }], agent: { name: 'Claude Agent', sdkVersion: '0.3.310' } };
  }
  #usable() { if (this.#closed) throw fail('CLAUDE_CLOSED', 'Claude 代理已关闭。'); if (!this.#profile || this.#storageError || this.#error?.code === 'CLAUDE_AUTH_REQUIRED') throw fail('CLAUDE_AUTH_REQUIRED', '请先通过官方程序连接 Claude 账号。'); if (this.#attempt) throw fail('CLAUDE_BUSY', '请等待 Claude 登录完成。'); return this.#profile; }
  async #options(profile, cwd, signal) {
    check(signal); const home = path.join(this.#profiles, profile); await this.#directory(home);
    const proxy = await wait(() => this.#proxy(), signal);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|home|userprofile|appdata|localappdata|lang|lc_all|node_extra_ca_certs)$/iu.test(key) && typeof value === 'string'));
    if (object(proxy)) for (const [key, value] of Object.entries(proxy)) if (/^(?:https?_proxy|all_proxy|no_proxy)$/iu.test(key) && text(value, 4096)) env[key] = value;
    env.CLAUDE_CONFIG_DIR = home;
    return { cwd, env, shell: false, windowsHide: true, detached: this.#platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] };
  }
  #spawnChild(entry, args, options) {
    const child = this.#spawn(entry, args, options); this.#children.add(child); child.once('close', () => this.#children.delete(child));
    // Never publish official stderr; it may include account diagnostics.
    child.stderr?.on('data', () => {}); return child;
  }
  async #command(entry, args, options, signal, timeoutMs, collect = false) {
    check(signal); const child = this.#spawnChild(entry, args, options); let size = 0, buffer = '';
    try {
      const completion = new Promise((resolve, reject) => {
        child.stdout?.on('data', bytes => { size += bytes.length; if (size > 1024 * 1024) return reject(invalid()); if (collect) buffer += bytes.toString('utf8'); });
        child.once('error', () => reject(fail('CLAUDE_START_FAILED', '官方 Claude 程序无法运行。')));
        child.once('close', code => code === 0 || args[1] === 'status' && code === 1 ? resolve({ code, output: buffer }) : reject(fail('CLAUDE_AUTH_FAILED', '官方 Claude 账号操作未完成，请重试。')));
      });
      return await wait(() => completion, signal, timeoutMs);
    } finally { if (child.exitCode == null) await this.#kill(child); }
  }
  async #status(entry, options, signal) {
    const result = await this.#command(entry, ['auth', 'status'], options, signal, this.#startTimeout, true);
    let state; try { state = JSON.parse(result.output); } catch { throw invalid(); }
    if (!object(state) || state.loggedIn !== true || !['claude.ai', 'oauth_token'].includes(state.authMethod)) throw fail('CLAUDE_AUTH_REQUIRED', '官方 Claude 程序尚未连接 Claude 账号，请重新登录并确认账号访问权限。');
  }
  async #removeProfile(profile) {
    if (!uuid(profile)) return; const directory = path.join(this.#profiles, profile), stat = await fs.lstat(directory).catch(() => null); if (!stat) return;
    const parent = await fs.lstat(this.#profiles); if (!parent.isDirectory() || parent.isSymbolicLink() || !stat.isDirectory() || stat.isSymbolicLink()
        || path.dirname(await fs.realpath(directory)).toLowerCase() !== (await fs.realpath(this.#profiles)).toLowerCase()) throw fail('CLAUDE_STORAGE_ERROR', '无法安全清理 Claude 连接目录。');
    await fs.rm(directory, { recursive: true, force: true });
  }
  async signIn({ signal } = {}) {
    await this.init(); check(signal); if (this.#closed) throw fail('CLAUDE_CLOSED', 'Claude 代理已关闭。'); if (this.#storageError) throw fail('CLAUDE_STORAGE_UNREADABLE', '请先重试读取 Claude 连接记录。');
    if (this.#attempt) return this.#attempt.done; if (this.#active || this.#catalog) throw fail('CLAUDE_BUSY', '请先停止 Claude 任务或目录读取。');
    const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const attempt = { controller, profile: randomUUID(), phase: 'starting', done: null }; this.#attempt = attempt; this.#error = null; this.#changed();
    attempt.done = (async () => {
      const old = { profile: this.#profile, sessions: this.#sessions }; let committed = false;
      try {
        const runtime = await this.#runtime.ensure({ signal: controller.signal }), options = await this.#options(attempt.profile, this.#work, controller.signal);
        attempt.phase = 'browser'; this.#changed(); await this.#command(runtime.entry, ['auth', 'login', '--claudeai'], options, controller.signal, this.#loginTimeout);
        attempt.phase = 'verifying'; this.#changed(); await this.#status(runtime.entry, options, controller.signal); check(controller.signal);
        attempt.phase = 'committing'; this.#profile = attempt.profile; this.#sessions = new Map(); await this.#save(controller.signal); check(controller.signal);
        committed = true; this.#models = []; this.#error = null;
      } catch (error) {
        this.#profile = old.profile; this.#sessions = old.sessions;
        if (attempt.phase === 'committing') { try { await this.#save(); } catch { this.#storageError = true; } }
        if (!controller.signal.aborted) this.#publish(error, attempt.phase === 'committing' ? 'storage' : 'authenticate'); throw controller.signal.aborted ? cancelled() : safeError(error);
      } finally {
        if (!committed) await this.#removeProfile(attempt.profile).catch(() => {});
        signal?.removeEventListener('abort', abort); if (this.#attempt === attempt) this.#attempt = null; this.#changed();
      }
      return this.publicState();
    })(); return attempt.done;
  }
  async cancelSignIn() { const attempt = this.#attempt; attempt?.controller.abort(); await attempt?.done.catch(() => {}); return this.publicState(); }
  async #query({ profile, cwd, controller, onPermission, onUserInput, localSessionId, sessionId, modeId = 'default', modelId, reasoningEffort, persist = true } = {}) {
    const runtime = await this.#runtime.ensure({ signal: controller.signal }), options = await this.#options(profile, cwd, controller.signal);
    await this.#status(runtime.entry, { ...options, cwd: this.#work }, controller.signal);
    const sdk = await wait(() => this.#sdkLoader(), controller.signal); if (typeof sdk?.query !== 'function') throw fail('CLAUDE_SDK_MISSING', '官方 Claude Agent SDK 不完整，请重新安装软件。');
    const input = inputQueue(), children = new Set();
    let query;
    try { query = sdk.query({ prompt: input, options: { pathToClaudeCodeExecutable: runtime.entry, cwd, env: options.env,
      abortController: controller, permissionMode: modeId, settingSources: [], strictMcpConfig: true, mcpServers: {}, includePartialMessages: true, persistSession: persist,
      ...(sessionId ? { resume: sessionId } : {}), ...(modelId ? { model: modelId } : {}), ...(reasoningEffort && reasoningEffort !== 'default' ? { effort: reasoningEffort } : {}),
      canUseTool: (name, toolInput, info) => this.#approve({ profile, localSessionId, sessionId, controller, onPermission, onUserInput }, name, toolInput, info),
      spawnClaudeCodeProcess: spawnOptions => {
        check(controller.signal);
        if (path.resolve(spawnOptions.command) !== path.resolve(runtime.entry) || !Array.isArray(spawnOptions.args)) throw invalid();
        const child = this.#spawnChild(runtime.entry, spawnOptions.args, { ...options, cwd: spawnOptions.cwd || cwd, env: spawnOptions.env, signal: spawnOptions.signal }); children.add(child); return child;
      }, stderr: () => {} } }); }
    catch (error) { input.close(); await Promise.allSettled([...children].filter(child => child.exitCode == null).map(child => this.#kill(child))); throw error; }
    return { query, input, children };
  }
  async #closeQuery(handle) {
    if (!handle) return; handle.input.close(); try { handle.query.close(); } catch {}
    await Promise.allSettled([...handle.children].filter(child => child.exitCode == null).map(child => this.#kill(child)));
  }
  async listModels({ cwd, signal } = {}) {
    await this.init(); const profile = this.#usable(); if (this.#active) return structuredClone(this.#models); if (this.#catalog) return wait(() => this.#catalog.done, signal);
    cwd ||= this.#work; if (!path.isAbsolute(cwd) || /[\x00\r\n]/u.test(cwd)) throw fail('CLAUDE_INVALID_INPUT', 'Claude 工作目录无效。');
    const controller = new AbortController(), abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const operation = { controller, handle: null, done: null }; this.#catalog = operation;
    operation.done = (async () => {
      try {
        operation.handle = await this.#query({ profile, cwd, controller, persist: false });
        const rows = await wait(() => operation.handle.query.supportedModels(), controller.signal, this.#startTimeout); check(controller.signal);
        if (profile !== this.#profile) throw cancelled(); this.#models = modelsFrom(rows); this.#error = null; this.#changed(); return structuredClone(this.#models);
      } catch (error) { if (!controller.signal.aborted) this.#publish(error, 'model-list'); throw controller.signal.aborted ? cancelled() : safeError(error); }
      finally { await this.#closeQuery(operation.handle); signal?.removeEventListener('abort', abort); if (this.#catalog === operation) this.#catalog = null; }
    })(); return operation.done;
  }
  async #approve(active, name, input, info) {
    const denied = { behavior: 'deny', message: 'Request was cancelled or not approved' };
    const signal = info?.signal instanceof AbortSignal ? AbortSignal.any([active.controller.signal, info.signal]) : active.controller.signal;
    const current = () => !signal.aborted && active.profile === this.#profile && this.#active?.controller === active.controller;
    if (!current() || !id(name) || !object(input) || !id(info?.toolUseID)) return denied;
    try {
      if (name === 'AskUserQuestion') {
        if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 8) return denied;
        const response = await wait(() => (active.onUserInput || this.#userInput)({ localSessionId: active.localSessionId, sessionId: this.#active.sessionId,
          questions: structuredClone(input.questions), signal }), signal);
        if (!current() || response?.action !== 'accept' || !object(response.content?.answers)) return denied;
        const answers = response.content.answers;
        if (input.questions.some(question => !id(question?.question) || typeof answers[question.question] !== 'string' || !answers[question.question].trim() || answers[question.question].length > 4000)) return denied;
        return { behavior: 'allow', updatedInput: { ...input, answers: structuredClone(answers) } };
      }
      const selected = await wait(() => (active.onPermission || this.#permission)({ localSessionId: active.localSessionId, sessionId: this.#active.sessionId,
        toolCall: { toolCallId: info.toolUseID, title: text(info.title, 2000) ? info.title : name, kind: toolKind(name), rawInput: structuredClone(input) },
        options: [{ optionId: 'allow', kind: 'allow_once', name: '允许一次' }, { optionId: 'deny', kind: 'reject_once', name: '拒绝' }], signal }), signal);
      return current() && selected === 'allow' ? { behavior: 'allow', updatedInput: input } : denied;
    } catch { return denied; }
  }
  async #emit(active, update) {
    check(active.controller.signal); const event = { localSessionId: active.localSessionId, sessionId: active.sessionId, update };
    for (const callback of [active.onUpdate, this.#onEvent]) if (callback) await wait(() => callback(event), active.controller.signal);
  }
  async #message(active, message) {
    if (!object(message)) throw invalid();
    if (uuid(message.session_id)) {
      if (active.sessionId && active.sessionId !== message.session_id) throw fail('CLAUDE_SESSION_CHANGED', 'Claude 官方会话发生变化，请新建会话。');
      if (!active.sessionId) { active.sessionId = message.session_id; this.#sessions.set(active.localSessionId, { id: active.sessionId, cwd: active.cwd, profile: active.profile }); await this.#save(active.controller.signal); }
    }
    if (message.type === 'stream_event' && object(message.event)) {
      const event = message.event;
      if (event.type === 'message_start') { active.streamMessage = event.message?.id; if (id(active.streamMessage)) active.streamed.add(active.streamMessage); }
      if (event.type === 'content_block_delta' && ['text_delta', 'thinking_delta'].includes(event.delta?.type)) {
        const thinking = event.delta.type === 'thinking_delta', delta = thinking ? event.delta.thinking : event.delta.text;
        if (typeof delta === 'string' && delta) { if (!thinking) active.text += delta; await this.#emit(active, { sessionUpdate: thinking ? 'agent_thought_chunk' : 'agent_message_chunk', content: { type: 'text', text: delta } }); }
      }
    } else if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
      const streamed = active.streamed.has(message.message.id);
      for (const content of message.message.content) {
        if (content.type === 'text' && typeof content.text === 'string' && !streamed) { active.text += content.text; await this.#emit(active, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: content.text } }); }
        else if (content.type === 'thinking' && typeof content.thinking === 'string' && !streamed) await this.#emit(active, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: content.thinking } });
        else if (content.type === 'tool_use' && id(content.id) && id(content.name)) await this.#emit(active, { sessionUpdate: 'tool_call', toolCallId: content.id, title: content.name, kind: toolKind(content.name), status: 'in_progress', rawInput: content.input });
      }
    } else if (message.type === 'user' && Array.isArray(message.message?.content)) {
      for (const content of message.message.content) if (content.type === 'tool_result' && id(content.tool_use_id)) {
        const native = Array.isArray(content.content) ? content.content.slice(0, 256) : [];
        const normalized = native.flatMap(block => {
          if (block?.type === 'text' && typeof block.text === 'string') return [{ type: 'content', content: { type: 'text', text: block.text } }];
          if (block?.type === 'image' && block.source?.type === 'base64' && typeof block.source.data === 'string'
              && ['image/png', 'image/jpeg', 'image/webp'].includes(block.source.media_type))
            return [{ type: 'content', content: { type: 'image', mimeType: block.source.media_type, data: block.source.data } }];
          return [];
        });
        await this.#emit(active, { sessionUpdate: 'tool_call_update', toolCallId: content.tool_use_id, status: content.is_error ? 'failed' : 'completed',
          ...(normalized.length ? { content: normalized } : {}), rawOutput: content.content });
      }
    }
    if (message.type !== 'result') return null;
    if (message.is_error || message.subtype !== 'success') throw safeError(new Error([message.startup_failure_reason, ...(Array.isArray(message.errors) ? message.errors : [])].filter(value => typeof value === 'string').join(' ').slice(0, 4096)));
    if (!active.sessionId) throw invalid();
    if (!active.text && typeof message.result === 'string' && message.result) await this.#emit(active, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message.result } });
    const raw = message.usage, valid = object(raw) && Number.isSafeInteger(raw.input_tokens) && raw.input_tokens >= 0 && Number.isSafeInteger(raw.output_tokens) && raw.output_tokens >= 0;
    const cached = valid ? [raw.cache_read_input_tokens, raw.cache_creation_input_tokens].reduce((sum, value) => sum + (Number.isSafeInteger(value) && value >= 0 ? value : 0), 0) : 0;
    const usage = valid ? { inputTokens: raw.input_tokens + cached, outputTokens: raw.output_tokens } : null;
    return { sessionId: active.sessionId, stopReason: 'end_turn', usage, usageReported: Boolean(usage) };
  }
  async runTask({ localSessionId, cwd, prompt, contextMessages, attachments = [], modelId, reasoningEffort = 'default', modeId = 'default', signal, onUpdate, onPermission, onUserInput } = {}) {
    await this.init(); const profile = this.#usable(); check(signal);
    if (this.#active || this.#catalog) throw fail('CLAUDE_BUSY', 'Claude 已有任务或目录读取正在运行。');
    if (!id(localSessionId) || typeof cwd !== 'string' || !path.isAbsolute(cwd) || /[\x00\r\n]/u.test(cwd) || modelId !== undefined && !id(modelId)
        || !['default', 'low', 'medium', 'high', 'xhigh', 'max'].includes(reasoningEffort) || !['default', 'plan'].includes(modeId)
        || [onUpdate, onPermission, onUserInput].some(value => value !== undefined && typeof value !== 'function')) throw fail('CLAUDE_INVALID_INPUT', 'Claude 会话配置无效。');
    blocks(prompt, attachments); const previous = this.#sessions.get(localSessionId);
    if (previous && (previous.cwd !== cwd || previous.profile !== profile)) throw fail('CLAUDE_SESSION_CHANGED', 'Claude 会话绑定的账号或项目已变化，请新建会话。');
    const controller = new AbortController(), abort = () => { controller.abort(); void this.stop(); }; signal?.addEventListener('abort', abort, { once: true });
    const active = { localSessionId, cwd, profile, controller, sessionId: previous?.id, handle: null, done: null, onUpdate, onPermission, onUserInput, text: '', streamed: new Set(), stopping: null };
    this.#active = active; this.#error = null; this.#changed(); if (signal?.aborted) abort();
    active.done = (async () => {
      let timer;
      try {
        active.handle = await this.#query({ ...active, modelId, reasoningEffort, modeId });
        const models = modelsFrom(await wait(() => active.handle.query.supportedModels(), controller.signal, this.#startTimeout)); this.#models = models;
        const selected = modelId ? models.find(row => row.id === modelId) : null;
        if (modelId && !selected) throw fail('CLAUDE_MODEL_UNAVAILABLE', '官方 Claude 目录没有提供所选模型，请刷新目录。');
        if (reasoningEffort !== 'default' && (!selected || !selected.reasoningEfforts.includes(reasoningEffort))) throw fail('CLAUDE_EFFORT_UNSUPPORTED', '当前 Claude 模型没有提供所选推理强度，请改用目录支持的档位。');
        check(controller.signal); if (profile !== this.#profile) throw cancelled();
        const continued = previous ? prompt : externalAgentPrompt(prompt, contextMessages);
        active.handle.input.push({ type: 'user', session_id: active.sessionId || '', message: { role: 'user', content: blocks(continued, attachments) }, parent_tool_use_id: null });
        timer = setTimeout(() => { active.timedOut = true; controller.abort(); void this.stop(); }, this.#timeout);
        const iterator = active.handle.query[Symbol.asyncIterator]();
        while (true) {
          const item = await wait(() => iterator.next(), controller.signal); if (item.done) throw fail('CLAUDE_TASK_INCOMPLETE', '官方 Claude 代理已退出，任务未完整完成。');
          const result = await this.#message(active, item.value); if (result) { check(controller.signal); this.#error = null; return result; }
        }
      } catch (error) {
        if (active.timedOut) throw this.#publish(fail('CLAUDE_TIMEOUT', '官方 Claude 任务超时，已停止代理。'), 'task');
        if (!controller.signal.aborted) this.#publish(error, 'task'); throw controller.signal.aborted ? cancelled() : safeError(error);
      }
      finally { clearTimeout(timer); await this.#closeQuery(active.handle); signal?.removeEventListener('abort', abort); if (this.#active === active) this.#active = null; this.#changed(); }
    })(); return active.done;
  }
  async stop() {
    const active = this.#active, catalog = this.#catalog;
    if (catalog) { catalog.controller.abort(); await this.#closeQuery(catalog.handle); await catalog.done?.catch(() => {}); }
    if (!active) return; if (active.stopping) return active.stopping; active.controller.abort();
    active.stopping = (async () => { try { const interrupt = active.handle?.query.interrupt?.(); if (interrupt) void Promise.resolve(interrupt).catch(() => {}); } catch {}
      let timer; await Promise.race([active.done?.catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, this.#stopGrace); })]); clearTimeout(timer);
      await this.#closeQuery(active.handle); await active.done?.catch(() => {});
    })(); return active.stopping;
  }
  async disconnect() {
    await this.init(); ++this.#epoch; const attempt = this.#attempt; attempt?.controller.abort(); await this.stop(); await attempt?.done.catch(() => {});
    const profile = this.#profile; this.#profile = null; this.#models = []; this.#sessions.clear(); this.#error = null;
    if (!this.#storageError) await this.#save();
    if (profile) await this.#removeProfile(profile); this.#changed(); return this.publicState();
  }
  async retryLocalRead() { if (this.#active || this.#attempt || this.#catalog) throw fail('CLAUDE_BUSY', '请先停止 Claude 任务、登录或目录读取。'); this.#profile = null; this.#sessions.clear(); this.#storageError = false; this.#error = null; this.#init = null; await this.init(); return this.publicState(); }
  async dispose() { if (this.#closed) return; this.#closed = true; const attempt = this.#attempt; attempt?.controller.abort(); await this.stop(); await attempt?.done.catch(() => {}); await Promise.allSettled([...this.#children].map(child => this.#kill(child))); await this.#writes.catch(() => {}); }
}
