// Exposes a small, safe API to the web UI. The UI never gets Node or Electron access directly.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipsyncNative', {
  platform: process.platform,
  getInfo: () => ipcRenderer.invoke('app:info'),
  writeText: (text) => ipcRenderer.invoke('clipboard:write', String(text)),

  getSession: () => ipcRenderer.invoke('engine:getSession'),
  setSession: (session) => ipcRenderer.invoke('engine:setSession', session),
  getState: () => ipcRenderer.invoke('engine:getState'),
  updateSettings: (patch) => ipcRenderer.invoke('engine:updateSettings', patch),
  sendText: (text) => ipcRenderer.invoke('engine:sendText', String(text)),
  deleteClip: (id) => ipcRenderer.invoke('engine:deleteClip', String(id)),
  clearAll: () => ipcRenderer.invoke('engine:clearAll'),

  onEvent: (cb) => {
    const handler = (_event, e) => cb(e);
    ipcRenderer.on('engine:event', handler);
    return () => ipcRenderer.removeListener('engine:event', handler);
  },
});
