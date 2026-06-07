const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dsbro', {
  getDashboard: () => ipcRenderer.invoke('dashboard:get'),
  refreshDashboard: () => ipcRenderer.invoke('dashboard:refresh'),
  openWeb: () => ipcRenderer.invoke('dashboard:open-web'),
  setSize: (size) => ipcRenderer.invoke('window:set-size', size),
  moveBy: (delta) => ipcRenderer.invoke('window:move-by', delta),
  setDetailOpen: (open) => ipcRenderer.invoke('window:set-detail-open', open),
  quit: () => ipcRenderer.invoke('app:quit'),
  onDashboardData: (callback) => ipcRenderer.on('dashboard-data', (_event, value) => callback(value))
});
