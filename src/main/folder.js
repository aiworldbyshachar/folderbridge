'use strict';
// FolderSync: one synced folder, from the disk to the network and back.
//
//   watcher  -> finds local changes, records them in the index
//   engine   -> sends our index records to peers, brings theirs in
//   receive  -> compares each incoming record with ours (version vectors) and
//               queues what has to happen here ("needs")
//   _process -> applies one need: delete (to the trash), create a folder,
//               get a file's content (local copy, download, or upload from the
//               peer) and swap it in atomically, or handle a conflict
//
// Safety rules, because nothing may ever be lost:
//  - deleted and replaced files go to the FolderBridge trash
//  - a change and a deletion of the same file: the change wins
//  - two different changes: ask (default), keep both, or newest wins - the
//    automatic modes are deterministic, so every computer ends up the same
//  - many deletions at once wait for the user's OK
//  - nothing is applied while the folder is unavailable
//  - a file is only replaced if it's still exactly what the index says it is
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const names = require('./names');
const { FileIndex, compareVV, mergeVV, sameContent, sanitizeRecord, ID_RE, HASH_RE } = require('./index');
const { Watcher, hashFile } = require('./watcher');
const { Trash } = require('./trash');
const { Activity } = require('./activity');
const { SyncEngine } = require('./sync');
const { partSize } = require('./transfer');

const PARALLEL = 3;
const MASS_DELETE_FILES = 50;
const MASS_DELETE_SHARE = 0.2;
const MASS_DELETE_MIN = 10;
const RECENT_DELETE_WINDOW = 60000;
const FREE_SPACE_MARGIN = 64 * 1024 * 1024;
const MAX_WANTS = 20;
const MAX_UPLOADS = 4;
const WANT_RETRY = 60000;
const PART_MAX_AGE = 7 * 24 * 3600 * 1000;
const HOUSEKEEPING = 6 * 3600 * 1000;
const EMPTY_HASH = crypto.createHash('sha256').digest('hex');

function codeOf(err) {
  return (err && err.code) || '';
}

function isLocked(err) {
  return ['EBUSY', 'EPERM', 'EACCES'].includes(codeOf(err));
}

function fileFields(rec, lmt) {
  return { type: 'file', path: rec.path, size: rec.size, mtime: rec.mtime, hash: rec.hash, lmt: lmt === undefined ? rec.lmt : lmt };
}

