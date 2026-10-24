import { createHash } from 'node:crypto';

const versionOf = content => content === null ? null : createHash('sha256').update(content, 'utf8').digest('hex');
const aborted = signal => { if (signal?.aborted) throw new DOMException('插件操作已取消。', 'AbortError'); };

// Project access shares WorkspaceTools' path, credential and concurrent-file
// checks. The host supplies its own context lock and visible write approval.
export function createPluginProjectAccess({ WorkspaceTools, getContext, confirmWrite, onFilesChanged = () => {} }) {
  const contextFor = (request, write = false) => {
    aborted(request.signal);
    const context = getContext(request);
    if (!context?.root || context.workspaceId !== request.project?.workspaceId || context.root !== request.project?.root)
      throw new Error('项目已切换或关闭，请重新打开插件窗口。');
    if (write && !context.canWrite) throw new Error('请先结束当前任务并保存编辑内容，再使用插件写入文件。');
    return context;
  };
  return Object.freeze({
    async listFiles(request) {
      const context = contextFor(request);
      const files = await new WorkspaceTools(context.root).listFiles({ path: request.path ?? '' });
      contextFor(request); return files;
    },
    async readText(request) {
      const context = contextFor(request);
      const file = await new WorkspaceTools(context.root).readFile({ path: request.path });
      contextFor(request); return { ...file, version: versionOf(file.content) };
    },
    async writeText(request) {
      const context = contextFor(request, true);
      if (request.expectedVersion !== null && (typeof request.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/u.test(request.expectedVersion)))
        throw new Error('请先读取文件并使用返回的版本进行修改；新文件的版本应为 null。');
      return context.runMutation(async () => {
        contextFor(request, true);
        const tools = new WorkspaceTools(context.root, { approve: async operation => {
          contextFor(request, true);
          if (versionOf(operation.before) !== request.expectedVersion) throw new Error('文件已变化，请重新读取后再修改。');
          const allowed = await confirmWrite({ ...request, operation });
          contextFor(request, true); return allowed === true;
        } });
        const raw = await tools.execute('write_file', { path: request.path, content: request.content }, { signal: request.signal });
        let result;
        try { result = JSON.parse(raw); } catch { throw new Error(raw.replace(/^错误：/u, '')); }
        if (result.denied) throw new Error('已取消插件文件修改。');
        contextFor(request);
        await onFilesChanged({ ...request, path: result.path, context });
        return { path: result.path, content: request.content, version: versionOf(request.content) };
      });
    },
  });
}
