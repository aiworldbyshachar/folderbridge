'use strict';
// File transfer: a file travels as a stream of sealed frames, so even a huge
// video never sits in memory and every piece is checked as it arrives.
//
// Frame on the wire: 4-byte length, then iv(12) + tag(16) + ciphertext.
// Frame 0 is a small JSON header (it names the file's hash), the rest carry up
// to 1 MB of file data each. Data frames are bound to the file hash and their
// number as AAD, so they can't be reordered, swapped between files or replayed. The receiver writes into a
// .part file (kept for resuming after a dropped connection), checks the
// sha256 of the whole file at the end, and only then is it used.
const fs = require('fs');
const crypto = require('crypto');
const { once } = require('events');

const FRAME_DATA = 1024 * 1024;
const OVERHEAD = 28;
const MAX_HEADER = 64 * 1024;

const HEADER_AAD = 'folderbridge/header';

function aad(hash, index) {
  return index === 0 ? HEADER_AAD : `${hash}/${index}`;
}

function sealFrame(key, payload, hash, index) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad(hash, index)));
  const body = Buffer.concat([cipher.update(payload), cipher.final()]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(OVERHEAD + body.length);
  return Buffer.concat([len, iv, cipher.getAuthTag(), body]);
}

function openFrame(key, frame, hash, index) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, frame.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad(hash, index)));
  decipher.setAuthTag(frame.subarray(12, OVERHEAD));
  return Buffer.concat([decipher.update(frame.subarray(OVERHEAD)), decipher.final()]);
}

// Splits a byte stream back into frames (without their length prefix).
async function* readFrames(stream) {
  let chunks = [];
  let total = 0;
  let need = 4;
  let len = -1;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.length;
    while (total >= need) {
      const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total);
      chunks = [all];
      if (len < 0) {
        len = all.readUInt32BE(0);
        if (len < OVERHEAD || len > OVERHEAD + FRAME_DATA + MAX_HEADER) throw new Error('bad frame');
        need = 4 + len;
        continue;
      }
      yield all.subarray(4, need);
      const rest = all.subarray(need);
      chunks = rest.length ? [rest] : [];
      total = rest.length;
      len = -1;
      need = 4;
    }
  }
  if (total) throw new Error('connection closed mid-frame');
}

// Writes header + file data (from header.offset) as frames to a writable stream.
async function writeFileFrames(out, key, absPath, header) {
  const hash = header.hash;
  const write = async (buf) => {
    if (out.destroyed) throw new Error('connection closed');
    if (!out.write(buf)) await Promise.race([once(out, 'drain'), once(out, 'close')]);
  };
  await write(sealFrame(key, Buffer.from(JSON.stringify(header)), hash, 0));
  if (header.size > header.offset) {
    const rs = fs.createReadStream(absPath, { start: header.offset, end: header.size - 1, highWaterMark: FRAME_DATA });
    let index = 1;
    for await (const data of rs) await write(sealFrame(key, data, hash, index++));
  }
  out.end();
}

function partSize(partPath) {
  try {
    return fs.statSync(partPath).size;
  } catch {
    return 0;
  }
}

async function hashPrefix(file, bytes, h) {
  if (!bytes) return;
  for await (const data of fs.createReadStream(file, { start: 0, end: bytes - 1 })) h.update(data);
}

// Reads the header frame. Kept separate so a server can check it before
// accepting the data (uploads carry who sends what in the header).
async function readHeader(frames, key) {
  const first = await frames.next();
  if (first.done) throw new Error('empty transfer');
  const header = JSON.parse(openFrame(key, first.value, null, 0).toString('utf8'));
  if (!header || typeof header.hash !== 'string' || !/^[0-9a-f]{64}$/.test(header.hash)) throw new Error('bad header');
  if (!Number.isSafeInteger(header.size) || !Number.isSafeInteger(header.offset)) throw new Error('bad header');
  if (header.offset < 0 || header.offset > header.size) throw new Error('bad header');
  return header;
}

// Receives the data frames into `partPath`, resuming at header.offset, and
// verifies the sha256. Returns when the complete, verified file is there.
async function receiveData(frames, key, header, partPath, onProgress) {
  const hash = header.hash;
  const have = partSize(partPath);
  if (header.offset !== have) throw new Error(`resume mismatch (${header.offset} vs ${have})`);
  const h = crypto.createHash('sha256');
  await hashPrefix(partPath, have, h);
  const fh = await fs.promises.open(partPath, have ? 'a' : 'w');
  let received = have;
  let index = 1;
  let tampered = false;
  try {
    for (;;) {
      const next = await frames.next();
      if (next.done) break;
      let data;
      try {
        data = openFrame(key, next.value, hash, index++);
      } catch {
        tampered = true;
        throw new Error('frame failed verification');
      }
      if (received + data.length > header.size) {
        tampered = true;
        throw new Error('more data than announced');
      }
      h.update(data);
      await fh.write(data);
      received += data.length;
      if (onProgress) onProgress(data.length, received, header.size);
    }
  } finally {
    await fh.close();
    if (tampered) fs.rmSync(partPath, { force: true });
  }
  if (received !== header.size) throw new Error('transfer interrupted');
  if (h.digest('hex') !== hash) {
    fs.rmSync(partPath, { force: true });
    throw new Error('hash mismatch');
  }
  return header;
}

module.exports = { FRAME_DATA, sealFrame, openFrame, readFrames, writeFileFrames, readHeader, receiveData, partSize };
