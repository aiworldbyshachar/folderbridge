'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makePair, makeDevice, waitFor, online, idle, snapshot, same, stopAll } = require('./helpers');
const { generateCode } = require('../src/main/code');

async function startPair(opts) {
  const pair = makePair(opts);
  await pair.a.start();
  await pair.b.start();
  await waitFor(() => online(pair.a) && online(pair.b), 15000, 'peers to connect');
  return pair;
}

const settled = (a, b) => idle(a) && idle(b) && same(a, b);

test('two-way sync: create, change, rename, delete, folders, Hebrew names', async () => {
  const { a, b } = await startPair();
  try {
    a.write('hello.txt', 'hello from A');
    a.write('docs/plan.md', '# plan');
    b.write('שלום/מסמך.txt', 'שלום מ-B');
    await waitFor(() => b.read('hello.txt') === 'hello from A' && b.read('docs/plan.md') === '# plan' && a.read('שלום/מסמך.txt') === 'שלום מ-B', 15000, 'first files');

    // A change on B replaces A's copy; A's old version is kept in A's trash.
    b.write('hello.txt', 'changed on B');
    await waitFor(() => a.read('hello.txt') === 'changed on B', 15000, 'change');
    assert.ok(a.getTrash().some((t) => t.path === 'hello.txt' && t.reason === 'replaced'));

    // A rename travels as a rename: no transfer, nothing in the trash.
    const trashBefore = b.getTrash().length;
    fs.renameSync(a.file('docs/plan.md'), a.file('docs/plan-v2.md'));
    await waitFor(() => b.exists('docs/plan-v2.md') && !b.exists('docs/plan.md'), 15000, 'rename');
    assert.strictEqual(b.read('docs/plan-v2.md'), '# plan');
    assert.strictEqual(b.getTrash().length, trashBefore, 'rename did not use the trash');
    assert.ok(b.getActivity().items.some((e) => e.action === 'moved' && e.path === 'docs/plan-v2.md'));

    // Deleting on B: gone on A, but in A's trash.
    fs.rmSync(b.file('hello.txt'));
    await waitFor(() => !a.exists('hello.txt'), 15000, 'delete');
    assert.ok(a.getTrash().some((t) => t.path === 'hello.txt' && t.reason === 'deleted'));

    // Deleting a whole folder on A.
    fs.rmSync(a.file('docs'), { recursive: true });
    await waitFor(() => !b.exists('docs'), 15000, 'folder delete');

    // Empty folders travel too.
    fs.mkdirSync(a.file('empty/inner'), { recursive: true });
    await waitFor(() => b.exists('empty/inner'), 15000, 'empty folder');

    await waitFor(() => settled(a, b), 15000, 'both sides identical');
    assert.strictEqual(a.getStatus().state, 'up-to-date');
    assert.strictEqual(b.getStatus().state, 'up-to-date');
  } finally {
    await stopAll(a, b);
  }
});

test('first sync merges two full folders and deletes nothing; "ask" holds the conflict', async () => {
  const { a, b } = makePair();
  a.write('same.txt', 'identical');
  b.write('same.txt', 'identical');
  a.write('only-a.txt', 'A');
  b.write('only-b.txt', 'B');
  a.write('report.txt', 'version A', Date.now() - 60000);
  b.write('report.txt', 'version B', Date.now() - 30000);
  try {
    await a.start();
    await b.start();
    await waitFor(() => a.exists('only-b.txt') && b.exists('only-a.txt'), 15000, 'merge');
    await waitFor(() => a.getConflicts().length === 1 && b.getConflicts().length === 1, 15000, 'conflict on both');
    assert.strictEqual(a.getStatus().state, 'conflicts');
    // While waiting, each side keeps its own version and nothing is lost.
    assert.strictEqual(a.read('report.txt'), 'version A');
    assert.strictEqual(b.read('report.txt'), 'version B');
    assert.ok(!a.getTrash().some((t) => t.reason === 'deleted'));
    assert.ok(!b.getTrash().some((t) => t.reason === 'deleted'));

    // Keep both, decided on A: both computers end up with both versions.
    await a.resolveConflict(a.getConflicts()[0].id, 'both');
    await waitFor(() => settled(a, b) && !a.getConflicts().length && !b.getConflicts().length, 15000, 'resolution everywhere');
    const files = Object.keys(snapshot(a)).sort();
    const copy = files.find((f) => f.startsWith('report (conflict - B '));
    assert.ok(copy, `conflict copy among ${files}`);
    assert.strictEqual(a.read('report.txt'), 'version A');
    assert.strictEqual(a.read(copy), 'version B');
    assert.strictEqual(b.read(copy), 'version B');
  } finally {
    await stopAll(a, b);
  }
});