class FolderSync extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.root = path.resolve(opts.root);
    this.dataDir = opts.dataDir;
    this.deviceName = opts.deviceName;
    this.platform = opts.platform || process.platform;
    this.stableMs = opts.stableMs === undefined ? 2000 : opts.stableMs;
    this.log = opts.log || (() => {});
    this.metaDir = path.join(this.root, names.META_DIR);
    this.tmpDir = path.join(this.metaDir, 'tmp');
    this.conflictDir = path.join(this.metaDir, 'conflicts');
    this.markerPath = path.join(this.metaDir, 'folder.json');
    this.index = new FileIndex({ dir: opts.dataDir, root: this.root, deviceName: opts.deviceName });
    this.trash = new Trash(this.root);
    this.activity = new Activity(opts.dataDir);
    this.watcher = null;
    this.engine = null;

    this.needs = new Map(); // key -> [{ rec, from, mode, retryAt, blocked }], first one is next
    this.ready = new Set(); // keys to look at
    this.waiting = new Map(); // key -> time to look again
    this.needHashes = new Map(); // hash -> Set of keys waiting for that content
    this.wanting = new Set(); // keys we asked peers to upload
    this.conflicts = new Map(); // id -> conflict waiting for the user
    this.busy = new Set(); // keys being worked on right now
    this.active = 0;
    this.transfers = new Map(); // key -> { size, done, peer, direction }
    this.verified = new Set(); // hashes of complete, checked .part files
    this.uploads = new Set();
    this.deleteApproved = new Set();
    this.holdDeletes = 0;
    this.recentDeletes = [];
    this.diskFull = false;
    this.paused = !!opts.paused;
    this.running = false;
    this.timers = [];
    this.waitTimer = null;
    this.statusTimer = null;
  }

  // ---------- lifecycle ----------

  async start() {
    if (!fs.existsSync(this.root) && this.opts.createRoot) fs.mkdirSync(this.root, { recursive: true });
    this.index.load();
    this.activity.load();
    this._loadState();
    this.index.provide('needs', () => this._serializeNeeds());
    this.index.provide('conflicts', () => [...this.conflicts.values()]);

    this.watcher = new Watcher({
      root: this.root,
      index: this.index,
      isBusy: (key) => this.busy.has(key),
      onLocal: (rec, prev) => this._onLocal(rec, prev),
      markerOk: () => this._markerOk(),
      stableMs: this.stableMs,
      scanInterval: this.opts.scanInterval,
      log: this.log,
    });
    this.watcher.on('unavailable', () => this._changed());
    this.watcher.on('available', () => {
      this._prepareMeta();
      this._changed();
      this._kick();
    });
    this.watcher.on('locked', () => this._changed());

    this.engine = new SyncEngine({
      index: this.index,
      handler: this,
      deviceName: this.deviceName,
      code: this.opts.code,
      port: this.opts.port,
      discoveryPort: this.opts.discoveryPort,
      manualPeers: this.opts.manualPeers,
      knownPeers: this.opts.knownPeers,
      platform: this.platform,
      log: this.log,
    });
    this.engine.on('peers', () => {
      this._changed();
      this._kick();
      this.emit('peers', this.engine.getPeers(), this.engine.getForeign());
    });

    this.running = true;
    if (fs.existsSync(this.root)) this._prepareMeta();
    this._housekeeping();
    this.timers.push(setInterval(() => this._housekeeping(), HOUSEKEEPING));
    await this.watcher.start();
    if (!this.paused) await this.engine.start();
    for (const key of this.needs.keys()) this.ready.add(key);
    this._kick();
    this._changed();
  }

  stop() {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    clearTimeout(this.waitTimer);
    clearTimeout(this.statusTimer);
    if (this.watcher) this.watcher.stop();
    if (this.engine) this.engine.stop();
    this.index.flush();
  }

  // ---------- settings ----------

  async setPaused(paused) {
    if (paused === this.paused) return;
    this.paused = paused;
    if (paused) this.engine.stop();
    else {
      await this.engine.start();
      this._kick();
    }
    this._changed();
  }

  setConflictMode(mode) {
    this.index.setShared('conflictMode', mode);
    this._changed();
  }

  getConflictMode() {
    return this.index.getShared('conflictMode');
  }

  setDeviceName(name) {
    this.deviceName = name;
    this.index.setDeviceName(name);
    this.engine.setDeviceName(name);
  }

  setCode(code) {
    this.engine.setCode(code);
  }

  setManualPeers(list) {
    this.engine.setManualPeers(list);
  }

  // ---------- queries ----------

  getStatus() {
    const peers = this.engine ? this.engine.getPeers() : [];
    const online = peers.filter((p) => p.online);
    let pending = 0;
    let bytesLeft = 0;
    for (const list of this.needs.values()) {
      const c = list[0];
      if (!c || c.blocked) continue;
      pending++;
      if (!c.rec.deleted && c.rec.type === 'file') bytesLeft += c.rec.size;
    }
    const transfers = [];
    for (const [key, t] of this.transfers) {
      if (t.direction === 'down') bytesLeft -= t.done;
      transfers.push({ path: key, ...t });
    }
    const available = !this.watcher || this.watcher.available;
    let state = 'up-to-date';
    if (!available) state = 'unavailable';
    else if (this.paused) state = 'paused';
    else if (this.holdDeletes) state = 'confirm-delete';
    else if (pending && online.length) state = 'syncing';
    else if (this.conflicts.size) state = 'conflicts';
    else if (!online.length) state = 'alone';
    return {
      state,
      folder: this.root,
      files: this.index.liveCount(),
      pending,
      bytesLeft: Math.max(0, bytesLeft),
      conflicts: this.conflicts.size,
      holdDeletes: this.holdDeletes,
      conflictMode: this.getConflictMode(),
      peers,
      foreign: this.engine ? this.engine.getForeign() : [],
      transfers,
      problems: this.getProblems(),
    };
  }

  getProblems() {
    const out = [];
    for (const [key, list] of this.needs) {
      const c = list[0];
      if (c && c.blocked === 'windows-name') out.push({ type: 'windows-name', side: 'remote', path: key, device: c.rec.byName });
      else if (c && c.blocked === 'case') out.push({ type: 'case', path: key, twin: c.twin });
    }
    // Names this computer has that a Windows peer can't use.
    const peers = this.engine ? this.engine.getPeers() : [];
    if (this.platform !== 'win32' && peers.some((p) => p.platform === 'win32')) {
      for (const rec of this.index.all()) {
        if (!rec.deleted && names.windowsNameProblem(rec.path)) out.push({ type: 'windows-name', side: 'local', path: rec.path });
      }
    }
    if (this.watcher) for (const key of this.watcher.locked) out.push({ type: 'locked', path: key });
    if (this.diskFull) out.push({ type: 'disk-full' });
    return out;
  }

  getActivity(opts) {
    return this.activity.query(opts);
  }

  getConflicts() {
    return [...this.conflicts.values()].map((c) => ({
      id: c.id,
      path: c.path,
      at: c.at,
      remote: { device: c.remote.byName, size: c.remote.size, mtime: c.remote.mtime },
      local: (() => {
        const r = this.index.get(c.path);
        return r && !r.deleted ? { device: this.deviceName, size: r.size, mtime: r.mtime } : null;
      })(),
    }));
  }

  getTrash() {
    return this.trash.list();
  }

  // ---------- user actions ----------

  // The many deletions that were held: go ahead.
  approveDeletes() {
    for (const [key, list] of this.needs) {
      if (this._isDeletion(key, list[0])) {
        this.deleteApproved.add(key);
        this.ready.add(key);
      }
    }
    this.holdDeletes = 0;
    this._kick();
    this._changed();
  }

  // The many deletions that were held: don't, and bring the files back on the
  // other computers too (a change wins over a deletion).
  keepFiles() {
    for (const [key, list] of [...this.needs]) {
      const c = list[0];
      if (!this._isDeletion(key, c)) continue;
      const local = this.index.get(key);
      this._finish(key, c);
      this.index.localChange(fileFields(local), { vv: mergeVV(local.vv, c.rec.vv) });
    }
    this.holdDeletes = 0;
    this.index.touchState();
    this._changed();
  }

  async resolveConflict(id, choice) {
    const conf = this.conflicts.get(id);
    if (!conf) throw new Error('no such conflict');
    if (!['local', 'remote', 'both'].includes(choice)) throw new Error('bad choice');
    const key = conf.path;
    if (this.busy.has(key)) throw new Error('busy');
    this.busy.add(key);
    try {
      const local = this.index.get(key);
      if ((await this._diskState(key, local)) !== 'ok') throw new Error('the file is being changed, try again in a moment');
      const held = path.join(this.conflictDir, id, 'file');
      const merged = mergeVV(local ? local.vv : {}, conf.remote.vv);
      const live = local && !local.deleted && local.type === 'file';
      const keepLocal = () => {
        if (live) this.index.localChange(fileFields(local), { vv: merged });
        else this.index.localChange({ type: 'file', path: key, deleted: true }, { vv: merged });
      };
      if (choice === 'local') {
        this.trash.put(held, { path: key, reason: 'conflict', byName: conf.remote.byName });
        keepLocal();
      } else if (choice === 'remote') {
        const abs = this._pathOrNull(key) || names.keyToPath(this.root, key, this.platform);
        if (live) this.trash.put(abs, { path: key, reason: 'conflict', byName: this.deviceName });
        const st = this._moveInto(held, abs, conf.remote.mtime);
        this.index.localChange(fileFields(conf.remote, st.mtimeMs), { vv: merged });
      } else {
        this._placeCopy(names.conflictKey(key, conf.remote.byName, conf.remote.mtime), held, conf.remote);
        keepLocal();
      }
      fs.rmSync(path.join(this.conflictDir, id), { recursive: true, force: true });
      this.conflicts.delete(id);
      this.activity.add({ path: key, action: 'conflict', device: this.deviceName, local: true, resolved: choice });
    } finally {
      this.busy.delete(key);
      this.index.touchState();
      this._changed();
      this._kick();
    }
  }

  async restoreFromTrash(id) {
    const item = this.trash.list().find((i) => i.id === id);
    if (!item || !names.isSafeKey(item.path)) throw new Error('not in the trash');
    let key = item.path;
    for (let n = 1; this._exists(key); n++) key = this._variantKey(item.path, n === 1 ? 'restored' : `restored ${n}`);
    this.trash.takeOut(id, names.keyToPath(this.root, key, this.platform));
    this.activity.add({ path: key, action: 'restored', device: this.deviceName, local: true, size: item.size });
    await this.watcher.scanNow(key);
    this._changed();
    return key;
  }

  // ---------- engine handler ----------

  receive(records, peer) {
    let queued = false;
    for (const w of records) {
      const rec = sanitizeRecord(w);
      if (!rec) continue;
      if (rec.type === 'setting') {
        if (this.index.applyRemoteSetting(rec)) this._changed();
        continue;
      }
      if (this._queue(rec, peer.replica)) queued = true;
    }
    if (!queued) return;
    this._updateDeleteHold();
    this.index.touchState();
    this._kick();
    this._changed();
  }

  wantsFor(replica) {
    const out = [];
    for (const key of this.wanting) {
      const c = (this.needs.get(key) || [])[0];
      if (!c || c.mode !== 'want' || c.from !== replica || this.busy.has(key)) continue;
      out.push({ hash: c.rec.hash, path: key, offset: partSize(this._partPath(c.rec.hash)) });
      if (out.length >= MAX_WANTS) break;
    }
    return out;
  }

  // A file we can send: still exactly what the index says it is.
  openForServe(hash, key) {
    if (!HASH_RE.test(hash)) return null;
    const keys = names.isSafeKey(key) ? [key, ...this.index.keysWithHash(hash)] : this.index.keysWithHash(hash);
    for (const k of keys) {
      const r = this.index.get(k);
      if (!r || r.deleted || r.type !== 'file' || r.hash !== hash) continue;
      const abs = this._pathOrNull(k);
      if (!abs) continue;
      try {
        const st = fs.statSync(abs);
        if (st.isFile() && st.size === r.size && st.mtimeMs === r.lmt) return { abs, size: st.size, mtime: r.mtime };
      } catch {}
    }
    return null;
  }

  acceptUpload(header, peer) {
    const key = header.path;
    if (!names.isSafeKey(key)) throw new Error('bad path');
    const c = (this.needs.get(key) || [])[0];
    if (!c || c.rec.deleted || c.rec.type !== 'file' || c.rec.hash !== header.hash || c.rec.size !== header.size) throw new Error('not needed');
    if (this.busy.has(key)) throw new Error('busy');
    this.busy.add(key);
    fs.mkdirSync(this.tmpDir, { recursive: true });
    const t = { size: header.size, done: header.offset, peer: peer.name, direction: 'down' };
    this.transfers.set(key, t);
    const release = () => {
      this.busy.delete(key);
      this.transfers.delete(key);
      this.ready.add(key);
      this._kick();
      this._changed();
    };
    return {
      partPath: this._partPath(header.hash),
      onProgress: (n, got) => {
        t.done = got;
        this._changed();
      },
      finish: async () => {
        this.verified.add(header.hash);
        c.retryAt = 0;
        release();
      },
      fail: (err) => {
        this.log(`upload of ${key} from ${peer.name} failed: ${err.message}`);
        release();
      },
    };
  }

  onWants(wants, peer) {
    for (const w of wants.slice(0, MAX_WANTS)) {
      if (!w || !HASH_RE.test(w.hash) || !names.isSafeKey(w.path) || !Number.isSafeInteger(w.offset) || w.offset < 0) continue;
      const id = `${peer.id}:${w.hash}`;
      if (this.uploads.has(id) || this.uploads.size >= MAX_UPLOADS) continue;
      const src = this.openForServe(w.hash, w.path);
      if (!src || w.offset > src.size) continue;
      this.uploads.add(id);
      this.engine
        .uploadFile(peer, { ...src, hash: w.hash, path: w.path, offset: w.offset })
        .catch((err) => this.log(`upload of ${w.path} to ${peer.name} failed: ${err.message}`))
        .finally(() => {
          this.uploads.delete(id);
          this._changed();
        });
    }
  }

  // ---------- local changes ----------

  _onLocal(rec, prev) {
    if (rec.type === 'file') {
      const action = rec.deleted ? 'deleted' : prev && !prev.deleted && prev.type === 'file' ? 'changed' : 'added';
      this.activity.add({ path: rec.path, action, device: this.deviceName, local: true, size: rec.size });
    }
    this._changed();
  }

  // ---------- the queue ----------

  _queue(rec, from) {
    const local = this.index.get(rec.path);
    const cmp = compareVV(rec.vv, local ? local.vv : {});
    if (cmp === 'equal' || cmp === 'less') return false;
    const list = this.needs.get(rec.path) || [];
    for (const c of list) {
      const k = compareVV(rec.vv, c.rec.vv);
      if (k === 'less' || k === 'equal') return false;
    }
    const kept = [];
    for (const c of list) {
      if (compareVV(rec.vv, c.rec.vv) === 'greater') this._unlinkCandidate(rec.path, c);
      else kept.push(c);
    }
    const cand = { rec, from, mode: 'fetch', retryAt: 0 };
    kept.push(cand);
    this.needs.set(rec.path, kept);
    if (!rec.deleted && rec.type === 'file') {
      let set = this.needHashes.get(rec.hash);
      if (!set) this.needHashes.set(rec.hash, (set = new Set()));
      set.add(rec.path);
    }
    this.ready.add(rec.path);
    return true;
  }

  _unlinkCandidate(key, c) {
    if (!c.rec.deleted && c.rec.type === 'file') {
      const set = this.needHashes.get(c.rec.hash);
      if (set) {
        set.delete(key);
        if (!set.size) this.needHashes.delete(c.rec.hash);
      }
    }
    this.deleteApproved.delete(key);
  }

  // This candidate is done (applied, or no longer needed).
  _finish(key, c) {
    const list = this.needs.get(key) || [];
    const i = list.indexOf(c);
    if (i >= 0) {
      list.splice(i, 1);
      this._unlinkCandidate(key, c);
    }
    if (!list.length) {
      this.needs.delete(key);
      this.wanting.delete(key);
    } else {
      this.ready.add(key);
    }
    this._clearResolvedConflicts(key);
    this.index.touchState();
  }

  _kick() {
    if (!this.running || this.paused || !this.watcher || !this.watcher.available) return;
    const now = Date.now();
    for (const key of this.ready) {
      if (this.active >= PARALLEL) break;
      this.ready.delete(key);
      if (this.busy.has(key)) continue; // looked at again when it's free
      const c = (this.needs.get(key) || [])[0];
      if (!c) {
        this.needs.delete(key);
        continue;
      }
      if (c.blocked === 'windows-name') continue;
      if (c.retryAt > now) {
        this._wait(key, c.retryAt);
        continue;
      }
      if (this.holdDeletes && this._isDeletion(key, c) && !this.deleteApproved.has(key)) continue;
      // The two halves of a rename are done together, by whichever starts first.
      const partner = this._renamePartner(key, c);
      if (partner && this.busy.has(partner)) {
        this._wait(key, now + 200);
        continue;
      }
      this._run(key);
    }
  }

  _run(key) {
    this.active++;
    this.busy.add(key);
    this._process(key)
      .catch((err) => {
        const c = (this.needs.get(key) || [])[0];
        if (!c) return;
        c.tries = (c.tries || 0) + 1;
        const delay = isLocked(err) ? 5000 : codeOf(err) === 'ENOSPC' ? 60000 : Math.min(60000, 2000 * c.tries);
        c.retryAt = Date.now() + delay;
        this.log(`${key}: ${err.message} (retrying in ${Math.round(delay / 1000)} s)`);
      })
      .finally(() => {
        this.active--;
        this.busy.delete(key);
        if (this.needs.has(key)) this.ready.add(key);
        // A file we now want uploaded: tell the peer straight away.
        if (this.wanting.has(key) && this.engine) this.engine.wakeWants();
        this.index.touchState();
        this._changed();
        setImmediate(() => this._kick());
      });
  }

  _wait(key, at) {
    this.waiting.set(key, at);
    this._armWait();
  }

  _armWait() {
    clearTimeout(this.waitTimer);
    if (!this.waiting.size || !this.running) return;
    let next = Infinity;
    for (const t of this.waiting.values()) if (t < next) next = t;
    this.waitTimer = setTimeout(() => {
      const now = Date.now();
      for (const [k, t] of this.waiting) {
        if (t <= now) {
          this.waiting.delete(k);
          this.ready.add(k);
        }
      }
      this._armWait();
      this._kick();
    }, Math.max(0, next - Date.now()) + 5);
  }

  // Look at this need again in `ms`; with a key, have the watcher check it first.
  _later(c, key, ms) {
    c.retryAt = Date.now() + ms;
    if (key !== null && key !== undefined) this.watcher.request(key);
  }

  // ---------- mass-delete guard ----------

  _isDeletion(key, c) {
    if (!c || !c.rec.deleted || c.rec.type !== 'file') return false;
    const local = this.index.get(key);
    return !!(local && !local.deleted && local.type === 'file');
  }

  _updateDeleteHold() {
    let count = 0;
    for (const [key, list] of this.needs) if (this._isDeletion(key, list[0]) && !this.deleteApproved.has(key)) count++;
    const now = Date.now();
    this.recentDeletes = this.recentDeletes.filter((t) => now - t < RECENT_DELETE_WINDOW);
    const total = count + this.recentDeletes.length;
    const live = this.index.liveCount();
    const tooMany = total > MASS_DELETE_FILES || (total >= MASS_DELETE_MIN && total > live * MASS_DELETE_SHARE);
    const hold = count && tooMany ? count : 0;
    if (hold !== this.holdDeletes) {
      this.holdDeletes = hold;
      if (hold) this.emit('confirm-delete', hold);
    }
  }

  // ---------- applying one need ----------

  async _process(key) {
    const c = (this.needs.get(key) || [])[0];
    if (!c) return;
    const remote = c.rec;
    let local = this.index.get(key);

    if (!remote.deleted) {
      if (this.platform === 'win32' && names.windowsNameProblem(key)) {
        c.blocked = 'windows-name';
        this._changed();
        return;
      }
      const twin = this.index.caseTwin(key);
      if (twin) {
        // "report.txt" became "Report.txt" on the other computer
        const tc = (this.needs.get(twin) || [])[0];
        const tl = this.index.get(twin);
        const renamed = tc && tc.rec.deleted && tl && !tl.deleted && tl.type === 'file' && remote.type === 'file' && tl.hash === remote.hash;
        if (renamed && compareVV(tc.rec.vv, tl.vv) === 'greater' && !this.busy.has(twin)) {
          if (await this._move(twin, tc, key, c)) return;
        }
        c.blocked = 'case';
        c.twin = twin;
        this._later(c, null, 3000);
        return;
      }
    }

    // The index must describe the disk right now, or we'd overwrite a change
    // it hasn't seen yet.
    const disk = await this._diskState(key, local);
    if (disk === 'twin') {
      c.blocked = 'case';
      this._later(c, '', 3000);
      return;
    }
    if (disk !== 'ok') return this._later(c, key, this.stableMs + 300);
    delete c.blocked;
    local = this.index.get(key);

    const cmp = compareVV(remote.vv, local ? local.vv : {});
    if (cmp === 'equal' || cmp === 'less') return this._finish(key, c);
    if (cmp === 'greater') return this._applyNewer(key, c, local);
    return this._applyConcurrent(key, c, local);
  }

  // The other computer's version includes ours: take it.
  async _applyNewer(key, c, local) {
    const remote = c.rec;
    const live = local && !local.deleted;
    const abs = this._pathOrNull(key);

    if (remote.deleted) {
      if (live && local.type === 'dir') {
        if (this._hasNeedsInside(key)) return this._later(c, null, 1000);
        try {
          fs.rmdirSync(abs);
        } catch (err) {
          if (codeOf(err) !== 'ENOENT') {
            // Something in there the other computer doesn't know about: keep the folder.
            this.index.localChange({ type: 'dir', path: key }, { vv: mergeVV(local.vv, remote.vv) });
            return this._finish(key, c);
          }
        }
      } else if (live && local.type === 'file') {
        const target = this._renameTarget(key, local);
        if (target && (await this._move(key, c, target.key, target.c))) return;
        this.trash.put(abs, { path: key, reason: 'deleted', byName: remote.byName });
        this.recentDeletes.push(Date.now());
        this.activity.add({ path: key, action: 'deleted', device: remote.byName, local: false, size: local.size });
      }
      this.index.adopt(remote, undefined, undefined, c.from);
      return this._finish(key, c);
    }

    if (remote.type === 'dir') {
      if (live && local.type === 'file') this.trash.put(abs, { path: key, reason: 'replaced', byName: remote.byName });
      fs.mkdirSync(names.keyToPath(this.root, key, this.platform), { recursive: true });
      this.index.adopt(remote, undefined, undefined, c.from);
      return this._finish(key, c);
    }

    if (live && local.type === 'file' && local.hash === remote.hash) {
      this.index.adopt(remote, local.lmt, undefined, c.from);
      return this._finish(key, c);
    }
    if (!live) {
      const source = this._renameSource(key, remote);
      if (source && (await this._move(source.key, source.c, key, c))) return;
    }
    const part = await this._obtain(key, c);
    if (!part) return;
    if (await this._place(key, c, part, local, null)) this._finish(key, c);
  }

  // Both sides changed this path on their own.
  async _applyConcurrent(key, c, local) {
    const remote = c.rec;
    const merged = mergeVV(local.vv, remote.vv);
    const live = !local.deleted;

    if (sameContent(remote, local)) {
      this.index.adopt(local, local.lmt, merged);
      return this._finish(key, c);
    }
    if (remote.deleted) {
      // Changed here, deleted there: the change wins.
      this.index.adopt(local, local.lmt, merged);
      return this._finish(key, c);
    }
    if (!live) {
      // Deleted here, changed there: the change wins.
      if (remote.type === 'dir') {
        fs.mkdirSync(names.keyToPath(this.root, key, this.platform), { recursive: true });
        this.index.adopt(remote, undefined, merged);
        return this._finish(key, c);
      }
      const part = await this._obtain(key, c);
      if (part && (await this._place(key, c, part, local, merged))) this._finish(key, c);
      return;
    }

    if (local.type !== remote.type) {
      // A file on one side, a folder on the other: keep both, the file moves
      // to a conflict name.
      const fileRec = local.type === 'file' ? local : remote;
      const copyKey = names.conflictKey(key, fileRec.byName, fileRec.mtime);
      if (local.type === 'file') {
        this._moveAside(key, copyKey, local);
        fs.mkdirSync(names.keyToPath(this.root, key, this.platform), { recursive: true });
        this.index.adopt(remote, undefined, merged);
      } else {
        const part = await this._obtain(key, c);
        if (!part) return;
        this._placeCopy(copyKey, part, remote);
        this.index.adopt(local, undefined, merged);
      }
      this.activity.add({ path: copyKey, action: 'conflict', device: fileRec.byName, local: fileRec === local });
      return this._finish(key, c);
    }

    // Two different versions of a file.
    const mode = this.index.getShared('conflictMode');
    if (mode === 'ask') return this._holdConflict(key, c, local);
    const remoteWins = remote.mtime > local.mtime || (remote.mtime === local.mtime && remote.by > local.by);
    const loser = remoteWins ? local : remote;
    const copyKey = names.conflictKey(key, loser.byName, loser.mtime);
    if (remoteWins) {
      const part = await this._obtain(key, c);
      if (!part) return;
      const opts = mode === 'both' ? { aside: copyKey } : { reason: 'conflict' };
      if (!(await this._place(key, c, part, local, merged, opts))) return;
    } else {
      if (mode === 'both') {
        const part = await this._obtain(key, c);
        if (!part) return;
        this._placeCopy(copyKey, part, remote);
      }
      this.index.adopt(local, local.lmt, merged);
    }
    this.activity.add({ path: key, action: 'conflict', device: remote.byName, local: false, kept: mode === 'both' ? 'both' : remoteWins ? 'remote' : 'local' });
    this._finish(key, c);
  }

  // "Ask every time": keep the other version safe until the user decides.
  async _holdConflict(key, c, local) {
    for (const conf of this.conflicts.values()) {
      if (conf.path !== key) continue;
      const k = compareVV(conf.remote.vv, c.rec.vv);
      if (k === 'equal' || k === 'greater') return this._finish(key, c);
    }
    const part = await this._obtain(key, c);
    if (!part) return;
    const id = crypto.randomUUID();
    const dir = path.join(this.conflictDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(part, path.join(dir, 'file'));
    this.verified.delete(c.rec.hash);
    // A newer version of the same conflict replaces the older one.
    for (const old of [...this.conflicts.values()]) {
      if (old.path === key) {
        fs.rmSync(path.join(this.conflictDir, old.id), { recursive: true, force: true });
        this.conflicts.delete(old.id);
      }
    }
    const conf = { id, path: key, at: Date.now(), from: c.from, remote: c.rec };
    this.conflicts.set(id, conf);
    this.activity.add({ path: key, action: 'conflict', device: c.rec.byName, local: false });
    this._finish(key, c);
    this.emit('conflict', { id, path: key, device: c.rec.byName });
  }

  _clearResolvedConflicts(key) {
    for (const conf of [...this.conflicts.values()]) {
      if (conf.path !== key) continue;
      const local = this.index.get(key);
      const k = compareVV(local ? local.vv : {}, conf.remote.vv);
      if (k !== 'greater' && k !== 'equal') continue;
      // Settled on another computer: the held copy goes to the trash.
      const held = path.join(this.conflictDir, conf.id, 'file');
      try {
        this.trash.put(held, { path: key, reason: 'conflict', byName: conf.remote.byName });
      } catch {}
      fs.rmSync(path.join(this.conflictDir, conf.id), { recursive: true, force: true });
      this.conflicts.delete(conf.id);
    }
  }

  // ---------- content ----------

  _partPath(hash) {
    return path.join(this.tmpDir, `${hash}.part`);
  }

  // Gets the remote version's content into a verified .part file. Returns its
  // path, or null when it has to wait (upload asked for, retry later).
  async _obtain(key, c) {
    const remote = c.rec;
    const part = this._partPath(remote.hash);
    fs.mkdirSync(this.tmpDir, { recursive: true });
    if (remote.size === 0 && remote.hash === EMPTY_HASH) {
      fs.writeFileSync(part, '');
      return part;
    }
    if (await this._partReady(part, remote)) return part;

    // The same content may already be in the folder.
    for (const k of this.index.keysWithHash(remote.hash)) {
      if (k !== key && this.busy.has(k)) continue;
      const r = this.index.get(k);
      const src = this._pathOrNull(k);
      if (!r || !src || (await this._diskState(k, r)) !== 'ok') continue;
      try {
        await fs.promises.copyFile(src, part);
        if ((await hashFile(part)) === remote.hash) {
          this.verified.add(remote.hash);
          return part;
        }
      } catch {}
      fs.rmSync(part, { force: true });
    }
    return this._download(key, c, part);
  }

  async _partReady(part, remote) {
    if (partSize(part) !== remote.size) return false;
    if (this.verified.has(remote.hash)) return true;
    try {
      if ((await hashFile(part)) === remote.hash) {
        this.verified.add(remote.hash);
        return true;
      }
    } catch {}
    fs.rmSync(part, { force: true });
    return false;
  }

  async _download(key, c, part) {
    const remote = c.rec;
    await this._checkSpace(remote.size - partSize(part));
    const source = this.engine.peerByReplica(c.from);
    const peers = [source, ...[...this.engine.peers.values()].filter((p) => p !== source)].filter((p) => p && p.online && p.replica);
    for (const p of peers) {
      if (p.reachable === false) continue;
      const t = { size: remote.size, done: partSize(part), peer: p.name, direction: 'down' };
      this.transfers.set(key, t);
      try {
        await this.engine.fetchFile(p, {
          hash: remote.hash,
          path: key,
          partPath: part,
          onProgress: (n, got) => {
            t.done = got;
            this._changed();
          },
        });
        this.verified.add(remote.hash);
        this.wanting.delete(key);
        return part;
      } catch (err) {
        this.log(`download of ${key} from ${p.name} failed: ${err.message}`);
        if (err.status === 404) continue;
        if (p.reachable !== false) {
          this._later(c, null, 3000);
          return null;
        }
      } finally {
        this.transfers.delete(key);
      }
    }
    // Nobody we can reach has it: ask the source to upload it instead.
    c.mode = 'want';
    this.wanting.add(key);
    this._later(c, null, WANT_RETRY);
    return null;
  }

  async _checkSpace(bytes) {
    if (!fs.promises.statfs || bytes <= 0) return;
    let st;
    try {
      st = await fs.promises.statfs(this.root);
    } catch {
      return;
    }
    const free = Number(st.bavail) * Number(st.bsize);
    this.diskFull = free < bytes + FREE_SPACE_MARGIN;
    if (this.diskFull) {
      const err = new Error('not enough free disk space');
      err.code = 'ENOSPC';
      throw err;
    }
  }

  // Swaps the downloaded content in at `key`, if the disk still holds exactly
  // the version we compared against. The old file goes to the trash (or, with
  // `aside`, to a conflict name).
  async _place(key, c, part, local, vv, opts = {}) {
    const remote = c.rec;
    if (this.index.get(key) !== local || (await this._diskState(key, local)) !== 'ok') {
      this._later(c, key, this.stableMs + 300);
      return false;
    }
    // The existing name as the disk spells it, so the new version takes its place.
    const abs = this._pathOrNull(key) || names.keyToPath(this.root, key, this.platform);
    const live = local && !local.deleted;
    if (live && local.type === 'file') {
      if (opts.aside) this._moveAside(key, opts.aside, local);
      else this.trash.put(abs, { path: key, reason: opts.reason || 'replaced', byName: remote.byName });
    } else if (live && local.type === 'dir') {
      fs.rmdirSync(abs); // a folder replaced by a file; fails (and retries) if it isn't empty
    }
    const st = this._moveInto(part, abs, remote.mtime);
    this.verified.delete(remote.hash);
    this.index.adopt(remote, st.mtimeMs, vv || undefined, vv ? undefined : c.from);
    this.wanting.delete(key);
    if (!opts.aside && !opts.reason) {
      this.activity.add({ path: key, action: live ? 'changed' : 'added', device: remote.byName, local: false, size: remote.size });
    }
    return true;
  }

  _moveInto(src, abs, mtime) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.renameSync(src, abs);
    try {
      fs.utimesSync(abs, new Date(), mtime / 1000);
    } catch {}
    return fs.statSync(abs);
  }

  // Our file moves to `copyKey` (a conflict name) and is recorded there.
  _moveAside(key, copyKey, local) {
    copyKey = this._freeKey(copyKey);
    const st = this._moveInto(this._pathOrNull(key), names.keyToPath(this.root, copyKey, this.platform), local.mtime);
    this.index.localChange(fileFields({ ...local, path: copyKey }, st.mtimeMs));
  }

  // Puts content (a .part or a held conflict file) at a new conflict name.
  _placeCopy(copyKey, src, rec) {
    const existing = this.index.get(copyKey);
    if (existing && !existing.deleted && existing.hash === rec.hash) {
      fs.rmSync(src, { force: true });
      return copyKey;
    }
    copyKey = this._freeKey(copyKey);
    const st = this._moveInto(src, names.keyToPath(this.root, copyKey, this.platform), rec.mtime);
    this.verified.delete(rec.hash);
    this.index.localChange(fileFields({ ...rec, path: copyKey }, st.mtimeMs));
    this.activity.add({ path: copyKey, action: 'conflict', device: rec.byName, local: false, size: rec.size });
    return copyKey;
  }

  // ---------- renames ----------

  // The other computer deleted `key`; did it reappear under another name?
  _renameTarget(key, local) {
    for (const k of this.needHashes.get(local.hash) || []) {
      if (k === key || this.busy.has(k)) continue;
      const c = (this.needs.get(k) || [])[0];
      if (!c || c.rec.deleted || c.rec.hash !== local.hash) continue;
      const there = this.index.get(k);
      if (there && !there.deleted) continue;
      if (compareVV(c.rec.vv, there ? there.vv : {}) !== 'greater') continue;
      return { key: k, c };
    }
    return null;
  }

  // A new file the other computer has, whose content sits here under a name
  // the other computer deleted: that's a rename.
  _renameSource(key, remote) {
    for (const k of this.index.keysWithHash(remote.hash)) {
      if (k === key || this.busy.has(k)) continue;
      const c = (this.needs.get(k) || [])[0];
      const local = this.index.get(k);
      if (!c || !c.rec.deleted || !local || compareVV(c.rec.vv, local.vv) !== 'greater') continue;
      return { key: k, c };
    }
    return null;
  }

  _renamePartner(key, c) {
    if (c.rec.type !== 'file') return null;
    if (c.rec.deleted) {
      const local = this.index.get(key);
      if (!local || local.deleted || local.type !== 'file') return null;
      for (const k of this.needHashes.get(local.hash) || []) if (k !== key) return k;
      return null;
    }
    for (const k of this.index.keysWithHash(c.rec.hash)) {
      const other = (this.needs.get(k) || [])[0];
      if (k !== key && other && other.rec.deleted) return k;
    }
    return null;
  }

  // Applies a rename as a rename: no trash, no transfer.
  async _move(fromKey, fromC, toKey, toC) {
    const other = this.busy.has(toKey) ? toKey : this.busy.has(fromKey) ? fromKey : null;
    const claim = other === toKey ? fromKey : toKey;
    if (this.busy.has(claim)) return false;
    this.busy.add(claim);
    try {
      const fromLocal = this.index.get(fromKey);
      if (!fromLocal || fromLocal.deleted || (await this._diskState(fromKey, fromLocal)) !== 'ok') return false;
      const caseOnly = names.foldKey(fromKey) === names.foldKey(toKey);
      if (!caseOnly && (await this._diskState(toKey, this.index.get(toKey))) !== 'ok') return false;
      const dst = names.keyToPath(this.root, toKey, this.platform);
      const st = this._moveInto(this._pathOrNull(fromKey), dst, toC.rec.mtime);
      this.watcher.diskPaths.delete(fromKey);
      this.index.adopt(fromC.rec, undefined, undefined, fromC.from);
      this.index.adopt(toC.rec, st.mtimeMs, undefined, toC.from);
      this.activity.add({ path: toKey, from: fromKey, action: 'moved', device: toC.rec.byName, local: false, size: toC.rec.size });
      this._finish(fromKey, fromC);
      this._finish(toKey, toC);
      return true;
    } finally {
      this.busy.delete(claim);
    }
  }

  // ---------- disk ----------

  _pathOrNull(key) {
    const known = this.watcher && this.watcher.diskPaths.get(key);
    if (known) return known;
    try {
      return names.keyToPath(this.root, key, this.platform);
    } catch {
      return null;
    }
  }

  _exists(key) {
    const abs = this._pathOrNull(key);
    return !!abs && fs.existsSync(abs);
  }

  // Is the disk at `key` exactly what the index record says?
  //   'ok'    - yes
  //   'stale' - no: the watcher has to look first
  //   'twin'  - the name exists on disk in another case
  async _diskState(key, rec) {
    const abs = this._pathOrNull(key);
    const live = rec && !rec.deleted;
    if (!abs) return live ? 'stale' : 'ok';
    let st = null;
    try {
      st = await fs.promises.lstat(abs);
    } catch {}
    if (!st) return live ? 'stale' : 'ok';
    if (st.isSymbolicLink()) return 'ok';
    if (!live) {
      const listed = (await fs.promises.readdir(path.dirname(abs)).catch(() => [])).some((n) => n.normalize('NFC') === names.baseName(key));
      return listed ? 'stale' : 'twin';
    }
    if (st.isDirectory()) return rec.type === 'dir' ? 'ok' : 'stale';
    if (!st.isFile()) return 'ok';
    return rec.type === 'file' && rec.size === st.size && rec.lmt === st.mtimeMs ? 'ok' : 'stale';
  }

  _hasNeedsInside(dirKey) {
    for (const [k, list] of this.needs) if (k !== dirKey && names.isInside(k, dirKey) && list.length && !list[0].blocked) return true;
    return false;
  }

  _freeKey(key) {
    if (!this._exists(key)) return key;
    for (let n = 2; n < 100; n++) {
      const k = this._variantKey(key, String(n));
      if (!this._exists(k)) return k;
    }
    return this._variantKey(key, crypto.randomBytes(3).toString('hex'));
  }

  // "a/b.txt" + "2" -> "a/b 2.txt"; + "restored" -> "a/b (restored).txt"
  _variantKey(key, tag) {
    const dir = names.parentKey(key);
    const name = names.baseName(key);
    const dot = name.lastIndexOf('.');
    const hasExt = dot > 0 && dot < name.length - 1;
    const stem = hasExt ? name.slice(0, dot) : name;
    const ext = hasExt ? name.slice(dot) : '';
    const out = /^\d+$/.test(tag) ? `${stem} ${tag}${ext}` : `${stem} (${tag})${ext}`;
    return dir ? `${dir}/${out}` : out;
  }

  // The marker file ties the folder to this index. A folder that is suddenly
  // empty, or belongs to another index, is not ours to sync deletions from.
  _markerOk() {
    let marker = null;
    try {
      marker = JSON.parse(fs.readFileSync(this.markerPath, 'utf8'));
    } catch {}
    if (marker && marker.replicaId === this.index.replicaId) return true;
    if (this.index.hasLive()) {
      if (marker) return false;
      let entries = [];
      try {
        entries = fs.readdirSync(this.root).filter((n) => !names.isIgnored(n));
      } catch {}
      if (!entries.length) return false;
    }
    this._prepareMeta();
    return true;
  }

  _prepareMeta() {
    try {
      const fresh = !fs.existsSync(this.metaDir);
      fs.mkdirSync(this.tmpDir, { recursive: true });
      fs.mkdirSync(this.conflictDir, { recursive: true });
      let marker = null;
      try {
        marker = JSON.parse(fs.readFileSync(this.markerPath, 'utf8'));
      } catch {}
      if (!marker || marker.replicaId !== this.index.replicaId) {
        if (!marker || !this.index.hasLive()) fs.writeFileSync(this.markerPath, JSON.stringify({ app: 'FolderBridge', replicaId: this.index.replicaId }));
      }
      if (fresh && process.platform === 'win32') execFile('attrib', ['+h', this.metaDir], () => {});
    } catch (err) {
      this.log('could not prepare .folderbridge:', err.message);
    }
  }

  _housekeeping() {
    try {
      this.trash.purge();
    } catch {}
    // Leftover partial downloads nobody needs any more.
    let parts = [];
    try {
      parts = fs.readdirSync(this.tmpDir);
    } catch {}
    const now = Date.now();
    for (const f of parts) {
      const hash = f.replace(/\.part$/, '');
      if (this.needHashes.has(hash)) continue;
      try {
        if (now - fs.statSync(path.join(this.tmpDir, f)).mtimeMs > PART_MAX_AGE) fs.rmSync(path.join(this.tmpDir, f), { force: true });
      } catch {}
    }
  }

  // ---------- persistence ----------

  _serializeNeeds() {
    const out = [];
    for (const list of this.needs.values()) for (const c of list) out.push({ rec: c.rec, from: c.from });
    return out;
  }

  _loadState() {
    for (const n of this.index.getExtra('needs') || []) {
      const rec = n && sanitizeRecord(n.rec);
      if (rec && rec.type !== 'setting' && ID_RE.test(n.from)) this._queue(rec, n.from);
    }
    for (const c of this.index.getExtra('conflicts') || []) {
      const remote = c && sanitizeRecord(c.remote);
      if (!remote || !ID_RE.test(c.id) || !names.isSafeKey(c.path)) continue;
      if (!fs.existsSync(path.join(this.conflictDir, c.id, 'file'))) continue;
      this.conflicts.set(c.id, { id: c.id, path: c.path, at: c.at, from: c.from, remote });
    }
    this.ready.clear();
  }

  _changed() {
    if (this.statusTimer || !this.running) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      this.emit('status', this.getStatus());
    }, 100);
  }
}

module.exports = { FolderSync };
