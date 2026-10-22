/* Per-task usage is supplied by the persisted request ledger. This view never
 * estimates tokens from reply text or substitutes the session-wide total. */
(() => {
  'use strict';

  const count = value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const runId = record => typeof (record?.runId || record?.id) === 'string' ? (record.runId || record.id).trim() : '';

  function formatTokens(value) {
    const tokens = count(value);
    if (tokens === null) return null;
    if (tokens < 1000) return String(tokens);
    const units = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
    let unit = units.find(([scale]) => tokens >= scale) || units[2];
    let rounded = Math.round(tokens / unit[0] * 10) / 10;
    if (rounded >= 1000 && unit !== units[0]) {
      unit = units[units.indexOf(unit) - 1];
      rounded = Math.round(tokens / unit[0] * 10) / 10;
    }
    return `${rounded}${unit[1]}`;
  }

  function describe(record = {}) {
    const id = runId(record);
    if (!id || record.demo === true || record.kind && record.kind !== 'agent'
        || !['completed', 'failed', 'stopped'].includes(record.status)) return null;
    const usage = record.usage;
    const input = count(usage?.inputTokens), output = count(usage?.outputTokens), suppliedTotal = count(usage?.totalTokens);
    const total = input !== null && output !== null && Number.isSafeInteger(input + output) ? input + output : suppliedTotal;
    const known = usage && ['reported', 'partial'].includes(usage.status) && total !== null;
    if (!known) return { runId: id, status: 'unavailable', label: '用量 未回报', title: '本轮没有可用的 API 用量报告。', partial: false };
    const missing = count(usage.unreportedRequests) || 0, partialRequests = count(usage.partialRequests) || 0;
    const partial = usage.status === 'partial' || missing > 0 || partialRequests > 0 || usage.historicalApproximate === true;
    const number = value => value === null ? '未回报' : value.toLocaleString('en-US');
    const lines = [`本轮 API 已回报用量：输入 ${number(input)} / 输出 ${number(output)} Token，共 ${number(total)} Token。`];
    const requests = count(usage.requests), reported = count(usage.reportedRequests);
    if (requests !== null) lines.push(`${requests} 次请求${reported !== null ? `，${reported} 次有用量报告` : ''}。`);
    if (partial) lines.push('仅累计已回报用量；缺失部分未计入。');
    if (usage.historicalApproximate === true) lines.push('包含旧版历史近似记录。');
    lines.push('包含本轮的工具续答、摘要、子任务和 AI 审批请求；缓存与推理 Token 不重复累加。');
    return { runId: id, status: partial ? 'partial' : 'reported', label: `用量 ${formatTokens(total)} tok${partial ? '*' : ''}`, title: lines.join('\n'), partial };
  }

  function create(record, document = globalThis.document) {
    const value = describe(record);
    if (!value || !document) return null;
    const badge = document.createElement('div');
    badge.className = 'round-token-usage';
    badge.dataset.runId = value.runId;
    badge.dataset.status = value.status;
    badge.title = value.title;
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 16 16');
    icon.setAttribute('aria-hidden', 'true');
    icon.classList.add('round-token-usage-icon');
    for (const path of ['M13 4c0 1.4-2.2 2.5-5 2.5S3 5.4 3 4s2.2-2.5 5-2.5S13 2.6 13 4Z', 'M3 4v4c0 1.4 2.2 2.5 5 2.5S13 9.4 13 8V4', 'M3 8v4c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V8']) {
      const item = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      item.setAttribute('d', path); icon.append(item);
    }
    const text = document.createElement('span');
    text.className = 'round-token-usage-text'; text.textContent = value.label;
    badge.append(icon, text);
    return badge;
  }

  const api = Object.freeze({ formatTokens, describe, create });
  if (typeof module === 'object' && module.exports) module.exports = api;
  globalThis.ForgeRoundTokenUsage = api;
})();
