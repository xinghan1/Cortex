import { createHash, randomUUID } from 'node:crypto';
import { IMAGE_ATTACHMENT_LIMITS, normalizeImageAttachments } from './message-images.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const toolNames = { read: 'read_file', edit: 'apply_patch', delete: 'delete_file', move: 'move_file',
  search: 'search_files', execute: 'run_command', fetch: 'read_url', think: 'agent_task' };
const maxText = 512 * 1024;
const officialModes = { gemini: 'antigravity-agent', kimi: 'kimi-agent', glm: 'glm-agent' };
const maxImageSources = 64, maxImageSourceBytes = 16 * 1024 * 1024;
const nativeImageTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const imageBytes = image => {
  const data = image.dataUrl.slice(image.dataUrl.indexOf(',') + 1);
  return data.length / 4 * 3 - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
};
function embeddedImage(content) {
  if (content?.type !== 'image' || !nativeImageTypes.has(content.mimeType) || typeof content.data !== 'string'
      || content.data.length > 4 * Math.ceil(IMAGE_ATTACHMENT_LIMITS.maxImageBytes / 3)) return null;
  try {
    const [attachment] = normalizeImageAttachments([{ mediaType: content.mimeType,
      name: typeof content.name === 'string' ? content.name : '官方代理图像.' + (content.mimeType === 'image/jpeg' ? 'jpg' : content.mimeType.slice(6)),
      dataUrl: `data:${content.mimeType};base64,${content.data}` }]);
    const hash = createHash('sha256').update(Buffer.from(content.data, 'base64')).digest('hex');
    return { attachment: { ...attachment, id: 'sha256:' + hash }, bytes: imageBytes(attachment) };
  } catch { return null; }
}
// The native result may contain image blocks in raw metadata as well as its
// public content. Never stringify their binary fields into command/tool logs.
function publicToolValue(value, imageData = []) {
  const scrubText = text => {
    let output = text.replace(/data:image\/[^;,\s]+;base64,[A-Za-z\d+/=]+/gu, '[图像内容]');
    for (const data of imageData) output = output.replaceAll(data, '[图像内容]');
    return output;
  };
  if (typeof value === 'string') {
    if (/"type"\s*:\s*"image"/u.test(value)) {
      try { return publicToolValue(JSON.parse(value), imageData); }
      catch { return '[图像原始数据未显示]'; }
    }
    return scrubText(value).slice(-maxText);
  }
  try {
    return JSON.stringify(value, (_key, item) => item?.type === 'image' ? '[图像内容]'
      : typeof item === 'string' ? scrubText(item) : item).slice(-maxText);
  } catch { return '[原始数据无法显示]'; }
}

function appendImageSources(session, additions) {
  const pool = [];
  for (const source of Array.isArray(session.imageToolSources) ? session.imageToolSources.slice(-maxImageSources) : []) {
    if (!object(source) || source.role !== 'tool' || source.source !== 'image-tool' || typeof source.id !== 'string'
        || source.id.length > 100 || !source.id || typeof source.runId !== 'string' || source.runId.length > 100 || !count(source.messageIndex)) continue;
    try {
      const attachments = normalizeImageAttachments(source.attachments);
      if (!attachments.length) continue;
      pool.push({ id: source.id, role: 'tool', source: 'image-tool', runId: source.runId, messageIndex: source.messageIndex, attachments });
    } catch { /* A malformed old preview cannot grant a new view receipt. */ }
  }
  pool.push(...additions);
  let bytes = pool.reduce((sum, source) => sum + source.attachments.reduce((total, image) => total + imageBytes(image), 0), 0);
  while (pool.length > maxImageSources || bytes > maxImageSourceBytes) {
    const removed = pool.shift(); bytes -= removed.attachments.reduce((total, image) => total + imageBytes(image), 0);
  }
  session.imageToolSources = pool;
}

