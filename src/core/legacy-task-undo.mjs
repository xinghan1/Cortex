import { safeRelativePath } from './approval-policy.cjs';
import { taskUndoPlan } from './task-change-undo.mjs';

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu;
const MAX_BYTES = 32 * 1024 * 1024;
const WRITES = new Set(['write_file', 'replace_in_file', 'undo_last_change']);
const REDACTED = /\[已隐藏(?:密钥| ChatGPT 凭据)\]/u;
const identity = value => value.replace(/\\/gu, '/').replace(/^(?:\.\/)+/u, '').toLowerCase();
const byteLength = value => typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0;
const validPath = value => typeof value === 'string' && safeRelativePath(value);
const validEdit = value => value && typeof value === 'object' && validPath(value.path)
  && ['before', 'after'].every(field => value[field] === null || typeof value[field] === 'string'
    && !value[field].includes('\0') && !REDACTED.test(value[field]) && byteLength(value[field]) <= 512 * 1024);
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : null; } catch { return null; } };

// Older archives have no commit counter. Only a complete, unambiguous set of
// successful file-tool results can prove their retained snapshots are complete.
function successfulCalls(session, record) {
  const messages = session.messages;
  const start = record.messageStartIndex, end = record.messageIndex;
  if (!Array.isArray(messages) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || end >= messages.length || messages[start]?.role !== 'user'
      || messages.slice(start + 1, end + 1).some(message => message?.role === 'user')
      || (Array.isArray(session.subagents) ? session.subagents : []).some(agent => agent?.parentRunId === record.runId)) return null;
  const calls = new Map(), results = new Map();
  for (let index = start; index <= end; index++) {
    const message = messages[index];
    if (message?.role === 'assistant') for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
      if (['spawn_agent', 'wait_agent', 'send_agent_message'].includes(call?.name)) return null;
      if (!WRITES.has(call?.name)) continue;
      if (typeof call.id !== 'string' || !call.id || calls.has(call.id)) return null;
      calls.set(call.id, call);
    }
    if (message?.role !== 'tool' || !calls.has(message.toolCallId)) continue;
    if (results.has(message.toolCallId)) return null;
    const body = parse(message.content);
    if (!body) {
      if (typeof message.content === 'string' && message.content.startsWith('错误：')) results.set(message.toolCallId, null);
      else return null;
    } else if (body.denied === true || !Object.hasOwn(body, 'path') && typeof body.message === 'string') results.set(message.toolCallId, null);
    else if (validPath(body.path) && (body.deleted === true || Number.isSafeInteger(body.bytes) && body.bytes >= 0 && body.bytes <= 512 * 1024))
      results.set(message.toolCallId, body.path);
    else return null;
  }
  if ([...calls.keys()].some(id => !results.has(id))) return null;
  return new Map([...results].filter(([, value]) => value !== null));
}

function legacyUndonePaths(session, runId, changes) {
  const plan = new Map(taskUndoPlan(changes).map(change => [identity(change.path), change]));
  const events = [...(Array.isArray(session.events) ? session.events : []),
    ...(Array.isArray(session.taskRuns) ? session.taskRuns.flatMap(run => Array.isArray(run.activityEvents) ? run.activityEvents : []) : [])];
  const starts = new Map();
  for (const event of events) if (event?.type === 'tool-start' && event.name === 'undo_run_changes'
      && UUID.test(event.runId) && event.args?.runId === runId) starts.set(event.runId, event);
  const undone = new Set();
  for (const event of events) {
    if (event?.type !== 'tool-result' || event.name !== 'undo_run_changes' || !starts.has(event.runId)) continue;
    const result = parse(event.result);
    if (!result || !Array.isArray(result.completed) || !['completed', 'partial', 'stopped', 'failed'].includes(result.status)) continue;
    for (const path of result.completed) {
      if (!validPath(path)) continue;
      const original = plan.get(identity(path));
      if (!original) continue;
      const evidence = (session.fileEdits || []).filter(edit => edit?.runId === event.runId && validEdit(edit) && identity(edit.path) === identity(path));
      if (evidence.length === 1 && evidence[0].before === original.after && evidence[0].after === original.before) undone.add(identity(path));
    }
  }
  return [...plan.values()].filter(change => undone.has(identity(change.path))).map(change => change.path);
}

// This is a one-time import of provable file-tool snapshots. Missing history or
// redacted source cannot be reconstructed, and never becomes an undo payload.
export function legacyTaskUndoRuns(session) {
  if (!session || !UUID.test(session.id) || typeof session.workspace !== 'string' || !session.workspace
      || session.temporary === true || session.demo === true || !Array.isArray(session.fileEdits)
      || session.fileEdits.length > 1024) return [];
  const records = new Map();
  for (const record of [...(Array.isArray(session.taskRuns) ? session.taskRuns : []),
    ...(Array.isArray(session.events) ? session.events.filter(event => event?.type === 'run-end') : [])]) {
    if (!record || !UUID.test(record.runId) || record.kind === 'undo' || record.demo === true
        || !['completed', 'failed', 'stopped'].includes(record.status)) continue;
    const previous = records.get(record.runId);
    if (previous && previous.fileChangeCount !== record.fileChangeCount) records.set(record.runId, null);
    else if (!records.has(record.runId) || previous !== null) records.set(record.runId, record);
  }
  const runs = []; let total = 0;
  for (const [runId, record] of records) {
    if (!record) continue;
    const snapshots = session.fileEdits.filter(edit => edit?.runId === runId);
    if (!snapshots.length || snapshots.some(edit => !validEdit(edit) || typeof edit.toolCallId !== 'string' || !edit.toolCallId)) continue;
    const unique = new Map(); let ambiguous = false;
    for (const edit of snapshots) {
      const previous = unique.get(edit.toolCallId);
      if (previous && (identity(previous.path) !== identity(edit.path) || previous.before !== edit.before || previous.after !== edit.after)) ambiguous = true;
      else unique.set(edit.toolCallId, edit);
    }
    if (ambiguous) continue;
    const changes = [...unique.values()].map(edit => ({ path: edit.path.replace(/\\/gu, '/'), before: edit.before, after: edit.after }));
    if (Object.hasOwn(record, 'fileChangeCount')) {
      if (!Number.isSafeInteger(record.fileChangeCount) || record.fileChangeCount !== changes.length) continue;
    } else {
      const calls = successfulCalls(session, record);
      if (!calls || calls.size !== unique.size || [...unique].some(([id, edit]) => identity(calls.get(id) || '') !== identity(edit.path))) continue;
    }
    let plan;
    try { plan = taskUndoPlan(changes); } catch { continue; }
    if (!plan.length) continue;
    const size = changes.reduce((sum, change) => sum + byteLength(change.before) + byteLength(change.after), 0);
    if (size > 8 * 1024 * 1024 || total + size > MAX_BYTES) continue;
    total += size;
    runs.push({ runId, changes, undonePaths: legacyUndonePaths(session, runId, changes) });
  }
  return runs;
}
