import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { killAntigravityProcessTree } from './antigravity-agent.mjs';

const require = createRequire(import.meta.url);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const uuid = value => typeof value === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/u.test(value);
const fail = (code, message) => Object.assign(new Error(`[${code}] ${message}`), { name: 'ArkAccountError', code });
const cancelled = () => Object.assign(fail('ARK_CANCELLED', '火山方舟账号操作已取消。'), { name: 'AbortError' });
const check = signal => { if (signal?.aborted) throw cancelled(); };
export function arkAuthorizationUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20\x7f]/u.test(value)) throw invalid();
  let url; try { url = new URL(value); } catch { throw invalid(); }
  if (url.protocol !== 'https:' || url.hostname !== 'signin.volcengine.com' || url.port || url.username || url.password || url.hash
      || url.pathname !== '/authorize/oauth/authorize' || url.searchParams.get('client_id') !== 'trn:signin:::devtools/cross-device'
      || url.searchParams.get('redirect_uri') !== 'https://signin.volcengine.com/authorize/oauth/authorize'
      || url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256'
      || !url.searchParams.get('state') || !url.searchParams.get('code_challenge')) throw invalid();
  return value;
}
const authCodeValid = value => typeof value === 'string' && value.length > 0 && value.length <= 16384 && /^[A-Za-z\d+/_-]+={0,2}$/u.test(value);

const invalid = () => fail('ARK_PROTOCOL_ERROR', '官方 Ark CLI 返回的账号或运行时资料无效，请更新组件后重试。');
const types = ['platform', 'agent-plan', 'coding-plan', 'agent-plan-team', 'coding-plan-team'];
// Official contracts: volcengine/ark-cli skills/arkcli-profile/SKILL.md
// (ProfileType routing), arkcli-auth/references/api-key-query.md (apikey get),
// and arkcli-resources/references/arkcli-resources-list.md (scoped resources).
const lane = type => type.startsWith('agent-plan') ? 'agent_plan' : type.startsWith('coding-plan') ? 'coding_plan' : 'platform';
const baseUrl = profile => {
  if (profile.region !== 'cn-beijing' || !types.includes(profile.type)) throw fail('ARK_PROFILE_UNSUPPORTED', '此连接当前支持北京地域的方舟、Agent Plan 和 Coding Plan 官方 Profile。');
  const suffix = profile.type.startsWith('agent-plan') ? 'plan/' : profile.type.startsWith('coding-plan') ? 'coding/' : '';
  return `https://ark.cn-beijing.volces.com/api/${suffix}v3`;
};
const digest = value => createHash('sha256').update(value).digest('hex');
const keyValid = value => typeof value === 'string' && value.length >= 8 && value.length <= 4096 && !/[\x00-\x20\x7f*]/u.test(value);
function parseJson(value) { try { const parsed = JSON.parse(value); if (!object(parsed)) throw invalid(); return parsed; } catch { throw invalid(); } }
function identityOwner(status, whoami) {
  const nested = status.volc_sso?.identity?.trn, owner = whoami.trn || nested;
  if (!text(owner, 2048) || nested && nested !== owner) throw fail('ARK_ACCOUNT_CHANGED', '官方方舟登录身份资料不一致，请重新授权。');
  return owner;
}
function profileFrom(status, whoami, profileName) {
  if (status.logged_in !== true || whoami.logged_in !== true) throw fail('ARK_SIGN_IN_REQUIRED', '请通过官方 Ark CLI 浏览器授权连接火山方舟。');
  const raw = status.active_profile || whoami.active_profile || whoami.profile;
  if (!object(raw) || !text(raw.name) || !types.includes(raw.type) || !text(raw.region) || !text(raw.project ?? 'default')) throw invalid();
  const currentOwner = identityOwner(status, whoami), owner = raw.owner_trn || currentOwner;
  if (owner !== currentOwner || profileName && raw.name !== profileName) throw fail('ARK_ACCOUNT_CHANGED', '官方 Ark CLI 当前身份与所选 Profile 不一致，请重新连接。');
  const result = { name: raw.name, type: raw.type, region: raw.region, project: raw.project ?? 'default', owner };
  baseUrl(result); return result;
}
function profileChoices(status, whoami) {
  if (status.logged_in !== true || whoami.logged_in !== true) throw fail('ARK_SIGN_IN_REQUIRED', '请先完成官方方舟浏览器授权。');
  const rows = status.profiles_summary ?? whoami.profiles_summary ?? [];
  if (!Array.isArray(rows) || rows.length > 256) throw invalid();
  const result = new Map(), currentOwner = identityOwner(status, whoami), active = status.active_profile || whoami.active_profile || whoami.profile;
  if (active?.owner_trn && active.owner_trn !== currentOwner) throw fail('ARK_ACCOUNT_CHANGED', '官方方舟当前 Profile 与登录主体不一致，请重新授权。');
  for (const row of [...rows, active]) {
    if (!object(row) || !text(row.name) || !types.includes(row.type) || !text(row.region) || !text(row.project ?? 'default')) continue;
    // Only supported official routes can be offered for an API-key handoff.
    if (row.region !== 'cn-beijing' || row.owner_trn && row.owner_trn !== currentOwner) continue;
    const profile = { name: row.name, type: row.type, region: row.region, project: row.project ?? 'default' };
    if (result.has(row.name) && JSON.stringify(result.get(row.name)) !== JSON.stringify(profile)) throw invalid();
    result.set(row.name, profile);
  }
  if (!result.size) throw fail('ARK_PROFILE_UNAVAILABLE', '官方方舟账号没有提供受支持的北京地域 Profile，请在官方 CLI 中检查套餐和身份配置。');
  return [...result.values()];
}
function resourceModels(result, profile) {
  if (result.profile !== profile.name || result.type !== profile.type || result.modality !== 'text' || !Array.isArray(result.items) || result.items.length > 2048
      || result.item_count !== undefined && result.item_count !== result.items.length) throw invalid();
  const seen = new Set(), models = [];
  for (const item of result.items) {
    if (!object(item) || !text(item.id) || seen.has(item.id)) throw invalid(); seen.add(item.id);
    if (item.invocable !== true || item.data_plane !== lane(profile.type) || Array.isArray(item.required_overrides) && item.required_overrides.length) continue;
    const credential = profile.type.endsWith('-team') ? 'team_seat' : profile.type === 'agent-plan' ? 'agent_plan' : 'paygo';
    if (item.credential_kind !== credential || item.resource_kind !== (profile.type === 'platform' ? 'endpoint' : 'model')) continue;
    models.push({ id: item.id, displayName: text(item.name, 256) ? item.name : item.id, compatible: true, textCompatible: true,
      ...(item.is_default === true && result.current_default === item.id ? { default: true } : {}) });
  }
  return models;
}

