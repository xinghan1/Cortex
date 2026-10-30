const path = require('node:path');
const fs = require('node:fs');

// Only installer builds carry synoraInstalled in their packaged metadata.
// Their data must survive replacement or removal of the executable directory.
function resolveDataDirectory({ override, isPackaged, isInstalled, appDataPath, execPath, projectDir, smoke = false }) {
  if (override) return override;
  if (!isPackaged) return path.join(projectDir, smoke ? '.smoke-data-v16-6' : '.local-data');
  if (isInstalled) return path.join(appDataPath, 'Cortex');
  return path.join(path.dirname(execPath), 'data');
}

// Preserve the complete old profile, including its Chromium encryption state and
// official account stores. Stage the copy before publishing it to avoid ever
// treating an interrupted migration as a complete profile.
function migrateInstalledProfile(appDataPath) {
  const source = path.join(appDataPath, 'Synora code');
  const target = path.join(appDataPath, 'Cortex');
  const stat = filename => { try { return fs.lstatSync(filename); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  if (stat(target)) return false;
  const sourceStat = stat(source);
  if (!sourceStat) return false;
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw new Error('旧版数据目录不是安全的普通目录，已保留原数据。');
  const staging = fs.mkdtempSync(path.join(appDataPath, '.cortex-migration-'));
  try {
    const copy = path.join(staging, 'profile');
    fs.cpSync(source, copy, { recursive: true, errorOnExist: true, force: false, filter: filename => {
      if (fs.lstatSync(filename).isSymbolicLink()) throw new Error('旧版数据包含符号链接，已停止迁移并保留原数据。');
      return true;
    } });
    // Never merge into an already existing destination.
    if (stat(target)) throw new Error('Cortex 数据目录已存在，已保留两个目录。');
    fs.renameSync(copy, target);
    return true;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

module.exports = { resolveDataDirectory, migrateInstalledProfile };
