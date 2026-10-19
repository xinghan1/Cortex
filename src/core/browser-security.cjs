const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');

const MAX_STATIC_BYTES = 16 * 1024 * 1024;
const BLOCKED = new Set(['.git', '.codex', '.aws', '.ssh', '.azure', '.gnupg', '.npm', '.npm-cache', 'node_modules']);
const SECRET = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const EXTENSIONS = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
}));
function samePath(left, right) { return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right; }
function inside(root, value) { const relative = path.relative(root, value); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)); }
function validateBrowserURL(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 8192 || /[\x00-\x20\x7f]/.test(input)) throw new Error('请输入有效的 HTTP 或 HTTPS 链接。');
  let parsed;
  try { parsed = new URL(input); } catch { throw new Error('请输入包含 http:// 或 https:// 的有效链接。'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) throw new Error('内置浏览器只允许 HTTP 和 HTTPS 链接，不能包含账号密码。');
  return parsed.href;
}
function safeParts(input) {
  if (typeof input !== 'string' || !input || input.length > 4096 || /[\x00-\x1f<>:"|?*]/.test(input) || /^[\\/]/.test(input) || path.win32.isAbsolute(input)) throw new Error('预览文件必须使用项目内的相对路径。');
  const parts = input.split(/[\\/]/);
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) throw new Error('预览路径包含不支持的名称或目录跳转。');
  if (parts.some(part => BLOCKED.has(part.toLowerCase()) || SECRET.test(part) || /\.(?:pem|key|p12|pfx|keystore)$/i.test(part))) throw new Error('无法预览受保护配置、凭据或依赖目录。');
  if (!EXTENSIONS.has(path.extname(parts.at(-1)).toLowerCase())) throw new Error('此文件类型不支持浏览器预览。');
  return parts;
}
async function resolveStaticFile(root, relative) {
  const parts = safeParts(relative);
  const rootStat = await fsp.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !samePath(await fsp.realpath(root), root)) throw new Error('预览项目目录已变化，请重新打开项目。');
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = await fsp.lstat(current);
    if (stat.isSymbolicLink() || !samePath(await fsp.realpath(current), current) || !inside(root, current)) throw new Error('预览路径不能包含链接或超出项目目录。');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('预览路径的父级不是目录。');
    if (index === parts.length - 1) {
      if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_STATIC_BYTES) throw new Error('预览只支持单一普通文件，且最大 16 MB。');
      return { absolute: current, stat, relative: parts.join('/') };
    }
  }
}
function sameFile(left, right) {
  const sameDevice = left.dev === right.dev || (process.platform === 'win32' && (!left.dev || !right.dev));
  return sameDevice && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}
class ProjectPreviewServer {
  constructor(root) {
    const original = path.resolve(root);
    const stat = fs.lstatSync(original);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('预览项目必须是实际文件夹。');
    this.root = fs.realpathSync.native(original);
    this.token = randomBytes(24).toString('hex');
    this.server = null;
    this.starting = null;
    this.closed = false;
  }
  async start() {
    if (this.closed) throw new Error('预览服务已关闭。');
    if (this.starting) return this.starting;
    this.starting = (async () => {
      this.server = http.createServer((request, response) => this.serve(request, response));
      this.server.requestTimeout = 15000;
      this.server.headersTimeout = 10000;
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(0, '127.0.0.1', resolve);
      });
      if (this.closed) { this.server.close(); throw new Error('预览服务已关闭。'); }
      this.origin = `http://127.0.0.1:${this.server.address().port}`;
      return this.origin;
    })();
    return this.starting;
  }
  async urlFor(relative) {
    const file = await resolveStaticFile(this.root, relative);
    if (!/\.html?$/i.test(file.relative)) throw new Error('请选择 HTML 文件进行页面预览。');
    const origin = await this.start();
    return `${origin}/${this.token}/${file.relative.split('/').map(encodeURIComponent).join('/')}`;
  }
  isLocalURL(value) {
    try { const url = new URL(value); return url.origin === this.origin && url.pathname.startsWith('/' + this.token + '/'); } catch { return false; }
  }
  async serve(request, response) {
    const fail = (status, text) => { if (!response.headersSent) response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(text); };
    if (this.closed || !['GET', 'HEAD'].includes(request.method)) return fail(405, '预览只支持读取文件。');
    // Check the raw target before URL normalization, which would erase ../.
    const raw = (request.url || '').split('?')[0];
    let decoded;
    try { decoded = decodeURIComponent(raw); } catch { return fail(400, '预览路径无效。'); }
    if (!this.origin || request.headers.host !== new URL(this.origin).host || !decoded.startsWith('/' + this.token + '/')) return fail(403, '预览地址无效。');
    const relative = decoded.slice(this.token.length + 2);
    let handle;
    try {
      const file = await resolveStaticFile(this.root, relative);
      handle = await fsp.open(file.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const opened = await handle.stat();
      const rechecked = await resolveStaticFile(this.root, relative);
      if (!sameFile(file.stat, opened) || !sameFile(rechecked.stat, opened) || !opened.isFile() || opened.nlink > 1 || opened.size > MAX_STATIC_BYTES) throw new Error('预览文件已变化。');
      const content = await handle.readFile();
      if (content.length > MAX_STATIC_BYTES) throw new Error('预览文件过大。');
      response.writeHead(200, {
        'Content-Type': EXTENSIONS.get(path.extname(file.relative).toLowerCase()),
        'Content-Length': content.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer',
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch { fail(404, '文件不可预览、已变化或不存在。'); }
    finally { await handle?.close().catch(() => {}); }
  }
  close() { this.closed = true; this.server?.closeAllConnections(); this.server?.close(); }
}
function clampBrowserBounds(bounds, contentSize, topInset = 44) {
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) throw new Error('浏览器面板位置无效。');
  const [windowWidth, windowHeight] = contentSize;
  const x = Math.max(0, Math.min(Math.round(bounds.x), windowWidth));
  const y = Math.max(Math.min(topInset, windowHeight), Math.min(Math.round(bounds.y), windowHeight));
  return { x, y, width: Math.max(0, Math.min(Math.round(bounds.width), windowWidth - x)), height: Math.max(0, Math.min(Math.round(bounds.height), windowHeight - y)) };
}
module.exports = { validateBrowserURL, safeParts, resolveStaticFile, ProjectPreviewServer, clampBrowserBounds, MAX_STATIC_BYTES };
