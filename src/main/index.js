'use strict';
// The file index: what this computer knows about every file in the folder.
//
// Each record describes one path: size, modification time, sha256, a deleted
// flag (a tombstone, so deletions travel too) and a version vector
// {replicaId: counter} listing the edits it contains. Comparing two vectors
// tells whether one version already includes the other, or whether both sides
// changed the file on their own (a conflict).
//
// Whenever a record changes here it gets the next local sequence number. A peer
// only has to remember the highest number it got from us (its "cursor") to ask
// for everything newer, so replication is just "records since N".
//
// The replica id belongs to this index, not to the computer: pointing the app
// at another folder starts a new replica, so its files are compared with the
// others as fresh versions instead of looking like old ones.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { isSafeKey, foldKey } = require('./names');

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_VV_ENTRIES = 256;
const SAVE_DELAY = 1000;

// Settings that belong to the shared folder rather than to one computer.
const SHARED = {
  conflictMode: { values: ['ask', 'both', 'newest'], default: 'ask' },
};

function compareVV(a, b) {
  let greater = false;
  let less = false;
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const x = (a && a[k]) || 0;
    const y = (b && b[k]) || 0;
    if (x > y) greater = true;
    else if (x < y) less = true;
  }
  if (greater && less) return 'concurrent';
  if (greater) return 'greater';
  if (less) return 'less';
  return 'equal';
}

function mergeVV(a, b) {
  const out = { ...(a || {}) };
  for (const [k, n] of Object.entries(b || {})) if (!out[k] || out[k] < n) out[k] = n;
  return out;
}

function sameContent(a, b) {
  if (!a || !b) return false;
  if (a.deleted || b.deleted) return !!a.deleted && !!b.deleted;
  if (a.type !== b.type) return false;
  return a.type === 'dir' || a.hash === b.hash;
}

// Whitelists fields so nothing unexpected from the network reaches disk.
function sanitizeRecord(w) {
  if (!w || typeof w !== 'object') return null;
  if (!ID_RE.test(w.by) || !Number.isFinite(w.ts)) return null;
  const seq = Number.isSafeInteger(w.seq) && w.seq > 0 ? w.seq : 0;
  if (w.type === 'setting') {
    const spec = SHARED[w.name];
    if (!spec || !spec.values.includes(w.value)) return null;
    return { type: 'setting', name: w.name, value: w.value, by: w.by, ts: w.ts, seq };
  }
  if (w.type !== 'file' && w.type !== 'dir') return null;
  if (!isSafeKey(w.path)) return null;
  if (!w.vv || typeof w.vv !== 'object') return null;
  const vv = {};
  const entries = Object.entries(w.vv);
  if (!entries.length || entries.length > MAX_VV_ENTRIES) return null;
  for (const [k, n] of entries) {
    if (!ID_RE.test(k) || !Number.isSafeInteger(n) || n < 1) return null;
    vv[k] = n;
  }
  const rec = {
    type: w.type,
    path: w.path,
    deleted: w.deleted === true,
    vv,
    by: w.by,
    byName: typeof w.byName === 'string' ? w.byName.slice(0, 100) : '',
    ts: w.ts,
    seq,
  };
  if (rec.type === 'file' && !rec.deleted) {
    if (!Number.isSafeInteger(w.size) || w.size < 0) return null;
    if (!Number.isFinite(w.mtime) || !HASH_RE.test(w.hash)) return null;
    rec.size = w.size;
    rec.mtime = w.mtime;
    rec.hash = w.hash;
  }
  return rec;
}

