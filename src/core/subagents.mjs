import { randomUUID } from 'node:crypto';
import { normalizeWorkspaceReference, workspacePathKey } from './workspace-path.cjs';

export const SUBAGENT_LIMITS = Object.freeze({ concurrent: 3, total: 8, taskChars: 12000,
  nameChars: 80, writePaths: 24, activity: 40, summaryChars: 6000, messages: 8, messageChars: 4000 });
const DESIGN_ROLES = Object.freeze(['frontend', 'backend', 'modeling']);
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
export const SUBAGENT_TOOL_DEFINITIONS = [
  { name: 'spawn_agent', description: '启动一个独立子智能体并立即返回 ID；最多同时 3 个、每次主任务累计 8 个。适合可独立完成的明确任务。默认只读且不能运行命令。write_paths 可授予项目内相对路径或任务授权的项目外绝对路径，目录必须以 / 结尾；活跃子任务的写入范围不能重叠。目录范围仅限制文件工具，不是命令的系统沙箱；命令仍需遵守当前审批规则。子智能体不能再次委派。',
    parameters: schema({ name: { type: 'string', maxLength: 80 }, task: { type: 'string', maxLength: 12000 },
      role: { type: 'string', enum: DESIGN_ROLES, description: '仅用于明确的前端设计、后端设计或三维、数据、系统等建模设计子任务；省略时使用普通子智能体模型。' },
      write_paths: { type: 'array', maxItems: 24, items: { type: 'string', description: '项目内相对路径或项目外完整绝对路径；目录必须以 / 结尾。不可包含 .. 或授予无关目录。' } } }, ['name', 'task']) },
  { name: 'wait_agents', description: '等待指定子智能体结束并返回摘要、错误和用量。省略 ids 时等待目前所有子智能体；不会创建额外模型请求。',
    parameters: schema({ ids: { type: 'array', maxItems: 8, items: { type: 'string' } } }) },
  { name: 'send_agent_message', description: '向运行中的子智能体补充实质新信息或新约束，相关补充应合并发送；不要用来催问进度或重复原要求，没有独立工作时用 wait_agents 等待。已结束的子任务不会重启。',
    parameters: schema({ id: { type: 'string' }, message: { type: 'string', maxLength: 4000 } }, ['id', 'message']) },
  { name: 'stop_agent', description: '取消指定子智能体并等待它停止；已经提交的文件更改会保留。',
    parameters: schema({ id: { type: 'string' } }, ['id']) },
];
const names = new Set(SUBAGENT_TOOL_DEFINITIONS.map(tool => tool.name));
export const isSubagentTool = name => names.has(name);
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function argsObject(value, keys, required = []) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))
      || required.some(key => !Object.hasOwn(value, key))) throw new Error('子智能体参数格式无效。');
  return value;
}
function textArg(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error(`${label}格式无效或超过长度限制。`);
  return value.trim();
}
export function normalizeSubagentPath(value, { root = process.cwd() } = {}) {
  if (typeof value !== 'string' || !value || value.length > 500 || value !== value.trim()) throw new Error('写入范围必须是相对或绝对文件路径，目录以 / 结尾。');
  const normalized = value.replaceAll('\\', '/'), directory = normalized.endsWith('/');
  const clean = directory ? normalized.slice(0, -1) : normalized;
  // Scopes must be explicit. Runtime file arguments may use equivalent absolute
  // paths, but a grant never silently expands through a dot or parent segment.
  const segments = clean.replace(/^[A-Za-z]:\//u, '').replace(/^\//u, '').split('/');
  if (segments.some(part => !part || part === '.' || part === '..' || part !== part.trim())) throw new Error('写入范围包含无效或受保护路径。');
  const reference = normalizeWorkspaceReference(root, clean, { allowExternalPaths: true });
  return reference.relative.replaceAll('\\', '/') + (directory ? '/' : '');
}
const identity = (root, value) => {
  const directory = value.endsWith('/'), clean = directory ? value.slice(0, -1) : value;
  return workspacePathKey(normalizeWorkspaceReference(root, clean, { allowExternalPaths: true }).absolute).replaceAll('\\', '/') + (directory ? '/' : '');
};
const covers = (scope, file) => scope === file || scope.endsWith('/') && file.startsWith(scope);
const overlap = (a, b) => covers(a, b) || covers(b, a)
  || a.endsWith('/') && b === a.slice(0, -1)
  || b.endsWith('/') && a === b.slice(0, -1);

// The manager owns lifecycle and public snapshots only. Provider messages and
// native reasoning stay in each independent runAgent invocation.
export function createSubagentManager({ root = process.cwd(), createWorkspace, runChild, parentSignal, emit, redact = value => value }) {
  if (typeof createWorkspace !== 'function' || typeof runChild !== 'function') throw new Error('子智能体运行环境无效。');
  const records = new Map();
  let closed = false;
  const safe = (value, max = 6000) => String(redact(String(value ?? ''))).slice(0, max);
  const snapshot = record => ({ id: record.id, name: record.name, task: record.task, role: record.role, writePaths: record.writePaths.map(path => safe(path, 500)),
    status: record.status, startedAt: record.startedAt, endedAt: record.endedAt,
    elapsedMs: Math.max(0, Date.parse(record.endedAt || new Date().toISOString()) - Date.parse(record.startedAt)),
    summary: record.summary, error: record.error, activity: record.activity.map(item => structuredClone(item)),
    inputTokens: record.inputTokens, outputTokens: record.outputTokens });
  const publish = record => emit({ type: 'subagent-update', agent: snapshot(record) });
  const result = record => { const { activity, ...value } = snapshot(record); return value; };
  const get = id => {
    if (typeof id !== 'string' || !/^agent-[a-f0-9-]{36}$/.test(id) || !records.has(id)) throw new Error('未找到此子智能体。');
    return records.get(id);
  };
  const pending = () => [...records.values()].filter(record => record.status === 'running');
  const activeScopes = () => pending().flatMap(record => record.scopes);
  const addActivity = (record, item) => {
    record.activity.push(item);
    if (record.activity.length > SUBAGENT_LIMITS.activity) record.activity.splice(0, record.activity.length - SUBAGENT_LIMITS.activity);
    publish(record);
  };
  const abortChildren = () => { for (const record of pending()) record.controller.abort(parentSignal?.reason); };
  parentSignal?.addEventListener('abort', abortChildren, { once: true });
  const eventFor = record => event => {
    if (!event || record.status !== 'running') return;
    if (event.type === 'usage') {
      record.inputTokens = Math.max(record.inputTokens, Number.isSafeInteger(event.inputTokens) ? event.inputTokens : 0);
      record.outputTokens = Math.max(record.outputTokens, Number.isSafeInteger(event.outputTokens) ? event.outputTokens : 0);
      publish(record);
    } else if (event.type === 'assistant-message') {
      if (typeof event.text === 'string' && event.text.trim()) {
        record.summary = safe(event.text, SUBAGENT_LIMITS.summaryChars);
        addActivity(record, { type: 'message', text: record.summary });
      }
    } else if (event.type === 'tool-start' || event.type === 'tool-result') {
      if (event.type === 'tool-start' && event.name === 'run_command') {
        record.commandBuffers = {}; record.commandActivity = {};
      }
      const item = { type: event.type, name: safe(event.name, 100), ...(typeof event.toolCallId === 'string' ? { toolCallId: safe(event.toolCallId, 100) } : {}) };
      if (event.type === 'tool-start') {
        // Only useful public command/path fields; do not retain arbitrary
        // provider arguments, document bodies, or private model state.
        item.args = {};
        if (plain(event.args)) for (const key of ['path', 'query', 'command', 'timeout_ms']) {
          if (typeof event.args[key] === 'string') item.args[key] = safe(event.args[key], 6000);
          else if (Number.isFinite(event.args[key])) item.args[key] = event.args[key];
        }
      } else item.result = safe(event.result, 6000);
      addActivity(record, item);
    } else if (event.type === 'command-output' && ['stdout', 'stderr'].includes(event.stream) && typeof event.text === 'string') {
      // Replace the whole accumulated frame before publishing, so credentials
      // split across process output chunks cannot reassemble in public history.
      const stream = event.stream;
      record.commandBuffers[stream] = ((record.commandBuffers[stream] || '') + event.text).slice(-65536);
      let item = record.commandActivity[stream];
      if (!item) {
        item = { type: 'command-output', stream, text: '' };
        record.commandActivity[stream] = item;
        record.activity.push(item);
        if (record.activity.length > SUBAGENT_LIMITS.activity) record.activity.shift();
      }
      item.text = safe(record.commandBuffers[stream], 65536).slice(-6000);
      publish(record);
    } else if (event.type === 'context-compaction-start' || event.type === 'context-compacted') {
      addActivity(record, { type: 'message', text: event.type === 'context-compacted' ? '子任务上下文已压缩' : '正在整理子任务上下文' });
    }
  };
  const spawn = async args => {
    argsObject(args, ['name', 'task', 'role', 'write_paths'], ['name', 'task']);
    if (closed) throw new Error('主任务已经结束，不能启动子智能体。');
    parentSignal?.throwIfAborted();
    const name = textArg(args.name, SUBAGENT_LIMITS.nameChars, '子任务名称');
    const task = textArg(args.task, SUBAGENT_LIMITS.taskChars, '子任务内容');
    if (args.role !== undefined && !DESIGN_ROLES.includes(args.role)) throw new Error('子任务角色无效。');
    const role = args.role ?? 'subagent';
    if (args.write_paths !== undefined && (!Array.isArray(args.write_paths) || args.write_paths.length > SUBAGENT_LIMITS.writePaths)) throw new Error('写入范围最多 24 项。');
    const writePaths = [...new Set((args.write_paths || []).map(value => normalizeSubagentPath(value, { root })))];
    const scopes = writePaths.map(value => identity(root, value));
    if (records.size >= SUBAGENT_LIMITS.total) throw new Error('本次主任务最多创建 8 个子智能体。');
    if (pending().length >= SUBAGENT_LIMITS.concurrent) throw new Error('最多同时运行 3 个子智能体，请先等待现有任务。');
    if (scopes.some(scope => activeScopes().some(active => overlap(scope, active)))) throw new Error('写入范围与正在运行的子智能体重叠，请等待它完成或分配不同文件。');
    const record = { id: `agent-${randomUUID()}`, name: safe(name, 80), task: safe(task, SUBAGENT_LIMITS.taskChars), role, writePaths, scopes,
      status: 'running', startedAt: new Date().toISOString(), endedAt: null, summary: '', error: '', activity: [],
      inputTokens: 0, outputTokens: 0, controller: new AbortController(), queue: [], delivered: false, promise: null,
      commandBuffers: {}, commandActivity: {} };
    records.set(record.id, record);
    publish(record);
    record.promise = (async () => {
      try {
        record.controller.signal.throwIfAborted();
        const childEmit = eventFor(record);
        const workspace = await createWorkspace({ id: record.id, name: record.name, task: record.task, role: record.role, writePaths: [...writePaths], onEvent: childEmit });
        record.controller.signal.throwIfAborted();
        if (!workspace || typeof workspace.execute !== 'function' || typeof workspace.root !== 'string') throw new Error('子任务工作区不可用。');
        const allowed = new Set(['list_files', 'read_file', 'search_files', ...(DESIGN_ROLES.includes(role) ? ['view_image'] : []), ...(writePaths.length ? ['write_file', 'replace_in_file', 'run_command'] : [])]);
        await runChild({ id: record.id, name: record.name, task: record.task, role: record.role, writePaths: [...writePaths],
          workspace: { root: workspace.root, execute: async (tool, parameters, options) => {
            record.controller.signal.throwIfAborted();
            if (!allowed.has(tool)) throw new Error('此工具不在子智能体授权范围内。');
            if (tool === 'write_file' || tool === 'replace_in_file') {
              const file = identity(root, parameters?.path || '');
              if (file.endsWith('/') || !scopes.some(scope => covers(scope, file))) throw new Error('文件不在此子智能体的写入范围内。');
            }
            return workspace.execute(tool, parameters, options);
          } },
          allowedTools: allowed, signal: record.controller.signal, emit: childEmit,
          takeSteering: async () => {
            record.controller.signal.throwIfAborted();
            return record.queue.splice(0);
          } });
        record.controller.signal.throwIfAborted();
        record.status = 'completed';
      } catch (error) {
        record.status = record.controller.signal.aborted ? 'stopped' : 'failed';
        record.error = record.status === 'stopped' ? '子任务已停止；已提交的改动保留。' : safe(error?.message || '子任务执行失败。', 2000);
      } finally {
        record.endedAt = new Date().toISOString();
        record.queue.length = 0;
        record.commandBuffers = {}; record.commandActivity = {};
        publish(record);
      }
    })();
    return { id: record.id, name: record.name, role: record.role, status: record.status, writePaths: writePaths.map(path => safe(path, 500)) };
  };
  const wait = async args => {
    argsObject(args, ['ids']);
    if (args.ids !== undefined && (!Array.isArray(args.ids) || args.ids.length > 8)) throw new Error('子智能体 ID 列表无效。');
    const selected = args.ids === undefined ? [...records.values()] : [...new Set(args.ids)].map(get);
    parentSignal?.throwIfAborted();
    await Promise.all(selected.map(record => record.promise));
    parentSignal?.throwIfAborted();
    selected.forEach(record => { record.delivered = true; });
    return { agents: selected.map(result) };
  };
  const stop = async args => {
    argsObject(args, ['id'], ['id']);
    const record = get(args.id);
    if (record.status === 'running') record.controller.abort(new Error('子任务已停止。'));
    await record.promise;
    return result(record);
  };
  return {
    hasPending: () => pending().length > 0,
    needsSynthesis: () => [...records.values()].some(record => !record.delivered),
    snapshots: () => [...records.values()].map(snapshot),
    stop,
    assertParentTool(name, args) {
      const scopes = activeScopes();
      if (!scopes.length) return;
      if (name === 'undo_last_change') throw new Error('子智能体正在写入文件，请等待它完成后再撤销。');
      if (name === 'write_file' || name === 'replace_in_file') {
        const file = identity(root, args?.path || '');
        if (scopes.some(scope => overlap(scope, file))) throw new Error('此文件正由子智能体处理，请等待它完成后再修改。');
      }
    },
    async execute(name, args) {
      if (name === 'spawn_agent') return JSON.stringify(await spawn(args));
      if (name === 'wait_agents') return JSON.stringify(await wait(args));
      if (name === 'stop_agent') {
        const value = await stop(args);
        get(value.id).delivered = true;
        return JSON.stringify(value);
      }
      if (name === 'send_agent_message') {
        argsObject(args, ['id', 'message'], ['id', 'message']);
        const record = get(args.id), message = textArg(args.message, SUBAGENT_LIMITS.messageChars, '补充消息');
        if (record.status !== 'running') {
          record.delivered = true;
          return JSON.stringify(result(record));
        }
        if (record.queue.length >= SUBAGENT_LIMITS.messages) throw new Error('子任务待处理补充消息已满，请等待它处理后再发送。');
        record.queue.push({ id: randomUUID(), text: safe(message, SUBAGENT_LIMITS.messageChars), source: 'subagent-steering', createdAt: new Date().toISOString() });
        return JSON.stringify({ id: record.id, status: record.status, queued: true });
      }
      throw new Error('未知的子智能体工具。');
    },
    async collectForFinal() {
      const selected = [...records.values()].filter(record => !record.delivered);
      await Promise.all(selected.map(record => record.promise));
      parentSignal?.throwIfAborted();
      selected.forEach(record => { record.delivered = true; });
      return selected.map(result);
    },
    async abortAndWait() {
      closed = true;
      parentSignal?.removeEventListener('abort', abortChildren);
      for (const record of pending()) record.controller.abort(new Error('主任务已结束。'));
      await Promise.all([...records.values()].map(record => record.promise));
    },
  };
}
