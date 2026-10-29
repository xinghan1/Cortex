const ENDPOINT = 'https://api.openai.com/v1/images/generations';
const RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const MAX_RESPONSE = 28 * 1024 * 1024;
const fail = message => new Error(message);

// Image credentials and returned bytes never enter the text-model transport.
// Redirects are rejected to prevent forwarding the authorization header.
export async function generateOpenAIImage({ apiKey, model, textModel, prompt, size = 'auto', signal, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/u.test(apiKey)) throw fail('请先配置 OpenAI API Key。');
  if (typeof model !== 'string' || !/^gpt-image-[a-z0-9.-]{1,80}$/u.test(model)) throw fail('请选择受支持的 OpenAI 图像模型。');
  if (textModel !== undefined && (typeof textModel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(textModel) || /^gpt-image-/u.test(textModel))) throw fail('请选择可调用图像生成工具的 OpenAI 文本模型。');
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 32000) throw fail('请输入不超过 32000 字符的图像描述。');
  if (!['auto', '1024x1024', '1024x1536', '1536x1024'].includes(size)) throw fail('图像尺寸无效。');
  if (typeof fetchImpl !== 'function') throw fail('图像服务不可用。');
  const timeout = AbortSignal.timeout(180000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  const body = textModel ? { model: textModel, input: prompt, tools: [{ type: 'image_generation', model, size, output_format: 'png' }], tool_choice: { type: 'image_generation' } }
    : { model, prompt, size, n: 1, output_format: 'png' };
  try { response = await fetchImpl(textModel ? RESPONSES_ENDPOINT : ENDPOINT, { method: 'POST', redirect: 'error', signal: combined,
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body) }); }
  catch (error) { if (signal?.aborted) throw signal.reason ?? new DOMException('已取消。', 'AbortError');
    if (timeout.aborted) throw fail('图像生成超时，请重试。');
    throw fail('无法连接 OpenAI 图像服务，请检查网络后重试。'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const status = response.status;
    if (status === 401 || status === 403) throw fail('OpenAI 图像服务拒绝访问，请检查 API Key、账号权限或组织验证。');
    if (status === 429) throw fail('OpenAI 图像服务请求受限，请检查额度或稍后重试。');
    throw fail(`OpenAI 图像生成失败（HTTP ${Number.isInteger(status) ? status : '未知'}）。`);
  }
  const length = Number(response.headers?.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE) { await response.body?.cancel().catch(() => {}); throw fail('图像响应过大。'); }
  if (!response.body?.getReader) throw fail('图像服务响应不可读取。');
  const reader = response.body.getReader(), chunks = []; let total = 0;
  try {
    while (true) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength;
      if (total > MAX_RESPONSE) { await reader.cancel(); throw fail('图像响应过大。'); } chunks.push(Buffer.from(value)); }
  } catch (error) { if (signal?.aborted) throw signal.reason ?? new DOMException('已取消。', 'AbortError');
    if (timeout.aborted) throw fail('图像生成超时，请重试。');
    if (error?.message === '图像响应过大。') throw error;
    throw fail('读取 OpenAI 图像响应失败，请检查网络后重试。'); }
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('图像服务返回的数据格式无效。'); }
  const base64 = textModel ? data?.output?.find(item => item?.type === 'image_generation_call' && (!item.status || item.status === 'completed'))?.result : data?.data?.[0]?.b64_json;
  if (typeof base64 !== 'string' || !base64 || base64.length > 24 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(base64)) throw fail('图像服务未返回有效的 PNG 图像。');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw fail('图像服务返回了无效的 PNG 图像。');
  return { dataUrl: `data:image/png;base64,${base64}`, mediaType: 'image/png' };
}
