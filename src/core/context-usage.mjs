import { createHash } from 'node:crypto';
import { estimateContextTokens } from './session-metrics.cjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const count = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => digest(JSON.stringify(canonical(value)));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}
function semanticMessage(message) {
  return { role: message.role, content: message.content, toolCalls: message.toolCalls,
    toolCallId: message.toolCallId, providerState: message.providerState,
    ...(message.attachments?.length ? { attachments: message.attachments.map(image => ({
      mediaType: image.mediaType, name: image.name,
      // The attachment bytes affect inference; UI IDs and timestamps do not.
      dataHash: digest(Buffer.from(String(image.dataUrl ?? '').split(',', 2)[1] ?? '', 'base64')),
    })) } : {}) };
}
function prefixHash(messages, tools) { return hash({ messages: messages.map(semanticMessage), tools }); }
function bindingHash(config) {
  return hash({ provider: config.provider, model: config.model, connectionKey: config.connectionKey ?? null,
    baseUrl: config.baseUrl ?? null, authMode: config.authMode ?? 'apiKey',
    apiProtocol: config.apiProtocol ?? (config.provider === 'relay' ? 'chat-completions' : config.provider === 'openai' ? 'responses' : config.provider),
    credentialHash: digest(String(config.apiKey ?? '')), reasoningEffort: config.reasoningEffort ?? 'default', contextWindow: config.modelCapabilities?.contextWindow ?? null,
    contextWindowKind: config.modelCapabilities?.contextWindowKind ?? 'total' });
}
function valid(measurement) {
  return measurement?.version === 2 && /^[a-f\d]{64}$/u.test(measurement.bindingHash ?? '')
    && /^[a-f\d]{64}$/u.test(measurement.prefixHash ?? '') && count(measurement.messageCount)
    && count(measurement.estimatedTokens) && count(measurement.measuredTokens);
}

// This remains a budgeting heuristic, never an exact UI or billing sample.
// Preserve the conservative allowance for private state replay without exposing it.
export function estimateRequestTokens(messages, tools = []) {
  const native = messages.filter(message => message.providerState)
    .map(message => ({ role: 'assistant', content: JSON.stringify(message.providerState) }));
  return estimateContextTokens([...messages, ...native], tools);
}

export function captureContextMeasurement({ config, messages, tools = [], inputTokens, outputTokens }) {
  if (!count(inputTokens) || !count(outputTokens) || !Number.isSafeInteger(inputTokens + outputTokens)) return null;
  const inputOnly = config.modelCapabilities?.contextWindowKind === 'input';
  // Input-only callers pass the measured request prefix WITHOUT its response;
  // the generated response is future input and will be estimated as growth.
  // Total-window callers include that response, covered by input + output.
  // V1 used a completed prefix for both kinds. Discard those old calibration
  // anchors; the transcript/checkpoint remains intact and is remeasured.
  return { version: 2, bindingHash: bindingHash(config), prefixHash: prefixHash(messages, tools), messageCount: messages.length,
    estimatedTokens: estimateRequestTokens(messages, tools), measuredTokens: inputOnly ? inputTokens : inputTokens + outputTokens };
}

export function contextMeasurementMatchesConfig(measurement, config) {
  return valid(measurement) && measurement.bindingHash === bindingHash(config);
}

export function getContextMeasurementTokens(messages, tools = [], measurement) {
  const estimated = estimateRequestTokens(messages, tools);
  if (!valid(measurement) || measurement.messageCount > messages.length
      || measurement.prefixHash !== prefixHash(messages.slice(0, measurement.messageCount), tools))
    return { tokens: estimated, basis: 'estimated-request-input' };
  const delta = Math.max(0, estimated - measurement.estimatedTokens);
  if (!Number.isSafeInteger(measurement.measuredTokens + delta)) return { tokens: estimated, basis: 'estimated-request-input' };
  return { tokens: measurement.measuredTokens + delta, basis: 'reported-context-plus-estimated-growth',
    reportedTokens: measurement.measuredTokens, estimatedDeltaTokens: delta };
}
