const { validateBrowserURL } = require('./browser-security.cjs');

const MAX_XML_BYTES = 1024 * 1024;
function isXmlURL(value) {
  try { return /\.xml$/iu.test(new URL(value).pathname); } catch { return false; }
}

// Read source bytes only. No DOM, XML parser, entities, scripts or cookies.
async function readXmlURL(input, { signal, fetchImpl = fetch, onRedirect, timeoutMs = 60000 } = {}) {
  const offset = input?.offset ?? 0, limit = input?.limit ?? 24000;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_XML_BYTES
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 50000) throw new Error('XML 读取范围无效。');
  let url = validateBrowserURL(input?.url);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('读取 XML 超时。')), timeoutMs);
  try {
    let response;
    for (let redirect = 0; ; redirect++) {
      controller.signal.throwIfAborted();
      response = await fetchImpl(url, { signal: controller.signal, redirect: 'manual', credentials: 'omit',
        headers: { Accept: 'application/xml,text/xml;q=0.9,text/plain;q=0.5' } });
      if (response.status < 300 || response.status >= 400) break;
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirect >= 5) throw new Error('XML 链接重定向无效或次数过多。');
      const next = validateBrowserURL(new URL(location, url).href);
      if (typeof onRedirect !== 'function') throw new Error('XML 重定向需要重新确认目标。');
      await onRedirect(next); controller.signal.throwIfAborted(); url = next;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`读取 XML 失败：HTTP ${response.status}。`); }
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('text/html')) { await response.body?.cancel(); throw new Error('该地址返回 HTML，未作为 XML 读取，也未打开浏览器。'); }
    if (!/\b(?:application|text)\/(?:[\w.+-]*\+)?xml\b/u.test(contentType)
        && !(isXmlURL(url) && (!contentType || /(?:text\/plain|application\/octet-stream)/u.test(contentType)))) {
      await response.body?.cancel(); throw new Error('该地址未返回 XML 文本。');
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_XML_BYTES) { await response.body?.cancel(); throw new Error('XML 文件超过 1 MB。'); }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('XML 文件没有可读取的内容。');
    const chunks = []; let bytes = 0;
    try {
      while (true) {
        controller.signal.throwIfAborted();
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_XML_BYTES) throw new Error('XML 文件超过 1 MB。');
        chunks.push(Buffer.from(part.value));
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const buffer = Buffer.concat(chunks, bytes);
    const encoding = /charset\s*=\s*["']?([\w.-]+)/iu.exec(contentType)?.[1]
      || /encoding\s*=\s*["']([\w.-]+)["']/iu.exec(buffer.subarray(0, 200).toString('ascii'))?.[1]
      || (buffer[0] === 0xff && buffer[1] === 0xfe ? 'utf-16le' : buffer[0] === 0xfe && buffer[1] === 0xff ? 'utf-16be' : 'utf-8');
    let text;
    try { text = new TextDecoder(encoding, { fatal: true }).decode(buffer); }
    catch { throw new Error('XML 编码无效或不受支持，未替换原始内容。'); }
    if (!text.trimStart().startsWith('<')) throw new Error('返回内容不是可识别的 XML 源文本。');
    if (offset > text.length) throw new Error('XML 读取起点超过文件长度。');
    const end = Math.min(text.length, offset + limit);
    return { format: 'xml', url, filename: new URL(url).pathname.split('/').at(-1) || 'document.xml',
      content: text.slice(offset, end), offset, nextOffset: end < text.length ? end : null,
      totalCharacters: text.length, bytes, truncated: end < text.length, browserOpened: false };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

module.exports = { readXmlURL, isXmlURL, MAX_XML_BYTES };
