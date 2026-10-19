import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { withFileCommit } from './file-commit.mjs';

const MAX_TEXT_BYTES = 512 * 1024;
const BLOCKED_DIRECTORIES = new Set(['.git', '.codex', '.aws', '.ssh', '.azure', '.gnupg', '.npm', '.npm-cache', 'node_modules']);
// Keep the same protected path boundary as WorkspaceTools. Manual operations
// are separate from the AI tool table and never send file contents to a model.
const SECRET_FILES = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const SECRET_EXTENSIONS = /\.(?:pem|key|p12|pfx|keystore)$/i;
const RESERVED_NAMES = /^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i;
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const versionOf = buffer => createHash('sha256').update(buffer).digest('hex');
const samePath = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
const sameFile = (left, right) => left.ino === right.ino && left.birthtimeMs === right.birthtimeMs
  && (left.dev === right.dev || (process.platform === 'win32' && (!left.dev || !right.dev)));
const unchanged = (left, right) => sameFile(left, right) && left.size === right.size
  && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

class FileManagerError extends Error {
  constructor(message, code) { super(message); this.name = 'FileManagerError'; this.code = code; }
}
function fail(message, code = 'FILE_OPERATION_FAILED') { throw new FileManagerError(message, code); }
function safeName(name) { return !BLOCKED_DIRECTORIES.has(name.toLowerCase()) && !SECRET_FILES.test(name) && !SECRET_EXTENSIONS.test(name); }
function safeError(error) {
  if (error instanceof FileManagerError) return error;
  const messages = {
    EEXIST: ['该名称已存在，请选择其他名称。', 'FILE_EXISTS'],
    ENOENT: ['文件或目录已不存在，请刷新资源管理器。', 'FILE_NOT_FOUND'],
    EACCES: ['没有操作权限，请检查文件权限或占用情况。', 'FILE_PERMISSION_DENIED'],
    EPERM: ['无法操作文件，请检查权限或占用情况。', 'FILE_PERMISSION_DENIED'],
    ENOTDIR: ['目标的父级不是目录。', 'FILE_TYPE_MISMATCH'],
    EISDIR: ['此操作需要常规文件。', 'FILE_TYPE_MISMATCH'],
    EXDEV: ['无法跨文件系统移动此项目，请选择同一磁盘内的目录。', 'FILE_CROSS_DEVICE'],
  };
  const [message, code] = messages[error?.code] ?? ['文件操作失败，请刷新后重试。', 'FILE_OPERATION_FAILED'];
  return new FileManagerError(message, code);
}

async function moveNoReplace(source, target, directory) {
  // Node's Windows rename uses replacement semantics, including replacing an
  // existing file with a directory. The built-in .NET two-argument Move APIs
  // atomically reject every existing destination and work on exFAT as well.
  // Paths are UTF-8 base64 data in a fixed script, never PowerShell source.
  if (process.platform !== 'win32') fail('手动移动功能需要 Windows，请使用系统文件管理器。', 'FILE_MOVE_UNAVAILABLE');
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  if (!path.win32.isAbsolute(systemRoot)) fail('Windows 系统目录无效，无法安全移动文件。', 'FILE_MOVE_UNAVAILABLE');
  const executable = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encodedPath = value => Buffer.from(value, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop';$src=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath(source)}'));$dst=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath(target)}'));try{[IO.${directory ? 'Directory' : 'File'}]::Move($src,$dst);[Console]::Out.Write('OK');exit 0}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};$code=$e.HResult -band 65535;if($code -eq 80 -or $code -eq 183){[Console]::Out.Write('FILE_EXISTS')}elseif($code -eq 2 -or $code -eq 3){[Console]::Out.Write('FILE_NOT_FOUND')}elseif($code -eq 5 -or $code -eq 32 -or $code -eq 33){[Console]::Out.Write('FILE_PERMISSION_DENIED')}elseif($code -eq 17){[Console]::Out.Write('FILE_CROSS_DEVICE')}else{[Console]::Out.Write('FILE_OPERATION_FAILED')};exit 1}`;
  const result = await new Promise(resolve => {
    childProcess.execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024, encoding: 'utf8' }, (error, stdout) => resolve({ error, status: String(stdout || '').trim() }));
  });
  if (!result.error && result.status === 'OK') return;
  const messages = {
    FILE_EXISTS: '目标名称已被使用，未移动或覆盖文件。',
    FILE_NOT_FOUND: '文件或目录已不存在，请刷新资源管理器。',
    FILE_PERMISSION_DENIED: '无法移动文件，请检查权限或占用情况。',
    FILE_CROSS_DEVICE: '无法跨文件系统移动此项目，请选择同一磁盘内的目录。',
  };
  if (messages[result.status]) fail(messages[result.status], result.status);
  if (result.error?.killed) fail('移动操作超时，请刷新后确认文件位置。', 'FILE_MOVE_TIMEOUT');
  fail('无法完成安全移动，请刷新后重试或使用系统文件管理器。', 'FILE_MOVE_UNAVAILABLE');
}

