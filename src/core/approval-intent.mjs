export const APPROVAL_INTENT_LIMITS = Object.freeze({ chars: 32000, messages: 100 });

// These are selection hints, never allow/deny decisions. Keep the original
// wording and order so the reviewer can interpret the user's actual scope.
const continuation = /^(?:继续(?:吧|执行|工作|做|完成)?|接着(?:做|执行)?|好(?:的)?|可以|行|确认|1|continue|go\s+on|proceed|resume|ok(?:ay)?|yes)[\s。.!！,，]*$/iu;
const constraints = /不要|不得|禁止|不能|不许|无需|暂不|勿|严禁|别(?:再)?(?:改|删|动|碰|用|停)|未经|仅|只|限于|必须|保留|保持|停止|取消|撤销|改为|改成|\b(?:avoid|never|must|only|do\s+not|don['’]t|cannot|can['’]t|may\s+not|should\s+not|without|unless|preserve|keep|except|instead|cancel|stop)\b/iu;
const syntheticPrefixes = ['【自动压缩的历史资料】', '[这是一条历史图片消息，图片完整保留；'];
const originalSources = new Set([undefined, 'direct', 'queue', 'steering']);

export const isApprovalContinuation = value => typeof value === 'string' && continuation.test(value.trim());

/** Select exact original user messages, never a model's summary of permission. */
export function selectApprovalIntent(messages, { terminalCommand } = {}) {
  const candidates = [];
  let invalidOriginal = !Array.isArray(messages);
  if (Array.isArray(messages)) messages.forEach((message, index) => {
    if (!message || message.role !== 'user' || message.localOnly === true || message.synthetic === true
        || !originalSources.has(message.source)) return;
    if (typeof message.content !== 'string' || message.content.includes('\0')) { invalidOriginal = true; return; }
    if (!message.content.trim() || syntheticPrefixes.some(prefix => message.content.trimStart().startsWith(prefix))) return;
    candidates.push({ index, text: message.content });
  });
  let terminalIndex = -1;
  if (terminalCommand !== undefined) {
    if (typeof terminalCommand !== 'string' || !terminalCommand.trim() || terminalCommand.length > 16000 || terminalCommand.includes('\0')) invalidOriginal = true;
    else {
      terminalIndex = candidates.length;
      candidates.push({ index: Array.isArray(messages) ? messages.length : 0, text: '用户在终端提交的完整命令：' + terminalCommand });
    }
  }
  const substantive = candidates.map((item, index) => !isApprovalContinuation(item.text) ? index : -1).filter(index => index >= 0);
  const required = new Set([substantive[0], substantive.at(-1), candidates.length - 1, terminalIndex].filter(index => index >= 0));
  for (let index = 0; index < candidates.length; index++) if (constraints.test(candidates[index].text)) required.add(index);
  const selected = new Set(); let chars = 0, missingRequiredContext = invalidOriginal || !substantive.length;
  const add = index => {
    if (selected.has(index)) return true;
    const item = candidates[index];
    if (!item || selected.size >= APPROVAL_INTENT_LIMITS.messages || chars + item.text.length > APPROVAL_INTENT_LIMITS.chars) return false;
    selected.add(index); chars += item.text.length; return true;
  };
  // Anchor the original goal and latest instructions before filling the middle.
  for (const index of required) if (!add(index)) missingRequiredContext = true;
  for (let index = candidates.length - 1; index >= 0; index--) add(index);
  const retained = [...selected].sort((a, b) => a - b).map(index => candidates[index]);
  return {
    userIntent: retained.map(item => item.text),
    intentSelection: { source: 'original-user-messages', totalMessages: candidates.length,
      selectedMessageIndices: retained.map(item => item.index), omittedMessages: candidates.length - retained.length,
      omittedChars: candidates.reduce((sum, item) => sum + item.text.length, 0) - chars, missingRequiredContext },
  };
}