// The npm wrapper executes this same original binary. Verify the bundled
// publisher manifest instead of resolving an arbitrary arkcli from PATH.
export function arkCliNativeExecutablePath(packageDirectory, filename) {
  // Electron can read package metadata through ASAR, but the OS needs the
  // unpacked native executable when creating the official CLI process.
  return path.join(packageDirectory, 'bin', filename).replace(/\.asar([\\/])/u, '.asar.unpacked$1');
}
export function createArkCliRuntime() {
  let ready = null;
  const locate = async () => {
    const packageFile = require.resolve('@volcengine/ark-cli/package.json'), directory = path.dirname(packageFile);
    const pkg = JSON.parse(await fs.readFile(packageFile, 'utf8'));
    const platform = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform], arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
    if (!platform || !arch || pkg.name !== '@volcengine/ark-cli' || !text(pkg.version, 80)) throw invalid();
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
    const entry = arkCliNativeExecutablePath(directory, `arkcli-${platform}-${arch}${platform === 'windows' ? '.exe' : ''}`), expected = manifest.platforms?.[`${platform}-${arch}`]?.sha256;
    if (!/^[a-f\d]{64}$/iu.test(expected || '')) throw invalid();
    const stat = await fs.lstat(entry); if (!stat.isFile() || stat.isSymbolicLink()) throw invalid();
    if (!ready || ready.entry !== entry || ready.size !== stat.size || ready.mtime !== stat.mtimeMs) {
      const hash = createHash('sha256'); for await (const chunk of createReadStream(entry)) hash.update(chunk);
      if (hash.digest('hex') !== expected.toLowerCase()) throw invalid();
      ready = { entry, version: pkg.version, size: stat.size, mtime: stat.mtimeMs };
    }
    return { entry, args: [], version: pkg.version };
  };
  return { init: async () => {}, ensure: async ({ signal } = {}) => {
    check(signal); try { const result = await locate(); check(signal); return result; }
    catch (error) { if (error.name === 'AbortError') throw error; throw fail('ARK_RUNTIME_MISSING', '官方 Ark CLI 组件缺失或校验失败，请重新安装 Cortex 或更新官方组件。'); }
  }, publicState: async () => { try { const value = await locate(); return { status: 'ready', version: value.version }; } catch { return { status: 'missing', version: '1.0.42' }; } } };
}

