const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MODES = new Set(['request', 'assist', 'full']);
const MAX_PROJECTS = 512, MAX_FILE_BYTES = 4 * 1024 * 1024;
const preferenceError = (message, code) => Object.assign(new Error(message), { code });

function projectKey(root) {
  if (root === null) return null;
  const invalid = () => { throw preferenceError('权限模式的项目路径无效。', 'PERMISSION_PREFERENCES_INVALID_PATH'); };
  if (typeof root !== 'string' || !root || root.length > 32767 || /[\u0000-\u001f\u007f]/u.test(root)) invalid();
  const windows = /^[a-z]:[\\/]/iu.test(root) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(root);
  if (windows) {
    if (/^[\\/]{2}[?.][\\/]/u.test(root)) invalid();
    const components = root.replace(/^[a-z]:/iu, '').split(/[\\/]+/u).filter(Boolean);
    if (components.some(part => /[<>:"|?*]/u.test(part) || part !== '.' && part !== '..' && /[. ]$/u.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(part))) invalid();
    const normalized = path.win32.normalize(root.replace(/\//gu, '\\')).toLowerCase();
    return normalized === path.win32.parse(normalized).root ? normalized : normalized.replace(/\\+$/u, '');
  }
  if (process.platform !== 'win32' && path.posix.isAbsolute(root) && !root.startsWith('//')) {
    return path.posix.normalize(root).replace(/\/+$/u, '') || '/';
  }
  invalid();
}

function decode(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
    || Object.keys(value).length !== 2 || !Array.isArray(value.modes) || value.modes.length > MAX_PROJECTS) throw new Error('Invalid permission preferences');
  const modes = new Map();
  for (const entry of value.modes) {
    if (!Array.isArray(entry) || entry.length !== 2 || !MODES.has(entry[1])) throw new Error('Invalid permission preference');
    const key = projectKey(entry[0]);
    if (key !== entry[0] || modes.has(key)) throw new Error('Invalid permission project');
    modes.set(key, entry[1]);
  }
  return modes;
}

// Persist explicit choices independently of provider settings and account
// secrets. Existing windows keep their own active mode; callers choose when
// to restore a project's saved mode, and still validate full-mode confirmation.
class PermissionPreferences {
  #dir; #file; #modes = new Map(); #initializing; #queue = Promise.resolve();

  constructor(dataDir) {
    if (typeof dataDir !== 'string' || !dataDir.trim() || /[\u0000-\u001f\u007f]/u.test(dataDir)) {
      throw preferenceError('权限首选项存储配置无效。', 'PERMISSION_PREFERENCES_INVALID_CONFIG');
    }
    this.#dir = path.resolve(dataDir);
    this.#file = path.join(this.#dir, 'permission-preferences.json');
  }

  get(root = null) { return this.#modes.get(projectKey(root)) || 'request'; }

  init() {
    return this.#initializing ??= (async () => {
      try {
        const stat = await fs.lstat(this.#file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid preference file');
        this.#modes = decode(JSON.parse(await fs.readFile(this.#file, 'utf8')));
      } catch {
        // Missing, damaged or unreadable data never grants permissions. Loading
        // does not overwrite the file; only a later explicit selection saves.
      }
      return this;
    })();
  }

  async set(root, mode) {
    const key = projectKey(root);
    if (!MODES.has(mode)) throw preferenceError('权限模式无效。', 'PERMISSION_PREFERENCES_INVALID_MODE');
    const operation = this.#queue.then(async () => {
      await this.init();
      const next = new Map(this.#modes);
      next.delete(key); next.set(key, mode);
      while (next.size > MAX_PROJECTS) next.delete(next.keys().next().value);
      const temporary = path.join(this.#dir, `.permission-preferences-${randomUUID()}.tmp`);
      try {
        const encoded = JSON.stringify({ version: 1, modes: [...next] }) + '\n';
        if (Buffer.byteLength(encoded) > MAX_FILE_BYTES) throw new Error('Preferences too large');
        await fs.mkdir(this.#dir, { recursive: true });
        const destination = await fs.lstat(this.#file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (destination && (!destination.isFile() || destination.isSymbolicLink())) throw new Error('Invalid preference destination');
        await fs.writeFile(temporary, encoded, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, this.#file);
        this.#modes = next;
        return mode;
      } catch {
        throw preferenceError('权限模式保存失败，请稍后重试。', 'PERMISSION_PREFERENCES_SAVE_FAILED');
      } finally {
        await fs.unlink(temporary).catch(() => {});
      }
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async settled() {
    await this.init();
    for (;;) { const queued = this.#queue; await queued; if (queued === this.#queue) return; }
  }
}

module.exports = { PermissionPreferences, permissionProjectKey: projectKey };
