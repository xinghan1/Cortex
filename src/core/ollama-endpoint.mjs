// Only the explicitly configured Ollama provider permits remote plain HTTP.
// Native endpoints share one validator; redirects are disabled by callers.
export function ollamaEndpoint(baseUrl, resource = 'chat') {
  const invalid = () => Object.assign(new Error('Ollama 地址无效：请填写 HTTP/HTTPS 基础地址，不能包含用户名、密码、查询参数、片段或控制字符。'), { code: 'INVALID_BASE_URL' });
  if (!['chat', 'tags', 'show'].includes(resource)) throw invalid();
  const raw = baseUrl === undefined || baseUrl === '' ? 'http://localhost:11434' : baseUrl;
  if (typeof raw !== 'string' || /[\s\\?#\x00-\x1f\x7f]/u.test(raw) || !/^https?:\/\//iu.test(raw)) throw invalid();
  let url;
  try { url = new URL(raw); } catch { throw invalid(); }
  const authority = raw.match(/^https?:\/\/([^/]*)/iu)?.[1] || '';
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || authority.includes('@')) throw invalid();
  const rawPath = raw.replace(/^https?:\/\/[^/]*/iu, '');
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { throw invalid(); }
  if (/[\x00-\x1f\x7f\\?#]/u.test(decoded) || /%(?:2f|5c)/iu.test(rawPath)
      || decoded.split('/').some(part => part === '.' || part === '..')) throw invalid();
  let prefix = url.pathname.replace(/\/+$/u, '');
  if (/\/v1(?:\/|$)/u.test(prefix)) throw Object.assign(new Error('Ollama 使用原生 /api 接口，请填写服务基础地址，不要填写 OpenAI 兼容的 /v1 地址。'), { code: 'INVALID_BASE_URL' });
  prefix = prefix.replace(/\/api\/(?:chat|tags|show)$/u, '/api');
  if (!prefix.endsWith('/api')) prefix += '/api';
  url.pathname = `${prefix}/${resource}`;
  return url;
}
