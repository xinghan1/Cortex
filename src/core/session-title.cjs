'use strict';

const TITLE_LIMIT = 80;
const DEFAULT_TITLE_LIMIT = 40;
const controls = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

function normalizeSessionTitle(value) {
  if (typeof value !== 'string' || value.length > 1024 || controls.test(value)) throw new Error('会话标题不能包含换行或控制字符。');
  const title = value.trim();
  if (!title) throw new Error('请输入会话标题。');
  if ([...title].length > TITLE_LIMIT) throw new Error(`会话标题最多 ${TITLE_LIMIT} 个字符。`);
  return title;
}

function sessionTitle(session, redact = value => value) {
  if (typeof session?.customTitle === 'string') {
    try { return normalizeSessionTitle(redact(normalizeSessionTitle(session.customTitle))); } catch { /* Ignore damaged optional metadata. */ }
  }
  if (session?.demo === true) return '离线演示 · 代码助手流程';
  for (const message of Array.isArray(session?.messages) ? session.messages : []) {
    if (message?.role !== 'user') continue;
    const text = typeof message.content === 'string' ? redact(message.content).replace(/[\u0000-\u001f\u007f-\u009f\s]+/gu, ' ').trim() : '';
    if (text) return [...text].slice(0, DEFAULT_TITLE_LIMIT).join('');
    if (Array.isArray(message.attachments) && message.attachments.some(image => typeof image?.dataUrl === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/u.test(image.dataUrl))) return '图片消息';
  }
  return '新会话';
}

module.exports = { normalizeSessionTitle, sessionTitle, TITLE_LIMIT };
