'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { LANGUAGES, STRINGS, createTranslator } = require('../src/shared/i18n');

const flat = (msg) => (typeof msg === 'object' ? Object.values(msg) : [msg]);
const placeholders = (msg) => new Set(flat(msg).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1])));

test('every language has every string, with the same placeholders', () => {
  const keys = Object.keys(STRINGS.en);
  for (const { code } of LANGUAGES) {
    const table = STRINGS[code];
    assert.ok(table, `missing language ${code}`);
    assert.deepStrictEqual(Object.keys(table).filter((k) => !(k in STRINGS.en)), [], `${code}: keys not in English`);
    for (const key of keys) {
      assert.ok(key in table, `${code}: missing "${key}"`);
      const want = placeholders(STRINGS.en[key]);
      const got = placeholders(table[key]);
      for (const p of got) assert.ok(want.has(p) || p === 'n', `${code}.${key}: unknown placeholder {${p}}`);
      for (const p of want) if (p !== 'n') assert.ok(got.has(p), `${code}.${key}: lost placeholder {${p}}`);
      if (typeof STRINGS.en[key] === 'object') assert.ok(typeof table[key] === 'object' && table[key].other, `${code}.${key}: needs plural forms`);
    }
  }
});

test('short hyphens only: no em or en dashes in any string', () => {
  for (const { code } of LANGUAGES) {
    for (const [key, msg] of Object.entries(STRINGS[code])) {
      for (const s of flat(msg)) assert.ok(!/[–—]/.test(s), `${code}.${key} has a long dash: ${s}`);
    }
  }
  for (const file of ['src/renderer/index.html', 'src/renderer/app.js', 'src/main/main.js']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.ok(!/[–—]/.test(text), `${file} has a long dash`);
  }
});

test('plurals and placeholders are filled in', () => {
  const en = createTranslator('en');
  assert.strictEqual(en.t('files', { n: 1 }), '1 file');
  assert.strictEqual(en.t('files', { n: 1200 }), '1,200 files');
  assert.strictEqual(en.t('keepTheirs', { device: 'MacBook' }), 'Keep MacBook’s');
  const ru = createTranslator('ru');
  assert.strictEqual(ru.t('files', { n: 1 }), '1 файл');
  assert.strictEqual(ru.t('files', { n: 3 }), '3 файла');
  assert.strictEqual(ru.t('files', { n: 5 }), '5 файлов');
  const ar = createTranslator('ar');
  assert.strictEqual(ar.t('files', { n: 2 }), 'ملفان');
  const he = createTranslator('he');
  assert.strictEqual(he.dir, 'rtl');
  assert.strictEqual(he.t('files', { n: 1 }), 'קובץ אחד');
  assert.strictEqual(createTranslator('xx').code, 'en', 'unknown language falls back to English');
});
