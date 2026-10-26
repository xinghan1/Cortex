const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { aggregateSessionUsage, createSessionMetrics } = require('./session-metrics.cjs');
const { sessionTaskRuns, snapshotTurnUsage } = require('./turn-usage.cjs');
const { normalizeSessionTitle, sessionTitle } = require('./session-title.cjs');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const EFFORTS = {
  gemini: ['default', 'minimal', 'low', 'medium', 'high'],
  kimi: ['default', 'none', 'low', 'high', 'max'],
  glm: ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  openai: ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  deepseek: ['default', 'none', 'low', 'high', 'max'],
  doubao: ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  anthropic: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
  relay: ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  ollama: ['default', 'none', 'enabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
};
const AUTH_PROVIDERS = ['openai', 'deepseek', 'gemini', 'kimi', 'glm', 'anthropic', 'doubao'];
const AGENT_AUTH = { gemini: ['antigravity-agent'], kimi: ['kimi-agent'], glm: ['glm-agent'], anthropic: ['claude-agent'] };
const validEffort = (provider, authMode, effort) => EFFORTS[provider].includes(effort)
  || AGENT_AUTH[provider]?.includes(authMode) && typeof effort === 'string' && effort.length > 0 && effort.length <= 128
    && effort.trim() === effort && !/[\u0000-\u001f\u007f]/u.test(effort);
const API_PROTOCOLS = ['responses', 'chat-completions'];
const validTokens = value => Number.isSafeInteger(value) && value >= 0;
const isoDate = value => typeof value === 'string'
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && Number.isFinite(Date.parse(value));
const period = () => ({ inputTokens: 0, outputTokens: 0, totalTokens: 0, requests: 0, unreportedRequests: 0, partialRequests: 0 });

// Keep project history comparisons independent of the current working directory
// and filesystem availability, including Windows history read on another host.
function projectIdentity(workspace) {
  if (typeof workspace !== 'string' || !workspace || /[\u0000-\u001f\u007f]/.test(workspace)) return null;
  const windows = /^[a-z]:[\\/]/i.test(workspace) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/.test(workspace);
  if (windows) {
    if (/^[\\/]{2}[?.][\\/]/.test(workspace)) return null;
    const normalized = path.win32.normalize(workspace.replace(/\//g, '\\'));
    const trimmed = normalized.replace(/[\\/]+$/, '');
    const root = path.win32.parse(normalized).root.replace(/[\\/]+$/, '');
    return { key: `win:${trimmed.toLowerCase()}`, title: path.win32.basename(trimmed) || root || normalized };
  }
  if (process.platform !== 'win32' && path.posix.isAbsolute(workspace)) {
    const normalized = path.posix.normalize(workspace);
    const trimmed = normalized.replace(/\/+$/, '') || '/';
    return { key: `posix:${trimmed}`, title: path.posix.basename(trimmed) || '/' };
  }
  return null;
}

function hasImage(message) {
  return message?.role === 'user' && Array.isArray(message.attachments)
    && message.attachments.some(image => typeof image?.dataUrl === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/u.test(image.dataUrl));
}

function meaningfulSession(data) {
  let named = false;
  try { named = typeof data.customTitle === 'string' && Boolean(normalizeSessionTitle(data.customTitle)); } catch { /* Invalid optional names do not make an empty session meaningful. */ }
  return data.demo !== true && Array.isArray(data.messages) && (named || data.messages.some(message =>
    message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string'
      && (message.content.trim() || hasImage(message))));
}

function normalizeUsage(record) {
  if (!record || typeof record.id !== 'string' || !UUID.test(record.id)) throw new Error('用量记录 ID 必须是 UUID。');
  if (!isoDate(record.timestamp)) throw new Error('用量记录时间必须是有效 ISO 时间。');
  if (!Object.hasOwn(EFFORTS, record.provider)) throw new Error('用量记录供应商无效。');
  if (typeof record.model !== 'string' || record.model.length > 200) throw new Error('用量记录模型无效。');
  for (const field of ['sessionId', 'runId']) {
    if (typeof record[field] !== 'string' || !record[field] || record[field].length > 200) throw new Error(`用量记录 ${field} 无效。`);
  }
  if (!['completed', 'failed', 'stopped'].includes(record.status)) throw new Error('用量记录状态无效。');
  const reported = record.reported === true && validTokens(record.inputTokens) && validTokens(record.outputTokens);
  return {
    id: record.id.toLowerCase(), timestamp: new Date(record.timestamp).toISOString(),
    provider: record.provider, model: record.model, sessionId: record.sessionId, runId: record.runId,
    inputTokens: reported ? record.inputTokens : null,
    outputTokens: reported ? record.outputTokens : null,
    reported, partial: record.partial === true, status: record.status,
    ...(reported && validTokens(record.cachedInputTokens) && record.cachedInputTokens <= record.inputTokens
      ? { cachedInputTokens: record.cachedInputTokens } : {}),
    ...(['context-compaction', 'approval-review', 'prompt-completion', 'side-chat', 'pet-chat', 'pet-reaction'].includes(record.purpose) ? { purpose: record.purpose } : {}),
    ...(record.historicalApproximate === true ? { historicalApproximate: true } : {}),
  };
}

function legacyId(sessionId, group) {
  const hash = createHash('sha256').update(`forgedesk-legacy-usage-v1:${sessionId}:${group}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

const DEFAULTS = {
  provider: 'deepseek',
  providers: {
    openai: { model: '', modelsByAuth: { apiKey: '', chatgpt: '' }, baseUrl: 'https://api.openai.com/v1', reasoningEffort: 'default', authMode: 'apiKey', apiProtocol: 'responses' },
    deepseek: { model: '', baseUrl: 'https://api.deepseek.com', reasoningEffort: 'default', authMode: 'apiKey', modelsByAuth: { apiKey: '', 'deepseek-account': '' } },
    gemini: { model: '', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', reasoningEffort: 'default', authMode: 'apiKey', modelsByAuth: { apiKey: '', 'gemini-account': '', 'antigravity-agent': '' } },
    kimi: { model: '', baseUrl: 'https://api.moonshot.cn/v1', reasoningEffort: 'default', apiProtocol: 'responses', authMode: 'apiKey', modelsByAuth: { apiKey: '', 'kimi-agent': '' }, region: 'mainland-cn' },
    glm: { model: '', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', reasoningEffort: 'default', apiProtocol: 'chat-completions', authMode: 'apiKey', modelsByAuth: { apiKey: '', 'glm-agent': '' }, region: 'bigmodel' },
    anthropic: { model: '', baseUrl: 'https://api.anthropic.com/v1', reasoningEffort: 'default', authMode: 'apiKey', modelsByAuth: { apiKey: '', 'claude-agent': '' } },
    doubao: { model: '', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', reasoningEffort: 'default', apiProtocol: 'chat-completions', authMode: 'apiKey', modelsByAuth: { apiKey: '', 'ark-account': '' } },
    relay: { model: '', baseUrl: '', reasoningEffort: 'default', apiProtocol: 'chat-completions' },
    ollama: { model: '', baseUrl: 'http://localhost:11434', reasoningEffort: 'default', contextWindowTokens: 32768 },
  }
};

class Store {
  #sessionQueues = new Map();
  #deletedSessions = new Set();
  #queueSession(id, operation) {
    const previous = this.#sessionQueues.get(id) || Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    this.#sessionQueues.set(id, pending);
    pending.finally(() => { if (this.#sessionQueues.get(id) === pending) this.#sessionQueues.delete(id); }).catch(() => {});
    return pending;
  }
  constructor(dir, safeStorage) {
    this.dir = dir; this.crypto = safeStorage; this.settings = structuredClone(DEFAULTS);
    this.usage = null; this.usageError = null; this.usageQueue = Promise.resolve(); this.usageIds = new Set();
    this.sessionUsageCache = new WeakMap();
  }
  async init() {
    await fs.mkdir(path.join(this.dir, 'sessions'), { recursive: true });
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.dir, 'settings.json'), 'utf8'));
      if (Object.hasOwn(DEFAULTS.providers, saved.provider)) this.settings.provider = saved.provider;
      let migrated = false;
      for (const name of Object.keys(DEFAULTS.providers)) {
        Object.assign(this.settings.providers[name], saved.providers?.[name] || {});
        if (!validEffort(name, this.settings.providers[name].authMode, saved.providers?.[name]?.reasoningEffort)) {
          this.settings.providers[name].reasoningEffort = 'default'; migrated = true;
        }
        if (['openai', 'relay', 'kimi', 'glm', 'doubao'].includes(name) && (!API_PROTOCOLS.includes(saved.providers?.[name]?.apiProtocol)
            || ['glm', 'doubao'].includes(name) && saved.providers?.[name]?.apiProtocol !== 'chat-completions')) {
          this.settings.providers[name].apiProtocol = DEFAULTS.providers[name].apiProtocol; migrated = true;
        }
      }
      if (!Number.isSafeInteger(this.settings.providers.ollama.contextWindowTokens)
          || this.settings.providers.ollama.contextWindowTokens < 4096 || this.settings.providers.ollama.contextWindowTokens > 2097152) {
        this.settings.providers.ollama.contextWindowTokens = DEFAULTS.providers.ollama.contextWindowTokens; migrated = true;
      }
      if (!['apiKey', 'chatgpt'].includes(this.settings.providers.openai.authMode)) this.settings.providers.openai.authMode = 'apiKey';
      const openai = this.settings.providers.openai;
      openai.modelsByAuth = { apiKey: '', chatgpt: '', ...openai.modelsByAuth, [openai.authMode]: openai.model };
      const deepseek = this.settings.providers.deepseek;
      if (!['apiKey', 'deepseek-account'].includes(deepseek.authMode)) deepseek.authMode = 'apiKey';
      deepseek.modelsByAuth = { apiKey: '', 'deepseek-account': '', ...deepseek.modelsByAuth, [deepseek.authMode]: deepseek.model };
      const doubao = this.settings.providers.doubao;
      if (!['apiKey', 'ark-account'].includes(doubao.authMode)) { doubao.authMode = 'apiKey'; migrated = true; }
      doubao.modelsByAuth = { apiKey: '', 'ark-account': '', ...doubao.modelsByAuth, [doubao.authMode]: doubao.model };
      const anthropic = this.settings.providers.anthropic;
      if (!['apiKey', 'claude-agent'].includes(anthropic.authMode)) { anthropic.authMode = 'apiKey'; migrated = true; }
      if (!saved.providers?.anthropic?.modelsByAuth) migrated = true;
      anthropic.modelsByAuth = { apiKey: '', 'claude-agent': '', ...anthropic.modelsByAuth, [anthropic.authMode]: anthropic.model };
      const gemini = this.settings.providers.gemini;
      if (!['apiKey', 'gemini-account', 'antigravity-agent'].includes(gemini.authMode)) gemini.authMode = 'apiKey';
      gemini.modelsByAuth = { apiKey: '', 'gemini-account': '', 'antigravity-agent': '', ...gemini.modelsByAuth, [gemini.authMode]: gemini.model };
      for (const name of ['kimi', 'glm']) {
        const value = this.settings.providers[name], agentMode = `${name}-agent`;
        if (!['apiKey', agentMode].includes(value.authMode)) { value.authMode = 'apiKey'; migrated = true; }
        value.modelsByAuth = { apiKey: '', [agentMode]: '', ...value.modelsByAuth, [value.authMode]: value.model };
        const allowed = name === 'kimi' ? ['mainland-cn', 'global'] : ['bigmodel', 'zai'];
        if (!allowed.includes(value.region)) { value.region = DEFAULTS.providers[name].region; migrated = true; }
      }
      if (migrated) await this.write('settings.json', this.settings);
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('设置文件损坏，请备份 data/settings.json 后重试。'); }
    await this.initUsage();
  }
  publicSettings() {
    const providers = {};
    for (const [name, value] of Object.entries(this.settings.providers)) providers[name] = { model: value.model, baseUrl: value.baseUrl, reasoningEffort: value.reasoningEffort, authMode: AUTH_PROVIDERS.includes(name) ? value.authMode || 'apiKey' : 'apiKey', ...(AUTH_PROVIDERS.includes(name) ? { modelsByAuth: { ...value.modelsByAuth } } : {}), ...(['kimi', 'glm'].includes(name) ? { region: value.region } : {}), ...(['openai', 'relay', 'kimi', 'glm', 'doubao'].includes(name) ? { apiProtocol: value.apiProtocol } : {}), ...(name === 'ollama' ? { contextWindowTokens: value.contextWindowTokens } : {}), hasKey: Boolean(value.encryptedKey) };
    return { provider: this.settings.provider, ...providers[this.settings.provider], providers };
  }
  async saveSettings(input) {
    if (!input || !Object.hasOwn(DEFAULTS.providers, input.provider)) throw new Error('请选择有效的模型供应商。');
    if (input.apiProtocol !== undefined && (!API_PROTOCOLS.includes(input.apiProtocol)
        || ['glm', 'doubao'].includes(input.provider) && input.apiProtocol !== 'chat-completions'
        || (!['openai', 'relay', 'kimi', 'glm', 'doubao'].includes(input.provider) && input.apiProtocol !== 'responses'))) throw new Error('此服务商不支持所选的 API 协议。');
    const previous = this.settings.providers[input.provider];
    const authMode = AUTH_PROVIDERS.includes(input.provider) ? input.authMode ?? previous.authMode : 'apiKey';
    const model = String(input.model ?? (AUTH_PROVIDERS.includes(input.provider) ? previous.modelsByAuth?.[authMode] : previous.model) ?? '').trim();
    const baseUrl = String(input.baseUrl === undefined ? previous.baseUrl : input.baseUrl || DEFAULTS.providers[input.provider].baseUrl).trim();
    if (model.length > 200 || /[\r\n]/.test(model)) throw new Error('模型 ID 格式不正确。');
    let parsed;
    try { parsed = new URL(baseUrl); } catch { throw new Error('API 地址不是有效 URL。'); }
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
    const ollama = input.provider === 'ollama';
    if ((parsed.protocol !== 'https:' && !((local || ollama) && parsed.protocol === 'http:')) || !parsed.hostname || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error(ollama ? 'Ollama 地址必须使用 HTTP 或 HTTPS，且不能包含密码或查询参数。' : 'API 地址必须使用 HTTPS；本机服务可使用 HTTP，地址不能包含密码或查询参数。');
    if (ollama && (/[?#\u0000-\u001f\u007f]/.test(baseUrl) || /^[a-z][a-z\d+.-]*:\/\/[^/]*@/i.test(baseUrl))) throw new Error('Ollama 地址不能包含登录信息、查询参数或控制字符。');
    if (input.contextWindowTokens !== undefined && (!ollama || !Number.isSafeInteger(input.contextWindowTokens)
        || input.contextWindowTokens < 4096 || input.contextWindowTokens > 2097152)) throw new Error('Ollama 模型上下文必须是 4,096 至 2,097,152 之间的整数 Token。');
    const next = structuredClone(this.settings);
    const value = next.providers[input.provider];
    if (ollama && input.contextWindowTokens !== undefined) value.contextWindowTokens = input.contextWindowTokens;
    if (input.authMode !== undefined && !(input.authMode === 'apiKey'
        || input.provider === 'openai' && input.authMode === 'chatgpt'
        || input.provider === 'deepseek' && input.authMode === 'deepseek-account'
        || input.provider === 'gemini' && ['gemini-account', 'antigravity-agent'].includes(input.authMode)
        || input.provider === 'kimi' && input.authMode === 'kimi-agent'
        || input.provider === 'glm' && input.authMode === 'glm-agent'
        || input.provider === 'anthropic' && input.authMode === 'claude-agent'
        || input.provider === 'doubao' && input.authMode === 'ark-account')) throw new Error('此服务商不支持所选的登录方式。');
    if (input.region !== undefined && !(input.provider === 'kimi' && ['mainland-cn', 'global'].includes(input.region)
        || input.provider === 'glm' && ['bigmodel', 'zai'].includes(input.region))) throw new Error('此服务商不支持所选的账号区域。');
    if (['kimi', 'glm'].includes(input.provider) && input.region !== undefined) value.region = input.region;
    if (AUTH_PROVIDERS.includes(input.provider) && input.authMode !== undefined) value.authMode = input.authMode;
    if (['openai', 'relay', 'kimi', 'glm', 'doubao'].includes(input.provider) && input.apiProtocol !== undefined) value.apiProtocol = input.apiProtocol;
    const reasoningEffort = input.reasoningEffort === undefined
      ? validEffort(input.provider, value.authMode, value.reasoningEffort) ? value.reasoningEffort : 'default' : input.reasoningEffort;
    if (!validEffort(input.provider, value.authMode, reasoningEffort)) throw new Error('此供应商不支持所选的思考强度。');
    value.reasoningEffort = reasoningEffort;
    value.model = model; value.baseUrl = baseUrl;
    if (AUTH_PROVIDERS.includes(input.provider)) value.modelsByAuth[value.authMode] = model;
    if (input.clearKey === true) delete value.encryptedKey;
    const key = String(input.apiKey || '').trim();
    if (key) {
      if (key.length > 4096 || /[\r\n]/.test(key)) throw new Error('API Key 格式不正确。');
      if (!this.crypto.isEncryptionAvailable()) throw new Error('系统密钥加密暂不可用，未保存 API Key。');
      value.encryptedKey = this.crypto.encryptString(key).toString('base64');
    }
    next.provider = input.provider;
    await this.write('settings.json', next);
    this.settings = next;
    return this.publicSettings();
  }
  key(provider) {
    const encoded = this.settings.providers[provider]?.encryptedKey;
    if (!encoded) return '';
    try { return this.crypto.decryptString(Buffer.from(encoded, 'base64')); }
    catch { throw new Error('本机密钥无法解密，请在设置中重新填写 API Key。'); }
  }
  redact(value) {
    let text = String(value);
    for (const provider of Object.keys(DEFAULTS.providers)) {
      try { const key = this.key(provider); if (key) text = text.split(key).join('[已隐藏密钥]'); } catch { /* unavailable key must not affect logs */ }
    }
    return text;
  }
  async write(relative, data) {
    const destination = path.join(this.dir, relative);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(data, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
      // Windows readers and security scanners can briefly hold the existing
      // JSON file open. Retry only its atomic replacement, never delete the
      // destination or relax its permissions to make a save succeed.
      const retryDelays = process.platform === 'win32' ? [20, 40, 80, 160, 320] : [];
      let firstLockError;
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporary, destination); break; }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
          firstLockError ||= error;
          if (attempt >= retryDelays.length) throw firstLockError;
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        }
      }
    } finally {
      // Clean only the temporary file owned by this invocation. Cleanup must
      // not replace an original write/rename failure or touch the old JSON.
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
  async listSessions() {
    const names = await fs.readdir(path.join(this.dir, 'sessions'));
    const projects = new Map();
    for (const name of names.filter(x => /^[a-f0-9-]+\.json$/.test(x))) {
      try {
        const data = JSON.parse(await fs.readFile(path.join(this.dir, 'sessions', name), 'utf8'));
        if (data.id + '.json' !== name || typeof data.title !== 'string' || typeof data.updatedAt !== 'string') continue;
        if (!meaningfulSession(data)) continue;
        const project = projectIdentity(data.workspace);
        const updated = Date.parse(data.updatedAt);
        if (!project || !Number.isFinite(updated)) continue;
        const previous = projects.get(project.key);
        if (previous && (previous.updated > updated || (previous.updated === updated && previous.session.id.localeCompare(data.id) >= 0))) continue;
        projects.set(project.key, { updated, session: { id: data.id, title: project.title, updatedAt: data.updatedAt, workspace: data.workspace, demo: false } });
      } catch { /* a damaged session must not prevent opening the app */ }
    }
    return [...projects.values()].sort((a, b) => b.updated - a.updated || a.session.id.localeCompare(b.session.id)).slice(0, 100).map(project => project.session);
  }
  async listProjectSessions(workspace) {
    const selected = projectIdentity(workspace);
    if (!selected) return [];
    const names = await fs.readdir(path.join(this.dir, 'sessions'));
    const sessions = [];
    for (const name of names.filter(value => value.endsWith('.json') && UUID.test(value.slice(0, -5)))) {
      try {
        const data = JSON.parse(await fs.readFile(path.join(this.dir, 'sessions', name), 'utf8'));
        if (data?.id + '.json' !== name || typeof data.title !== 'string' || data.temporary === true
            || !meaningfulSession(data) || !isoDate(data.updatedAt)) continue;
        const project = projectIdentity(data.workspace);
        if (project?.key !== selected.key) continue;
        const firstPrompt = data.messages.find(message => message?.role === 'user' && typeof message.content === 'string' && message.content.trim());
        const summary = firstPrompt?.content || (data.messages.some(hasImage) ? '图片消息' : '历史会话');
        const preview = [...this.redact(summary).replace(/[\u0000-\u001f\u007f\s]+/gu, ' ').trim()].slice(0, 80).join('');
        sessions.push({
          id: data.id, title: this.sessionTitle(data), preview,
          createdAt: isoDate(data.createdAt) ? new Date(data.createdAt).toISOString() : null,
          updatedAt: new Date(data.updatedAt).toISOString(),
        });
      } catch { /* A damaged or disappearing history file must not block the menu. */ }
    }
    return sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id)).slice(0, 100);
  }
  async getSession(id) {
    if (!/^[a-f0-9-]{36}$/.test(String(id))) throw new Error('会话 ID 无效。');
    if (this.#deletedSessions.has(id)) throw Object.assign(new Error('会话记录已删除。'), { code: 'ENOENT' });
    const data = JSON.parse(await fs.readFile(path.join(this.dir, 'sessions', `${id}.json`), 'utf8'));
    if (this.#deletedSessions.has(id)) throw Object.assign(new Error('会话记录已删除。'), { code: 'ENOENT' });
    if (data.id !== id || typeof data.title !== 'string' || !Array.isArray(data.messages) || !Array.isArray(data.events) || (data.workspace !== null && typeof data.workspace !== 'string')) throw new Error('会话文件格式损坏，未加载。');
    for (const message of data.messages) {
      if (!message || !['user', 'assistant', 'tool'].includes(message.role) || typeof message.content !== 'string') throw new Error('会话消息格式损坏，未加载。');
    }
    return data;
  }
  createSession(workspace = null) { const now = new Date().toISOString(); return { id: randomUUID(), title: '新会话', createdAt: now, updatedAt: now, workspace, messages: [], events: [] }; }
  sessionTitle(session) { return sessionTitle(session, value => this.redact(value)); }
  async renameSession(session, title) {
    if (!session || !UUID.test(session.id)) throw new Error('会话 ID 无效，未保存。');
    const customTitle = normalizeSessionTitle(title);
    let latest = session;
    if (session.temporary !== true) {
      try { latest = await this.getSession(session.id); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const identity = value => projectIdentity(value)?.key ?? value;
      if (identity(latest.workspace) !== identity(session.workspace)) throw new Error('会话所属项目已变化，标题未保存。');
    }
    // History can be open in another window while its original keeps growing.
    // A name edit must never replace those newer messages with this snapshot.
    const next = { ...latest, customTitle };
    next.title = this.sessionTitle(next);
    if (session.temporary !== true) await this.saveSession(next);
    else next.updatedAt = new Date().toISOString();
    session.customTitle = next.customTitle;
    session.title = next.title;
    session.updatedAt = next.updatedAt;
    return { id: session.id, title: next.title };
  }
  async saveSession(session) {
    if (!/^[a-f0-9-]{36}$/.test(String(session?.id))) throw new Error('会话 ID 无效，未保存。');
    if (session.temporary === true) return;
    session.title = this.sessionTitle(session);
    session.updatedAt = new Date().toISOString();
    // Capture at invocation, before waiting behind another write. A queued save
    // must never follow a caller's later session mutations or ID reassignment.
    const snapshot = JSON.parse(this.redact(JSON.stringify(session)));
    return this.#queueSession(snapshot.id, async () => {
      if (this.#deletedSessions.has(snapshot.id)) throw new Error('会话记录已删除，不能重新保存。');
      await this.write(path.join('sessions', `${snapshot.id}.json`), snapshot);
    });
  }
  async flushSessions() {
    for (;;) {
      const writes = [...this.#sessionQueues.values()];
      if (!writes.length) return;
      await Promise.all(writes);
    }
  }
  async validateSessionDeletion(id, workspace, { temporary = false } = {}) {
    if (!UUID.test(id)) throw new Error('会话 ID 无效，未删除。');
    if (!temporary) {
      const stored = await this.getSession(id);
      const identity = value => projectIdentity(value)?.key ?? value;
      if (identity(stored.workspace) !== identity(workspace)) throw new Error('只能删除当前项目的会话。');
    }
    const directory = path.join(this.dir, 'sessions'), filename = path.join(directory, `${id}.json`);
    const parent = await fs.lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('会话存储目录无效，未删除。');
    const stat = await fs.lstat(filename).catch(error => { if (error.code === 'ENOENT' && temporary) return null; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error('会话记录路径无效，未删除。');
    return { filename, exists: Boolean(stat) };
  }
  async deleteSession(id, workspace, { temporary = false } = {}) {
    await this.validateSessionDeletion(id, workspace, { temporary });
    this.#deletedSessions.add(id);
    try {
      return await this.#queueSession(id, async () => {
        const directory = path.join(this.dir, 'sessions'), filename = path.join(directory, `${id}.json`);
        const parent = await fs.lstat(directory);
        if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('会话存储目录无效，未删除。');
        const stat = await fs.lstat(filename).catch(error => { if (error.code === 'ENOENT' && temporary) return null; throw error; });
        if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error('会话记录路径无效，未删除。');
        if (stat) await fs.unlink(filename);
        return { id, deleted: true };
      });
    } catch (error) { this.#deletedSessions.delete(id); throw error; }
  }

  async initUsage() {
    let ledger;
    try {
      ledger = JSON.parse(await fs.readFile(path.join(this.dir, 'usage.json'), 'utf8'));
      if (ledger?.version !== 1 || !isoDate(ledger.since) || !Array.isArray(ledger.records)) throw new Error('账本结构无效');
      ledger.since = new Date(ledger.since).toISOString();
      const ids = new Set();
      ledger.records = ledger.records.map(record => {
        if (typeof record.reported !== 'boolean' || (record.partial !== undefined && typeof record.partial !== 'boolean')
            || (record.reported ? !validTokens(record.inputTokens) || !validTokens(record.outputTokens) : record.inputTokens !== null || record.outputTokens !== null)) {
          throw new Error('账本用量字段无效');
        }
        const clean = normalizeUsage(record);
        if (ids.has(clean.id)) throw new Error('账本含重复记录');
        ids.add(clean.id); return clean;
      });
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.usageError = '本机用量账本损坏或无法读取，请备份 data/usage.json 后修复；原文件未被覆盖。';
        return;
      }
      ledger = { version: 1, since: new Date().toISOString(), records: [] };
    }
    try {
      if (ledger.legacyMigration?.version !== 1) {
        await this.migrateLegacyUsage(ledger);
        await this.write('usage.json', ledger);
      }
      this.usage = ledger;
      this.usageIds = new Set(ledger.records.map(record => record.id));
    } catch {
      this.usageError = '本机用量账本初始化或历史迁移失败，未重置已有记录，请检查数据目录。';
    }
  }

  async migrateLegacyUsage(ledger) {
    const names = (await fs.readdir(path.join(this.dir, 'sessions'))).filter(name => UUID.test(name.replace(/\.json$/, '')) && name.endsWith('.json')).sort();
    const ids = new Set(ledger.records.map(record => record.id));
    const ledgerSessionIds = new Set(ledger.records.map(record => record.sessionId));
    let imported = 0, skippedSessions = 0;
    for (const name of names) {
      let session;
      try {
        session = JSON.parse(await fs.readFile(path.join(this.dir, 'sessions', name), 'utf8'));
        if (session.demo === true) continue;
        if (session.usageLedgerVersion === 1 || ledgerSessionIds.has(session.id)) continue;
        if (`${session.id}.json` !== name || !Array.isArray(session.events) || !isoDate(session.updatedAt)) throw new Error('历史会话无效');
      } catch { skippedSessions += 1; continue; }
      const provider = Object.hasOwn(EFFORTS, session.provider) ? session.provider : this.settings.provider;
      const model = typeof session.model === 'string' ? session.model : this.settings.providers[provider].model || '历史模型未记录';
      let group = null, ordinal = 0;
      const flush = () => {
        if (!group?.sawUsage) { group = null; return; }
        const id = legacyId(session.id, group.key);
        if (!ids.has(id)) {
          const known = validTokens(group.inputTokens) && validTokens(group.outputTokens) && (group.inputTokens > 0 || group.outputTokens > 0);
          const record = normalizeUsage({
            id, timestamp: session.updatedAt, provider, model, sessionId: session.id, runId: group.runId,
            reported: known, inputTokens: group.inputTokens, outputTokens: group.outputTokens,
            status: group.status, partial: group.status !== 'completed', historicalApproximate: true,
          });
          ledger.records.push(record); ids.add(id); imported += 1;
          if (record.timestamp < ledger.since) ledger.since = record.timestamp;
        }
        group = null;
      };
      const begin = event => {
        const runId = typeof event?.runId === 'string' && event.runId ? event.runId : `legacy-run-${ordinal}`;
        group = { key: `${ordinal++}:${runId}`, runId, inputTokens: null, outputTokens: null, sawUsage: false, status: 'completed' };
      };
      for (const event of session.events) {
        if (!event || typeof event !== 'object') continue;
        if (event.type === 'run-start') { flush(); begin(event); }
        else if (event.type === 'usage') {
          if (!group) begin();
          group.sawUsage = true;
          if (validTokens(event.inputTokens)) group.inputTokens = Math.max(group.inputTokens ?? 0, event.inputTokens);
          if (validTokens(event.outputTokens)) group.outputTokens = Math.max(group.outputTokens ?? 0, event.outputTokens);
        } else if (event.type === 'run-end') {
          if (group && ['completed', 'failed', 'stopped'].includes(event.status)) group.status = event.status;
          flush();
        }
      }
      flush();
    }
    ledger.legacyMigration = { version: 1, completedAt: new Date().toISOString(), imported, skippedSessions };
  }

  async recordUsage(record) {
    const clean = normalizeUsage(record);
    const operation = this.usageQueue.then(async () => {
      if (this.usageError || !this.usage) throw new Error(this.usageError || '本机用量账本尚未初始化。');
      if (this.usageIds.has(clean.id)) return { recorded: false, duplicate: true };
      const next = { ...this.usage, since: clean.timestamp < this.usage.since ? clean.timestamp : this.usage.since, records: [...this.usage.records, clean] };
      await this.write('usage.json', next);
      this.usage = next; this.usageIds.add(clean.id);
      return { recorded: true, duplicate: false };
    });
    this.usageQueue = operation.catch(() => {});
    return operation;
  }

  sessionUsageTotals(session) {
    if (!session) return aggregateSessionUsage([]);
    let cached = this.sessionUsageCache.get(session);
    if (!cached || cached.ledger !== this.usage || cached.baseline !== session.usageBaseline || cached.sessionId !== session.id) {
      cached = { ledger: this.usage, baseline: session.usageBaseline, sessionId: session.id,
        value: aggregateSessionUsage((this.usage?.records || []).filter(record => record.sessionId === session.id), session.usageBaseline) };
      this.sessionUsageCache.set(session, cached);
    }
    return structuredClone(cached.value);
  }
  sessionMetrics(session, expectedContext) {
    return createSessionMetrics(session, this.sessionUsageTotals(session), { unavailable: Boolean(this.usageError), expectedContext });
  }
  sessionTaskRuns(session) {
    return sessionTaskRuns(session, this.usage?.records || [], { unavailable: Boolean(this.usageError) });
  }
  snapshotTurnUsage(session) {
    return snapshotTurnUsage(session, this.usage?.records || [], { unavailable: Boolean(this.usageError) });
  }

  usageStats(now = new Date()) {
    const date = new Date(now);
    if (!Number.isFinite(date.getTime())) throw new Error('用量统计时间无效。');
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong', year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
    const midnight = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
    const dayStart = midnight - 8 * 3600000;
    const weekStart = dayStart - ((new Date(midnight).getUTCDay() + 6) % 7) * 86400000;
    const monthStart = Date.UTC(Number(parts.year), Number(parts.month) - 1, 1) - 8 * 3600000;
    const result = {
      timeZone: 'Asia/Hong_Kong', generatedAt: date.toISOString(), since: this.usage?.since ?? null,
      historicalApproximate: Boolean(this.usage?.records.some(record => record.historicalApproximate)),
      day: period(), week: period(), month: period(),
      ...(this.usageError ? { error: this.usageError } : {}),
      ...(this.usage?.legacyMigration?.skippedSessions ? { warning: '部分旧会话损坏或缺少日期，未计入历史用量。' } : {}),
    };
    for (const record of this.usage?.records || []) {
      const timestamp = Date.parse(record.timestamp);
      if (timestamp > date.getTime()) continue;
      for (const [name, start] of [['day', dayStart], ['week', weekStart], ['month', monthStart]]) {
        if (timestamp < start) continue;
        const target = result[name];
        target.requests += 1;
        if (record.reported) { target.inputTokens += record.inputTokens; target.outputTokens += record.outputTokens; }
        if (!record.reported || record.partial) target.unreportedRequests += 1;
        if (record.partial) target.partialRequests += 1;
        target.totalTokens = target.inputTokens + target.outputTokens;
      }
    }
    return result;
  }
}
module.exports = { Store };