export class ArkAccount {
  #dir; #profiles; #file; #safe; #runtime; #spawn; #kill; #proxy; #change; #openExternal; #version; #timeout; #loginTimeout;
  #initialized = null; #grant = null; #attempt = null; #failure = null; #storageError = false; #closed = false; #rejected = false;
  #writes = Promise.resolve(); #commands = new Set(); #requests = new Set(); #knownSecrets = new Set(); #epoch = 0;
  constructor({ dataDir, safeStorage, runtime = createArkCliRuntime(), spawnImpl = spawn, killTreeImpl = killAntigravityProcessTree,
    getProxyEnv = () => ({}), onChange = () => {}, openExternal, version = '0.0.0', requestTimeoutMs = 60000, loginTimeoutMs = 600000 } = {}) {
    if (!text(dataDir, 8192) || !path.isAbsolute(dataDir) || !runtime?.ensure || !runtime?.publicState || typeof spawnImpl !== 'function' || typeof killTreeImpl !== 'function'
        || typeof getProxyEnv !== 'function' || typeof onChange !== 'function' || openExternal !== undefined && typeof openExternal !== 'function' || !text(version, 80)
        || ![requestTimeoutMs, loginTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 600000)) throw fail('ARK_INVALID_CONFIG', '火山方舟账号连接配置无效。');
    this.#dir = path.join(path.resolve(dataDir), 'ark-account'); this.#profiles = path.join(this.#dir, 'profiles'); this.#file = path.join(this.#dir, 'connection.json');
    this.#safe = safeStorage; this.#runtime = runtime; this.#spawn = spawnImpl; this.#kill = killTreeImpl; this.#proxy = getProxyEnv; this.#change = onChange; this.#openExternal = openExternal; this.#version = version;
    this.#timeout = requestTimeoutMs; this.#loginTimeout = loginTimeoutMs;
  }
  #changed() { try { Promise.resolve(this.#change()).catch(() => {}); } catch {} }
  #setError(error) { this.#failure = { code: error?.name === 'ArkAccountError' ? error.code : 'ARK_REQUEST_FAILED', message: error?.name === 'ArkAccountError' ? error.message : '火山方舟账号操作失败，请检查官方组件、账号权限和网络后重试。' }; this.#changed(); }
  #encryption() { if (!this.#safe?.isEncryptionAvailable?.() || typeof this.#safe.encryptString !== 'function' || typeof this.#safe.decryptString !== 'function') throw fail('ARK_STORAGE_LOCKED', '系统安全存储不可用，无法保存方舟运行时密钥。'); }
  #home(profileId) { if (!uuid(profileId)) throw invalid(); const home = path.resolve(this.#profiles, profileId); if (path.dirname(home) !== this.#profiles) throw invalid(); return home; }
  async #mkdir(directory) { await fs.mkdir(directory, { recursive: true }); const stat = await fs.lstat(directory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid(); }
  async #removeHome(profileId) { const home = this.#home(profileId), stat = await fs.lstat(home).catch(() => null); if (stat) { if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid(); await fs.rm(home, { recursive: true, force: true }); } }
  async init() {
    if (this.#initialized) return this.#initialized;
    this.#initialized = (async () => {
      await this.#runtime.init?.();
      try {
        await this.#mkdir(this.#dir); await this.#mkdir(this.#profiles);
        const stat = await fs.lstat(this.#file).catch(error => { if (error.code === 'ENOENT') return null; throw error; }); if (!stat) return this;
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw invalid();
        const record = parseJson(await fs.readFile(this.#file, 'utf8')); this.#encryption();
        if (record.version !== 1 || !uuid(record.profileId) || typeof record.encrypted !== 'string' || !/^[A-Za-z\d+/]+={0,2}$/u.test(record.encrypted)) throw invalid();
        const grant = parseJson(this.#safe.decryptString(Buffer.from(record.encrypted, 'base64')));
        if (grant.profileId !== record.profileId || !keyValid(grant.apiKey) || !object(grant.profile) || !text(grant.profile.owner, 2048) || grant.baseUrl !== baseUrl(grant.profile)
            || grant.binding !== digest(JSON.stringify(grant.profile) + '\n' + grant.apiKey) || !Array.isArray(grant.models) || grant.models.length > 2048) throw invalid();
        const homeStat = await fs.lstat(this.#home(grant.profileId)); if (!homeStat.isDirectory() || homeStat.isSymbolicLink()) throw invalid();
        this.#grant = grant; this.#knownSecrets.add(grant.apiKey); this.#storageError = false; this.#rejected = false;
      } catch { this.#grant = null; this.#storageError = true; this.#failure = { code: 'ARK_STORAGE_UNREADABLE', message: '无法读取加密的方舟连接记录，请重试读取或重新连接。' }; }
      return this;
    })(); return this.#initialized;
  }
  async ensure() { await this.init(); const result = await this.#runtime.ensure(); this.#changed(); return result; }
  async #save(grant, signal) {
    this.#writes = this.#writes.catch(() => {}).then(async () => {
      const temporary = path.join(this.#dir, `.connection-${randomUUID()}.json`);
      try {
        check(signal); await this.#mkdir(this.#dir);
        if (!grant) { await fs.unlink(this.#file).catch(error => { if (error.code !== 'ENOENT') throw error; }); return; }
        this.#encryption(); const raw = JSON.stringify(grant), encrypted = this.#safe.encryptString(raw);
        if (!Buffer.isBuffer(encrypted) || this.#safe.decryptString(encrypted) !== raw) throw invalid();
        await fs.writeFile(temporary, JSON.stringify({ version: 1, profileId: grant.profileId, encrypted: encrypted.toString('base64') }), { flag: 'wx', mode: 0o600 });
        check(signal); await fs.rename(temporary, this.#file);
        const persisted = parseJson(await fs.readFile(this.#file, 'utf8'));
        if (this.#safe.decryptString(Buffer.from(persisted.encrypted, 'base64')) !== raw) throw invalid();
      } finally { await fs.unlink(temporary).catch(() => {}); }
    }); return this.#writes;
  }
  redact(value) { let result = String(value); for (const secret of this.#knownSecrets) result = result.split(secret).join('[已隐藏方舟凭据]'); return result; }
  async publicState() {
    await this.init(); const grant = this.#grant, rejected = this.#rejected;
    return { runtime: await this.#runtime.publicState(), session: { status: this.#attempt ? 'connecting' : rejected || this.#storageError ? 'reauth_required' : grant ? 'connected' : 'disconnected', sharing: Boolean(grant) && !rejected && !this.#storageError, profileId: grant?.profileId || null,
      ...(grant ? { identity: { name: grant.profile.name, type: grant.profile.type, region: grant.profile.region, project: grant.profile.project } } : {}) },
    attempt: this.#attempt ? { phase: this.#attempt.phase, ...(this.#attempt.verificationUrl ? { verificationUrl: this.#attempt.verificationUrl, expiresAt: this.#attempt.expiresAt } : {}) } : null, profiles: this.#attempt?.profiles ? structuredClone(this.#attempt.profiles) : grant ? [{ name: grant.profile.name, type: grant.profile.type, region: grant.profile.region, project: grant.profile.project }] : [],
    error: this.#failure ? { ...this.#failure } : null, storageRecovery: this.#storageError,
    storage: { owner: 'official-cli-and-app', homeIsolated: true, credentialScope: 'app-isolated', encrypted: true }, models: grant ? structuredClone(grant.models) : [] };
  }
  async #options(profileId, signal) {
    const home = this.#home(profileId); await this.#mkdir(this.#profiles); await this.#mkdir(home); check(signal);
    let proxy;
    try { proxy = await this.#proxy(); }
    catch { check(signal); throw fail('ARK_PROXY_FAILED', '无法读取当前代理配置，请检查系统代理后重试。'); }
    check(signal);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => /^(?:path|pathext|systemroot|windir|comspec|temp|tmp|appdata|localappdata|lang|lc_all|node_extra_ca_certs)$/iu.test(key) && typeof value === 'string'));
    if (object(proxy)) for (const [key, value] of Object.entries(proxy)) if (/^(?:https?_proxy|all_proxy|no_proxy)$/iu.test(key) && text(value, 4096)) env[key] = value;
    env.HOME = home; env.USERPROFILE = home; env.APPDATA = path.join(home, 'AppData', 'Roaming'); env.LOCALAPPDATA = path.join(home, 'AppData', 'Local'); env.CI = '1'; env.ARKCLI_NO_UPDATE_NOTIFIER = '1';
    return { cwd: home, env, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] };
  }
  async #run(args, profileId, { signal, login = false } = {}) {
    check(signal); const runtime = await this.#runtime.ensure({ signal }), options = await this.#options(profileId, signal); check(signal);
    if (!text(runtime.entry, 8192) || !path.isAbsolute(runtime.entry) || runtime.args !== undefined && (!Array.isArray(runtime.args) || runtime.args.some(arg => !text(arg, 4096)))) throw invalid();
    if (/\.[cm]?js$/iu.test(runtime.entry)) options.env.ELECTRON_RUN_AS_NODE = '1';
    return new Promise((resolve, reject) => {
      let child, timer, done = false, output = '', size = 0; const decoder = new StringDecoder('utf8');
      const finish = error => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); this.#commands.delete(command); error ? reject(error) : resolve(output); };
      const command = { stop: () => { void this.#kill(child).catch(() => {}); finish(cancelled()); } };
      const abort = () => command.stop(); this.#commands.add(command);
      try {
        const entry = /\.[cm]?js$/iu.test(runtime.entry) ? process.execPath : runtime.entry;
        child = this.#spawn(entry, [...(/\.[cm]?js$/iu.test(runtime.entry) ? [runtime.entry] : []), ...(runtime.args || []), ...args], options);
        if (!child?.stdout?.on || !child?.stderr?.on || !child?.once) throw invalid();
        child.stdout.on('data', bytes => { size += bytes.length; if (size > 4 * 1024 * 1024) { void this.#kill(child).catch(() => {}); finish(invalid()); return; } output += decoder.write(Buffer.from(bytes)); });
        child.stderr.on('data', bytes => { size += bytes.length; if (size > 4 * 1024 * 1024) { void this.#kill(child).catch(() => {}); finish(invalid()); } });
        child.once('error', () => finish(fail('ARK_START_FAILED', '无法启动官方 Ark CLI，请重新安装组件。')));
        child.once('close', code => { output += decoder.end(); finish(code === 0 ? null : fail(login ? 'ARK_AUTH_FAILED' : 'ARK_CLI_FAILED', login ? '官方 Ark CLI 登录未完成，请在浏览器完成授权并确认账号 Profile 已配置。' : '官方 Ark CLI 未返回可用运行时资料，请检查 Profile、套餐权限或重新连接。')); });
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) return abort();
        timer = setTimeout(() => { void this.#kill(child).catch(() => {}); finish(fail('ARK_TIMEOUT', login ? '官方方舟授权超时，请重试。' : '官方方舟资料查询超时，请重试。')); }, login ? this.#loginTimeout : this.#timeout);
      } catch (error) { finish(error?.name === 'ArkAccountError' ? error : fail('ARK_START_FAILED', '无法启动官方 Ark CLI，请重新安装组件。')); }
    });
  }
  async #authorize(attempt) {
    const flags = ['auth', 'login', '--login-mode', 'legacy', '--no-browser'];
    // The pinned CLI's default broker flow does not implement --no-browser.
    // Keep both phases in its documented legacy cross-device flow and HOME.
    let raw;
    try { raw = await this.#run(flags, attempt.profileId, { signal: attempt.controller.signal, login: true }); }
    catch (error) {
      if (error?.code === 'ARK_AUTH_FAILED') throw fail('ARK_AUTH_INITIALIZATION_FAILED', '官方方舟登录组件未能生成授权页面，请检查网络、代理和组件状态后重试。');
      throw error;
    }
    const response = parseJson(raw);
    if (response.stage !== 'authorize_pending' || response.method !== 'sso_no_browser'
        || !Number.isSafeInteger(response.expires_in_sec) || response.expires_in_sec <= 0 || response.expires_in_sec > 600) throw invalid();
    attempt.verificationUrl = arkAuthorizationUrl(response.authorize_url);
    attempt.expiresAt = Date.now() + Math.min(response.expires_in_sec * 1000, this.#loginTimeout);
    let first = true;
    while (true) {
      check(attempt.controller.signal);
      if (Date.now() >= attempt.expiresAt) throw fail('ARK_AUTH_EXPIRED', '本次方舟授权已过期，请重新登录。');
      const codePending = new Promise((resolve, reject) => {
        let timer;
        const cleanup = () => { clearTimeout(timer); attempt.controller.signal.removeEventListener('abort', abort); attempt.submitCode = null; };
        const abort = () => { cleanup(); reject(cancelled()); };
        attempt.submitCode = code => { cleanup(); resolve(code); };
        attempt.controller.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => { cleanup(); reject(fail('ARK_AUTH_EXPIRED', '本次方舟授权已过期，请重新登录。')); }, Math.max(1, attempt.expiresAt - Date.now()));
        if (attempt.controller.signal.aborted) abort();
      });
      // Attach a handler before awaiting browser startup: cancellation can win.
      codePending.catch(() => {});
      attempt.phase = 'waiting-authorization-code'; this.#changed();
      if (first) { first = false; await this.openAuthorization().catch(error => { if (error.name === 'AbortError') throw error; this.#setError(error); }); }
      const code = await codePending; check(attempt.controller.signal);
      attempt.phase = 'exchanging-authorization-code'; this.#failure = null; this.#changed();
      try { await this.#run([...flags, '--code', code], attempt.profileId, { signal: attempt.controller.signal, login: true }); }
      catch (error) {
        check(attempt.controller.signal);
        if (Date.now() >= attempt.expiresAt) throw fail('ARK_AUTH_EXPIRED', '本次方舟授权已过期，请重新登录。');
        if (error.code !== 'ARK_AUTH_FAILED') throw error;
        this.#setError(fail('ARK_AUTH_EXCHANGE_FAILED', '授权码校验或兑换未完成，请复制当前官方页面的完整授权码后重试。'));
        continue;
      }
      delete attempt.verificationUrl; delete attempt.expiresAt; this.#failure = null; return;
    }
  }
  async openAuthorization() {
    const attempt = this.#attempt;
    if (!attempt || attempt.controller.signal.aborted || attempt.phase !== 'waiting-authorization-code' || !attempt.verificationUrl) throw fail('ARK_BUSY', '当前没有等待中的方舟授权页面。');
    const url = arkAuthorizationUrl(attempt.verificationUrl);
    if (Date.now() >= attempt.expiresAt) throw fail('ARK_AUTH_EXPIRED', '本次方舟授权已过期，请重新登录。');
    try {
      if (!this.#openExternal) throw new Error();
      await new Promise((resolve, reject) => {
        let timer;
        const finish = (error) => { clearTimeout(timer); attempt.controller.signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
        const abort = () => finish(cancelled());
        attempt.controller.signal.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(new Error('Browser startup timed out')), 15000);
        if (attempt.controller.signal.aborted) return abort();
        Promise.resolve().then(() => this.#openExternal(url)).then(() => finish(), finish);
      });
    } catch (error) {
      if (attempt.controller.signal.aborted || error?.name === 'AbortError') throw cancelled();
      throw fail('ARK_BROWSER_OPEN_FAILED', '无法打开官方授权页面，请检查默认浏览器后点击重新打开。');
    }
    if (this.#attempt === attempt && attempt.phase === 'waiting-authorization-code' && this.#failure?.code === 'ARK_BROWSER_OPEN_FAILED') { this.#failure = null; this.#changed(); }
    return this.publicState();
  }
  async submitAuthorizationCode(code) {
    const attempt = this.#attempt;
    if (!attempt || attempt.controller.signal.aborted || attempt.phase !== 'waiting-authorization-code' || !attempt.submitCode) throw fail('ARK_BUSY', '当前没有等待中的方舟授权。');
    if (typeof code === 'string') code = code.trim();
    if (!authCodeValid(code)) throw fail('ARK_AUTH_CODE_INVALID', '请粘贴官方页面返回的完整 base64 授权码。');
    if (Date.now() >= attempt.expiresAt) throw fail('ARK_AUTH_EXPIRED', '本次方舟授权已过期，请重新登录。');
    this.#knownSecrets.add(code); this.#failure = null; attempt.phase = 'exchanging-authorization-code'; attempt.submitCode(code); this.#changed();
    return this.publicState();
  }
  async #identityInfo(profileId, profileName, signal) {
    const flags = profileName ? ['--profile', profileName] : [];
    const status = parseJson(await this.#run(['auth', 'status', ...flags, '--format', 'json'], profileId, { signal }));
    const whoami = parseJson(await this.#run(['auth', 'whoami', ...flags, '--format', 'json'], profileId, { signal }));
    return { status, whoami };
  }
  async #identity(profileId, profileName, signal) { const { status, whoami } = await this.#identityInfo(profileId, profileName, signal); return profileFrom(status, whoami, profileName); }
  async #models(profileId, profile, signal) { return resourceModels(parseJson(await this.#run(['resources', 'list', '--profile', profile.name, '--modality', 'text', '--format', 'json'], profileId, { signal })), profile); }
  async signIn({ profileName, profileType, signal } = {}) {
    await this.init(); if (this.#closed) throw fail('ARK_CLOSED', '方舟账号连接已关闭。'); if (this.#attempt) throw fail('ARK_BUSY', '请等待当前方舟授权完成。');
    if (profileName !== undefined && !text(profileName) || profileType !== undefined && !types.includes(profileType)) throw fail('ARK_INVALID_CONFIG', '方舟 Profile 名称或类型无效。'); this.#encryption(); check(signal);
    const attempt = { controller: new AbortController(), profileId: randomUUID(), phase: 'waiting-browser' };
    const controller = attempt.controller, abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); this.#attempt = attempt; this.#failure = null; this.#changed();
    attempt.done = (async () => {
      let committed = false, staged = false;
      try {
        if (!attempt.profiles) {
          await this.#authorize(attempt); attempt.phase = 'validating-profile'; this.#changed();
          const identity = await this.#identityInfo(attempt.profileId, undefined, controller.signal); attempt.profiles = profileChoices(identity.status, identity.whoami); attempt.owner = identityOwner(identity.status, identity.whoami);
        }
        const candidates = attempt.profiles.filter(row => profileName ? row.name === profileName : profileType ? row.type === profileType : true);
        if (!candidates.length) throw fail('ARK_PROFILE_UNAVAILABLE', '官方账号未提供所选 Profile；不会改用其他套餐或按量计费连接。');
        let selected = candidates.length === 1 && (profileName !== undefined || profileType !== undefined) ? candidates[0] : null;
        if (!selected) {
          attempt.profiles = candidates; attempt.phase = 'choosing-profile'; this.#changed();
          const selectedName = await new Promise((resolve, reject) => {
            const cleanup = () => { controller.signal.removeEventListener('abort', abortSelection); attempt.select = null; };
            const abortSelection = () => { cleanup(); reject(cancelled()); };
            attempt.select = value => { cleanup(); resolve(value); };
            controller.signal.addEventListener('abort', abortSelection, { once: true }); if (controller.signal.aborted) abortSelection();
          });
          selected = candidates.find(row => row.name === selectedName); if (!selected) throw invalid();
        }
        attempt.phase = 'validating-profile'; this.#changed();
        const profile = await this.#identity(attempt.profileId, selected.name, controller.signal);
        if (profile.owner !== attempt.owner || ['name', 'type', 'region', 'project'].some(key => profile[key] !== selected[key]))
          throw fail('ARK_ACCOUNT_CHANGED', '所选方舟 Profile 的账号或计费范围已变化，请重新授权并确认配置。');
        const raw = await this.#run(['profile', 'apikey', 'get', '--profile', profile.name, '--plain'], attempt.profileId, { signal: controller.signal });
        const apiKey = raw.replace(/\r?\n$/u, ''); if (!keyValid(apiKey)) throw fail('ARK_RUNTIME_KEY_UNAVAILABLE', '方舟浏览器身份已授权，但所选 Profile 没有可安全交接的运行时密钥，请在官方 CLI 中检查套餐或 Key 配置。');
        this.#knownSecrets.add(apiKey); const models = await this.#models(attempt.profileId, profile, controller.signal); check(controller.signal);
        if (!models.length) throw fail('ARK_CATALOG_EMPTY', '方舟身份已授权，但此 Profile 未返回兼容的文本模型或接入点，请检查官方套餐和模型配置。');
        const grant = { profileId: attempt.profileId, profile, apiKey, baseUrl: baseUrl(profile), binding: digest(JSON.stringify(profile) + '\n' + apiKey), models };
        attempt.phase = 'saving'; this.#changed(); staged = true; await this.#save(grant, controller.signal); check(controller.signal);
        const previous = this.#grant; this.#grant = grant; committed = true; this.#storageError = false; this.#rejected = false; this.#failure = null; ++this.#epoch;
        for (const request of this.#requests) request.abort(); if (previous) await this.#removeHome(previous.profileId).catch(() => {});
        return this.publicState();
      } catch (error) { if (staged && !committed) await this.#save(this.#grant).catch(() => { this.#storageError = true; }); if (!controller.signal.aborted) this.#setError(error); throw controller.signal.aborted ? cancelled() : error; }
      finally { signal?.removeEventListener('abort', abort); if (this.#attempt === attempt) this.#attempt = null; if (!committed) await this.#removeHome(attempt.profileId).catch(() => {}); this.#changed(); }
    })(); return attempt.done;
  }
  async selectProfile(value) {
    const profileName = typeof value === 'string' ? value : value?.profileName ?? value?.name, attempt = this.#attempt;
    if (!attempt || attempt.phase !== 'choosing-profile' || typeof attempt.select !== 'function' || attempt.controller.signal.aborted) throw fail('ARK_NO_PROFILE_SELECTION', '当前没有等待选择的官方方舟 Profile。');
    if (!text(profileName) || !attempt.profiles.some(profile => profile.name === profileName)) throw fail('ARK_PROFILE_UNAVAILABLE', '请选择本次官方授权实际提供的 Profile。');
    attempt.phase = 'validating-profile'; attempt.select(profileName); this.#changed(); return this.publicState();
  }
  async cancelSignIn() { const attempt = this.#attempt; attempt?.controller.abort(); await attempt?.done.catch(() => {}); if (attempt && this.#attempt === attempt) { this.#attempt = null; await this.#removeHome(attempt.profileId).catch(() => {}); this.#changed(); } return this.publicState(); }
  #activeGrant() { if (this.#closed) throw fail('ARK_CLOSED', '方舟账号连接已关闭。'); if (!this.#grant || this.#storageError || this.#rejected) throw fail('ARK_SIGN_IN_REQUIRED', '请先连接火山方舟账号。'); if (this.#attempt) throw fail('ARK_BUSY', '请等待方舟授权完成。'); return this.#grant; }
  async listModels({ signal } = {}) {
    await this.init(); const grant = this.#activeGrant(), epoch = this.#epoch;
    try {
      const profile = await this.#identity(grant.profileId, grant.profile.name, signal);
      if (JSON.stringify(profile) !== JSON.stringify(grant.profile)) throw fail('ARK_ACCOUNT_CHANGED', '方舟 Profile 身份已变化，请重新连接后开始新会话。');
      const models = await this.#models(grant.profileId, profile, signal); check(signal); if (grant !== this.#grant || epoch !== this.#epoch) throw cancelled();
      if (!models.length) throw fail('ARK_CATALOG_EMPTY', '当前官方方舟 Profile 未提供可调用的文本模型或接入点。');
      const next = { ...grant, models }; await this.#save(next, signal); check(signal); if (grant !== this.#grant || epoch !== this.#epoch) throw cancelled();
      this.#grant = next; this.#failure = null; this.#changed(); return structuredClone(models);
    } catch (error) { if (grant === this.#grant && ['ARK_SIGN_IN_REQUIRED', 'ARK_ACCOUNT_CHANGED'].includes(error?.code)) this.#rejected = true; if (error.name !== 'AbortError') this.#setError(error); throw error; }
  }
  async requestModel({ requestModel, ...config } = {}) {
    await this.init(); const grant = this.#activeGrant();
    if (config.provider !== 'doubao' || config.authMode !== 'ark-account' || typeof requestModel !== 'function') throw fail('ARK_INVALID_CONFIG', '方舟账号调用配置无效。');
    if (config.arkProfileId && config.arkProfileId !== grant.profileId) throw fail('ARK_ACCOUNT_CHANGED', '方舟账号已变化，请重新开始任务。');
    if (!grant.models.some(model => model.id === config.model)) throw fail('ARK_MODEL_UNAVAILABLE', '当前方舟 Profile 未提供所选模型，请刷新目录。');
    const controller = new AbortController(), epoch = this.#epoch; this.#requests.add(controller);
    try {
      const result = await requestModel({ ...config, authMode: 'apiKey', apiKey: grant.apiKey, baseUrl: grant.baseUrl, apiProtocol: 'chat-completions',
        connectionKey: `ark:${grant.profileId}:${grant.binding.slice(0, 16)}`, signal: config.signal ? AbortSignal.any([config.signal, controller.signal]) : controller.signal });
      if (this.#grant?.profileId !== grant.profileId || epoch !== this.#epoch) throw cancelled(); return result;
    } catch (error) { if (this.#grant?.profileId === grant.profileId && (error?.code === 'PROVIDER_HTTP_401' || error?.status === 401)) { this.#rejected = true; this.#failure = { code: 'ARK_SIGN_IN_REQUIRED', message: '方舟运行时密钥已失效，请重新连接官方账号。' }; this.#changed(); } throw error; }
    finally { this.#requests.delete(controller); }
  }
  async retryLocalRead() { if (this.#attempt) throw fail('ARK_BUSY', '请先完成或取消方舟授权。'); this.#initialized = null; this.#grant = null; this.#storageError = false; this.#rejected = false; this.#failure = null; await this.init(); this.#changed(); return this.publicState(); }
  async disconnect() {
    await this.init(); await this.cancelSignIn(); ++this.#epoch; for (const request of this.#requests) request.abort();
    const previous = this.#grant; this.#grant = null; await this.#save(null); if (previous) await this.#removeHome(previous.profileId);
    this.#failure = null; this.#storageError = false; this.#rejected = false; this.#changed(); return this.publicState();
  }
  async dispose() { this.#closed = true; await this.cancelSignIn(); for (const request of this.#requests) request.abort(); for (const command of this.#commands) command.stop(); await this.#writes.catch(() => {}); }
}
