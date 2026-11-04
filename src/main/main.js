'use strict';
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  nativeTheme,
  ipcMain,
  globalShortcut,
  shell,
  Notification,
  dialog,
  systemPreferences,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Settings, defaultFolder } = require('./settings');
const { FolderSync } = require('./folder');
const { localAddresses, parseTarget, DEFAULT_PORT } = require('./sync');
const { formatCode, isValidCode, generateCode } = require('./code');
const { META_DIR } = require('./names');
const { LANGUAGES, createTranslator } = require('../shared/i18n');

const isMac = process.platform === 'darwin';
const ASSETS = path.join(__dirname, '..', '..', 'assets');

let tr = createTranslator('en');
const t = (key, vars) => tr.t(key, vars);

// FOLDERBRIDGE_PROFILE runs an independent second instance (separate data,
// folder and port) on the same machine, which is handy for testing.
const profile = process.env.FOLDERBRIDGE_PROFILE;
if (profile) app.setPath('userData', path.join(app.getPath('appData'), `FolderBridge-${profile}`));

let settings, sync, tray, win;
let quitting = false;

// A small log file in the data folder, for troubleshooting.
let logFile = null;
function log(...args) {
  const line = `${new Date().toISOString()} ${args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')}\n`;
  if (!app.isPackaged) process.stdout.write(line);
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, line);
  } catch {}
}
process.on('uncaughtException', (err) => log('uncaught:', err));
process.on('unhandledRejection', (err) => log('unhandled rejection:', err));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(init).catch((err) => {
    dialog.showErrorBox('FolderBridge', `FolderBridge failed to start:\n${err.stack || err}`);
    app.quit();
  });
}

// macOS: clicking the Dock icon opens the window. Ignored right after launch,
// so starting at login doesn't pop the window up.
let acceptActivate = false;
app.on('activate', () => {
  if (acceptActivate) showWindow();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (sync) sync.stop();
});

// Keep running in the tray when the window is closed.
app.on('window-all-closed', () => {});

async function init() {
  if (isMac) {
    // App Nap slows the timers of background apps. Info.plist opts out too.
    try {
      systemPreferences.setUserDefault('NSAppSleepDisabled', 'boolean', true);
    } catch {}
  }

  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  logFile = path.join(userData, 'folderbridge.log');
  try {
    if (fs.statSync(logFile).size > 1024 * 1024) fs.rmSync(logFile);
  } catch {}
  log(`starting FolderBridge ${app.getVersion()} on ${process.platform}`);

  settings = new Settings(userData);
  settings.load();
  if (profile && settings.isFirstRun) settings.set({ folder: path.join(os.homedir(), `FolderBridge-${profile}`) });
  tr = createTranslator(settings.get('language'));
  buildAppMenu();

  await startSync();
  setupIpc();
  createTray();
  registerShortcut();
  applyLoginItem();

  if (settings.isFirstRun || !launchedAtLogin()) showWindow();
  setTimeout(() => (acceptActivate = true), 1500);
  if (process.env.FOLDERBRIDGE_SCREENSHOT) captureForTesting(process.env.FOLDERBRIDGE_SCREENSHOT);
}

// ---------- the synced folder ----------

async function startSync() {
  const folder = settings.get('folder');
  sync = new FolderSync({
    root: folder,
    dataDir: path.join(app.getPath('userData'), 'sync'),
    deviceName: settings.get('deviceName'),
    code: settings.get('code'),
    port: Number(process.env.FOLDERBRIDGE_PORT) || DEFAULT_PORT,
    manualPeers: settings.get('manualPeers'),
    knownPeers: settings.get('knownPeers'),
    // Only the default folder is created on its own; a folder the user picked
    // that has gone missing is "unavailable", not recreated empty.
    createRoot: settings.isDefaultFolder() || !!profile,
    paused: settings.get('paused'),
    log: (...args) => log('[sync]', ...args),
  });
  sync.on('status', onStatus);
  sync.on('peers', onPeersChanged);
  sync.on('conflict', onConflict);
  sync.on('confirm-delete', onConfirmDelete);
  await sync.start();
  log(`syncing ${folder} on port ${sync.engine.port}, addresses ${localAddresses().join(', ')}, ${sync.index.liveCount()} files`);
}

// A different folder is a fresh start for this computer: its files are merged
// with the other computers' (nothing is deleted), the old folder stays as it is.
async function changeFolder(dir) {
  const target = path.resolve(dir);
  const problem = folderProblem(target);
  if (problem) return { ok: false, error: t(problem) };
  if (target === path.resolve(settings.get('folder'))) return { ok: true };
  sync.stop();
  settings.set({ folder: target });
  await startSync();
  sendState();
  updateTrayMenu();
  return { ok: true };
}

