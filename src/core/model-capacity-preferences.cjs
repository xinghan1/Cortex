const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const MIN_MODEL_CAPACITY = 1000, MAX_MODEL_CAPACITY = 16000000;
const MAX_RECORDS = 2048, MAX_BYTES = 512 * 1024;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validConnection = value => typeof value === 'string' && /^[a-f\d]{64}$/u.test(value);
const validModel = value => typeof value === 'string' && value.trim() === value && value.length > 0
  && value.length <= 200 && !/[\p{Cc}\p{Cf}]/u.test(value);
const validCapacity = value => Number.isSafeInteger(value) && value >= MIN_MODEL_CAPACITY && value <= MAX_MODEL_CAPACITY;
const validLimit = value => Number.isSafeInteger(value) && value > 0;
const CAPACITY_ORIGINS = new Set(['provider', 'account', 'official-default', 'ollama']);
const CAPACITY_LABELS = { manual: '手动设置', provider: '服务商返回', account: '账号接口返回',
  'official-default': '官方型号默认', ollama: 'Ollama 运行配置', unknown: '未知' };
const failure = (code, message) => Object.assign(new Error(message), { code });

/** Stable across restarts and model/window/connection-status changes. Secrets
 * and account identifiers never leave the digest or enter the preference file. */
function modelCapacityConnectionKey(context, apiKey = '') {
  const provider = context?.provider, authMode = context?.authMode;
  if (!['openai', 'deepseek', 'anthropic', 'relay', 'ollama'].includes(provider)
      || !['apiKey', 'chatgpt', 'deepseek-account'].includes(authMode))
    throw failure('MODEL_CAPACITY_INVALID_CONNECTION', '模型容量连接无效。');
  let connection;
  if (authMode === 'chatgpt' || authMode === 'deepseek-account') {
    const profileId = context.account?.session?.profileId;
    if (provider !== (authMode === 'chatgpt' ? 'openai' : 'deepseek') || typeof profileId !== 'string'
        || !profileId || profileId.length > 1000 || /[\p{Cc}\p{Cf}]/u.test(profileId))
      throw failure('MODEL_CAPACITY_INVALID_CONNECTION', '请先连接模型账号，再设置模型容量。');
    connection = [provider, authMode, profileId];
  } else {
    if (typeof apiKey !== 'string' || apiKey.length > 8192 || /[\x00-\x1f\x7f]/u.test(apiKey)
        || provider !== 'ollama' && !apiKey)
      throw failure('MODEL_CAPACITY_INVALID_CONNECTION', '请先保存模型连接，再设置模型容量。');
    let endpoint;
    try { endpoint = new URL(context.config?.baseUrl); } catch { throw failure('MODEL_CAPACITY_INVALID_CONNECTION', '模型容量连接地址无效。'); }
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
      throw failure('MODEL_CAPACITY_INVALID_CONNECTION', '模型容量连接地址无效。');
    endpoint.pathname = endpoint.pathname.replace(/\/+$/u, '') || '/';
    const protocol = provider === 'openai' || provider === 'relay' ? context.config?.apiProtocol || (provider === 'relay' ? 'chat-completions' : 'responses')
      : provider === 'deepseek' ? 'chat-completions' : provider === 'anthropic' ? 'messages' : 'ollama';
    if (!['responses', 'chat-completions', 'messages', 'ollama'].includes(protocol))
      throw failure('MODEL_CAPACITY_INVALID_CONNECTION', '模型容量连接协议无效。');
    connection = [provider, authMode, endpoint.href, protocol, apiKey];
  }
  return digest(['synora-model-capacity-connection-v1', ...connection]);
}

function modelCapacityScope(connection, model) {
  if (!validConnection(connection)) throw failure('MODEL_CAPACITY_INVALID_CONNECTION', '模型容量连接无效。');
  if (!validModel(model)) throw failure('MODEL_CAPACITY_INVALID_MODEL', '请先选择有效模型，再设置模型容量。');
  return digest(['synora-model-capacity-scope-v1', connection, model]);
}

/** Apply after directory capability derivation, leaving the advertised snapshot
 * intact. Unknown manually supplied capacities are total context windows. */
