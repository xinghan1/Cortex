import { randomUUID } from 'node:crypto';

const TEN_MINUTES = 10 * 60 * 1000;
const MAX_ENTRIES = 24;
const MAX_MODELS = 5000;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const signature = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const validId = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);

function failure(code, message) {
  const error = new Error(message);
  error.name = 'SettingsCatalogError'; error.code = code;
  return error;
}

function snapshotModels(models) {
  let copied;
  try { copied = structuredClone(models); }
  catch { throw failure('SETTINGS_CATALOG_UNAVAILABLE', '模型目录数据无效，请重新获取目录。'); }
  if (!Array.isArray(copied) || !copied.length || copied.length > MAX_MODELS) {
    throw failure('SETTINGS_CATALOG_UNAVAILABLE', '模型目录为空或不可用，请成功获取目录后再保存。');
  }
  const ids = new Set();
  for (const model of copied) {
    if (!object(model) || !validId(model.id) || ids.has(model.id)
        || (model.compatible !== undefined && typeof model.compatible !== 'boolean')) {
      throw failure('SETTINGS_CATALOG_UNAVAILABLE', '模型目录包含无效或重复的模型信息，请重新获取目录。');
    }
    ids.add(model.id);
  }
  if (!copied.some(model => model.compatible !== false)) {
    throw failure('SETTINGS_CATALOG_UNAVAILABLE', '模型目录中没有可选模型，请检查服务商和接口设置后重新获取。');
  }
  return copied;
}

/** Main-process grants for a successful settings preview, never API keys or configuration drafts. */
export class SettingsCatalogSelections {
  #entries = new Map();
  #clock; #ttlMs; #maxEntries;

  constructor({ clock = Date.now, ttlMs = TEN_MINUTES, maxEntries = MAX_ENTRIES } = {}) {
    if (typeof clock !== 'function' || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > TEN_MINUTES
        || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_ENTRIES) {
      throw failure('SETTINGS_CATALOG_INVALID_CONFIG', '模型目录选择凭证的缓存配置无效。');
    }
    this.#clock = clock; this.#ttlMs = ttlMs; this.#maxEntries = maxEntries;
  }

  #now() {
    let now;
    try { now = this.#clock(); } catch {}
    if (!Number.isSafeInteger(now) || now < 0 || now > 8.64e15 - this.#ttlMs) {
      this.#entries.clear();
      throw failure('SETTINGS_CATALOG_SELECTION_EXPIRED', '无法确认模型目录的有效时间，请稍后重新获取目录。');
    }
    return now;
  }

  #prune(now) {
    for (const [token, entry] of this.#entries) {
      if (now < entry.createdAt || now >= entry.expiresAt) this.#entries.delete(token);
    }
  }

  register(arg = {}) {
    if (!object(arg) || !signature(arg.connection)) {
      throw failure('SETTINGS_CATALOG_INVALID_CONNECTION', '模型目录连接标识无效，请重新获取目录。');
    }
    const models = snapshotModels(arg.models);
    const now = this.#now(); this.#prune(now);
    const selectionToken = randomUUID(), expiresAt = now + this.#ttlMs;
    this.#entries.set(selectionToken, { connection: arg.connection.toLowerCase(), models, createdAt: now, expiresAt });
    while (this.#entries.size > this.#maxEntries) this.#entries.delete(this.#entries.keys().next().value);
    return { selectionToken, expiresAt: new Date(expiresAt).toISOString(), models: structuredClone(models) };
  }

  validate(arg = {}) {
    if (!object(arg) || typeof arg.selectionToken !== 'string' || arg.selectionToken.length > 100) {
      throw failure('SETTINGS_CATALOG_SELECTION_INVALID', '请先获取模型目录并选择模型，再保存设置。');
    }
    const now = this.#now(), entry = this.#entries.get(arg.selectionToken);
    this.#prune(now);
    if (!entry) throw failure('SETTINGS_CATALOG_SELECTION_INVALID', '模型目录选择凭证无效，请重新获取目录后再保存。');
    if (now < entry.createdAt || now >= entry.expiresAt) {
      throw failure('SETTINGS_CATALOG_SELECTION_EXPIRED', '模型目录已过期，请重新获取目录后再保存。');
    }
    if (!signature(arg.connection) || arg.connection.toLowerCase() !== entry.connection) {
      throw failure('SETTINGS_CATALOG_CONNECTION_CHANGED', '连接配置已改变，请重新获取模型目录后再保存。');
    }
    const selected = validId(arg.model) ? entry.models.find(model => model.id === arg.model) : undefined;
    if (!selected) throw failure('SETTINGS_CATALOG_MODEL_NOT_FOUND', '请选择本次获取的模型目录中的模型。');
    if (selected.compatible === false) {
      throw failure('SETTINGS_CATALOG_MODEL_INCOMPATIBLE', '此模型不支持当前编程流程，请选择目录中的其他模型。');
    }
    return structuredClone(selected);
  }
}
