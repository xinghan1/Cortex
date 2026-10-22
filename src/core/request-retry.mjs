import { setTimeout as delay } from 'node:timers/promises';

export const MODEL_RETRY_LIMITS = Object.freeze({ maxRetries: 5, baseDelayMs: 1000, maxDelayMs: 30_000, maxRetryAfterMs: 60_000 });

// Retry-After is a duration or an HTTP date. Keep the numeric value separate
// from error text: public reconnect events never contain a server header/body.
export function retryAfterMilliseconds(value, now = Date.now()) {
  if (typeof value !== 'string' || value.length > 256 || !Number.isFinite(now)) return undefined;
  const text = value.trim();
  if (/^\d+$/u.test(text)) {
    const seconds = Number(text);
    return Number.isSafeInteger(seconds) && seconds <= Number.MAX_SAFE_INTEGER / 1000 ? seconds * 1000 : undefined;
  }
  if (!/^[A-Za-z]{3},\s/u.test(text)) return undefined;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

export function reconnectReason(error) {
  if (error?.retryable === false || error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return null;
  if (error?.code === 'PROVIDER_TIMEOUT') return 'timeout';
  if (['PROVIDER_NETWORK_ERROR', 'PROVIDER_INCOMPLETE_STREAM'].includes(error?.code)) return 'connection';
  // This is the OAuth credential transport, not the SDK's model streamer. A
  // non-retryable sign-in, storage, or entitlement error must remain terminal.
  if (error?.code === 'network_error' && error.retryable === true) return 'connection';
  const status = /^PROVIDER_HTTP_(\d{3})$/u.exec(error?.code || '')?.[1];
  const number = status ? Number(status) : Number.isInteger(error?.status) ? error.status : null;
  return number === 408 || number === 429 || number >= 500 && number <= 599 ? 'service' : null;
}

/** Retry only a model request. Callers commit its reply and execute tools after
 * this resolves, so retrying cannot replay a previously executed local tool.
 * Each operation invocation is an independent, billed request attempt. */
export async function retryModelRequest(operation, {
  signal, onEvent = () => {}, maxRetries = MODEL_RETRY_LIMITS.maxRetries,
  baseDelayMs = MODEL_RETRY_LIMITS.baseDelayMs, maxDelayMs = MODEL_RETRY_LIMITS.maxDelayMs,
  initialRetries = 0, beforeAttempt = () => {},
  sleep = milliseconds => delay(milliseconds, undefined, { signal }),
} = {}) {
  if (typeof operation !== 'function' || typeof onEvent !== 'function' || typeof sleep !== 'function' || typeof beforeAttempt !== 'function'
      || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > MODEL_RETRY_LIMITS.maxRetries
      || !Number.isInteger(initialRetries) || initialRetries < 0 || initialRetries > maxRetries
      || !Number.isInteger(baseDelayMs) || baseDelayMs < 0 || baseDelayMs > 60_000
      || !Number.isInteger(maxDelayMs) || maxDelayMs < 0 || maxDelayMs > 60_000) throw new TypeError('模型重连配置无效。');
  let retried = initialRetries;
  const publish = (status, attempt, delayMs, reason) => onEvent({ type: 'reconnect', status, attempt,
    maxAttempts: maxRetries, delayMs, ...(reason ? { reason } : {}) });
  while (true) {
    signal?.throwIfAborted();
    // Planning/configuration errors happen before an actual request and must
    // neither create a failed attempt nor consume the remaining retry budget.
    await beforeAttempt(retried);
    signal?.throwIfAborted();
    let value;
    try { value = await operation(retried); }
    catch (error) {
      if (signal?.aborted) throw error;
      const reason = reconnectReason(error);
      if (!reason) {
        if (retried) publish('failed', retried, 0, 'not-retryable');
        throw error;
      }
      if (retried >= maxRetries) { publish('failed', retried, 0, 'retry-limit'); throw error; }
      const hinted = Number.isFinite(error.retryAfterMs) && error.retryAfterMs >= 0 ? error.retryAfterMs : undefined;
      // Never shorten a server's longer cooldown and retry prematurely. Long
      // waits remain an explicit final failure rather than an unbounded timer.
      if (hinted > MODEL_RETRY_LIMITS.maxRetryAfterMs) { publish('failed', retried, 0, 'retry-after'); throw error; }
      const delayMs = hinted ?? Math.min(maxDelayMs, baseDelayMs * 2 ** retried);
      retried++;
      publish('waiting', retried, delayMs, reason);
      signal?.throwIfAborted();
      await sleep(delayMs);
      signal?.throwIfAborted();
      publish('retrying', retried, 0, reason);
      continue;
    }
    signal?.throwIfAborted();
    // Keep observer exceptions outside the catch: a UI callback failing after
    // success must never cause an already completed model request to be sent again.
    if (retried) publish('recovered', retried, 0);
    return value;
  }
}
