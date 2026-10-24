const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');

const PET_LIMITS = Object.freeze({ configBytes: 1024 * 1024, clipBytes: 8 * 1024 * 1024, packBytes: 256 * 1024 * 1024, clips: 256, packs: 32 });
const STATES = Object.freeze(['idle', 'clicks', 'drag', 'turn', 'actions', 'thinking', 'working', 'result', 'waiting', 'success', 'error']);
const WORK_STATES = STATES.slice(5);
const BUILTIN = Object.freeze({
  idle: ['待机呼吸休闲'], clicks: ['点击回应-开心跃动'], drag: ['被鼠标拖拽悬空反馈'], turn: ['东张西望'], actions: ['写代码'],
  thinking: ['工作状态-思考冒泡'], working: ['工作状态-忙碌点按'], result: ['工作状态-清点归档'], waiting: ['工作状态-原地踱步张望'], success: ['工作状态-雀跃庆祝'], error: ['工作状态-垂头叹气冒汗'],
});
const defaults = () => ({ enabled: true, size: 220, x: 1, y: 1, workStatus: true, packId: 'dsh-pet' });
const fail = (message = '宠物素材包无效，请选择 dsh-pet 的 JSON 或 JSONC 配置及配套 WebM 动画。', code = 'PET_INVALID_PACK') => Object.assign(new Error(message), { code });
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const validName = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && !/[\\/<>:"|?*\p{Cc}\p{Cf}]/u.test(value) && value !== '.' && value !== '..' && !/[. ]$/u.test(value);
const validId = value => typeof value === 'string' && /^(?:dsh-pet|local-[a-f0-9]{24})$/u.test(value);
const settingsKeys = Object.keys(defaults());

// JSONC is data only: remove comments and trailing commas outside JSON strings.
// Never evaluate configuration or load an upstream JavaScript entry point.
function parseJsonc(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > PET_LIMITS.configBytes) throw fail();
  let stripped = '', quoted = false, escaped = false;
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index++) {
    const char = text[index], next = text[index + 1];
    if (quoted) {
      stripped += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; stripped += char; }
    else if (char === '/' && next === '/') {
      index += 2;
      while (index < text.length && text[index] !== '\n' && text[index] !== '\r') index++;
      stripped += '\n';
    } else if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      if (end < 0) throw fail();
      stripped += ' '; index = end + 1;
    } else stripped += char;
  }
  let cleaned = ''; quoted = false; escaped = false;
  for (let index = 0; index < stripped.length; index++) {
    const char = stripped[index];
    if (quoted) {
      cleaned += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') { quoted = true; cleaned += char; }
    else if (char === ',') {
      let lookahead = index + 1;
      while (/\s/u.test(stripped[lookahead] || '') && lookahead < stripped.length) lookahead++;
      if (stripped[lookahead] !== '}' && stripped[lookahead] !== ']') cleaned += char;
    } else cleaned += char;
  }
  try { return JSON.parse(cleaned); } catch { throw fail(); }
}

async function readBounded(filename, limit, code = 'PET_INVALID_PACK') {
  const handle = await fs.open(filename, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw fail('宠物素材文件无效或超过大小限制。', code);
    const bytes = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > limit || offset !== stat.size) throw fail('宠物素材文件在读取时发生变化，请重试。', code);
    return bytes.subarray(0, offset);
  } finally { await handle.close(); }
}

function under(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function safeFile(root, relative) {
  if (typeof relative !== 'string' || relative.includes('\0') || path.isAbsolute(relative)) throw fail();
  const target = path.resolve(root, relative);
  if (!under(root, target)) throw fail();
  // A reparse point anywhere below the selected root cannot redirect a copy.
  const pieces = path.relative(root, target).split(path.sep);
  let current = root;
  for (const piece of pieces) {
    current = path.join(current, piece);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw fail();
  }
  const canonical = await fs.realpath(target);
  if (!under(root, canonical)) throw fail();
  return canonical;
}

function webm(bytes) {
  return bytes.length >= 32 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && bytes.subarray(4, 4096).includes(Buffer.from('webm'));
}

function names(value, optional = true) {
  if (value === undefined && optional) return [];
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.length > PET_LIMITS.clips || list.some(name => !validName(name))) throw fail();
  return [...new Set(list)];
}

function animationMap(config) {
  if (!plainObject(config) || !plainObject(config.animations)) throw fail();
  const source = config.animations;
  const output = Object.fromEntries(STATES.map(state => [state, []]));
  output.idle = names(source.idle, false);
  if (!output.idle.length) throw fail();
  for (const state of ['clicks', 'drag', 'turn']) output[state] = names(source[state]);
  if (source.categories !== undefined) {
    if (!Array.isArray(source.categories) || source.categories.length > 64) throw fail();
    for (const category of source.categories) {
      if (!plainObject(category)) throw fail();
      output.actions.push(...names(category.actions));
    }
  }
  if (source.moves !== undefined) {
    if (!plainObject(source.moves) || !Array.isArray(source.moves.actions) || source.moves.actions.length > PET_LIMITS.clips) throw fail();
    for (const action of source.moves.actions) {
      if (!plainObject(action)) throw fail();
      output.actions.push(...names(action.name, false));
    }
  }
  if (source.events?.workStatus !== undefined) {
    if (!plainObject(source.events) || !Array.isArray(source.events.workStatus) || source.events.workStatus.length > 32) throw fail();
    for (let index = 0; index < WORK_STATES.length; index++) output[WORK_STATES[index]] = names(source.events.workStatus[index]);
  }
  output.actions = [...new Set(output.actions)];
  if (new Set(Object.values(output).flat()).size > PET_LIMITS.clips) throw fail('宠物素材包最多包含 256 段动画。', 'PET_PACK_LIMIT');
  return output;
}

