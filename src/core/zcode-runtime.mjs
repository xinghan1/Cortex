import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const filename = 'zcode-windows-x64.exe';
const sourceCommit = '3c5b227649371507ddc4eb46ac5133afe6db1cab';
const MAX_BYTES = 768 * 1024 * 1024, MAX_METADATA = 128 * 1024;
const failure = (code, message) => Object.assign(new Error(`[${code}] ${message}`), { code, name: 'ZCodeRuntimeError' });
const cancelled = () => Object.assign(failure('ZCODE_CANCELLED', 'ZCode 组件准备已取消。'), { name: 'AbortError' });
const check = signal => { if (signal?.aborted) throw cancelled(); };
function wait(operation, signal) {
  check(signal);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => { if (done) return; done = true; signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => finish(cancelled()); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    Promise.resolve().then(operation).then(value => finish(null, value), error => finish(error));
  });
}
const sha256 = async (file, signal) => {
  check(signal); const hash = createHash('sha256'), stream = createReadStream(file, { signal }); let bytes = 0;
  try { for await (const chunk of stream) { check(signal); bytes += chunk.length; if (bytes > MAX_BYTES) throw failure('ZCODE_RUNTIME_INTEGRITY', 'ZCode 组件大小异常。'); hash.update(chunk); } check(signal); return hash.digest('hex'); }
  finally { stream.destroy(); }
};

