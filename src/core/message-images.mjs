// This is a bounded container-header/dimension check, not a pixel decoder.
// PNG: https://www.w3.org/TR/png/#11IHDR
// JPEG: https://www.w3.org/Graphics/JPEG/itu-t81.pdf (B.2.2)
// WebP: https://developers.google.com/speed/webp/docs/riff_container
// VP8: https://www.rfc-editor.org/rfc/rfc6386#section-9.1
export const IMAGE_ATTACHMENT_LIMITS = Object.freeze({
  maxImages: 4,
  maxImageBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxDimension: 8192,
  maxPixels: 20_000_000,
});

const PREFIXES = new Map([
  ['data:image/png;base64,', { mediaType: 'image/png', extension: 'png' }],
  ['data:image/jpeg;base64,', { mediaType: 'image/jpeg', extension: 'jpg' }],
  ['data:image/webp;base64,', { mediaType: 'image/webp', extension: 'webp' }],
]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DISPLAY_CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu;
const ID_CONTROLS = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

export class ImageAttachmentError extends Error {
  constructor(message, code = 'INVALID_IMAGE_ATTACHMENT') {
    super(message);
    this.name = 'ImageAttachmentError';
    this.code = code;
  }
}

function invalid(index, reason) {
  throw new ImageAttachmentError(`第 ${index + 1} 张图片附件${reason}。`);
}

function limit(index, reason) {
  throw new ImageAttachmentError(`第 ${index + 1} 张图片附件${reason}。`, 'IMAGE_ATTACHMENT_LIMIT');
}

function pngDimensions(bytes, index) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
      || bytes.readUInt32BE(8) !== 13 || !bytes.subarray(12, 16).equals(Buffer.from('IHDR'))) {
    invalid(index, '的 PNG 文件头不完整或与声明类型不符');
  }
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

function jpegDimensions(bytes, index) {
  if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    invalid(index, '的 JPEG 文件头不完整或与声明类型不符');
  }
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalid(index, '的 JPEG 标记头不完整');
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) break;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break; // Do not scan compressed pixel data.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0x00 || marker === 0xd8 || offset + 2 > bytes.length) invalid(index, '的 JPEG 标记头不完整');
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) invalid(index, '的 JPEG 标记长度无效');
    if (SOF_MARKERS.has(marker)) {
      if (length < 8 || !bytes[offset + 7] || length !== 8 + 3 * bytes[offset + 7]) {
        invalid(index, '的 JPEG 尺寸头不完整');
      }
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
  invalid(index, '缺少可读取的 JPEG 尺寸头');
}

function webpDimensions(bytes, index) {
  if (bytes.length < 20 || !bytes.subarray(0, 4).equals(Buffer.from('RIFF'))
      || !bytes.subarray(8, 12).equals(Buffer.from('WEBP'))
      || bytes.readUInt32LE(4) !== bytes.length - 8 || bytes.length % 2 !== 0) {
    invalid(index, '的 WebP 容器头或声明长度无效');
  }
  const length = bytes.readUInt32LE(16);
  const end = 20 + length;
  if (end + length % 2 > bytes.length || (length % 2 && bytes[end] !== 0)) {
    invalid(index, '的 WebP 首块长度无效');
  }
  const chunk = bytes.subarray(12, 16);
  if (chunk.equals(Buffer.from('VP8X'))) {
    if (length !== 10) invalid(index, '的 WebP VP8X 尺寸头无效');
    return [bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1];
  }
  if (chunk.equals(Buffer.from('VP8L'))) {
    if (length < 5 || bytes[20] !== 0x2f) invalid(index, '的 WebP VP8L 尺寸头无效');
    const fields = bytes.readUInt32LE(21);
    if (fields >>> 29) invalid(index, '的 WebP VP8L 版本无效');
    return [(fields & 0x3fff) + 1, ((fields >>> 14) & 0x3fff) + 1];
  }
  if (chunk.equals(Buffer.from('VP8 '))) {
    if (length < 10 || bytes[20] & 1 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      invalid(index, '的 WebP VP8 尺寸头无效');
    }
    return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
  }
  invalid(index, '缺少受支持的 WebP 尺寸头');
}

function checkDimensions(bytes, mediaType, index) {
  const [width, height] = mediaType === 'image/png' ? pngDimensions(bytes, index)
    : mediaType === 'image/jpeg' ? jpegDimensions(bytes, index) : webpDimensions(bytes, index);
  if (!width || !height) invalid(index, '的图片尺寸必须大于零');
  if (width > IMAGE_ATTACHMENT_LIMITS.maxDimension || height > IMAGE_ATTACHMENT_LIMITS.maxDimension
      || width * height > IMAGE_ATTACHMENT_LIMITS.maxPixels) {
    limit(index, '超过单边 8192 像素或总计 2000 万像素的尺寸上限');
  }
}

function displayName(value, extension, index) {
  if (value !== undefined && typeof value !== 'string') invalid(index, '的名称必须为字符串');
  const basename = (value ?? '').split(/[\\/]/u).at(-1);
  const cleaned = Array.from(basename.replace(DISPLAY_CONTROLS, '').trim()).slice(0, 80).join('');
  return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : `image-${index + 1}.${extension}`;
}

/** Normalize untrusted message attachments without mutating or forwarding extra fields. */
export function normalizeImageAttachments(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new ImageAttachmentError('图片附件必须为数组。');
  if (input.length > IMAGE_ATTACHMENT_LIMITS.maxImages) {
    throw new ImageAttachmentError('每条消息最多添加 4 张图片。', 'IMAGE_ATTACHMENT_LIMIT');
  }
  let totalBytes = 0;
  return Array.from(input, (attachment, index) => {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) invalid(index, '必须为对象');
    if (typeof attachment.dataUrl !== 'string') invalid(index, '缺少有效的图片 data URL');
    const comma = attachment.dataUrl.indexOf(',');
    const format = PREFIXES.get(attachment.dataUrl.slice(0, comma + 1));
    if (!format) invalid(index, '仅支持 PNG、JPEG 或 WebP 的 Base64 data URL');
    const encoded = attachment.dataUrl.slice(comma + 1);
    if (encoded.length > 4 * Math.ceil(IMAGE_ATTACHMENT_LIMITS.maxImageBytes / 3)) limit(index, '超过 2 MiB 上限');
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
      invalid(index, '的 Base64 编码不规范');
    }
    const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
    const decodedBytes = encoded.length / 4 * 3 - padding;
    if (decodedBytes > IMAGE_ATTACHMENT_LIMITS.maxImageBytes) limit(index, '超过 2 MiB 上限');
    totalBytes += decodedBytes;
    if (totalBytes > IMAGE_ATTACHMENT_LIMITS.maxTotalBytes) limit(index, '使附件总大小超过 8 MiB 上限');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) invalid(index, '的 Base64 尾部位或填充不规范');
    if (attachment.mediaType !== undefined && attachment.mediaType !== format.mediaType) {
      invalid(index, '的 mediaType 与 data URL 不一致');
    }
    if (attachment.id !== undefined && (typeof attachment.id !== 'string' || !attachment.id.trim()
        || Array.from(attachment.id).length > 100 || ID_CONTROLS.test(attachment.id))) {
      invalid(index, '的 id 必须为不含控制字符的 1 至 100 字符字符串');
    }
    checkDimensions(bytes, format.mediaType, index);
    return {
      ...(attachment.id === undefined ? {} : { id: attachment.id }),
      name: displayName(attachment.name, format.extension, index),
      mediaType: format.mediaType,
      dataUrl: attachment.dataUrl,
    };
  });
}