function packView(pack) {
  return { id: pack.id, name: pack.name, source: pack.source, license: pack.license,
    animations: Object.fromEntries(STATES.map(state => [state, pack.animations[state].map(name => ({ name, url: pathToFileURL(path.join(pack.dir, 'webm', `${name}.webm`)).href }))])) };
}

function validSettings(value, partial) {
  if (!plainObject(value) || !Object.keys(value).length || Object.keys(value).some(key => !settingsKeys.includes(key)) || (!partial && settingsKeys.some(key => !Object.hasOwn(value, key)))) return false;
  return (!Object.hasOwn(value, 'enabled') || typeof value.enabled === 'boolean')
    && (!Object.hasOwn(value, 'workStatus') || typeof value.workStatus === 'boolean')
    && (!Object.hasOwn(value, 'size') || Number.isInteger(value.size) && value.size >= 80 && value.size <= 600)
    && ['x', 'y'].every(key => !Object.hasOwn(value, key) || Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 1)
    && (!Object.hasOwn(value, 'packId') || validId(value.packId));
}

class DshPetStore {
  #dir; #file; #packsDir; #builtinDir; #state = defaults(); #packs = []; #initializing; #queue = Promise.resolve();
  constructor({ dataDir, builtinDir = path.join(__dirname, '..', 'vendor', 'dsh-pet') } = {}) {
    if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0') || typeof builtinDir !== 'string' || !builtinDir.trim()) throw fail('宠物配置目录无效。', 'PET_INVALID_CONFIG');
    this.#dir = path.resolve(dataDir); this.#file = path.join(this.#dir, 'pet-settings.json'); this.#packsDir = path.join(this.#dir, 'pet-packs'); this.#builtinDir = path.resolve(builtinDir);
    this.#packs = [{ id: 'dsh-pet', name: 'DSH 蓝色桌宠', source: 'dsh-pet 0.3.8 · PC2005-cloud', license: 'MIT', dir: this.#builtinDir, animations: BUILTIN }];
  }
  snapshot() { return { ...this.#state, packs: this.#packs.map(packView) }; }
  init() {
    if (!this.#initializing) this.#initializing = (async () => {
      let entries = [];
      try { entries = await fs.readdir(this.#packsDir, { withFileTypes: true }); } catch (error) { if (error.code !== 'ENOENT') throw fail('无法读取宠物配置，请检查软件数据目录。', 'PET_STORAGE_ERROR'); }
      for (const entry of entries.slice(0, 256)) {
        if (!entry.isDirectory() || !/^local-[a-f0-9]{24}$/u.test(entry.name) || this.#packs.length > PET_LIMITS.packs) continue;
        try {
          const dir = await fs.realpath(path.join(this.#packsDir, entry.name));
          if (!under(this.#packsDir, dir)) continue;
          const manifest = JSON.parse((await readBounded(await safeFile(dir, 'manifest.json'), PET_LIMITS.configBytes)).toString('utf8'));
          if (!plainObject(manifest) || manifest.version !== 1 || manifest.id !== entry.name || !validName(manifest.name) || typeof manifest.license !== 'string' || manifest.license.length > 100) continue;
          const animations = Object.fromEntries(STATES.map(state => [state, names(manifest.animations?.[state], false)]));
          if (!animations.idle.length || new Set(Object.values(animations).flat()).size > PET_LIMITS.clips) continue;
          let size = 0;
          for (const name of new Set(Object.values(animations).flat())) {
            const bytes = await readBounded(await safeFile(dir, path.join('webm', `${name}.webm`)), PET_LIMITS.clipBytes);
            if (!webm(bytes) || (size += bytes.length) > PET_LIMITS.packBytes) throw fail();
          }
          this.#packs.push({ id: entry.name, name: manifest.name, source: '本地导入 · dsh-pet', license: manifest.license, dir, animations });
        } catch { /* A damaged pack does not disable the built-in pet. */ }
      }
      try {
        const stored = JSON.parse((await readBounded(this.#file, 16384)).toString('utf8'));
        const { version, ...value } = stored;
        if (version === 1 && validSettings(value, false)) this.#state = { ...value, packId: this.#packs.some(pack => pack.id === value.packId) ? value.packId : 'dsh-pet' };
      } catch { /* Preserve corrupt preferences for diagnosis; defaults remain usable. */ }
      return this;
    })();
    return this.#initializing;
  }
  #enqueue(task) { const result = this.#queue.then(task); this.#queue = result.catch(() => {}); return result; }
  async settled() { await this.#queue; }
  async #save(next) {
    await fs.mkdir(this.#dir, { recursive: true });
    const temporary = path.join(this.#dir, `.pet-settings-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, ...next }, null, 2), { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, this.#file);
    } catch { await fs.unlink(temporary).catch(() => {}); throw fail('无法保存宠物设置，请检查软件数据目录。', 'PET_STORAGE_ERROR'); }
    this.#state = next;
    return this.snapshot();
  }
  set(patch) {
    return this.#enqueue(async () => {
      await this.init();
      if (!validSettings(patch, true) || patch.packId && !this.#packs.some(pack => pack.id === patch.packId)) throw fail('宠物设置无效。', 'PET_INVALID_SETTINGS');
      return this.#save({ ...this.#state, ...patch });
    });
  }
  async importDirectory(directory) {
    if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) throw fail();
    const root = await fs.realpath(path.resolve(directory));
    for (const relative of ['config.jsonc', 'config.json', 'main-config.jsonc', 'assets/config.jsonc', 'assets/config.json']) {
      try { return await this.importFile(await safeFile(root, relative)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    throw fail('未找到 dsh-pet 配置，请选择包含 config.jsonc 的素材包目录。');
  }
  importFile(filename) {
    return this.#enqueue(async () => {
      await this.init();
      if (typeof filename !== 'string' || !filename.trim() || filename.includes('\0') || !/\.jsonc?$/iu.test(filename)) throw fail();
      let stage;
      try {
        if ((await fs.lstat(filename)).isSymbolicLink()) throw fail();
        const canonical = await fs.realpath(filename), root = path.dirname(canonical);
        const configBytes = await readBounded(canonical, PET_LIMITS.configBytes), config = parseJsonc(configBytes.toString('utf8'));
        const animations = animationMap(config), allNames = [...new Set(Object.values(animations).flat())];
        const base = path.basename(canonical).replace(/-config\.jsonc?$/iu, '');
        const candidates = ['webm', 'main-animation/webm', 'assets/webm'];
        if (base !== path.basename(canonical)) candidates.unshift(`${base}-animation/webm`);
        let animationDir;
        for (const relative of candidates) {
          try {
            const marker = await safeFile(root, path.join(relative, `${animations.idle[0]}.webm`));
            animationDir = path.dirname(marker); break;
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        if (!animationDir) throw fail('未找到配置对应的 WebM 动画目录。');
        const clips = [], hash = createHash('sha256').update(JSON.stringify(animations));
        let total = 0;
        for (const name of allNames) {
          const clipFile = await safeFile(root, path.relative(root, path.join(animationDir, `${name}.webm`)));
          const bytes = await readBounded(clipFile, PET_LIMITS.clipBytes);
          if (!webm(bytes)) throw fail('素材包包含无效的 WebM 动画。');
          total += bytes.length;
          if (total > PET_LIMITS.packBytes) throw fail('宠物素材包不能超过 256 MB。', 'PET_PACK_LIMIT');
          hash.update(name).update(bytes); clips.push({ name, bytes });
        }
        const id = `local-${hash.digest('hex').slice(0, 24)}`;
        const existing = this.#packs.find(pack => pack.id === id);
        if (existing) return this.#save({ ...this.#state, enabled: true, packId: id });
        if (this.#packs.length >= PET_LIMITS.packs + 1) throw fail('最多可导入 32 个宠物素材包。', 'PET_PACK_LIMIT');
        let name = config.pets?.[0]?.name;
        if (!validName(name)) name = '导入的 DSH 宠物';
        let license = config.license;
        if (typeof license !== 'string' || license.length > 100 || /[\p{Cc}\p{Cf}]/u.test(license)) license = '遵循素材包原许可';
        const manifest = { version: 1, id, name, license, animations };
        await fs.mkdir(this.#packsDir, { recursive: true });
        stage = path.join(this.#packsDir, `.import-${randomUUID()}`);
        await fs.mkdir(path.join(stage, 'webm'), { recursive: true });
        for (const clip of clips) await fs.writeFile(path.join(stage, 'webm', `${clip.name}.webm`), clip.bytes, { flag: 'wx' });
        await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
        const destination = path.join(this.#packsDir, id);
        // Never replace an unrelated existing directory, including a damaged pack.
        try { await fs.lstat(destination); throw fail('同名素材包目录已存在，请检查宠物数据目录。'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await fs.rename(stage, destination); stage = undefined;
        const pack = { ...manifest, source: '本地导入 · dsh-pet', dir: destination };
        this.#packs.push(pack);
        // The copied pack is already complete on disk. Keep it discoverable if
        // preferences cannot be saved so a retry can select it without trying
        // to replace its existing directory. The prior selection stays intact.
        return await this.#save({ ...this.#state, enabled: true, packId: id });
      } catch (error) {
        if (stage && path.dirname(stage) === this.#packsDir && path.basename(stage).startsWith('.import-')) await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
        if (error.code?.startsWith('PET_')) throw error;
        throw fail();
      }
    });
  }
}

module.exports = { DshPetStore, PET_LIMITS, parseJsonc };
