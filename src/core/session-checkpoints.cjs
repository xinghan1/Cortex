const { randomUUID } = require('node:crypto');

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
const toolIdentifier = value => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(value);
const partialMarker = '[本次响应因程序异常退出而未完成]';
const immediateEvents = new Set(['assistant-message', 'tool-start', 'tool-result', 'user-message', 'file-change-recorded',
  'context-compacted', 'approval-resolved', 'run-start', 'question-answer']);
const timestamp = (value, fallback) => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : value instanceof Date ? value.getTime() : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
const interruption = '程序异常退出，无法确认此操作的执行结果。请先核验实际状态，不可据此直接重跑。';
const metadataEvents = new Set(['user-message', 'run-start', 'assistant-message', 'tool-start', 'tool-result', 'file-change-recorded',
  'images-viewed', 'subagent-update', 'approval-request', 'approval-resolved', 'approval-review', 'agent-plan', 'context-compacted', 'reconnect', 'question-answer']);

/** A fixed-session, coalesced checkpoint writer. Provisional stream data is a
 * snapshot projection only: it never enters the active model transcript. */
class SessionCheckpoints {
  #session; #run; #ownerId; #save; #onError; #debounceMs; #maxIntervalMs;
  #dirty = false; #revision = 0; #pending = null; #timer = null; #deadline = null;
  #stream = ''; #commands = new Map(); #toolNames = new Map(); #lastTool = null;
  #final = false; #disposed = false; #barrierRequested = false; #maxDue = false; #temporary; #errorKey = ''; #errorAt = 0;
  constructor({ session, run, ownerId, save, onError = () => {}, debounceMs = 350, maxIntervalMs = 2000 } = {}) {
    if (!object(session) || !identifier(session.id) || !Array.isArray(session.messages) || !Array.isArray(session.events)
        || !object(run) || !identifier(run.id) || run.sessionId !== session.id || !identifier(ownerId)
        || typeof save !== 'function' || typeof onError !== 'function'
        || !Number.isSafeInteger(debounceMs) || debounceMs < 1
        || !Number.isSafeInteger(maxIntervalMs) || maxIntervalMs < 1) throw new Error('会话增量保存配置无效。');
    this.#session = session;
    this.#run = { id: run.id, sessionId: run.sessionId, startedAt: timestamp(run.startedAt, Date.now()),
      messageStartIndex: Number.isSafeInteger(run.messageStartIndex) && run.messageStartIndex >= 0 ? run.messageStartIndex : 0 };
    this.#ownerId = ownerId; this.#save = save; this.#onError = onError;
    this.#debounceMs = debounceMs; this.#maxIntervalMs = maxIntervalMs; this.#temporary = session.temporary === true;
  }
  get pending() { return this.#dirty || this.#pending !== null; }
  #clearTimers() { clearTimeout(this.#timer); clearTimeout(this.#deadline); this.#timer = null; this.#deadline = null; this.#maxDue = false; }
  #schedule() {
    if (this.#disposed || this.#final || this.#temporary || this.#session.temporary === true) return;
    clearTimeout(this.#timer);
    // Background writes do not drain an endlessly changing stream. Restart the
    // debounce after each completed write, retaining the original deadline for
    // bytes that arrived during I/O. If that deadline elapsed while blocked,
    // yield to a timer before the next capture instead of a promise write loop.
    this.#timer = setTimeout(() => { this.#timer = null; void this.#background().catch(() => {}); }, this.#maxDue ? 1 : this.#debounceMs);
    this.#timer.unref?.();
    if (!this.#deadline && !this.#maxDue) {
      this.#deadline = setTimeout(() => { this.#deadline = null; this.#maxDue = true; void this.#background().catch(() => {}); }, this.#maxIntervalMs);
      this.#deadline.unref?.();
    }
  }
  touch({ immediate = false } = {}) {
    if (this.#disposed || this.#temporary || this.#session.temporary === true) return;
    this.#dirty = true; this.#revision++;
    if (immediate) { this.#clearTimers(); void this.flush().catch(() => {}); }
    else this.#schedule();
  }
  observe(event) {
    if (this.#disposed || this.#final || this.#temporary || this.#session.temporary === true || !object(event)) return;
    if (event.runId && event.runId !== this.#run.id || event.sessionId && event.sessionId !== this.#run.sessionId) return;
    if (event.type === 'text-delta') {
      if (typeof event.text !== 'string') return;
      this.#stream = event.replace ? event.text : this.#stream + event.text;
    } else if (event.type === 'assistant-message') this.#stream = '';
    else if (event.type === 'reconnect' && event.resetText) this.#stream = '';
    else if (event.type === 'tool-start') {
      const id = toolIdentifier(event.toolCallId) ? event.toolCallId : identifier(event.name) ? event.name : null;
      if (id) { this.#lastTool = id; this.#toolNames.set(id, event.name); }
    } else if (event.type === 'tool-result') {
      const id = toolIdentifier(event.toolCallId) ? event.toolCallId : event.name;
      this.#commands.delete(id); this.#toolNames.delete(id); if (this.#lastTool === id) this.#lastTool = null;
    } else if (event.type === 'command-output') {
      if (typeof event.text !== 'string') return;
      const id = toolIdentifier(event.toolCallId) ? event.toolCallId : this.#lastTool;
      if (!id) return;
      const previous = this.#commands.get(id);
      // Match the existing live command-output bound. User/assistant messages
      // and committed tool results retain their entire original contents.
      const text = (event.replace ? event.text : (previous?.text || '') + event.text).slice(-256 * 1024);
      this.#commands.set(id, { ...structuredClone(event), type: 'command-output', runId: this.#run.id,
        toolCallId: id, text, replace: true });
    } else if (!metadataEvents.has(event.type)) return;
    this.touch({ immediate: immediateEvents.has(event.type) });
  }
  #snapshot() {
    if (this.#session.id !== this.#run.sessionId) throw new Error('运行中的会话标识已变化，未跨会话保存。');
    const snapshot = structuredClone(this.#session);
    if (this.#final) { delete snapshot.runCheckpoint; return snapshot; }
    if (this.#stream) snapshot.messages.push({ id: 'checkpoint-' + this.#run.id, role: 'assistant', content: this.#stream,
      toolCalls: [], localOnly: true, source: 'interrupted-stream', checkpointRunId: this.#run.id });
    for (const command of this.#commands.values()) snapshot.events.push(structuredClone(command));
    snapshot.runCheckpoint = { version: 1, runId: this.#run.id, ownerId: this.#ownerId, status: 'running',
      startedAt: this.#run.startedAt, messageStartIndex: this.#run.messageStartIndex, savedAt: new Date().toISOString() };
    return snapshot;
  }
  #report(error) {
    const key = String(error?.code || '') + ':' + String(error?.message || error), now = Date.now();
    if (key === this.#errorKey && now - this.#errorAt < 5000) return;
    this.#errorKey = key; this.#errorAt = now;
    try { this.#onError(error); } catch { /* Preserve the original storage failure. */ }
  }
  #background() {
    if (this.#temporary || this.#session.temporary === true || this.#disposed || !this.#dirty) return Promise.resolve(false);
    // An already active write owns the captured revision. A timer must neither
    // upgrade it to a barrier nor enqueue another snapshot behind it.
    return this.#pending || this.#write(false);
  }
  #write(barrier) {
    this.#barrierRequested = barrier;
    let completed = false;
    // Deferring the body also makes a synchronous injected save callback unable
    // to reenter flush before the shared in-flight promise has been installed.
    const operation = Promise.resolve().then(async () => {
      while (this.#dirty && !this.#disposed) {
        this.#clearTimers(); const revision = this.#revision; this.#dirty = false;
        try { const snapshot = this.#snapshot(); await this.#save(snapshot); this.#errorKey = ''; this.#errorAt = 0; }
        catch (error) { this.#dirty = true; this.#report(error); throw error; }
        if (revision !== this.#revision) this.#dirty = true;
        if (!this.#barrierRequested) break;
      }
      completed = true;
      return true;
    });
    this.#pending = operation.finally(() => {
      this.#pending = null;
      const schedule = completed && !this.#barrierRequested && this.#dirty;
      this.#barrierRequested = false;
      if (schedule) this.#schedule();
    });
    return this.#pending;
  }
  flush() {
    if (this.#temporary || this.#session.temporary === true) { this.#clearTimers(); this.#dirty = false; return Promise.resolve(false); }
    if (this.#pending) {
      this.#barrierRequested = true; this.#clearTimers();
      // A background promise may already have left its body when the caller
      // arrives. Check the latest dirty revision after its finally, rather than
      // assuming sharing that promise alone makes this call a write barrier.
      return this.#pending.then(() => this.#dirty && !this.#disposed ? this.flush() : true);
    }
    if (this.#disposed || !this.#dirty) return Promise.resolve(false);
    this.#clearTimers();
    return this.#write(true);
  }
  finish() {
    if (this.#disposed || this.#temporary || this.#session.temporary === true) { this.#clearTimers(); return Promise.resolve(false); }
    this.#final = true; this.#stream = ''; this.#commands.clear(); this.#toolNames.clear(); this.#lastTool = null;
    this.#dirty = true; this.#revision++; this.#clearTimers();
    const pending = this.#pending;
    // A failed older running write must not prevent the final snapshot from
    // getting its own attempt. Its error has already reached onError/flush.
    return pending ? pending.catch(() => {}).then(() => this.#dirty ? this.flush() : true) : this.flush();
  }
  dispose() { this.#disposed = true; this.#clearTimers(); this.#stream = ''; this.#commands.clear(); }
}

/** Called only when loading a checkpoint owned by an earlier process. This
 * never resumes a model, approval or tool and never claims an unknown result. */
function recoverInterruptedSession(session, { ownerId, now = Date.now() } = {}) {
  const checkpoint = session?.runCheckpoint;
  if (!object(session) || !object(checkpoint) || checkpoint.version !== 1 || checkpoint.status !== 'running'
      || checkpoint.ownerId === ownerId || !identifier(ownerId) || !identifier(checkpoint.ownerId)
      || !identifier(checkpoint.runId) || !Array.isArray(session.messages) || !Array.isArray(session.events)) return false;
  const runId = checkpoint.runId, startIndex = Number.isSafeInteger(checkpoint.messageStartIndex)
    ? Math.max(0, Math.min(session.messages.length, checkpoint.messageStartIndex)) : 0;
  const rebuilt = [], missing = new Map();
  for (let index = 0; index < session.messages.length; index++) {
    const message = session.messages[index];
    if (message?.role === 'assistant' && message.localOnly === true && message.checkpointRunId === runId
        && message.providerState === undefined && Array.isArray(message.toolCalls) && message.toolCalls.length === 0
        && typeof message.content === 'string' && !message.content.includes(partialMarker)) message.content += '\n\n' + partialMarker;
    rebuilt.push(message);
    if (index < startIndex || message?.role !== 'assistant' || !Array.isArray(message.toolCalls) || !message.toolCalls.length) continue;
    const returned = new Set();
    while (session.messages[index + 1]?.role === 'tool') {
      const result = session.messages[++index]; rebuilt.push(result); returned.add(result.toolCallId);
    }
    for (const call of message.toolCalls) {
      if (!toolIdentifier(call?.id) || returned.has(call.id)) continue;
      returned.add(call.id); missing.set(call.id, call.name || 'unknown_tool');
      rebuilt.push({ id: randomUUID(), role: 'tool', toolCallId: call.id, content: interruption, interrupted: true, recoveredRunId: runId });
    }
  }
  session.messages = rebuilt;
  const completed = new Set(session.events.filter(event => event?.type === 'tool-result' && event.runId === runId).map(event => event.toolCallId));
  const started = new Map(missing);
  for (const event of session.events) if (event?.runId === runId && ['tool-start', 'command-output'].includes(event.type) && toolIdentifier(event.toolCallId))
    started.set(event.toolCallId, event.name || started.get(event.toolCallId) || 'official_agent_tool');
  for (const [toolCallId, name] of started) if (!completed.has(toolCallId)) session.events.push({ type: 'tool-result', runId,
    toolCallId, name, interrupted: true, result: JSON.stringify({ status: 'stopped', output: interruption }) });
  const recoveredAt = timestamp(now, Date.now());
  // Recovery time is not execution time. A machine can remain off for days;
  // count only through the last checkpoint that observed the running task.
  const endedAt = timestamp(checkpoint.savedAt, timestamp(checkpoint.startedAt, recoveredAt));
  const startedAt = Math.min(timestamp(checkpoint.startedAt, endedAt), endedAt);
  const previous = (Array.isArray(session.taskRuns) ? session.taskRuns : []).find(record => record?.runId === runId)
    || session.events.find(event => event?.type === 'run-end' && event.runId === runId) || {};
  const end = { ...previous, type: 'run-end', runId, kind: 'agent', status: 'stopped', interrupted: true,
    error: '程序异常退出，本轮任务已停止。已恢复最近保存的会话内容；未确认的操作结果请先核验。',
    startedAt, endedAt, recoveredAt, elapsedMs: Math.max(0, endedAt - startedAt), messageStartIndex: startIndex,
    messageIndex: Math.max(0, session.messages.length - 1) };
  session.events = session.events.filter(event => !(event?.type === 'run-end' && event.runId === runId));
  session.events.push(end);
  session.taskRuns = [...(Array.isArray(session.taskRuns) ? session.taskRuns.filter(record => record?.runId !== runId) : []), { ...end }];
  if (Array.isArray(session.subagents)) for (const agent of session.subagents)
    if (agent?.parentRunId === runId && ['running', 'queued', 'pending', 'waiting'].includes(agent.status)) {
      agent.status = 'stopped'; agent.error = '主程序异常退出，子任务已停止；实际执行结果请先核验。';
    }
  delete session.runCheckpoint;
  return true;
}

module.exports = { SessionCheckpoints, recoverInterruptedSession };
