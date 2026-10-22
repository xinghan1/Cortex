const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const MAX_PROJECTS = 100, MAX_BYTES = 128 * 1024;
function workspacePath(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !value || value.length > 32767 || /[\u0000-\u001f\u007f]/u.test(value)
      || /^[\\/]{2}[?.][\\/]/u.test(value)) throw new Error('恢复项目路径无效。');
  const windows = /^[a-z]:[\\/]/iu.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value);
  if (!windows && !(process.platform !== 'win32' && path.posix.isAbsolute(value))) throw new Error('恢复项目路径无效。');
  const implementation = windows ? path.win32 : path.posix;
  const normalized = implementation.normalize(value);
  return normalized === implementation.parse(normalized).root ? normalized : normalized.replace(/[\\/]+$/u, '');
}
const identity = value => value === null ? null : process.platform === 'win32' || /^[a-z]:/iu.test(value) || value.startsWith('\\\\')
  ? value.toLowerCase() : value;
function selection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !UUID.test(value.sessionId)) throw new Error('恢复会话记录无效。');
  return { workspace: workspacePath(value.workspace), sessionId: value.sessionId };
}

// This file contains only explicit UI selections. Session contents remain in
// Store; restoring a selection never resumes a task, tool or pending approval.
class SessionRestore {
  #dir; #file; #fs; #value = { version: 1, current: null, projects: [] };
  #initializing; #queue = Promise.resolve(); #pending = 0; #writable = true; #error = null; #missing = false; #forgotten = new Set();
  constructor(dataDir, { filesystem = fs } = {}) {
    this.#dir = path.resolve(dataDir); this.#file = path.join(this.#dir, 'startup-session.json'); this.#fs = filesystem;
  }
  get pending() { return this.#pending > 0; }
  get error() { return this.#error; }
  snapshot() { return structuredClone(this.#value); }
  init() {
    return this.#initializing ??= (async () => {
      try {
        const stat = await this.#fs.lstat(this.#file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error('Invalid restore file');
        const value = JSON.parse(await this.#fs.readFile(this.#file, 'utf8'));
        if (!value || value.version !== 1 || !Array.isArray(value.projects) || value.projects.length > MAX_PROJECTS) throw new Error('Invalid restore data');
        const current = value.current === null ? null : selection(value.current);
        const projects = value.projects.map(selection);
        if (projects.some(item => item.workspace === null) || new Set(projects.map(item => identity(item.workspace))).size !== projects.length)
          throw new Error('Invalid restore projects');
        this.#value = { version: 1, current, projects };
      } catch (error) {
        if (error.code === 'ENOENT') this.#missing = true;
        else {
          this.#writable = false;
          this.#error = '上次会话记录损坏或无法读取，原文件已保留；本次正常打开新会话。';
        }
      }
      return this;
    })();
  }
  record(session, { active = true } = {}) {
    if (!session || session.temporary === true || this.#forgotten.has(session.id)) return Promise.resolve(false);
    let next;
    try { next = selection({ workspace: session.workspace, sessionId: session.id }); }
    catch { return Promise.resolve(false); }
    this.#pending++;
    const operation = this.#queue.then(async () => {
      await this.init();
      if (!this.#writable) throw new Error(this.#error);
      const projects = next.workspace === null ? this.#value.projects : [next,
        ...this.#value.projects.filter(item => identity(item.workspace) !== identity(next.workspace))].slice(0, MAX_PROJECTS);
      const value = { version: 1, current: active ? next : this.#value.current, projects };
      if (JSON.stringify(value) === JSON.stringify(this.#value)) return true;
      return this.#save(value);
    }).finally(() => { this.#pending--; });
    this.#queue = operation.catch(() => {});
    return operation;
  }
  forgetSession(id) {
    if (!UUID.test(id)) return Promise.reject(new Error('恢复会话 ID 无效。'));
    this.#forgotten.add(id); this.#pending++;
    const operation = this.#queue.then(async () => {
      await this.init();
      if (!this.#writable) throw new Error(this.#error);
      const value = { version: 1, current: this.#value.current?.sessionId === id ? null : this.#value.current,
        projects: this.#value.projects.filter(item => item.sessionId !== id) };
      if (JSON.stringify(value) === JSON.stringify(this.#value)) return true;
      return this.#save(value);
    }).finally(() => { this.#pending--; });
    this.#queue = operation.catch(() => {});
    return operation;
  }
  async #save(value) {
      const temporary = path.join(this.#dir, '.startup-session-' + randomUUID() + '.tmp');
      try {
        await this.#fs.mkdir(this.#dir, { recursive: true });
        if ((await this.#fs.lstat(this.#dir)).isSymbolicLink()) throw new Error('Invalid data directory');
        const destination = await this.#fs.lstat(this.#file).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (destination && (!destination.isFile() || destination.isSymbolicLink())) throw new Error('Invalid restore destination');
        await this.#fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        await this.#fs.rename(temporary, this.#file);
        this.#value = value; this.#error = null; this.#missing = false;
        return true;
      } catch {
        this.#error = '上次会话选择保存失败，已保留上次成功记录。';
        throw new Error(this.#error);
      } finally { await this.#fs.unlink(temporary).catch(() => {}); }
  }
  async flush() {
    // A late focus event may enqueue another selection while an earlier
    // atomic rename is in flight. Quit only after that tail settles as well.
    for (;;) { const queued = this.#queue; await queued; if (queued === this.#queue) return; }
  }
  async resolveProject(workspace, { readSession, listProjectSessions, preferredId } = {}) {
    await this.init();
    let canonical;
    try {
      canonical = await this.#fs.realpath(workspacePath(workspace));
      if (!(await this.#fs.stat(canonical)).isDirectory()) return null;
      // Directory ACL failures must be found before assigning the workspace.
      const directory = await this.#fs.opendir(canonical); await directory.close();
    } catch { return null; }
    const remembered = this.#value.projects.find(item => identity(item.workspace) === identity(workspacePath(workspace)));
    const checked = new Set();
    const load = async id => {
      if (!id || checked.has(id)) return null;
      checked.add(id);
      try {
        const session = await readSession(id);
        if (session.id !== id || session.temporary === true || identity(workspacePath(session.workspace)) !== identity(workspacePath(workspace))) return null;
        return { workspace: canonical, session };
      } catch { /* A missing or damaged session never destroys other history. */ }
      return null;
    };
    // The explicit ID is normally enough. Avoid scanning every history file
    // before the first paint when that selected session is still available.
    for (const id of [preferredId, remembered?.sessionId]) {
      const result = await load(id); if (result) return result;
    }
    let history = [];
    try { history = await listProjectSessions(canonical); } catch { /* Welcome/new session remains available. */ }
    for (const item of history) { const result = await load(item.id); if (result) return result; }
    return { workspace: canonical, session: null };
  }
  async resolve(options) {
    await this.init();
    const current = this.#value.current;
    if (!current) {
      // Upgrades have session history but no selection file yet. Use the old
      // meaningful-history index once; an existing damaged/unreadable file
      // must never be treated as permission to infer a different selection.
      if (this.#missing && typeof options.listSessions === 'function') {
        let history = [];
        try { history = await options.listSessions(); } catch { return null; }
        for (const item of history) {
          if (!item?.workspace) continue;
          const restored = await this.resolveProject(item.workspace, { ...options, preferredId: item.id });
          if (restored?.session) return restored;
        }
      }
      return null;
    }
    if (current.workspace !== null) return this.resolveProject(current.workspace, { ...options, preferredId: current.sessionId });
    try {
      const session = await options.readSession(current.sessionId);
      return session.workspace === null && session.temporary !== true ? { workspace: null, session } : null;
    } catch { return null; }
  }
}

module.exports = { SessionRestore };
