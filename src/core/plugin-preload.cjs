const { contextBridge, ipcRenderer } = require('electron');
const invoke = (method, args = {}) => ipcRenderer.invoke('synora-plugin:invoke', { method, args });
const listeners = new Set();
let latestCommand = null;
ipcRenderer.on('synora-plugin:command', (_event, command) => {
  if (!command || typeof command.id !== 'string') return;
  latestCommand = Object.freeze({ id: command.id });
  for (const listener of listeners) { try { listener(latestCommand); } catch {} }
});
contextBridge.exposeInMainWorld('synoraPlugin', Object.freeze({
  info: () => invoke('app.info'),
  project: Object.freeze({
    info: () => invoke('project.info'),
    listFiles: (args = {}) => invoke('project.listFiles', args),
    readText: args => invoke('project.readText', args),
    writeText: args => invoke('project.writeText', args),
  }),
  notify: message => invoke('notify', { message }),
  onCommand(listener) {
    if (typeof listener !== 'function') throw new TypeError('命令回调必须是函数。');
    listeners.add(listener);
    const command = latestCommand;
    if (command) queueMicrotask(() => { if (listeners.has(listener)) { try { listener(command); } catch {} } });
    return () => listeners.delete(listener);
  },
}));
