'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FileIndex, compareVV, mergeVV, sameContent, sanitizeRecord } = require('../src/main/index');

const HASH = 'a'.repeat(64);
const HASH2 = 'b'.repeat(64);

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'folderbridge-index-'));
}

test('version vectors: equal, newer, older, concurrent', () => {
  assert.strictEqual(compareVV({ a: 1 }, { a: 1 }), 'equal');
  assert.strictEqual(compareVV({ a: 2 }, { a: 1 }), 'greater');
  assert.strictEqual(compareVV({ a: 1, b: 1 }, { a: 1 }), 'greater');
  assert.strictEqual(compareVV({ a: 1 }, { a: 1, b: 1 }), 'less');
  assert.strictEqual(compareVV({ a: 2 }, { a: 1, b: 1 }), 'concurrent');
  assert.strictEqual(compareVV({}, {}), 'equal');
  assert.deepStrictEqual(mergeVV({ a: 2, b: 1 }, { a: 1, c: 3 }), { a: 2, b: 1, c: 3 });
  assert.ok(sameContent({ type: 'file', hash: HASH }, { type: 'file', hash: HASH }));
  assert.ok(!sameContent({ type: 'file', hash: HASH }, { type: 'file', hash: HASH2 }));
  assert.ok(sameContent({ deleted: true }, { deleted: true, type: 'dir' }));
  assert.ok(!sameContent({ deleted: true }, { type: 'file', hash: HASH }));
});

test('index: local changes, paging, reload, and a new folder starts fresh', () => {
  const dir = tmp();
  const root = path.join(dir, 'folder');
  const ix = new FileIndex({ dir, root, deviceName: 'PC' });
  ix.load();
  const a1 = ix.localChange({ type: 'file', path: 'a.txt', size: 1, mtime: 1000, hash: HASH, lmt: 1000 });
  assert.deepStrictEqual(a1.vv, { [ix.replicaId]: 1 });
  const a2 = ix.localChange({ type: 'file', path: 'a.txt', size: 2, mtime: 2000, hash: HASH2, lmt: 2000 });
  assert.deepStrictEqual(a2.vv, { [ix.replicaId]: 2 });
  ix.localChange({ type: 'dir', path: 'docs' });
  for (let i = 0; i < 10; i++) ix.localChange({ type: 'file', path: `docs/${i}.txt`, size: i, mtime: i, hash: HASH, lmt: i });
  assert.deepStrictEqual(ix.keysWithHash(HASH).sort(), [...Array(10).keys()].map((i) => `docs/${i}.txt`).sort());
  ix.localChange({ type: 'file', path: 'a.txt', deleted: true });
  assert.strictEqual(ix.liveCount(), 10);

  // Replication pages, in order, with a cursor.
  const p1 = ix.recordsSince(0, 5);
  assert.strictEqual(p1.records.length, 5);
  assert.ok(p1.more);
  const p2 = ix.recordsSince(p1.last, 100);
  assert.ok(!p2.more);
  assert.strictEqual(p1.records.length + p2.records.length, 12, 'one record per path');
  assert.ok(p2.records.every((r) => r.lmt === undefined), 'local-only fields stay home');
  assert.ok(p2.records.find((r) => r.path === 'a.txt').deleted);

  const other = '11111111-2222-4333-8444-555555555555';
  ix.setCursor(other, 42);
  ix.setShared('conflictMode', 'both');
  ix.flush();

  const again = new FileIndex({ dir, root, deviceName: 'PC' });
  again.load();
  assert.strictEqual(again.replicaId, ix.replicaId);
  assert.strictEqual(again.deviceId, ix.deviceId);
  assert.strictEqual(again.maxSeq, ix.maxSeq);
  assert.strictEqual(again.get('docs/3.txt').lmt, 3);
  assert.ok(again.get('a.txt').deleted);
  assert.strictEqual(again.cursor(other), 42);
  assert.strictEqual(again.getShared('conflictMode'), 'both');
  const next = again.localChange({ type: 'file', path: 'new.txt', size: 1, mtime: 1, hash: HASH });
  assert.strictEqual(next.seq, ix.maxSeq + 1, 'numbering continues after reload');

  const moved = new FileIndex({ dir, root: path.join(dir, 'elsewhere'), deviceName: 'PC' });
  moved.load();
  assert.notStrictEqual(moved.replicaId, ix.replicaId, 'another folder is another replica');
  assert.strictEqual(moved.liveCount(), 0);
  assert.strictEqual(moved.deviceId, ix.deviceId, 'still the same computer');
});

test('index: remote versions, shared settings and records from the network', () => {
  const ix = new FileIndex({ dir: tmp(), root: '/x', deviceName: 'PC' });
  ix.load();
  const peer = '11111111-2222-4333-8444-555555555555';
  const remote = { type: 'file', path: 'r.txt', size: 3, mtime: 5, hash: HASH, vv: { [peer]: 4 }, by: peer, byName: 'Mac', ts: 1, seq: 9 };
  ix.adopt(sanitizeRecord(remote), 77, undefined, peer);
  assert.deepStrictEqual(ix.get('r.txt').vv, { [peer]: 4 });
  assert.strictEqual(ix.recordsSince(0, 10, peer).records.length, 0, 'not sent back to where it came from');
  assert.strictEqual(ix.recordsSince(0, 10).records.length, 1);
  const mine = ix.localChange({ type: 'file', path: 'r.txt', size: 4, mtime: 6, hash: HASH2 });
  assert.deepStrictEqual(mine.vv, { [peer]: 4, [ix.replicaId]: 1 });
  assert.strictEqual(ix.caseTwin('R.TXT'), 'r.txt');
  assert.strictEqual(ix.caseTwin('r.txt'), null);

  // Shared settings: latest wins.
  const later = { type: 'setting', name: 'conflictMode', value: 'newest', by: peer, ts: Date.now() + 5000 };
  assert.ok(ix.applyRemoteSetting(sanitizeRecord(later)));
  assert.strictEqual(ix.getShared('conflictMode'), 'newest');
  assert.ok(!ix.applyRemoteSetting(sanitizeRecord({ ...later, value: 'ask', ts: 1 })));

  // Junk from the network is refused.
  assert.strictEqual(sanitizeRecord({ ...remote, path: '../evil' }), null);
  assert.strictEqual(sanitizeRecord({ ...remote, hash: 'nothex' }), null);
  assert.strictEqual(sanitizeRecord({ ...remote, vv: {} }), null);
  assert.strictEqual(sanitizeRecord({ ...remote, vv: { notanid: 1 } }), null);
  assert.strictEqual(sanitizeRecord({ ...remote, size: -1 }), null);
  assert.strictEqual(sanitizeRecord({ type: 'setting', name: 'conflictMode', value: 'whatever', by: peer, ts: 1 }), null);
  assert.strictEqual(sanitizeRecord({ type: 'setting', name: 'rootPath', value: 'ask', by: peer, ts: 1 }), null);
  const tomb = sanitizeRecord({ type: 'file', path: 'gone.txt', deleted: true, vv: { [peer]: 1 }, by: peer, ts: 1 });
  assert.ok(tomb && tomb.deleted && tomb.hash === undefined);
});
