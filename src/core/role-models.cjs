const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Store } = require('./store.cjs');

const LEGACY_ROLE_KEYS = Object.freeze(['subagent', 'approval', 'completion', 'sidebar']);
const PREVIOUS_ROLE_KEYS = Object.freeze([...LEGACY_ROLE_KEYS, 'pet']);
const IMAGE_ROLE_KEYS = Object.freeze([...PREVIOUS_ROLE_KEYS, 'image']);
const ROLE_KEYS = Object.freeze([...IMAGE_ROLE_KEYS, 'frontend', 'backend', 'modeling']);
const MAX_BYTES = 512 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const failure = (message, code) => Object.assign(new Error(message), { code });
const validText = (value, limit) => typeof value === 'string' && value.length <= limit
  && !/[\u0000-\u001f\u007f]/u.test(value);

/** Independent role settings. Account sessions and model-catalog grants belong to the caller. */
class RoleModels {
  #dir; #file; #crypto; #roles; #initializing; #queue = Promise.resolve();

  constructor(dataDir, safeStorage) {
    if (typeof dataDir !== 'string' || !dataDir.trim() || /[\u0000-\u001f\u007f]/u.test(dataDir)) {
      throw failure('角色模型存储配置无效。', 'ROLE_MODELS_INVALID_CONFIG');
    }
    this.#dir = path.resolve(dataDir);
    this.#file = path.join(this.#dir, 'role-models.json');
    this.#crypto = safeStorage;
    this.#roles = Object.fromEntries(ROLE_KEYS.map(role => [role, { enabled: false, store: this.#store() }]));
  }

