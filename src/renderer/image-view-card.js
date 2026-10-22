'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.ForgeImageViewCard = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
  const validId = value => typeof value === 'string' && value.trim().length > 0
    && Array.from(value).length <= 100 && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);
  const displayName = (value, index) => typeof value === 'string'
    ? Array.from(value.split(/[\\/]/u).at(-1).replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').trim()).slice(0, 80).join('') || `图片 ${index + 1}`
    : `图片 ${index + 1}`;
  function references(event) {
    if (event?.type !== 'images-viewed' || event.version !== 1 || !Array.isArray(event.images)
        || !event.images.length || event.images.length > 64) return [];
    const result = [], seen = new Set();
    for (const image of event.images) {
      if (!image || !validId(image.messageId) || !Number.isInteger(image.attachmentIndex)
          || image.attachmentIndex < 0 || image.attachmentIndex > 3
          || image.attachmentId !== undefined && !validId(image.attachmentId)) continue;
      const key = `${image.messageId}\u0000${image.attachmentIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ messageId: image.messageId, attachmentIndex: image.attachmentIndex,
        ...(image.attachmentId === undefined ? {} : { attachmentId: image.attachmentId }) });
    }
    return result;
  }
  function safeImage(attachment) {
    if (!attachment || typeof attachment !== 'object' || typeof attachment.dataUrl !== 'string'
        || attachment.dataUrl.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 64) return null;
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z\d+/]+={0,2})$/u.exec(attachment.dataUrl);
    if (!match || match[2].length % 4 !== 0 || attachment.mediaType !== undefined && attachment.mediaType !== match[1]) return null;
    const bytes = match[2].length / 4 * 3 - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
    if (bytes <= 0 || bytes > MAX_IMAGE_BYTES) return null;
    return { src: attachment.dataUrl, mediaType: match[1] };
  }
  function resolve(event, messages) {
    const sources = new Map();
    for (const message of Array.isArray(messages) ? messages : []) {
      if (message?.role !== 'user' || !validId(message.id)) continue;
      sources.set(message.id, sources.has(message.id) ? null : message);
    }
    const images = references(event).map((reference, index) => {
      const attachment = sources.get(reference.messageId)?.attachments?.[reference.attachmentIndex];
      const matched = reference.attachmentId === undefined || attachment?.id === reference.attachmentId;
      const source = matched ? safeImage(attachment) : null;
      return { ...reference, name: displayName(matched ? attachment?.name : undefined, index),
        available: Boolean(source), ...(source || {}) };
    });
    const availableCount = images.filter(image => image.available).length;
    return { count: images.length, availableCount, missingCount: images.length - availableCount, images };
  }
  const node = (tag, className, text) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function create(event, { messages = [], onPreview = () => {}, onExpand = () => {} } = {}) {
    const resolved = resolve(event, messages);
    if (!resolved.count) return null;
    const card = node('details', 'image-view-card');
    card.open = true;
    if (typeof event.requestId === 'string' && event.requestId.length <= 100) card.dataset.requestId = event.requestId;
    const header = node('summary', 'image-view-header');
    const icon = node('span', 'image-view-icon'); icon.setAttribute('aria-hidden', 'true');
    const label = node('span', 'image-view-label', `已查看 ${resolved.count} 张图像`);
    const chevron = node('span', 'image-view-chevron'); chevron.setAttribute('aria-hidden', 'true');
    header.append(icon, label, chevron);
    const body = node('div', 'image-view-body'), gallery = node('div', 'image-view-gallery');
    for (const [index, image] of resolved.images.entries()) {
      const entry = node('div', 'image-view-entry');
      entry.append(node('span', 'image-view-name', image.name));
      if (image.available) {
        const button = node('button', 'image-view-thumbnail-button');
        button.type = 'button'; button.title = `查看图片：${image.name}`;
        button.setAttribute('aria-label', `查看图片：${image.name}`);
        const thumbnail = node('img', 'image-view-thumbnail');
        thumbnail.src = image.src; thumbnail.alt = image.name; thumbnail.loading = 'lazy'; thumbnail.decoding = 'async';
        const unavailable = node('span', 'image-view-unavailable', '预览不可用'); unavailable.hidden = true;
        let loaded = true;
        thumbnail.addEventListener('error', () => { loaded = false; thumbnail.hidden = true; unavailable.hidden = false; button.disabled = true; });
        button.addEventListener('click', () => { if (loaded) onPreview({ src: image.src, name: image.name, mediaType: image.mediaType }); });
        button.append(thumbnail, unavailable); entry.prepend(button);
      } else {
        const missing = node('div', 'image-view-unavailable', '原图未保留');
        missing.setAttribute('aria-label', `第 ${index + 1} 张图像原图未保留`); entry.prepend(missing);
      }
      gallery.append(entry);
    }
    body.append(gallery);
    card.append(header, body);
    card.addEventListener('toggle', () => { if (card.open) onExpand(card); });
    return card;
  }
  return Object.freeze({ references, resolve, create });
});
