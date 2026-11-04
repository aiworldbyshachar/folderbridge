'use strict';
// The FolderBridge trash: nothing is ever lost.
//
// Files deleted or overwritten by sync (and the losing side of a conflict) are
// moved here instead of being removed. Each item is a small folder in
// .folderbridge/trash holding the file and a meta.json saying where it came
// from. Items older than 30 days are cleared automatically.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { META_DIR, baseName } = require('./names');

const KEEP_DAYS = 30;
const ITEM_RE = /^\d{13}-[0-9a-f]{8}$/;

class Trash {
  constructor(root) {
    this.root = root;
    this.dir = path.join(root, META_DIR, 'trash');
  }

  // Moves a file (same volume, so it's a rename) into the trash.
  put(absPath, info) {
    fs.mkdirSync(this.dir, { recursive: true });
    const at = Date.now();
    const id = `${at}-${crypto.randomBytes(4).toString('hex')}`;
    const itemDir = path.join(this.dir, id);
    fs.mkdirSync(itemDir);
    const name = baseName(info.path);
    let size = 0;
    try {
      size = fs.statSync(absPath).size;
    } catch {}
    try {
      fs.renameSync(absPath, path.join(itemDir, name));
    } catch (err) {
      fs.rmSync(itemDir, { recursive: true, force: true });
      throw err;
    }
    const meta = { path: info.path, name, at, size, reason: info.reason || 'deleted', byName: info.byName || '' };
    fs.writeFileSync(path.join(itemDir, 'meta.json'), JSON.stringify(meta));
    return { id, ...meta };
  }

  list() {
    let ids = [];
    try {
      ids = fs.readdirSync(this.dir).filter((d) => ITEM_RE.test(d));
    } catch {}
    const items = [];
    for (const id of ids) {
      const meta = this._meta(id);
      if (meta) items.push({ id, ...meta });
    }
    return items.sort((a, b) => b.at - a.at);
  }

  // Path of the trashed file itself (used to restore content without a transfer).
  filePath(id) {
    const meta = ITEM_RE.test(id) && this._meta(id);
    return meta ? path.join(this.dir, id, meta.name) : null;
  }

  // Takes the file out of the trash and moves it to `targetAbs`.
  takeOut(id, targetAbs) {
    const file = this.filePath(id);
    if (!file) throw new Error('not in the trash');
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    fs.renameSync(file, targetAbs);
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
  }

  remove(id) {
    if (!ITEM_RE.test(id)) return;
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
  }

  purge(days = KEEP_DAYS) {
    const before = Date.now() - days * 24 * 3600 * 1000;
    let removed = 0;
    for (const item of this.list()) {
      if (item.at < before) {
        this.remove(item.id);
        removed++;
      }
    }
    return removed;
  }

  _meta(id) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(this.dir, id, 'meta.json'), 'utf8'));
      if (typeof m.path === 'string' && typeof m.name === 'string' && Number.isFinite(m.at)) return m;
    } catch {}
    return null;
  }
}

module.exports = { Trash, KEEP_DAYS };
