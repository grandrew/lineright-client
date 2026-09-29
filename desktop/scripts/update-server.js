#!/usr/bin/env node
'use strict';
/**
 * A generic update feed for the desktop app, self-hosted.
 *
 *   node scripts/update-server.js [directory=releases] [port=8788]
 *
 * electron-updater's "generic" provider wants nothing more than a directory
 * over HTTP: `latest.yml` (Windows), `latest-mac.yml`, `latest-linux.yml`, and
 * the installers they name — which is exactly what `npm run dist` leaves in
 * dist/. Copy those files here after each build, point the app at this
 * server's URL (Settings → Update feed, or REGBOT_UPDATE_URL), and the next
 * check finds the new version.
 *
 * Range requests are honoured because the Windows differential download asks
 * for pieces of the installer by byte range.
 */
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const root = path.resolve(process.argv[2] || 'releases');
const port = Number(process.argv[3] || process.env.PORT || 8788);

const TYPES = {
  '.yml': 'text/yaml', '.yaml': 'text/yaml', '.json': 'application/json',
  '.exe': 'application/octet-stream', '.dmg': 'application/octet-stream',
  '.zip': 'application/zip', '.AppImage': 'application/octet-stream',
  '.deb': 'application/vnd.debian.binary-package', '.blockmap': 'application/octet-stream',
};

function serve(req, res) {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  const file = path.join(root, name);
  if (!file.startsWith(root) || !name) {
    res.writeHead(name ? 403 : 200, { 'content-type': 'text/plain' });
    return res.end(name ? 'no' : `regbot update feed\n${fs.existsSync(root) ? fs.readdirSync(root).join('\n') : '(empty)'}\n`);
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  let start = 0;
  let end = stat.size - 1;
  if (range) {
    if (range[1]) start = Number(range[1]);
    if (range[2]) end = Number(range[2]);
    if (!range[1] && range[2]) { start = Math.max(0, stat.size - Number(range[2])); end = stat.size - 1; }
    if (start > end || end >= stat.size) {
      res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
  }
  res.writeHead(range ? 206 : 200, {
    'content-type': type, 'content-length': end - start + 1, 'accept-ranges': 'bytes',
    'cache-control': 'no-store', ...(range ? { 'content-range': `bytes ${start}-${end}/${stat.size}` } : {}),
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file, { start, end }).pipe(res);
  console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${name} ${range ? `[${start}-${end}]` : ''} -> ${res.statusCode}`);
}

if (require.main === module) {
  http.createServer(serve).listen(port, '0.0.0.0', () => {
    console.log(`update feed for ${root} on http://127.0.0.1:${port}`);
    console.log('  put latest*.yml and the installers from dist/ in that directory');
    console.log('  in the app: Settings → Update feed → this address');
  });
}

module.exports = { serve };
