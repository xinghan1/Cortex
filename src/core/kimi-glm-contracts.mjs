// Provider-specific request/replay rules. HTTP, SSE, cancellation and tool JSON
// validation stay in the shared providers adapter.
// https://platform.kimi.ai/docs/api/responses
// https://platform.kimi.com/docs/guide/use-thinking-models
// https://www.kimi.com/code/docs/en/kimi-code/models.html
// https://docs.bigmodel.cn/cn/guide/capabilities/thinking
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const own = value => value && typeof value === 'object' && !Array.isArray(value);
const error = (message, code = 'INVALID_REASONING_EFFORT') => Object.assign(new Error(message), { name: 'ProviderError', code, retryable: false });
export const isKimiGlm = provider => provider === 'kimi' || provider === 'glm';
export function officialVendor(provider, endpoint) {
  let url; try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== 'https:' || url.port) return false;
  const base = url.pathname.replace(/\/(?:models|responses|chat\/completions)\/?$/u, '').replace(/\/$/u, '');
  return provider === 'kimi' ? ['api.moonshot.cn', 'api.moonshot.ai'].includes(url.hostname) && base === '/v1'
    || ['api.kimi.com', 'api.kimi.ai'].includes(url.hostname) && base === '/coding/v1'
    : provider === 'glm' && (url.hostname === 'open.bigmodel.cn' || url.hostname === 'api.z.ai')
      && ['/api/paas/v4', '/api/coding/paas/v4'].includes(base);
}
export const GLM_DOC_MODELS = Object.freeze([
  ['glm-5.3', 'GLM-5.3', false], ['glm-5.2', 'GLM-5.2', false],
  ['glm-5.3-flash', 'GLM-5.3-Flash', true], ['glm-5.3-flashx', 'GLM-5.3-FlashX', true],
].map(([id, displayName, supportsImages]) => Object.freeze({ id, displayName, supportsImages, supportsTools: true,
  textCompatible: true, compatible: true, maxOutputTokens: 131072,
  reasoningEfforts: id === 'glm-5.2' ? ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] : ['low', 'high', 'max'] })));
const kimiEffortIds = new Set(['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3', 'k3.1-pro', 'k3.1-pro-highspeed', 'k3', 'k3-256k', 'kimi-for-coding']);
export function documentedEfforts(provider, model) {
  if (provider === 'glm') return GLM_DOC_MODELS.find(value => value.id === model)?.reasoningEfforts;
  if (provider === 'kimi' && kimiEffortIds.has(model)) return ['low', 'high', 'max'];
  return undefined;
}
export function vendorBinding({ provider, model, endpoint, apiProtocol, apiKey, connectionKey }) {
  return digest(['synora-native-vendor-v1', provider, model, endpoint, apiProtocol, apiKey?.trim(), connectionKey ?? null]);
}
export function vendorMessages(messages, { provider, model, endpoint, apiProtocol, binding }) {
  return messages.map(message => {
    const state = message.providerState;
    if (!state) return message;
    if (state.provider !== provider) return { ...message, providerState: undefined };
    if (state.model !== model || state.endpoint !== endpoint || state.apiProtocol !== apiProtocol || state.connectionBinding !== binding)
      throw error('模型原生状态属于其他供应商、型号或连接，未重放。', 'PROVIDER_NATIVE_STATE_MISMATCH');
    let content, calls;
    try {
      if (apiProtocol === 'responses') {
        if (!Array.isArray(state.output)) throw Error();
        content = state.output.filter(item => item.type === 'message').flatMap(item => item.content ?? [])
          .map(part => part.text ?? part.refusal ?? '').join('');
        calls = state.output.filter(item => item.type === 'function_call').map(item => ({ id: item.call_id, name: item.name,
          arguments: typeof item.arguments === 'string' ? JSON.parse(item.arguments) : item.arguments }));
      } else {
        if (!own(state.message) || state.message.role !== 'assistant') throw Error();
        content = state.message.content ?? '';
        calls = (state.message.tool_calls ?? []).map(call => ({ id: call.id, name: call.function.name,
          arguments: typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments }));
      }
    } catch { throw error('模型原生消息格式无效，未重放。', 'PROVIDER_NATIVE_STATE_MISMATCH'); }
    if (content !== message.content || !isDeepStrictEqual(calls, message.toolCalls ?? []))
      throw error('模型原生消息与可见内容或工具参数不一致，未重放。', 'PROVIDER_NATIVE_STATE_MISMATCH');
    return { ...message, providerState: { ...state, provider: apiProtocol === 'responses' ? 'openai' : 'deepseek' } };
  });
}
export function vendorResult(result, { provider, apiProtocol, binding }) {
  if (!result?.message?.providerState) return result;
  return { ...result, message: { ...result.message, providerState: { ...result.message.providerState,
    provider, apiProtocol, connectionBinding: binding } } };
}
export function vendorRequest(body, { provider, model, endpoint, apiProtocol, reasoningEffort = 'default', sessionId, promptCacheKey, messages }) {
  const official = officialVendor(provider, endpoint), documented = official ? documentedEfforts(provider, model) : undefined;
  if (reasoningEffort !== 'default' && !documented?.includes(reasoningEffort)
      && !(provider === 'kimi' && official && model === 'kimi-k2.6' && apiProtocol === 'chat-completions' && reasoningEffort === 'none'))
    throw error('此型号和地址未声明支持该思考档位，请使用默认档位。');
  if (provider === 'kimi') {
    // Unlike OpenAI, this include value is not in Kimi's public enum. Native
    // reasoning output is returned and replayed without requesting it here.
    delete body.include;
    if (reasoningEffort !== 'default') {
      if (reasoningEffort === 'none') body.thinking = { type: 'disabled' };
      else if (apiProtocol === 'responses') body.reasoning = { effort: reasoningEffort };
      else body.reasoning_effort = reasoningEffort;
    }
    // Explicit session lineage is preferred. Older callers can still derive
    // a stable opaque cache key from their first user message; never a new
    // network-request UUID or mutable whole-conversation hash.
    const first = messages.find(message => message.role === 'user');
    const lineage = promptCacheKey || sessionId || first?.id || first?.content || 'empty';
    body.prompt_cache_key = `synora-${digest([lineage])}`;
  } else if (official && documented) {
    const disabled = model === 'glm-5.2' && ['none', 'minimal'].includes(reasoningEffort);
    body.thinking = disabled ? { type: 'disabled' } : { type: 'enabled', clear_thinking: false };
    if (!disabled && reasoningEffort !== 'default') body.reasoning_effort = model === 'glm-5.2'
      ? ['low', 'medium'].includes(reasoningEffort) ? 'high' : reasoningEffort === 'xhigh' ? 'max' : reasoningEffort : reasoningEffort;
    if (body.tools?.length) { body.tool_choice = 'auto'; body.tool_stream = true; }
  }
  return body;
}
