const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const APPEARANCE_LIMITS = Object.freeze({ maxImageBytes: 12 * 1024 * 1024, maxDimension: 16384, maxPixels: 64_000_000 });
const DEFAULT_TRANSPARENCY = 28;
const DEFAULT_FROST = 70;
const DEFAULT_PANEL_TRANSPARENCY = 30;
const DEFAULT_CONVERSATION_TEXT_COLOR = 'white';
const CONVERSATION_TEXT_COLORS = Object.freeze(['red', 'yellow', 'green', 'blue', 'white', 'black']);
const DEFAULT_BACKGROUND_PRESET = 'aurora';
const BACKGROUND_PRESETS = Object.freeze(['aurora', 'rose', 'amber', 'forest', 'ocean', 'snow', 'midnight', 'orange', 'purple', 'olive', 'pink', 'magenta', 'cyan']);
const DEFAULT_UI_STYLE = 'glass';
const UI_STYLES = Object.freeze(['glass', 'black', 'white', 'industrial', 'deepseek', 'codex']);
const DEFAULT_SELECTION_COLOR = null;
const validSelectionColor = value => value === null || typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value);
const LEGACY_FROST_FIELDS = Object.freeze(['sidebarFrost', 'conversationFrost', 'previewFrost']);
const MAX_DOCUMENT_BYTES = 4 * Math.ceil(APPEARANCE_LIMITS.maxImageBytes / 3) + 4096;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const FORMATS = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp']]);
const PREFIXES = new Map([...new Set(FORMATS.values())].map(type => [`data:${type};base64,`, type]));
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const validTransparency = value => Number.isInteger(value) && value >= 0 && value <= 100;
const appearanceError = (message, code) => Object.assign(new Error(message), { code });
const invalidImage = () => appearanceError('背景图片无效，请选择有效的 PNG、JPEG 或 WebP 图片。', 'APPEARANCE_INVALID_IMAGE');
const imageLimit = () => appearanceError('背景图片不能超过 12 MiB、单边 16384 像素或总计 6400 万像素。', 'APPEARANCE_IMAGE_LIMIT');
const defaultState = () => ({
  backgroundImage: null,
  backgroundName: '',
  backgroundTransparency: DEFAULT_TRANSPARENCY,
  panelFrost: DEFAULT_FROST,
  panelTransparency: DEFAULT_PANEL_TRANSPARENCY,
  conversationTextColor: DEFAULT_CONVERSATION_TEXT_COLOR,
  backgroundPreset: DEFAULT_BACKGROUND_PRESET,
  uiStyle: DEFAULT_UI_STYLE,
  selectionColor: DEFAULT_SELECTION_COLOR,
});

function displayName(value) {
  return Array.from(value.split(/[\\/]/u).at(-1).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').trim()).slice(0, 120).join('');
}

// Check bounded container metadata before handing compressed bytes to Chromium's
// raster decoder. In particular, a tiny compressed file cannot request an
// unbounded decoded bitmap. These are not substitutes for the native decode.
function imageDimensions(bytes, mediaType) {
  if (mediaType === 'image/png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
        || bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') throw invalidImage();
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (mediaType === 'image/jpeg') {
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) throw invalidImage();
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) throw invalidImage();
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) break;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (marker === 0x00 || marker === 0xd8 || offset + 2 > bytes.length) throw invalidImage();
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) throw invalidImage();
      if (SOF_MARKERS.has(marker)) {
        if (length < 8 || !bytes[offset + 7] || length !== 8 + 3 * bytes[offset + 7]) throw invalidImage();
        return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      }
      offset += length;
    }
    throw invalidImage();
  }
  if (mediaType !== 'image/webp' || bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'RIFF'
      || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) !== bytes.length - 8
      || bytes.length % 2) throw invalidImage();
  const length = bytes.readUInt32LE(16), end = 20 + length;
  if (end + length % 2 > bytes.length || (length % 2 && bytes[end] !== 0)) throw invalidImage();
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    if (length !== 10) throw invalidImage();
    return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
  }
  if (chunk === 'VP8L') {
    if (length < 5 || bytes[20] !== 0x2f) throw invalidImage();
    const fields = bytes.readUInt32LE(21);
    if (fields >>> 29) throw invalidImage();
    return [(fields & 0x3fff) + 1, ((fields >>> 14) & 0x3fff) + 1];
  }
  if (chunk !== 'VP8 ' || length < 10 || bytes[20] & 1
      || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) throw invalidImage();
  return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
}