export class ManualFileManager {
  #rootStat;
  #trash;
  #maxCopyEntries;
  #maxCopyBytes;
  #maxDepth;

  constructor(root, { trash, maxCopyEntries = 2000, maxCopyBytes = 128 * 1024 * 1024, maxDepth = 40 } = {}) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || root.includes('\0')) fail('请选择实际的绝对项目目录。', 'FILE_INVALID_ROOT');
    if ((trash !== undefined && typeof trash !== 'function') || !Number.isSafeInteger(maxCopyEntries) || maxCopyEntries < 1 || maxCopyEntries > 10000
        || !Number.isSafeInteger(maxCopyBytes) || maxCopyBytes < 1 || maxCopyBytes > 1024 * 1024 * 1024
        || !Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 100) fail('文件管理器配置无效。', 'FILE_INVALID_CONFIG');
    try {
      const original = path.resolve(root);
      const stat = fs.lstatSync(original);
      const canonical = fs.realpathSync.native(original);
      if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(canonical, original)) fail('项目根目录必须是实际目录，不能包含符号链接或联接。', 'FILE_INVALID_ROOT');
      Object.defineProperty(this, 'root', { value: canonical, enumerable: true });
      this.#rootStat = stat;
    } catch (error) { throw error instanceof FileManagerError ? error : new FileManagerError('项目根目录不可访问。', 'FILE_INVALID_ROOT'); }
    this.#trash = trash;
    this.#maxCopyEntries = maxCopyEntries; this.#maxCopyBytes = maxCopyBytes; this.#maxDepth = maxDepth;
  }

  async #guard(operation) { try { return await operation(); } catch (error) { throw safeError(error); } }
  #mutate(operation) {
    // Share commit ordering with AI writes and other windows, including
    // overlapping project roots. Dialog confirmation happens before this call.
    return withFileCommit(() => this.#guard(operation));
  }
  #parts(input, allowRoot = false) {
    if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x1f\x7f-\x9f<>:"|?*]/u.test(input)
        || /^[\\/]/u.test(input) || path.win32.isAbsolute(input) || path.posix.isAbsolute(input)) fail('仅允许项目内的相对路径，不能使用绝对、设备或备用数据流路径。', 'FILE_INVALID_PATH');
    const parts = input.split(/[\\/]+/u).filter(part => part && part !== '.');
    for (const part of parts) {
      if (part === '..' || part.length > 255 || /[. ]$/u.test(part) || RESERVED_NAMES.test(part.trim())) fail('路径包含目录跳转或不允许的 Windows 名称。', 'FILE_INVALID_PATH');
      if (!safeName(part)) fail('此路径属于依赖目录、受保护配置或密钥文件，无法操作。', 'FILE_PROTECTED_PATH');
    }
    if (!allowRoot && !parts.length) fail('不能对项目根目录执行此操作，请选择具体文件或目录。', 'FILE_ROOT_OPERATION');
    return parts;
  }
  #name(name) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/]/u.test(name)) fail('请输入不含路径分隔符的文件或文件夹名称。', 'FILE_INVALID_NAME');
    this.#parts(name);
    return name;
  }
  async #resolve(input = '', { allowRoot = false, allowMissing = false } = {}) {
    const parts = this.#parts(input, allowRoot);
    const rootStat = await fsp.lstat(this.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !sameFile(rootStat, this.#rootStat)
        || !samePath(await fsp.realpath(this.root), this.root)) fail('项目根目录已变化，请重新打开项目。', 'FILE_ROOT_CHANGED');
    let absolute = this.root, stat = rootStat;
    for (let index = 0; index < parts.length; index++) {
      absolute = path.join(absolute, parts[index]);
      try { stat = await fsp.lstat(absolute); }
      catch (error) {
        if (error.code === 'ENOENT' && allowMissing && index === parts.length - 1) return { absolute, relative: parts.join('/'), parts, exists: false };
        throw error;
      }
      if (stat.isSymbolicLink()) fail('不允许访问符号链接或 Windows 目录联接。', 'FILE_LINK_UNSUPPORTED');
      if (!stat.isFile() && !stat.isDirectory()) fail('仅支持常规文件与目录。', 'FILE_TYPE_MISMATCH');
      if (stat.isFile() && stat.nlink > 1) fail('不允许操作具有多个硬链接的文件。', 'FILE_LINK_UNSUPPORTED');
      if (index < parts.length - 1 && !stat.isDirectory()) fail('路径的父级不是目录。', 'FILE_TYPE_MISMATCH');
      if (!samePath(await fsp.realpath(absolute), absolute)) fail('路径包含重定向，无法操作。', 'FILE_LINK_UNSUPPORTED');
    }
    return { absolute, relative: parts.join('/'), parts, stat, exists: true };
  }
  async #directory(input = '') {
    const target = await this.#resolve(input, { allowRoot: true });
    if (!target.stat.isDirectory()) fail('请选择目标文件夹。', 'FILE_TYPE_MISMATCH');
    return target;
  }
  async #snapshot(input) {
    const target = await this.#resolve(input);
    if (!target.stat.isFile()) fail('只能编辑常规文件。', 'FILE_TYPE_MISMATCH');
    if (target.stat.size > MAX_TEXT_BYTES) fail('编辑仅支持 512 KiB 以内的 UTF-8 文件。', 'FILE_TOO_LARGE');
    const handle = await fsp.open(target.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const initial = await handle.stat();
      if (!initial.isFile() || initial.nlink > 1 || initial.size > MAX_TEXT_BYTES || !unchanged(initial, (await this.#resolve(input)).stat)) fail('文件在读取时发生变化，请重新打开。', 'FILE_CHANGED');
      const buffer = Buffer.alloc(MAX_TEXT_BYTES + 1);
      let count = 0;
      while (count < buffer.length) {
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
        if (!bytesRead) break;
        count += bytesRead;
      }
      if (count > MAX_TEXT_BYTES) fail('编辑仅支持 512 KiB 以内的 UTF-8 文件。', 'FILE_TOO_LARGE');
      const checked = await this.#resolve(input), after = await handle.stat();
      if (!unchanged(initial, after) || !sameFile(initial, checked.stat)) fail('文件在读取时发生变化，请重新打开。', 'FILE_CHANGED');
      const bytes = buffer.subarray(0, count);
      if (bytes.includes(0)) fail('二进制文件可以复制或移动，不能在文本编辑器中打开。', 'FILE_BINARY_UNSUPPORTED');
      let content;
      try { content = decoder.decode(bytes); } catch { fail('文本编辑仅支持有效的 UTF-8 文件。', 'FILE_ENCODING_UNSUPPORTED'); }
      return { ...checked, content, version: versionOf(bytes) };
    } finally { await handle.close(); }
  }
  async #tree(target, { copy = false } = {}) {
    const entries = [];
    let bytes = 0;
    const visit = async (input, depth) => {
      if (depth > this.#maxDepth) fail('目录层级过深，无法安全操作。', 'FILE_COPY_LIMIT');
      const entry = await this.#resolve(input);
      entries.push(entry);
      if (entries.length > this.#maxCopyEntries) fail('目录项目过多，请分批操作。', 'FILE_COPY_LIMIT');
      if (entry.stat.isFile()) {
        bytes += entry.stat.size;
        if (copy && bytes > this.#maxCopyBytes) fail('复制总大小超过上限，请分批操作。', 'FILE_COPY_LIMIT');
      } else {
        const children = await fsp.readdir(entry.absolute);
        children.sort();
        for (const name of children) await visit(`${entry.relative}/${name}`, depth + 1);
      }
    };
    await visit(target.relative, 0);
    return entries;
  }
  async #verifyTree(entries) {
    for (const entry of entries) {
      if (!unchanged((await this.#resolve(entry.relative)).stat, entry.stat)) fail('目录或文件在操作期间发生变化，请刷新后重试。', 'FILE_CHANGED');
    }
  }

  list({ path: input = '' } = {}) { return this.#guard(async () => {
    const target = await this.#directory(input), entries = await fsp.readdir(target.absolute, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const result = [];
    for (const entry of entries) {
      if (!safeName(entry.name) || entry.isSymbolicLink()) continue;
      try {
        const child = await this.#resolve(target.relative ? `${target.relative}/${entry.name}` : entry.name);
        result.push({ name: entry.name, path: child.relative, type: child.stat.isDirectory() ? 'directory' : 'file' });
      } catch { continue; }
      if (result.length >= 500) break;
    }
    return result;
  }); }
  read({ path: input } = {}) { return this.#guard(async () => {
    const result = await this.#snapshot(input);
    return { path: result.relative, content: result.content, version: result.version };
  }); }
  paths({ path: input = '' } = {}) { return this.#guard(async () => {
    const target = await this.#resolve(input, { allowRoot: true });
    return { absolute: target.absolute, relative: target.relative };
  }); }
  create({ parent = '', name, type } = {}) { return this.#mutate(async () => {
    if (!['file', 'directory'].includes(type)) fail('创建类型必须是文件或文件夹。', 'FILE_INVALID_TYPE');
    name = this.#name(name);
    const directory = await this.#directory(parent);
    const relative = directory.relative ? `${directory.relative}/${name}` : name;
    const target = await this.#resolve(relative, { allowMissing: true });
    if (target.exists) fail('该名称已存在，请选择其他名称。', 'FILE_EXISTS');
    if (type === 'directory') await fsp.mkdir(target.absolute);
    else {
      const handle = await fsp.open(target.absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      await handle.close();
    }
    await this.#resolve(relative);
    return { path: relative, type };
  }); }
  rename({ path: input, name } = {}) { return this.#mutate(async () => {
    name = this.#name(name);
    const source = await this.#resolve(input), type = source.stat.isDirectory() ? 'directory' : 'file';
    const relative = [...source.parts.slice(0, -1), name].join('/');
    if (relative === source.relative) return { path: relative, oldPath: source.relative, type };
    const entries = await this.#tree(source);
    const target = await this.#resolve(relative, { allowMissing: true });
    const caseOnly = target.exists && samePath(target.absolute, source.absolute) && sameFile(target.stat, source.stat);
    if (target.exists && !caseOnly) fail('该名称已存在，请选择其他名称。', 'FILE_EXISTS');
    await this.#verifyTree(entries);
    if (caseOnly) await fsp.rename(source.absolute, target.absolute);
    else await moveNoReplace(source.absolute, target.absolute, type === 'directory');
    await this.#resolve(relative);
    return { path: relative, oldPath: source.relative, type };
  }); }
  copyOrMove({ source: input, destination = '', mode } = {}) { return this.#mutate(async () => {
    if (!['copy', 'cut'].includes(mode)) fail('请选择复制或剪切。', 'FILE_INVALID_MODE');
    const source = await this.#resolve(input), directory = await this.#directory(destination);
    const type = source.stat.isDirectory() ? 'directory' : 'file';
    const child = path.relative(source.absolute, directory.absolute);
    if (type === 'directory' && (child === '' || (!child.startsWith(`..${path.sep}`) && child !== '..' && !path.isAbsolute(child)))) fail('不能将文件夹粘贴到自身或其子目录。', 'FILE_SELF_DESTINATION');
    const join = name => directory.relative ? `${directory.relative}/${name}` : name;
    const base = source.parts.at(-1);
    let relative = join(base), target = await this.#resolve(relative, { allowMissing: true });
    if (mode === 'cut' && samePath(target.absolute, source.absolute)) return { path: source.relative, source: source.relative, mode, type };
    if (target.exists && mode === 'cut') fail('目标已存在同名项目，未移动或覆盖。', 'FILE_EXISTS');
    if (target.exists) {
      const extension = type === 'file' ? path.extname(base) : '', stem = extension ? base.slice(0, -extension.length) : base;
      for (let index = 1; index <= 999; index++) {
        const name = `${stem} - 副本${index === 1 ? '' : ` (${index})`}${extension}`;
        this.#name(name);
        relative = join(name); target = await this.#resolve(relative, { allowMissing: true });
        if (!target.exists) break;
      }
      if (target.exists) fail('无法生成未使用的副本名称，请重命名后复制。', 'FILE_EXISTS');
    }
    const entries = await this.#tree(source, { copy: mode === 'copy' });
    if (mode === 'cut') {
      if ((await this.#resolve(relative, { allowMissing: true })).exists) fail('目标名称已被使用，未移动文件。', 'FILE_EXISTS');
      await this.#verifyTree(entries);
      await moveNoReplace(source.absolute, target.absolute, type === 'directory');
    } else {
      const created = [], budget = { bytes: 0 };
      try {
        for (const entry of entries) {
          const newRelative = relative + entry.relative.slice(source.relative.length);
          const checked = await this.#resolve(entry.relative);
          if (!unchanged(checked.stat, entry.stat)) fail('复制源在操作期间发生变化，已取消复制。', 'FILE_CHANGED');
          const next = await this.#resolve(newRelative, { allowMissing: true });
          if (next.exists) fail('复制目标名称已被使用，未覆盖文件。', 'FILE_EXISTS');
          if (entry.stat.isDirectory()) {
            await fsp.mkdir(next.absolute);
            created.push(await this.#resolve(newRelative));
          } else await this.#copyFile(checked, next, budget, created);
        }
        await this.#verifyTree(entries);
      } catch (error) { await this.#cleanup(created); throw error; }
    }
    await this.#resolve(relative);
    return { path: relative, source: source.relative, mode, type };
  }); }
  async #copyFile(source, target, budget, created) {
    const readHandle = await fsp.open(source.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let writeHandle;
    try {
      if (!unchanged(await readHandle.stat(), source.stat) || !unchanged((await this.#resolve(source.relative)).stat, source.stat)) fail('复制源已变化，已停止复制。', 'FILE_CHANGED');
      await this.#directory(target.parts.slice(0, -1).join('/'));
      writeHandle = await fsp.open(target.absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), source.stat.mode & 0o777);
      const stat = await writeHandle.stat();
      created.push({ ...target, stat });
      if (!sameFile((await this.#resolve(target.relative)).stat, stat)) fail('复制目标已变化，已停止复制。', 'FILE_CHANGED');
      const buffer = Buffer.alloc(64 * 1024);
      for (;;) {
        const { bytesRead } = await readHandle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        budget.bytes += bytesRead;
        if (budget.bytes > this.#maxCopyBytes) fail('复制总大小超过上限，已停止复制。', 'FILE_COPY_LIMIT');
        let offset = 0;
        while (offset < bytesRead) {
          const { bytesWritten } = await writeHandle.write(buffer, offset, bytesRead - offset, null);
          if (!bytesWritten) fail('复制写入未能完成。');
          offset += bytesWritten;
        }
      }
      if (!unchanged(await readHandle.stat(), source.stat) || !unchanged((await this.#resolve(source.relative)).stat, source.stat)) fail('复制源在读取期间发生变化，已取消复制。', 'FILE_CHANGED');
    } finally { await writeHandle?.close(); await readHandle.close(); }
  }
  async #cleanup(created) {
    for (const entry of created.toReversed()) {
      try {
        const current = await this.#resolve(entry.relative);
        if (!sameFile(current.stat, entry.stat)) continue;
        if (current.stat.isDirectory()) await fsp.rmdir(current.absolute);
        else await fsp.unlink(current.absolute);
      } catch { /* Never follow changed paths or recursively remove unknown files. */ }
    }
  }
  remove({ path: input } = {}) { return this.#mutate(async () => {
    if (typeof this.#trash !== 'function') fail('未配置系统回收站，无法删除文件。', 'TRASH_UNAVAILABLE');
    const source = await this.#resolve(input);
    const entries = await this.#tree(source);
    await this.#verifyTree(entries);
    await this.#trash(source.absolute);
    return { path: source.relative, deleted: true };
  }); }
  save({ path: input, content, expectedVersion } = {}) { return this.#mutate(async () => {
    if (typeof content !== 'string' || content.includes('\0')) fail('保存仅支持不含二进制空字符的文本。', 'FILE_BINARY_UNSUPPORTED');
    if (typeof expectedVersion !== 'string' || !/^[a-f\d]{64}$/iu.test(expectedVersion)) fail('缺少有效文件版本，请重新打开文件。', 'FILE_VERSION_CONFLICT');
    if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) fail('编辑仅支持 512 KiB 以内的 UTF-8 文件。', 'FILE_TOO_LARGE');
    const bytes = Buffer.from(content, 'utf8');
    if (decoder.decode(bytes) !== content) fail('保存内容包含无法编码为 UTF-8 的字符。', 'FILE_ENCODING_UNSUPPORTED');
    const before = await this.#snapshot(input);
    if (before.version !== expectedVersion.toLowerCase()) fail('文件已被其他操作修改，请重新打开后合并改动。', 'FILE_VERSION_CONFLICT');
    const parent = before.parts.slice(0, -1).join('/');
    const temporary = parent ? `${parent}/.manual-save-${randomUUID()}.tmp` : `.manual-save-${randomUUID()}.tmp`;
    const target = await this.#resolve(temporary, { allowMissing: true });
    let created;
    try {
      const handle = await fsp.open(target.absolute, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), before.stat.mode & 0o777);
      try {
        created = { ...target, stat: await handle.stat() };
        if (!sameFile((await this.#resolve(temporary)).stat, created.stat)) fail('保存目标目录已变化，请重试。', 'FILE_CHANGED');
        await handle.writeFile(bytes); await handle.sync();
        created.stat = await handle.stat();
      } finally { await handle.close(); }
      // Windows can briefly deny atomic replacement while another reader or
      // file scanner holds the target. Retry only that commit, with the same
      // pinned version/identity checks every time; never truncate or delete it.
      const retryDelays = process.platform === 'win32' ? [25, 50, 100] : [];
      for (let attempt = 0; ; attempt++) {
        const latest = await this.#snapshot(input);
        if (latest.version !== before.version || !unchanged(latest.stat, before.stat)) fail('文件在保存期间发生变化，未覆盖外部改动。', 'FILE_VERSION_CONFLICT');
        const replacement = await this.#resolve(temporary);
        if (!unchanged(replacement.stat, created.stat)) fail('临时保存文件在提交前发生变化，已取消保存。', 'FILE_CHANGED');
        await this.#directory(parent);
        try {
          await fsp.rename(replacement.absolute, latest.absolute);
          created = undefined;
          return { path: latest.relative, content, version: versionOf(bytes) };
        } catch (error) {
          if (attempt >= retryDelays.length || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
          await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
        }
      }
    } finally { if (created) await this.#cleanup([created]); }
  }); }
}
