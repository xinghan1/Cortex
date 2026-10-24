const validTokens = value => Number.isSafeInteger(value) && value >= 0;
const fields = ['requests', 'reportedRequests', 'unreportedRequests', 'partialRequests', 'inputTokens',
  'outputTokens', 'cachedInputTokens', 'cacheInputTokens', 'cacheReportedRequests'];
const emptyUsage = () => Object.fromEntries(fields.map(field => [field, 0]));

function aggregateSessionUsage(records, baseline) {
  const result = { ...emptyUsage(), historicalApproximate: false };
  if (baseline && fields.every(field => validTokens(baseline[field]))) {
    for (const field of fields) result[field] = baseline[field];
    result.historicalApproximate = baseline.historicalApproximate === true;
  }
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record.id)) continue;
    ids.add(record.id);
    result.requests++;
    result.historicalApproximate ||= record.historicalApproximate === true;
    if (record.partial) result.partialRequests++;
    if (record.reported && validTokens(record.inputTokens) && validTokens(record.outputTokens)) {
      result.reportedRequests++;
      result.inputTokens += record.inputTokens;
      result.outputTokens += record.outputTokens;
      if (validTokens(record.cachedInputTokens) && record.cachedInputTokens <= record.inputTokens) {
        result.cachedInputTokens += record.cachedInputTokens;
        result.cacheInputTokens += record.inputTokens;
        result.cacheReportedRequests++;
      }
    } else result.unreportedRequests++;
  }
  return result;
}

function contextMatches(context, expected) {
  return !expected || (expected.provider === context.provider && expected.model === context.model
    && expected.connectionKey === context.connectionKey);
}

function projectCurrentCapacity(context, expected) {
  if (!context || !expected || !Object.hasOwn(expected, 'limit') || !contextMatches(context, expected)) return context;
  return { ...context, limit: validTokens(expected.limit) && expected.limit > 0 ? expected.limit : null,
    ...(Object.hasOwn(expected, 'limitKind') ? { limitKind: expected.limitKind === 'input' ? 'input' : 'total' } : {}) };
}

function reportedContext(context) {
  if (!context || context.version !== 2 || context.status !== 'reported' || context.phase !== 'complete'
      || !validTokens(context.inputTokens)) return null;
  const inputOnly = context.limitKind === 'input';
  if (!inputOnly && !validTokens(context.outputTokens)) return null;
  const usedTokens = inputOnly ? context.inputTokens : context.inputTokens + context.outputTokens;
  if (!validTokens(usedTokens)) return null;
  const { lastReported, ...flat } = context;
  return { ...flat, usedTokens };
}

function publicContextReport(report) {
  if (!report) return null;
  const limit = validTokens(report.limit) && report.limit > 0 ? report.limit : null;
  return {
    inputTokens: report.inputTokens, outputTokens: validTokens(report.outputTokens) ? report.outputTokens : null,
    usedTokens: report.usedTokens, limit, limitKind: report.limitKind === 'input' ? 'input' : 'total',
    percent: limit ? Math.round(report.usedTokens / limit * 1000) / 10 : null,
    provider: typeof report.provider === 'string' ? report.provider : null,
    model: typeof report.model === 'string' ? report.model : null,
    measuredAt: typeof report.measuredAt === 'string' ? report.measuredAt : null,
  };
}

// Stored counts describe one dispatched request's input. Validate that anchor
// before allocating an actual report or exposing a local estimate. Inherited
// counts from an invalidated request must never describe newly changed content.
function requestBreakdown(context) {
  const value = context?.breakdown;
  if (context?.version !== 2 || typeof context.requestId !== 'string' || !context.requestId
      || value?.version !== 1 || value.requestId !== context.requestId || value.source !== 'estimated-local'
      || !['requesting', 'complete', 'failed', 'stopped'].includes(context.phase)
      || !['systemTokens', 'toolTokens', 'messageTokens', 'totalTokens'].every(key => validTokens(value[key]))
      || !validTokens(value.systemTokens + value.toolTokens + value.messageTokens)
      || value.systemTokens + value.toolTokens + value.messageTokens !== value.totalTokens
      || typeof value.hasUnknownAttachmentCost !== 'boolean'
      || (value.estimatedOutputTokens !== undefined && !validTokens(value.estimatedOutputTokens))) return null;
  return value;
}

