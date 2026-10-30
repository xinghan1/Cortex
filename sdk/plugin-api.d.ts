/** Cortex local HTML plugin API, schemaVersion / apiVersion 1. */
export type PluginPermission = 'project.read' | 'project.write' | 'notifications';
export interface CortexPluginManifest {
  schemaVersion: 1;
  /** Lowercase ID, for example com.example.tools. Stable across versions. */
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Plugin-relative HTML path, for example index.html. */
  entry: string;
  permissions: PluginPermission[];
  commands?: Array<{ id: string; title: string }>;
}
export interface PluginTextFile {
  path: string;
  content: string;
  /** Opaque revision token. Pass unchanged as writeText.expectedVersion. */
  version: string | null;
}
export interface CortexPluginAPI {
  info(): Promise<{ name: string; version: string; apiVersion: 1 }>;
  readonly project: {
    /** The project captured when this plugin window opened. */
    info(): Promise<{ name: string; root: string }>;
    /** At most 500 direct entries. Empty path means the project root. Requires project.read. */
    listFiles(args?: { path?: string }): Promise<Array<{ path: string; type: 'file' | 'directory' }>>;
    /** UTF-8 text only, at most 512 KiB. Requires project.read. */
    readText(args: { path: string }): Promise<PluginTextFile>;
    /**
     * Requires project.write and an explicit host confirmation for each write.
     * expectedVersion is the most recently read token, or null to create a new file.
     * A conflicting revision never overwrites an existing edit. At most 512 KiB.
     */
    writeText(args: { path: string; content: string; expectedVersion: string | null }): Promise<PluginTextFile>;
  };
  /** Host notification, at most 500 characters. Requires notifications. */
  notify(message: string): Promise<null>;
  /** Subscribe to a declared command selected by the user. Returns an unsubscribe function. */
  onCommand(listener: (command: Readonly<{ id: string }>) => void): () => void;
}
export type SynoraPluginManifest = CortexPluginManifest;
export type SynoraPluginAPI = CortexPluginAPI;
declare global { interface Window { readonly cortexPlugin: CortexPluginAPI; readonly synoraPlugin: CortexPluginAPI } }