function validateRaster(bytes, mediaType, decodeImage) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw invalidImage();
  if (bytes.length > APPEARANCE_LIMITS.maxImageBytes) throw imageLimit();
  const [width, height] = imageDimensions(bytes, mediaType);
  if (!width || !height) throw invalidImage();
  if (width > APPEARANCE_LIMITS.maxDimension || height > APPEARANCE_LIMITS.maxDimension
      || width * height > APPEARANCE_LIMITS.maxPixels) throw imageLimit();
  let decoded;
  try { decoded = decodeImage(bytes); } catch { throw invalidImage(); }
  if (!decoded || !Number.isInteger(decoded.width) || !Number.isInteger(decoded.height)
      || !((decoded.width === width && decoded.height === height) || (decoded.width === height && decoded.height === width))) throw invalidImage();
}

async function readBounded(filename, maxBytes, tooLarge) {
  let handle;
  try {
    handle = await fs.open(filename, 'r');
    const stat = await handle.stat();
    if (!stat.isFile()) throw invalidImage();
    if (stat.size > maxBytes) throw tooLarge();
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > maxBytes) throw tooLarge();
    return buffer.subarray(0, offset);
  } finally {
    if (handle) await handle.close();
  }
}

class AppearanceStore {
  #dir;
  #file;
  #decodeImage;
  #state = defaultState();
  #initializing;
  #queue = Promise.resolve();

  constructor(options = {}) {
    const { dataDir, decodeImage } = options || {};
    if (typeof dataDir !== 'string' || !dataDir.trim() || dataDir.includes('\0') || typeof decodeImage !== 'function') {
      throw appearanceError('界面外观存储配置无效。', 'APPEARANCE_INVALID_CONFIG');
    }
    this.#dir = path.resolve(dataDir);
    this.#file = path.join(this.#dir, 'appearance.json');
    this.#decodeImage = decodeImage;
  }

