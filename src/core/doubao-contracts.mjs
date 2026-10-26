// Documented Volcengine Ark Chat
// contracts, verified 2026-10-26. The model list is a public documentation
// snapshot, not a claim that the supplied key has activated these models.
// https://docs.volcengine.com/docs/ark/chat-api?lang=zh
// https://docs.volcengine.com/docs/ark/model-list?lang=zh
// https://docs.volcengine.com/docs/ark/deep-thinking?lang=zh
export const DOUBAO_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';
export const DOUBAO_MODELS_SOURCE = 'https://docs.volcengine.com/docs/ark/model-list?lang=zh';
// Native levels only. Compatibility aliases (none/xhigh/max) are not choices.
const efforts = Object.freeze(['minimal', 'low', 'medium', 'high']);
export const DOUBAO_DOC_MODELS = Object.freeze([
  ['doubao-seed-2-1-pro-260915', 'Doubao Seed 2.1 Pro', 1048576],
  ['doubao-seed-2-1-lite-260915', 'Doubao Seed 2.1 Lite', 1048576],
  ['doubao-seed-2-1-turbo-260628', 'Doubao Seed 2.1 Turbo', 262144],
].map(([id, displayName, contextWindow]) => Object.freeze({ id, displayName, contextWindow,
  maxOutputTokens: 262144, supportsTools: true, supportsImages: true,
  textCompatible: true, compatible: true, reasoningEfforts: efforts, defaultReasoningEffort: 'high', contextWindowOrigin: 'official-default' })));
export function officialDoubao(endpoint) {
  let url; try { url = new URL(endpoint); } catch { return false; }
  return url.origin === 'https://ark.cn-beijing.volces.com'
    && /^\/api\/(?:plan\/|coding\/)?v3(?:\/(?:models|chat\/completions))?\/?$/u.test(url.pathname)
    && !url.username && !url.password && !url.search && !url.hash;
}
export function doubaoRequest(body, { model, endpoint, reasoningEffort = 'default' }) {
  if (reasoningEffort !== 'default') {
    if (!officialDoubao(endpoint) || !DOUBAO_DOC_MODELS.some(value => value.id === model && value.reasoningEfforts.includes(reasoningEffort)))
      throw Object.assign(new Error('此豆包型号和地址未声明支持该思考档位，请使用默认档位。'), { name: 'ProviderError', code: 'INVALID_REASONING_EFFORT' });
    body.reasoning_effort = reasoningEffort;
  }
  // Ark's output cap counts answer + reasoning; do not apply DeepSeek's cap.
  if (body.max_tokens !== undefined) { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; }
  return body;
}
