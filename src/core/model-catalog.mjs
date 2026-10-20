import { createHash } from 'node:crypto';

// Discovery schemas verified 2026-10-19. A catalog entry is not an inference entitlement.
// https://developers.openai.com/api/reference/resources/models/methods/list
// https://api-docs.deepseek.com/api/list-models/
// https://platform.claude.com/docs/en/api/models/list
const DEFAULTS = { openai: 'https://api.openai.com/v1', deepseek: 'https://api.deepseek.com', anthropic: 'https://api.anthropic.com/v1', relay: '' };
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

class CatalogError extends Error {
  constructor(code, message, status) {
    super(message); this.name = 'ModelCatalogError'; this.code = code;
    if (status !== undefined) this.status = status;
  }
}
const failure = (code, message, status) => new CatalogError(code, message, status);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cancelled = () => Object.assign(failure('CATALOG_CANCELLED', '模型目录请求已取消。'), { name: 'AbortError' });
const clone = value => structuredClone(value);
function levels(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && EFFORTS.includes(item))
    ? [...new Set(value)] : undefined;
}

const EFFORT_LIST_FIELDS = ['reasoningEfforts', 'reasoning_efforts', 'supportedReasoningEfforts',
  'supported_reasoning_efforts', 'supportedReasoningLevels', 'supported_reasoning_levels'];
const NESTED_EFFORT_LIST_FIELDS = [...EFFORT_LIST_FIELDS, 'supportedLevels', 'supported_levels', 'levels', 'efforts'];
const DEFAULT_EFFORT_FIELDS = ['defaultReasoningEffort', 'default_reasoning_effort', 'defaultLevel',
  'default_level', 'defaultEffort', 'default_effort'];
function declaredLevels(sources, fields) {
  for (const source of sources) {
    if (!object(source)) continue;
    for (const field of fields) {
      const supported = levels(source[field]);
      if (supported !== undefined) return supported;
    }
  }
}

function reasoningMetadata(provider, metadata) {
  const capabilities = object(metadata.capabilities) ? metadata.capabilities : {};
  const reasoning = [metadata.reasoning, capabilities.reasoning];
  const effort = [metadata.effort, capabilities.effort];
  const sources = [metadata, capabilities, ...reasoning, ...effort].filter(object);
  // An explicit denial takes precedence over contradictory positive metadata.
  // A boolean `true` without a list does not prove any selectable effort level.
  const denied = [metadata, capabilities].some(source => source.supportsReasoning === false || source.supports_reasoning === false)
    || [...reasoning, ...effort].some(source => source === false || (object(source) && source.supported === false));
  let supported = denied ? [] : declaredLevels([metadata, capabilities], EFFORT_LIST_FIELDS);
  if (supported === undefined) supported = declaredLevels(reasoning, NESTED_EFFORT_LIST_FIELDS);
  if (supported === undefined && provider === 'deepseek' && object(metadata.effort)) {
    const thinking = declaredLevels([metadata.effort], NESTED_EFFORT_LIST_FIELDS);
    // DeepSeek disables thinking separately; only that provider adds `none`.
    if (thinking !== undefined) supported = ['none', ...thinking.filter(level => level !== 'none')];
  }
  if (supported === undefined) supported = declaredLevels(effort, NESTED_EFFORT_LIST_FIELDS);
  if (supported === undefined) {
    for (const source of [...reasoning, ...effort].filter(object)) {
      if (EFFORTS.some(level => object(source[level]) && typeof source[level].supported === 'boolean')) {
        supported = EFFORTS.filter(level => source[level]?.supported === true);
        break;
      }
    }
  }
  const defaultLevel = sources.flatMap(source => DEFAULT_EFFORT_FIELDS.map(field => source[field]))
    .find(value => supported === undefined ? EFFORTS.includes(value) : supported.includes(value));
  return { supported, defaultLevel };
}

/**
 * Explicit metadata wins. officialSource is a trusted caller flag, never inferred
 * from a model name: proxies may reuse an official ID for a different model.
 */