function publicContextBreakdown(context, displaySource, measured = false) {
  const value = requestBreakdown(context);
  if (!value) return null;
  let systemTokens = value.systemTokens, toolTokens = value.toolTokens, messageTokens = value.messageTokens;
  if (measured) {
    // These are approximate proportions calibrated to the real input total,
    // not three invented server counters. Assign integer rounding to messages.
    systemTokens = value.totalTokens ? Math.floor(context.inputTokens * (value.systemTokens / value.totalTokens)) : 0;
    toolTokens = value.totalTokens ? Math.min(context.inputTokens - systemTokens,
      Math.floor(context.inputTokens * (value.toolTokens / value.totalTokens))) : 0;
    messageTokens = context.inputTokens - systemTokens - toolTokens;
  }
  const outputTokens = context.limitKind === 'input' ? 0 : validTokens(context.outputTokens)
    ? context.outputTokens : value.estimatedOutputTokens ?? 0;
  messageTokens += outputTokens;
  const totalTokens = systemTokens + toolTokens + messageTokens;
  if (!validTokens(totalTokens)) return null;
  return { systemTokens, toolTokens, messageTokens, totalTokens,
    source: measured ? 'estimated-allocation' : 'estimated-local', displaySource,
    hasUnknownAttachmentCost: value.hasUnknownAttachmentCost };
}

function estimatedContextReport(context, breakdown) {
  const limit = validTokens(context.limit) && context.limit > 0 ? context.limit : null;
  return { usedTokens: breakdown.totalTokens, inputTokens: null, outputTokens: null, limit,
    limitKind: context.limitKind === 'input' ? 'input' : 'total',
    percent: limit ? Math.round(breakdown.totalTokens / limit * 1000) / 10 : null,
    provider: typeof context.provider === 'string' ? context.provider : null,
    model: typeof context.model === 'string' ? context.model : null,
    measuredAt: typeof context.measuredAt === 'string' ? context.measuredAt : null };
}

function makePendingContextUsage(previous = {}, overrides = {}) {
  const { lastReported, breakdown, ...flat } = previous;
  const last = reportedContext(previous) || reportedContext(lastReported);
  return { ...flat, ...overrides, version: 2, status: 'pending', phase: 'changed',
    usedTokens: null, inputTokens: null, outputTokens: null, measuredAt: null, requestId: null,
    ...(last ? { lastReported: last } : {}) };
}

