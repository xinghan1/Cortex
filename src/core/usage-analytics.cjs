'use strict';

const path = require('node:path');

const DAY = 86_400_000;
const MAX_TASK_MS = 30 * DAY;
const MAX_TOKENS = BigInt(Number.MAX_SAFE_INTEGER);
const TIME_ZONE = 'Asia/Hong_Kong';
const DAY_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const TERMINAL = new Set(['completed', 'failed', 'stopped']);
const ISO_TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/;
const validTokens = value => Number.isSafeInteger(value) && value >= 0;
const timestamp = value => {
  if (typeof value === 'number') return Number.isFinite(new Date(value).getTime()) ? value : null;
  if (typeof value !== 'string' || !ISO_TIME.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const dateKey = time => {
  const parts = Object.fromEntries(DAY_FORMAT.formatToParts(new Date(time)).map(part => [part.type, part.value]));
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
};
const dayOrdinal = key => Date.parse(`${key}T00:00:00.000Z`) / DAY;
const ordinalKey = day => new Date(day * DAY).toISOString().slice(0, 10);
const totals = () => ({ inputTokens: 0n, outputTokens: 0n, requests: 0, unreportedRequests: 0, partialRequests: 0, historicalApproximate: false });
const safeNumber = value => value <= MAX_TOKENS ? Number(value) : null;

function publicTotals(value) {
  return {
    inputTokens: safeNumber(value.inputTokens), outputTokens: safeNumber(value.outputTokens),
    totalTokens: safeNumber(value.inputTokens + value.outputTokens), requests: value.requests,
    unreportedRequests: value.unreportedRequests, partialRequests: value.partialRequests,
    historicalApproximate: value.historicalApproximate,
  };
}

function addRecord(target, record, reported) {
  target.requests += 1;
  if (reported) {
    target.inputTokens += BigInt(record.inputTokens);
    target.outputTokens += BigInt(record.outputTokens);
  }
  // This deliberately matches the existing sidebar usageStats convention:
  // partial responses contain a known lower bound but not a complete total.
  if (!reported || record.partial === true) target.unreportedRequests += 1;
  if (record.partial === true) target.partialRequests += 1;
  if (record.historicalApproximate === true) target.historicalApproximate = true;
}

function workspaceKey(session) {
  const workspace = session.workspace;
  if (typeof workspace === 'string' && workspace) {
    if (/^[a-z]:[\\/]/i.test(workspace) || /^[\\/]{2}/.test(workspace)) {
      return `win:${path.win32.normalize(workspace.replace(/\//g, '\\')).replace(/[\\/]+$/, '').toLowerCase()}`;
    }
    return `path:${path.posix.normalize(workspace)}`;
  }
  return `session:${typeof session.id === 'string' ? session.id : ''}`;
}

function longestTask(sessions, now) {
  let longest = null;
  const captured = new Map();
  for (const session of Array.isArray(sessions) ? sessions : []) {
    if (!session || typeof session !== 'object' || session.demo === true) continue;
    const workspace = workspaceKey(session);
    const starts = new Map();
    const consider = (record, pairedStart, isEndEvent = false) => {
      if (!record || typeof record !== 'object' || record.demo === true || record.kind === 'undo') return;
      if (!TERMINAL.has(record.status) && !(isEndEvent && record.status === undefined)) return;
      const start = timestamp(record.startedAt) ?? pairedStart;
      const end = timestamp(record.endedAt);
      if ((start !== null && (start < 0 || start > now)) || (end !== null && (end < 0 || end > now))) return;
      if (start !== null && end !== null && (end < start || end - start > MAX_TASK_MS)) return;
      const elapsed = record.elapsedMs ?? record.durationMs ?? (start !== null && end !== null ? end - start : null);
      if (typeof elapsed !== 'number' || !Number.isFinite(elapsed) || elapsed < 0 || elapsed > MAX_TASK_MS) return;
      const runId = typeof record.runId === 'string' ? record.runId : typeof record.id === 'string' ? record.id : '';
      // A continued chat inherits taskRuns and events. The project/run/start
      // identity keeps those copies from being treated as distinct tasks.
      const key = JSON.stringify([workspace, runId, start, runId ? null : end, runId ? null : elapsed]);
      // Copies should agree. If a damaged fork disagrees, retain the smaller
      // captured duration so enumeration order cannot inflate the record.
      captured.set(key, Math.min(captured.get(key) ?? Infinity, Math.round(elapsed)));
    };
    for (const event of Array.isArray(session.events) ? session.events : []) {
      if (!event || typeof event !== 'object') continue;
      const runId = typeof event.runId === 'string' ? event.runId : typeof event.id === 'string' ? event.id : null;
      if (event.type === 'run-start') {
        if (runId !== null) starts.set(runId, timestamp(event.startedAt));
      } else if (event.type === 'run-end') {
        consider(event, runId === null ? null : starts.get(runId) ?? null, true);
        if (runId !== null) starts.delete(runId);
      }
    }
    for (const record of Array.isArray(session.taskRuns) ? session.taskRuns : []) consider(record, null);
  }
  for (const duration of captured.values()) longest = Math.max(longest ?? 0, duration);
  return longest;
}

/** Public, local-only analytics. No session content or provider metadata escapes. */
function createUsageAnalytics({ records = [], sessions = [], now = new Date(), since = null, error = null } = {}) {
  const current = new Date(now);
  const nowMs = current.getTime();
  if (!Number.isFinite(nowMs)) throw new Error('用量统计时间无效。');
  const sinceMs = timestamp(since);
  const result = {
    summary: {
      totalTokens: 0, inputTokens: 0, outputTokens: 0, peakDailyTokens: 0, longestTaskMs: null,
      longestStreak: 0, currentStreak: 0, activeDays: 0, requests: 0, unreportedRequests: 0, partialRequests: 0,
    },
    days: [], since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
    updatedAt: current.toISOString(), timeZone: TIME_ZONE, error: null,
    approximate: false, historicalApproximate: false, overflow: false,
  };
  if (error) {
    result.error = typeof error === 'string' ? error.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) : '本机用量数据暂时不可用。';
    for (const key of Object.keys(result.summary)) result.summary[key] = null;
    return result;
  }

  const daily = new Map();
  const all = totals();
  const seen = new Set();
  let earliest = null;
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== 'object') continue;
    const time = timestamp(record.timestamp);
    if (time === null || time > nowMs) continue;
    const id = typeof record.id === 'string' && record.id ? record.id.toLowerCase() : null;
    if (id !== null && seen.has(id)) continue;
    if (id !== null) seen.add(id);
    const day = dayOrdinal(dateKey(time));
    const target = daily.get(day) ?? totals();
    const reported = record.reported === true && validTokens(record.inputTokens) && validTokens(record.outputTokens);
    addRecord(target, record, reported); addRecord(all, record, reported);
    daily.set(day, target);
    earliest = Math.min(earliest ?? time, time);
  }

  const today = dayOrdinal(dateKey(nowMs));
  const first = today - 364;
  const active = new Set(daily.keys());
  let peak = 0n, cumulative = 0n, longestStreak = 0;
  for (const [day, value] of daily) {
    const total = value.inputTokens + value.outputTokens;
    if (total > peak) peak = total;
    if (day < first) cumulative += total;
    if (!active.has(day - 1)) {
      let length = 1;
      while (active.has(day + length)) length += 1;
      longestStreak = Math.max(longestStreak, length);
    }
  }
  let currentStreak = 0;
  let cursor = active.has(today) ? today : today - 1;
  while (active.has(cursor--)) currentStreak += 1;
  for (let day = first; day <= today; day++) {
    const value = daily.get(day) ?? totals();
    cumulative += value.inputTokens + value.outputTokens;
    result.days.push({ date: ordinalKey(day), ...publicTotals(value), cumulativeTokens: safeNumber(cumulative) });
  }
  const publicAll = publicTotals(all);
  result.summary = {
    totalTokens: publicAll.totalTokens, inputTokens: publicAll.inputTokens, outputTokens: publicAll.outputTokens,
    peakDailyTokens: safeNumber(peak), longestTaskMs: longestTask(sessions, nowMs),
    longestStreak, currentStreak, activeDays: active.size, requests: all.requests,
    unreportedRequests: all.unreportedRequests, partialRequests: all.partialRequests,
  };
  if (earliest !== null && (sinceMs === null || earliest < sinceMs)) result.since = new Date(earliest).toISOString();
  result.historicalApproximate = all.historicalApproximate;
  result.overflow = publicAll.totalTokens === null;
  result.approximate = all.historicalApproximate || all.unreportedRequests > 0 || result.overflow;
  return result;
}

module.exports = { createUsageAnalytics };
