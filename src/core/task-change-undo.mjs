const MAX_CHANGES = 1024, MAX_RUN_BYTES = 8 * 1024 * 1024, MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const bytes = value => typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;

export function taskUndoPlan(changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > MAX_CHANGES) throw new Error('本轮原始修改记录不完整，无法撤销。');
  const files = new Map();
  for (const change of changes) {
    if (!change || typeof change.path !== 'string' || !change.path || !['before', 'after'].every(field => change[field] === null || typeof change[field] === 'string')
        || bytes(change.before) > 512 * 1024 || bytes(change.after) > 512 * 1024) throw new Error('本轮原始修改记录无效，无法撤销。');
    const relative = change.path.replace(/\\/gu, '/'), identity = key(relative), previous = files.get(identity);
    if (previous && previous.after !== change.before) throw new Error(`文件 ${relative} 的修改记录不连续，无法安全撤销本轮。`);
    files.set(identity, { path: previous?.path ?? relative, before: previous ? previous.before : change.before, after: change.after });
  }
  return [...files.values()].filter(change => change.before !== change.after).reverse();
}

// Raw snapshots are process-local and are never serialized into session data.
export class TaskChangeUndo {
  #runs = new Map();
  record({ runId, sessionId, workspace, change }) {
    let entry = this.#runs.get(runId);
    if (!entry) { entry = { runId, sessionId, workspace, changes: [], bytes: 0, sealed: false, valid: true }; this.#runs.set(runId, entry); }
    if (!entry.valid || entry.sessionId !== sessionId || entry.workspace !== workspace || entry.sealed) return;
    entry.bytes += bytes(change.before) + bytes(change.after);
    if (entry.bytes > MAX_RUN_BYTES || entry.changes.length >= MAX_CHANGES) { entry.valid = false; entry.changes = []; entry.bytes = 0; return; }
    entry.changes.push({ path: change.path, before: change.before, after: change.after });
    while (this.#runs.size > 32 || [...this.#runs.values()].reduce((sum, value) => sum + value.bytes, 0) > MAX_TOTAL_BYTES)
      this.#runs.delete(this.#runs.keys().next().value);
  }
  seal(runId) { const entry = this.#runs.get(runId); if (entry) entry.sealed = true; }
  changes(runId, sessionId, workspace) {
    const entry = this.#runs.get(runId);
    if (!entry?.valid || !entry.sealed || entry.sessionId !== sessionId || entry.workspace !== workspace) throw new Error('此轮没有可用的原始撤销记录；重启或切换会话后无法撤销历史修改。');
    taskUndoPlan(entry.changes);
    return entry.changes.map(change => ({ ...change }));
  }
  ids(sessionId, workspace) {
    return [...this.#runs.keys()].filter(id => { try { return taskUndoPlan(this.changes(id, sessionId, workspace)).length > 0; } catch { return false; } });
  }
  completed(runId, paths) {
    const entry = this.#runs.get(runId); if (!entry) return;
    const removed = new Set(paths.map(value => key(value.replace(/\\/gu, '/'))));
    entry.changes = entry.changes.filter(change => !removed.has(key(change.path.replace(/\\/gu, '/'))));
    entry.bytes = entry.changes.reduce((sum, change) => sum + bytes(change.before) + bytes(change.after), 0);
    if (!entry.changes.length) this.#runs.delete(runId);
  }
  clear() { this.#runs.clear(); }
}
