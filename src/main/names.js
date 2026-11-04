'use strict';
// File names between macOS and Windows.
//
// Inside FolderBridge every file is known by its "key": the path relative to
// the synced folder, with "/" separators and Unicode in NFC form. macOS often
// hands out NFD names (accents, Hebrew niqqud) while Windows uses NFC, so the
// same name typed on both machines must end up as one key, never two files.
const path = require('path');

const META_DIR = '.folderbridge';
const MAX_KEY_LENGTH = 4096;

// System and editor junk that should never travel between computers.
const IGNORED = new Set([
  '.ds_store',
  '.spotlight-v100',
  '.trashes',
  '.fseventsd',
  '.temporaryitems',
  '.documentrevisions-v100',
  'thumbs.db',
  'ehthumbs.db',
  'desktop.ini',
  '$recycle.bin',
  'system volume information',
  META_DIR,
]);
const IGNORED_SUFFIXES = ['.tmp', '.crdownload', '.part', '.partial', '.download'];

function isIgnored(name) {
  const lower = name.toLowerCase();
  if (IGNORED.has(lower)) return true;
  if (name.startsWith('._')) return true; // AppleDouble resource forks
  if (name.startsWith('~$')) return true; // Office lock files
  if (name.startsWith('.~lock.')) return true; // LibreOffice lock files
  return IGNORED_SUFFIXES.some((s) => lower.endsWith(s));
}

// Relative OS path -> key.
function toKey(rel) {
  return rel.split(path.sep).join('/').normalize('NFC');
}

function parentKey(key) {
  const i = key.lastIndexOf('/');
  return i < 0 ? '' : key.slice(0, i);
}

function baseName(key) {
  return key.slice(key.lastIndexOf('/') + 1);
}

function isInside(key, prefix) {
  return !prefix || key === prefix || key.startsWith(prefix + '/');
}

// Case-insensitive identity: both default file systems ignore case, so two
// keys that only differ in case would land on the same file.
function foldKey(key) {
  return key.toLowerCase();
}

// Keys arriving from the network must be plain relative paths.
function isSafeKey(key) {
  if (typeof key !== 'string' || !key || key.length > MAX_KEY_LENGTH) return false;
  if (key.includes('\0') || key.startsWith('/')) return false;
  if (key !== key.normalize('NFC')) return false;
  for (const part of key.split('/')) {
    if (!part || part === '.' || part === '..') return false;
    if (isIgnored(part)) return false;
  }
  return true;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const WIN_BAD_CHARS = /[<>:"\\|?*\x00-\x1f]/;

// Why a key can't be written on Windows, or null when it can.
function windowsNameProblem(key) {
  for (const part of key.split('/')) {
    if (WIN_BAD_CHARS.test(part)) return 'characters';
    if (/[. ]$/.test(part)) return 'ending';
    if (WIN_RESERVED.test(part)) return 'reserved';
  }
  return null;
}

// Joins a key onto the folder, refusing anything that could step outside it.
function keyToPath(root, key, platform = process.platform) {
  if (!isSafeKey(key)) throw new Error(`unsafe path: ${key}`);
  if (platform === 'win32' && windowsNameProblem(key)) throw new Error(`not a valid Windows name: ${key}`);
  const abs = path.join(root, ...key.split('/'));
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`unsafe path: ${key}`);
  return abs;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function stamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}`;
}

// "dir/report.docx" -> "dir/report (conflict - Home-PC 2026-11-01 14.32).docx".
// Built only from the losing version's own data, so every computer that
// resolves the same conflict picks the same name.
function conflictKey(key, deviceName, mtime) {
  const dir = parentKey(key);
  const name = baseName(key);
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && dot < name.length - 1;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  const device = String(deviceName || 'device').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim().slice(0, 40) || 'device';
  const out = `${stem} (conflict - ${device} ${stamp(mtime)})${ext}`.normalize('NFC');
  return dir ? `${dir}/${out}` : out;
}

module.exports = {
  META_DIR,
  isIgnored,
  toKey,
  parentKey,
  baseName,
  isInside,
  foldKey,
  isSafeKey,
  windowsNameProblem,
  keyToPath,
  conflictKey,
};
