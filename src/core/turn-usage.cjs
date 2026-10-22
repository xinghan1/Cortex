const { aggregateSessionUsage } = require('./session-metrics.cjs');

const count = value => Number.isSafeInteger(value) && value >= 0;
const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200;
const counters = ['requests', 'reportedRequests', 'unreportedRequests', 'partialRequests'];
const lightFields = ['kind', 'status', 'demo', 'startedAt', 'endedAt', 'elapsedMs', 'messageStartIndex', 'messageIndex'];

function createTurnUsage(records = [], { unavailable = false } = {}) {
  const totals = aggregateSessionUsage(records);
  const known = !unavailable && totals.reportedRequests > 0
    && count(totals.inputTokens) && count(totals.outputTokens) && count(totals.inputTokens + totals.outputTokens);
  return {
    version: 1,
    inputTokens: known ? totals.inputTokens : null,
    outputTokens: known ? totals.outputTokens : null,
    totalTokens: known ? totals.inputTokens + totals.outputTokens : null,
    ...Object.fromEntries(counters.map(field => [field, totals[field]])),
    status: !known ? 'unavailable'
      : totals.unreportedRequests || totals.partialRequests || totals.historicalApproximate ? 'partial' : 'reported',
    ...(totals.historicalApproximate ? { historicalApproximate: true } : {}),
  };
}

function normalizeTurnUsage(value) {
  if (!value || value.version !== 1 || !counters.every(field => count(value[field]))
      || value.reportedRequests + value.unreportedRequests !== value.requests || value.partialRequests > value.requests) return null;
  const known = value.reportedRequests > 0 && count(value.inputTokens) && count(value.outputTokens)
    && count(value.totalTokens) && value.inputTokens + value.outputTokens === value.totalTokens;
  const status = !known ? 'unavailable'
    : value.unreportedRequests || value.partialRequests || value.historicalApproximate === true ? 'partial' : 'reported';
  if (value.status !== status || (!known && [value.inputTokens, value.outputTokens, value.totalTokens].some(item => item !== null))) return null;
  return { version: 1, inputTokens: value.inputTokens, outputTokens: value.outputTokens, totalTokens: value.totalTokens,
    ...Object.fromEntries(counters.map(field => [field, value[field]])), status,
    ...(value.historicalApproximate === true ? { historicalApproximate: true } : {}) };
}

function compactTurnRecord(record) {
  if (!record || !identifier(record.runId) || record.kind && record.kind !== 'agent') return null;
  const result = { type: 'run-end', runId: record.runId, kind: 'agent' };
  for (const field of lightFields) {
    const value = record[field];
    if ((['startedAt', 'endedAt', 'elapsedMs', 'messageStartIndex', 'messageIndex'].includes(field) && count(value))
        || (field === 'status' && ['completed', 'failed', 'stopped'].includes(value))
        || (field === 'demo' && value === true)) result[field] = value;
  }
  return result;
}

// Only the explicit session/run pair is a ledger lineage. A fork stores the
// inherited summaries before changing its session ID; it never consults another
// session's later requests or copies those requests into the billing ledger.
function sessionTaskRuns(session, records = [], { unavailable = false } = {}) {
  if (!session) return [];
  const snapshots = new Map();
  for (const value of Array.isArray(session.turnUsage) ? session.turnUsage : []) {
    const compact = compactTurnRecord(value), usage = normalizeTurnUsage(value?.usage);
    if (compact && usage) snapshots.set(value.runId, { ...compact, usage,
      ...(identifier(value.sourceSessionId) ? { sourceSessionId: value.sourceSessionId } : {}) });
  }
  const runs = new Map([...snapshots].map(([id, value]) => {
    const { sourceSessionId, ...record } = value;
    return [id, record];
  }));
  for (const value of [...(Array.isArray(session.events) ? session.events.filter(event => event?.type === 'run-end') : []),
    ...(Array.isArray(session.taskRuns) ? session.taskRuns : [])]) {
    if (value && identifier(value.runId)) runs.set(value.runId, { ...runs.get(value.runId), ...value });
  }
  const byRun = new Map();
  for (const record of records) {
    if (record.sessionId !== session.id || !identifier(record.runId)) continue;
    if (!byRun.has(record.runId)) byRun.set(record.runId, []);
    byRun.get(record.runId).push(record);
  }
  return [...runs.values()].map(record => {
    if (record.kind && record.kind !== 'agent') return { ...record };
    const snapshot = snapshots.get(record.runId), ownRecords = byRun.get(record.runId) || [];
    const inherited = snapshot?.sourceSessionId && snapshot.sourceSessionId !== session.id;
    // A finalized summary also survives an individual ledger write failure.
    // It describes only that completed turn and never changes billing totals.
    const usage = inherited ? snapshot.usage : normalizeTurnUsage(record.usage) || snapshot?.usage
      || createTurnUsage(ownRecords, { unavailable });
    return { ...record, usage };
  });
}

function snapshotTurnUsage(session, records, options) {
  const previous = new Map((Array.isArray(session?.turnUsage) ? session.turnUsage : []).map(value => [value?.runId, value]));
  return sessionTaskRuns(session, records, options).flatMap(record => {
    const compact = compactTurnRecord(record);
    if (!compact) return [];
    const source = previous.get(record.runId)?.sourceSessionId;
    return [{ ...compact, sourceSessionId: identifier(source) ? source : session.id,
      usage: record.usage }];
  });
}

module.exports = { createTurnUsage, normalizeTurnUsage, sessionTaskRuns, snapshotTurnUsage };