// An external ACP agent owns inference and tools. This adapter only records
// its public updates; it never executes a tool or feeds its tokens into the
// application's model request loop.
export async function runExternalAgentTurn({ agent, session, cwd, prompt, attachments = [], modelId,
  runId, signal, emit, onPermission, onUserInput = async () => ({ action: 'cancel' }), provider = 'gemini', onUsage = async () => {}, redact = value => value }) {
  if (!agent || typeof agent.runTask !== 'function' || !session?.id || !Array.isArray(session.messages)
      || typeof emit !== 'function' || typeof onPermission !== 'function') throw new Error('官方代理会话配置无效。');
  const tools = new Map(), imageCandidates = new Map(), imageData = new Set(); let text = '', characters = 0, result, status = 'failed', imageCandidateBytes = 0;
  const clean = value => String(redact(String(value)));
  const flush = partial => {
    if (!text) return;
    const content = clean(text); text = '';
    session.messages.push({ id: randomUUID(), role: 'assistant', content, toolCalls: [],
      ...(partial ? { localOnly: true } : {}), source: 'official-agent' });
    emit({ type: 'assistant-message', text: content, toolCallCount: 0 });
  };
  const toolContent = value => {
    if (!Array.isArray(value)) return '';
    return value.map(item => item?.type === 'content' && item.content?.type === 'image' ? '[图像内容]'
      : item?.type === 'content' && item.content?.type === 'text' ? item.content.text
      : item?.type === 'diff' ? [item.path, item.oldText, item.newText].filter(part => typeof part === 'string').join('\n') : '')
      .join('\n').slice(-maxText);
  };
  const startTool = record => {
    if (record.started) return;
    flush(false); record.started = true;
    emit({ type: 'tool-start', name: record.name, args: record.args || { title: record.title || '官方代理操作' }, toolCallId: record.id });
  };
  const updateTool = update => {
    const id = update.toolCallId;
    if (typeof id !== 'string' || !id || id.length > 512) throw new Error('官方代理工具标识无效。');
    let record = tools.get(id);
    if (!record) {
      record = { id: `${runId}:${id}`, name: 'official_agent_tool', started: false, done: false, title: '', output: '', args: null,
        images: new Set(), imageFailed: false, imageCompleted: false };
      tools.set(id, record);
    }
    if (!record.started && Object.hasOwn(toolNames, update.kind)) record.name = toolNames[update.kind];
    if (typeof update.title === 'string') record.title = update.title.slice(0, 2000);
    for (const item of Array.isArray(update.content) ? update.content.slice(0, 256) : []) {
      if (item?.type !== 'content' || item.content?.type !== 'image') continue;
      const image = embeddedImage(item.content); if (!image) continue;
      const hash = image.attachment.id;
      if (!imageCandidates.has(hash)) {
        if (imageCandidates.size >= maxImageSources || imageCandidateBytes + image.bytes > maxImageSourceBytes) continue;
        imageCandidates.set(hash, image); imageCandidateBytes += image.bytes;
        imageData.add(item.content.data);
      }
      record.images.add(hash);
    }
    if (update.status === 'completed') record.imageCompleted = true;
    if (['failed', 'cancelled', 'stopped'].includes(update.status)) record.imageFailed = true;
    if (object(update.rawInput)) {
      try { const value = JSON.parse(publicToolValue(update.rawInput, imageData)); record.args = object(value) ? value : { detail: '[图像内容]' }; }
      catch { record.args = { detail: '[原始参数无法显示]' }; }
    }
    const previousOutput = record.output;
    if (Array.isArray(update.content)) record.output = toolContent(update.content);
    if (update.rawOutput != null && (!Array.isArray(update.content) || !record.output)) record.output = publicToolValue(update.rawOutput, imageData);
    const wasStarted = record.started, terminal = ['completed', 'failed'].includes(update.status);
    if (record.name !== 'official_agent_tool' || terminal) startTool(record);
    if (record.started && record.name === 'run_command' && (record.output !== previousOutput || !wasStarted && record.output)) emit({ type: 'command-output', toolCallId: record.id,
      text: clean(record.output), replace: true });
    if (!record.done && terminal) {
      record.done = true;
      emit({ type: 'tool-result', name: record.name, toolCallId: record.id,
        result: JSON.stringify({ status: update.status === 'completed' ? 'completed' : 'failed',
          title: clean(record.title), output: clean(record.output) }) });
    }
  };
  try {
    const account = typeof agent.publicState === 'function' ? await agent.publicState() : null;
    signal?.throwIfAborted();
    let contextMessages = [];
    if (officialModes[provider] && session.officialAgentMode === officialModes[provider]
        && typeof session.officialAgentProfileId === 'string' && session.officialAgentProfileId
        && account?.session?.status === 'connected' && account.session.sharing === true
        && account.session.profileId === session.officialAgentProfileId) {
      // Main already appended this turn's user message. Only previously visible
      // text belongs in a fresh native session; old tool/image/private state does not.
      const previous = session.messages.at(-1)?.role === 'user' ? session.messages.slice(0, -1) : session.messages;
      contextMessages = previous.filter(message => message && ['user', 'assistant'].includes(message.role)
        && typeof message.content === 'string' && message.localOnly !== true && message.hidden !== true && message.private !== true)
        .map(message => ({ role: message.role, content: clean(message.content) }));
    }
    result = await agent.runTask({ localSessionId: session.id, cwd, prompt, contextMessages, attachments, modelId, signal, onPermission, onUserInput,
      onUpdate: event => {
        signal?.throwIfAborted();
        if (event?.localSessionId !== session.id) throw new Error('官方代理返回了其他会话的更新。');
        const update = event.update;
        if (!object(update)) return;
        if (update.sessionUpdate === 'agent_message_chunk') {
          if (update.content?.type !== 'text' || typeof update.content.text !== 'string') return;
          text += update.content.text; characters += update.content.text.length;
          if (characters > 4 * 1024 * 1024) throw new Error('官方代理本轮回复过长，请缩小任务后重试。');
          emit({ type: 'text-delta', text: clean(text), replace: true });
        } else if (update.sessionUpdate === 'agent_thought_chunk') {
          emit({ type: 'telemetry', phase: 'thinking' });
        } else if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) updateTool(update);
        else if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
          emit({ type: 'agent-plan', entries: update.entries.map(item => ({ content: clean(item.content || '').slice(0, 4000), status: item.status })) });
        }
      } });
    signal?.throwIfAborted();
    if (result?.stopReason !== 'end_turn') throw new Error(result?.stopReason === 'cancelled' ? '官方代理任务已取消。' : '官方代理尚未完整结束本轮任务。');
    if ([...tools.values()].some(record => !record.done)) throw new Error('官方代理已结束回复，但仍有操作未返回完成状态。');
    flush(false); signal?.throwIfAborted();
    const viewed = new Map();
    for (const record of tools.values()) if (record.imageCompleted && !record.imageFailed)
      for (const hash of record.images) if (!viewed.has(hash)) viewed.set(hash, imageCandidates.get(hash));
    if (viewed.size) {
      const sources = [...viewed.values()].map(image => ({ id: randomUUID(), role: 'tool', source: 'image-tool',
        attachments: [image.attachment], runId, messageIndex: Math.max(0, session.messages.length - 1) }));
      appendImageSources(session, sources);
      for (let index = 0; index < sources.length; index += 4) emit({ type: 'images-viewed', version: 1,
        requestId: `official-image:${runId}:${index / 4}`, images: sources.slice(index, index + 4).map(source => ({
          messageId: source.id, attachmentIndex: 0, attachmentId: source.attachments[0].id,
        })) });
    }
    status = 'completed';
    return { ...result, toolCount: tools.size };
  } catch (error) {
    // A native service rejection may arrive after it has reported real usage.
    // Keep only normalized numeric counters, never its raw response or text.
    if (error?.usageReported === true && count(error.usage?.inputTokens) && count(error.usage?.outputTokens))
      result = { usageReported: true, usage: { inputTokens: error.usage.inputTokens, outputTokens: error.usage.outputTokens,
        ...(count(error.usage.cachedInputTokens) && error.usage.cachedInputTokens <= error.usage.inputTokens
          ? { cachedInputTokens: error.usage.cachedInputTokens } : {}) } };
    throw error;
  } finally {
    if (signal?.aborted) status = 'stopped';
    flush(status !== 'completed');
    for (const record of tools.values()) if (!record.done) {
      startTool(record);
      emit({ type: 'tool-result', name: record.name, toolCallId: record.id,
        result: JSON.stringify({ status: status === 'stopped' ? 'stopped' : 'incomplete', output: clean(record.output) }) });
    }
    const usage = result?.usage, reported = result?.usageReported !== false && count(usage?.inputTokens) && count(usage?.outputTokens);
    await onUsage({ id: randomUUID(), timestamp: new Date().toISOString(), provider, model: modelId,
      sessionId: session.id, runId, status, reported, partial: status !== 'completed',
      inputTokens: reported ? usage.inputTokens : null, outputTokens: reported ? usage.outputTokens : null,
      ...(reported && count(usage.cachedInputTokens) && usage.cachedInputTokens <= usage.inputTokens ? { cachedInputTokens: usage.cachedInputTokens } : {}) });
  }
}
