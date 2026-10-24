import { randomUUID } from 'node:crypto';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const toolNames = { read: 'read_file', edit: 'apply_patch', delete: 'delete_file', move: 'move_file',
  search: 'search_files', execute: 'run_command', fetch: 'read_url', think: 'agent_task' };
const maxText = 512 * 1024;
const officialModes = { gemini: 'antigravity-agent', kimi: 'kimi-agent', glm: 'glm-agent' };

// An external ACP agent owns inference and tools. This adapter only records
// its public updates; it never executes a tool or feeds its tokens into the
// application's model request loop.
export async function runExternalAgentTurn({ agent, session, cwd, prompt, attachments = [], modelId,
  runId, signal, emit, onPermission, onUserInput = async () => ({ action: 'cancel' }), provider = 'gemini', onUsage = async () => {}, redact = value => value }) {
  if (!agent || typeof agent.runTask !== 'function' || !session?.id || !Array.isArray(session.messages)
      || typeof emit !== 'function' || typeof onPermission !== 'function') throw new Error('官方代理会话配置无效。');
  const tools = new Map(); let text = '', characters = 0, result, status = 'failed';
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
    return value.map(item => item?.type === 'content' && item.content?.type === 'text' ? item.content.text
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
      record = { id: `${runId}:${id}`, name: 'official_agent_tool', started: false, done: false, title: '', output: '', args: null };
      tools.set(id, record);
    }
    if (!record.started && Object.hasOwn(toolNames, update.kind)) record.name = toolNames[update.kind];
    if (typeof update.title === 'string') record.title = update.title.slice(0, 2000);
    if (object(update.rawInput)) record.args = structuredClone(update.rawInput);
    const previousOutput = record.output;
    if (Array.isArray(update.content)) record.output = toolContent(update.content);
    if (update.rawOutput != null && (!Array.isArray(update.content) || !record.output)) record.output = (typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput)).slice(-maxText);
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
    flush(false); status = 'completed';
    return { ...result, toolCount: tools.size };
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
