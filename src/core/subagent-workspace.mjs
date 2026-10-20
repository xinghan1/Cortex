import { AsyncLocalStorage } from 'node:async_hooks';
import { WorkspaceTools } from './workspace.mjs';
import { safeRelativePath } from './approval-policy.cjs';
import { SUBAGENT_LIMITS } from './subagents.mjs';

const READ_TOOLS = new Set(['list_files', 'read_file', 'search_files']);
const WRITE_TOOLS = new Set(['write_file', 'replace_in_file']);
const normalizedPath = value => typeof value === 'string' ? value.replace(/\\/g, '/').split('/').filter(part => part !== '.').join('/') : '';

// Each child has its own observed-file versions; commit guards remain shared.
export function createSubagentWorkspace({ root, id, name, writePaths = [], approve, onEvent, history, onCommitted }) {
  if (!Array.isArray(writePaths) || writePaths.length > SUBAGENT_LIMITS.writePaths) throw new Error('子智能体文件范围无效。');
  const scopes = writePaths.map(input => {
    if (typeof input !== 'string' || input !== input.trim()) throw new Error('子智能体文件范围必须是项目内相对路径。');
    const value = normalizedPath(input), directory = value.endsWith('/'), clean = directory ? value.slice(0, -1) : value;
    if (!safeRelativePath(clean)) throw new Error('子智能体文件范围包含不允许的路径。');
    return { path: clean.toLowerCase(), directory };
  });
  const operation = new AsyncLocalStorage();
  const tools = new WorkspaceTools(root, {
    approve: request => {
      const signal = operation.getStore()?.signal;
      signal?.throwIfAborted();
      return approve({ ...request, agentId: id, agentName: name, title: `${name} · ${request.title}` }, { signal });
    },
    onEvent: event => onEvent?.(event),
  });
  return {
    root: tools.root,
    async execute(tool, args, options = {}) {
      options.signal?.throwIfAborted();
      if (!READ_TOOLS.has(tool) && !WRITE_TOOLS.has(tool) && tool !== 'run_command') throw new Error('子智能体不能使用此工具。');
      if (WRITE_TOOLS.has(tool)) {
        const relative = normalizedPath(args?.path);
        if (!safeRelativePath(relative) || !scopes.some(scope => relative.toLowerCase() === scope.path || scope.directory && relative.toLowerCase().startsWith(scope.path + '/'))) {
          throw new Error('此文件不在子智能体获分配的写入范围内。');
        }
      }
      if (tool === 'run_command' && !scopes.length) throw new Error('只读子智能体不能运行命令。');
      // Bind cancellation to this operation, including approval callbacks after
      // asynchronous reads. A shared mutable signal could cancel a sibling
      // operation if a caller ever issues concurrent requests on this workspace.
      return operation.run({ signal: options.signal }, () => tools.execute(tool, args, { ...options, onFileChange: change => {
        const committed = tools.history.at(-1);
        if (committed && Array.isArray(history)) {
          history.push({ ...committed });
          if (history.length > 100) history.shift();
        }
        try { onCommitted?.(change); } catch { /* A display hook cannot undo a committed file. */ }
        options.onFileChange?.(change);
      } }));
    },
  };
}
