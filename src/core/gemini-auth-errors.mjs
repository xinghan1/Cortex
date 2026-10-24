// ACP diagnostics are untrusted and may contain OAuth URLs or account data.
// Inspect a bounded set of error fields; publish only fixed codes and enums.
const FIELDS = Object.freeze(['message', 'error', 'data', 'details', 'cause', 'response', 'errors',
  'error_description', 'description', 'reason', 'unsupportedClient', 'status', 'statusCode', 'status_code', 'code', 'errno']);
const STATUS_FIELDS = new Set(['status', 'statusCode', 'status_code', 'code']);
const HTTP_STATUSES = new Set([400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410, 411, 412, 413,
  414, 415, 416, 417, 418, 421, 422, 423, 424, 425, 426, 428, 429, 431, 451,
  500, 501, 502, 503, 504, 505, 506, 507, 508, 510, 511, 520, 521, 522, 523, 524, 525, 526, 527, 529, 530, 598, 599]);
const ERRNOS = new Set(['ENOTFOUND', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENETUNREACH',
  'EHOSTUNREACH', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED', 'ERR_NETWORK', 'ERR_SOCKET_CLOSED',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_CONNECT',
  'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_DESTROYED', 'UND_ERR_ABORTED',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH']);
const SERVER_STATUSES = new Set(['CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED',
  'NOT_FOUND', 'ALREADY_EXISTS', 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL', 'UNAVAILABLE', 'DATA_LOSS']);
const MAX_DEPTH = 9, MAX_NODES = 160, MAX_ARRAY = 24, MAX_STRING = 16384, MAX_TEXT = 65536;

function ownValue(value, key) {
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}

function collect(error) {
  const result = { strings: [], statuses: [], errno: null, serverStatus: null, undici: false, unsupportedClient: false };
  const seen = new Set(); let nodes = 0, remaining = MAX_TEXT;
  const status = value => {
    const number = typeof value === 'number' ? value : /^\d{3}$/u.test(value) ? Number(value) : null;
    if (Number.isInteger(number) && number >= 400 && number <= 599) result.statuses.push(number);
  };
  function visit(value, depth, field = '') {
    if (value === undefined || value === null) return;
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return;
    if (field === 'unsupportedClient' && (value === true || typeof value === 'object' || typeof value === 'string' && value.trim())) result.unsupportedClient = true;
    if (typeof value === 'number') { if (STATUS_FIELDS.has(field)) status(value); return; }
    if (typeof value === 'string') {
      if (!remaining) return;
      const text = value.slice(0, Math.min(MAX_STRING, remaining)); remaining -= text.length;
      result.strings.push(text);
      if (STATUS_FIELDS.has(field)) status(text.trim());
      const trimmed = text.trim();
      if (SERVER_STATUSES.has(trimmed)) result.serverStatus ||= trimmed;
      for (const rawToken of text.match(/\b[A-Z][A-Z_]{2,63}\b/giu) || []) {
        const token = rawToken.toUpperCase();
        if (ERRNOS.has(token)) result.errno ||= token;
        if (/^UND_ERR_[A-Z_]+$/u.test(token)) result.undici = true;
        // Ordinary wrapper text such as "Internal error" is not a Google enum.
        if (rawToken === token && SERVER_STATUSES.has(token)) result.serverStatus ||= token;
      }
      for (const match of text.matchAll(/\b(?:HTTP(?:\/[\d.]+)?\s*(?:status\s*)?|(?:status(?:\s*code)?|statusCode|response\s*code)[\s:=]*)([45]\d{2})\b/giu)) status(match[1]);
      const named = text.match(/\b(401\s+Unauthorized|403\s+Forbidden|407\s+Proxy Authentication Required|429\s+Too Many Requests|500\s+Internal Server Error|502\s+Bad Gateway|503\s+Service Unavailable|504\s+Gateway Timeout)\b/iu);
      if (named) status(named[1].slice(0, 3));
      if (['{', '[', '"'].includes(trimmed[0]) && remaining && depth < MAX_DEPTH) {
        try { visit(JSON.parse(trimmed), depth + 1, field); } catch {}
      }
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    let array; try { array = Array.isArray(value); } catch { return; }
    if (array) {
      for (let index = 0; index < Math.min(ownValue(value, 'length') || 0, MAX_ARRAY); index++) visit(ownValue(value, String(index)), depth + 1, field);
      return;
    }
    for (const key of FIELDS) visit(ownValue(value, key), depth + 1, key);
  }
  visit(error, 0);
  return result;
}

export function classifyGeminiRpcError(method, error) {
  const value = collect(error), text = value.strings.join('\n');
  const httpStatus = value.statuses[0], diagnostic = {};
  if (HTTP_STATUSES.has(httpStatus)) diagnostic.httpStatus = httpStatus;
  if (value.errno) diagnostic.errno = value.errno;
  if (value.serverStatus) diagnostic.serverStatus = value.serverStatus;
  const finish = code => Object.keys(diagnostic).length ? { code, diagnostic } : { code };

  if (value.unsupportedClient || /\b(?:this |the )?client (?:is )?(?:no longer supported|not supported|unsupported)\b|\bunsupported[_ -]?client\b/iu.test(text))
    return finish('GEMINI_CLIENT_UNSUPPORTED');
  if (/invalid_grant|invalid_token|unauthenticated|credentials? (?:have |has )?expired/iu.test(text)
      || value.serverStatus === 'UNAUTHENTICATED') return finish('GEMINI_SIGN_IN_REQUIRED');
  if (/(?:GOOGLE_CLOUD_PROJECT|GOOGLE_CLOUD_PROJECT_ID|Google Cloud project).{0,100}(?:required|must|set|specif)|(?:set|specif|require).{0,100}(?:GOOGLE_CLOUD_PROJECT|Google Cloud project)/iu.test(text))
    return finish('GEMINI_PROJECT_REQUIRED');
  if (/Account validation required:|\bVALIDATION_REQUIRED\b/iu.test(text)) return finish('GEMINI_ACCOUNT_VALIDATION_REQUIRED');
  if (/unsupported (?:user )?location|(?:location|region|country) (?:is )?not supported|restricted (?:region|location)|(?:region|location) (?:is )?restricted|\b(?:REGION_UNAVAILABLE|LOCATION_RESTRICTED)\b/iu.test(text))
    return finish('GEMINI_REGION_UNAVAILABLE');
  if (/LoadCodeAssist returned empty response/iu.test(text)) return finish('GEMINI_SERVICE_UNAVAILABLE');
  if (/terms of service|accept.{0,40}terms|tos[_ -]?(?:required|not[_ -]?accepted)/iu.test(text))
    return finish('GEMINI_ACCOUNT_ACTION_REQUIRED');
  if (/quota.{0,30}(?:exceed|exhaust)|resource_exhausted|rate.?limit|too many requests/iu.test(text)
      || value.serverStatus === 'RESOURCE_EXHAUSTED' || httpStatus === 429) return finish('GEMINI_QUOTA_EXCEEDED');
  if (httpStatus === 407) return finish('GEMINI_PROXY_FAILED');
  if (httpStatus === 401) return finish('GEMINI_SIGN_IN_REQUIRED');
  if (value.errno || value.undici || /fetch failed|network error|unable to verify|certificate|socket hang up|proxy/iu.test(text))
    return finish('GEMINI_NETWORK_ERROR');
  if (httpStatus >= 500 || ['INTERNAL', 'UNAVAILABLE', 'DEADLINE_EXCEEDED'].includes(value.serverStatus))
    return finish('GEMINI_SERVICE_UNAVAILABLE');
  if (httpStatus === 403 || value.serverStatus === 'PERMISSION_DENIED') return finish('GEMINI_ACCESS_DENIED');
  if (httpStatus === 408) return finish('GEMINI_TIMEOUT');
  return finish(method === 'authenticate' ? 'GEMINI_AUTH_FAILED' : method === 'session/new' ? 'GEMINI_SESSION_FAILED' : 'GEMINI_CLI_REQUEST_FAILED');
}
