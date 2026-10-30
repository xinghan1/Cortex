const fs = require('node:fs/promises');
const path = require('node:path');
const { constants } = require('node:fs');
const { randomUUID } = require('node:crypto');

const PLUGIN_LIMITS = Object.freeze({ plugins: 100, files: 1000, fileBytes: 4 * 1024 * 1024, totalBytes: 20 * 1024 * 1024, manifestBytes: 32768,
  registryBytes: 1024 * 1024, textBytes: 512 * 1024, listEntries: 500 });
const PLUGIN_PERMISSIONS = Object.freeze(['project.read', 'project.write', 'notifications']);
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const COMMAND = /^[a-z][a-zA-Z0-9]*(?:[.-][a-zA-Z0-9]+)*$/u;
const control = /[\x00-\x1f\x7f]/u;
const fail = text => { throw new Error(text); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const text = (value, length) => typeof value === 'string' && value.trim() && value.length <= length && !control.test(value);
const relative = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && !control.test(value)
  && !value.includes('\\') && !value.includes(':') && !value.includes('%') && !value.includes('?') && !value.includes('#')
  && !path.posix.isAbsolute(value) && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/u.test(part));
const within = (root, target) => { const part = path.relative(root, target); return part !== '' && !part.startsWith('..' + path.sep) && part !== '..' && !path.isAbsolute(part); };

function validatePluginManifest(value) {
  if (!plain(value) || Object.keys(value).some(key => !['schemaVersion', 'id', 'name', 'version', 'description', 'entry', 'permissions', 'commands'].includes(key))) fail('插件清单格式无效。');
  if (value.schemaVersion !== 1 || !text(value.id, 80) || !IDENTIFIER.test(value.id) || !text(value.name, 100)
      || !text(value.version, 64) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(value.version)
      || !relative(value.entry) || !/\.html?$/iu.test(value.entry)
      || value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 500 || control.test(value.description))) fail('插件清单中的版本、名称或入口无效。');
  if (!Array.isArray(value.permissions) || value.permissions.length > PLUGIN_PERMISSIONS.length
      || value.permissions.some(item => !PLUGIN_PERMISSIONS.includes(item)) || new Set(value.permissions).size !== value.permissions.length) fail('插件申请了不支持的权限。');
  const commands = value.commands ?? [];
  if (!Array.isArray(commands) || commands.length > 30 || commands.some(command => !plain(command)
      || Object.keys(command).some(key => !['id', 'title'].includes(key)) || !text(command.id, 100) || !COMMAND.test(command.id) || !text(command.title, 100))
      || new Set(commands.map(command => command.id)).size !== commands.length) fail('插件命令定义无效。');
  return { schemaVersion: 1, id: value.id, name: value.name.trim(), version: value.version,
    description: value.description?.trim() ?? '', entry: value.entry, permissions: [...value.permissions], commands: commands.map(command => ({ ...command })) };
}

async function readManifest(root) {
  const names = await Promise.all(['cortex-plugin.json', 'synora-plugin.json'].map(async name => {
    try { await fs.lstat(path.join(root, name)); return name; } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }));
  const present = names.filter(Boolean);
  if (present.length !== 1) fail('请选择包含一个 cortex-plugin.json 清单的插件目录。');
  const file = path.join(root, present[0]);
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > PLUGIN_LIMITS.manifestBytes) fail('请选择包含普通插件清单文件的目录。');
  let value;
  try { value = JSON.parse(await fs.readFile(file, 'utf8')); } catch { fail('无法读取插件清单，请检查 JSON 格式。'); }
  return validatePluginManifest(value);
}