function folderProblem(dir) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch {
    return 'errFolderMissing';
  }
  if (!st.isDirectory()) return 'errFolderMissing';
  // Syncing a whole drive or the home folder would pull in far too much.
  if (path.parse(dir).root === dir || dir === os.homedir()) return 'errFolderTooBig';
  const data = app.getPath('userData');
  if (dir.startsWith(data) || data.startsWith(dir + path.sep)) return 'errFolderData';
  if (dir.split(path.sep).includes(META_DIR)) return 'errFolderData';
  return null;
}

// ---------- events from the engine ----------

let stateTimer = null;
function onStatus() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    sendState();
    send('activity:changed');
    updateTrayMenu();
  }, 150);
}

function onPeersChanged(peers, foreign) {
  log('peers:', peers.map((p) => `${p.name}@${p.address}:${p.port}${p.online ? '' : ' (offline)'}`).join(', ') || 'none',
    foreign.length ? `| other code: ${foreign.map((f) => `${f.name}@${f.address}`).join(', ')}` : '');
  const known = new Set(settings.get('knownPeers'));
  let changed = false;
  for (const p of peers) {
    if (!p.online || !p.address) continue;
    const key = `${p.address}:${p.port}`;
    if (!known.has(key)) {
      known.add(key);
      changed = true;
    }
  }
  if (changed) settings.set({ knownPeers: [...known].slice(-8) });
  onStatus();
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => showWindow());
  n.show();
}

function onConflict({ path: key, device }) {
  log(`conflict: ${key} (also changed on ${device})`);
  if (settings.get('notifyConflicts')) notify(t('notifyConflictTitle'), t('notifyConflictBody', { name: path.basename(key), device }));
  onStatus();
}

function onConfirmDelete(count) {
  log(`holding ${count} deletions for confirmation`);
  notify(t('notifyDeleteTitle', { n: count }), t('notifyDeleteBody'));
  onStatus();
}

function send(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}

function sendState() {
  send('state:changed');
}

// ---------- state for the renderer ----------

function getState() {
  const s = settings.data;
  const status = sync.getStatus();
  status.problems = status.problems.slice(0, 50);
  return {
    self: { id: sync.index.deviceId, name: s.deviceName, platform: process.platform },
    settings: {
      language: tr.code,
      deviceName: s.deviceName,
      code: s.code,
      folder: sync.root,
      conflictMode: sync.getConflictMode(),
      openAtLogin: s.openAtLogin,
      paused: s.paused,
      notifyConflicts: s.notifyConflicts,
      shortcut: s.shortcut,
      manualPeers: s.manualPeers,
    },
    status,
    conflicts: sync.getConflicts(),
    isDefaultFolder: settings.isDefaultFolder(),
    defaultFolder: defaultFolder(),
    port: sync.engine.port,
    addresses: localAddresses(),
    listenError: sync.engine.listenError,
    loginStatus: isMac && app.isPackaged ? app.getLoginItemSettings().status : null,
    dataDir: app.getPath('userData'),
    version: app.getVersion(),
  };
}

// ---------- IPC ----------

