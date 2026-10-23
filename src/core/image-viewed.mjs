import { normalizeImageAttachments } from './message-images.mjs';

export const MAX_VIEWED_IMAGE_REFERENCES = 64;
const MAX_SEEN_IMAGES = 2048;
const validId = value => typeof value === 'string' && value.trim().length > 0
  && Array.from(value).length <= 100 && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);

/** Called only after a successful ordinary image-bearing model request.
 * Keep references to the original user messages, never another image copy.
 * Request history can include older photos: restrict display evidence to the
 * current run's user-message IDs without removing history from the request. */
export function collectViewedImages(messages, seen = new Set(), allowedMessageIds) {
  if (!Array.isArray(messages) || !(seen instanceof Set)
      || (allowedMessageIds !== undefined && !(allowedMessageIds instanceof Set))) return [];
  const ids = new Map();
  for (const message of messages) if (message?.role === 'user' && validId(message.id))
    ids.set(message.id, (ids.get(message.id) || 0) + 1);
  const references = [];
  for (const message of messages) {
    if (message?.role !== 'user' || !validId(message.id) || ids.get(message.id) !== 1
        || (allowedMessageIds && !allowedMessageIds.has(message.id))
        || !Array.isArray(message.attachments) || message.attachments.length > 4) continue;
    for (let attachmentIndex = 0; attachmentIndex < message.attachments.length; attachmentIndex++) {
      if (references.length >= MAX_VIEWED_IMAGE_REFERENCES || seen.size >= MAX_SEEN_IMAGES) return references;
      const identity = `${message.id}\u0000${attachmentIndex}`;
      if (seen.has(identity)) continue;
      let attachment;
      try { [attachment] = normalizeImageAttachments([message.attachments[attachmentIndex]]); }
      catch { continue; }
      seen.add(identity);
      references.push({ messageId: message.id, attachmentIndex,
        ...(attachment.id === undefined ? {} : { attachmentId: attachment.id }) });
    }
  }
  return references;
}
