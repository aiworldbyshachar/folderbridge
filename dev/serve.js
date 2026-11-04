'use strict';
// Static file server for previewing the renderer in a browser with the mock API:
//   node dev/serve.js  ->  http://localhost:5179/src/renderer/index.html
// Query options: ?lang=he  &state=syncing|alone|paused|conflicts|confirm-delete|unavailable|problems  &empty  &platform=darwin
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const types = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
};

http
  .createServer((req, res) => {
    const file = path.normalize(path.join(root, decodeURIComponent(req.url.split('?')[0])));
    if (!file.startsWith(root)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('not found');
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  })
  .listen(5179, () => console.log('preview at http://localhost:5179/src/renderer/index.html'));
