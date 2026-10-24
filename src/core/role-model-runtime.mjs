import { createHash } from 'node:crypto';
import { SettingsCatalogSelections } from './settings-model-catalog.mjs';

export const MODEL_ROLES = Object.freeze(['subagent', 'approval', 'completion', 'sidebar', 'pet']);
const roleName = role => {
  if (!MODEL_ROLES.includes(role)) throw new Error('模型用途无效。');
  return role;
};
const changed = () => new DOMException('模型配置已变化。', 'AbortError');
function waitForCatalog(pending, signal) {
  if (!signal) return pending;
  signal.throwIfAborted();
  let onAbort;
  return Promise.race([pending, new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  })]).finally(() => signal.removeEventListener('abort', onAbort));
}

/** Independent connections share validation/catalog code, never the main credentials. */
export class RoleModelRuntime {
  constructor({ configs, accounts, deepseekAccounts = new Map(), geminiAccounts = new Map(), catalog, deriveCapabilities, requestModel, redact = String }) {
    Object.assign(this, { configs, accounts, deepseekAccounts, geminiAccounts, catalog, deriveCapabilities, requestModel, redact });
    this.grants = new SettingsCatalogSelections();
    this.previews = new Map(); this.snapshots = new Map();
    this.revisions = Object.fromEntries(MODEL_ROLES.map(role => [role, 0]));
  }
  invalidate(role) { this.revisions[roleName(role)]++; }
  async publicState(main) {
    const result = this.configs.publicState();
    for (const role of MODEL_ROLES) {
      const entry = result[role], settings = entry.enabled ? entry.settings : main;
      entry.effective = { provider: settings.provider, authMode: settings.authMode, model: settings.model };
      entry.chatgpt = await this.accounts.get(role).publicState();
      entry.deepseek = await this.deepseekAccounts.get(role)?.publicState() || null;
      entry.gemini = await this.geminiAccounts.get(role)?.publicState() || null;
    }
    return result;
  }
  async draft(role, arg = {}) {
    roleName(role);
    const input = { provider: arg.provider, model: '' };
    for (const key of ['authMode', 'baseUrl', 'apiProtocol', 'apiKey', 'clearKey', 'contextWindowTokens', 'reasoningEffort', 'region'])
      if (Object.hasOwn(arg, key)) input[key] = arg[key];
    const validator = await this.configs.draft(role, input);
    const settings = validator.publicSettings();
    if (['antigravity-agent', 'kimi-agent', 'glm-agent'].includes(settings.authMode)) throw new Error('此登录方式是完整官方代理；请为此功能单独配置 API 模型。');
    const isDeepSeek = settings.provider === 'deepseek' && settings.authMode === 'deepseek-account';
    const isGemini = settings.provider === 'gemini' && settings.authMode === 'gemini-account';
    const account = isGemini ? await this.geminiAccounts.get(role)?.publicState()
      : isDeepSeek ? await this.deepseekAccounts.get(role)?.publicState() : await this.accounts.get(role).publicState();
    const isAccount = isGemini || isDeepSeek || settings.provider === 'openai' && settings.authMode === 'chatgpt';
    if (isAccount && (account?.session?.status !== 'connected' || !account.session.sharing || !account.session.profileId))
      throw new Error(isGemini ? '请先登录此用途的 Google 账号。' : isDeepSeek ? '请先登录此用途的 DeepSeek 账号。' : '请先连接此用途的 ChatGPT 账号，并授权套餐用量。');
    const apiKey = isAccount ? '' : validator.key(settings.provider);
    if (!isAccount && settings.provider !== 'ollama' && !apiKey) throw new Error('请填写此用途的 API Key，再获取模型目录。');
    const connection = createHash('sha256').update(JSON.stringify([role, settings.provider, settings.authMode,
      isAccount ? 'official' : settings.baseUrl, settings.apiProtocol || 'responses',
      isAccount ? account.session.profileId : apiKey, settings.contextWindowTokens || null])).digest('hex');
    return { input, validator, settings, account, apiKey, connection };
  }
  async preview(role, arg) {
    const draft = await this.draft(role, arg), settings = draft.settings;
    let result;
    if (settings.authMode === 'gemini-account') {
      result = { source: 'gemini-account', fetchedAt: new Date().toISOString(),
        models: await this.geminiAccounts.get(role).listModels({ force: true }) };
    } else if (settings.authMode === 'deepseek-account') {
      result = { source: 'deepseek-account', fetchedAt: new Date().toISOString(),
        models: await this.deepseekAccounts.get(role).listModels({ force: true }) };
    } else if (settings.authMode === 'chatgpt') {
      const models = await this.accounts.get(role).listModels({ force: true });
      result = { source: 'chatgpt', fetchedAt: new Date().toISOString(), models: models.map(model => ({
        ...model, id: model.slug, ...this.deriveCapabilities('openai', model.slug, { ...model, officialSource: true }),
      })) };
    } else result = await this.catalog.list({ provider: settings.provider, baseUrl: settings.baseUrl,
      apiKey: draft.apiKey, contextWindowTokens: settings.contextWindowTokens, force: true });
    if ((await this.draft(role, arg)).connection !== draft.connection) throw new Error('连接或账号已变化，请重新获取模型目录。');
    // Text-only roles may use models that do not expose coding tools.
    const models = result.models.map(model => role === 'subagent' ? model : ({ ...model,
      compatible: model.textCompatible !== false && (model.compatible !== false || model.textCompatible === true) }));
    let encoded = this.redact(JSON.stringify({ ...result, models, provider: settings.provider, authMode: settings.authMode }));
    if (draft.apiKey) encoded = encoded.replaceAll(JSON.stringify(draft.apiKey).slice(1, -1), '[已隐藏密钥]');
    const snapshot = JSON.parse(encoded);
    const grant = this.grants.register({ connection: draft.connection, models: snapshot.models });
    this.previews.set(grant.selectionToken, { role, connection: draft.connection, snapshot });
    while (this.previews.size > 24) this.previews.delete(this.previews.keys().next().value);
    return { ...snapshot, selectionToken: grant.selectionToken, expiresAt: grant.expiresAt };
  }
  async save(role, arg) {
    const draft = await this.draft(role, arg);
    const selected = this.grants.validate({ selectionToken: arg.selectionToken, connection: draft.connection, model: arg.model });
    const preview = this.previews.get(arg.selectionToken);
    if (!preview || preview.role !== role || preview.connection !== draft.connection) throw new Error('请重新获取目录后再保存配置。');
    if (role === 'subagent' && selected.supportsTools === false) throw new Error('子智能体需要支持编程工具的模型。');
    const levels = selected.reasoningEfforts || selected.reasoningLevels;
    const oldEffort = draft.settings.reasoningEffort || 'default';
    const reasoningEffort = Array.isArray(levels) && !levels.includes(oldEffort) ? 'default' : oldEffort;
    const input = { provider: draft.settings.provider, authMode: draft.settings.authMode,
      baseUrl: draft.settings.baseUrl, model: selected.id, reasoningEffort,
      ...(draft.settings.apiProtocol ? { apiProtocol: draft.settings.apiProtocol } : {}),
      ...(draft.settings.provider === 'ollama' ? { contextWindowTokens: draft.settings.contextWindowTokens } : {}),
      ...(draft.apiKey ? { apiKey: draft.apiKey } : {}) };
    await this.configs.save(role, input);
    this.snapshots.set(role, { connection: draft.connection, models: structuredClone(preview.snapshot.models) });
    this.invalidate(role);
  }
  async reset(role) { await this.configs.reset(roleName(role)); this.invalidate(role); }
  async config(role, { signal, permissionMode } = {}) {
    roleName(role); signal?.throwIfAborted();
    if (!this.configs.isEnabled(role)) throw new Error('此用途正在跟随当前模型。');
    const revision = this.revisions[role];
    const saved = this.configs.publicState()[role].settings;
    const draft = await this.draft(role, saved);
    signal?.throwIfAborted();
    if (revision !== this.revisions[role] || !this.configs.isEnabled(role)) throw new DOMException('模型配置已变化。', 'AbortError');
    const model = saved.model;
    if (!model) throw new Error('请先为此用途选择模型。');
    let snapshot = this.snapshots.get(role);
    if (saved.authMode === 'gemini-account' && snapshot?.connection !== draft.connection) {
      const account = this.geminiAccounts.get(role); let models;
      try { models = await waitForCatalog(Promise.resolve().then(() => account.listModels()), signal); }
      catch (error) {
        signal?.throwIfAborted(); if (error?.name === 'AbortError') throw error;
        // A catalog failure must not fabricate a CLI model capacity.
      }
      signal?.throwIfAborted();
      if (revision !== this.revisions[role] || !this.configs.isEnabled(role)) throw changed();
      const current = await account.publicState(); signal?.throwIfAborted();
      if (revision !== this.revisions[role] || !this.configs.isEnabled(role) || current.session?.status !== 'connected'
          || !current.session.sharing || current.session.profileId !== draft.account.session.profileId) throw changed();
      if (models) { snapshot = { connection: draft.connection, models }; this.snapshots.set(role, snapshot); }
    }
    if (saved.authMode === 'chatgpt' && snapshot?.connection !== draft.connection) {
      const account = this.accounts.get(role);
      let models;
      try {
        // The account controller shares its bounded, profile-scoped catalog
        // cache. A cancelled caller must not abort another caller's refresh.
        const listed = await waitForCatalog(Promise.resolve().then(() => account.listModels()), signal);
        models = listed.map(value => ({ ...value, id: value.slug,
          ...this.deriveCapabilities('openai', value.slug, { ...value, officialSource: true }) }));
      } catch (error) {
        signal?.throwIfAborted();
        if (error?.name === 'AbortError') throw error;
        // A failed refresh does not prove the account has the public model's
        // full capacity. Continue with an unknown budget and retry next time.
      }
      signal?.throwIfAborted();
      if (revision !== this.revisions[role] || !this.configs.isEnabled(role)) throw changed();
      const current = await account.publicState();
      signal?.throwIfAborted();
      if (revision !== this.revisions[role] || !this.configs.isEnabled(role)
          || current.session?.status !== 'connected' || !current.session.sharing
          || current.session.profileId !== draft.account.session.profileId) throw changed();
      if (models) {
        snapshot = { connection: draft.connection, models };
        this.snapshots.set(role, snapshot);
      }
    }
    if (saved.provider === 'ollama' && snapshot?.connection !== draft.connection) {
      const listed = await this.catalog.list({ provider: saved.provider, baseUrl: saved.baseUrl,
        apiKey: draft.apiKey, contextWindowTokens: saved.contextWindowTokens });
      signal?.throwIfAborted();
      snapshot = { connection: draft.connection, models: listed.models };
      this.snapshots.set(role, snapshot);
    }
    if (['gemini', 'kimi', 'glm'].includes(saved.provider) && saved.authMode === 'apiKey' && snapshot?.connection !== draft.connection) {
      let listed;
      try { listed = await waitForCatalog(Promise.resolve().then(() => this.catalog.list({ provider: saved.provider,
        baseUrl: saved.baseUrl, apiKey: draft.apiKey })), signal); }
      catch (error) { signal?.throwIfAborted(); if (error?.name === 'AbortError') throw error; }
      signal?.throwIfAborted();
      if (revision !== this.revisions[role] || !this.configs.isEnabled(role)) throw changed();
      if (listed) {
        snapshot = { connection: draft.connection, models: listed.models };
        this.snapshots.set(role, snapshot);
      }
    }
    const metadata = snapshot?.connection === draft.connection ? snapshot.models.find(value => value.id === model) : undefined;
    const modelCapabilities = this.deriveCapabilities(saved.provider, model, { ...metadata,
      ...(saved.provider === 'ollama' ? { contextWindowTokens: saved.contextWindowTokens } : {}),
      ...(saved.authMode === 'chatgpt' ? { officialSource: true, allowPublishedContextWindow: Boolean(metadata) } : {}) });
    if (role === 'subagent' && modelCapabilities.supportsTools === false) throw new Error('此子智能体模型不支持编程工具。');
    const key = createHash('sha256').update(JSON.stringify([draft.connection, model, saved.reasoningEffort, revision])).digest('hex');
    signal?.throwIfAborted();
    if (revision !== this.revisions[role] || !this.configs.isEnabled(role)) throw new DOMException('模型配置已变化。', 'AbortError');
    return { provider: saved.provider, apiKey: draft.apiKey, authMode: saved.authMode,
      baseUrl: saved.authMode === 'chatgpt' ? 'https://api.openai.com/v1' : saved.authMode === 'deepseek-account' ? 'https://api.deepseek.com/anthropic/v1' : saved.baseUrl,
      apiProtocol: saved.authMode === 'chatgpt' ? 'responses' : saved.apiProtocol,
      model, modelCapabilities, reasoningEffort: saved.reasoningEffort, permissionMode,
      modelRole: role, connectionKey: key, roleConnectionRevision: revision,
      chatgptProfileId: saved.authMode === 'chatgpt' ? draft.account.session.profileId : null,
      deepseekProfileId: saved.authMode === 'deepseek-account' ? draft.account.session.profileId : null,
      geminiProfileId: saved.authMode === 'gemini-account' ? draft.account.session.profileId : null };
  }
  async dispatch(config) {
    const role = roleName(config.modelRole);
    if (config.roleConnectionRevision !== this.revisions[role]) throw new DOMException('模型连接已变化，请重试。', 'AbortError');
    if (config.authMode === 'chatgpt') {
      const account = this.accounts.get(role), state = await account.publicState();
      if (config.roleConnectionRevision !== this.revisions[role]) throw new DOMException('模型连接已变化，请重试。', 'AbortError');
      if (state.session.profileId !== config.chatgptProfileId || !state.session.sharing) throw new Error('此用途的 ChatGPT 账号授权已变化，请重新连接。');
      return account.requestModel({ ...config, requestModel: this.requestModel });
    }
    if (config.authMode === 'deepseek-account') {
      const account = this.deepseekAccounts.get(role), state = await account?.publicState();
      if (config.roleConnectionRevision !== this.revisions[role]) throw new DOMException('模型连接已变化，请重试。', 'AbortError');
      if (!account || state.session.profileId !== config.deepseekProfileId || !state.session.sharing)
        throw new Error('此用途的 DeepSeek 账号授权已变化，请重新登录。');
      return account.requestModel({ ...config, requestModel: this.requestModel });
    }
    if (config.authMode === 'gemini-account') {
      const account = this.geminiAccounts.get(role), state = await account?.publicState();
      config.signal?.throwIfAborted();
      if (config.roleConnectionRevision !== this.revisions[role] || !this.configs.isEnabled(role)) throw changed();
      if (!account || state?.session?.status !== 'connected' || state.session.profileId !== config.geminiProfileId || !state.session.sharing)
        throw new Error('此用途的 Google 账号授权已变化，请重新登录。');
      return account.requestModel(config);
    }
    return this.requestModel(config);
  }
}