function applyModelCapacity({ capabilities = {}, manualTokens = null } = {}) {
  if (!object(capabilities)) throw failure('MODEL_CAPACITY_INVALID_CONFIG', '模型容量配置无效。');
  if (manualTokens !== null && !validCapacity(manualTokens))
    throw failure('MODEL_CAPACITY_INVALID_VALUE', `模型容量必须为 ${MIN_MODEL_CAPACITY} 至 ${MAX_MODEL_CAPACITY} 之间的整数 Token。`);
  const advertisedTokens = validLimit(capabilities.contextWindow) ? capabilities.contextWindow : null;
  const capacityTokens = manualTokens === null ? advertisedTokens : advertisedTokens === null ? manualTokens : Math.min(manualTokens, advertisedTokens);
  const source = manualTokens !== null ? 'manual' : advertisedTokens !== null ? 'catalog' : 'unknown';
  const limitKind = advertisedTokens !== null && capabilities.contextWindowKind === 'input' ? 'input' : 'total';
  const advertisedOrigin = advertisedTokens === null ? 'unknown'
    : CAPACITY_ORIGINS.has(capabilities.contextWindowOrigin) ? capabilities.contextWindowOrigin : 'provider';
  const capacityOrigin = source === 'manual' ? 'manual' : advertisedOrigin;
  const kind = limitKind === 'input' ? '输入上限' : '上下文容量';
  const sourceDescription = {
    manual: `手动设置的${kind}，仅适用于当前连接和型号；服务商实际限制仍然适用。`,
    provider: `服务商接口返回的${kind}。`,
    account: `账号接口返回的${kind}，可能与官方型号公布的上下文容量不同。`,
    'official-default': '接口未提供容量，采用官方型号公开的上下文容量；不代表当前账号一定可用。',
    ollama: '当前 Ollama 请求使用的上下文配置，受模型训练容量约束。',
    unknown: '当前模型未提供容量，可在下方填写。',
  }[capacityOrigin];
  const result = { ...capabilities,
    // The agent's temporary-capability cache must not resurrect a manual value
    // after reset, while an automatic catalog outage may reuse a known limit.
    contextWindowPreferenceKey: manualTokens === null ? 'automatic' : `manual:${manualTokens}` };
  if (advertisedTokens === null) delete result.contextWindowOrigin;
  else result.contextWindowOrigin = advertisedOrigin;
  if (capacityTokens === null) { delete result.contextWindow; delete result.contextWindowKind; }
  else { result.contextWindow = capacityTokens; result.contextWindowKind = limitKind; }
  return { capabilities: result, modelCapacity: { capacityTokens, advertisedTokens, manualTokens, source, limitKind,
    capacityOrigin, advertisedOrigin, sourceLabel: CAPACITY_LABELS[capacityOrigin], sourceDescription,
    compressionTriggerTokens: capacityTokens === null ? 45000 : Math.max(1, Math.floor(capacityTokens * 0.8)),
    manualClamped: manualTokens !== null && advertisedTokens !== null && manualTokens > advertisedTokens } };
}

function decode(value) {
  if (!object(value) || value.version !== 1 || Object.keys(value).length !== 2 || !Array.isArray(value.capacities)
      || value.capacities.length > MAX_RECORDS) throw Error('Invalid capacity preferences');
  const records = new Map();
  for (const row of value.capacities) {
    if (!Array.isArray(row) || row.length !== 2 || !validConnection(row[0]) || !validCapacity(row[1]) || records.has(row[0]))
      throw Error('Invalid capacity preference');
    records.set(row[0], row[1]);
  }
  return records;
}

class ModelCapacityPreferences {
  #dir; #file; #records = new Map(); #initializing; #queue = Promise.resolve();
  constructor(dataDir) {
    if (typeof dataDir !== 'string' || !dataDir.trim() || /[\x00-\x1f\x7f]/u.test(dataDir))
      throw failure('MODEL_CAPACITY_INVALID_CONFIG', '模型容量存储配置无效。');
    this.#dir = path.resolve(dataDir); this.#file = path.join(this.#dir, 'model-capacities.json');
  }
  init() {
    return this.#initializing ??= (async () => {
      try {
        const stat = await fs.lstat(this.#file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw Error('Invalid capacity file');
        const encoded = await fs.readFile(this.#file, 'utf8');
        if (Buffer.byteLength(encoded) > MAX_BYTES) throw Error('Capacity file too large');
        this.#records = decode(JSON.parse(encoded));
      } catch { /* Starting never overwrites missing, damaged or unreadable preferences. */ }
      return this;
    })();
  }
  get(connection, model) { return this.#records.get(modelCapacityScope(connection, model)) ?? null; }
  async set(connection, model, capacityTokens, { advertisedTokens = null } = {}) {
    const scope = modelCapacityScope(connection, model);
    if (capacityTokens !== null && !validCapacity(capacityTokens))
      throw failure('MODEL_CAPACITY_INVALID_VALUE', `模型容量必须为 ${MIN_MODEL_CAPACITY} 至 ${MAX_MODEL_CAPACITY} 之间的整数 Token。`);
    if (advertisedTokens !== null && !validLimit(advertisedTokens)) throw failure('MODEL_CAPACITY_INVALID_CONFIG', '模型容量上限无效。');
    if (capacityTokens !== null && advertisedTokens !== null && capacityTokens > advertisedTokens)
      throw failure('MODEL_CAPACITY_ABOVE_LIMIT', '手动容量不能超过自动识别的容量上限。');
    const operation = this.#queue.then(async () => {
      await this.init();
      const next = new Map(this.#records); next.delete(scope);
      if (capacityTokens !== null) next.set(scope, capacityTokens);
      while (next.size > MAX_RECORDS) next.delete(next.keys().next().value);
      const temporary = path.join(this.#dir, `.model-capacities-${randomUUID()}.tmp`);
      try {
        const encoded = JSON.stringify({ version: 1, capacities: [...next] }) + '\n';
        if (Buffer.byteLength(encoded) > MAX_BYTES) throw Error('Capacity preferences too large');
        await fs.mkdir(this.#dir, { recursive: true });
        const destination = await fs.lstat(this.#file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (destination && (!destination.isFile() || destination.isSymbolicLink())) throw Error('Invalid capacity destination');
        await fs.writeFile(temporary, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, this.#file); this.#records = next; return capacityTokens;
      } catch { throw failure('MODEL_CAPACITY_SAVE_FAILED', '模型容量保存失败，请稍后重试。'); }
      finally { await fs.unlink(temporary).catch(() => {}); }
    });
    this.#queue = operation.catch(() => {}); return operation;
  }
  reset(connection, model) { return this.set(connection, model, null); }
  async settled() { await this.init(); for (;;) { const queued = this.#queue; await queued; if (queued === this.#queue) return; } }
}

module.exports = { ModelCapacityPreferences, modelCapacityConnectionKey, modelCapacityScope, applyModelCapacity,
  MIN_MODEL_CAPACITY, MAX_MODEL_CAPACITY };