function setupIpc() {
  ipcMain.handle('state:get', () => getState());
  ipcMain.handle('activity:list', (_e, opts) => {
    const res = sync.getActivity(opts || {});
    // Whether each file is still there, so the UI only offers "Show" when it can.
    return { total: res.total, items: res.items.map((e) => ({ ...e, exists: !!sync.pathOf(e.path) })) };
  });
  ipcMain.handle('trash:list', () => sync.getTrash());
  ipcMain.handle('trash:restore', async (_e, id) => {
    try {
      return { ok: true, path: await sync.restoreFromTrash(id) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
  ipcMain.handle('conflict:resolve', async (_e, id, choice) => {
    try {
      await sync.resolveConflict(id, choice);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message === 'busy' ? t('errBusy') : err.message };
    }
  });
  ipcMain.handle('deletes:approve', () => sync.approveDeletes());
  ipcMain.handle('deletes:keep', () => sync.keepFiles());
  ipcMain.handle('folder:open', () => openFolder());
  ipcMain.handle('folder:choose', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: t('chooseFolderTitle'),
      defaultPath: sync.root,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    return changeFolder(res.filePaths[0]);
  });
  ipcMain.handle('folder:reset', async () => {
    fs.mkdirSync(defaultFolder(), { recursive: true });
    return changeFolder(defaultFolder());
  });
  ipcMain.handle('file:show', (_e, key) => {
    const abs = sync.pathOf(key);
    if (abs) shell.showItemInFolder(abs);
    return { ok: !!abs };
  });
  ipcMain.handle('trash:show', () => shell.openPath(path.join(sync.root, META_DIR, 'trash')));

  ipcMain.handle('settings:set', (_e, patch) => applySettings(patch || {}));
  ipcMain.handle('settings:regen-code', () => applySettings({ code: generateCode() }));

  ipcMain.handle('peer:add', async (_e, text) => {
    const target = parseTarget(text);
    if (!target) return { ok: false, error: t('errAddress') };
    const entry = target.port === DEFAULT_PORT ? target.host : `${target.host}:${target.port}`;
    const list = [...new Set([...settings.get('manualPeers'), entry])];
    settings.set({ manualPeers: list });
    sync.setManualPeers(list);
    sendState();
    try {
      const hello = await sync.engine.probe(target.host, target.port);
      if (hello.id === sync.index.deviceId) return { ok: true, found: true, self: true };
      return { ok: true, found: true, name: hello.name, sameCode: hello.fp === sync.engine.fp };
    } catch {
      return { ok: true, found: false };
    }
  });

  ipcMain.handle('peer:remove', (_e, entry) => {
    const list = settings.get('manualPeers').filter((p) => p !== entry);
    settings.set({ manualPeers: list });
    sync.setManualPeers(list);
    sendState();
  });

  ipcMain.handle('sync:now', () => sync.engine.syncAll());
  ipcMain.handle('app:open-data-dir', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('app:hide', () => hideWindow());
}

async function applySettings(patch) {
  if ('language' in patch && LANGUAGES.some((l) => l.code === patch.language)) {
    settings.set({ language: patch.language });
    tr = createTranslator(patch.language);
    buildAppMenu();
    updateTrayMenu();
  }
  if ('deviceName' in patch) {
    const name = String(patch.deviceName || '').trim().slice(0, 60);
    if (!name) return { ok: false, error: t('errNameEmpty') };
    settings.set({ deviceName: name });
    sync.setDeviceName(name);
  }
  if ('code' in patch) {
    if (!isValidCode(patch.code)) return { ok: false, error: t('errCodeShort') };
    const code = formatCode(patch.code);
    if (code !== settings.get('code')) {
      settings.set({ code });
      sync.setCode(code);
    }
  }
  if ('conflictMode' in patch) {
    try {
      sync.setConflictMode(patch.conflictMode);
    } catch {
      return { ok: false, error: t('toastSaveFailed') };
    }
  }
  if ('notifyConflicts' in patch) settings.set({ notifyConflicts: !!patch.notifyConflicts });
  if ('paused' in patch) {
    settings.set({ paused: !!patch.paused });
    await sync.setPaused(!!patch.paused);
    updateTrayMenu();
  }
  if ('openAtLogin' in patch) {
    settings.set({ openAtLogin: !!patch.openAtLogin });
    applyLoginItem();
  }
  if ('shortcut' in patch) {
    const previous = settings.get('shortcut');
    settings.set({ shortcut: String(patch.shortcut || '') });
    if (!registerShortcut()) {
      settings.set({ shortcut: previous });
      registerShortcut();
      return { ok: false, error: t('errShortcut') };
    }
  }
  sendState();
  return { ok: true };
}

function applyLoginItem() {
  if (!app.isPackaged) return;
  try {
    // `args` is Windows-only; it tells this app it was started at login.
    app.setLoginItemSettings({ openAtLogin: !!settings.get('openAtLogin'), args: ['--hidden'] });
  } catch (err) {
    log('login item:', err);
  }
}

// Started automatically at login (as opposed to by the user)? Windows passes
// --hidden. Newer macOS no longer reports it, so a launch within the first
// minutes after boot while "Launch at login" is on counts as one.
function launchedAtLogin() {
  if (process.argv.includes('--hidden')) return true;
  if (!isMac) return false;
  if (app.getLoginItemSettings().wasOpenedAtLogin) return true;
  return !!settings.get('openAtLogin') && os.uptime() < 180;
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  const accelerator = settings.get('shortcut');
  if (!accelerator) return true;
  try {
    return globalShortcut.register(accelerator, () => toggleWindow());
  } catch {
    return false;
  }
}

function openFolder() {
  fs.mkdirSync(sync.root, { recursive: true });
  return shell.openPath(sync.root);
}

// ---------- window ----------

function createWindow() {
  win = new BrowserWindow({
    width: 520,
    height: 720,
    minWidth: 380,
    minHeight: 480,
    show: false,
    title: 'FolderBridge',
    icon: isMac ? undefined : path.join(ASSETS, 'icon.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#14141b' : '#f5f5f8',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The language is passed along so the first paint is already translated.
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { lang: tr.code } });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error') log(`renderer ${e.level}: ${e.message} (${e.sourceId}:${e.lineNumber})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => log('renderer gone:', details.reason));
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      hideWindow();
    }
  });
  // Never navigate away from the app page; open links in the browser instead.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow(then) {
  if (!win || win.isDestroyed()) createWindow();
  if (isMac) app.focus({ steal: true });
  const reveal = () => {
    win.show();
    win.focus();
    if (then) send(then);
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', reveal);
  else reveal();
}

function hideWindow() {
  if (!win || win.isDestroyed()) return;
  win.hide();
}

function toggleWindow() {
  if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) hideWindow();
  else showWindow();
}

// ---------- tray ----------

function formatBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function statusLine(s) {
  switch (s.state) {
    case 'syncing':
      return s.bytesLeft ? t('stSyncingBytes', { n: s.pending, size: formatBytes(s.bytesLeft) }) : t('stSyncing', { n: s.pending });
    case 'alone':
      return t('stAlone');
    case 'paused':
      return t('stPaused');
    case 'conflicts':
      return t('stConflicts', { n: s.conflicts });
    case 'confirm-delete':
      return t('stConfirmDelete', { n: s.holdDeletes });
    case 'unavailable':
      return t('stUnavailable');
    default:
      return t('stUpToDate');
  }
}

function createTray() {
  let icon;
  if (isMac) {
    icon = nativeImage.createFromPath(path.join(ASSETS, 'trayTemplate.png'));
    icon.setTemplateImage(true);
  } else {
    icon = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  }
  tray = new Tray(icon);
  tray.setToolTip('FolderBridge');
  if (!isMac) tray.on('click', () => toggleWindow());
  updateTrayMenu();
}

let trayTimer = null;
function updateTrayMenu() {
  if (!tray || trayTimer) return;
  trayTimer = setTimeout(() => {
    trayTimer = null;
    buildTrayMenu();
  }, 200);
}

const ACTION_MARK = { added: '+', changed: '~', deleted: '-', moved: '>', conflict: '!', restored: '+' };

function buildTrayMenu() {
  const status = statusLine(sync.getStatus());
  tray.setToolTip(`FolderBridge - ${status}`);

  const recent = sync.getActivity({ limit: 8 }).items.map((e) => {
    const name = path.basename(e.path);
    const label = `${ACTION_MARK[e.action] || ''}  ${name.length > 44 ? name.slice(0, 43) + '…' : name}`;
    const abs = sync.pathOf(e.path);
    return { label, enabled: !!abs, click: () => abs && shell.showItemInFolder(abs) };
  });

  const accel = settings.get('shortcut');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: status, enabled: false },
      { type: 'separator' },
      { label: t('trayOpenFolder'), click: () => openFolder() },
      { label: t('trayOpen'), accelerator: accel || undefined, registerAccelerator: false, click: () => showWindow() },
      { label: t('trayRecent'), submenu: recent.length ? recent : [{ label: t('trayNothing'), enabled: false }] },
      { type: 'separator' },
      {
        label: t('trayPause'),
        type: 'checkbox',
        checked: !!settings.get('paused'),
        click: (item) => applySettings({ paused: item.checked }),
      },
      { label: t('traySettings'), click: () => showWindow('ui:open-settings') },
      { type: 'separator' },
      { label: t('trayQuit'), click: () => app.quit() },
    ])
  );
}

// macOS shows the app's menu bar while FolderBridge is in front; it also makes
// copy/paste shortcuts work in text fields. Windows needs none.
function buildAppMenu() {
  if (!isMac) {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: t('traySettings'), accelerator: 'Command+,', click: () => showWindow('ui:open-settings') },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { label: t('trayQuit'), accelerator: 'Command+Q', click: () => app.quit() },
        ],
      },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ])
  );
}

// ---------- test helper ----------

function captureForTesting(file) {
  setTimeout(async () => {
    try {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(file, image.toPNG());
      log('captured window to', file);
    } catch (err) {
      log('capture failed', err);
    }
    if (process.env.FOLDERBRIDGE_EXIT_AFTER_CAPTURE) app.quit();
  }, Number(process.env.FOLDERBRIDGE_CAPTURE_DELAY) || 2500);
}
