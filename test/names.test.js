'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const names = require('../src/main/names');

test('keys: "/" separators and NFC, so Mac and Windows names meet', () => {
  assert.strictEqual(names.toKey(['docs', 'café.txt'].join(path.sep)), 'docs/café.txt');
  assert.strictEqual(names.toKey('שָלום.txt'), 'שָלום.txt'.normalize('NFC'));
  assert.strictEqual(names.parentKey('a/b/c.txt'), 'a/b');
  assert.strictEqual(names.parentKey('c.txt'), '');
  assert.strictEqual(names.baseName('a/b/c.txt'), 'c.txt');
  assert.ok(names.isInside('a/b/c', 'a/b'));
  assert.ok(names.isInside('a/b', 'a/b'));
  assert.ok(!names.isInside('a/bc', 'a/b'));
  assert.ok(names.isInside('anything', ''));
});

test('junk files are ignored, real files are not', () => {
  for (const n of ['.DS_Store', 'Thumbs.db', 'desktop.ini', '~$report.docx', '._photo.jpg', 'x.tmp', 'video.crdownload', '.folderbridge', '.~lock.sheet.ods#']) {
    assert.ok(names.isIgnored(n), n);
  }
  for (const n of ['report.docx', 'photo.jpg', '.env', 'tmp', 'notes.txt']) assert.ok(!names.isIgnored(n), n);
});

test('network keys must be plain relative paths', () => {
  for (const k of ['a.txt', 'a/b/c.txt', 'שלום/קובץ.txt', 'a:b.txt']) assert.ok(names.isSafeKey(k), k);
  for (const k of ['', '../x', 'a/../b', '/abs', 'a//b', './a', 'a/./b', '.folderbridge/x', 'café', 'a\0b', 42, null]) {
    assert.ok(!names.isSafeKey(k), String(k));
  }
  const root = path.resolve('/tmp/fb-root');
  assert.strictEqual(names.keyToPath(root, 'a/b.txt'), path.join(root, 'a', 'b.txt'));
  assert.throws(() => names.keyToPath(root, '../escape'));
  assert.throws(() => names.keyToPath(root, 'a:b.txt', 'win32'));
  assert.doesNotThrow(() => names.keyToPath(root, 'a:b.txt', 'darwin'));
});

test('names Windows cannot use are recognised', () => {
  assert.strictEqual(names.windowsNameProblem('Meeting: notes?.txt'), 'characters');
  assert.strictEqual(names.windowsNameProblem('a\\b.txt'), 'characters');
  assert.strictEqual(names.windowsNameProblem('notes.'), 'ending');
  assert.strictEqual(names.windowsNameProblem('dir /file.txt'), 'ending');
  assert.strictEqual(names.windowsNameProblem('CON'), 'reserved');
  assert.strictEqual(names.windowsNameProblem('docs/aux.txt'), 'reserved');
  assert.strictEqual(names.windowsNameProblem('lpt1'), 'reserved');
  assert.strictEqual(names.windowsNameProblem('console.txt'), null);
  assert.strictEqual(names.windowsNameProblem('docs/report (final).docx'), null);
});

test('conflict names are built only from the losing version', () => {
  const mtime = new Date(2026, 10, 1, 14, 32, 10).getTime();
  assert.strictEqual(names.conflictKey('dir/report.docx', 'Home-PC', mtime), 'dir/report (conflict - Home-PC 2026-11-01 14.32).docx');
  assert.strictEqual(names.conflictKey('README', 'Mac', mtime), 'README (conflict - Mac 2026-11-01 14.32)');
  assert.strictEqual(names.conflictKey('.env', 'Mac', mtime), '.env (conflict - Mac 2026-11-01 14.32)');
  // A device name with characters Windows can't use still gives a usable name.
  const k = names.conflictKey('a.txt', 'My:Mac?', mtime);
  assert.strictEqual(names.windowsNameProblem(k), null);
  assert.ok(!k.includes('—') && !k.includes('–'), 'short hyphens only');
});
