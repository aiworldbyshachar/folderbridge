'use strict';
// Settings of this computer, in settings.json in the app's data folder.
// (How conflicts are handled is a setting of the shared folder instead; it
// lives in the index and travels to the other computers.)
const fs = require('fs');
const path = require('path');
const os = require('os');
const { formatCode, generateCode } = require('./code');

function defaultDeviceName() {
  const host = os.hostname().replace(/\.local$/i, '').trim();
  return host || (process.platform === 'darwin' ? 'Mac' : 'PC');
}

function defaultFolder() {
  return path.join(os.homedir(), 'FolderBridge');
}

const DEFAULTS = {
  language: 'en',
  deviceName: '',
  code: '',
  folder: '',
  openAtLogin: true,
  paused: false,
  notifyConflicts: true,
  shortcut: '', // none by default: people work in Finder / Explorer, not in this window
  manualPeers: [],
  knownPeers: [],
};

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    this.isFirstRun = false;
  }

  load() {
    let saved = null;
    try {
      saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.isFirstRun = true;
    }
    this.data = { ...DEFAULTS, ...(saved || {}) };
    if (!this.data.deviceName) this.data.deviceName = defaultDeviceName();
    if (!this.data.folder) this.data.folder = defaultFolder();
    this.data.code = this.data.code ? formatCode(this.data.code) : generateCode();
    this.save();
  }

  // The default folder is created on first run; a folder the user picked is
  // never created behind their back (if it's missing, it's "unavailable").
  isDefaultFolder() {
    return path.resolve(this.data.folder) === path.resolve(defaultFolder());
  }

  get(key) {
    return this.data[key];
  }

  set(patch) {
    Object.assign(this.data, patch);
    this.save();
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    try {
      fs.renameSync(tmp, this.file);
    } catch {
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    }
  }
}

module.exports = { Settings, defaultFolder, DEFAULTS };
