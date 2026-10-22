/* Project the redacted, public chat archive into expandable task histories.
 * This helper never reads native provider state or evaluates tool arguments. */
(() => {
  'use strict';

  const messageFields = ['role', 'content', 'id', 'source', 'createdAt', 'attachments', 'toolCalls', 'localOnly'];
  const recordFields = ['runId', 'id', 'kind', 'demo', 'status', 'error', 'startedAt', 'endedAt', 'elapsedMs', 'durationMs', 'messageStartIndex', 'messageIndex', 'telemetry', 'finalTelemetry', 'fileChangeCount'];
  const usageFields = ['version', 'inputTokens', 'outputTokens', 'totalTokens', 'requests', 'reportedRequests', 'unreportedRequests', 'partialRequests', 'status', 'historicalApproximate'];
  const eventFields = ['type', 'runId', 'sequence', 'messageIndex', 'toolCallId', 'name', 'args', 'result', 'fileChange', 'text', 'id', 'kind', 'title', 'detail', 'path', 'before', 'after', 'command', 'url', 'selector', 'action', 'approved', 'status', 'reason', 'reviewReason', 'count', 'throughIndex', 'beforeChars', 'afterChars', 'budgetMode', 'contextLimit', 'contextLimitKind', 'triggerTokens', 'targetTokens', 'requestedTriggerTokens', 'effectiveTriggerTokens', 'triggerClamped', 'triggerClampReason', 'triggerFloorApplied', 'estimatedBeforeTokens', 'estimatedAfterTokens', 'compressionTriggerBasis', 'reportedContextTokens', 'estimatedGrowthTokens', 'triggerChars', 'targetChars'];
  const extraTypes = new Set(['command-output', 'approval-request', 'approval-auto', 'approval-resolved', 'context-compacted', 'subagent-update', 'approval-review', 'images-viewed']);
  const pick = (value, fields) => {
    const result = {};
    if (value && typeof value === 'object') for (const field of fields) if (Object.prototype.hasOwnProperty.call(value, field)) result[field] = value[field];
    return result;
  };
  const displayMessage = (message, index) => {
    const clean = pick(message, messageFields);
    if (Array.isArray(clean.toolCalls)) clean.toolCalls = clean.toolCalls.map(call => pick(call, ['id', 'name', 'arguments']));
    return { type: 'message', index, message: clean };
  };
  const displayRecord = record => {
    const clean = pick(record, recordFields);
    if (record.usage && typeof record.usage === 'object' && !Array.isArray(record.usage)) {
      clean.usage = {};
      for (const field of usageFields) {
        const value = record.usage[field];
        if (field === 'status') { if (['reported', 'partial', 'unavailable'].includes(value)) clean.usage[field] = value; }
        else if (field === 'historicalApproximate') { if (typeof value === 'boolean') clean.usage[field] = value; }
        else if (value === null || typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) clean.usage[field] = value;
      }
    }
    return clean;
  };
  const fileChange = value => value && typeof value.path === 'string' && value.path
    && ['before', 'after'].every(key => value[key] === null || typeof value[key] === 'string') ? pick(value, ['path', 'before', 'after']) : null;
  const agentFields = ['id', 'name', 'task', 'status', 'startedAt', 'endedAt', 'elapsedMs', 'summary', 'error', 'inputTokens', 'outputTokens'];
  const agentActivityTypes = new Set(['message', 'assistant-message', 'text', 'tool-start', 'tool-result', 'command-output', 'status', 'progress']);
  const privateAgentKeys = new Set(['providerstate', 'nativestate', 'reasoning', 'analysis', 'apikey', 'accesstoken', 'refreshtoken', 'authorization', 'credentials', 'credential', 'secret', 'headers', 'proto', 'constructor', 'prototype']);
  function publicAgentValue(value, depth = 0, seen = new WeakSet()) {
    if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') return value.slice(0, 20000);
    if (depth >= 6 || !value || typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) return value.slice(0, 100).map(item => publicAgentValue(item, depth + 1, seen) ?? null);
    const clean = Object.create(null);
    for (const [key, content] of Object.entries(value).slice(0, 100)) {
      if (privateAgentKeys.has(key.toLowerCase().replace(/[-_]/g, ''))) continue;
      const item = publicAgentValue(content, depth + 1, seen);
      if (item !== undefined) clean[key] = item;
    }
    return clean;
  }
  function publicAgent(value) {
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id) return null;
    const clean = {};
    for (const field of agentFields) {
      if (!Object.prototype.hasOwnProperty.call(value, field)) continue;
      if (['elapsedMs', 'inputTokens', 'outputTokens'].includes(field)) {
        if (typeof value[field] === 'number' && Number.isFinite(value[field]) && value[field] >= 0) clean[field] = value[field];
      } else if (typeof value[field] === 'string' || ['startedAt', 'endedAt'].includes(field) && typeof value[field] === 'number' && Number.isFinite(value[field])) clean[field] = typeof value[field] === 'string' ? value[field].slice(0, 16000) : value[field];
    }
    if (Array.isArray(value.activity)) clean.activity = value.activity.filter(item => item && typeof item === 'object' && agentActivityTypes.has(item.type)).slice(-100).map(item => {
      const activity = pick(item, ['type']);
      for (const field of ['name', 'toolCallId', 'text']) if (typeof item[field] === 'string') activity[field] = item[field].slice(0, 16000);
      for (const field of ['args', 'result']) if (Object.prototype.hasOwnProperty.call(item, field)) {
        const data = publicAgentValue(item[field]);
        if (data !== undefined) activity[field] = data;
      }
      return activity;
    });
    return clean;
  }
  const displayEvent = event => {
    const clean = pick(event, eventFields), change = fileChange(clean.fileChange);
    if (event.type === 'images-viewed') {
      clean.version = event.version;
      if (typeof event.requestId === 'string') clean.requestId = event.requestId;
      clean.images = (Array.isArray(event.images) ? event.images : []).slice(0, 64)
        .map(image => pick(image, ['messageId', 'attachmentIndex', 'attachmentId']));
    }
    if (change) clean.fileChange = change;
    else delete clean.fileChange;
    if (event.type === 'subagent-update') {
      const agent = publicAgent(event.agent);
      if (agent) clean.agent = agent;
    }
    return { type: 'event', event: clean };
  };
  const validIndex = (index, length) => Number.isInteger(index) && index >= 0 && index < length;
  const hasCalls = message => Array.isArray(message?.toolCalls) && message.toolCalls.length > 0;

  function recordsFor(session, supplied) {
    const records = Array.isArray(supplied) ? supplied : [
      ...(Array.isArray(session?.taskRuns) ? session.taskRuns : []),
      ...(Array.isArray(session?.events) ? session.events.filter(event => event?.type === 'run-end') : []),
    ];
    const seen = new Set();
    return records.filter(record => {
      // Manual undo/redo updates its original change card; it is not another
      // model task and should not reconstruct an empty timed task in history.
      if (!record || typeof record !== 'object' || record.kind === 'undo') return false;
      const key = record.runId || record.id || `${record.startedAt || ''}:${record.messageStartIndex}:${record.messageIndex}:${record.elapsedMs ?? record.durationMs}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function runItems(session, record, messages, finalIndex) {
    const start = record.messageStartIndex, end = record.messageIndex;
    const nodes = [], calls = [], pending = [], steeringIndices = new Map();
    const changes = new Map((Array.isArray(session.fileEdits) ? session.fileEdits : [])
      .filter(value => value?.runId === (record.runId || record.id) && typeof value.toolCallId === 'string' && fileChange(value))
      .map(value => [value.toolCallId, fileChange(value)]));
    let ordinal = 0;
    const add = (order, item) => nodes.push({ order, ordinal: ordinal++, item });
    const event = (value, index) => displayEvent({ ...value, runId: record.runId || record.id, messageIndex: index });
    const begin = (call, index) => {
      if (call.start) return;
      call.order = index * 10 - 3;
      call.start = event({ type: 'tool-start', name: call.name, args: call.args, toolCallId: call.id }, call.assistantIndex);
      add(call.order, call.start);
    };
    const flush = index => {
      for (const call of pending) if (!call.start) begin(call, index);
    };
    for (let index = start; index <= end; index++) {
      const message = messages[index];
      if (message?.role !== 'tool') flush(index);
      if (message?.role === 'assistant') {
        if (index !== finalIndex) add(index * 10, displayMessage(message, index));
        for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
          if (!call || typeof call !== 'object') continue;
          const value = { id: call.id, name: call.name || '工具调用', args: call.arguments, assistantIndex: index, resultIndex: null, start: null, matched: false };
          calls.push(value); pending.push(value);
        }
      } else if (index !== start && message?.role === 'user' && message.source === 'steering') {
        // Only consumed steering belongs inside its existing task. Its stored
        // message index is the boundary between earlier work and the next turn.
        add(index * 10, displayMessage(message, index));
        if (typeof message.id === 'string' && message.id) steeringIndices.set(message.id, steeringIndices.has(message.id) ? null : index);
      } else if (message?.role === 'tool') {
        const call = pending.find(value => value.resultIndex === null && value.id !== undefined && value.id === message.toolCallId);
        if (call) {
          begin(call, index);
          call.resultIndex = index;
          call.result = message.content;
          const completed = event({ type: 'tool-result', name: call.name, result: message.content, toolCallId: call.id,
            ...(changes.has(call.id) ? { fileChange: changes.get(call.id) } : {}) }, index);
          call.resultEvent = completed.event;
          add(index * 10 - 1, completed);
        } else {
          // An old/incomplete archive may have a result without its call. Keep
          // it inspectable instead of silently dropping the stored text.
          add(index * 10, event({ type: 'tool-result', name: '工具调用', result: message.content, toolCallId: message.toolCallId }, index));
        }
      }
    }
    flush(end + 1);

    // New runs may keep a bounded per-run log. Older archives retain only the
    // last 150 session events, so message records remain the source of truth
    // for tool inputs/results. Event-only demo tools and approval/output
    // details supplement them, without duplicating real calls.
    const events = [...(Array.isArray(record.activityEvents) ? record.activityEvents
      : (Array.isArray(session.events) ? session.events.filter(value => value?.runId && value.runId === (record.runId || record.id)) : []))];
    const imageRequests = new Set(events.filter(value => value?.type === 'images-viewed').map(value => value.requestId));
    for (const view of Array.isArray(session.imageViews) ? session.imageViews : []) {
      if (view?.type !== 'images-viewed' || view.runId !== (record.runId || record.id)
          || typeof view.requestId !== 'string' || imageRequests.has(view.requestId)) continue;
      imageRequests.add(view.requestId);
      events.push(view);
    }
    // Keep a child's latest public snapshot at its original position, while
    // retaining surrounding parent messages and tool events in their order.
    const agents = new Map();
    for (let index = 0; index < events.length; index++) {
      const value = events[index];
      if (value?.type !== 'subagent-update' || !publicAgent(value.agent)) continue;
      const previous = agents.get(value.agent.id);
      agents.set(value.agent.id, { first: previous?.first ?? index, agent: value.agent });
    }
    // The per-session archive survives bounded event retention. It supplements
    // an agent whose full event stream has already fallen out of that log.
    for (const agent of Array.isArray(session.subagents) ? session.subagents : []) {
      if (!publicAgent(agent) || agent.parentRunId !== (record.runId || record.id) || agents.has(agent.id)) continue;
      const index = events.length;
      events.push({ type: 'subagent-update', runId: record.runId || record.id, messageIndex: end, agent });
      agents.set(agent.id, { first: index, agent });
    }
    let currentCall = null, assistantCursor = start, anchor = start;
    const matchedResults = new Set();
    for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
      let value = events[eventIndex];
      if (!value || typeof value !== 'object') continue;
      if (value.type === 'user-message') {
        const index = value.source === 'steering' && (!value.runId || value.runId === (record.runId || record.id))
          ? steeringIndices.get(value.id) : null;
        if (Number.isInteger(index)) {
          // A lightweight consumed-steering receipt anchors event-only progress
          // without storing or displaying another copy of the user's message.
          anchor = index; assistantCursor = Math.max(assistantCursor, index + 1); currentCall = null;
        }
        continue;
      }
      if (value.type === 'subagent-update') {
        const agent = agents.get(value.agent?.id);
        if (!agent || agent.first !== eventIndex) continue;
        value = { ...value, agent: agent.agent };
      }
      if (value.type === 'assistant-message') {
        for (let index = assistantCursor; index <= end; index++) {
          if (messages[index]?.role === 'assistant' && messages[index].content === value.text) {
            anchor = index; assistantCursor = index + 1; break;
          }
        }
        continue;
      }
      const fractional = (eventIndex + 1) / (events.length + 1);
      if (value.type === 'tool-start') {
        currentCall = calls.find(call => !call.matched && (value.toolCallId ? call.id === value.toolCallId : call.name === value.name)) || null;
        if (currentCall) { currentCall.matched = true; continue; }
      } else if (value.type === 'tool-result') {
        const call = currentCall && (value.toolCallId ? currentCall.id === value.toolCallId : !value.name || currentCall.name === value.name) ? currentCall
          : calls.find(candidate => !matchedResults.has(candidate) && (value.toolCallId ? candidate.id === value.toolCallId
            : candidate.name === value.name && (candidate.matched || candidate.result === value.result)));
        currentCall = null;
        if (call?.resultIndex !== null && call?.resultIndex !== undefined) {
          const change = fileChange(value.fileChange);
          if (change && !call.resultEvent.fileChange) call.resultEvent.fileChange = change;
          call.matched = true; matchedResults.add(call); anchor = call.resultIndex; continue;
        }
      } else if (!extraTypes.has(value.type)) continue;

      if (currentCall && extraTypes.has(value.type)) {
        // Keep live command output and approvals inside the matching tool,
        // even when emit-time messageIndex still points at its assistant.
        add(currentCall.order + 1 + fractional, displayEvent(value));
      } else {
        const explicit = validIndex(value.messageIndex, messages.length) && value.messageIndex >= start && value.messageIndex <= end;
        let order = (explicit ? value.messageIndex : anchor) * 10 + 2 + fractional;
        if (value.type === 'context-compacted' && explicit) order = value.messageIndex * 10 - 4 + fractional;
        // Event-only tools/demo steps occur before the final answer.
        if (finalIndex !== null) order = Math.min(order, finalIndex * 10 - 0.5 + fractional / 4);
        add(order, displayEvent(value));
      }
    }
    return nodes.sort((left, right) => left.order - right.order || left.ordinal - right.ordinal);
  }

  function project(session = {}, historicalRecords) {
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const records = recordsFor(session, historicalRecords);
    const candidates = records.map((record, order) => ({ record, order,
      valid: validIndex(record.messageStartIndex, messages.length) && validIndex(record.messageIndex, messages.length)
        && record.messageStartIndex <= record.messageIndex && messages[record.messageStartIndex]?.role === 'user'
        && !messages.slice(record.messageStartIndex + 1, record.messageIndex + 1)
          .some(message => message?.role === 'user' && message.source !== 'steering') }));
    // Guessing which run owns overlapping anchors can hide or reorder user
    // messages. Keep both histories flat when old metadata is ambiguous.
    for (let left = 0; left < candidates.length; left++) for (let right = left + 1; right < candidates.length; right++) {
      const a = candidates[left], b = candidates[right];
      if (a.valid && b.valid && a.record.messageStartIndex <= b.record.messageIndex && b.record.messageStartIndex <= a.record.messageIndex) a.overlap = b.overlap = true;
    }
    const starts = new Map(), legacy = new Map();
    for (const candidate of candidates) {
      if (candidate.valid && !candidate.overlap) starts.set(candidate.record.messageStartIndex, candidate.record);
      else {
        const anchor = validIndex(candidate.record.messageIndex, messages.length) ? candidate.record.messageIndex : messages.length;
        const list = legacy.get(anchor) || []; list.push(candidate.record); legacy.set(anchor, list);
      }
    }
    const blocks = [];
    const standaloneSubagents = record => {
      const runId = record.runId || record.id;
      if (typeof runId !== 'string' || !runId) return [];
      const snapshots = new Map();
      const saved = Array.isArray(record.activityEvents) ? record.activityEvents
        : (Array.isArray(session.events) ? session.events.filter(value => value?.runId === runId) : []);
      const images = new Map();
      for (const value of [...saved, ...(Array.isArray(session.imageViews) ? session.imageViews : [])]) {
        if (value?.type === 'images-viewed' && value.runId === runId && typeof value.requestId === 'string')
          images.set(value.requestId, { ...value, runId });
      }
      for (const value of saved) if (value?.type === 'subagent-update' && publicAgent(value.agent)) snapshots.set(value.agent.id, { ...value, runId });
      for (const agent of Array.isArray(session.subagents) ? session.subagents : []) {
        if (agent?.parentRunId === runId && publicAgent(agent) && !snapshots.has(agent.id)) snapshots.set(agent.id, { type: 'subagent-update', runId, agent });
      }
      return [...images.values(), ...snapshots.values()].map(displayEvent);
    };
    const appendLegacy = index => {
      for (const record of legacy.get(index) || []) blocks.push({ type: 'run', record: displayRecord(record), items: standaloneSubagents(record), finalIndex: null, unanchored: true });
    };
    for (let index = 0; index < messages.length; index++) {
      const record = starts.get(index);
      if (!record) { blocks.push(displayMessage(messages[index], index)); appendLegacy(index); continue; }
      const end = record.messageIndex, last = messages[end];
      const finalIndex = last?.role === 'assistant' && !hasCalls(last) && last.localOnly !== true ? end : null;
      const items = runItems(session, record, messages, finalIndex).map(node => node.item);
      blocks.push(displayMessage(messages[index], index)); appendLegacy(index);
      blocks.push({ type: 'run', record: displayRecord(record), items, finalIndex });
      for (let cursor = index + 1; cursor <= end; cursor++) if (cursor !== finalIndex) appendLegacy(cursor);
      if (finalIndex !== null) { blocks.push(displayMessage(last, finalIndex)); appendLegacy(finalIndex); }
      index = end;
    }
    appendLegacy(messages.length);
    return blocks;
  }

  const api = Object.freeze({ project });
  if (typeof module === 'object' && module.exports) module.exports = api;
  globalThis.ForgeTaskHistory = api;
})();
