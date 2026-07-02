const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onInit: (callback) => ipcRenderer.on('init', (_, data) => callback(data)),
  onUploadDone: (callback) => ipcRenderer.on('upload-done', (_, count) => callback(count)),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-text', text),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
});