function createSessionMetrics(session, usage, { unavailable = false, expectedContext } = {}) {
  const context = projectCurrentCapacity(session?.contextUsage || {}, expectedContext);
  const stale = !contextMatches(context, expectedContext);
  const actual = !stale && reportedContext(context);
  const contextInputTokens = !stale && context.version === 2 && validTokens(context.inputTokens) ? context.inputTokens : null;
  const contextOutputTokens = !stale && context.version === 2 && validTokens(context.outputTokens) ? context.outputTokens : null;
  const contextLimit = !stale && validTokens(context.limit) && context.limit > 0 ? context.limit : null;
  const contextStatus = stale ? 'unknown' : actual ? 'reported' : context.version === 2 && context.status === 'pending' ? 'pending'
    : context.version === 2 && (context.status === 'partial' || contextInputTokens !== null || contextOutputTokens !== null) ? 'partial' : 'unknown';
  const contextUsedTokens = actual ? actual.usedTokens : null;
  const previous = reportedContext(projectCurrentCapacity(context.lastReported, expectedContext));
  const compatiblePrevious = previous && contextMatches(previous, expectedContext) ? previous : null;
  const contextLastReported = publicContextReport(compatiblePrevious);
  // Display the latest compatible complete report while a changed request is
  // unmeasured. This is a labelled historical sample, never a current budget,
  // streaming approximation, or replacement for the strict fields above.
  const displaySource = actual ? 'current' : contextLastReported ? 'last-reported' : 'estimated';
  const contextBreakdown = actual ? publicContextBreakdown(actual, 'current', true)
    : compatiblePrevious ? publicContextBreakdown(compatiblePrevious, 'last-reported', true)
    : !stale ? publicContextBreakdown(context, 'estimated') : null;
  const displayReport = actual ? publicContextReport(actual) : contextLastReported
    || (contextBreakdown ? estimatedContextReport(context, contextBreakdown) : null);
  const contextDisplay = {
    source: displayReport ? displaySource : 'none',
    pending: !actual && (Boolean(displayReport) || ['pending', 'partial'].includes(contextStatus)),
    ...(displayReport || { usedTokens: null, inputTokens: null, outputTokens: null, limit: null, percent: null,
      provider: null, model: null, measuredAt: null, limitKind: null }),
  };
  const usageStatus = unavailable ? 'unavailable'
    : usage.unreportedRequests || usage.partialRequests || usage.historicalApproximate ? 'partial' : 'reported';
  const cacheStatus = unavailable || !usage.cacheReportedRequests ? 'unavailable'
    : usage.cacheReportedRequests === usage.requests && !usage.partialRequests && !usage.historicalApproximate ? 'reported' : 'partial';
  return {
    rounds: session?.demo ? 0 : (session?.messages || []).filter(message => message.role === 'user').length,
    steps: validTokens(session?.toolSteps) ? session.toolSteps : (session?.events || []).filter(event => event.type === 'tool-start').length,
    inputTokens: unavailable ? null : usage.inputTokens,
    outputTokens: unavailable ? null : usage.outputTokens,
    totalTokens: unavailable ? null : usage.inputTokens + usage.outputTokens,
    cachedInputTokens: cacheStatus === 'unavailable' ? null : usage.cachedInputTokens,
    cacheInputTokens: cacheStatus === 'unavailable' ? null : usage.cacheInputTokens,
    cacheHitPercent: cacheStatus !== 'unavailable' && usage.cacheInputTokens > 0
      ? Math.round(usage.cachedInputTokens / usage.cacheInputTokens * 1000) / 10 : null,
    cacheCoveragePercent: usage.inputTokens > 0 ? Math.round(usage.cacheInputTokens / usage.inputTokens * 1000) / 10 : null,
    usageStatus, cacheStatus,
    contextUsedTokens, contextLimit, contextStatus, contextInputTokens, contextOutputTokens,
    contextPhase: !stale && typeof context.phase === 'string' ? context.phase : null,
    contextMeasuredAt: actual && typeof context.measuredAt === 'string' ? context.measuredAt : null,
    contextRequestId: !stale && typeof context.requestId === 'string' ? context.requestId : null,
    contextLastReported, contextDisplay, contextBreakdown,
    contextRequestedTriggerTokens: !stale && validTokens(context.requestedTriggerTokens) ? context.requestedTriggerTokens : null,
    contextEffectiveTriggerTokens: !stale && validTokens(context.effectiveTriggerTokens) ? context.effectiveTriggerTokens : null,
    contextTriggerClamped: !stale && context.triggerClamped === true,
    contextTriggerClampReason: !stale && ['model-capacity', 'unknown-capacity', 'necessary-context'].includes(context.triggerClampReason) ? context.triggerClampReason : null,
    contextTriggerFloorApplied: !stale && context.triggerFloorApplied === true,
    contextLimitKind: context.limitKind === 'input' ? 'input' : 'total',
    contextPercent: !actual || !contextLimit ? null : Math.round(contextUsedTokens / contextLimit * 1000) / 10,
    contextModel: !stale && typeof context.model === 'string' ? context.model : null,
    contextDescription: stale ? '当前模型或连接尚无实测数据，等待服务端回报。'
      : contextStatus === 'pending' ? '当前内容尚未完整测量，等待服务端回报；新增消息和工具结果不使用旧统计充当实测值。'
      : contextStatus === 'partial' ? '服务端尚未完整回报本次 Token 用量，当前上下文占用待确认。'
      : !actual ? '尚无完整的服务端实测数据；字符估算不作为实测值。'
      : `最近完成请求的服务端实测${context.limitKind === 'input' ? '输入 Token（不含输出）' : '输入与输出 Token 之和'}；${context.model || '当前模型'}，${context.limitKind === 'input' ? '配置或目录声明的输入上限' : '配置或目录声明的上下文窗口'} ${contextLimit || '未知'} Token。缓存属于输入，思考属于相应输出用量，不重复累加；此值不是会话累计消耗或账号剩余额度。`,
  };
}

// Character heuristic only, not a tokenizer. Never count base64 image transport
// as text or expose native reasoning/provider state to the renderer.
function estimateContextTokens(messages, tools = []) {
  const visible = messages.map(({ role, content, toolCalls, toolCallId }) => ({ role, content, toolCalls, toolCallId }));
  const text = JSON.stringify({ messages: visible, tools });
  let units = 0;
  for (const character of text) units += character.codePointAt(0) <= 0x7f ? 3 : 8;
  return Math.ceil(units / 12);
}

module.exports = { aggregateSessionUsage, createSessionMetrics, estimateContextTokens, makePendingContextUsage };
