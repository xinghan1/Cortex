const path = require('node:path');

const BLOCKED_DIRECTORIES = new Set([
  '.git', '.codex', '.aws', '.ssh', '.azure', '.gnupg', '.npm', '.npm-cache', 'node_modules',
]);
const SECRET_FILES = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const SECRET_EXTENSIONS = /\.(?:pem|key|p12|pfx|keystore)$/i;
const RESERVED_NAMES = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/iu;
const apiFor = platform => platform === 'win32' ? path.win32 : path.posix;
const slash = value => value.replace(/\\/gu, '/');

function isSafeWorkspaceName(name) {
  return !BLOCKED_DIRECTORIES.has(name.toLowerCase()) && !SECRET_FILES.test(name) && !SECRET_EXTENSIONS.test(name);
}

function validatePart(part, allowParent) {
  if (part === '..') {
    if (allowParent) return;
    throw new Error('路径包含不允许的目录跳转或名称。');
  }
  if (part.length > 255 || /[. ]$/u.test(part) || RESERVED_NAMES.test(part)) throw new Error('路径包含不允许的目录跳转或名称。');
  if (!isSafeWorkspaceName(part)) throw new Error('此路径属于依赖目录、受保护配置或密钥文件，无法访问。');
}

function workspacePathKey(value, { platform = process.platform } = {}) {
  const normalized = slash(value);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function sameWorkspacePath(left, right, options) { return workspacePathKey(left, options) === workspacePathKey(right, options); }

// This function is lexical only. Callers opening a file must inspect every
// entry in walks, including entries cancelled by '..', for links/redirections.
function normalizeWorkspaceReference(root, input = '', { allowExternalPaths = false, allowRoot = false, platform = process.platform } = {}) {
  if (typeof root !== 'string' || !root || typeof input !== 'string') throw new Error('路径必须是字符串。');
  if (input.length > 4096 || input !== input.trim()) throw new Error('路径长度或空白字符无效。');
  const api = apiFor(platform);
  const project = api.resolve(root);
  if (/[\x00-\x1f\x7f-\x9f<>"|?*]/u.test(input) || /^[\\/]{2}/u.test(input)) throw new Error('不允许设备路径、网络共享、备用数据流或无效名称。');
  const driveAbsolute = /^[A-Za-z]:[\\/]/u.test(input);
  const absoluteInput = platform === 'win32' ? driveAbsolute : input.startsWith('/');
  if (!allowExternalPaths && (/^[\\/]/u.test(input) || path.win32.isAbsolute(input) || path.posix.isAbsolute(input) || input.includes(':'))) {
    throw new Error('只允许项目内的相对路径，不允许绝对路径、设备路径或备用数据流。');
  }
  if (platform === 'win32' && (/^[\\/]/u.test(input) || /^[A-Za-z]:/u.test(input) && !driveAbsolute)
      || input.replace(driveAbsolute ? /^[A-Za-z]:/u : /$^/u, '').includes(':')) {
    throw new Error('请使用完整盘符绝对路径或项目相对路径，不允许设备路径或备用数据流。');
  }
  // A Windows drive reference is never interpreted as a POSIX filename.
  if (platform !== 'win32' && (driveAbsolute || /^[\\]/u.test(input))) throw new Error('此平台不支持该绝对路径。');
  const raw = (absoluteInput ? input.slice(api.parse(input).root.length) : input).split(/[\\/]+/u).filter(part => part && part !== '.');
  for (const part of raw) validatePart(part, allowExternalPaths);
  if (!allowExternalPaths) {
    if (!allowRoot && !raw.length) throw new Error('必须指定文件路径。');
    return { absolute: api.join(project, ...raw), relative: raw.join('/'), parts: raw, base: project, walks: [], external: false };
  }
  const volume = api.parse(absoluteInput ? input : project).root;
  const prefix = absoluteInput ? [] : project.slice(volume.length).split(/[\\/]+/u).filter(Boolean);
  for (const part of prefix) validatePart(part, false);
  const stack = [], walks = [volume];
  for (const part of [...prefix, ...raw]) {
    if (part === '..') {
      if (!stack.length) throw new Error('路径跳转超出磁盘根目录。');
      stack.pop();
    } else stack.push(part);
    walks.push(api.join(volume, ...stack));
  }
  let absolute = api.join(volume, ...stack);
  if (absolute.length > 4096) throw new Error('路径长度超过上限。');
  if (platform === 'win32') absolute = absolute[0].toUpperCase() + absolute.slice(1);
  const projectRelative = api.relative(project, absolute);
  const external = projectRelative === '..' || projectRelative.startsWith(`..${api.sep}`) || api.isAbsolute(projectRelative);
  const base = external ? api.parse(absolute).root : project;
  const parts = api.relative(base, absolute).split(api.sep).filter(Boolean);
  if (!allowRoot && !parts.length) throw new Error('必须指定文件路径。');
  return { absolute, relative: external ? slash(absolute) : parts.join('/'), parts, base, walks, external };
}

function safeWorkspacePath(input, { allowRoot = false, platform = process.platform } = {}) {
  try {
    if (typeof input !== 'string' || input.split(/[\\/]+/u).includes('..')) return false;
    normalizeWorkspaceReference(platform === 'win32' ? 'C:/' : '/', input, { allowExternalPaths: true, allowRoot, platform });
    return true;
  } catch { return false; }
}

function validStoredWorkspaceReference(input, { platform = process.platform } = {}) {
  if (!safeWorkspacePath(input, { platform }) || !input) return false;
  const api = apiFor(platform), isAbsolute = api.isAbsolute(input);
  if (!isAbsolute) return input === input.split(/[\\/]+/u).filter(part => part && part !== '.').join('/');
  let normalized = slash(api.resolve(input));
  if (platform === 'win32') normalized = normalized[0].toUpperCase() + normalized.slice(1);
  return normalized === input && api.parse(input).root !== input;
}

module.exports = { normalizeWorkspaceReference, workspacePathKey, sameWorkspacePath, isSafeWorkspaceName, safeWorkspacePath, validStoredWorkspaceReference };
