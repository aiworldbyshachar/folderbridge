'use strict';
// LAN engine (the ClipBridge design, carrying file records and file content).
//
// Discovery: every device broadcasts a small UDP announcement. Devices that
// share a connection code have the same fingerprint and pair automatically;
// devices with a different code are listed as "foreign" so the UI can say so.
// Known peers are also probed directly over HTTP, which keeps things working on
// networks that drop broadcasts once a device has been found (or added by IP).
//
// Transport: plain HTTP between peers, every body sealed with AES-256-GCM using
// a key derived from the connection code. Index records reach a peer two ways:
//  - push: the device that changed something posts the new records, and
//  - watch: every device keeps a long-poll /api/sync open to each peer, which
//    the peer answers the moment it has something new.
// Either one is enough, so changes arrive at once even when one side can't
// accept incoming connections (a firewall, macOS local network rules, ...).
//
// File content follows the same rule: a device that needs a file downloads it
// (/api/file); if it can't reach the peer that has it, it lists the file in its
// "wants", which travel back on that peer's long-poll and push replies, and the
// peer uploads the file instead (/api/upload).
const dgram = require('dgram');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { normalizeCode } = require('./code');
const { ID_RE } = require('./index');
const { readFrames, writeFileFrames, readHeader, receiveData, partSize } = require('./transfer');

const APP_TAG = 'folderbridge';
const PROTO = 1;
const DEFAULT_PORT = 47811;
const DEFAULT_DISCOVERY_PORT = 47810;
const ANNOUNCE_INTERVAL = 3000;
const PROBE_INTERVAL = 5000;
const PROBE_WHEN_SILENT = 6000;
const PEER_TIMEOUT = 15000;
const PERIODIC_SYNC = 30000;
const MAX_BODY = 64 * 1024 * 1024;
const PAGE_RECORDS = 1000;
const WATCH_HOLD = 10000; // how long a server holds an idle long-poll
const WATCH_TIMEOUT = 25000;
const PUSH_DELAY = 50;
const CONNECT_TIMEOUT = 5000; // a firewall that drops packets shouldn't keep us waiting

function deriveKey(code) {
  return crypto.scryptSync(normalizeCode(code), 'folderbridge/v1', 32);
}

function seal(key, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

function unseal(key, buf) {
  if (buf.length < 28) throw new Error('short body');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8'));
}

function readBody(stream, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    stream.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        stream.destroy();
        return;
      }
      parts.push(c);
    });
    stream.on('end', () => resolve(Buffer.concat(parts)));
    stream.on('error', reject);
  });
}

const ipToInt = (ip) => ip.split('.').reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
const intToIp = (n) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');

function ipv4Interfaces() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a);
    }
  }
  return out;
}

function localAddresses() {
  return ipv4Interfaces().map((a) => a.address);
}

function broadcastAddresses() {
  const set = new Set(['255.255.255.255']);
  for (const a of ipv4Interfaces()) {
    set.add(intToIp((ipToInt(a.address) | ~ipToInt(a.netmask)) >>> 0));
  }
  return [...set];
}

function cleanAddress(addr) {
  return String(addr || '').replace(/^::ffff:/, '');
}

function parseTarget(text) {
  const m = String(text || '').trim().match(/^([a-zA-Z0-9.\-]+)(?::(\d{1,5}))?$/);
  if (!m) return null;
  return { host: m[1], port: m[2] ? Number(m[2]) : DEFAULT_PORT };
}

// Gives up on a connection that isn't established within CONNECT_TIMEOUT.
// (The request's own timeout only covers an idle connection once it's up.)
function limitConnect(req) {
  const timer = setTimeout(() => req.destroy(new Error('connect timeout')), CONNECT_TIMEOUT);
  req.on('socket', (sock) => {
    if (!sock.connecting) clearTimeout(timer);
    else sock.once('connect', () => clearTimeout(timer));
  });
  req.on('close', () => clearTimeout(timer));
}

// Connection-level failures (as opposed to the peer answering with an error).
function isNetworkError(err) {
  return /ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EPIPE|timeout|socket hang up/i.test(String(err && (err.code || err.message)));
}