export function deriveModelCapabilities(provider, id, metadata = {}) {
  if (!object(metadata)) metadata = {};
  const result = {};
  const capacities = [metadata, metadata.capabilities].filter(object);
  for (const source of capacities) {
    const total = source.contextWindow ?? source.context_window ?? source.context_length;
    const input = source.max_input_tokens;
    const capacity = total ?? input;
    if (Number.isSafeInteger(capacity) && capacity > 0) {
      result.contextWindow = capacity;
      result.contextWindowKind = total !== undefined ? source.contextWindowKind === 'input' ? 'input' : 'total' : 'input';
      break;
    }
  }
  let { supported, defaultLevel } = reasoningMetadata(provider, metadata);
  if (typeof metadata.supportsTools === 'boolean') result.supportsTools = metadata.supportsTools;
  if (typeof metadata.supportsImages === 'boolean') result.supportsImages = metadata.supportsImages;
  else if (Array.isArray(metadata.input_modalities) && metadata.input_modalities.length
      && metadata.input_modalities.every(item => typeof item === 'string' && item.trim())) {
    result.supportsImages = metadata.input_modalities.includes('image');
  }
  if (typeof metadata.compatible === 'boolean') result.compatible = metadata.compatible;
  if (typeof metadata.textCompatible === 'boolean') result.textCompatible = metadata.textCompatible;
  if (typeof metadata.compatibilityReason === 'string' && metadata.compatibilityReason.length <= 500) result.compatibilityReason = metadata.compatibilityReason;

  if (metadata.officialSource === true) {
    // Exact published IDs only; no guessed capabilities for future model families.
    // https://developers.openai.com/api/docs/models/gpt-6.1-sol
    // https://developers.openai.com/api/docs/models/gpt-6-astra
    if (provider === 'openai' && ['gpt-6.1-sol', 'gpt-6-astra'].includes(id)) {
      if (supported === undefined) supported = ['low', 'medium', 'high', 'xhigh', 'max'];
      if (id === 'gpt-6.1-sol' && defaultLevel === undefined) defaultLevel = 'medium';
      if (result.supportsTools === undefined) result.supportsTools = true;
    }
    // Specialized endpoints cannot run this application's text/function-call loop.
    // https://developers.openai.com/api/docs/guides/embeddings
    // https://developers.openai.com/api/docs/guides/audio
    // https://developers.openai.com/api/docs/guides/image-generation
    if (provider === 'openai' && /^(?:text-embedding-|text-search-|text-similarity-|whisper-|tts-|gpt-image-|dall-e-|sora-|omni-moderation-|text-moderation-|gpt-audio(?:-|$)|gpt-realtime(?:-|$)|gpt-4o-(?:realtime|audio|transcribe|mini-transcribe|mini-tts))/.test(id)) {
      result.compatible = false; result.supportsTools = false; result.textCompatible = false;
      result.compatibilityReason = '此模型使用嵌入、音频、图像、视频或审核等专用接口，不能用于当前文本编程工具流程。';
      supported = [];
    }
  }
  const noText = ['input_modalities', 'output_modalities'].some(key =>
    Array.isArray(metadata[key]) && metadata[key].length > 0 && metadata[key].every(item => typeof item === 'string') && !metadata[key].includes('text'));
  // `compatible` describes the coding/tool loop. A text-only model can still
  // answer a separate tools:[] request. Preserve that distinction when these
  // normalized capabilities pass through derive again (e.g. a cached catalog).
  const normalizedTextOnly = metadata.compatible === false && metadata.supportsTools === false && metadata.textCompatible === true;
  const textDenied = noText || metadata.lifecycle === 'retired' || result.textCompatible === false
    || metadata.compatible === false && !normalizedTextOnly;
  if (textDenied) result.textCompatible = false;
  else if (result.supportsTools === false) result.textCompatible = true;
  if (textDenied || result.supportsTools === false || result.compatible === false) {
    result.compatible = false; result.supportsTools = false;
    result.compatibilityReason ||= metadata.lifecycle === 'retired' ? '服务商目录将此模型标记为已退役。'
      : noText ? '模型目录未声明支持当前流程所需的文本输入和输出。' : '模型元数据声明不支持当前工具调用流程。';
  }
  if (supported !== undefined) result.reasoningEfforts = supported;
  if (supported?.includes(defaultLevel)) result.defaultReasoningEffort = defaultLevel;
  return result;
}

