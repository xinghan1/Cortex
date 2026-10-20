'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createUsageAnalytics } = require('./usage-analytics.cjs');
const SESSION_FILE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.json$/iu;
const RUN_FIELDS = ['type', 'runId', 'kind', 'status', 'demo', 'startedAt', 'endedAt', 'elapsedMs', 'durationMs', 'timestamp'];
function metadata(value) {
  if (!value || typeof value.id !== 'string' || value.demo === true) return null;
  const run = item => Object.fromEntries(RUN_FIELDS.filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]));
  return {
    id: value.id, workspace: value.workspace, demo: value.demo === true, temporary: value.temporary === true,
    events: Array.isArray(value.events) ? value.events.filter(item => item && ['run-start', 'run-end'].includes(item.type)).map(run) : [],
    taskRuns: Array.isArray(value.taskRuns) ? value.taskRuns.filter(item => item && typeof item === 'object').map(run) : [],
  };
}
async function loadUsageAnalytics(store, liveSessions = []) {
  await store.usageQueue;
  const sessions = [];
  let skipped = 0;
  const directory = path.join(store.dir, 'sessions');
  let names = [];
  try { names = (await fs.readdir(directory)).filter(name => SESSION_FILE.test(name)); }
  catch (error) { if (error.code !== 'ENOENT') skipped++; }
  // Read a small batch at a time; conversation contents never leave this loader.
  for (let index = 0; index < names.length; index += 4) {
    await Promise.all(names.slice(index, index + 4).map(async name => {
      try {
        const file = path.join(directory, name), info = await fs.lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) { skipped++; return; }
        const value = JSON.parse(await fs.readFile(file, 'utf8'));
        if (value.id + '.json' !== name) { skipped++; return; }
        const clean = metadata(value);
        if (clean) sessions.push(clean);
      } catch { skipped++; }
    }));
  }
  for (const session of liveSessions) {
    const clean = metadata(session);
    if (clean) sessions.push(clean);
  }
  // Keep both disk history and live suffixes: live event buffers may be trimmed.
  // The analytics layer deduplicates runs without losing earlier closed tasks.
  const result = createUsageAnalytics({ records: store.usage?.records || [], sessions, since: store.usage?.since || null, error: store.usageError || null });
  if (skipped) result.durationWarning = '部分历史会话无法读取，最长任务用时仅覆盖可读取的记录。';
  if (store.usage?.legacyMigration?.skippedSessions) result.historyWarning = '部分旧会话未能迁入用量账本，缺失用量未计入。';
  return result;
}
module.exports = { loadUsageAnalytics };
