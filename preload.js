const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  onInit: (cb) => ipcRenderer.on('init', (_, data) => cb(data)),
  onUploadDone: (cb) => ipcRenderer.on('upload-done', (_, count) => cb(count)),
  onDirChanged: (cb) => ipcRenderer.on('dir-changed', (_, dir) => cb(dir)),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-text', text),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  openFolder: (p) => ipcRenderer.invoke('open-folder', p),
  generateQR: (text) => ipcRenderer.invoke('generate-qr', text),
  getAllIPs: () => ipcRenderer.invoke('get-all-ips'),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  getSharedDir: () => ipcRenderer.invoke('get-shared-dir'),
});
