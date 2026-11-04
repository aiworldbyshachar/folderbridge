'use strict';
// Finds local changes in the synced folder and records them in the index.
//
// fs.watch (recursive, native on Windows and macOS) marks paths as dirty so
// changes are picked up within a fraction of a second; a full rescan on start
// and every few minutes catches anything the watcher missed. A file counts as
// changed only when its size or modification time differ from the index, and
// then its content is hashed. Files still being written (modified in the last
// couple of seconds, or changing while hashed) are checked again a bit later,
// and files another program keeps locked are retried.
//
// A folder that disappears (unplugged drive, moved folder) is reported as
// unavailable; it never turns into "every file was deleted".
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { META_DIR, isIgnored, toKey, isInside, baseName } = require('./names');

const DEBOUNCE = 200;
const LOCKED_RETRY = 5000;

function hashFile(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const rs = fs.createReadStream(abs);
    rs.on('data', (d) => h.update(d));
    rs.on('error', reject);
    rs.on('end', () => resolve(h.digest('hex')));
  });
}

function joinKey(dir, name) {
  return dir ? `${dir}/${name}` : name;
}

class Watcher extends EventEmitter {
  constructor({ root, index, isBusy, onLocal, markerOk, stableMs = 2000, scanInterval = 5 * 60 * 1000, log }) {
    super();
    this.root = root;
    this.index = index;
    this.isBusy = isBusy || (() => false);
    this.onLocal = onLocal || (() => {});
    this.markerOk = markerOk || (() => true);
    this.stableMs = stableMs;
    this.scanInterval = scanInterval;
    this.log = log || (() => {});
    this.available = true;
    this.locked = new Set();
    this.diskPaths = new Map(); // key -> absolute path when the name on disk isn't plain NFC
    this.dirty = new Set();
    this.fsw = null;
    this.timers = [];
    this.debounceTimer = null;
    this.retryTimer = null;
    this.running = false;
    this.scanning = null;
  }

  start() {
    this.running = true;
    this._watch();
    this.timers.push(setInterval(() => this.request(''), this.scanInterval));
    return this.request('', 0);
  }