test('"ask": keeping the other version, and a held conflict settled elsewhere', async () => {
  const { a, b } = await startPair();
  try {
    a.write('notes.txt', 'base');
    await waitFor(() => b.read('notes.txt') === 'base');
    await a.setPaused(true);
    await b.setPaused(true);
    a.write('notes.txt', 'edit on A');
    b.write('notes.txt', 'edit on B');
    await waitFor(() => a.index.get('notes.txt').hash !== b.index.get('notes.txt').hash, 5000, 'both edits seen');
    await a.setPaused(false);
    await b.setPaused(false);
    await waitFor(() => a.getConflicts().length === 1 && b.getConflicts().length === 1, 15000, 'conflicts');
    await b.resolveConflict(b.getConflicts()[0].id, 'remote'); // B takes A's version
    await waitFor(() => settled(a, b) && !a.getConflicts().length && !b.getConflicts().length, 15000, 'settled');
    assert.strictEqual(a.read('notes.txt'), 'edit on A');
    assert.strictEqual(b.read('notes.txt'), 'edit on A');
    assert.ok(b.getTrash().some((t) => t.path === 'notes.txt' && t.reason === 'conflict'), "B's own edit is in its trash");
  } finally {
    await stopAll(a, b);
  }
});

test('automatic conflict modes ("keep both", "newest wins") converge to the same result', async () => {
  const { a, b } = await startPair();
  try {
    a.setConflictMode('both');
    await waitFor(() => b.getConflictMode() === 'both', 10000, 'shared setting');
    a.write('both.txt', 'base');
    a.write('newest.txt', 'base');
    a.write('kept.txt', 'base');
    await waitFor(() => b.read('both.txt') === 'base' && b.read('newest.txt') === 'base' && b.read('kept.txt') === 'base');

    await a.setPaused(true);
    await b.setPaused(true);
    a.write('both.txt', 'A wrote this', Date.now() - 20000);
    b.write('both.txt', 'B wrote this later', Date.now() - 10000);
    // Changed on one side, deleted on the other: the change wins.
    fs.rmSync(a.file('kept.txt'));
    b.write('kept.txt', 'B changed it');
    await new Promise((r) => setTimeout(r, 600));
    await a.setPaused(false);
    await b.setPaused(false);
    await waitFor(() => settled(a, b), 15000, 'keep both');
    assert.strictEqual(a.read('both.txt'), 'B wrote this later');
    const copy = Object.keys(snapshot(a)).find((k) => k.startsWith('both (conflict - A '));
    assert.ok(copy, 'older version kept under a conflict name');
    assert.strictEqual(b.read(copy), 'A wrote this');
    assert.strictEqual(a.read('kept.txt'), 'B changed it');

    b.setConflictMode('newest');
    await waitFor(() => a.getConflictMode() === 'newest', 10000, 'shared setting back');
    await a.setPaused(true);
    await b.setPaused(true);
    a.write('newest.txt', 'A is newer', Date.now() - 1000);
    b.write('newest.txt', 'B is older', Date.now() - 50000);
    await new Promise((r) => setTimeout(r, 600));
    await a.setPaused(false);
    await b.setPaused(false);
    await waitFor(() => settled(a, b) && b.read('newest.txt') === 'A is newer', 15000, 'newest wins');
    assert.ok(!Object.keys(snapshot(b)).some((k) => k.startsWith('newest (conflict')), 'no copy in "newest wins"');
    assert.ok(b.getTrash().some((t) => t.path === 'newest.txt'), 'the older version is in the trash');
  } finally {
    await stopAll(a, b);
  }
});

test('many deletions at once wait for an OK; "keep my files" brings them back everywhere', async () => {
  const { a, b } = await startPair();
  try {
    for (let i = 0; i < 60; i++) a.write(`batch/${i}.txt`, `file ${i}`);
    await waitFor(() => b.getStatus().files === 60 && idle(b), 20000, '60 files on B');

    for (let i = 0; i < 60; i++) fs.rmSync(a.file(`batch/${i}.txt`));
    await waitFor(() => b.getStatus().state === 'confirm-delete', 15000, 'hold on B');
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(fs.readdirSync(b.file('batch')).length, 60, 'nothing deleted yet');

    b.keepFiles();
    await waitFor(() => a.exists('batch/59.txt') && settled(a, b), 20000, 'files restored on A');
    assert.strictEqual(fs.readdirSync(a.file('batch')).length, 60);

    for (let i = 0; i < 60; i++) fs.rmSync(a.file(`batch/${i}.txt`));
    await waitFor(() => b.getStatus().state === 'confirm-delete', 15000, 'hold again');
    b.approveDeletes();
    await waitFor(() => !b.exists('batch/0.txt') && settled(a, b), 20000, 'deleted after OK');
    assert.ok(b.getTrash().filter((t) => t.reason === 'deleted').length >= 60, 'all of them in the trash');
  } finally {
    await stopAll(a, b);
  }
});