class FileIndex extends EventEmitter {
  constructor({ dir, root, deviceName }) {
    super();
    this.dir = dir;
    this.root = root;
    this.deviceName = deviceName;
    this.logPath = path.join(dir, 'index.jsonl');
    this.statePath = path.join(dir, 'state.json');
    this.deviceId = null;
    this.replicaId = null;
    this.seq = 0;
    this.records = new Map(); // key -> record
    this.settings = new Map(); // shared setting name -> record
    this.bySeq = new Map(); // seq -> record, ascending
    this.hashes = new Map(); // sha256 -> Set of live keys
    this.folds = new Map(); // lower-cased key -> Set of live keys
    this.cursors = {}; // replica -> highest seq received from it
    this.extra = {}; // state kept for the sync layer (pending work, conflicts)
    this.providers = {}; // name -> function giving the current value of an extra at save time
    this._queue = [];
    this._saveTimer = null;
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true });
    this.deviceId = this._loadDeviceId();
    let state = null;
    try {
      state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch {}
    if (!state || state.root !== this.root || !ID_RE.test(state.replicaId)) {
      // A new folder (or a first run): a fresh replica with an empty index.
      this.replicaId = crypto.randomUUID();
      fs.rmSync(this.logPath, { force: true });
      this._writeState();
      return;
    }
    this.replicaId = state.replicaId;
    this.cursors = state.cursors && typeof state.cursors === 'object' ? state.cursors : {};
    this.extra = state.extra && typeof state.extra === 'object' ? state.extra : {};

    let raw = '';
    try {
      raw = fs.readFileSync(this.logPath, 'utf8');
    } catch {}
    let lines = 0;
    let bad = 0;
    const loaded = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      lines++;
      let rec;
      try {
        const obj = JSON.parse(line);
        rec = sanitizeRecord(obj);
        if (rec && Number.isFinite(obj.lmt)) rec.lmt = obj.lmt;
        if (rec && ID_RE.test(obj.src)) rec.src = obj.src;
      } catch {
        rec = null;
      }
      if (!rec || !rec.seq) {
        bad++;
        continue;
      }
      loaded.push(rec);
    }
    // Later lines win; the log is in write order, which is also seq order.
    for (const rec of loaded) {
      if (rec.type === 'setting') this.settings.set(rec.name, rec);
      else this.records.set(rec.path, rec);
      this.seq = Math.max(this.seq, rec.seq);
    }
    const all = [...this.records.values(), ...this.settings.values()].sort((a, b) => a.seq - b.seq);
    for (const rec of all) {
      this.bySeq.set(rec.seq, rec);
      this._indexHash(rec, true);
    }
    if (bad || lines > all.length * 2 + 100) this.compact();
  }

  // ---------- reading ----------

  get(key) {
    return this.records.get(key) || null;
  }

  all() {
    return this.records.values();
  }

  liveFiles() {
    return [...this.records.values()].filter((r) => r.type === 'file' && !r.deleted);
  }

  hasLive() {
    for (const r of this.records.values()) if (!r.deleted) return true;
    return false;
  }

  liveCount() {
    let n = 0;
    for (const r of this.records.values()) if (r.type === 'file' && !r.deleted) n++;
    return n;
  }

  // Keys of live local files with this content.
  keysWithHash(hash) {
    return [...(this.hashes.get(hash) || [])];
  }

  // A live key that differs from `key` only in case (same file on disk).
  caseTwin(key) {
    for (const k of this.folds.get(foldKey(key)) || []) if (k !== key) return k;
    return null;
  }

  getShared(name) {
    const rec = this.settings.get(name);
    return rec ? rec.value : SHARED[name].default;
  }

  // ---------- changes ----------

  // A change made on this computer: the version vector moves forward.
  localChange(fields, base) {
    const prev = this.records.get(fields.path);
    const rec = {
      type: fields.type,
      path: fields.path,
      deleted: !!fields.deleted,
      vv: { ...((base && base.vv) || (prev && prev.vv) || {}) },
      by: this.replicaId,
      byName: this.deviceName,
      ts: Date.now(),
    };
    rec.vv[this.replicaId] = (rec.vv[this.replicaId] || 0) + 1;
    if (rec.type === 'file' && !rec.deleted) {
      rec.size = fields.size;
      rec.mtime = fields.mtime;
      rec.hash = fields.hash;
      if (Number.isFinite(fields.lmt)) rec.lmt = fields.lmt;
    }
    return this._put(rec);
  }

  // A version that came from another computer, now applied here as is (or a
  // merge of two versions with the same content). `src` is the replica it came
  // from, which already has it, so it isn't sent back there.
  adopt(remote, lmt, vv, src) {
    const rec = { ...remote, vv: { ...(vv || remote.vv) } };
    delete rec.seq;
    delete rec.lmt;
    delete rec.src;
    if (rec.type === 'file' && !rec.deleted && Number.isFinite(lmt)) rec.lmt = lmt;
    if (!vv && src) rec.src = src;
    return this._put(rec);
  }

  // The file on disk was touched but its content is the same.
  touchLocal(key, lmt) {
    const rec = this.records.get(key);
    if (!rec || rec.lmt === lmt) return;
    rec.lmt = lmt;
    this._queue.push(JSON.stringify(rec));
    this._commit(false);
  }

  setShared(name, value) {
    const spec = SHARED[name];
    if (!spec || !spec.values.includes(value)) throw new Error(`bad value for ${name}`);
    const prev = this.settings.get(name);
    const ts = Math.max(Date.now(), prev ? prev.ts + 1 : 0);
    return this._put({ type: 'setting', name, value, by: this.replicaId, ts });
  }

  // Shared settings: the latest change wins (ties broken by replica id).
  applyRemoteSetting(remote) {
    const cur = this.settings.get(remote.name);
    if (cur && (cur.ts > remote.ts || (cur.ts === remote.ts && cur.by >= remote.by))) return false;
    const rec = { ...remote };
    delete rec.seq;
    this._put(rec);
    return true;
  }

  // ---------- replication ----------

  get maxSeq() {
    return this.seq;
  }

  // Records changed here after `since`, in order. Records that came from the
  // `exclude` replica are skipped (it has them) but still move `last` on.
  recordsSince(since, max, exclude) {
    const after = Number.isSafeInteger(since) && since > 0 ? since : 0;
    const records = [];
    let last = after;
    for (const [seq, rec] of this.bySeq) {
      if (seq <= after) continue;
      if (exclude && rec.src === exclude) {
        last = seq;
        continue;
      }
      if (records.length >= max) return { records, last, more: true };
      records.push(this.toWire(rec));
      last = seq;
    }
    return { records, last, more: false };
  }

  toWire(rec) {
    const wire = { ...rec };
    delete wire.lmt;
    delete wire.src;
    return wire;
  }

  cursor(replica) {
    return this.cursors[replica] || 0;
  }

  setCursor(replica, seq) {
    if (!ID_RE.test(replica) || !Number.isSafeInteger(seq) || seq <= this.cursor(replica)) return;
    this.cursors[replica] = seq;
    this._scheduleSave();
  }

  setExtra(name, value) {
    this.extra[name] = value;
    this._scheduleSave();
  }

  // Lets the sync layer hand over state that's only serialized when saved.
  provide(name, fn) {
    this.providers[name] = fn;
  }

  touchState() {
    this._scheduleSave();
  }

  getExtra(name) {
    return this.extra[name];
  }

  setDeviceName(name) {
    this.deviceName = name;
  }

  // ---------- persistence ----------

  compact() {
    const lines = [...this.bySeq.values()].map((r) => JSON.stringify(r));
    const body = lines.length ? lines.join('\n') + '\n' : '';
    writeAtomic(this.logPath, body);
  }

  flush() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    this._writeState();
  }

  _put(rec) {
    const prev = rec.type === 'setting' ? this.settings.get(rec.name) : this.records.get(rec.path);
    if (prev) {
      this.bySeq.delete(prev.seq);
      this._indexHash(prev, false);
    }
    rec.seq = ++this.seq;
    if (rec.type === 'setting') this.settings.set(rec.name, rec);
    else this.records.set(rec.path, rec);
    this.bySeq.set(rec.seq, rec);
    this._indexHash(rec, true);
    this._queue.push(JSON.stringify(rec));
    this._commit(true);
    return rec;
  }

  _indexHash(rec, add) {
    if (rec.type === 'setting' || rec.deleted) return;
    const fold = foldKey(rec.path);
    let twins = this.folds.get(fold);
    if (add) {
      if (!twins) this.folds.set(fold, (twins = new Set()));
      twins.add(rec.path);
    } else if (twins) {
      twins.delete(rec.path);
      if (!twins.size) this.folds.delete(fold);
    }
    if (rec.type !== 'file' || !rec.hash) return;
    let set = this.hashes.get(rec.hash);
    if (add) {
      if (!set) this.hashes.set(rec.hash, (set = new Set()));
      set.add(rec.path);
    } else if (set) {
      set.delete(rec.path);
      if (!set.size) this.hashes.delete(rec.hash);
    }
  }

  _commit(changed) {
    if (this._queue.length) {
      fs.appendFileSync(this.logPath, this._queue.join('\n') + '\n');
      this._queue = [];
    }
    this._scheduleSave();
    if (changed) this.emit('changed');
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._writeState();
    }, SAVE_DELAY);
    if (this._saveTimer.unref) this._saveTimer.unref();
  }

  _writeState() {
    const extra = { ...this.extra };
    for (const [name, fn] of Object.entries(this.providers)) extra[name] = fn();
    const state = { root: this.root, replicaId: this.replicaId, cursors: this.cursors, extra };
    writeAtomic(this.statePath, JSON.stringify(state));
  }

  _loadDeviceId() {
    const file = path.join(this.dir, 'device.json');
    try {
      const id = JSON.parse(fs.readFileSync(file, 'utf8')).deviceId;
      if (ID_RE.test(id)) return id;
    } catch {}
    const id = crypto.randomUUID();
    fs.writeFileSync(file, JSON.stringify({ deviceId: id }));
    return id;
  }
}

function writeAtomic(file, body) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, body);
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, body);
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { FileIndex, compareVV, mergeVV, sameContent, sanitizeRecord, SHARED, ID_RE, HASH_RE };
