import { AsyncLocalStorage } from 'node:async_hooks';
import { WorkspaceTools } from './workspace.mjs';
import { normalizeWorkspaceReference, workspacePathKey } from './workspace-path.cjs';
import { normalizeSubagentPath, SUBAGENT_LIMITS } from './subagents.mjs';

const READ_TOOLS = new Set(['list_files', 'read_file', 'search_files', 'view_image']);
const WRITE_TOOLS = new Set(['write_file', 'replace_in_file']);
const pathIdentity = (root, value) => workspacePathKey(normalizeWorkspaceReference(root, value, { allowExternalPaths: true }).absolute).replaceAll('\\', '/');

// Each child has its own observed-file versions; commit guards remain shared.
export function createSubagentWorkspace({ root, id, name, writePaths = [], approve, onEvent, history, onCommitted }) {
  if (!Array.isArray(writePaths) || writePaths.length > SUBAGENT_LIMITS.writePaths) throw new Error('子智能体文件范围无效。');
  const scopes = writePaths.map(input => {
    const value = normalizeSubagentPath(input, { root }), directory = value.endsWith('/');
    return { path: pathIdentity(root, directory ? value.slice(0, -1) : value), directory };
  });
  const operation = new AsyncLocalStorage();
  const tools = new WorkspaceTools(root, {
    allowExternalPaths: true,
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
        const absolute = pathIdentity(root, args?.path);
        if (!scopes.some(scope => absolute === scope.path || scope.directory && absolute.startsWith(scope.path + '/'))) {
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