function endpointFor(provider, baseUrl) {
  if (!Object.hasOwn(DEFAULTS, provider)) throw failure('CATALOG_INVALID_CONFIG', '模型目录服务商无效。');
  const raw = baseUrl === undefined || baseUrl === '' ? DEFAULTS[provider] : baseUrl;
  if (provider === 'relay' && !raw) throw failure('CATALOG_INVALID_URL', '请先填写中转站的 Base URL，再获取模型目录。');
  if (typeof raw !== 'string' || /[?#\u0000-\u001f]/.test(raw)) throw failure('CATALOG_INVALID_URL', '模型目录 API 地址不能包含查询参数、片段或控制字符。');
  let url;
  try { url = new URL(raw); } catch { throw failure('CATALOG_INVALID_URL', '模型目录 API 地址无效。'); }
  const authority = raw.match(/^[a-z][a-z\d+.-]*:\/\/([^/]*)/i)?.[1] || '';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.username || url.password || authority.includes('@') || (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
    throw failure('CATALOG_INVALID_URL', 'API 地址仅允许 HTTPS 或本机 HTTP，且不能包含用户名和密码。');
  }
  let prefix = url.pathname.replace(/\/+$/, '');
  prefix = prefix.replace(/\/(?:responses|chat\/completions|messages|models)$/, '');
  url.pathname = `${prefix}/models`;
  return url;
}

function officialEndpoint(provider, url) {
  return (provider === 'openai' && url.origin === 'https://api.openai.com' && url.pathname === '/v1/models')
    || (provider === 'deepseek' && url.origin === 'https://api.deepseek.com' && ['/models', '/v1/models'].includes(url.pathname))
    || (provider === 'anthropic' && url.origin === 'https://api.anthropic.com' && url.pathname === '/v1/models');
}

function credentialForms(key) {
  return [...new Set([key, encodeURIComponent(key), encodeURI(key), Buffer.from(key).toString('base64'), Buffer.from(key).toString('base64url')])];
}

function containsCredential(value, secrets) {
  if (typeof value === 'string') {
    let decoded = value;
    for (let pass = 0; pass < 3; pass++) {
      if (secrets.some(secret => decoded.includes(secret))) return true;
      try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } catch { break; }
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(item => containsCredential(item, secrets));
  if (object(value)) return Object.values(value).some(item => containsCredential(item, secrets));
  return false;
}

function normalizeModel(provider, item, officialSource, secrets) {
  if (!object(item) || typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200 || /[\u0000-\u001f\u007f]/.test(item.id)) {
    throw failure('CATALOG_INVALID_RESPONSE', '模型目录包含无效的模型标识。');
  }
  const name = [item.display_name, item.name, item.displayName].find(value => typeof value === 'string' && value.trim() && value.length <= 300 && !/[\u0000-\u001f\u007f]/.test(value));
  const model = { id: item.id, displayName: name || item.id,
    ...deriveModelCapabilities(provider, item.id, { ...item, officialSource,
      // Raw server `compatible:false` is an explicit protocol denial. Only our
      // previously normalized text-only result may carry that flag alongside
      // textCompatible:true; contradictory raw advertisements cannot override it.
      ...(item.compatible === false ? { textCompatible: false } : {}),
    }),
  };
  if (containsCredential(model, secrets)) throw failure('CATALOG_UNSAFE_RESPONSE', '模型目录回显了不安全的凭据信息，已拒绝展示。');
  return model;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(cancelled()); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) { reject(cancelled()); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function boundedJSON(response, signal, budget, limit) {
  if (!response.body?.getReader) throw failure('CATALOG_INVALID_RESPONSE', '模型目录响应缺少 JSON 正文。');
  const advertised = Number(response.headers?.get('content-length'));
  if (Number.isFinite(advertised) && advertised > limit - budget.bytes) throw failure('CATALOG_RESPONSE_TOO_LARGE', '模型目录响应超过大小上限。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      budget.bytes += value.byteLength;
      if (budget.bytes > limit) throw failure('CATALOG_RESPONSE_TOO_LARGE', '模型目录响应超过大小上限。');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    let result;
    try { result = JSON.parse(text); } catch { throw failure('CATALOG_INVALID_RESPONSE', '模型目录响应不是有效 JSON。'); }
    if (!object(result) || !Array.isArray(result.data) || result.error) throw failure('CATALOG_INVALID_RESPONSE', '模型目录响应缺少有效的 data 数组。');
    return result;
  } catch (error) {
    if (error instanceof CatalogError || error?.name === 'AbortError') throw error;
    throw failure('CATALOG_INVALID_RESPONSE', '模型目录响应编码或格式无效。');
  } finally {
    // Do not wait indefinitely for a peer's body cancellation implementation.
    try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
    try { reader.releaseLock(); } catch {}
  }
}

function httpError(status) {
  const detail = { 400: '目录地址或请求格式不受支持。', 401: 'API Key 无效或已过期。', 403: '当前凭据无权读取此目录。',
    404: '此 API 地址不提供模型目录；仍可手动填写模型 ID。', 429: '目录请求过于频繁，请稍后重试。',
    524: 'Cloudflare 已连接上游服务器，但未及时收到响应；请联系中转站确认上游状态，或稍后重试。延长客户端超时无法解决此网关超时。' }[status]
    || (status >= 500 ? '服务商目录暂不可用，请稍后重试。' : '服务商拒绝了目录请求。');
  return failure(`CATALOG_HTTP_${status}`, `HTTP ${status}：${detail}`, status);
}

export class ModelCatalog {
  #cache = new Map();
  #ttlMs; #timeoutMs; #maxResponseBytes; #maxModels; #maxPages; #clock;
  constructor({ ttlMs = 300000, timeoutMs = 20000, maxResponseBytes = 2 * 1024 * 1024, maxModels = 5000, maxPages = 20, clock = () => Date.now() } = {}) {
    for (const [key, value] of Object.entries({ ttlMs, timeoutMs, maxResponseBytes, maxModels, maxPages })) {
      if (!Number.isSafeInteger(value) || value <= 0) throw failure('CATALOG_INVALID_CONFIG', `模型目录 ${key} 配置无效。`);
    }
    if (typeof clock !== 'function') throw failure('CATALOG_INVALID_CONFIG', '模型目录时钟配置无效。');
    this.#ttlMs = ttlMs; this.#timeoutMs = timeoutMs; this.#maxResponseBytes = maxResponseBytes;
    this.#maxModels = maxModels; this.#maxPages = maxPages; this.#clock = clock;
  }

  async list({ provider, baseUrl, apiKey, force = false, signal, fetchImpl = globalThis.fetch } = {}) {
    const endpoint = endpointFor(provider, baseUrl);
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(apiKey)) throw failure('CATALOG_INVALID_CONFIG', '请提供有效的 API Key 后读取模型目录。');
    if (typeof fetchImpl !== 'function') throw failure('CATALOG_INVALID_CONFIG', '模型目录网络请求组件不可用。');
    if (signal?.aborted) throw cancelled();
    const key = apiKey.trim();
    const secrets = credentialForms(key);
    const cacheKey = `${provider}\0${endpoint.href}\0${createHash('sha256').update(key).digest('hex')}`;
    const cached = this.#cache.get(cacheKey);
    if (!force && cached && cached.expiresAt > this.#clock()) return clone(cached.result);
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.#timeoutMs);
    const budget = { bytes: 0 };
    const models = [], ids = new Set(), cursors = new Set();
    const official = officialEndpoint(provider, endpoint);
    let cursor;
    try {
      for (let page = 0; page < this.#maxPages; page++) {
        if (combined.aborted) throw cancelled();
        const url = new URL(endpoint);
        if (provider === 'anthropic') { url.searchParams.set('limit', '1000'); if (cursor) url.searchParams.set('after_id', cursor); }
        const response = await abortable(fetchImpl(url.href, { method: 'GET', redirect: 'error', signal: combined,
          headers: { Accept: 'application/json', ...(provider === 'anthropic'
            ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${key}` }) },
        }), combined);
        if (!response || !Number.isInteger(response.status)) throw failure('CATALOG_INVALID_RESPONSE', '模型目录网络响应无效。');
        if (!response.ok) {
          try { Promise.resolve(response.body?.cancel()).catch(() => {}); } catch {}
          throw httpError(response.status);
        }
        const body = await boundedJSON(response, combined, budget, this.#maxResponseBytes);
        if (body.data.length > this.#maxModels) throw failure('CATALOG_RESPONSE_TOO_LARGE', '模型目录条目数超过上限。');
        for (const item of body.data) {
          const model = normalizeModel(provider, item, official, secrets);
          if (ids.has(model.id)) continue;
          ids.add(model.id); models.push(model);
          if (models.length > this.#maxModels) throw failure('CATALOG_RESPONSE_TOO_LARGE', '模型目录条目数超过上限。');
        }
        if (provider !== 'anthropic') break;
        if (typeof body.has_more !== 'boolean') throw failure('CATALOG_INVALID_RESPONSE', 'Claude 模型目录缺少有效的分页状态。');
        if (!body.has_more) break;
        const next = body.last_id;
        if (!body.data.length || typeof next !== 'string' || !next || next.length > 200 || /[\u0000-\u001f\u007f]/.test(next) || cursors.has(next)) {
          throw failure('CATALOG_INVALID_RESPONSE', 'Claude 模型目录分页游标无效或重复。');
        }
        if (page + 1 >= this.#maxPages) throw failure('CATALOG_RESPONSE_TOO_LARGE', '模型目录页数超过上限，未返回不完整目录。');
        cursors.add(next); cursor = next;
      }
      if (combined.aborted) throw cancelled();
      const result = { models, fetchedAt: new Date(this.#clock()).toISOString(), source: 'api' };
      this.#cache.set(cacheKey, { result, expiresAt: this.#clock() + this.#ttlMs });
      while (this.#cache.size > 100) this.#cache.delete(this.#cache.keys().next().value);
      return clone(result);
    } catch (error) {
      // A failed refresh must not silently resurrect the previous cached list.
      this.#cache.delete(cacheKey);
      if (signal?.aborted) throw cancelled();
      if (timedOut) throw failure('CATALOG_TIMEOUT', '模型目录请求超时，请检查网络后重试。');
      if (error instanceof CatalogError) throw error;
      if (error?.name === 'AbortError') throw cancelled();
      // Neither upstream bodies nor arbitrary transport errors may reflect a key.
      throw failure('CATALOG_NETWORK_ERROR', '无法连接模型目录，请检查网络、代理和 API 地址。');
    } finally { clearTimeout(timer); }
  }
}