// Read a bounded snapshot before copying. No plugin code is imported into Node.
async function inspectPluginDirectory(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.includes('\0')) fail('请选择普通本机插件目录。');
  const root = path.resolve(input), stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('插件目录不能是符号链接。');
  const canonicalRoot = await fs.realpath(root);
  const files = []; let total = 0, entriesSeen = 0;
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (['.git', 'node_modules', '.DS_Store'].includes(entry.name)) continue;
      if (++entriesSeen > PLUGIN_LIMITS.files) fail('插件超过 1000 个文件和目录的限制。');
      const absolute = path.join(directory, entry.name), name = path.relative(root, absolute).split(path.sep).join('/');
      if (!relative(name) || !within(root, absolute)) fail('插件包含无效文件名。');
      const info = await fs.lstat(absolute);
      if (info.isSymbolicLink() || !within(canonicalRoot, await fs.realpath(absolute))) fail('插件不能包含目录跳转或符号链接。');
      if (info.isDirectory()) { if (name.split('/').length > 16) fail('插件目录层级过深。'); await visit(absolute); continue; }
      if (!info.isFile() || info.nlink > 1) fail('插件只能包含普通文件。');
      if (files.length >= PLUGIN_LIMITS.files || info.size > PLUGIN_LIMITS.fileBytes || total + info.size > PLUGIN_LIMITS.totalBytes) fail('插件超过文件数量或 20 MB 大小限制。');
      const handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      let bytes;
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.nlink > 1 || opened.size !== info.size || opened.ino !== info.ino
            || opened.dev && info.dev && opened.dev !== info.dev) fail('插件文件在读取时发生变化，请重新安装。');
        const buffer = Buffer.alloc(info.size + 1); let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) break;
          offset += bytesRead;
        }
        bytes = buffer.subarray(0, offset);
      } finally { await handle.close(); }
      if (bytes.length !== info.size) fail('插件文件在读取时发生变化，请重新安装。');
      files.push({ name, bytes }); total += bytes.length;
    }
  }
  await visit(root);
  const manifests = files.filter(file => ['cortex-plugin.json', 'synora-plugin.json'].includes(file.name));
  if (manifests.length !== 1 || manifests[0].bytes.length > PLUGIN_LIMITS.manifestBytes) fail('请选择包含一个 cortex-plugin.json 清单的插件目录。');
  const manifestFile = manifests[0];
  let raw;
  try { raw = JSON.parse(manifestFile.bytes.toString('utf8')); } catch { fail('无法读取插件清单，请检查 JSON 格式。'); }
  const manifest = validatePluginManifest(raw);
  if (!files.some(file => file.name === manifest.entry)) fail('找不到插件 HTML 入口。');
  return { manifest, files, totalBytes: total };
}