  #role(role) {
    if (!ROLE_KEYS.includes(role)) throw failure('角色模型类型无效。', 'ROLE_MODELS_INVALID_ROLE');
    return this.#roles[role];
  }

  #store(settings) {
    // Do not init Store: each role starts without the main connection's keys,
    // and must never create sessions/usage/settings.json of its own.
    const store = new Store(this.#dir, this.#crypto);
    if (settings) store.settings = structuredClone(settings);
    store.write = async () => {};
    return store;
  }

  #copyInput(input) {
    if (!object(input)) throw failure('角色模型设置无效。', 'ROLE_MODELS_INVALID_CONFIG');
    for (const [key, limit] of [['model', 200], ['baseUrl', 4096], ['apiKey', 4096]]) {
      if (input[key] !== undefined && !validText(input[key], limit)) {
        throw failure('角色模型设置格式不正确。', 'ROLE_MODELS_INVALID_CONFIG');
      }
    }
    try { return structuredClone(input); }
    catch { throw failure('角色模型设置无效。', 'ROLE_MODELS_INVALID_CONFIG'); }
  }

  #requiresKey(store) {
    const { provider, providers } = store.settings;
    return provider !== 'ollama' && !(provider === 'openai' && providers.openai.authMode === 'chatgpt')
      && !(provider === 'deepseek' && providers.deepseek.authMode === 'deepseek-account')
      && !(provider === 'gemini' && providers.gemini.authMode === 'gemini-account');
  }

  async #draft(role, input) {
    const store = this.#store(this.#role(role).store.settings);
    await store.saveSettings(input);
    if (['antigravity-agent', 'kimi-agent', 'glm-agent', 'claude-agent', 'ark-account'].includes(store.publicSettings().authMode))
      throw failure('此登录方式暂不支持独立角色；请为此功能单独配置 API 模型。', 'ROLE_MODELS_AGENT_UNSUPPORTED');
    if (this.#requiresKey(store) && !store.key(store.settings.provider)) {
      throw failure('请为此角色填写独立的 API Key。', 'ROLE_MODELS_API_KEY_REQUIRED');
    }
    return store;
  }

  async #decodeSettings(saved) {
    const store = this.#store(), defaults = store.settings;
    const providers = Object.keys(defaults.providers);
    // Accept exact historical provider sets, adding fresh empty connections.
    // Never copy the main model or credential into a role.
    if (object(saved) && [providers.filter(provider => !['kimi', 'glm'].includes(provider)),
      providers.filter(provider => !['gemini', 'kimi', 'glm'].includes(provider)),
      providers.filter(provider => !['doubao'].includes(provider)),
      providers.filter(provider => !['doubao', 'kimi', 'glm'].includes(provider)),
      providers.filter(provider => !['doubao', 'gemini', 'kimi', 'glm'].includes(provider))].some(legacy => exactKeys(saved.providers, legacy)))
      saved = { ...saved, providers: Object.fromEntries(providers.map(provider => [provider,
        Object.hasOwn(saved.providers, provider) ? saved.providers[provider] : structuredClone(defaults.providers[provider])])) };
    if (!exactKeys(saved, ['provider', 'providers']) || !providers.includes(saved.provider)
        || !exactKeys(saved.providers, providers)) throw new Error('Invalid role settings');
    for (const provider of providers) {
      const value = structuredClone(saved.providers[provider]), baseline = defaults.providers[provider];
      if (provider === 'gemini' && object(value) && exactKeys(value.modelsByAuth, ['apiKey', 'gemini-account']))
        value.modelsByAuth['antigravity-agent'] = '';
      // Version-one role files written before account login have no DeepSeek
      // auth fields. Preserve their model, endpoint and independent API key.
      if (provider === 'deepseek' && object(value) && !Object.hasOwn(value, 'authMode') && !Object.hasOwn(value, 'modelsByAuth')) {
        value.authMode = 'apiKey'; value.modelsByAuth = { apiKey: value.model, 'deepseek-account': '' };
      }
      if (['kimi', 'glm'].includes(provider) && object(value)) {
        if (!Object.hasOwn(value, 'authMode') && !Object.hasOwn(value, 'modelsByAuth')) {
          value.authMode = 'apiKey'; value.modelsByAuth = { apiKey: value.model, [`${provider}-agent`]: '' };
        }
        if (!Object.hasOwn(value, 'region')) value.region = baseline.region;
      }
      if (provider === 'doubao' && object(value) && !Object.hasOwn(value, 'authMode') && !Object.hasOwn(value, 'modelsByAuth')) {
        value.authMode = 'apiKey'; value.modelsByAuth = { apiKey: value.model, 'ark-account': '' };
        value.apiProtocol ??= 'chat-completions';
      }
      if (provider === 'anthropic' && object(value) && !Object.hasOwn(value, 'authMode') && !Object.hasOwn(value, 'modelsByAuth')) {
        value.authMode = 'apiKey'; value.modelsByAuth = { apiKey: value.model, 'claude-agent': '' };
      }
      const keys = Object.keys(baseline);
      if (!object(value) || !keys.every(key => Object.hasOwn(value, key))
          || Object.keys(value).some(key => !keys.includes(key) && key !== 'encryptedKey')
          || !validText(value.model, 200) || !validText(value.baseUrl, 4096)
          || !validText(value.reasoningEffort, 128)) throw new Error('Invalid role provider');
      if (Object.hasOwn(value, 'encryptedKey') && (typeof value.encryptedKey !== 'string'
          || !value.encryptedKey.length || value.encryptedKey.length > 16384
          || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.encryptedKey))) {
        throw new Error('Invalid role credential');
      }
      if (provider === 'openai' && (!exactKeys(value.modelsByAuth, ['apiKey', 'chatgpt'])
          || !Object.values(value.modelsByAuth).every(model => validText(model, 200))
          || !['apiKey', 'chatgpt'].includes(value.authMode)
          || value.model !== value.modelsByAuth[value.authMode])) throw new Error('Invalid role auth settings');
      if (provider === 'deepseek' && (!exactKeys(value.modelsByAuth, ['apiKey', 'deepseek-account'])
          || !Object.values(value.modelsByAuth).every(model => validText(model, 200))
          || !['apiKey', 'deepseek-account'].includes(value.authMode)
          || value.model !== value.modelsByAuth[value.authMode])) throw new Error('Invalid role auth settings');
      if (provider === 'doubao' && (!exactKeys(value.modelsByAuth, ['apiKey', 'ark-account'])
          || !Object.values(value.modelsByAuth).every(model => validText(model, 200)) || value.authMode !== 'apiKey'
          || value.model !== value.modelsByAuth.apiKey)) throw new Error('Invalid role account settings');
      if (provider === 'anthropic' && (!exactKeys(value.modelsByAuth, ['apiKey', 'claude-agent'])
          || !Object.values(value.modelsByAuth).every(model => validText(model, 200)) || value.authMode !== 'apiKey'
          || value.model !== value.modelsByAuth.apiKey)) throw new Error('Invalid role agent settings');
      if (provider === 'gemini' && (!exactKeys(value.modelsByAuth, ['apiKey', 'gemini-account', 'antigravity-agent'])
          || !Object.values(value.modelsByAuth).every(model => validText(model, 200))
          || !['apiKey', 'gemini-account'].includes(value.authMode)
          || value.model !== value.modelsByAuth[value.authMode])) throw new Error('Invalid role auth settings');
      if (['kimi', 'glm'].includes(provider) && (!exactKeys(value.modelsByAuth, ['apiKey', `${provider}-agent`])
          || !Object.values(value.modelsByAuth).every(model => validText(model, 200)) || value.authMode !== 'apiKey'
          || value.model !== value.modelsByAuth.apiKey || !(provider === 'kimi' ? ['mainland-cn', 'global'] : ['bigmodel', 'zai']).includes(value.region))) throw new Error('Invalid role agent settings');
      // An untouched relay has no endpoint. Store validates only the selected
      // provider, so do not turn this legitimate default into a corrupt file.
      if (provider === 'relay' && value.baseUrl === ''
          && exactKeys(value, keys) && keys.every(key => value[key] === baseline[key])) continue;
      const input = { provider, model: value.model, baseUrl: value.baseUrl, reasoningEffort: value.reasoningEffort };
      if (provider === 'openai') {
        input.apiProtocol = value.apiProtocol;
        for (const authMode of ['apiKey', 'chatgpt']) {
          await store.saveSettings({ ...input, authMode, model: value.modelsByAuth[authMode] });
        }
        input.authMode = value.authMode;
      }
      if (provider === 'deepseek') {
        for (const authMode of ['apiKey', 'deepseek-account'])
          await store.saveSettings({ ...input, authMode, model: value.modelsByAuth[authMode] });
        input.authMode = value.authMode;
      }
      if (provider === 'gemini') {
        for (const authMode of ['apiKey', 'gemini-account'])
          await store.saveSettings({ ...input, authMode, model: value.modelsByAuth[authMode] });
        input.authMode = value.authMode;
      }
      if (['relay', 'kimi', 'glm', 'doubao'].includes(provider)) input.apiProtocol = value.apiProtocol;
      if (['kimi', 'glm'].includes(provider)) { input.authMode = 'apiKey'; input.region = value.region; }
      if (['anthropic', 'doubao'].includes(provider)) input.authMode = 'apiKey';
      if (provider === 'ollama') input.contextWindowTokens = value.contextWindowTokens;
      await store.saveSettings(input);
    }
    for (const provider of providers) {
      if (saved.providers[provider].encryptedKey) store.settings.providers[provider].encryptedKey = saved.providers[provider].encryptedKey;
      if (['anthropic', 'doubao'].includes(provider)) {
        const mode = provider === 'anthropic' ? 'claude-agent' : 'ark-account';
        store.settings.providers[provider].modelsByAuth[mode] = saved.providers[provider].modelsByAuth?.[mode] || '';
      }
    }
    store.settings.provider = saved.provider;
    return store;
  }

  init() {
    return this.#initializing ??= (async () => {
      try {
        const stat = await fs.lstat(this.#file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid role settings file');
        const text = await fs.readFile(this.#file, 'utf8');
        if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Role settings file too large');
        const data = JSON.parse(text);
        if (!exactKeys(data, ['version', 'roles']) || data.version !== 1
            || ![ROLE_KEYS, IMAGE_ROLE_KEYS, PREVIOUS_ROLE_KEYS, LEGACY_ROLE_KEYS].some(keys => exactKeys(data.roles, keys))) throw new Error('Invalid role models');
        const roles = {};
        for (const role of ROLE_KEYS) {
          // Newly introduced roles follow the main model with independent defaults.
          if (!Object.hasOwn(data.roles, role)) {
            roles[role] = { enabled: false, store: this.#store() }; continue;
          }
          const value = data.roles[role];
          if (!exactKeys(value, ['enabled', 'settings']) || typeof value.enabled !== 'boolean') throw new Error('Invalid role state');
          const store = await this.#decodeSettings(value.settings);
          if (value.enabled && (!store.publicSettings().model
              || this.#requiresKey(store) && !store.settings.providers[store.settings.provider].encryptedKey)) throw new Error('Incomplete role settings');
          // A temporarily unavailable OS key store must not silently switch a
          // configured role to the main connection. Decryption occurs at use.
          roles[role] = { enabled: value.enabled, store };
        }
        this.#roles = roles;
      } catch (error) {
        if (error.code !== 'ENOENT') throw failure('角色模型配置无法读取，请备份 role-models.json 后重新配置。', 'ROLE_MODELS_LOAD_FAILED');
      }
      return this;
    })();
  }

  publicState() {
    return Object.fromEntries(ROLE_KEYS.map(role => [role, {
      enabled: this.#roles[role].enabled, settings: this.#roles[role].store.publicSettings(),
    }]));
  }

  isEnabled(role) { return this.#role(role).enabled; }
  settingsFor(role) { return structuredClone(this.#role(role).store.settings); }
  key(role, provider = this.#role(role).store.settings.provider) {
    const store = this.#role(role).store;
    if (!Object.hasOwn(store.settings.providers, provider)) throw failure('模型供应商无效。', 'ROLE_MODELS_INVALID_CONFIG');
    return store.key(provider);
  }

  redact(value) {
    const keys = new Set();
    for (const { store } of Object.values(this.#roles)) {
      for (const provider of Object.keys(store.settings.providers)) {
        try { const key = store.key(provider); if (key) keys.add(key); } catch { /* Unavailable credentials must not break error reporting. */ }
      }
    }
    let text = String(value);
    for (const key of [...keys].sort((a, b) => b.length - a.length)) text = text.split(key).join('[已隐藏密钥]');
    return text;
  }

  async draft(role, input) {
    this.#role(role);
    const copied = this.#copyInput(input);
    await this.settled();
    return this.#draft(role, copied);
  }

  async #persist(roles) {
    const temporary = path.join(this.#dir, `.role-models-${randomUUID()}.tmp`);
    try {
      const data = { version: 1, roles: Object.fromEntries(ROLE_KEYS.map(role => [role, {
        enabled: roles[role].enabled, settings: roles[role].store.settings,
      }])) };
      const encoded = JSON.stringify(data, null, 2) + '\n';
      if (Buffer.byteLength(encoded) > MAX_BYTES) throw new Error('Role settings too large');
      await fs.mkdir(this.#dir, { recursive: true });
      const stat = await fs.lstat(this.#file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Invalid role destination');
      await fs.writeFile(temporary, encoded, { flag: 'wx', mode: 0o600 });
      const delays = process.platform === 'win32' ? [20, 40, 80, 160, 320] : [];
      for (let attempt = 0; ; attempt++) {
        try { await fs.rename(temporary, this.#file); break; }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= delays.length) throw error;
          await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        }
      }
    } catch { throw failure('角色模型保存失败，请稍后重试。', 'ROLE_MODELS_SAVE_FAILED'); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }

  #enqueue(operation) {
    const pending = this.#queue.then(async () => { await this.init(); return operation(); });
    this.#queue = pending.catch(() => {});
    return pending;
  }

  async save(role, input) {
    this.#role(role);
    const copied = this.#copyInput(input);
    return this.#enqueue(async () => {
      const store = await this.#draft(role, copied);
      if (!store.publicSettings().model) throw failure('请选择此角色使用的模型。', 'ROLE_MODELS_MODEL_REQUIRED');
      const roles = { ...this.#roles, [role]: { enabled: true, store } };
      await this.#persist(roles);
      this.#roles = roles;
      return this.publicState();
    });
  }

  async reset(role) {
    this.#role(role);
    return this.#enqueue(async () => {
      const roles = { ...this.#roles, [role]: { ...this.#roles[role], enabled: false } };
      await this.#persist(roles);
      this.#roles = roles;
      return this.publicState();
    });
  }

  async settled() {
    await this.init();
    for (;;) { const queue = this.#queue; await queue; if (queue === this.#queue) return; }
  }
}

module.exports = { RoleModels, ROLE_KEYS };
