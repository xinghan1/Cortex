const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MARKERS = ['settings.json', 'usage.json', 'projects.json', 'migration.json', 'task-undo', path.join('chatgpt', 'chatgpt-auth.json')];
const exists = filename => {
  try { syncFs.lstatSync(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
function freshDestination(target) {
  return !MARKERS.some(marker => exists(path.join(target, marker)));
}
function directory(filename) {
  try {
    const info = syncFs.lstatSync(filename);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function findLegacyData(destination, candidates) {
  const target = path.resolve(destination);
  if (!freshDestination(target)) return null;
  return candidates.map(candidate => path.resolve(candidate)).find(source =>
    source.toLowerCase() !== target.toLowerCase() && directory(source)
      && MARKERS.some(marker => exists(path.join(source, marker)))) || null;
}

function readLocalState(filename) {
  const info = syncFs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('旧版应用加密状态无法安全读取，请保留原数据目录后重试。');
  let value;
  try { value = JSON.parse(syncFs.readFileSync(filename, 'utf8')); }
  catch { throw new Error('应用加密状态无法读取，请保留原数据目录后重试。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('应用加密状态格式无效，请保留原数据目录后重试。');
  return value;
}

function hasProtectedCredentials(source) {
  if (exists(path.join(source, 'chatgpt', 'chatgpt-auth.json'))) return true;
  const undoDirectory = path.join(source, 'task-undo');
  if (directory(undoDirectory) && syncFs.readdirSync(undoDirectory, { withFileTypes: true })
    .some(entry => entry.isFile() && /^[a-f\d-]{36}\.json$/iu.test(entry.name))) return true;
  const filename = path.join(source, 'settings.json');
  if (!exists(filename)) return false;
  const info = syncFs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('旧版模型配置无法安全读取，原数据已保留。');
  let settings;
  try { settings = JSON.parse(syncFs.readFileSync(filename, 'utf8')); }
  catch { throw new Error('旧版模型配置无法读取，原数据已保留。'); }
  const encrypted = value => typeof value?.encryptedKey === 'string' && value.encryptedKey.length > 0;
  return encrypted(settings) || Object.values(settings?.providers || {}).some(encrypted);
}

// Electron 44 on Windows binds safeStorage to the session profile's os_crypt
// state. Its key is loaded before `ready`; copying credentials in boot() alone
// leaves them unreadable. Copy only OS-protected encryption state, no cookies,
// browsing state or unrelated Chromium preferences, before Electron is ready.
function prepareLegacyEncryptionState(destination, legacy) {
  const source = path.resolve(legacy), target = path.resolve(destination);
  if (source.toLowerCase() === target.toLowerCase() || !directory(source) || !freshDestination(target)) return false;
  const needsKey = hasProtectedCredentials(source);
  const missingState = () => {
    if (needsKey) throw new Error('旧版登录文件、API 密钥或撤销记录缺少配套的本机加密状态，已停止迁移并保留原数据。请使用包含完整 data 目录的备份。');
    return false;
  };
  const sourceProfile = path.join(source, 'chromium');
  if (!exists(sourceProfile)) return missingState();
  if (!directory(sourceProfile)) throw new Error('旧版应用加密状态目录不可安全读取。');
  const from = path.join(sourceProfile, 'Local State');
  if (!exists(from)) return missingState();
  const cryptoState = readLocalState(from).os_crypt;
  if (cryptoState === undefined) return missingState();
  if (!cryptoState || typeof cryptoState !== 'object' || Array.isArray(cryptoState)
      || typeof cryptoState.encrypted_key !== 'string' || !cryptoState.encrypted_key) throw new Error('旧版应用加密状态不完整，请保留原数据目录后重试。');
  if (exists(target) && !directory(target)) throw new Error('新版本数据目录不能为符号链接。');
  const targetProfile = path.join(target, 'chromium');
  if (exists(targetProfile) && !directory(targetProfile)) throw new Error('新版本加密状态目录不能为符号链接。');
  syncFs.mkdirSync(targetProfile, { recursive: true });
  const to = path.join(targetProfile, 'Local State');
  if (exists(to)) {
    const current = readLocalState(to);
    if (current.os_crypt?.encrypted_key === cryptoState.encrypted_key) return false;
    // Never replace a key that might already protect newly created credentials.
    throw new Error('新版本数据目录已有不同的加密状态，已保留原文件；请使用完整的原数据目录，或选择新的安装目录升级。');
  }
  syncFs.writeFileSync(to, JSON.stringify({ os_crypt: cryptoState }), { flag: 'wx', mode: 0o600 });
  return true;
}

// Copy only app-owned settings, recents, usage and session JSON into a fresh portable installation.
// Do not touch the running older app, copy browser caches, or overwrite new data.
async function migrateLegacyData(destination, legacy, { encryptionPrepared = false } = {}) {
  const source = path.resolve(legacy), target = path.resolve(destination);
  if (source.toLowerCase() === target.toLowerCase()) return false;
  const sourceStat = await fs.lstat(source).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!sourceStat || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) return false;
  for (const marker of MARKERS) {
    try { await fs.access(path.join(target, marker)); return false; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await fs.mkdir(target, { recursive: true });
  if ((await fs.lstat(target)).isSymbolicLink()) throw new Error('数据目录不能为符号链接。');
  if (!encryptionPrepared) prepareLegacyEncryptionState(target, source);
  const copy = async relative => {
    const from = path.join(source, relative), to = path.join(target, relative);
    const stat = await fs.lstat(from).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) return;
    await fs.mkdir(path.dirname(to), { recursive: true });
    const temp = `${to}.${randomUUID()}.tmp`;
    await fs.copyFile(from, temp);
    await fs.rename(temp, to);
  };
  const sessions = path.join(source, 'sessions');
  const sessionStat = await fs.lstat(sessions).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (sessionStat?.isDirectory() && !sessionStat.isSymbolicLink()) {
    for (const entry of await fs.readdir(sessions, { withFileTypes: true })) {
      if (entry.isFile() && /^[a-f0-9-]{36}\.json$/.test(entry.name)) await copy(path.join('sessions', entry.name));
    }
  }
  const undoDirectory = path.join(source, 'task-undo');
  const undoStat = await fs.lstat(undoDirectory).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (undoStat?.isDirectory() && !undoStat.isSymbolicLink()) {
    for (const entry of await fs.readdir(undoDirectory, { withFileTypes: true })) {
      if (entry.isFile() && /^[a-f\d-]{36}\.json$/iu.test(entry.name)) await copy(path.join('task-undo', entry.name));
    }
  }
  await copy('usage.json');
  await copy('preferences.json');
  await copy('projects.json');
  await copy('settings.json');
  const authDirectory = await fs.lstat(path.join(source, 'chatgpt')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (authDirectory?.isDirectory() && !authDirectory.isSymbolicLink()) {
    // Keep the encrypted connection together with its runtime identity. Never
    // copy OAuth locks, callback state, temporary files or Chromium cookies.
    for (const name of ['chatgpt-host.json', 'chatgpt-auth.json']) await copy(path.join('chatgpt', name));
  }
  await fs.writeFile(path.join(target, 'migration.json'), JSON.stringify({ from: source, copiedAt: new Date().toISOString() }));
  return true;
}
module.exports = { migrateLegacyData, findLegacyData, prepareLegacyEncryptionState };