// The complete, unchanged upstream SEA build includes the official runtime
// resources. It is copied out of ASAR before execution; no account material is
// ever read while installing this Apache-2.0 source-built component.
export class ZCodeRuntime {
  #root; #dir; #source; #onChange; #state; #manifest; #initializing; #pending; #controller;
  constructor({ dataDir, sourceDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'zcode-agent'), onChange = () => {}, platform = process.platform, arch = process.arch } = {}) {
    if (!path.isAbsolute(dataDir || '') || !path.isAbsolute(sourceDirectory || '') || typeof onChange !== 'function') throw failure('ZCODE_INVALID_CONFIG', 'ZCode 组件目录无效。');
    this.#root = path.resolve(dataDir); this.#dir = path.join(this.#root, 'zcode-runtime'); this.#source = path.resolve(sourceDirectory); this.#onChange = onChange;
    this.#state = { status: 'missing', version: '0.17.0', download: null, error: null };
    if (platform !== 'win32' || arch !== 'x64') this.#state.error = { code: 'ZCODE_PLATFORM_UNSUPPORTED', message: '当前 ZCode 组件支持 Windows x64。' };
  }
  #change(value) { Object.assign(this.#state, value); try { Promise.resolve(this.#onChange()).catch(() => {}); } catch {} }
  async #directory(directory, create = true, signal) {
    const relative = path.relative(this.#root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw failure('ZCODE_STORAGE_ERROR', 'ZCode 组件目录不可用。');
    const components = [this.#root]; let current = this.#root;
    for (const part of relative.split(path.sep).filter(Boolean)) { current = path.join(current, part); components.push(current); }
    for (const candidate of components) {
      check(signal); if (create) await wait(() => fs.mkdir(candidate, { recursive: candidate === this.#root }).catch(error => { if (error.code !== 'EEXIST') throw error; }), signal);
      const stat = await wait(() => fs.lstat(candidate), signal); if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('ZCODE_STORAGE_ERROR', 'ZCode 组件目录不可用。');
    }
    check(signal);
  }
  async #metadata(signal) {
    check(signal); const directory = await wait(() => fs.lstat(this.#source), signal);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw failure('ZCODE_RUNTIME_MISSING', 'ZCode 组件来源目录无效，请重新安装软件。');
    const source = path.join(this.#source, 'provenance.json'), stat = await wait(() => fs.lstat(source), signal);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_METADATA) throw failure('ZCODE_RUNTIME_MISSING', 'ZCode 组件信息无效，请重新安装软件。');
    const raw = await fs.readFile(source, { encoding: 'utf8', signal }); check(signal);
    if (Buffer.byteLength(raw) > MAX_METADATA) throw failure('ZCODE_RUNTIME_MISSING', 'ZCode 组件信息无效，请重新安装软件。');
    const value = JSON.parse(raw);
    if (value.sourceCommit !== sourceCommit || value.version !== '0.17.0' || value.license !== 'Apache-2.0'
        || !/^[a-f\d]{64}$/u.test(value.files?.[filename] || '')) throw failure('ZCODE_RUNTIME_MISSING', 'ZCode 组件来源无法验证，请重新安装软件。');
    return value;
  }
  async #installed(signal) {
    if (!this.#manifest) return false;
    const directory = path.join(this.#dir, this.#manifest.version);
    try { await this.#directory(directory, false, signal); } catch (error) { if (signal?.aborted) throw cancelled(); if (error.code === 'ENOENT') return false; throw error; }
    const dir = await wait(() => fs.lstat(directory).catch(() => null), signal), stat = await wait(() => fs.lstat(path.join(directory, filename)).catch(() => null), signal);
    check(signal);
    return dir?.isDirectory() && !dir.isSymbolicLink() && stat?.isFile() && !stat.isSymbolicLink()
      && stat.size > 2 && stat.size <= MAX_BYTES && await sha256(path.join(directory, filename), signal) === this.#manifest.files[filename];
  }
  init() {
    return this.#initializing ??= (async () => {
      if (this.#state.error) return this;
      try { this.#manifest = await this.#metadata(); if (await this.#installed()) this.#change({ status: 'ready' }); }
      catch { /* Source checkouts can run API modes before preparing ZCode. */ }
      return this;
    })();
  }
  async publicState() { await this.init(); return structuredClone(this.#state); }
  ensure({ signal, onProgress } = {}) {
    if (this.#pending) return wait(() => this.#pending, signal);
    const controller = new AbortController(), abort = () => controller.abort(); this.#controller = controller;
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    this.#pending = (async () => {
      let temporary;
      try {
        await wait(() => this.init(), controller.signal); check(controller.signal);
        if (this.#state.error?.code === 'ZCODE_PLATFORM_UNSUPPORTED') throw failure(this.#state.error.code, this.#state.error.message);
        this.#manifest = await this.#metadata(controller.signal);
        await this.#directory(this.#dir, true, controller.signal); const directory = path.join(this.#dir, this.#manifest.version); await this.#directory(directory, true, controller.signal);
        const installed = await this.#installed(controller.signal); check(controller.signal);
        if (installed) { this.#change({ status: 'ready', error: null, download: null }); return { entry: path.join(directory, filename), args: [], version: this.#manifest.version }; }
        const source = path.join(this.#source, filename), stat = await wait(() => fs.lstat(source), controller.signal);
        check(controller.signal);
        if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.size) || stat.size <= 2 || stat.size > MAX_BYTES) throw failure('ZCODE_RUNTIME_MISSING', '完整 ZCode 组件缺失，请重新安装软件。');
        temporary = path.join(directory, `.${randomUUID()}.part`);
        let receivedBytes = 0, last = 0; const hash = createHash('sha256');
        const progress = () => {
          this.#change({ status: 'downloading', error: null, download: { receivedBytes, totalBytes: stat.size } });
          try { onProgress?.({ receivedBytes, totalBytes: stat.size }); } catch {}
        }; progress();
        await pipeline(createReadStream(source), new Transform({ transform(chunk, _encoding, next) {
          receivedBytes += chunk.length;
          if (receivedBytes > stat.size || receivedBytes > MAX_BYTES) { next(failure('ZCODE_RUNTIME_INTEGRITY', 'ZCode 组件复制大小异常。')); return; }
          hash.update(chunk); next(null, chunk);
          if (Date.now() - last > 100) { last = Date.now(); progress(); }
        } }), createWriteStream(temporary, { flags: 'wx', mode: 0o700 }), { signal: controller.signal });
        if (receivedBytes !== stat.size || hash.digest('hex') !== this.#manifest.files[filename]) throw failure('ZCODE_RUNTIME_INTEGRITY', 'ZCode 组件校验失败，请重新安装软件。');
        check(controller.signal); await this.#directory(directory, false, controller.signal); check(controller.signal);
        await fs.rename(temporary, path.join(directory, filename)); temporary = null;
        check(controller.signal);
        this.#change({ status: 'ready', error: null, download: null });
        return { entry: path.join(directory, filename), args: [], version: this.#manifest.version };
      } catch (caught) {
        const error = controller.signal.aborted ? cancelled() : caught?.name === 'ZCodeRuntimeError' ? caught : failure('ZCODE_RUNTIME_MISSING', 'ZCode 组件准备失败，请检查软件安装和本机存储。');
        this.#change({ status: 'missing', download: null, error: error.name === 'AbortError' ? null : { code: error.code, message: error.message } }); throw error;
      } finally {
        if (temporary) { try { await this.#directory(path.dirname(temporary), false); await fs.unlink(temporary); } catch { /* Never follow a replaced private ancestor during cleanup. */ } }
        signal?.removeEventListener('abort', abort); this.#controller = null; this.#pending = null;
      }
    })(); return this.#pending;
  }
  cancel() { this.#controller?.abort(); }
  async dispose() { this.cancel(); await this.#pending?.catch(() => {}); }
}