test('one OK covers a deletion burst that arrives in pieces', async () => {
  const base = fs.mkdtempSync(path.join(require('os').tmpdir(), 'folderbridge-burst-'));
  const b = makeDevice(base, 'B', { code: generateCode() });
  for (let i = 0; i < 60; i++) b.write(`burst/${i}.txt`, `file ${i}`);
  try {
    await b.start();
    await waitFor(() => b.getStatus().files === 60, 10000, '60 files indexed');
    // Tombstones from another computer, the way they'd arrive in two pushes.
    const peer = '99999999-9999-4999-8999-999999999999';
    const tomb = (i) => {
      const local = b.index.get(`burst/${i}.txt`);
      return { ...b.index.toWire(local), deleted: true, vv: { ...local.vv, [peer]: 1 }, by: peer, byName: 'A', ts: Date.now() };
    };
    b.receive([...Array(40).keys()].map(tomb), { replica: peer, name: 'A' });
    assert.strictEqual(b.getStatus().holdDeletes, 40);
    b.approveDeletes();
    await waitFor(() => b.getStatus().files === 20, 10000, 'first part deleted');
    b.receive([...Array(20).keys()].map((i) => tomb(i + 40)), { replica: peer, name: 'A' });
    assert.strictEqual(b.getStatus().holdDeletes, 0, 'the rest of the burst needs no second OK');
    await waitFor(() => b.getStatus().files === 0, 10000, 'all deleted');
    assert.strictEqual(b.getTrash().length, 60, 'every one of them is in the trash');
  } finally {
    await stopAll(b);
  }
});

test('a big file resumes after a dropped connection; damaged pieces are refused', async () => {
  const { a, b } = makePair();
  const data = crypto.randomBytes(6 * 1024 * 1024 + 123);
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  a.write('video.bin', data);
  // B already has the first 2 MB from an earlier, interrupted attempt.
  fs.mkdirSync(path.join(b.root, '.folderbridge', 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(b.root, '.folderbridge', 'tmp', `${hash}.part`), data.subarray(0, 2 * 1024 * 1024));
  try {
    await a.start();
    const offsets = [];
    const serve = a.engine._serveFile.bind(a.engine);
    a.engine._serveFile = (msg, res) => {
      offsets.push(msg.offset);
      return serve(msg, res);
    };
    await b.start();
    await waitFor(() => b.exists('video.bin') && idle(b), 20000, 'big file');
    assert.ok(fs.readFileSync(b.file('video.bin')).equals(data));
    assert.deepStrictEqual(offsets, [2 * 1024 * 1024], 'only the missing 4 MB travelled');

    // A .part with wrong bytes fails the final check and is fetched again in full.
    const data2 = crypto.randomBytes(3 * 1024 * 1024);
    const hash2 = crypto.createHash('sha256').update(data2).digest('hex');
    fs.writeFileSync(path.join(b.root, '.folderbridge', 'tmp', `${hash2}.part`), crypto.randomBytes(1024 * 1024));
    offsets.length = 0;
    a.write('video2.bin', data2);
    await waitFor(() => b.exists('video2.bin') && idle(b), 20000, 'second file');
    assert.ok(fs.readFileSync(b.file('video2.bin')).equals(data2));
    assert.deepStrictEqual(offsets, [1024 * 1024, 0], 'resumed, failed verification, fetched again');
  } finally {
    await stopAll(a, b);
  }
});

test('changes and files flow even when one side cannot accept connections', async () => {
  const { a, b } = makePair();
  try {
    await a.start();
    await b.start();
    a.engine.server.close(); // like a firewall: nothing can connect to A
    if (a.engine.server.closeAllConnections) a.engine.server.closeAllConnections();
    await waitFor(() => online(a) && online(b), 15000, 'peers');

    a.write('from-a.bin', crypto.randomBytes(1500 * 1024));
    await waitFor(() => b.exists('from-a.bin') && idle(b), 20000, 'A -> B by upload');
    assert.ok(fs.readFileSync(b.file('from-a.bin')).equals(fs.readFileSync(a.file('from-a.bin'))));

    b.write('from-b.txt', 'B to A');
    await waitFor(() => a.read('from-b.txt') === 'B to A', 15000, 'B -> A by download');
  } finally {
    await stopAll(a, b);
  }
});

test('a device with another code is seen but gets nothing', async () => {
  const { a, b, base, discoveryPort } = await startPair();
  const c = makeDevice(base, 'C', { code: generateCode(), discoveryPort, manualPeers: [`127.0.0.1:${a.port}`] });
  try {
    a.write('secret.txt', 'for A and B only');
    await waitFor(() => b.exists('secret.txt'));
    await c.start();
    await waitFor(() => c.engine.getForeign().some((f) => f.name === 'A'), 15000, 'A seen as foreign');
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!c.exists('secret.txt'));
    assert.ok(!c.engine.getPeers().some((p) => p.online));
    const peerA = { address: '127.0.0.1', port: a.port, name: 'A' };
    const hash = a.index.get('secret.txt').hash;
    await assert.rejects(c.engine.fetchFile(peerA, { hash, path: 'secret.txt', partPath: path.join(base, 'x.part') }), /wrong connection code|403/);
  } finally {
    await stopAll(a, b, c);
  }
});

