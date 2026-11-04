'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { PassThrough } = require('stream');
const { writeFileFrames, readFrames, readHeader, receiveData } = require('../src/main/transfer');

const KEY = crypto.randomBytes(32);

function setup(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folderbridge-transfer-'));
  const data = crypto.randomBytes(bytes);
  const src = path.join(dir, 'source.bin');
  fs.writeFileSync(src, data);
  const hash = crypto.createHash('sha256').update(data).digest('hex');
  return { dir, data, src, hash, part: path.join(dir, `${hash}.part`) };
}

// Sends a file through an in-memory pipe, optionally changing the bytes in flight.
async function send(key, src, header, mangle) {
  const wire = new PassThrough();
  const out = mangle ? new PassThrough() : wire;
  if (mangle) {
    const chunks = [];
    out.on('data', (c) => chunks.push(c));
    out.on('end', () => wire.end(mangle(Buffer.concat(chunks))));
  }
  writeFileFrames(out, KEY, src, header);
  return readFrames(wire);
}

test('a file arrives in frames and is verified', async () => {
  const t = setup(3.5 * 1024 * 1024);
  const frames = await send(KEY, t.src, { hash: t.hash, size: t.data.length, offset: 0, mtime: 1 });
  const header = await readHeader(frames, KEY);
  assert.strictEqual(header.hash, t.hash);
  let progress = 0;
  await receiveData(frames, KEY, header, t.part, (n) => (progress += n));
  assert.ok(fs.readFileSync(t.part).equals(t.data));
  assert.strictEqual(progress, t.data.length);
});

test('a transfer resumes where the .part file ends', async () => {
  const t = setup(2.5 * 1024 * 1024);
  const have = 1234567;
  fs.writeFileSync(t.part, t.data.subarray(0, have));
  const frames = await send(KEY, t.src, { hash: t.hash, size: t.data.length, offset: have, mtime: 1 });
  const header = await readHeader(frames, KEY);
  let sent = 0;
  await receiveData(frames, KEY, header, t.part, (n) => (sent += n));
  assert.strictEqual(sent, t.data.length - have, 'only the missing part travelled');
  assert.ok(fs.readFileSync(t.part).equals(t.data));
});

test('changed bytes, a wrong key, or a wrong resume point are refused', async () => {
  const t = setup(300 * 1024);
  const header = { hash: t.hash, size: t.data.length, offset: 0, mtime: 1 };

  // One flipped bit inside a data frame.
  let frames = await send(KEY, t.src, header, (buf) => {
    buf[buf.length - 10] ^= 1;
    return buf;
  });
  const h = await readHeader(frames, KEY);
  await assert.rejects(receiveData(frames, KEY, h, t.part), /verification/);
  assert.ok(!fs.existsSync(t.part), 'nothing tampered is kept');

  // Someone without the code.
  frames = await send(KEY, t.src, header);
  await assert.rejects(readHeader(frames, crypto.randomBytes(32)));

  // The part file doesn't match the announced offset.
  fs.writeFileSync(t.part, 'xyz');
  frames = await send(KEY, t.src, header);
  await assert.rejects(receiveData(frames, KEY, await readHeader(frames, KEY), t.part), /resume mismatch/);
});

test('an intact transfer of the wrong content fails the hash check', async () => {
  const t = setup(100 * 1024);
  const other = crypto.randomBytes(100 * 1024);
  const lie = path.join(t.dir, 'other.bin');
  fs.writeFileSync(lie, other);
  // Correctly sealed frames, but the content doesn't match the hash they claim.
  const frames = await send(KEY, lie, { hash: t.hash, size: other.length, offset: 0, mtime: 1 });
  await assert.rejects(receiveData(frames, KEY, await readHeader(frames, KEY), t.part), /hash mismatch/);
  assert.ok(!fs.existsSync(t.part));
});