  snapshot() { return { ...this.#state }; }

  init() {
    if (!this.#initializing) {
      this.#initializing = (async () => {
        try {
          const value = JSON.parse((await readBounded(this.#file, MAX_DOCUMENT_BYTES, invalidImage)).toString('utf8'));
          const fields = ['backgroundImage', 'backgroundName', 'backgroundTransparency', 'version'];
          if (value?.version >= 2 && value.version <= 4) fields.push(...LEGACY_FROST_FIELDS);
          if (value?.version >= 5) fields.push('panelFrost', 'panelTransparency');
          if (value?.version >= 3) fields.push('conversationTextColor');
          if (value?.version >= 4) fields.push('backgroundPreset');
          if (value?.version >= 6) fields.push('uiStyle');
          if (value?.version >= 7) fields.push('selectionColor');
          if (!value || Array.isArray(value) || ![1, 2, 3, 4, 5, 6, 7].includes(value.version) || Object.keys(value).sort().join(',') !== fields.sort().join(',')
              || !validTransparency(value.backgroundTransparency) || typeof value.backgroundName !== 'string'
              || value.backgroundName !== displayName(value.backgroundName)) throw invalidImage();
          if (value.version >= 2 && value.version <= 4 && LEGACY_FROST_FIELDS.some(field => !validTransparency(value[field]))) throw invalidImage();
          if (value.version >= 5 && (!validTransparency(value.panelFrost) || !validTransparency(value.panelTransparency))) throw invalidImage();
          if (value.version >= 3 && !CONVERSATION_TEXT_COLORS.includes(value.conversationTextColor)) throw invalidImage();
          if (value.version >= 4 && !BACKGROUND_PRESETS.includes(value.backgroundPreset)) throw invalidImage();
          if (value.version >= 6 && !UI_STYLES.includes(value.uiStyle)) throw invalidImage();
          if (value.version >= 7 && !validSelectionColor(value.selectionColor)) throw invalidImage();
          if (value.backgroundImage === null) {
            if (value.backgroundName !== '') throw invalidImage();
          } else {
            if (typeof value.backgroundImage !== 'string' || !value.backgroundName) throw invalidImage();
            const comma = value.backgroundImage.indexOf(','), prefix = value.backgroundImage.slice(0, comma + 1);
            const mediaType = PREFIXES.get(prefix), encoded = value.backgroundImage.slice(comma + 1);
            if (!mediaType || !encoded || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) throw invalidImage();
            const bytes = Buffer.from(encoded, 'base64');
            if (bytes.toString('base64') !== encoded) throw invalidImage();
            validateRaster(bytes, mediaType, this.#decodeImage);
          }
          this.#state = {
            ...defaultState(),
            backgroundImage: value.backgroundImage,
            backgroundName: value.backgroundName,
            backgroundTransparency: value.backgroundTransparency,
          };
          if (value.version >= 2 && value.version <= 4) {
            this.#state.panelFrost = Math.round(LEGACY_FROST_FIELDS.reduce((sum, field) => sum + value[field], 0) / LEGACY_FROST_FIELDS.length);
          }
          if (value.version >= 5) {
            this.#state.panelFrost = value.panelFrost;
            this.#state.panelTransparency = value.panelTransparency;
          }
          if (value.version >= 3) this.#state.conversationTextColor = value.conversationTextColor;
          if (value.version >= 4) this.#state.backgroundPreset = value.backgroundPreset;
          if (value.version >= 6) this.#state.uiStyle = value.uiStyle;
          if (value.version >= 7) this.#state.selectionColor = value.selectionColor?.toLowerCase() ?? null;
        } catch {
          // A damaged background must not prevent startup or overwrite the
          // original file. The user can import another image or reset it.
        }
        return this;
      })();
    }
    return this.#initializing;
  }

  #enqueue(operation) {
    const pending = this.#queue.then(async () => { await this.init(); return operation(); });
    this.#queue = pending.catch(() => {});
    return pending;
  }

  async #persist(next) {
    const temporary = path.join(this.#dir, `.appearance-${randomUUID()}.tmp`);
    let handle;
    try {
      await fs.mkdir(this.#dir, { recursive: true });
      handle = await fs.open(temporary, 'wx', 0o600);
      // A single versioned document commits both image bytes and metadata.
      // There is no two-file state in which metadata refers to a missing image.
      await handle.writeFile(JSON.stringify({ version: 7, ...next }) + '\n', 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(temporary, this.#file);
      this.#state = next;
      return this.snapshot();
    } catch {
      throw appearanceError('外观设置保存失败，请稍后重试。', 'APPEARANCE_SAVE_FAILED');
    } finally {
      if (handle) { try { await handle.close(); } catch { /* Preserve the sanitized save error. */ } }
      try { await fs.unlink(temporary); } catch { /* Already committed or unavailable. */ }
    }
  }

  importFile(filename) {
    return this.#enqueue(async () => {
      if (typeof filename !== 'string' || !path.isAbsolute(filename) || filename.includes('\0')) throw invalidImage();
      const mediaType = FORMATS.get(path.extname(filename).toLowerCase());
      if (!mediaType) throw invalidImage();
      let bytes;
      try { bytes = await readBounded(filename, APPEARANCE_LIMITS.maxImageBytes, imageLimit); }
      catch (error) {
        if (error.code === 'APPEARANCE_IMAGE_LIMIT' || error.code === 'APPEARANCE_INVALID_IMAGE') throw error;
        throw appearanceError('背景图片读取失败，请重新选择图片。', 'APPEARANCE_READ_FAILED');
      }
      validateRaster(bytes, mediaType, this.#decodeImage);
      return this.#persist({ ...this.#state, backgroundImage: `data:${mediaType};base64,${bytes.toString('base64')}`, backgroundName: displayName(filename) || '背景图片' });
    });
  }

  setAppearance(input) {
    const fields = input && typeof input === 'object' && !Array.isArray(input) ? Reflect.ownKeys(input) : [];
    const hasFrost = fields.includes('panelFrost') || fields.some(field => LEGACY_FROST_FIELDS.includes(field));
    const hasPanelTransparency = fields.includes('panelTransparency');
    const hasTextColor = fields.includes('conversationTextColor');
    const hasPreset = fields.includes('backgroundPreset');
    const hasUiStyle = fields.includes('uiStyle');
    const hasSelectionColor = fields.includes('selectionColor');
    if (!fields.length || fields.some(field => !['backgroundTransparency', 'conversationTextColor', 'backgroundPreset', 'panelFrost', 'panelTransparency', 'uiStyle', 'selectionColor'].includes(field))) {
      if (hasSelectionColor) return Promise.reject(appearanceError('选中颜色设置包含无效字段。', 'APPEARANCE_INVALID_SELECTION_COLOR'));
      if (hasUiStyle) return Promise.reject(appearanceError('界面风格设置包含无效字段。', 'APPEARANCE_INVALID_UI_STYLE'));
      if (hasPreset) return Promise.reject(appearanceError('背景样式设置包含无效字段。', 'APPEARANCE_INVALID_BACKGROUND_PRESET'));
      if (hasTextColor) return Promise.reject(appearanceError('会话文字颜色设置包含无效字段。', 'APPEARANCE_INVALID_TEXT_COLOR'));
      if (hasFrost) return Promise.reject(appearanceError('磨砂设置包含无效字段。', 'APPEARANCE_INVALID_FROST'));
      if (hasPanelTransparency) return Promise.reject(appearanceError('面板透明度设置包含无效字段。', 'APPEARANCE_INVALID_PANEL_TRANSPARENCY'));
      return Promise.reject(appearanceError('背景透明度必须为 0 至 100 之间的整数。', 'APPEARANCE_INVALID_TRANSPARENCY'));
    }
    const patch = Object.fromEntries(fields.map(field => [field, input[field]]));
    if (Object.hasOwn(patch, 'backgroundTransparency') && !validTransparency(patch.backgroundTransparency)) {
      return Promise.reject(appearanceError('背景透明度必须为 0 至 100 之间的整数。', 'APPEARANCE_INVALID_TRANSPARENCY'));
    }
    if (Object.hasOwn(patch, 'panelFrost') && !validTransparency(patch.panelFrost)) {
      return Promise.reject(appearanceError('磨砂强度必须为 0 至 100 之间的整数。', 'APPEARANCE_INVALID_FROST'));
    }
    if (hasPanelTransparency && !validTransparency(patch.panelTransparency)) {
      return Promise.reject(appearanceError('面板透明度必须为 0 至 100 之间的整数。', 'APPEARANCE_INVALID_PANEL_TRANSPARENCY'));
    }
    if (hasTextColor && !CONVERSATION_TEXT_COLORS.includes(patch.conversationTextColor)) {
      return Promise.reject(appearanceError('会话文字颜色必须为红、黄、绿、蓝、白或黑。', 'APPEARANCE_INVALID_TEXT_COLOR'));
    }
    if (hasPreset && !BACKGROUND_PRESETS.includes(patch.backgroundPreset)) {
      return Promise.reject(appearanceError('请选择有效的内置背景样式。', 'APPEARANCE_INVALID_BACKGROUND_PRESET'));
    }
    if (hasUiStyle && !UI_STYLES.includes(patch.uiStyle)) {
      return Promise.reject(appearanceError('请选择有效的界面风格。', 'APPEARANCE_INVALID_UI_STYLE'));
    }
    if (hasSelectionColor && !validSelectionColor(patch.selectionColor)) {
      return Promise.reject(appearanceError('请选择有效的六位十六进制颜色。', 'APPEARANCE_INVALID_SELECTION_COLOR'));
    }
    if (hasSelectionColor && patch.selectionColor !== null) patch.selectionColor = patch.selectionColor.toLowerCase();
    if (hasPreset) {
      patch.backgroundImage = null;
      patch.backgroundName = '';
    }
    return this.#enqueue(() => this.#persist({ ...this.#state, ...patch }));
  }

  resetBackground() {
    return this.#enqueue(() => this.#persist({ ...this.#state, backgroundImage: null, backgroundName: '', backgroundTransparency: DEFAULT_TRANSPARENCY, backgroundPreset: DEFAULT_BACKGROUND_PRESET }));
  }
}

module.exports = {
  AppearanceStore, APPEARANCE_LIMITS, DEFAULT_TRANSPARENCY, DEFAULT_FROST, DEFAULT_PANEL_TRANSPARENCY,
  DEFAULT_CONVERSATION_TEXT_COLOR, CONVERSATION_TEXT_COLORS,
  DEFAULT_BACKGROUND_PRESET, BACKGROUND_PRESETS,
  DEFAULT_UI_STYLE, UI_STYLES,
  DEFAULT_SELECTION_COLOR,
};