class SyncEngine extends EventEmitter {
  // opts.handler is the folder layer:
  //   receive(records, peer)          records that arrived from a peer
  //   wantsFor(replica)               files we'd like that peer to upload
  //   openForServe(hash, path)        { abs, size, mtime } of a file we can send
  //   acceptUpload(header, peer)      { partPath, finish(), fail(err) } or throws
  //   onWants(wants, peer)            a peer asked us to upload these files
  constructor(opts) {
    super();
    this.index = opts.index;
    this.handler = opts.handler;
    this.id = opts.index.deviceId;
    this.name = opts.deviceName;
    this.platform = opts.platform || process.platform;
    this.preferredPort = opts.port || DEFAULT_PORT;
    this.discoveryPort = opts.discoveryPort || DEFAULT_DISCOVERY_PORT;
    this.manualPeers = opts.manualPeers || [];
    this.knownPeers = opts.knownPeers || [];
    this.log = opts.log || (() => {});
    this.port = null;
    this.peers = new Map();
    this.foreign = new Map();
    this.syncing = new Set();
    this.resync = new Set();
    this.syncTimers = new Map();
    this.links = new Set(); // peers we hold a long-poll to
    this.waiters = new Set(); // long-polls peers hold to us
    this.requests = new Set(); // outgoing requests in flight
    this.timers = [];
    this.pushTimer = null;
    this.running = false;
    this.listenError = null;
    this.setCode(opts.code, true);
  }

  get replica() {
    return this.index.replicaId;
  }

  // ---------- lifecycle ----------

  async start() {
    this.running = true;
    this._onIndexChanged = () => this._schedulePush();
    this.index.on('changed', this._onIndexChanged);
    try {
      await this._listen();
    } catch (err) {
      this.listenError = err.message;
      this.log('listen failed:', err.message);
    }
    this._startDiscovery();
    this.timers.push(setInterval(() => this._announce(), ANNOUNCE_INTERVAL));
    this.timers.push(setInterval(() => this._probeTick(), PROBE_INTERVAL));
    this.timers.push(setInterval(() => this._checkPeers(), 2000));
    this.timers.push(setInterval(() => this.syncAll(), PERIODIC_SYNC));
    this._probeTick();
  }

  stop() {
    this.running = false;
    if (this._onIndexChanged) this.index.off('changed', this._onIndexChanged);
    this._dropConnections();
    for (const t of this.timers) clearInterval(t);
    for (const t of this.syncTimers.values()) clearTimeout(t);
    clearTimeout(this.pushTimer);
    this.timers = [];
    this.syncTimers.clear();
    for (const p of this.peers.values()) p.online = false;
    if (this.udp) {
      try {
        this.udp.close();
      } catch {}
      this.udp = null;
    }
    if (this.server) {
      this.server.close();
      if (this.server.closeAllConnections) this.server.closeAllConnections();
      this.server = null;
    }
  }

  // ---------- configuration ----------

  setCode(code, silent) {
    this.key = deriveKey(code);
    this.fp = crypto.createHash('sha256').update(this.key).update('fingerprint').digest('hex').slice(0, 16);
    if (silent) return;
    this.peers.clear();
    this.foreign.clear();
    this._dropConnections();
    this._emitPeers();
    this._announce();
    this._probeTick();
  }

  setDeviceName(name) {
    this.name = name;
    this._announce();
  }

  setManualPeers(list) {
    this.manualPeers = list;
    this._probeTick();
  }

  // ---------- public API ----------

  getPeers() {
    return [...this.peers.values()].map((p) => ({
      id: p.id,
      name: p.name,
      platform: p.platform,
      replica: p.replica,
      address: p.address,
      port: p.port,
      online: p.online,
      reachable: p.reachable !== false,
      lastSeen: p.lastSeen,
      lastSyncAt: p.lastSyncAt,
      lastError: p.lastError || null,
    }));
  }

  getForeign() {
    return [...this.foreign.values()].map((f) => ({ ...f }));
  }

  peerByReplica(replica) {
    for (const p of this.peers.values()) if (p.replica === replica) return p;
    return null;
  }

