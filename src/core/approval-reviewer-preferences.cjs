const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { permissionProjectKey } = require('./permission-preferences.cjs');

const MAX_SELECTIONS = 512, MAX_BYTES = 4 * 1024 * 1024;
const validConnection = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const validModel = value => value === null || typeof value === 'string' && value.trim() === value
  && value.length > 0 && value.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(value);
const preferenceError = (message, code) => Object.assign(new Error(message), { code });
const identity = (root, connection) => JSON.stringify([permissionProjectKey(root), connection]);

// Only this digest is persisted. Connection state, tokens, encrypted-key bytes,
// model selections and context-window sizes must not invalidate a saved choice.
function approvalReviewerConnectionKey(context, apiKey = '') {
  if (!context || !['openai', 'deepseek', 'gemini', 'anthropic', 'relay', 'ollama'].includes(context.provider)
      || !['apiKey', 'chatgpt', 'deepseek-account', 'gemini-account'].includes(context.authMode)) throw new Error('审批模型连接无效。');
  let parts;
  if (['chatgpt', 'deepseek-account', 'gemini-account'].includes(context.authMode)) {
    if (context.provider !== (context.authMode === 'chatgpt' ? 'openai' : context.authMode === 'gemini-account' ? 'gemini' : 'deepseek')) throw new Error('审批模型连接无效。');
    const profileId = context.account?.session?.profileId || null;
    if (profileId !== null && (typeof profileId !== 'string' || profileId.length > 1000)) throw new Error('审批模型账号无效。');
    parts = [context.provider, context.authMode, profileId];
  } else {
    if (typeof apiKey !== 'string') throw new Error('审批模型连接无效。');
    const endpoint = new URL(context.config?.baseUrl);
    endpoint.hash = '';
    endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '') || '/';
    parts = [context.provider, context.authMode, endpoint.href, context.config?.apiProtocol || 'responses', apiKey];
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function decode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
      || Object.keys(value).length !== 2 || !Array.isArray(value.selections) || value.selections.length > MAX_SELECTIONS) throw new Error('Invalid reviewer preferences');
  const selections = new Map();
  for (const item of value.selections) {
    if (!Array.isArray(item) || item.length !== 3 || !validConnection(item[1]) || !validModel(item[2])
        || permissionProjectKey(item[0]) !== item[0]) throw new Error('Invalid reviewer selection');
    const key = identity(item[0], item[1]);
    if (selections.has(key)) throw new Error('Duplicate reviewer selection');
    selections.set(key, item);
  }
  return selections;
}

class ApprovalReviewerPreferences {
  #dir; #file; #selections = new Map(); #initializing; #queue = Promise.resolve();
  constructor(dataDir) {
    if (typeof dataDir !== 'string' || !dataDir.trim() || /[\u0000-\u001f\u007f]/u.test(dataDir))
      throw preferenceError('审批模型首选项存储配置无效。', 'APPROVAL_REVIEWER_INVALID_CONFIG');
    this.#dir = path.resolve(dataDir); this.#file = path.join(this.#dir, 'approval-reviewer-preferences.json');
  }
  get(root, connection) {
    if (!validConnection(connection)) throw preferenceError('审批模型连接无效。', 'APPROVAL_REVIEWER_INVALID_CONNECTION');
    return this.#selections.get(identity(root, connection))?.[2] ?? null;
  }
  init() {
    return this.#initializing ??= (async () => {
      try {
        const stat = await fs.lstat(this.#file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid reviewer file');
        this.#selections = decode(JSON.parse(await fs.readFile(this.#file, 'utf8')));
      } catch { /* Loading never overwrites missing, damaged or unreadable preferences. */ }
      return this;
    })();
  }
  async set(root, connection, model) {
    const normalized = permissionProjectKey(root), key = identity(normalized, connection);
    if (!validConnection(connection)) throw preferenceError('审批模型连接无效。', 'APPROVAL_REVIEWER_INVALID_CONNECTION');
    if (!validModel(model)) throw preferenceError('审批模型无效。', 'APPROVAL_REVIEWER_INVALID_MODEL');
    const operation = this.#queue.then(async () => {
      await this.init();
      const next = new Map(this.#selections);
      next.delete(key); next.set(key, [normalized, connection, model]);
      while (next.size > MAX_SELECTIONS) next.delete(next.keys().next().value);
      const temporary = path.join(this.#dir, `.approval-reviewer-${randomUUID()}.tmp`);
      try {
        const encoded = JSON.stringify({ version: 1, selections: [...next.values()] }) + '\n';
        if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error('Preferences too large');
        await fs.mkdir(this.#dir, { recursive: true });
        const destination = await fs.lstat(this.#file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (destination && (!destination.isFile() || destination.isSymbolicLink())) throw new Error('Invalid reviewer destination');
        await fs.writeFile(temporary, encoded, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, this.#file);
        this.#selections = next;
        return model;
      } catch { throw preferenceError('审批模型保存失败，请稍后重试。', 'APPROVAL_REVIEWER_SAVE_FAILED'); }
      finally { await fs.unlink(temporary).catch(() => {}); }
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
  async settled() {
    await this.init();
    for (;;) { const queued = this.#queue; await queued; if (queued === this.#queue) return; }
  }
}

module.exports = { ApprovalReviewerPreferences, approvalReviewerConnectionKey };