  stop() {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.debounceTimer);
    clearTimeout(this.retryTimer);
    if (this.fsw) {
      try {
        this.fsw.close();
      } catch {}
      this.fsw = null;
    }
  }

  // Where a key lives on this disk.
  absPath(key) {
    return this.diskPaths.get(key) || path.join(this.root, ...key.split('/'));
  }

  // Marks a path (or '' for everything) to be checked soon. Resolves once
  // the scan that covers it has finished.
  request(key, delay = DEBOUNCE) {
    this.dirty.add(key);
    if (!this._waiters) this._waiters = [];
    const done = new Promise((resolve) => this._waiters.push(resolve));
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this._runDirty(), delay);
    return done;
  }

  // Scans right away (used before applying a remote change to a path).
  async scanNow(key) {
    this.dirty.add(key);
    clearTimeout(this.debounceTimer);
    await this._runDirty();
  }

  // ---------- internals ----------

  _watch() {
    if (this.fsw || !this.running) return;
    try {
      this.fsw = fs.watch(this.root, { recursive: true }, (evt, filename) => this._onEvent(filename));
      this.fsw.on('error', (err) => {
        this.log('watch error:', err.message);
        try {
          this.fsw.close();
        } catch {}
        this.fsw = null;
      });
    } catch (err) {
      this.log('watch failed:', err.message);
      this.fsw = null;
    }
  }

  _onEvent(filename) {
    if (!filename) return this.request('');
    const raw = filename.toString();
    const key = toKey(raw);
    if (key.split('/').some((part) => part === META_DIR || isIgnored(part))) return;
    // Keep the name as the disk spells it (NFD from a Mac on NTFS isn't found by its NFC form).
    if (key !== raw.split(path.sep).join('/')) this.diskPaths.set(key, path.join(this.root, raw));
    this.request(key);
  }

  async _runDirty() {
    // One scan at a time; anything marked meanwhile is picked up next round.
    while (this.scanning) await this.scanning;
    if (!this.dirty.size) return this._release();
    let prefixes = [...this.dirty];
    this.dirty.clear();
    this._names = new Map(); // folder listings shared by this round's scans
    const waiters = this._waiters || [];
    this._waiters = [];
    if (prefixes.includes('')) prefixes = [''];
    else prefixes = prefixes.filter((k) => !prefixes.some((o) => o !== k && isInside(k, o)));
    this.scanning = (async () => {
      for (const prefix of prefixes) {
        try {
          await this._scan(prefix);
        } catch (err) {
          this.log('scan failed:', err.message);
        }
      }
    })();
    try {
      await this.scanning;
    } finally {
      this.scanning = null;
      for (const resolve of waiters) resolve();
    }
    if (this.dirty.size) await this._runDirty();
  }

  _release() {
    const waiters = this._waiters || [];
    this._waiters = [];
    for (const resolve of waiters) resolve();
  }

  _setAvailable(ok, reason) {
    if (ok === this.available) return;
    this.available = ok;
    this.log(ok ? 'folder available' : `folder unavailable: ${reason}`);
    this.emit(ok ? 'available' : 'unavailable', reason);
  }

  // On case-insensitive disks lstat("Report.txt") also finds "report.txt", so
  // a single path is only "there" if its folder lists that exact name.
  // A cached listing is only trusted to say "yes"; a "no" is read again.
  async _listed(abs, key) {
    const dir = path.dirname(abs);
    const name = baseName(key);
    const cached = this._names && this._names.get(dir);
    if (cached && cached.has(name)) return true;
    let names;
    try {
      names = new Set((await fs.promises.readdir(dir)).map((n) => n.normalize('NFC')));
    } catch {
      names = new Set();
    }
    if (this._names) this._names.set(dir, names);
    return names.has(name);
  }

  async _scan(prefix) {
    let rootStat = null;
    try {
      rootStat = fs.statSync(this.root);
    } catch {}
    if (!rootStat || !rootStat.isDirectory()) return this._setAvailable(false, 'missing');
    if (!this.markerOk()) return this._setAvailable(false, 'replaced');
    this._setAvailable(true);
    this._watch();

    const files = [];
    const dirs = [];
    const failed = []; // folders we couldn't read: don't treat their content as deleted
    const now = Date.now();

    const walk = async (dirKey, absDir) => {
      let entries;
      try {
        entries = await fs.promises.readdir(absDir, { withFileTypes: true });
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') failed.push(dirKey);
        return;
      }
      for (const ent of entries) {
        if (isIgnored(ent.name) || ent.isSymbolicLink()) continue;
        const name = ent.name.normalize('NFC');
        const key = joinKey(dirKey, name);
        const abs = path.join(absDir, ent.name);
        if (name !== ent.name) this.diskPaths.set(key, abs);
        if (ent.isDirectory()) {
          dirs.push(key);
          await walk(key, abs);
        } else if (ent.isFile()) {
          files.push({ key, abs });
        }
      }
    };

    if (!prefix) {
      await walk('', this.root);
    } else {
      const abs = this.absPath(prefix);
      let st = null;
      try {
        st = await fs.promises.lstat(abs);
      } catch (err) {
        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') failed.push(prefix);
      }
      if (st && !(await this._listed(abs, prefix))) st = null;
      if (st && st.isDirectory()) {
        dirs.push(prefix);
        await walk(prefix, abs);
      } else if (st && st.isFile()) {
        files.push({ key: prefix, abs });
      }
    }

    const seen = new Set([...dirs, ...files.map((f) => f.key)]);
    const later = new Set();
    const locked = new Set();

    for (const key of dirs) {
      const rec = this.index.get(key);
      if (this.isBusy(key)) continue;
      if (!rec || rec.deleted || rec.type !== 'dir') this.onLocal(this.index.localChange({ type: 'dir', path: key }), rec);
    }

    for (const { key, abs } of files) {
      if (this.isBusy(key)) continue;
      const rec = this.index.get(key);
      let st;
      try {
        st = await fs.promises.stat(abs);
      } catch {
        later.add(key);
        continue;
      }
      if (rec && rec.type === 'file' && !rec.deleted && rec.size === st.size && rec.lmt === st.mtimeMs) continue;
      if (now - st.mtimeMs < this.stableMs && st.mtimeMs < now + 60000) {
        later.add(key); // probably still being written
        continue;
      }
      let hash;
      try {
        hash = await hashFile(abs);
      } catch (err) {
        if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') locked.add(key);
        else later.add(key);
        continue;
      }
      let st2;
      try {
        st2 = await fs.promises.stat(abs);
      } catch {
        later.add(key);
        continue;
      }
      const recNow = this.index.get(key);
      if (st2.size !== st.size || st2.mtimeMs !== st.mtimeMs || recNow !== rec || this.isBusy(key)) {
        later.add(key);
        continue;
      }
      if (rec && rec.type === 'file' && !rec.deleted && rec.hash === hash) {
        this.index.touchLocal(key, st.mtimeMs);
      } else {
        const next = this.index.localChange({ type: 'file', path: key, size: st.size, mtime: st.mtimeMs, hash, lmt: st.mtimeMs });
        this.onLocal(next, rec);
      }
    }

    // Whatever the index has under this prefix that is no longer on disk was deleted.
    const gone = [];
    for (const rec of this.index.all()) {
      if (rec.deleted || !isInside(rec.path, prefix) || seen.has(rec.path)) continue;
      if (later.has(rec.path) || this.isBusy(rec.path)) continue;
      if (failed.some((f) => isInside(rec.path, f))) continue;
      gone.push(rec);
    }
    // Deepest first, so a folder's files are recorded before the folder itself.
    gone.sort((a, b) => b.path.length - a.path.length);
    for (const rec of gone) {
      this.diskPaths.delete(rec.path);
      this.onLocal(this.index.localChange({ type: rec.type, path: rec.path, deleted: true }), rec);
    }

    // Files another program keeps open: remember them for the status line.
    const nowLocked = new Set([...this.locked].filter((k) => !isInside(k, prefix)));
    for (const k of locked) nowLocked.add(k);
    if (nowLocked.size !== this.locked.size || [...nowLocked].some((k) => !this.locked.has(k))) {
      this.locked = nowLocked;
      this.emit('locked', [...nowLocked]);
    }
    if (later.size || locked.size) {
      for (const k of later) this.dirty.add(k);
      for (const k of locked) this.dirty.add(k);
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this._runDirty(), locked.size ? LOCKED_RETRY : this.stableMs + 100);
    }
    this.emit('scanned', prefix);
  }
}

module.exports = { Watcher, hashFile };