test('names: NFD names from a Mac stay one file; Windows-only problems are flagged, never written', async () => {
  const { a, b } = await startPair({ b: { platform: 'win32' } });
  try {
    const nfd = 'café.txt';
    a.write(nfd, 'from a Mac');
    await waitFor(() => b.read('café.txt') === 'from a Mac', 15000, 'NFC on B');
    b.write('café.txt', 'edited on B');
    await waitFor(() => fs.readFileSync(path.join(a.root, nfd), 'utf8') === 'edited on B', 15000, 'back to the NFD file');
    assert.strictEqual(fs.readdirSync(a.root).filter((n) => n.normalize('NFC') === 'café.txt').length, 1, 'no duplicate');

    // A name only a Mac can have: B (Windows) flags it instead of writing it.
    const peer = a.index.replicaId;
    const rec = { type: 'file', path: 'Meeting: notes?.txt', size: 1, mtime: 1, hash: 'c'.repeat(64), vv: { [peer]: 99 }, by: peer, byName: 'A', ts: Date.now() };
    b.receive([rec], { replica: peer, name: 'A' });
    await waitFor(() => b.getProblems().some((p) => p.type === 'windows-name' && p.path === rec.path), 5000, 'flagged');
    assert.ok(!fs.readdirSync(b.root).some((n) => n.startsWith('Meeting')));
    // Renamed on the Mac (the old name is deleted): the problem goes away.
    b.receive([{ ...rec, deleted: true, vv: { [peer]: 100 } }], { replica: peer, name: 'A' });
    await waitFor(() => !b.getProblems().some((p) => p.type === 'windows-name'), 5000, 'cleared');
  } finally {
    await stopAll(a, b);
  }
});

test('trash restore brings a file back on every computer', async () => {
  const { a, b } = await startPair();
  try {
    a.write('keep-me.txt', 'precious');
    await waitFor(() => b.exists('keep-me.txt'));
    fs.rmSync(b.file('keep-me.txt'));
    await waitFor(() => !a.exists('keep-me.txt'), 15000, 'deleted on A');
    const item = a.getTrash().find((t) => t.path === 'keep-me.txt');
    assert.ok(item);
    await a.restoreFromTrash(item.id);
    await waitFor(() => b.read('keep-me.txt') === 'precious' && a.read('keep-me.txt') === 'precious', 15000, 'restored on both');
  } finally {
    await stopAll(a, b);
  }
});

test('a folder that goes missing is "unavailable", never "everything deleted"', async () => {
  const pair = await startPair();
  let { a, b } = pair;
  try {
    a.write('photo.jpg', 'pixels');
    a.write('doc.txt', 'words');
    await waitFor(() => b.exists('photo.jpg') && b.exists('doc.txt'));
    await waitFor(() => idle(a) && idle(b));
    a.stop();

    // Like an unplugged drive: the folder is gone, then an empty one is there.
    const moved = a.root + '-away';
    fs.renameSync(a.root, moved);
    a = makeDevice(pair.base, 'A', { code: pair.code, port: a.port, discoveryPort: pair.discoveryPort, manualPeers: [`127.0.0.1:${b.port}`] });
    a.opts.createRoot = false;
    await a.start();
    assert.strictEqual(a.getStatus().state, 'unavailable');
    fs.mkdirSync(a.root);
    await a.watcher.request('', 0);
    assert.strictEqual(a.getStatus().state, 'unavailable', 'an empty stand-in folder is not trusted');
    await new Promise((r) => setTimeout(r, 1000));
    assert.ok(b.exists('photo.jpg') && b.exists('doc.txt'), 'nothing deleted on B');

    // The real folder comes back.
    a.stop();
    fs.rmdirSync(a.root);
    fs.renameSync(moved, a.root);
    a = makeDevice(pair.base, 'A', { code: pair.code, port: a.port, discoveryPort: pair.discoveryPort, manualPeers: [`127.0.0.1:${b.port}`] });
    await a.start();
    assert.notStrictEqual(a.getStatus().state, 'unavailable');
    a.write('after.txt', 'back');
    await waitFor(() => b.exists('after.txt'), 15000, 'syncing again');
    assert.ok(b.exists('photo.jpg') && b.exists('doc.txt'));
  } finally {
    await stopAll(a, b);
  }
});
