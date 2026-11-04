'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = ['state:changed', 'activity:changed', 'ui:open-settings', 'ui:open-trash'];

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('state:get'),
  activity: (opts) => ipcRenderer.invoke('activity:list', opts),
  trash: () => ipcRenderer.invoke('trash:list'),
  restore: (id) => ipcRenderer.invoke('trash:restore', id),
  showTrashFolder: () => ipcRenderer.invoke('trash:show'),
  resolveConflict: (id, choice) => ipcRenderer.invoke('conflict:resolve', id, choice),
  approveDeletes: () => ipcRenderer.invoke('deletes:approve'),
  keepFiles: () => ipcRenderer.invoke('deletes:keep'),
  openFolder: () => ipcRenderer.invoke('folder:open'),
  chooseFolder: () => ipcRenderer.invoke('folder:choose'),
  resetFolder: () => ipcRenderer.invoke('folder:reset'),
  showFile: (key) => ipcRenderer.invoke('file:show', key),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  regenerateCode: () => ipcRenderer.invoke('settings:regen-code'),
  addPeer: (address) => ipcRenderer.invoke('peer:add', address),
  removePeer: (address) => ipcRenderer.invoke('peer:remove', address),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  hide: () => ipcRenderer.invoke('app:hide'),
  on: (channel, callback) => {
    if (!EVENTS.includes(channel)) return () => {};
    const handler = (_e, ...args) => callback(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
