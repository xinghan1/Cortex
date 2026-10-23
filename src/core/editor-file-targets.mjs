import path from 'node:path';
import { ManualFileManager } from './file-manager.mjs';
import paths from './workspace-path.cjs';

// Only editor read/save/reveal accepts an explicit external file. Explorer
// creation, moving, clipboard operations and deletion keep their project scope.
export class EditorFileTargets {
  #project;
  #volumes = new Map();

  constructor(projectManager) {
    this.#project = projectManager;
  }

  #target(input, allowRoot = false) {
    if (typeof input !== 'string' || !path.isAbsolute(input)) return { manager: this.#project, input, display: null };
    // Editor paths come from the file picker or a saved canonical reference.
    // Reject traversals rather than discard components before filesystem checks.
    if (!paths.safeWorkspacePath(input, { allowRoot })) throw new Error('请选择普通本机文件路径，不能使用设备路径、目录跳转或受保护文件。');
    const reference = paths.normalizeWorkspaceReference(this.#project.root, input, { allowExternalPaths: true, allowRoot });
    let manager = this.#project;
    if (reference.external) {
      const key = paths.workspacePathKey(reference.base);
      if (!this.#volumes.has(key)) this.#volumes.set(key, new ManualFileManager(reference.base));
      manager = this.#volumes.get(key);
    }
    return { manager, input: reference.parts.join('/'), display: reference.relative };
  }

  async read(arg = {}) {
    const target = this.#target(arg.path);
    const result = await target.manager.read({ ...arg, path: target.input });
    return { ...result, path: target.display ?? result.path };
  }

  async save(arg = {}) {
    const target = this.#target(arg.path);
    const result = await target.manager.save({ ...arg, path: target.input });
    return { ...result, path: target.display ?? result.path };
  }

  async paths(arg = {}) {
    const target = this.#target(arg.path ?? '', true);
    const result = await target.manager.paths({ ...arg, path: target.input });
    return { ...result, relative: target.display ?? result.relative };
  }
}
