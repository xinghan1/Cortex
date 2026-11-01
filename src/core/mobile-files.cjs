'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');

const EDIT_LIMIT = 2 * 1024 * 1024;
const DOWNLOAD_LIMIT = 100 * 1024 * 1024;
const fail = (status, message) => Object.assign(new Error(message), { status });
function absolutePath(value) {
  if (typeof value !== 'string' || !value || value.length > 32768 || value.includes('\0') || !path.isAbsolute(value)) throw fail(400, '必须提供有效的电脑绝对路径');
  if (process.platform === 'win32') {
    if (/^(?:\\\\[.?]\\|\\\?\?\\)/.test(value)) throw fail(400, '不支持设备路径');
    const parts = value.replaceAll('/', '\\').split('\\');
    if (parts.some((part, index) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part) || (part.includes(':') && !(index===0 && /^[a-z]:$/i.test(part))))) throw fail(400, '不支持设备或数据流路径');
  }
  return path.normalize(value);
}
async function regularFile(file) {
  const handle = await fs.promises.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw fail(400, '路径不是普通文件');
    return { handle, stat };
  } catch (error) { await handle.close(); throw error; }
}
async function readBounded(handle) {
  const buffer=Buffer.alloc(EDIT_LIMIT+1); let offset=0;
  while(offset<buffer.length) { const {bytesRead}=await handle.read(buffer,offset,buffer.length-offset,offset); if(!bytesRead) break; offset+=bytesRead; }
  return buffer.subarray(0,offset);
}
async function mobileFiles(action, body, activateProject) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw fail(400, '请求参数无效');
  if (action === 'list' && (body.path === '' || body.path == null)) {
    const roots = process.platform === 'win32' ? Array.from({length:26}, (_,i)=>`${String.fromCharCode(65+i)}:\\`) : ['/'];
    const available = await Promise.all(roots.map(async root => { try { await fs.promises.access(root); return {name:root,path:root,type:'directory'}; } catch { return null; } }));
    return { path:'', parent:null, entries:available.filter(Boolean) };
  }
  const target = absolutePath(body.path);
  if (action === 'list') {
    const entries = await fs.promises.readdir(target, { withFileTypes: true });
    if (entries.length > 10000) throw fail(413, '目录项目过多');
    return { path: target, parent: path.dirname(target), entries: entries.map(entry => ({ name: entry.name, path: path.join(target, entry.name), type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other' })).sort((a, b) => a.name.localeCompare(b.name)) };
  }
  if (action === 'project') {
    await fs.promises.mkdir(target);
    try { await activateProject(target); } catch (error) { throw fail(500, `目录已创建，但打开项目失败：${String(error.message || error).slice(0, 200)}`); }
    return { path: target };
  }
  if (action === 'read') {
    const { handle, stat } = await regularFile(target);
    try {
      if (stat.size > EDIT_LIMIT) throw fail(413, '文件超过编辑大小限制');
      const bytes = await readBounded(handle);
      if (bytes.length > EDIT_LIMIT) throw fail(413, '文件超过编辑大小限制');
      if (bytes.includes(0)) throw fail(415, '不支持编辑二进制文件');
      let content;
      try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw fail(415, '文件不是有效的 UTF-8 文本'); }
      return { path: target, content, version: crypto.createHash('sha256').update(bytes).digest('hex') };
    } finally { await handle.close(); }
  }
  if (action === 'write') {
    if (typeof body.content !== 'string') throw fail(400, '文件内容无效');
    if (typeof body.version !== 'string' || !/^[0-9a-f]{64}$/.test(body.version)) throw fail(400, '缺少文件版本，请重新读取');
    if (Buffer.byteLength(body.content, 'utf8') > EDIT_LIMIT) throw fail(413, '文件超过编辑大小限制');
    // Never create a missing file or truncate a directory; edit only existing regular files.
    const handle = await fs.promises.open(target, 'r+');
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw fail(400, '路径不是普通文件');
      if (stat.size > EDIT_LIMIT) throw fail(413, '文件超过编辑大小限制');
      const current = await readBounded(handle);
      if (current.length > EDIT_LIMIT || crypto.createHash('sha256').update(current).digest('hex') !== body.version) throw fail(409, '电脑上的文件已更改，请重新读取后再保存');
      const bytes = Buffer.from(body.content, 'utf8');
      let offset = 0;
      while (offset < bytes.length) { const {bytesWritten} = await handle.write(bytes, offset, bytes.length-offset, offset); if (!bytesWritten) throw fail(500, '保存失败'); offset += bytesWritten; }
      await handle.truncate(bytes.length);
      await handle.sync();
      return { path: target, saved: true, version: crypto.createHash('sha256').update(bytes).digest('hex') };
    } finally { await handle.close(); }
  }
  if (action === 'download') {
    const { handle, stat } = await regularFile(target);
    if (stat.size > DOWNLOAD_LIMIT) { await handle.close(); throw fail(413, '文件超过下载大小限制'); }
    return { handle, size: stat.size, name: path.basename(target) };
  }
  throw fail(404, '不存在');
}
module.exports = { mobileFiles, EDIT_LIMIT, DOWNLOAD_LIMIT };
