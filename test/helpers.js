'use strict';
// Two (or more) FolderSync instances on this machine, each with its own temp
// folder and data folder, talking over 127.0.0.1.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { FolderSync } = require('../src/main/folder');
const { generateCode } = require('../src/main/code');

let nextPort = 48200 + (process.pid % 50) * 20;

function makeDevice(base, name, opts = {}) {
  const port = opts.port || nextPort++;
  const dev = new FolderSync({
    root: opts.root || path.join(base, name, 'folder'),
    dataDir: path.join(base, name, 'data'),
    deviceName: name,
    code: opts.code,
    port,
    discoveryPort: opts.discoveryPort,
    manualPeers: opts.manualPeers || [],
    createRoot: true,
    stableMs: 100,
    scanInterval: 60000,
    platform: opts.platform,
    paused: opts.paused,
    log: process.env.FB_DEBUG ? (...a) => console.log(`[${name}]`, ...a) : () => {},
  });
  dev.port = port;
  dev.file = (key) => path.join(dev.root, ...key.split('/'));
  dev.write = (key, content, mtime) => {
    fs.mkdirSync(path.dirname(dev.file(key)), { recursive: true });
    fs.writeFileSync(dev.file(key), content);
    if (mtime) fs.utimesSync(dev.file(key), mtime / 1000, mtime / 1000);
  };
  dev.read = (key) => {
    try {
      return fs.readFileSync(dev.file(key), 'utf8');
    } catch {
      return null;
    }
  };
  dev.exists = (key) => fs.existsSync(dev.file(key));
  return dev;
}

// A pair (A, B) sharing a fresh random code, pointed at each other.
function makePair(opts = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'folderbridge-'));
  const code = opts.code || generateCode();
  const discoveryPort = 49000 + (process.pid % 400);
  const pa = nextPort++;
  const pb = nextPort++;
  const a = makeDevice(base, 'A', { code, port: pa, discoveryPort, manualPeers: [`127.0.0.1:${pb}`], ...(opts.a || {}) });
  const b = makeDevice(base, 'B', { code, port: pb, discoveryPort, manualPeers: [`127.0.0.1:${pa}`], ...(opts.b || {}) });
  return { base, code, a, b, discoveryPort };
}

async function waitFor(fn, ms = 15000, what = 'condition') {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch (err) {
      last = err;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

const online = (dev) => dev.engine.getPeers().some((p) => p.online);
const idle = (dev) => dev.needs.size === 0 && dev.active === 0;

// Every file under the folder (except .folderbridge), as { key: content }.
function snapshot(dev) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.folderbridge') continue;
      const key = (prefix ? `${prefix}/` : '') + ent.name.normalize('NFC');
      if (ent.isDirectory()) {
        out[key + '/'] = true;
        walk(path.join(dir, ent.name), key);
      } else {
        out[key] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, ent.name))).digest('hex').slice(0, 12);
      }
    }
  };
  walk(dev.root, '');
  return out;
}

function same(a, b) {
  return JSON.stringify(snapshot(a)) === JSON.stringify(snapshot(b));
}

async function stopAll(...devs) {
  for (const d of devs) {
    try {
      d.stop();
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 50));
}

module.exports = { makePair, makeDevice, waitFor, online, idle, snapshot, same, stopAll };
