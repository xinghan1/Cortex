const noop = () => {};
const abortError = signal => signal?.reason ?? new DOMException('更新请求已取消。', 'AbortError');
const transportError = (message, code) => Object.assign(new Error(message), { code });
const asError = value => typeof value?.message === 'string' ? value : new Error(String(value || '更新网络请求失败。'));

function responseHeaders(values) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(values || {})) {
    for (const item of Array.isArray(value) ? value : [value]) if (item !== undefined) headers.append(name, String(item));
  }
  return headers;
}

// net.fetch cancels manual redirects instead of exposing their status/Location.
// Return each HTTP hop separately so AppUpdater remains the only redirect policy.
function createUpdateFetch({ net, session, maxBufferedBytes = 8 * 1024 * 1024 } = {}) {
  if (typeof net?.request !== 'function' || !Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes < 1)
    throw new Error('更新网络传输配置无效。');
  return async function updateFetch(address, init = {}) {
    const url = new URL(String(address));
    const method = init.method === undefined ? 'GET' : String(init.method).toUpperCase();
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
        || !['GET', 'HEAD'].includes(method) || init.body != null
        || init.redirect !== undefined && init.redirect !== 'manual') throw new Error('更新传输仅支持不含凭据的手动重定向 GET 或 HEAD 请求。');
    const signal = init.signal;
    if (signal?.aborted) throw abortError(signal);
    const requestHeaders = new Headers(init.headers);
    for (const name of ['authorization', 'proxy-authorization', 'cookie', 'cookie2']) requestHeaders.delete(name);
    const headers = Object.fromEntries(requestHeaders);
    return new Promise((resolve, reject) => {
      let request, incoming, controller, finished = false, responded = false;
      const highWaterMark = Math.min(256 * 1024, maxBufferedBytes);
      const abortRequest = () => { try { request?.abort(); } catch {} };
      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
        if (request) {
          for (const [name, listener] of [['redirect', onRedirect], ['response', onResponse], ['error', fail], ['abort', onRequestAbort], ['login', onLogin]])
            request.removeListener(name, listener);
          request.on('error', noop);
        }
        if (incoming) {
          for (const [name, listener] of [['end', onEnd], ['data', onData], ['error', fail], ['aborted', onResponseAbort]]) incoming.removeListener(name, listener);
          incoming.on('error', noop);
        }
      };
      function fail(error) {
        if (finished) return;
        finished = true; error = asError(error);
        cleanup();
        if (responded) controller?.error(error); else reject(error);
        abortRequest();
      }
      function onAbort() { fail(abortError(signal)); }
      function onRequestAbort() { fail(abortError(signal)); }
      function onResponseAbort() { fail(signal?.aborted ? abortError(signal) : transportError('net::ERR_ABORTED', 'ERR_ABORTED')); }
      function onLogin(_auth, callback) { callback(); }
      function onRedirect(statusCode, _method, redirectUrl, values) {
        if (finished) return;
        try {
          if (![301, 302, 303, 307, 308].includes(statusCode)) throw transportError('更新重定向状态无效。', 'UPDATE_INVALID_REDIRECT');
          const redirectHeaders = responseHeaders(values);
          if (!redirectHeaders.has('location') && typeof redirectUrl === 'string') redirectHeaders.set('location', redirectUrl);
          const response = new Response(null, { status: statusCode, headers: redirectHeaders });
          finished = true; cleanup();
          // Abort synchronously inside the redirect event. Never followRedirect.
          abortRequest(); resolve(response);
        } catch (error) { fail(error); }
      }
      function onEnd() {
        if (finished) return;
        finished = true; cleanup(); controller.close();
      }
      function onData(value) {
        if (finished) return;
        try {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
          const queued = Math.max(0, highWaterMark - controller.desiredSize);
          // Electron IncomingMessage is an EventEmitter, not necessarily a
          // pausable Node Readable. Bound the queue even on those runtimes.
          if (queued + chunk.length > maxBufferedBytes) throw transportError('更新下载缓冲区已满，请重试。', 'UPDATE_BUFFER_LIMIT');
          controller.enqueue(new Uint8Array(chunk));
          if (controller.desiredSize <= 0) incoming.pause?.();
        } catch (error) { fail(error); }
      }
      function onResponse(message) {
        if (finished) return;
        incoming = message;
        try {
          const status = incoming.statusCode, values = responseHeaders(incoming.headers);
          if (method === 'HEAD' || [204, 205, 304].includes(status)) {
            const response = new Response(null, { status, headers: values });
            finished = true; cleanup(); abortRequest(); resolve(response); return;
          }
          const body = new ReadableStream({
            start(value) { controller = value; },
            pull() { incoming.resume?.(); },
            cancel() { if (!finished) { finished = true; cleanup(); abortRequest(); } },
          }, { highWaterMark, size: chunk => chunk.byteLength });
          const response = new Response(body, { status, headers: values });
          // Electron requires installing end before data listeners.
          incoming.once('end', onEnd); incoming.on('error', fail); incoming.once('aborted', onResponseAbort); incoming.on('data', onData);
          responded = true; resolve(response);
        } catch (error) { fail(error); }
      }
      try {
        request = net.request({ url: url.href, method, redirect: 'manual', credentials: 'omit', useSessionCookies: false,
          bypassCustomProtocolHandlers: true, headers, ...(session ? { session } : {}) });
        request.on('error', fail); request.on('redirect', onRedirect); request.once('response', onResponse);
        // Electron can close the request's writable side before response
        // headers arrive. Completion belongs to IncomingMessage, not close.
        request.once('abort', onRequestAbort); request.on('login', onLogin);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort(); else request.end();
      } catch (error) { fail(error); }
    });
  };
}

module.exports = { createUpdateFetch };
