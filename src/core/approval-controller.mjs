import { randomUUID } from 'node:crypto';

const requestFields = ['kind', 'title', 'detail', 'path', 'before', 'after', 'command', 'url', 'selector', 'action', 'local', 'text', 'agentId', 'agentName', 'timeout_ms', 'complete', 'detailsComplete', 'contextComplete', 'truncated', 'incomplete'];
const copyRequest = request => Object.fromEntries(requestFields.filter(key => Object.hasOwn(request || {}, key)
  && (request[key] === null || ['string', 'number', 'boolean'].includes(typeof request[key]))).map(key => [key, request[key]]));
const notifyDecision = (callback, outcome) => {
  if (typeof callback !== 'function') return;
  try { Promise.resolve(callback(Object.freeze(outcome))).catch(() => {}); } catch {}
};

// A pending value remains a callable done(bool) for existing shutdown code.
// Cancellation/generations and model promises never enter its public snapshot.
export function createApprovalController({ pending, getMode, decide, review, emit, redact = value => value, idFactory = randomUUID }) {
  if (!(pending instanceof Map) || [getMode, decide, review, emit, redact, idFactory].some(value => typeof value !== 'function')) throw new Error('审批控制器参数无效。');
  const entries = new Map(), reviews = new Map();
  const publicText = (value, maximum = 500) => {
    try { const clean = redact(String(value ?? '')); return typeof clean === 'string' ? clean.slice(0, maximum) : '审批信息不可用。'; }
    catch { return '审批信息不可用。'; }
  };
  const alive = entry => !entry.settled && entries.get(entry.id) === entry && pending.get(entry.id) === entry.done;
  const metadata = entry => ({ id: entry.id, runId: entry.runId, workspaceId: entry.workspaceId });
  const snapshot = (entry, extra = {}) => {
    const clean = {};
    for (const [key, value] of Object.entries(entry.request)) clean[key] = typeof value === 'string' ? publicText(value, Math.max(500, value.length + 1000)) : value;
    return { ...clean, ...metadata(entry), ...extra };
  };
  const send = (type, entry, extra = {}) => emit({ ...snapshot(entry), ...extra, type });
  const invalidate = (entry, reason = '') => {
    if (entry.stage === 'reviewing' && reason) send('approval-review', entry, { status: 'cancelled', reviewStatus: 'cancelled', reason: publicText(reason) });
    entry.generation++;
    entry.stage = 'routing';
    entry.reviewReason = null;
    const controller = entry.controller; entry.controller = null;
    controller?.abort();
  };
  const manual = entry => {
    if (!alive(entry)) return;
    entry.stage = 'manual';
    entry.done.request = snapshot(entry, { type: 'approval-request', reviewStatus: 'manual' });
    emit(entry.done.request);
  };
  const denyReview = (entry, reason) => {
    entry.stage = 'denied'; entry.reviewReason = publicText(reason);
    send('approval-review', entry, { status: 'denied', reviewStatus: 'denied', reason: entry.reviewReason }); entry.done(false);
  };
  function route(entry) {
    if (!alive(entry)) return;
    if (entry.signals.some(signal => signal.aborted)) { entry.done(false); return; }
    const mode = getMode();
    let decision;
    try { decision = decide(mode, entry.request); } catch { decision = 'ask'; }
    if (decision === 'allow') {
      send('approval-auto', entry, { permissionMode: mode }); entry.done(true); return;
    }
    if (mode !== 'assist') { manual(entry); return; }
    const generation = entry.generation, controller = new AbortController();
    entry.controller = controller; entry.stage = 'reviewing';
    entry.done.request = snapshot(entry, { type: 'approval-request', reviewStatus: 'reviewing' });
    send('approval-review', entry, { status: 'reviewing', reviewStatus: 'reviewing' });
    // Register before starting the microtask so drain also sees synchronous
    // review failures and requests cancelled before their first await.
    const task = Promise.resolve().then(() => {
      if (!alive(entry) || entry.generation !== generation || controller.signal.aborted) return null;
      return review({ ...entry.request }, { signal: controller.signal, runId: entry.runId, workspaceId: entry.workspaceId });
    }).then(result => {
      if (!alive(entry) || entry.generation !== generation || controller.signal.aborted) return;
      if (entry.signals.some(signal => signal.aborted)) { entry.done(false); return; }
      const reason = publicText(result?.reason || 'AI 审批未返回有效结论，本次操作已拒绝。');
      if (result?.decision === 'allow' && typeof result.reason === 'string' && result.reason.trim() && result.reason.length <= 500) {
        entry.stage = 'allowed'; entry.reviewReason = reason;
        send('approval-review', entry, { status: 'allowed', reviewStatus: 'allowed', reason });
        send('approval-auto', entry, { permissionMode: 'assist', reviewed: true, reviewReason: reason }); entry.done(true);
      } else denyReview(entry, reason);
    }, () => {
      if (!alive(entry) || entry.generation !== generation || controller.signal.aborted) return;
      denyReview(entry, 'AI 审批失败，本次操作已拒绝。');
    }).finally(() => {
      const running = reviews.get(entry.runId);
      running?.delete(task); if (!running?.size) reviews.delete(entry.runId);
    });
    const running = reviews.get(entry.runId) || new Set(); running.add(task); reviews.set(entry.runId, running);
  }
  function approve(request, { signal, parentSignal, runId, workspaceId, onDecision } = {}) {
    const signals = [...new Set([signal, parentSignal].filter(Boolean))];
    if (signals.some(value => value.aborted)) {
      notifyDecision(onDecision, { approved: false, reviewReason: null, reviewStatus: 'cancelled' }); return Promise.resolve(false);
    }
    const id = idFactory();
    if (typeof id !== 'string' || !id || pending.has(id) || entries.has(id)) throw new Error('审批 ID 无效。');
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const entry = { id, request: copyRequest(request), runId, workspaceId, signals, generation: 0, controller: null, stage: 'routing', settled: false, done: null };
    const abort = () => entry.done(false);
    entry.done = approved => {
      if (!alive(entry)) return;
      const reviewed = ['allowed', 'denied'].includes(entry.stage);
      const reviewReason = entry.reviewReason;
      const reviewStatus = reviewed ? entry.stage : entry.stage === 'manual' ? 'manual' : approved === true ? 'auto' : 'cancelled';
      entry.settled = true; invalidate(entry, 'AI 审查已取消。');
      entries.delete(id); pending.delete(id);
      for (const value of signals) value.removeEventListener('abort', abort);
      notifyDecision(onDecision, { approved: approved === true, reviewReason: reviewed ? reviewReason : null, reviewStatus });
      send('approval-resolved', entry, { approved: approved === true, ...(reviewed ? { reviewed: true, reviewReason } : {}) });
      resolve(approved === true);
    };
    entry.done.request = snapshot(entry, { type: 'approval-request' });
    entries.set(id, entry); pending.set(id, entry.done);
    for (const value of signals) value.addEventListener('abort', abort, { once: true });
    route(entry);
    return promise;
  }
  return Object.freeze({
    approve,
    reconcile() {
      const current = [...entries.values()];
      // Invalidate the entire generation before emitting or rerouting any item.
      for (const entry of current) if (alive(entry)) invalidate(entry, '审批设置已变更，旧审查已取消。');
      for (const entry of current) if (alive(entry)) route(entry);
    },
    respond({ id, approved } = {}) {
      const entry = entries.get(id);
      if (typeof approved !== 'boolean' || !entry || !alive(entry) || entry.stage !== 'manual') return false;
      entry.done(approved); return true;
    },
    async drain(runId) {
      while (reviews.get(runId)?.size) await Promise.allSettled([...reviews.get(runId)]);
    },
  });
}
