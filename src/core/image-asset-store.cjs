'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

function createImageAssetStore({ dataDir, nativeImage, clipboard, shell }) {
  const dir = path.join(path.resolve(dataDir), 'generated-images');
  function decode(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length > 28 * 1024 * 1024) throw new Error('图片数据无效或过大。');
    const match = /^data:image\/(png|jpeg|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/u.exec(dataUrl);
    if (!match) throw new Error('图片数据格式无效。');
    const bytes = Buffer.from(match[2], 'base64'), image = nativeImage.createFromBuffer(bytes);
    const signatureValid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : match[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!signatureValid) throw new Error('图片内容与格式不匹配。');
    if (!bytes.length || image.isEmpty()) throw new Error('图片无法解码。');
    const size = image.getSize(); if (!size.width || !size.height || size.width > 8192 || size.height > 8192 || size.width * size.height > 20000000) throw new Error('图片尺寸超出限制。');
    return { bytes, image, extension: match[1] === 'jpeg' ? 'jpg' : match[1] };
  }
  async function ensureDir() {
    await fs.mkdir(dir, { recursive: true });
    const stat = await fs.lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('图片保存目录无效。');
    const real = await fs.realpath(dir), parent = await fs.realpath(path.dirname(dir));
    if (real !== path.join(parent, path.basename(dir))) throw new Error('图片保存目录无效。');
  }
  async function save(dataUrl) {
    const { bytes, extension } = decode(dataUrl); await ensureDir();
    const hash = createHash('sha256').update(bytes).digest('hex'), filename = path.join(dir, `image-${hash}.${extension}`);
    try { await fs.writeFile(filename, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error;
      const stat = await fs.lstat(filename); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('图片文件路径无效。');
      const existing = await fs.readFile(filename); if (!existing.equals(bytes)) throw new Error('图片文件校验失败。'); }
    return filename;
  }
  async function trustedOriginal(storedPath) {
    if (typeof storedPath === 'string' && path.dirname(storedPath) === dir && /^image-[a-f0-9]{64}\.(png|jpg|webp)$/u.test(path.basename(storedPath))) {
      await ensureDir(); const stat = await fs.lstat(storedPath).catch(() => null);
      if (stat?.isFile() && !stat.isSymbolicLink() && stat.size <= 21 * 1024 * 1024) { const bytes = await fs.readFile(storedPath); if (createHash('sha256').update(bytes).digest('hex') === path.basename(storedPath).slice(6, 70)) return bytes; }
    }
    return null;
  }
  async function reveal(dataUrl, storedPath) {
    const filename = await trustedOriginal(storedPath) ? storedPath : await save(dataUrl);
    shell.showItemInFolder(filename); return filename;
  }
  async function copy(dataUrl, storedPath) {
    const original = await trustedOriginal(storedPath);
    const image = original ? nativeImage.createFromBuffer(original) : decode(dataUrl).image;
    if (image.isEmpty()) throw new Error('图片无法解码。'); clipboard.writeImage(image);
  }
  return { save, copy, reveal };
}
module.exports = { createImageAssetStore };
