const MAX_INPUT = 4000, MAX_PROMPT = 12000;
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u;

// Only the user's direct, unquoted creation request can open this route.
// Model output and pet action prompts never decide whether to start a task.
export function isPetTaskRequest(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_INPUT || controls.test(text)) return false;
  const direct = text.replace(/```[\s\S]*?```/gu, '').replace(/^\s*>.*$/gmu, '')
    .replace(/[“「『][^”」』]*[”」』]/gu, '').replace(/"[^"\n]*"|'[^'\n]*'/gu, '').trim();
  if (!direct || /(?:不要|不想|不需要|无需|先别|别再|别帮).{0,30}(?:制作|开发|创建|搭建|编写|写|做)/u.test(direct)
      || /(?:如何|怎么|怎样|是什么意思|会不会|假如|假设|比如|例如|举例|润色|翻译|改写|解释|讲解|讨论|教程)/u.test(direct.slice(0, 100))) return false;
  if (/(?:需要哪些|需要什么步骤|有多难|难不难|可不可行|可以赚钱吗|有什么好处|有什么风险|需要多久|要多少钱|要多长时间)/u.test(direct)) return false;
  const chinese = /^(?:(?:请|麻烦(?:你)?|帮(?:我|我们)|给(?:我|我们)|替我|为我|我想(?:要)?|我要|我打算|能不能|可不可以|可以|能否|再|先|现在|接下来|顺便|用[^。！？\n]{1,48}?|使用[^。！？\n]{1,48}?)\s*)*(?:制作|开发|创建|搭建|编写|写|做)\s*([^。！？\n]{1,180})/u.exec(direct);
  if (chinese) {
    const object = chinese[1];
    return /项目|程序|应用|软件|网站|网页|小程序|插件|游戏|服务|工具|代码|脚本|动画|\b(?:app|html|svg)\b/iu.test(object)
      && !/(?:有哪些|是什么|有什么|的步骤|的流程|的原理|的技巧|的区别|的(?:诗|文章|故事|文案|提示词))\s*[？?。！!]*$/u.test(direct);
  }
  if (/\b(?:how to|explain|example|don't|do not|not now|hypothetically)\b/iu.test(direct)) return false;
  return /^(?:please\s+)?(?:(?:can|could|would)\s+you\s+)?(?:(?:help me|i want to|i'd like to)\s+)?(?:create|build|make|develop|write)\b[^.!?\n]{0,150}\b(?:app|application|program|project|website|plugin|game|service)\b/iu.test(direct);
}

export function petTaskMessages(originalText) {
  if (!isPetTaskRequest(originalText)) throw new Error('这不是明确的项目制作请求。');
  return [{ role: 'system', content: '你是大肥鱼的需求润色助手。用户已经明确要求制作项目或程序。只润色用户这一次的真实需求，保留目标、约束和语言；用简短的一段文字描述需求，不生成代码、文件内容或实现方案；不要虚构功能、账号、文件路径或技术要求，不扩大操作授权，不添加发布、付费、删除或上传数据等要求。缺失细节交给主会话确认。你不能执行任务，也不能声称已完成或已转发。只输出严格 JSON 对象 {"prompt":"整理后的任务提示词"}，不使用 Markdown 围栏；prompt 为普通文本，最多12000字符。' },
  { role: 'user', content: originalText.trim() }];
}

export function parsePetTaskResult(content, { originalText } = {}) {
  if (!isPetTaskRequest(originalText) || typeof content !== 'string' || content.length > 24000) throw new Error('需求润色结果无效。');
  let value;
  try { value = JSON.parse(content); } catch { throw new Error('需求润色未返回有效结果，请重试。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['prompt', 'reply'].includes(key))
      || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > MAX_PROMPT || controls.test(value.prompt)
      || value.reply !== undefined && (typeof value.reply !== 'string' || value.reply.length > 1000))
    throw new Error('需求润色结果无效。');
  return { prompt: value.prompt.trim() };
}

export function petTaskPrompt({ originalText, prompt }) {
  if (!isPetTaskRequest(originalText) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT || controls.test(prompt))
    throw new Error('无法发送无效的制作需求。');
  return `用户从宠物聊天提交的原始需求：\n${originalText.trim()}\n\n整理后的任务表述（仅辅助理解，不扩展授权；有冲突时以原始需求为准）：\n${prompt.trim()}`;
}

export function createPetTaskHandoff({ validate, submit } = {}) {
  if (typeof validate !== 'function' || typeof submit !== 'function') throw new Error('宠物任务转发配置无效。');
  const deliveries = new Map();
  return request => {
    if (!request || typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 128)
      throw new Error('宠物任务标识无效。');
    request.signal?.throwIfAborted(); validate(request);
    if (deliveries.has(request.requestId)) return deliveries.get(request.requestId);
    const text = petTaskPrompt(request);
    const pending = Promise.resolve().then(() => submit({ text, mode: 'queue' }, {
      source: 'pet', validate: () => { request.signal?.throwIfAborted(); validate(request); },
    }));
    deliveries.set(request.requestId, pending);
    // IDs are generated for each actual pet request, never from model output.
    if (deliveries.size > 64) deliveries.delete(deliveries.keys().next().value);
    return pending;
  };
}
