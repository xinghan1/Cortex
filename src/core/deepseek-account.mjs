const OFFICIAL_BASE_URL = 'https://api.deepseek.com';
const BALANCE_ENDPOINT = `${OFFICIAL_BASE_URL}/user/balance`;
const MAX_RESPONSE_BYTES = 32 * 1024;
const MAX_DECIMAL_CHARS = 64;

class DeepSeekBalanceError extends Error {
  constructor(code, message) { super(message); this.name = 'DeepSeekBalanceError'; this.code = code; }
}
const fail = (code, message) => new DeepSeekBalanceError(code, message);
const aborted = () => Object.assign(new Error('余额查询已取消。'), { name: 'AbortError', code: 'ABORT_ERR' });

// Check the raw authority and path as well as the URL parser: normalization
// must not make a third-party URL, credentials, escaped path or port official.
export function isOfficialDeepSeekURL(baseUrl) {
  if (typeof baseUrl !== 'string' || /[\s\\\x00-\x1f\x7f]/u.test(baseUrl)) return false;
  const parts = baseUrl.match(/^https:\/\/([^/]+)(.*)$/iu);
  if (!parts || parts[1].toLowerCase() !== 'api.deepseek.com' || !['', '/', '/v1', '/v1/'].includes(parts[2])) return false;
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && url.hostname === 'api.deepseek.com' && !url.port && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function parseBalance(raw) {
  const invalid = () => fail('DEEPSEEK_BALANCE_RESPONSE', 'DeepSeek 余额数据格式无效，请稍后重试。');
  let value;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  if (!exactKeys(value, ['is_available', 'balance_infos']) || typeof value.is_available !== 'boolean'
      || !Array.isArray(value.balance_infos) || value.balance_infos.length > 2) throw invalid();
  const currencies = new Set();
  const balance_infos = value.balance_infos.map(info => {
    const fields = ['currency', 'total_balance', 'granted_balance', 'topped_up_balance'];
    if (!exactKeys(info, fields) || !['CNY', 'USD'].includes(info.currency) || currencies.has(info.currency)) throw invalid();
    currencies.add(info.currency);
    for (const key of fields.slice(1)) if (typeof info[key] !== 'string' || info[key].length > MAX_DECIMAL_CHARS
        || !/^-?\d+(?:\.\d+)?$/u.test(info[key])) throw invalid();
    return Object.fromEntries(fields.map(key => [key, info[key]]));
  });
  return { is_available: value.is_available, balance_infos };
}

async function readBody(response, signal) {
  const tooLarge = () => fail('DEEPSEEK_BALANCE_TOO_LARGE', 'DeepSeek 余额响应过大，请稍后重试。');
  const length = response.headers?.get('content-length');
  if (/^\d+$/u.test(length ?? '') && Number(length) > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!response.body || typeof response.body.getReader !== 'function')
    throw fail('DEEPSEEK_BALANCE_RESPONSE', 'DeepSeek 余额数据格式无效，请稍后重试。');
  const reader = response.body.getReader(), chunks = [];
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  let total = 0;
  try {
    if (signal.aborted) { cancel(); throw aborted(); }
    while (true) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw aborted();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { void reader.cancel().catch(() => {}); throw tooLarge(); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
}

export async function fetchDeepSeekBalance({ apiKey, baseUrl = OFFICIAL_BASE_URL, fetchImpl = globalThis.fetch,
  signal, timeoutMs = 15000 } = {}) {
  if (signal?.aborted) throw aborted();
  if (!isOfficialDeepSeekURL(baseUrl)) throw fail('DEEPSEEK_BALANCE_UNOFFICIAL', '当前连接不是 DeepSeek 官方服务，无法查询官方账户余额。');
  if (typeof apiKey !== 'string' || !apiKey.length || apiKey.length > 4096 || /[^\x21-\x7e]/u.test(apiKey))
    throw fail('DEEPSEEK_BALANCE_KEY', '请先保存有效的 DeepSeek API Key。');
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw fail('DEEPSEEK_BALANCE_CONFIG', '余额查询配置无效。');
  const controller = new AbortController();
  let timer, cancelled = false, timedOut = false, cancel;
  const interrupted = new Promise((_, reject) => {
    cancel = () => { cancelled = true; controller.abort(); reject(aborted()); };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    timer = setTimeout(() => {
      timedOut = true; controller.abort();
      reject(fail('DEEPSEEK_BALANCE_TIMEOUT', 'DeepSeek 余额查询超时，请重试。'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([interrupted, (async () => {
      const response = await fetchImpl(BALANCE_ENDPOINT, { method: 'GET', headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        redirect: 'error', credentials: 'omit', cache: 'no-store', signal: controller.signal });
      if (!response?.ok) {
        void response?.body?.cancel().catch(() => {});
        if (response?.status === 401) throw fail('DEEPSEEK_BALANCE_AUTH', 'DeepSeek 密钥无效或已失效，请更新后重试。');
        if (response?.status === 403) throw fail('DEEPSEEK_BALANCE_FORBIDDEN', '当前 DeepSeek 密钥无权查询余额。');
        if (response?.status === 429) throw fail('DEEPSEEK_BALANCE_BUSY', 'DeepSeek 请求过于频繁，请稍后重试。');
        throw fail('DEEPSEEK_BALANCE_HTTP', 'DeepSeek 余额服务暂不可用，请稍后重试。');
      }
      return parseBalance(await readBody(response, controller.signal));
    })()]);
  } catch (error) {
    if (cancelled || signal?.aborted) throw aborted();
    if (timedOut) throw fail('DEEPSEEK_BALANCE_TIMEOUT', 'DeepSeek 余额查询超时，请重试。');
    if (error instanceof DeepSeekBalanceError) throw error;
    throw fail('DEEPSEEK_BALANCE_NETWORK', '无法读取 DeepSeek 账户余额，请检查网络后重试。');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}
