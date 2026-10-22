'use strict';

const MAX_SELECTION = 500;
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
const contains = (parent, child) => key(child) === key(parent) || key(child).startsWith(key(parent) + '/');

// Resolve every requested source before mutating anything. The file manager
// retains its normal protected-path, root, link and race checks per operation.
async function selectionTargets(manager, arg, { allowRoot = false, prune = true } = {}) {
  const batch = Object.hasOwn(arg || {}, 'paths');
  const inputs = batch ? arg.paths : [arg?.path ?? ''];
  if (!Array.isArray(inputs) || !inputs.length || inputs.length > MAX_SELECTION
      || inputs.some(value => typeof value !== 'string')) throw new Error('请选择有效的项目文件或文件夹。');
  const targets = [], seen = new Set();
  for (const input of inputs) {
    const target = await manager.paths({ path: input });
    if (!allowRoot && !target.relative) throw new Error('请先选择项目内的文件或文件夹。');
    const identity = key(target.relative);
    if (!seen.has(identity)) { seen.add(identity); targets.push(target); }
  }
  return { batch, targets: prune ? targets.filter(target => !targets.some(parent => parent !== target && contains(parent.relative, target.relative))) : targets };
}

function clipboardPaths(value) {
  return value ? Array.isArray(value.paths) ? value.paths : [value.path] : [];
}

function updateClipboard(value, transform) {
  if (!value) return null;
  const paths = [...new Set(clipboardPaths(value).map(transform).filter(path => typeof path === 'string' && path))];
  if (!paths.length) return null;
  return { ...value, path: paths[0], ...(Array.isArray(value.paths) ? { paths } : {}) };
}

function remapClipboard(value, source, destination) {
  return updateClipboard(value, entry => contains(source, entry) ? destination + entry.slice(source.length) : entry);
}

function removeClipboardPaths(value, sources) {
  return updateClipboard(value, entry => sources.some(source => contains(source, entry)) ? null : entry);
}

async function performSelection(selection, operation) {
  const results = [];
  for (const target of selection.targets) {
    try { results.push(await operation(target)); }
    catch (error) {
      if (!selection.batch) throw error;
      return { results, error: error?.message || '文件操作失败，请刷新后重试。', failedPath: target.relative };
    }
  }
  return selection.batch ? { results } : results[0];
}

function createExplorerHandlers({ getManager, getClipboard, setClipboard, onChange, confirmDelete, broadcast, writeText }) {
  return {
    fileRename: async arg => {
      const result = await getManager().rename(arg);
      setClipboard(remapClipboard(getClipboard(), result.oldPath, result.path));
      return onChange('rename', result);
    },
    fileMove: async arg => {
      const destination = arg?.destination ?? '';
      if (typeof destination !== 'string') throw new Error('文件移动参数无效。');
      const manager = getManager(), selection = await selectionTargets(manager, arg);
      const target = await manager.paths({ path: destination });
      if (selection.targets.some(source => contains(source.relative, target.relative))) throw new Error('不能将文件夹移动到自身或其子目录。');
      return performSelection(selection, async source => {
        const result = await manager.copyOrMove({ source: source.relative, destination: target.relative, mode: 'cut' });
        setClipboard(remapClipboard(getClipboard(), result.source, result.path));
        return onChange('move', result);
      });
    },
    fileDelete: async arg => {
      const manager = getManager(), selection = await selectionTargets(manager, arg);
      if (!(await confirmDelete(selection.targets))) return { canceled: true };
      return performSelection(selection, async target => {
        const result = await manager.remove({ path: target.relative });
        setClipboard(removeClipboardPaths(getClipboard(), [result.path]));
        return onChange('delete', result);
      });
    },
    fileClipboard: async arg => {
      if (!['copy', 'cut'].includes(arg?.mode)) throw new Error('请选择复制或剪切。');
      const selection = await selectionTargets(getManager(), arg);
      const paths = selection.targets.map(target => target.relative);
      const value = { path: paths[0], mode: arg.mode, ...(selection.batch ? { paths } : {}) };
      setClipboard(value);
      await broadcast();
      return { ...value, ...(selection.batch ? { paths: [...paths] } : {}) };
    },
    filePaste: async arg => {
      const value = getClipboard();
      if (!value) throw new Error('请先在文件树中复制或剪切文件。');
      const destination = arg?.destination ?? '';
      if (typeof destination !== 'string') throw new Error('文件粘贴参数无效。');
      const manager = getManager();
      const selection = await selectionTargets(manager, Array.isArray(value.paths) ? { paths: value.paths } : { path: value.path });
      const target = await manager.paths({ path: destination });
      if (selection.targets.some(source => contains(source.relative, target.relative))) throw new Error('不能将文件夹粘贴到自身或其子目录。');
      return performSelection(selection, async source => {
        const result = await manager.copyOrMove({ source: source.relative, destination: target.relative, mode: value.mode });
        if (value.mode === 'cut') setClipboard(removeClipboardPaths(getClipboard(), [result.source]));
        return onChange('paste', result);
      });
    },
    fileCopyPath: async arg => {
      if (arg?.relative !== undefined && typeof arg.relative !== 'boolean') throw new Error('路径复制参数无效。');
      const selection = await selectionTargets(getManager(), arg, { allowRoot: true, prune: false });
      const text = selection.targets.map(target => arg?.relative === true ? target.relative : target.absolute).join('\r\n');
      writeText(text);
      return { text };
    },
  };
}

module.exports = { selectionTargets, clipboardPaths, remapClipboard, removeClipboardPaths, performSelection, createExplorerHandlers };