  syncAll() {
    for (const p of this.peers.values()) if (p.online) this._scheduleSync(p.id, 0);
    this._schedulePush();
  }

  // Our list of wanted files changed: tell peers waiting on a long-poll.
  wakeWants() {
    for (const w of [...this.waiters]) {
      const wants = this.handler.wantsFor(w.replica);
      if (wants.length) this._finishWaiter(w, this._page(w.msg, wants));
    }
  }

  // Asks a host directly who it is. Pairs with it when the code matches.
  probe(host, port) {
    return new Promise((resolve, reject) => {
      const req = http.get({ host, port: port || DEFAULT_PORT, path: '/api/hello', timeout: 2500 }, (res) => {
        readBody(res, 64 * 1024).then((buf) => {
          let hello;
          try {
            hello = JSON.parse(buf.toString('utf8'));
          } catch {
            return reject(new Error('not a FolderBridge device'));
          }
          if (!hello || hello.app !== APP_TAG || typeof hello.id !== 'string') return reject(new Error('not a FolderBridge device'));
          if (hello.id !== this.id) {
            if (hello.fp === this.fp) this._touchPeer(hello, host, 'probe');
            else this._touchForeign(hello, host);
          }
          resolve(hello);
        }, reject);
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }

  // Downloads a file from a peer into partPath (resuming what's there).
  fetchFile(peer, { hash, path, partPath, onProgress }) {
    const offset = partSize(partPath);
    const payload = seal(this.key, { from: this._me(), hash, path, offset });
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: peer.address,
        port: peer.port,
        path: '/api/file',
        method: 'POST',
        timeout: 30000,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length },
      });
      this.requests.add(req);
      limitConnect(req);
      req.on('close', () => this.requests.delete(req));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => {
        if (isNetworkError(err)) peer.reachable = false;
        reject(err);
      });
      req.on('response', async (res) => {
        peer.reachable = true;
        try {
          if (res.statusCode !== 200) {
            const buf = await readBody(res, 64 * 1024);
            let msg = `HTTP ${res.statusCode}`;
            try {
              msg = JSON.parse(buf.toString('utf8')).error || msg;
            } catch {}
            const err = new Error(msg);
            err.status = res.statusCode;
            throw err;
          }
          const frames = readFrames(res);
          const header = await readHeader(frames, this.key);
          if (header.hash !== hash || header.offset !== offset) throw new Error('unexpected file');
          resolve(await receiveData(frames, this.key, header, partPath, onProgress));
        } catch (err) {
          res.destroy();
          reject(err);
        }
      });
      req.end(payload);
    });
  }

  // Sends a file to a peer that asked for it but can't reach us.
  uploadFile(peer, { abs, hash, path, size, mtime, offset }) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: peer.address,
        port: peer.port,
        path: '/api/upload',
        method: 'POST',
        timeout: 30000,
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      this.requests.add(req);
      limitConnect(req);
      req.on('close', () => this.requests.delete(req));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      req.on('response', (res) => {
        readBody(res, 64 * 1024).then((buf) => {
          if (res.statusCode === 200) return resolve();
          let msg = `HTTP ${res.statusCode}`;
          try {
            msg = JSON.parse(buf.toString('utf8')).error || msg;
          } catch {}
          reject(new Error(msg));
        }, reject);
      });
      writeFileFrames(req, this.key, abs, { hash, path, size, mtime, offset, from: this._me() }).catch((err) => req.destroy(err));
    });
  }

  // ---------- HTTP server ----------

  _listen() {
    return new Promise((resolve, reject) => {
      let port = this.preferredPort;
      let attempts = 0;
      const server = http.createServer((req, res) => this._handle(req, res));
      server.keepAliveTimeout = 5000;
      const onError = (err) => {
        if (err.code === 'EADDRINUSE' && attempts < 10) {
          attempts++;
          port++;
          server.listen(port, '0.0.0.0');
        } else {
          reject(err);
        }
      };
      server.on('error', onError);
      server.once('listening', () => {
        server.off('error', onError);
        server.on('error', (err) => this.log('server error:', err.message));
        this.server = server;
        this.port = server.address().port;
        resolve();
      });
      server.listen(port, '0.0.0.0');
    });
  }

  async _handle(req, res) {
    const url = (req.url || '').split('?')[0];
    try {
      if (req.method === 'GET' && url === '/api/hello') return this._json(res, 200, this._hello());
      if (req.method === 'POST' && url === '/api/upload') return await this._onUpload(req, res);
      if (req.method !== 'POST' || !['/api/push', '/api/sync', '/api/file'].includes(url)) return this._json(res, 404, { error: 'not found' });
      const body = await readBody(req, MAX_BODY);
      let msg;
      try {
        msg = unseal(this.key, body);
      } catch {
        return this._json(res, 403, { error: 'wrong connection code' });
      }
      const from = this._validFrom(msg && msg.from);
      if (!from) return this._json(res, 400, { error: 'bad request' });
      const peer = this._touchPeer(from, cleanAddress(req.socket.remoteAddress), 'http');
      if (url === '/api/push') return this._reply(res, this._onPush(msg, peer));
      if (url === '/api/file') return await this._serveFile(msg, res);
      if (msg.wait) return this._watch(msg, peer, res);
      this._reply(res, this._page(msg));
    } catch (err) {
      this.log('request failed:', err.message);
      if (!res.headersSent) this._json(res, 500, { error: 'internal error' });
      else res.destroy();
    }
  }

  _validFrom(from) {
    if (!from || typeof from.id !== 'string' || from.id === this.id) return null;
    if (!ID_RE.test(from.replica)) return null;
    return from;
  }

  _reply(res, obj) {
    const sealed = seal(this.key, obj);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': sealed.length });
    res.end(sealed);
  }

  _onPush(msg, peer) {
    const replica = msg.from.replica;
    const cursor = this.index.cursor(replica);
    // Only accept records that continue where we are; otherwise tell the
    // sender our cursor and it sends from there.
    if (Number.isSafeInteger(msg.since) && msg.since <= cursor && Array.isArray(msg.records)) {
      this.handler.receive(msg.records, peer);
      if (Number.isSafeInteger(msg.upTo)) this.index.setCursor(replica, msg.upTo);
      return { ok: true, cursor: this.index.cursor(replica), wants: this.handler.wantsFor(replica) };
    }
    return { ok: false, cursor, wants: this.handler.wantsFor(replica) };
  }

  // One page of our records the requester hasn't seen, plus what we have from
  // it (so it can push the rest) and the files we'd like it to upload.
  _page(msg, wants) {
    const replica = msg.from.replica;
    const page = this.index.recordsSince(msg.since, PAGE_RECORDS, replica);
    page.cursor = this.index.cursor(replica);
    page.wants = wants || this.handler.wantsFor(replica);
    return page;
  }

  async _serveFile(msg, res) {
    const src = typeof msg.hash === 'string' ? this.handler.openForServe(msg.hash, msg.path) : null;
    if (!src) return this._json(res, 404, { error: 'not available' });
    const offset = Number.isSafeInteger(msg.offset) ? msg.offset : 0;
    if (offset < 0 || offset > src.size) return this._json(res, 416, { error: 'bad offset' });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    try {
      await writeFileFrames(res, this.key, src.abs, { hash: msg.hash, size: src.size, mtime: src.mtime, offset });
    } catch (err) {
      this.log('sending file failed:', err.message);
      res.destroy();
    }
  }

  async _onUpload(req, res) {
    const frames = readFrames(req);
    let header;
    try {
      header = await readHeader(frames, this.key);
    } catch {
      req.destroy();
      return;
    }
    const from = this._validFrom(header.from);
    if (!from) return this._json(res, 400, { error: 'bad request' });
    const peer = this._touchPeer(from, cleanAddress(req.socket.remoteAddress), 'http');
    let job;
    try {
      job = this.handler.acceptUpload(header, peer);
    } catch (err) {
      req.resume();
      return this._json(res, 409, { error: err.message });
    }
    try {
      await receiveData(frames, this.key, header, job.partPath, job.onProgress);
      await job.finish();
      this._json(res, 200, { ok: true });
    } catch (err) {
      job.fail(err);
      if (!res.headersSent && !req.destroyed) this._json(res, 409, { error: err.message });
      else res.destroy();
    }
  }

  // ---------- long-poll, server side ----------

  _watch(msg, peer, res) {
    const page = this._page(msg);
    if (page.records.length || page.wants.length || page.last > (msg.since || 0)) return this._reply(res, page);
    const waiter = { msg, replica: msg.from.replica, res, done: false };
    waiter.timer = setTimeout(() => this._finishWaiter(waiter, this._page(msg)), WATCH_HOLD);
    res.on('close', () => this._dropWaiter(waiter));
    this.waiters.add(waiter);
  }

  _wakeWaiters() {
    for (const w of [...this.waiters]) {
      const page = this._page(w.msg);
      if (page.records.length || page.wants.length || page.last > (w.msg.since || 0)) this._finishWaiter(w, page);
    }
  }

  _finishWaiter(w, body) {
    if (w.done) return;
    this._dropWaiter(w);
    try {
      this._reply(w.res, body);
    } catch {}
  }

  _dropWaiter(w) {
    w.done = true;
    clearTimeout(w.timer);
    this.waiters.delete(w);
  }

  _dropConnections() {
    for (const w of [...this.waiters]) {
      this._dropWaiter(w);
      w.res.destroy();
    }
    for (const req of this.requests) req.destroy();
    this.requests.clear();
  }

  _json(res, status, obj) {
    const body = Buffer.from(JSON.stringify(obj));
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length });
    res.end(body);
  }

  _post(peer, urlPath, obj, timeout) {
    const payload = seal(this.key, obj);
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: peer.address,
        port: peer.port,
        path: urlPath,
        method: 'POST',
        timeout,
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': payload.length },
      });
      this.requests.add(req);
      limitConnect(req);
      req.on('close', () => this.requests.delete(req));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', (err) => {
        if (isNetworkError(err)) peer.reachable = false;
        reject(err);
      });
      req.on('response', (res) => {
        peer.reachable = true;
        readBody(res, MAX_BODY).then((buf) => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(unseal(this.key, buf));
          } catch {
            reject(new Error('could not decrypt reply'));
          }
        }, reject);
      });
      req.end(payload);
    });
  }

  // ---------- discovery ----------

  _hello() {
    return { app: APP_TAG, proto: PROTO, id: this.id, name: this.name, platform: this.platform, port: this.port, replica: this.replica, fp: this.fp };
  }

  _me() {
    return { id: this.id, name: this.name, platform: this.platform, port: this.port, replica: this.replica };
  }

  _startDiscovery() {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (err) => this.log('udp error:', err.message));
    sock.on('message', (buf, rinfo) => this._onAnnounce(buf, rinfo));
    sock.bind(this.discoveryPort, () => {
      try {
        sock.setBroadcast(true);
      } catch {}
      this._announce();
    });
    this.udp = sock;
  }

  _announce(target) {
    if (!this.udp || !this.port) return;
    const msg = Buffer.from(JSON.stringify({ ...this._hello(), reply: !!target }));
    const targets = target ? [target] : broadcastAddresses();
    if (!target) {
      // Unicast as well: some routers and mesh Wi-Fi drop broadcasts.
      for (const p of this.peers.values()) if (p.address) targets.push(p.address);
    }
    for (const addr of new Set(targets)) {
      try {
        this.udp.send(msg, this.discoveryPort, addr, () => {});
      } catch {}
    }
  }

  _onAnnounce(buf, rinfo) {
    let m;
    try {
      m = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    if (!m || m.app !== APP_TAG || typeof m.id !== 'string' || m.id === this.id) return;
    if (m.fp !== this.fp) return this._touchForeign(m, rinfo.address);
    if (!ID_RE.test(m.replica)) return;
    const wasOnline = this.peers.get(m.id)?.online;
    this._touchPeer(m, rinfo.address, 'udp');
    if (!wasOnline && !m.reply) this._announce(rinfo.address);
  }

  _touchPeer(info, address, via) {
    let p = this.peers.get(info.id);
    const cameOnline = !p || !p.online;
    if (!p) {
      p = { id: info.id, lastSyncAt: 0, ack: null };
      this.peers.set(info.id, p);
    }
    const now = Date.now();
    const name = String(info.name || '').slice(0, 100) || 'device';
    const port = Number.isInteger(info.port) ? info.port : p.port;
    // A machine with several network adapters (Wi-Fi + VPN/WSL) is heard on all
    // of them; stick with the current address while it keeps working.
    if (address === p.address) p.addressSeen = now;
    const keepAddress = p.address && address !== p.address && now - (p.addressSeen || 0) < ANNOUNCE_INTERVAL * 2.5;
    if (keepAddress) address = p.address;
    if (ID_RE.test(info.replica) && info.replica !== p.replica) {
      // The other computer started over with a different folder.
      p.replica = info.replica;
      p.ack = null;
    }
    const changed = cameOnline || p.name !== name || p.address !== address || p.port !== port;
    p.name = name;
    p.platform = typeof info.platform === 'string' ? info.platform : p.platform;
    if (address && address !== p.address) {
      p.address = address;
      p.addressSeen = now;
    }
    p.port = port;
    p.lastSeen = now;
    p.online = true;
    p.via = via;
    if (this.foreign.delete(info.id) || changed) this._emitPeers();
    if (cameOnline) {
      this._startLink(p.id);
      this._pushTo(p);
    }
    return p;
  }

  _touchForeign(info, address) {
    const isNew = !this.foreign.has(info.id);
    this.foreign.set(info.id, {
      id: info.id,
      name: String(info.name || '').slice(0, 100),
      platform: info.platform,
      address,
      lastSeen: Date.now(),
    });
    const p = this.peers.get(info.id);
    if (p && p.online) p.online = false;
    if (isNew) this._emitPeers();
  }

  _probeTick() {
    const now = Date.now();
    const targets = new Map();
    const add = (text) => {
      const t = parseTarget(text);
      if (t) targets.set(`${t.host}:${t.port}`, t);
    };
    this.manualPeers.forEach(add);
    this.knownPeers.forEach(add);
    for (const p of this.peers.values()) if (p.address && p.port) add(`${p.address}:${p.port}`);
    for (const p of this.peers.values()) {
      // Peers that are announcing themselves over UDP don't need probing.
      if (p.online && now - p.lastSeen < PROBE_WHEN_SILENT) targets.delete(`${p.address}:${p.port}`);
    }
    for (const t of targets.values()) this.probe(t.host, t.port).catch(() => {});
  }

  _checkPeers() {
    const now = Date.now();
    let changed = false;
    for (const p of this.peers.values()) {
      if (p.online && now - p.lastSeen > PEER_TIMEOUT) {
        p.online = false;
        changed = true;
      }
    }
    for (const [id, f] of this.foreign) {
      if (now - f.lastSeen > PEER_TIMEOUT * 2) {
        this.foreign.delete(id);
        changed = true;
      }
    }
    if (changed) this._emitPeers();
  }

  _emitPeers() {
    this.emit('peers', this.getPeers(), this.getForeign());
  }

  // ---------- push, client side ----------

  // Index changes come in bursts (a scan can record thousands of files), so
  // waiting long-polls are answered and pushes started once per burst.
  _schedulePush() {
    if (this.pushTimer || !this.running) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this._wakeWaiters();
      for (const p of this.peers.values()) if (p.online) this._pushTo(p);
    }, PUSH_DELAY);
  }

  // Sends a peer every record it hasn't acknowledged, page by page.
  async _pushTo(p) {
    if (!this.running) return;
    if (p.pushing) {
      p.pushAgain = true;
      return;
    }
    p.pushing = true;
    try {
      for (let rounds = 0; rounds < 10000; rounds++) {
        if (!this.running || !p.online || !p.replica) return;
        if (p.ack === null) {
          const r = await this._post(p, '/api/push', { from: this._me(), since: null, records: [] }, 15000);
          this._onReply(r, p);
          if (p.ack === null) return;
          continue;
        }
        const since = p.ack;
        const page = this.index.recordsSince(since, PAGE_RECORDS, p.replica);
        if (page.last <= since) return;
        const r = await this._post(p, '/api/push', { from: this._me(), since, upTo: page.last, records: page.records }, 60000);
        this._onReply(r, p);
        if (r.ok && !page.more && p.ack >= page.last) return;
      }
    } catch (err) {
      this.log(`push to ${p.name} failed: ${err.message}`);
    } finally {
      p.pushing = false;
      if (p.pushAgain) {
        p.pushAgain = false;
        this._pushTo(p);
      }
    }
  }

  _onReply(r, p) {
    if (!r) return;
    if (Number.isSafeInteger(r.cursor) && r.cursor >= 0) p.ack = r.cursor;
    if (Array.isArray(r.wants) && r.wants.length) this.handler.onWants(r.wants, p);
  }

  // ---------- long-poll, client side ----------

  _startLink(id) {
    if (!this.running || this.links.has(id)) return;
    this.links.add(id);
    this._runLink(id).finally(() => this.links.delete(id));
  }

  // While a peer is online: catch up, then keep a long-poll open so its
  // changes arrive the moment they happen.
  async _runLink(id) {
    let caughtUp = false;
    let failures = 0;
    while (this.running) {
      const p = this.peers.get(id);
      if (!p || !p.online || !p.address || !p.port || !p.replica) return;
      try {
        if (!caughtUp) {
          await this._pull(p);
          this._markSynced(p);
          caughtUp = true;
        } else {
          const res = await this._post(p, '/api/sync', { from: this._me(), since: this.index.cursor(p.replica), wait: true }, WATCH_TIMEOUT);
          this._applyPage(res, p);
          if (res.more) caughtUp = false;
        }
        failures = 0;
      } catch (err) {
        caughtUp = false;
        if (!failures++) this.log(`connection to ${p.name} failed: ${err.message}`);
        p.lastError = err.message;
        await new Promise((r) => setTimeout(r, Math.min(30000, 2000 * failures)).unref());
      }
    }
  }

  // ---------- pulling ----------

  async _pull(p) {
    for (let pages = 0; pages < 100000; pages++) {
      const res = await this._post(p, '/api/sync', { from: this._me(), since: this.index.cursor(p.replica) }, 60000);
      this._applyPage(res, p);
      if (!res.more) return;
    }
  }

  _applyPage(res, p) {
    if (!res || !p.replica) return;
    if (Array.isArray(res.records) && res.records.length) this.handler.receive(res.records, p);
    if (Number.isSafeInteger(res.last)) this.index.setCursor(p.replica, res.last);
    this._onReply({ cursor: res.cursor, wants: res.wants }, p);
    // The peer is missing some of our records: send them.
    if (Number.isSafeInteger(res.cursor) && this.index.recordsSince(res.cursor, 1, p.replica).last > res.cursor) this._pushTo(p);
  }

  _markSynced(p) {
    const first = !p.lastSyncAt || p.lastError;
    p.lastSyncAt = Date.now();
    p.lastError = null;
    if (first) this._emitPeers();
  }

  _scheduleSync(id, delay) {
    if (this.syncTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.syncTimers.delete(id);
      this._syncWith(id);
    }, delay);
    this.syncTimers.set(id, timer);
  }

  async _syncWith(id) {
    const p = this.peers.get(id);
    if (!p || !p.online || !p.address || !p.port) return;
    if (this.syncing.has(id)) {
      this.resync.add(id);
      return;
    }
    this.syncing.add(id);
    try {
      await this._pull(p);
      this._markSynced(p);
    } catch (err) {
      p.lastError = err.message;
      this.log(`sync with ${p.name} failed: ${err.message}`);
    } finally {
      this.syncing.delete(id);
      if (this.resync.delete(id)) this._scheduleSync(id, 100);
    }
  }
}

module.exports = { SyncEngine, localAddresses, parseTarget, deriveKey, DEFAULT_PORT, DEFAULT_DISCOVERY_PORT };
