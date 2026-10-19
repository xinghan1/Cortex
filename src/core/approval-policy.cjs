// Approval convenience only. Workspace/browser validation must run before this
// policy; even full control never grants access around their existing guards.
const APPROVAL_MODES = Object.freeze(['request', 'assist', 'full']);
const MAX_TEXT_BYTES = 512 * 1024;
const BLOCKED_DIRECTORIES = new Set(['.git', '.codex', '.aws', '.ssh', '.azure', '.gnupg', '.npm', '.npm-cache', 'node_modules']);
const SECRET_FILES = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/iu;
const SECRET_EXTENSIONS = /\.(?:pem|key|p12|pfx|keystore)$/iu;
const RESERVED_NAMES = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const BROWSER_ACTIONS = new Set(['navigate', 'click', 'type', 'scroll', 'snapshot']);

function validateMode(mode) {
  if (!APPROVAL_MODES.includes(mode)) throw Object.assign(new Error('权限模式无效，请重新选择。'), { code: 'APPROVAL_MODE_INVALID' });
  return mode;
}

function safeRelativePath(input, { allowRoot = false } = {}) {
  if (typeof input !== 'string' || !input || input.length > 4096 || input !== input.trim()
      || /^[\\/\-]/u.test(input) || /[\x00-\x1f\x7f-\x9f<>:"|?*]/u.test(input)) return false;
  const parts = input.split(/[\\/]/u);
  if (parts.some(part => !part || part.length > 255 || part === '..' || /[. ]$/u.test(part) && part !== '.'
      || RESERVED_NAMES.test(part) || BLOCKED_DIRECTORIES.has(part.toLowerCase()) || SECRET_FILES.test(part) || SECRET_EXTENSIONS.test(part))) return false;
  return allowRoot || parts.some(part => part !== '.');
}

function isText(value) {
  return typeof value === 'string' && !value.includes('\0') && Buffer.byteLength(value, 'utf8') <= MAX_TEXT_BYTES;
}

function assistedWrite(request) {
  return safeRelativePath(request.path)
    && (request.before === null || isText(request.before))
    && (request.after === null || isText(request.after))
    && !(request.before === null && request.after === null);
}

function assistedCommand(command) {
  // Parse a deliberately tiny language rather than try to sanitize PowerShell.
  // No aliases, expansions, compound statements, wildcards, pipelines, comments,
  // redirections, switches other than LiteralPath, or file-content commands.
  if (typeof command !== 'string' || !command || command.length > 4096
      || /[\x00-\x1f\x7f-\x9f,;&|<>$`{}()[\]@#"]/u.test(command)) return false;
  const text = command.trim();
  if (/^Get-Location$/iu.test(text)) return true;
  const match = /^Get-ChildItem(?: +-LiteralPath +(.+))?$/iu.exec(text);
  if (!match) return false;
  if (match[1] === undefined) return true;
  let literal = match[1];
  if (literal.startsWith("'")) {
    if (!literal.endsWith("'") || literal.length < 3) return false;
    literal = literal.slice(1, -1);
    if (literal.includes("'")) return false;
  } else if (/[\s']/u.test(literal)) return false;
  return safeRelativePath(literal, { allowRoot: true });
}

function loopbackNavigation(value) {
  if (typeof value !== 'string' || value.length > 8192 || value !== value.trim() || /[\x00-\x1f\x7f-\x9f]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  } catch { return false; }
}

function approvalDecision(mode, request) {
  if (!APPROVAL_MODES.includes(mode) || !request || typeof request !== 'object' || Array.isArray(request)) return 'ask';
  if (!['write', 'command', 'browser'].includes(request.kind)) return 'ask';
  if (request.kind === 'browser') {
    if (!BROWSER_ACTIONS.has(request.action)) return 'ask';
    if (request.action === 'snapshot') return 'allow';
  }
  if (mode === 'full') return 'allow';
  if (mode === 'request') return 'ask';
  if (request.kind === 'write') return assistedWrite(request) ? 'allow' : 'ask';
  if (request.kind === 'command') return assistedCommand(request.command) ? 'allow' : 'ask';
  if (request.action === 'scroll') return 'allow';
  if (request.action === 'navigate' && loopbackNavigation(request.url)) return 'allow';
  return 'ask';
}

module.exports = { APPROVAL_MODES, validateMode, approvalDecision };
