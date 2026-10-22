import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { taskUndoPlan } from './task-change-undo.mjs';
import { safeRelativePath } from './approval-policy.cjs';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
const MAX_FILE = 48 * 1024 * 1024, MAX_RAW = 32 * 1024 * 1024, MAX_RUN = 8 * 1024 * 1024;
const size = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;
const failure = () => new Error('持久撤销记录无法安全读取或保存，原文件已保留；该会话的自动撤销与恢复已停用。');
const safePath = value => safeRelativePath(value) && value === value.split(/[\\/]/u).filter(part => part !== '.').join('/');
const validChange = value => value && safePath(value.path) && ['before', 'after'].every(key => value[key] === null
  || typeof value[key] === 'string' && !value[key].includes('\0') && Buffer.byteLength(value[key]) <= 512 * 1024);

export class PersistentTaskUndo {
  #dir; #crypto; #fs; #legacy; #sessions = new Map(); #loading = new Map(); #queues = new Map(); #busy = new Set(); #pinned = new Set(); #deleting = new Set(); #deleted = new Set();
  constructor({ dataDir, safeStorage, legacyTaskUndoRuns = () => [], filesystem = fs }) {
    this.#dir = path.join(path.resolve(dataDir), 'task-undo'); this.#crypto = safeStorage; this.#fs = filesystem; this.#legacy = legacyTaskUndoRuns;
  }
  get pending() { return this.#queues.size > 0 || this.#loading.size > 0; }
  isProjectBusy(workspace) { return typeof workspace === 'string' && this.#busy.has(identity(workspace)); }
  async #storage(sessionId, missing = false) {
    if (!UUID.test(sessionId)) throw failure();
    const directory = await this.#fs.lstat(this.#dir).catch(error => { if (missing && error.code === 'ENOENT') return null; throw error; });
    if (directory && (!directory.isDirectory() || directory.isSymbolicLink())) throw failure();
    const file = path.join(this.#dir, `${sessionId}.json`);
    const stat = await this.#fs.lstat(file).catch(error => { if (missing && error.code === 'ENOENT') return null; throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FILE)) throw failure();
    return { file, stat };
  }
  #validate(value, sessionId, workspace) {
    if (!value || value.version !== 1 || value.sessionId !== sessionId || value.workspace !== workspace
        || typeof value.importedLegacy !== 'boolean' || !Array.isArray(value.runs) || value.runs.length > 64 || size(value) > MAX_RAW) throw failure();
    const ids = new Set();
    for (const run of value.runs) {
      if (!run || !UUID.test(run.runId) || ids.has(run.runId) || typeof run.sealed !== 'boolean' || typeof run.valid !== 'boolean') throw failure();
      ids.add(run.runId);
      if (run.sealed) {
        if (!Array.isArray(run.files) || run.files.length > 1024) throw failure();
        const paths = new Set();
        for (const file of run.files) {
          if (!validChange(file) || paths.has(identity(file.path)) || !['applied', 'undone', 'pending'].includes(file.state)) throw failure();
          paths.add(identity(file.path));
        }
      } else {
        if (!Array.isArray(run.changes) || run.changes.length > 1024 || size(run.changes) > MAX_RUN || run.changes.some(change => !validChange(change))) throw failure();
        if (run.valid && run.changes.length) taskUndoPlan(run.changes);
      }
    }
    return value;
  }
  async loadSession(session, { importLegacy = true } = {}) {
    const { id: sessionId, workspace } = session;
    if (!UUID.test(sessionId) || workspace !== null && typeof workspace !== 'string' || this.#deleting.has(sessionId) || this.#deleted.has(sessionId)) throw failure();
    if (this.#loading.has(sessionId)) return this.#loading.get(sessionId);
    if (this.#sessions.has(sessionId)) {
      const entry = this.#sessions.get(sessionId); if (entry.value.workspace !== workspace) throw failure(); return;
    }
    const pending = (async () => {
      const entry = { temporary: session.temporary === true, blocked: false,
        value: { version: 1, sessionId, workspace, importedLegacy: false, runs: [] } };
      this.#sessions.set(sessionId, entry);
      if (entry.temporary) return;
      let missing = false;
      try {
        const target = await this.#storage(sessionId, true);
        if (!target.stat) missing = true;
        else {
          if (!this.#crypto.isEncryptionAvailable()) throw failure();
          const outer = JSON.parse(await this.#fs.readFile(target.file, 'utf8'));
          if (outer.version !== 1 || outer.sessionId !== sessionId || typeof outer.encrypted !== 'string'
              || !/^[a-z\d+/]+={0,2}$/iu.test(outer.encrypted)) throw failure();
          entry.value = this.#validate(JSON.parse(this.#crypto.decryptString(Buffer.from(outer.encrypted, 'base64'))), sessionId, workspace);
        }
      } catch { entry.blocked = true; return; }
      if (missing) {
        try {
          const imported = importLegacy ? this.#legacy(session) : [];
          for (const run of imported) {
            if (!UUID.test(run.runId)) continue;
            const files = taskUndoPlan(run.changes);
            if (files.some(file => !safePath(file.path)) || size(files) > MAX_RUN) continue;
            const undone = new Set(run.undonePaths ?? []);
            entry.value.runs.push({ runId: run.runId, valid: true, sealed: true, files: files.map(file => ({ ...file, state: undone.has(file.path) ? 'undone' : 'applied' })) });
          }
          entry.value.importedLegacy = true;
          // Even an empty marker prevents a later redacted history import.
          await this.#enqueue(sessionId, () => {});
        } catch { entry.blocked = true; }
      }
    })();
    this.#loading.set(sessionId, pending);
    try { await pending; } finally { this.#loading.delete(sessionId); }
  }
  #entry(sessionId, workspace) {
    const entry = this.#sessions.get(sessionId);
    if (!entry || entry.blocked || entry.value.workspace !== workspace || this.#deleting.has(sessionId) || this.#deleted.has(sessionId)) throw failure();
    return entry;
  }
  async deleteSession(sessionId) {
    if (!UUID.test(sessionId) || [...this.#pinned].some(value => value.startsWith(sessionId + ':')) || this.#deleting.has(sessionId)) throw failure();
    this.#deleting.add(sessionId);
    try {
      await this.#loading.get(sessionId);
      await this.#queues.get(sessionId);
      const target = await this.#storage(sessionId, true);
      const backup = target.stat ? await this.#fs.readFile(target.file) : null;
      const entry = this.#sessions.get(sessionId);
      if (target.stat) await this.#fs.unlink(target.file);
      this.#sessions.delete(sessionId);
      this.#deleted.add(sessionId);
      return { rollback: async () => {
        if (backup) {
          const current = await this.#storage(sessionId, true);
          if (current.stat) throw failure();
          await this.#fs.writeFile(current.file, backup, { flag: 'wx', mode: 0o600 });
        }
        if (entry) this.#sessions.set(sessionId, entry);
        this.#deleted.delete(sessionId);
      } };
    } finally { this.#deleting.delete(sessionId); }
  }
  async #save(entry) {
    if (entry.temporary) return;
    if (!this.#crypto.isEncryptionAvailable()) throw failure();
    const value = entry.value;
    while (value.runs.length > 64 || size(value) > MAX_RAW) {
      if (value.runs.length <= 1) throw failure();
      const index = value.runs.findIndex(run => !this.#pinned.has(`${value.sessionId}:${run.runId}`));
      if (index < 0) throw failure();
      value.runs.splice(index, 1);
    }
    await this.#fs.mkdir(this.#dir, { recursive: true });
    const target = await this.#storage(value.sessionId, true);
    const encrypted = this.#crypto.encryptString(JSON.stringify(value)).toString('base64');
    const contents = JSON.stringify({ version: 1, sessionId: value.sessionId, encrypted });
    if (Buffer.byteLength(contents) > MAX_FILE) throw failure();
    const temporary = path.join(this.#dir, `.${value.sessionId}-${randomUUID()}.tmp`);
    try {
      const handle = await this.#fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
      await this.#storage(value.sessionId, true);
      for (let attempt = 0; ; attempt++) {
        try { await this.#fs.rename(temporary, target.file); break; }
        catch (error) {
          if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
          await new Promise(resolve => setTimeout(resolve, 20 * 2 ** attempt));
        }
      }
    } finally { await this.#fs.unlink(temporary).catch(() => {}); }
  }
  #enqueue(sessionId, mutation) {
    const previous = this.#queues.get(sessionId) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const entry = this.#sessions.get(sessionId);
      if (!entry || entry.blocked) throw failure();
      try { mutation(entry.value); await this.#save(entry); }
      catch { entry.blocked = true; throw failure(); }
    });
    this.#queues.set(sessionId, pending);
    pending.finally(() => { if (this.#queues.get(sessionId) === pending) this.#queues.delete(sessionId); }).catch(() => {});
    return pending;
  }
  record({ runId, sessionId, workspace, change }) {
    this.#entry(sessionId, workspace);
    if (!UUID.test(runId) || !validChange(change)) throw failure();
    return this.#enqueue(sessionId, value => {
      let run = value.runs.find(item => item.runId === runId);
      if (!run) { run = { runId, valid: true, sealed: false, changes: [] }; value.runs.push(run); }
      if (!run.valid || run.sealed) return;
      run.changes.push({ path: change.path, before: change.before, after: change.after });
      try { taskUndoPlan(run.changes); if (!safePath(change.path) || size(run.changes) > MAX_RUN) throw failure(); }
      catch { run.valid = false; run.changes = []; }
    });
  }
  seal(runId, sessionId, workspace) {
    this.#entry(sessionId, workspace);
    return this.#enqueue(sessionId, value => {
      const run = value.runs.find(item => item.runId === runId);
      if (!run || run.sealed) return;
      run.files = run.valid ? taskUndoPlan(run.changes).map(file => ({ ...file, state: 'applied' })) : [];
      run.sealed = true; delete run.changes;
    });
  }
  ids(sessionId, workspace, direction = 'undo') {
    try {
      return this.#entry(sessionId, workspace).value.runs.filter(run => run.valid && run.sealed
        && !run.files.some(file => file.state === 'pending')
        && run.files.some(file => file.state === (direction === 'redo' ? 'undone' : 'applied'))).map(run => run.runId);
    } catch { return []; }
  }
  async copySession(sourceId, target) {
    await this.flush(); await this.loadSession(target, { importLegacy: false });
    const source = this.#entry(sourceId, target.workspace), destination = this.#entry(target.id, target.workspace);
    if (source.value.runs.length && !destination.value.runs.length) await this.#enqueue(target.id, value => { value.runs = structuredClone(source.value.runs); });
  }
  async operate({ sessionId, workspace, runId, direction = 'undo', workspaceTools, signal, onFileChange }) {
    if (!['undo', 'redo'].includes(direction)) throw failure();
    const project = identity(workspace);
    if (this.#busy.has(project)) throw new Error('此项目正在另一窗口撤销或恢复修改，请稍后重试。');
    this.#busy.add(project);
    const pin = `${sessionId}:${runId}`; this.#pinned.add(pin);
    try {
      await this.flush();
      const entry = this.#entry(sessionId, workspace), run = entry.value.runs.find(value => value.runId === runId);
      const from = direction === 'undo' ? 'applied' : 'undone', to = direction === 'undo' ? 'undone' : 'applied';
      if (!run?.valid || !run.sealed || run.files.some(file => file.state === 'pending')) throw failure();
      const files = run.files.filter(file => file.state === from);
      if (!files.length) throw new Error('此轮没有可执行的撤销或恢复修改。');
      const changes = files.map(({ path, before, after }) => direction === 'undo' ? { path, before, after } : { path, before: after, after: before });
      const rawResult = await workspaceTools.undoChanges(changes, { signal, onFileChange, operationLabel: direction === 'redo' ? '恢复' : '撤销',
        beforeCommit: async change => {
          await this.#enqueue(sessionId, () => { const file = run.files.find(item => item.path === change.path); file.state = 'pending'; });
        },
        onCommitted: async change => {
          await this.#enqueue(sessionId, () => { const file = run.files.find(item => item.path === change.path); file.state = to; });
        },
      });
      const result = JSON.parse(rawResult);
      // Cancellation may occur after the write-ahead journal but before any
      // file commit. Only an exact guarded read of the unchanged source side
      // can release that pending marker for a later retry.
      if (!entry.blocked) for (const file of files.filter(value => value.state === 'pending' && !result.completed.includes(value.path))) {
        let current;
        try { current = (await workspaceTools.readFile({ path: file.path })).content; }
        catch (error) { if (error.code === 'ENOENT') current = null; else continue; }
        if (current === (from === 'applied' ? file.after : file.before)) {
          try { await this.#enqueue(sessionId, () => { file.state = from; }); } catch { break; }
        }
      }
      return rawResult;
    } finally { this.#busy.delete(project); this.#pinned.delete(pin); }
  }
  async flush() {
    for (;;) {
      const pending = [...this.#queues.values(), ...this.#loading.values()]; if (!pending.length) return;
      await Promise.allSettled(pending);
      if (![...this.#queues.values(), ...this.#loading.values()].some(value => !pending.includes(value))) return;
    }
  }
}
