'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('petNative', Object.freeze({
  onState: callback => ipcRenderer.on('cortex:pet-native-state', (_event, state) => callback(state)),
  input: value => ipcRenderer.send('cortex:pet-native-input', value),
}));
