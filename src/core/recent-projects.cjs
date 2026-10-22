const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_PROJECTS = 30;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const recentError = (message, code) => Object.assign(new Error(message), { code });

function projectPath(value) {
  const invalid = () => { throw recentError('项目路径必须是完整的绝对目录路径，不能包含路径穿越、设备路径或 URI。', 'RECENT_PROJECTS_INVALID_PATH'); };
  if (typeof value !== 'string' || !value || value.length > 32767 || /[\u0000-\u001f\u007f]/u.test(value)) invalid();
  const windows = /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+(?:[\\/]|$)/u.test(value);
  if (windows) {
    if (/^[\\/]{2}[?.][\\/]/u.test(value) || /^[\\/]\?\?[\\/]/u.test(value)) invalid();
    const components = value.replace(/^[a-z]:/iu, '').split(/[\\/]+/u).filter(Boolean);
    if (components.some(part => part === '.' || part === '..' || /[<>:"|?*]/u.test(part) || /[. ]$/u.test(part) || RESERVED.test(part))) invalid();
    const normalized = path.win32.normalize(value.replace(/\//gu, '\\'));
    const root = path.win32.parse(normalized).root;
    const absolute = normalized === root ? root : normalized.replace(/\\+$/u, '');
    const titlePath = absolute.replace(/\\+$/u, '');
    return { path: absolute, key: 'win:' + absolute.toLowerCase(), name: path.win32.basename(titlePath) || titlePath || root };
  }
  if (process.platform !== 'win32' && value.startsWith('/') && !value.startsWith('//')) {
    if (value.split('/').some(part => part === '.' || part === '..')) invalid();
    const absolute = path.posix.normalize(value).replace(/\/+$/u, '') || '/';
    return { path: absolute, key: 'posix:' + absolute, name: path.posix.basename(absolute) || '/' };
  }
  invalid();
}

function timestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error('Invalid recent-project timestamp');
  }
  return new Date(value).toISOString();
}

function normalizeRecords(values) {
  if (!Array.isArray(values) || values.length > 1000) throw new Error('Invalid recent-project list');
  const unique = new Map();
  for (const item of values) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid recent-project record');
    const project = projectPath(item.path);
    const lastOpenedAt = timestamp(item.lastOpenedAt);
    const previous = unique.get(project.key);
    if (!previous || lastOpenedAt > previous.lastOpenedAt) unique.set(project.key, { path: project.path, name: project.name, lastOpenedAt });
  }
  return [...unique.values()].sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)).slice(0, MAX_PROJECTS);
}

class RecentProjects {
  #dir;
  #file;
  #now;
  #projects = [];
  #hidden = [];
  #initializing;
  #queue = Promise.resolve();
  #writable = true;
  #error = null;

  constructor(dataDir, { now = () => new Date() } = {}) {
    if (typeof dataDir !== 'string' || !dataDir.trim() || /[\u0000-\u001f\u007f]/u.test(dataDir) || typeof now !== 'function') {
      throw recentError('最近项目存储配置无效。', 'RECENT_PROJECTS_INVALID_CONFIG');
    }
    this.#dir = path.resolve(dataDir);
    this.#file = path.join(this.#dir, 'projects.json');
    this.#now = now;
  }

  get error() { return this.#error; }
  // False means loading was unsafe; this instance will never replace that file.
  get writable() { return this.#writable; }
  list() { return this.#projects.map(project => ({ ...project })); }
  hidden() { return [...this.#hidden]; }
  isHidden(value) { try { return this.#hidden.some(item => projectPath(item).key === projectPath(value).key); } catch { return false; } }

  init() {
    if (!this.#initializing) this.#initializing = (async () => {
      try {
        const stat = await fs.lstat(this.#file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid recent-project file');
        const value = JSON.parse(await fs.readFile(this.#file, 'utf8'));
        if (!value || value.version !== 1 || Array.isArray(value)) throw new Error('Invalid recent-project version');
        this.#projects = normalizeRecords(value.projects);
        if (value.hidden !== undefined) {
          if (!Array.isArray(value.hidden) || value.hidden.length > 1000) throw new Error('Invalid hidden project list');
          this.#hidden = [...new Map(value.hidden.map(item => { const project = projectPath(item); return [project.key, project.path]; })).values()];
          this.#projects = this.#projects.filter(item => !this.isHidden(item.path));
        }
      } catch (error) {
        if (error.code !== 'ENOENT') {
          this.#writable = false;
          this.#error = '最近项目文件损坏或无法读取，原文件已保留；请备份并修复 projects.json 后重新启动。';
        }
      }
      return this;
    })();
    return this.#initializing;
  }

  async record(absoluteRoot) {
    const project = projectPath(absoluteRoot);
    const operation = this.#queue.then(async () => {
      await this.init();
      if (!this.#writable) throw recentError(this.#error, 'RECENT_PROJECTS_READ_ONLY');
      let opened;
      try { opened = new Date(this.#now()).toISOString(); }
      catch { throw recentError('最近项目打开时间无效。', 'RECENT_PROJECTS_INVALID_TIME'); }
      const next = [{ path: project.path, name: project.name, lastOpenedAt: opened }, ...this.#projects.filter(item => projectPath(item.path).key !== project.key)]
        .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt)).slice(0, MAX_PROJECTS);
      const hidden = this.#hidden.filter(item => projectPath(item).key !== project.key);
      return this.#save(next, hidden);
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async remove(absoluteRoot) {
    const project = projectPath(absoluteRoot);
    const operation = this.#queue.then(async () => {
      await this.init();
      if (!this.#writable) throw recentError(this.#error, 'RECENT_PROJECTS_READ_ONLY');
      const next = this.#projects.filter(item => projectPath(item.path).key !== project.key);
      const hidden = [project.path, ...this.#hidden.filter(item => projectPath(item).key !== project.key)].slice(0, 1000);
      return this.#save(next, hidden);
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async #save(next, hidden) {
      const temporary = path.join(this.#dir, '.projects-' + randomUUID() + '.tmp');
      try {
        await fs.mkdir(this.#dir, { recursive: true });
        if ((await fs.lstat(this.#dir)).isSymbolicLink()) throw new Error('Invalid data directory');
        const current = await fs.lstat(this.#file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (current && (!current.isFile() || current.isSymbolicLink())) throw new Error('Invalid recent-project destination');
        await fs.writeFile(temporary, JSON.stringify({ version: 1, projects: next, ...(hidden.length ? { hidden } : {}) }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, this.#file);
        this.#projects = next;
        this.#hidden = hidden;
        this.#error = null;
        return this.list();
      } catch {
        this.#error = '最近项目保存失败，已保留上次成功记录，请稍后重试。';
        throw recentError(this.#error, 'RECENT_PROJECTS_SAVE_FAILED');
      } finally {
        try { await fs.unlink(temporary); } catch { /* Renamed successfully or never created. */ }
      }
  }
}

module.exports = { RecentProjects };
