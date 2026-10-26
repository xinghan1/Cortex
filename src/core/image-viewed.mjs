import { normalizeImageAttachments } from './message-images.mjs';

export const MAX_VIEWED_IMAGE_REFERENCES = 64;
const MAX_SEEN_IMAGES = 2048;
const validId = value => typeof value === 'string' && value.trim().length > 0
  && Array.from(value).length <= 100 && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value);
const eligibleSource = message => message?.role === 'user' || message?.role === 'tool' && message.source === 'image-tool';

/** Called only after a successful ordinary image-bearing model request.
 * Keep references to the original user messages, never another image copy.
 * Request history can include older photos: restrict display evidence to the
 * current run's user or explicit image-tool message IDs without removing
 * history from the request. A local read alone is never a view receipt. */
export function collectViewedImages(messages, seen = new Set(), allowedMessageIds) {
  if (!Array.isArray(messages) || !(seen instanceof Set)
      || (allowedMessageIds !== undefined && !(allowedMessageIds instanceof Set))) return [];
  const ids = new Map();
  for (const message of messages) if (eligibleSource(message) && validId(message.id))
    ids.set(message.id, (ids.get(message.id) || 0) + 1);
  const references = [];
  for (const message of messages) {
    if (!eligibleSource(message) || !validId(message.id) || ids.get(message.id) !== 1
        || (allowedMessageIds && !allowedMessageIds.has(message.id))
        || !Array.isArray(message.attachments) || message.attachments.length > 4) continue;
    for (let attachmentIndex = 0; attachmentIndex < message.attachments.length; attachmentIndex++) {
      if (references.length >= MAX_VIEWED_IMAGE_REFERENCES || seen.size >= MAX_SEEN_IMAGES) return references;
      let attachment;
      try { [attachment] = normalizeImageAttachments([message.attachments[attachmentIndex]]); }
      catch { continue; }
      // Reopening an unchanged generated screenshot in the same run need not
      // create another card. User uploads retain their original message identity.
      const identity = message.role === 'tool' && /^sha256:[a-f\d]{64}$/u.test(attachment.id || '')
        ? `image-tool\u0000${attachment.id}` : `${message.id}\u0000${attachmentIndex}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      references.push({ messageId: message.id, attachmentIndex,
        ...(attachment.id === undefined ? {} : { attachmentId: attachment.id }) });
    }
  }
  return references;
}
