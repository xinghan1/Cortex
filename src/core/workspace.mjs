import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TextDecoder } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { withFileCommit } from './file-commit.mjs';
import { taskUndoPlan } from './task-change-undo.mjs';

const MAX_FILE_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_COMMAND_TIMEOUT = 600_000;
const MAX_COMMAND_TIMEOUT = 600_000;
const MAX_LIST_ENTRIES = 500;
const WINDOWS_SYSTEM = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const POWERSHELL = process.platform === 'win32'
  ? path.join(WINDOWS_SYSTEM, 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'pwsh';
const BLOCKED_DIRECTORIES = new Set([
  '.git', '.codex', '.aws', '.ssh', '.azure', '.gnupg', '.npm', '.npm-cache',
  'node_modules',
]);
const SECRET_FILES = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const SECRET_EXTENSIONS = /\.(?:pem|key|p12|pfx|keystore)$/i;
const RESERVED_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const decoder = new TextDecoder('utf-8', { fatal: true });

const objectSchema = (properties, required = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const relativePath = { type: 'string', description: '相对项目根目录的路径，使用正斜线。' };

export const TOOL_DEFINITIONS = [
  {
    name: 'list_files', description: '列出项目目录中的文件与子目录，最多 500 项。',
    parameters: objectSchema({ path: relativePath }),
  },
  {
    name: 'read_file', description: '读取项目中的 UTF-8 文本文件，最大 512 KB。凭据与密钥文件不可读取。',
    parameters: objectSchema({ path: relativePath }, ['path']),
  },
  {
    name: 'search_files', description: '在项目文本文件中搜索字面文本，最多 100 处命中，跳过隐藏目录和构建产物。',
    parameters: objectSchema({
      query: { type: 'string', description: '要搜索的字面文本，不是正则表达式。' },
      path: relativePath,
      case_sensitive: { type: 'boolean', description: '是否区分大小写，默认 false。' },
      max_results: { type: 'integer', minimum: 1, maximum: 100 },
    }, ['query']),
  },
  {
    name: 'write_file', description: '请求用户审批后创建或完整更新文本文件。先读取现有文件，审批后检查并发修改。',
    parameters: objectSchema({ path: relativePath, content: { type: 'string' } }, ['path', 'content']),
  },
  {
    name: 'replace_in_file', description: '请求用户审批后替换文件中恰好出现一次的文本；零次或多次匹配都会拒绝。',
    parameters: objectSchema({
      path: relativePath, old_text: { type: 'string' }, new_text: { type: 'string' },
    }, ['path', 'old_text', 'new_text']),
  },
  {
    name: 'run_command', description: '按当前权限模式审批后在项目目录运行 PowerShell 命令。命令没有系统沙箱；默认和最长均为 10 分钟，只有需要更短时才设置 timeout_ms，输出最多 64 KB。',
    parameters: objectSchema({
      command: { type: 'string' },
      timeout_ms: { type: 'integer', minimum: 1000, maximum: MAX_COMMAND_TIMEOUT },
    }, ['command']),
  },
  {
    name: 'undo_last_change', description: '请求用户审批后撤销本次打开项目期间最近一次文件修改。若文件已被用户修改，则拒绝覆盖；重启后不保留撤销历史。',
    parameters: objectSchema({}),
  },
];

function abortIfNeeded(signal) {
  if (signal?.aborted) throw new Error('任务已取消。');
}

function safeName(name) {
  return !BLOCKED_DIRECTORIES.has(name.toLowerCase()) && !SECRET_FILES.test(name) && !SECRET_EXTENSIONS.test(name);
}

function sameFile(a, b) {
  // Node on Windows can report dev=0 from path-based lstat while fstat reports the volume ID.
  const sameDevice = a.dev === b.dev || (process.platform === 'win32' && (!a.dev || !b.dev));
  return sameDevice && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs;
}

function textBuffer(content) {
  if (typeof content !== 'string') throw new Error('文件内容必须为字符串。');
  if (content.includes('\0')) throw new Error('不支持二进制文件。');
  const buffer = Buffer.from(content, 'utf8');
  if (buffer.length > MAX_FILE_BYTES) throw new Error('文件大小超过 512 KB 上限。');
  return buffer;
}

function decodeText(buffer) {
  if (buffer.includes(0)) throw new Error('不支持二进制文件。');
  try { return decoder.decode(buffer); }
  catch { throw new Error('只支持有效的 UTF-8 文本文件。'); }
}

export class WorkspaceTools {
  #observedFiles = new Map();

  constructor(root, { approve, onEvent } = {}) {
    if (typeof root !== 'string' || !root) throw new Error('请选择项目根目录。');
    const original = path.resolve(root);
    const stat = fs.lstatSync(original);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('项目根目录必须是实际目录，不能是符号链接或联接。');
    this.root = fs.realpathSync.native(original);
    this.approve = typeof approve === 'function' ? approve : async () => false;
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {};
    this.history = [];
  }

  #parts(input = '', allowRoot = false) {
    if (typeof input !== 'string') throw new Error('路径必须是字符串。');
    if (/[\x00-\x1f<>:"|?*]/.test(input) || /^[\\/]/.test(input) || path.win32.isAbsolute(input) || path.posix.isAbsolute(input)) {
      throw new Error('只允许项目内的相对路径，不允许绝对路径、设备路径或备用数据流。');
    }
    const parts = input.split(/[\\/]+/).filter(part => part && part !== '.');
    for (const part of parts) {
      if (part === '..' || /[. ]$/.test(part) || RESERVED_NAMES.test(part)) throw new Error('路径包含不允许的目录跳转或名称。');
      if (!safeName(part)) throw new Error('此路径属于依赖目录、受保护配置或密钥文件，无法访问。');
    }
    if (!allowRoot && !parts.length) throw new Error('必须指定文件路径。');
    return parts;
  }

  async #resolve(input = '', { allowRoot = false, allowMissing = false } = {}) {
    const parts = this.#parts(input, allowRoot);
    const rootStat = await fsp.lstat(this.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !this.#samePath(await fsp.realpath(this.root), this.root)) {
      throw new Error('项目根目录已变化，请重新打开项目。');
    }
    let current = this.root;
    let lastStat = rootStat;
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      try { lastStat = await fsp.lstat(current); }
      catch (error) {
        if (error.code === 'ENOENT' && allowMissing) {
          return { absolute: path.join(this.root, ...parts), relative: parts.join('/'), exists: false, parts };
        }
        throw error;
      }
      if (lastStat.isSymbolicLink()) throw new Error('不允许访问符号链接或 Windows 目录联接。');
      if (index < parts.length - 1 && !lastStat.isDirectory()) throw new Error('路径的父级不是目录。');
      const canonical = await fsp.realpath(current);
      if (!this.#samePath(canonical, current) || !this.#inside(canonical)) throw new Error('路径超出项目目录或包含重定向。');
    }
    return { absolute: current, relative: parts.join('/'), exists: true, stat: lastStat, parts };
  }

  #samePath(left, right) {
    return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  }

  #inside(target) {
    const relative = path.relative(this.root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  }

  async listFiles({ path: input = '' } = {}) {
    const target = await this.#resolve(input, { allowRoot: true });
    if (!target.stat.isDirectory()) throw new Error('目标不是目录。');
    const entries = await fsp.readdir(target.absolute, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const output = [];
    for (const entry of entries) {
      if (!safeName(entry.name) || entry.isSymbolicLink()) continue;
      const child = target.relative ? `${target.relative}/${entry.name}` : entry.name;
      try {
        const resolved = await this.#resolve(child);
        if (!resolved.stat.isDirectory() && !resolved.stat.isFile()) continue;
        output.push({ name: entry.name, path: child, type: resolved.stat.isDirectory() ? 'directory' : 'file' });
      } catch { continue; }
      if (output.length >= MAX_LIST_ENTRIES) break;
    }
    return output;
  }

  async #readSnapshot(input) {
    const target = await this.#resolve(input);
    if (!target.stat.isFile()) throw new Error('目标不是常规文件。');
    if (target.stat.size > MAX_FILE_BYTES) throw new Error('文件大小超过 512 KB 上限。');
    const handle = await fsp.open(target.absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > MAX_FILE_BYTES) throw new Error('只支持 512 KB 以内的常规文件。');
      const checked = await this.#resolve(input);
      if (!sameFile(opened, checked.stat)) throw new Error('文件在读取期间发生变化，请重试。');
      // Read a fixed maximum to avoid an unbounded allocation if another process grows the file.
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
        if (!bytesRead) break;
        total += bytesRead;
      }
      if (total > MAX_FILE_BYTES) throw new Error('文件大小超过 512 KB 上限。');
      const after = await this.#resolve(input);
      const endStat = await handle.stat();
      if (!sameFile(opened, after.stat) || opened.mtimeMs !== endStat.mtimeMs || opened.size !== endStat.size) {
        throw new Error('文件在读取期间发生变化，请重试。');
      }
      return { target: after, content: decodeText(buffer.subarray(0, total)) };
    } finally { await handle.close(); }
  }

  async readFile({ path: input }) {
    return withFileCommit(async () => {
      const snapshot = await this.#readSnapshot(input);
      this.#rememberFile(snapshot.target.relative, snapshot.content, snapshot.target.stat);
      return { path: snapshot.target.relative, content: snapshot.content };
    });
  }

  #observationKey(input) {
    const relative = this.#parts(input).join('/');
    return process.platform === 'win32' ? relative.toLowerCase() : relative;
  }

  #rememberFile(input, content, stat) {
    const key = this.#observationKey(input);
    this.#observedFiles.delete(key);
    this.#observedFiles.set(key, { hash: createHash('sha256').update(content).digest('hex'), stat });
    if (this.#observedFiles.size > 1000) this.#observedFiles.delete(this.#observedFiles.keys().next().value);
  }

  #requireObservedFile(input, snapshot) {
    const observed = this.#observedFiles.get(this.#observationKey(input));
    if (!observed) return;
    if (!snapshot || observed.hash !== createHash('sha256').update(snapshot.content).digest('hex')
        || !sameFile(observed.stat, snapshot.target.stat) || observed.stat.mtimeMs !== snapshot.target.stat.mtimeMs) {
      throw new Error('文件在读取后已发生变化，请重新读取后再修改，已保留当前内容。');
    }
  }

  async #search({ query, path: input = '', case_sensitive = false, max_results = 100 }, signal) {
    if (typeof query !== 'string' || !query || query.length > 1000) throw new Error('搜索文本长度必须为 1 至 1000 个字符。');
    const limit = Math.min(100, Math.max(1, Number.isFinite(max_results) ? Math.floor(max_results) : 100));
    const start = await this.#resolve(input, { allowRoot: true });
    if (start.parts.some(part => part.startsWith('.') || ['build', 'dist'].includes(part.toLowerCase()))) {
      return { matches: [], truncated: false };
    }
    const needle = case_sensitive ? query : query.toLowerCase();
    const matches = [];
    let visited = 0;
    let truncated = false;
    const visit = async (relative, depth = 0) => {
      abortIfNeeded(signal);
      if (matches.length >= limit || visited >= 5000 || depth > 30) { truncated = true; return; }
      visited += 1;
      let target;
      try { target = await this.#resolve(relative, { allowRoot: true }); }
      catch { return; }
      if (target.stat.isDirectory()) {
        const entries = await fsp.readdir(target.absolute, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          if (!safeName(entry.name) || entry.name.startsWith('.') || ['build', 'dist'].includes(entry.name.toLowerCase()) || entry.isSymbolicLink()) continue;
          await visit(relative ? `${relative}/${entry.name}` : entry.name, depth + 1);
          if (matches.length >= limit || visited >= 5000) { truncated = true; break; }
        }
      } else if (target.stat.isFile()) {
        let content;
        try { content = (await this.#readSnapshot(relative)).content; }
        catch { return; }
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const haystack = case_sensitive ? lines[index] : lines[index].toLowerCase();
          const column = haystack.indexOf(needle);
          if (column === -1) continue;
          const excerptStart = Math.max(0, column - 120);
          matches.push({ path: target.relative, line: index + 1, text: lines[index].slice(excerptStart, excerptStart + 500) });
          if (matches.length >= limit) { truncated = true; break; }
        }
      }
    };
    await visit(start.relative);
    return { matches, truncated };
  }

  async #write(input, content, signal, expectedContent, { recordHistory = true, title, onFileChange, requireSingleLink = false, beforeCommit } = {}) {
    const buffer = textBuffer(content);
    const { target, snapshot } = await withFileCommit(async () => {
      abortIfNeeded(signal);
      const target = await this.#resolve(input, { allowMissing: true });
      const snapshot = target.exists ? await this.#readSnapshot(input) : null;
      if (requireSingleLink && snapshot && snapshot.target.stat.nlink !== 1) throw new Error('不允许撤销硬链接文件。');
      this.#requireObservedFile(input, snapshot);
      return { target, snapshot };
    });
    const before = snapshot?.content ?? null;
    if (expectedContent !== undefined && before !== expectedContent) throw new Error('文件已发生变化，请重新读取后再修改。');
    abortIfNeeded(signal);
    const approved = await this.approve({
      kind: 'write', title: title ?? `${target.exists ? '修改' : '创建'}文件：${target.relative}`,
      detail: `将${target.exists ? '更新' : '创建'}项目文件 ${target.relative}（${buffer.length} 字节）。`,
      path: target.relative, before, after: content,
    });
    abortIfNeeded(signal);
    if (approved !== true) return { denied: true, message: '用户拒绝了文件修改，未写入文件。' };
    return withFileCommit(async () => {
      abortIfNeeded(signal);
      const current = await this.#resolve(input, { allowMissing: true });
      if (current.exists !== target.exists) throw new Error('文件在等待审批时已创建或删除，已取消修改。');
      if (current.exists) {
        const latest = await this.#readSnapshot(input);
        if (latest.content !== before || !sameFile(latest.target.stat, snapshot.target.stat) || latest.target.stat.mtimeMs !== snapshot.target.stat.mtimeMs) {
          throw new Error('文件在等待审批时已变化，已取消修改。');
        }
      }
      // Create each parent separately and revalidate every existing component.
      for (let index = 1; index < target.parts.length; index += 1) {
        const relative = target.parts.slice(0, index).join('/');
        const parent = await this.#resolve(relative, { allowMissing: true });
        if (!parent.exists) {
          try { await fsp.mkdir(parent.absolute); }
          catch (error) { if (error.code !== 'EEXIST') throw error; }
        }
        const checked = await this.#resolve(relative);
        if (!checked.stat.isDirectory()) throw new Error('目标文件的父级不是目录。');
      }
      abortIfNeeded(signal);
      const finalTarget = await this.#resolve(input, { allowMissing: true });
      if (finalTarget.exists !== target.exists) throw new Error('文件在写入前发生变化，已取消修改。');
      // Journal before an O_EXCL create can change disk. The opened handle and
      // content checks below still run after this asynchronous durable write.
      await beforeCommit?.({ path: target.relative, before, after: content });
      abortIfNeeded(signal);
      const flags = target.exists
        ? fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0)
        : fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
      const handle = await fsp.open(finalTarget.absolute, flags, 0o600);
      let committedStat;
      try {
        const opened = await handle.stat();
        if (requireSingleLink && opened.nlink !== 1) throw new Error('不允许撤销硬链接文件。');
        const checked = await this.#resolve(input);
        if (!opened.isFile() || !sameFile(opened, checked.stat)) throw new Error('文件在写入前被替换，已取消修改。');
        if (target.exists) {
          if (opened.size > MAX_FILE_BYTES) throw new Error('文件在写入前发生变化，已取消修改。');
          const latest = await handle.readFile({ encoding: 'utf8' });
          if (latest !== before || !sameFile(opened, snapshot.target.stat) || opened.mtimeMs !== snapshot.target.stat.mtimeMs) {
            throw new Error('文件在写入前发生变化，已取消修改。');
          }
          await this.#resolve(input);
        }
        if (requireSingleLink && (await handle.stat()).nlink !== 1) throw new Error('文件链接在等待撤销时已变化。');
        abortIfNeeded(signal);
        // Explicit position is required: reading an existing handle advances its file offset.
        let written = 0;
        while (written < buffer.length) {
          const { bytesWritten } = await handle.write(buffer, written, buffer.length - written, written);
          if (!bytesWritten) throw new Error('无法完成文件写入。');
          written += bytesWritten;
        }
        await handle.truncate(buffer.length);
        await handle.sync();
        committedStat = await handle.stat();
      } finally { await handle.close(); }
      this.#rememberFile(target.relative, content, committedStat);
      if (recordHistory) {
        this.history.push({ path: target.relative, before, after: content });
        if (this.history.length > 100) this.history.shift();
      }
      // Report only committed content. Approval describes a proposal and may
      // still be followed by a rejected concurrent edit or a failed write.
      try { onFileChange?.({ path: target.relative, before, after: content }); } catch { /* A display listener must not turn a committed write into a failure. */ }
      return { path: target.relative, bytes: buffer.length, message: '文件已保存。' };
    });
  }

  async undoLastChange({ signal, onFileChange } = {}) {
    try {
      abortIfNeeded(signal);
      const change = this.history.at(-1);
      if (!change) return JSON.stringify({ message: '当前项目没有可撤销的修改。' });
      const snapshot = await withFileCommit(() => this.#readSnapshot(change.path));
      if (snapshot.content !== change.after) throw new Error('文件在修改后已变化，无法撤销；已保留当前内容。');
      let result;
      if (change.before !== null) {
        result = await this.#write(change.path, change.before, signal, change.after, {
          recordHistory: false, title: `撤销文件修改：${change.path}`, onFileChange,
        });
      } else {
        const approved = await this.approve({
          kind: 'write', title: `撤销新建文件（删除）：${change.path}`,
          detail: `此操作将删除本次新建的文件 ${change.path}。仅在文件内容仍与创建时一致时执行。`,
          path: change.path, before: change.after, after: null,
        });
        abortIfNeeded(signal);
        if (approved !== true) return JSON.stringify({ denied: true, message: '用户拒绝撤销，文件未改变。' });
        result = await withFileCommit(async () => {
          abortIfNeeded(signal);
          const current = await this.#readSnapshot(change.path);
          if (current.content !== change.after || !sameFile(current.target.stat, snapshot.target.stat) || current.target.stat.mtimeMs !== snapshot.target.stat.mtimeMs) {
            throw new Error('文件在等待撤销审批时已变化，已保留当前内容。');
          }
          if (this.history.at(-1) !== change) throw new Error('审批期间出现了新的修改，请重新执行撤销。');
          await this.#resolve(change.path);
          abortIfNeeded(signal);
          await fsp.unlink(current.target.absolute);
          this.#observedFiles.delete(this.#observationKey(change.path));
          try { onFileChange?.({ path: change.path, before: change.after, after: null }); } catch { /* The deletion has already committed. */ }
          return { path: change.path, deleted: true };
        });
      }
      if (!result.denied) {
        const index = this.history.indexOf(change);
        if (index !== -1) this.history.splice(index, 1);
        result.message = '最近一次文件修改已撤销。';
      }
      return JSON.stringify(result);
    } catch (error) {
      if (error.code === 'APPROVAL_DENIED') return JSON.stringify({ denied: true, message: error.message });
      return `错误：${error.message}`;
    }
  }

  async undoChanges(changes, { signal, onFileChange, beforeCommit, onCommitted, operationLabel = '撤销' } = {}) {
    const label = operationLabel === '恢复' ? '恢复' : '撤销';
    const completed = []; let plan = [];
    const report = (status, extra = {}) => JSON.stringify({ status, completed,
      remaining: plan.filter(change => !completed.includes(change.path)).map(change => change.path), ...extra });
    try {
      abortIfNeeded(signal);
      if (!Array.isArray(changes)) throw new Error('本轮原始修改记录无效，无法撤销。');
      plan = taskUndoPlan(changes.map(change => ({ ...change, path: this.#parts(change?.path).join('/') })));
      const snapshots = new Map();
      const inspect = async change => {
        const target = await this.#resolve(change.path, { allowMissing: true });
        const snapshot = target.exists ? await this.#readSnapshot(change.path) : null;
        if (snapshot && snapshot.target.stat.nlink !== 1) throw new Error(`不允许撤销硬链接文件 ${change.path}。`);
        if ((snapshot?.content ?? null) !== change.after) throw new Error(`文件 ${change.path} 在本轮修改后已变化，已保留当前内容。`);
        return snapshot;
      };
      // Validate every path and every current file before asking to change one.
      await withFileCommit(async () => {
        for (const change of plan) { abortIfNeeded(signal); this.#parts(change.path); snapshots.set(change.path, await inspect(change)); }
      });
      for (const change of plan) {
        abortIfNeeded(signal);
        await withFileCommit(async () => {
          const current = await inspect(change), original = snapshots.get(change.path);
          if (Boolean(current) !== Boolean(original) || current && (!sameFile(current.target.stat, original.target.stat)
              || current.target.stat.mtimeMs !== original.target.stat.mtimeMs)) throw new Error(`文件 ${change.path} 在批量撤销期间已变化，已保留当前内容。`);
          if (current) this.#rememberFile(change.path, current.content, current.target.stat);
          else this.#observedFiles.delete(this.#observationKey(change.path));
        });
        let result;
        if (change.before !== null) {
          result = await this.#write(change.path, change.before, signal, change.after,
            { recordHistory: false, title: `${label}本轮文件修改：${change.path}`, onFileChange, requireSingleLink: true, beforeCommit });
        } else {
          const snapshot = snapshots.get(change.path);
          const approved = await this.approve({ kind: 'write', title: `${label}本轮文件变更（删除）：${change.path}`,
            detail: `仅在文件仍与预期内容一致时删除 ${change.path}；其他文件可能已先${label}。`, path: change.path, before: change.after, after: null });
          abortIfNeeded(signal);
          if (approved !== true) result = { denied: true };
          else result = await withFileCommit(async () => {
            abortIfNeeded(signal);
            const current = await inspect(change);
            if (!current || !snapshot || !sameFile(current.target.stat, snapshot.target.stat) || current.target.stat.mtimeMs !== snapshot.target.stat.mtimeMs)
              throw new Error(`文件 ${change.path} 在等待撤销审批时已变化，已保留当前内容。`);
            await this.#resolve(change.path); abortIfNeeded(signal);
            await beforeCommit?.({ path: change.path, before: change.after, after: null });
            abortIfNeeded(signal);
            const ready = await inspect(change);
            if (!ready || !sameFile(ready.target.stat, current.target.stat) || ready.target.stat.mtimeMs !== current.target.stat.mtimeMs)
              throw new Error(`文件 ${change.path} 在准备撤销时已变化，已保留当前内容。`);
            await fsp.unlink(current.target.absolute);
            this.#observedFiles.delete(this.#observationKey(change.path));
            try { onFileChange?.({ path: change.path, before: change.after, after: null }); } catch { /* Deletion has committed. */ }
            return { deleted: true };
          });
        }
        if (result.denied) return report(completed.length ? 'partial' : 'denied', { denied: true, message: `${label}已拒绝；已${label} ${completed.length} 个文件，其余文件未${label}。` });
        completed.push(change.path);
        // Earlier single-step entries for a restored path no longer describe
        // the current file. Invalidate those paths, preserving all other order.
        for (let index = this.history.length - 1; index >= 0; index--)
          if (this.#samePath(this.history[index].path, change.path)) this.history.splice(index, 1);
        await onCommitted?.({ path: change.path, before: change.after, after: change.before });
      }
      return report('completed', { message: `本轮已${label} ${completed.length} 个文件。` });
    } catch (error) {
      return report(completed.length ? 'partial' : signal?.aborted ? 'stopped' : 'failed', {
        ...(signal?.aborted ? { stopped: true } : {}), error: error.message,
        message: `${label}未全部完成：已${label} ${completed.length} 个文件；${error.message}` });
    }
  }

  async #replace({ path: input, old_text, new_text }, signal, onFileChange) {
    if (typeof old_text !== 'string' || !old_text || typeof new_text !== 'string') throw new Error('old_text 必须是非空字符串，new_text 必须是字符串。');
    const { content } = await this.readFile({ path: input });
    const index = content.indexOf(old_text);
    if (index === -1) throw new Error('未找到要替换的文本。');
    if (content.indexOf(old_text, index + 1) !== -1) throw new Error('要替换的文本出现多次，请提供唯一的上下文。');
    return this.#write(input, content.slice(0, index) + new_text + content.slice(index + old_text.length), signal, content, { onFileChange });
  }

  async #command({ command, timeout_ms = DEFAULT_COMMAND_TIMEOUT }, signal) {
    if (typeof command !== 'string' || !command.trim() || command.includes('\0') || command.length > 16000) throw new Error('请提供 1 至 16000 个字符的 PowerShell 命令。');
    const timeout = Math.min(MAX_COMMAND_TIMEOUT, Math.max(1000, Number.isFinite(timeout_ms) ? timeout_ms : DEFAULT_COMMAND_TIMEOUT));
    await this.#resolve('', { allowRoot: true });
    abortIfNeeded(signal);
    const approved = await this.approve({
      kind: 'command', title: '运行 PowerShell 命令', command,
      detail: `工作目录：${this.root}\n最长运行：${Math.round(timeout / 1000)} 秒\n输出编码：应用预设 UTF-8。\n\n此命令不在系统沙箱内，可访问当前账户权限下的文件、网络和进程。请查看下方完整命令，仅在信任时批准。`,
    });
    abortIfNeeded(signal);
    if (approved !== true) return { denied: true, message: '用户拒绝了命令执行，未启动进程。' };
    await this.#resolve('', { allowRoot: true });
    abortIfNeeded(signal);
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:API[_-]?KEY|(?:^|_)(?:TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:$|_)|PRIVATE[_-]?KEY)/i.test(name)));
    return new Promise((resolve, reject) => {
      const execution = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding;\n${command}`;
      const child = spawn(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', execution], {
        cwd: this.root, env, shell: false, windowsHide: true,
        detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output = { stdout: [], stderr: [] };
      const outputDecoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
      let outputBytes = 0;
      let terminated = null;
      let forceTimer;
      let settled = false;
      const stop = reason => {
        if (terminated || settled) return;
        terminated = reason;
        if (child.pid) {
          if (process.platform === 'win32') {
            const killer = spawn(path.join(WINDOWS_SYSTEM, 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            killer.on('error', () => { try { child.kill('SIGKILL'); } catch {} });
          } else {
            try { process.kill(-child.pid, 'SIGKILL'); }
            catch { try { child.kill('SIGKILL'); } catch {} }
          }
        }
        forceTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
        forceTimer.unref();
      };
      const onAbort = () => stop('cancelled');
      const timer = setTimeout(() => stop('timeout'), timeout);
      const cleanup = () => { clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', onAbort); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      for (const stream of ['stdout', 'stderr']) {
        child[stream].on('data', chunk => {
          const remaining = MAX_OUTPUT_BYTES - outputBytes;
          if (remaining > 0) {
            const part = chunk.subarray(0, remaining);
            output[stream].push(part);
            outputBytes += part.length;
            const text = outputDecoders[stream].write(part);
            if (text) { try { this.onEvent({ type: 'command-output', stream, text }); } catch {} }
          }
          if (chunk.length > remaining || outputBytes >= MAX_OUTPUT_BYTES) stop('output_limit');
        });
        child[stream].once('end', () => {
          const text = outputDecoders[stream].end();
          if (text) { try { this.onEvent({ type: 'command-output', stream, text }); } catch {} }
        });
      }
      child.once('error', error => { settled = true; cleanup(); reject(new Error(`无法启动 PowerShell：${error.message}`)); });
      child.once('close', (exitCode, exitSignal) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          command, exitCode, signal: exitSignal, terminated,
          stdout: Buffer.concat(output.stdout).toString('utf8'),
          stderr: Buffer.concat(output.stderr).toString('utf8'),
        });
      });
    });
  }

  async execute(name, args = {}, { signal, onFileChange } = {}) {
    try {
      abortIfNeeded(signal);
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象。');
      let result;
      switch (name) {
        case 'list_files': result = await this.listFiles(args); break;
        case 'read_file': result = await this.readFile(args); break;
        case 'search_files': result = await this.#search(args, signal); break;
        case 'write_file': result = await this.#write(args.path, args.content, signal, undefined, { onFileChange }); break;
        case 'replace_in_file': result = await this.#replace(args, signal, onFileChange); break;
        case 'run_command': result = await this.#command(args, signal); break;
        case 'undo_last_change': return await this.undoLastChange({ signal, onFileChange });
        default: throw new Error(`未知工具：${name}`);
      }
      return JSON.stringify(result);
    } catch (error) {
      if (error.code === 'APPROVAL_DENIED') return JSON.stringify({ denied: true, message: error.message });
      return `错误：${error.message}`;
    }
  }
}
