'use strict';
// Stand-in for the Electron preload API, used only when the renderer is opened
// directly in a browser for design work. Not included in the built app.
// ?state=syncing|alone|paused|conflicts|confirm-delete|unavailable|problems  ?empty  ?lang=he  ?platform=darwin
(function () {
  const params = new URLSearchParams(location.search);
  const mode = params.get('state') || 'up-to-date';
  const platform = params.get('platform') || 'win32';
  const now = Date.now();
  const min = 60e3;
  const MAC = 'MacBook Air';

  let activity = [
    { ts: now - 0.4 * min, path: 'Q3 launch/launch-video.mp4', action: 'added', device: MAC, local: false, size: 2.4e9 },
    { ts: now - 3 * min, path: 'Q3 launch/plan.docx', action: 'changed', device: 'Shachar-PC', local: true, size: 48211 },
    { ts: now - 9 * min, path: 'Photos/Wedding/IMG_2041.jpg', action: 'added', device: MAC, local: false, size: 3.1e6 },
    { ts: now - 14 * min, path: 'Q3 launch/budget v2.xlsx', from: 'Q3 launch/budget.xlsx', action: 'moved', device: MAC, local: false, size: 18900 },
    { ts: now - 40 * min, path: 'מסמכים/חוזה שכירות.pdf', action: 'added', device: 'Shachar-PC', local: true, size: 512000 },
    { ts: now - 75 * min, path: 'notes.txt', action: 'deleted', device: MAC, local: false, size: 1200 },
    { ts: now - 26 * 60 * min, path: 'Q3 launch/plan (conflict - MacBook Air 2026-11-03 17.12).docx', action: 'conflict', device: MAC, local: false, kept: 'both', size: 47002 },
    { ts: now - 27 * 60 * min, path: 'Photos/Wedding/IMG_2040.jpg', action: 'added', device: MAC, local: false, size: 2.9e6 },
    { ts: now - 3 * 24 * 60 * min, path: 'old-draft.md', action: 'restored', device: 'Shachar-PC', local: true, size: 3400 },
  ].map((e) => ({ exists: e.action !== 'deleted', ...e }));
  if (params.has('empty')) activity = [];

  const trash = [
    { id: '1793600000000-aaaaaaaa', path: 'notes.txt', name: 'notes.txt', at: now - 75 * min, size: 1200, reason: 'deleted', byName: MAC },
    { id: '1793600000000-bbbbbbbb', path: 'Q3 launch/plan.docx', name: 'plan.docx', at: now - 3 * 60 * min, size: 47002, reason: 'replaced', byName: MAC },
    { id: '1793600000000-cccccccc', path: 'Photos/IMG_1999.jpg', name: 'IMG_1999.jpg', at: now - 4 * 24 * 60 * min, size: 2.2e6, reason: 'conflict', byName: '' },
  ];

  const peers = [{ id: 'm', name: MAC, platform: 'darwin', replica: 'r', address: '192.168.1.31', port: 47811, online: true, reachable: true, lastSeen: now, lastSyncAt: now - 20e3 }];
  const status = {
    state: mode,
    folder: platform === 'darwin' ? '/Users/shachar/FolderBridge' : 'C:\\Users\\Shachar\\FolderBridge',
    files: params.has('empty') ? 0 : 1284,
    pending: 0,
    bytesLeft: 0,
    conflicts: 0,
    holdDeletes: 0,
    conflictMode: 'ask',
    peers,
    foreign: [],
    transfers: [],
    problems: [],
  };
  let conflicts = [];
  const settings = {
    language: params.get('lang') || 'en',
    deviceName: 'Shachar-PC',
    code: 'K7QM-4XRT-P9WE',
    folder: status.folder,
    conflictMode: 'ask',
    openAtLogin: true,
    paused: mode === 'paused',
    notifyConflicts: true,
    shortcut: params.get('shortcut') || '',
    manualPeers: [],
  };

  if (mode === 'syncing') {
    Object.assign(status, { pending: 12, bytesLeft: 340e6, transfers: [{ path: 'Q3 launch/launch-video.mp4', size: 2.4e9, done: 1.1e9, peer: MAC, direction: 'down' }] });
  }
  if (mode === 'alone') {
    status.peers = [];
  }
  if (mode === 'conflicts') {
    conflicts = [
      { id: 'c1', path: 'Q3 launch/plan.docx', at: now - 2 * min, remote: { device: MAC, size: 47002, mtime: now - 12 * min }, local: { device: 'Shachar-PC', size: 48211, mtime: now - 5 * min } },
    ];
    status.conflicts = 1;
  }
  if (mode === 'confirm-delete') status.holdDeletes = 64;
  if (mode === 'unavailable') status.peers[0].online = true;
  if (mode === 'problems') {
    status.problems = [
      { type: 'windows-name', side: 'remote', path: 'Notes/Meeting: Q3?.txt', device: MAC },
      { type: 'locked', path: 'Q3 launch/budget v2.xlsx' },
    ];
  }

  const listeners = {};
  const emit = (ch) => (listeners[ch] || []).forEach((cb) => cb());

  window.api = {
    platform,
    getState: async () => ({
      self: { id: 'me', name: settings.deviceName, platform },
      settings: { ...settings },
      status: { ...status, conflicts: conflicts.length, state: conflicts.length || mode !== 'conflicts' ? status.state : 'up-to-date' },
      conflicts,
      isDefaultFolder: true,
      defaultFolder: status.folder,
      port: 47811,
      addresses: ['192.168.1.24'],
      listenError: null,
      loginStatus: null,
      dataDir: 'C:\\Users\\Shachar\\AppData\\Roaming\\FolderBridge',
      version: '0.1.0',
    }),
    activity: async ({ q = '', filter = 'all', offset = 0, limit = 100 }) => {
      const needle = q.toLowerCase();
      const res = activity.filter(
        (e) =>
          (filter !== 'local' || e.local) &&
          (filter !== 'remote' || !e.local) &&
          (filter !== 'conflict' || e.action === 'conflict') &&
          (!needle || e.path.toLowerCase().includes(needle))
      );
      return { items: res.slice(offset, offset + limit), total: res.length };
    },
    trash: async () => trash,
    restore: async (id) => {
      const i = trash.findIndex((x) => x.id === id);
      const [item] = trash.splice(i, 1);
      activity.unshift({ ts: Date.now(), path: item.path, action: 'restored', device: settings.deviceName, local: true, size: item.size, exists: true });
      emit('activity:changed');
      return { ok: true, path: item.path };
    },
    showTrashFolder: async () => {},
    resolveConflict: async (id, choice) => {
      conflicts = conflicts.filter((c) => c.id !== id);
      activity.unshift({ ts: Date.now(), path: 'Q3 launch/plan.docx', action: 'conflict', device: settings.deviceName, local: true, resolved: choice, exists: true });
      emit('activity:changed');
      emit('state:changed');
      return { ok: true };
    },
    approveDeletes: async () => {
      status.holdDeletes = 0;
      status.state = 'up-to-date';
      emit('state:changed');
    },
    keepFiles: async () => {
      status.holdDeletes = 0;
      status.state = 'up-to-date';
      emit('state:changed');
    },
    openFolder: async () => {},
    chooseFolder: async () => ({ ok: false, canceled: true }),
    resetFolder: async () => ({ ok: true }),
    showFile: async () => ({ ok: true }),
    setSettings: async (patch) => {
      Object.assign(settings, patch);
      if ('paused' in patch) status.state = patch.paused ? 'paused' : 'up-to-date';
      emit('state:changed');
      return { ok: true };
    },
    regenerateCode: async () => ({ ok: true }),
    addPeer: async () => ({ ok: true, found: false }),
    removePeer: async () => {},
    syncNow: async () => {},
    openDataDir: async () => {},
    hide: async () => {},
    on: (ch, cb) => {
      (listeners[ch] = listeners[ch] || []).push(cb);
      return () => {};
    },
  };
})();