class PluginManager {
  #root; #registry; #items = new Map(); #ready; #queue = Promise.resolve(); #listeners = new Set(); #disposed = false; #pending = 0; #storageError = null;
  constructor({ dataDir, onChange = () => {} } = {}) {
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || typeof onChange !== 'function') fail('插件管理器配置无效。');
    this.#root = path.join(dataDir, 'plugins'); this.#registry = path.join(this.#root, 'registry.json'); this.#listeners.add(onChange);
  }
  async init() {
    if (this.#disposed) fail('插件管理器已关闭。');
    this.#ready ??= this.#load().catch(() => {
      this.#items.clear(); this.#storageError = '插件配置损坏或无法读取。原文件已保留，修复后重启软件再试。';
    });
    await this.#ready; return this;
  }
  async #load() {
    await fs.mkdir(this.#root, { recursive: true });
    if ((await fs.lstat(this.#root)).isSymbolicLink()) fail('插件存储目录无效。');
    let registry;
    try {
      const stat = await fs.lstat(this.#registry);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > PLUGIN_LIMITS.registryBytes) fail('插件列表文件无效。');
      const handle = await fs.open(this.#registry, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size > PLUGIN_LIMITS.registryBytes) fail('插件列表文件无效。');
        const bytes = Buffer.alloc(opened.size + 1); let offset = 0;
        while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) break; offset += bytesRead; }
        if (offset !== opened.size) fail('插件列表文件在读取时发生变化。');
        registry = JSON.parse(bytes.subarray(0, offset).toString('utf8'));
      } finally { await handle.close(); }
    } catch (error) { if (error.code === 'ENOENT') return; throw new Error('无法读取已安装插件列表。'); }
    if (!plain(registry) || registry.schemaVersion !== 1 || !Array.isArray(registry.plugins) || registry.plugins.length > PLUGIN_LIMITS.plugins) fail('插件列表格式无效。');
    for (const item of registry.plugins) {
      if (!plain(item) || !text(item.id, 80) || !IDENTIFIER.test(item.id) || typeof item.enabled !== 'boolean' || this.#items.has(item.id)) fail('插件列表格式无效。');
      const root = path.join(this.#root, item.id);
      try {
        if ((await fs.lstat(root)).isSymbolicLink()) continue;
        const manifest = await readManifest(root);
        if (manifest.id !== item.id) continue;
        this.#items.set(item.id, { root, manifest, enabled: item.broken ? false : item.enabled, broken: item.broken === true });
      } catch {
        // A failed recursive removal can leave only part of the folder. Retain
        // a disabled, visible recovery entry without executing damaged content.
        try {
          const manifest = validatePluginManifest(item.manifest);
          if (manifest.id === item.id) this.#items.set(item.id, { root, manifest, enabled: false, broken: true });
        } catch { /* Invalid registry backups never provide an executable plugin. */ }
      }
    }
  }
  list() { return [...this.#items.values()].map(({ manifest, enabled }) => ({ id: manifest.id, name: manifest.name, version: manifest.version,
    description: manifest.description, enabled, permissions: [...manifest.permissions], commands: manifest.commands.map(command => ({ ...command })) })); }
  subscribe(listener) { if (typeof listener !== 'function') fail('插件监听器无效。'); this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #publish() { for (const listener of this.#listeners) { try { listener(this.list()); } catch {} } }
  get pending() { return this.#pending > 0; }
  get storageError() { return this.#storageError; }
  #mutate(action) {
    this.#pending++;
    const result = this.#queue.then(async () => { await this.init(); if (this.#disposed) fail('插件管理器已关闭。'); if (this.#storageError) fail(this.#storageError); return action(); }).finally(() => { this.#pending--; });
    this.#queue = result.catch(() => {}); return result;
  }
  async #save(items = this.#items) {
    const target = path.join(this.#root, `registry-${randomUUID()}.tmp`);
    try {
      const contents = JSON.stringify({ schemaVersion: 1, plugins: [...items.values()].map(item => ({ id: item.manifest.id,
        enabled: item.enabled, manifest: item.manifest, ...(item.broken ? { broken: true } : {}) })) }, null, 2) + '\n';
      if (Buffer.byteLength(contents) > PLUGIN_LIMITS.registryBytes) fail('插件清单总大小超过 1 MB，请移除部分插件后再试。');
      await fs.writeFile(target, contents, { flag: 'wx' });
      await fs.rename(target, this.#registry);
    } finally { await fs.rm(target, { force: true }).catch(() => {}); }
  }
  async preview(sourceDir) { const { manifest, files, totalBytes } = await inspectPluginDirectory(sourceDir); return { ...manifest, files: files.length, totalBytes }; }
  install(sourceDir) { return this.#mutate(async () => {
    const { manifest, files } = await inspectPluginDirectory(sourceDir);
    if (this.#items.has(manifest.id)) fail('此插件已安装，请先移除旧版本。');
    if (this.#items.size >= PLUGIN_LIMITS.plugins) fail('最多安装 100 个插件。');
    const staging = path.join(this.#root, `.install-${randomUUID()}`), destination = path.join(this.#root, manifest.id);
    let moved = false;
    try {
      await fs.mkdir(staging);
      for (const file of files) { const target = path.join(staging, ...file.name.split('/')); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file.bytes, { flag: 'wx' }); }
      try { await fs.lstat(destination); fail('插件存储目录已存在，请先移除对应插件。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fs.rename(staging, destination); moved = true;
      const items = new Map(this.#items); items.set(manifest.id, { root: destination, manifest, enabled: false });
      try { await this.#save(items); } catch (error) { await fs.rm(destination, { recursive: true, force: true }); moved = false; throw error; }
      this.#items = items; this.#publish(); return this.list();
    } finally { if (!moved) await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
  }); }
  setEnabled(id, enabled) { return this.#mutate(async () => {
    const current = this.#items.get(id); if (!current || typeof enabled !== 'boolean') fail('插件或启用状态无效。');
    if (enabled && current.broken) fail('插件文件不完整，请先移除后重新安装。');
    const items = new Map(this.#items); items.set(id, { ...current, enabled }); await this.#save(items); this.#items = items; this.#publish(); return this.list();
  }); }
  uninstall(id) { return this.#mutate(async () => {
    let current = this.#items.get(id); if (!current) fail('插件不存在。');
    // The only recursive deletion target is this manager's validated ID folder.
    if (!within(this.#root, current.root) || path.dirname(current.root) !== this.#root || !IDENTIFIER.test(id)) fail('插件存储目录无效。');
    if (current.enabled) {
      current = { ...current, enabled: false };
      const disabled = new Map(this.#items); disabled.set(id, current); await this.#save(disabled); this.#items = disabled; this.#publish();
    }
    // Keep the disabled registry entry until deletion succeeds. A locked file
    // leaves a visible, retryable item instead of an unregistered orphan folder.
    try { await fs.rm(current.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch {
      const recovery = new Map(this.#items); recovery.set(id, { ...current, enabled: false, broken: true });
      try { await this.#save(recovery); } catch { /* The previous disabled registry backup remains recoverable. */ }
      this.#items = recovery; this.#publish();
      fail('无法移除插件文件，请关闭占用程序后重新点击“移除”。');
    }
    const items = new Map(this.#items); items.delete(id); await this.#save(items); this.#items = items; this.#publish(); return this.list();
  }); }
  async get(id) { await this.init(); if (this.#storageError) fail(this.#storageError); const item = this.#items.get(id); if (!item) fail('插件不存在。'); return { root: item.root, enabled: item.enabled, manifest: structuredClone(item.manifest) }; }
  async settled() { await this.#queue; }
  async dispose() { await this.#queue; this.#disposed = true; this.#items.clear(); this.#publish(); this.#listeners.clear(); }
}

module.exports = { PluginManager, PLUGIN_LIMITS, PLUGIN_PERMISSIONS, validatePluginManifest, inspectPluginDirectory, isPluginRelativePath: relative };
