const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function createPluginExample(source, parent) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  if (!entries.length || entries.length > 20 || entries.some(entry => !entry.isFile() || entry.isSymbolicLink()))
    throw new Error('插件示例文件不完整，请重新安装软件。');
  const files = [];
  for (const entry of entries) {
    const filename = path.join(source, entry.name), stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('插件示例文件无效。');
    files.push({ name: entry.name, bytes: await fs.readFile(filename) });
  }
  const destination = path.join(parent, 'hello-plugin'), written = [];
  // Reserve a new directory atomically. Never merge with an existing project.
  await fs.mkdir(destination);
  try {
    for (const file of files) {
      await fs.writeFile(path.join(destination, file.name), file.bytes, { flag: 'wx' });
      written.push(file);
    }
    return destination;
  } catch (error) {
    // Remove only unchanged files created by this operation. rmdir succeeds
    // only while the directory is empty, preserving any concurrent user file.
    for (const file of written) {
      const filename = path.join(destination, file.name);
      try { if (hash(await fs.readFile(filename)) === hash(file.bytes)) await fs.unlink(filename); } catch {}
    }
    await fs.rmdir(destination).catch(() => {});
    throw error;
  }
}
module.exports = { createPluginExample };
