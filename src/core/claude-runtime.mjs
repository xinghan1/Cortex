import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export const CLAUDE_INSTALL_URL = 'https://code.claude.com/docs/en/setup';
export const CLAUDE_AGENT_SDK_VERSION = '0.3.310';
export const CLAUDE_BUNDLED_RELEASE = Object.freeze({ version: '2.1.310', sdkVersion: '0.3.310', bytes: 296791712,
  sha256: 'f9a3920634ae3b961ee92c2eb58d0051f5f8852b120983d0a4f57b6a5efeba61' });
const fail = (code, message) => Object.assign(new Error(`[${code}] ${message}`), { name: 'ClaudeError', code });
const cancelled = () => Object.assign(fail('CLAUDE_CANCELLED', 'Claude 操作已取消。'), { name: 'AbortError' });
const check = signal => { if (signal?.aborted) throw cancelled(); };

// Only native, explicitly resolved executables are used. npm .cmd/.ps1 shims,
// shell expansion and a project's current directory never participate in lookup.
// Installation stays with Anthropic's official installer; no OAuth files are read.
export class ClaudeRuntime {
  #path; #env; #platform; #onChange; #state; #entry = null; #initialized = false; #bundled; #arch; #validated = null;
  constructor({ dataDir, executablePath, bundledExecutablePath, env = process.env, platform = process.platform, arch = process.arch, onChange = () => {} } = {}) {
    if (!path.isAbsolute(dataDir || '') || executablePath !== undefined && (!path.isAbsolute(executablePath) || /[\x00\r\n]/u.test(executablePath))
        || bundledExecutablePath !== undefined && bundledExecutablePath !== null && !path.isAbsolute(bundledExecutablePath)
        || !env || typeof env !== 'object' || typeof onChange !== 'function') throw fail('CLAUDE_INVALID_INPUT', 'Claude 运行组件配置无效。');
    this.#path = executablePath; this.#env = env; this.#platform = platform; this.#arch = arch; this.#onChange = onChange; this.#bundled = bundledExecutablePath;
    this.#state = { status: 'missing', version: null, sdkVersion: CLAUDE_AGENT_SDK_VERSION, download: null, error: null, installUrl: CLAUDE_INSTALL_URL };
  }
  #bundledPath() {
    if (this.#bundled !== undefined) return this.#bundled;
    if (this.#arch !== 'x64') return null;
    try { return createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe').replace(/\.asar([\\/])/u, '.asar.unpacked$1'); }
    catch { return null; }
  }
  #change(value) { Object.assign(this.#state, value); try { Promise.resolve(this.#onChange()).catch(() => {}); } catch {} }
  #candidates() {
    if (this.#path) return [this.#path];
    const env = Object.fromEntries(Object.entries(this.#env).map(([key, value]) => [key.toLowerCase(), value]));
    const home = env.userprofile || env.home;
    const paths = typeof env.path === 'string' ? env.path.split(path.delimiter) : [];
    return [...new Set([...(typeof home === 'string' && path.isAbsolute(home) ? [path.join(home, '.local', 'bin', 'claude.exe')] : []),
      ...paths.filter(item => path.isAbsolute(item) && !/[\x00\r\n"]/u.test(item)).map(item => path.join(item, 'claude.exe')), this.#bundledPath()].filter(Boolean))];
  }
  async #locate(signal) {
    check(signal);
    if (this.#platform !== 'win32') throw fail('CLAUDE_PLATFORM_UNSUPPORTED', '当前 Claude 本机代理支持 Windows 官方原生安装。');
    for (const candidate of this.#candidates()) {
      check(signal);
      if (path.basename(candidate).toLowerCase() !== 'claude.exe') continue;
      let file;
      try {
        const stat = await fs.lstat(candidate); if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2) continue;
        file = await fs.open(candidate, 'r'); const magic = Buffer.alloc(2); await file.read(magic, 0, 2, 0);
        if (magic.toString('ascii') !== 'MZ') continue;
        if (candidate === this.#bundledPath()) {
          if (stat.size !== CLAUDE_BUNDLED_RELEASE.bytes) continue;
          const fingerprint = `${candidate}:${stat.size}:${stat.mtimeMs}`;
          if (this.#validated !== fingerprint) {
            const hash = createHash('sha256'); for await (const bytes of createReadStream(candidate)) { check(signal); hash.update(bytes); }
            if (hash.digest('hex') !== CLAUDE_BUNDLED_RELEASE.sha256) continue;
            this.#validated = fingerprint;
          }
        }
        check(signal); return path.resolve(candidate);
      } catch (error) { if (error?.name === 'AbortError') throw error; }
      finally { await file?.close().catch(() => {}); }
    }
    throw fail('CLAUDE_RUNTIME_MISSING', '未找到官方原生 Claude 程序。请按官方说明安装 Claude Code 后重试；不支持 npm 命令脚本入口。');
  }
  async init() { if (this.#initialized) return this; this.#initialized = true; try { this.#entry = await this.#locate(); this.#change({ status: 'ready', error: null, version: this.#entry === this.#bundledPath() ? CLAUDE_BUNDLED_RELEASE.version : null }); } catch (error) { this.#entry = null; this.#change({ status: 'missing', error: { code: error.code, message: error.message } }); } return this; }
  async publicState() { await this.init(); return structuredClone(this.#state); }
  async ensure({ signal } = {}) {
    try { this.#entry = await this.#locate(signal); const version = this.#entry === this.#bundledPath() ? CLAUDE_BUNDLED_RELEASE.version : null; this.#change({ status: 'ready', error: null, version }); return { entry: this.#entry, args: [], version, sdkVersion: CLAUDE_AGENT_SDK_VERSION }; }
    catch (error) { if (error.name !== 'AbortError') this.#change({ status: 'missing', error: { code: error.code, message: error.message } }); throw error; }
  }
  cancel() {}
  async dispose() {}
}
