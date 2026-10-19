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

function createSessionMetrics(session, usage, { unavailable = false, expectedContext } = {}) {
  const context = session?.contextUsage || {};
  const stale = expectedContext && (expectedContext.provider !== context.provider || expectedContext.model !== context.model
    || (context.connectionKey && expectedContext.connectionKey !== context.connectionKey));
  const contextUsedTokens = validTokens(context.usedTokens) ? context.usedTokens : null;
  const contextLimit = validTokens(context.limit) && context.limit > 0 ? context.limit : null;
  const contextStatus = !stale && contextUsedTokens !== null && contextLimit !== null
    && ['reported', 'estimated'].includes(context.status) ? context.status : 'unknown';
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
    contextUsedTokens, contextLimit, contextStatus,
    contextLimitKind: context.limitKind === 'input' ? 'input' : 'total',
    contextPercent: contextStatus === 'unknown' ? null : Math.min(100, Math.round(contextUsedTokens / contextLimit * 1000) / 10),
    contextModel: typeof context.model === 'string' ? context.model : null,
    contextDescription: contextStatus === 'unknown'
      ? stale ? '当前模型或连接尚无请求数据，无法计算使用率。' : '模型目录尚未提供有效的上下文容量，无法计算使用率。'
      : `最近请求输入占用比例（不含输出）。${context.status === 'estimated' ? '当前请求输入的字符估算，包含工具定义；图片及原生模型状态可能影响误差' : '上次模型请求报告的输入 Token'}；${context.model || '当前模型'}，${context.limitKind === 'input' ? '目录声明的输入上限' : '目录声明的上下文窗口'} ${contextLimit} Token。缓存输入也占用上下文；此值不是账号剩余额度。`,
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

module.exports = { aggregateSessionUsage, createSessionMetrics, estimateContextTokens };
