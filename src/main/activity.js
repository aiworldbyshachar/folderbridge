'use strict';
// Recent activity: which file changed, how, on which computer, and when.
// Local to this computer (not replicated); the newest 1000 entries are kept.
const fs = require('fs');
const path = require('path');

const KEEP = 1000;
const ACTIONS = new Set(['added', 'changed', 'deleted', 'moved', 'conflict', 'restored']);

class Activity {
  constructor(dir) {
    this.file = path.join(dir, 'activity.jsonl');
    this.items = [];
    this.lines = 0;
  }

  load() {
    let raw = '';
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch {}
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      this.lines++;
      try {
        const e = JSON.parse(line);
        if (e && typeof e.path === 'string' && ACTIONS.has(e.action) && Number.isFinite(e.ts)) this.items.push(e);
      } catch {}
    }
    if (this.items.length > KEEP) this.items = this.items.slice(-KEEP);
    if (this.lines > KEEP * 2) this._rewrite();
  }

  // entry: { path, action, device, local, size?, from? }
  add(entry) {
    const e = { ts: Date.now(), ...entry };
    this.items.push(e);
    if (this.items.length > KEEP) this.items.splice(0, this.items.length - KEEP);
    try {
      fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
      if (++this.lines > KEEP * 2) this._rewrite();
    } catch {}
    return e;
  }

  // Newest first. filter: all | local | remote | conflict
  query({ q = '', filter = 'all', offset = 0, limit = 100 } = {}) {
    const needle = String(q).trim().toLowerCase();
    const items = [];
    let total = 0;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const e = this.items[i];
      if (filter === 'local' && !e.local) continue;
      if (filter === 'remote' && e.local) continue;
      if (filter === 'conflict' && e.action !== 'conflict') continue;
      if (needle && !e.path.toLowerCase().includes(needle)) continue;
      if (total >= offset && items.length < limit) items.push(e);
      total++;
    }
    return { items, total };
  }

  _rewrite() {
    const body = this.items.map((e) => JSON.stringify(e)).join('\n') + (this.items.length ? '\n' : '');
    fs.writeFileSync(this.file, body);
    this.lines = this.items.length;
  }
}

module.exports = { Activity };
