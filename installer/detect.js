'use strict';
// Detect an existing console before installing (CON-PUBLIC D), in this order:
//   1. the install marker <home>\install.json {version, path, channel};
//   2. known legacy layouts: a console/ subtree inside a Main checkout (<drive>:\Main\console)
//      and any console/ inside the Desktop portable deliveries (private build only);
//   3. a server answering on 127.0.0.1:<port>/api/info.
// Nothing found = a clean install. Detection is read-only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { layout } = require('./paths');
const { readJson, isDir, exists } = require('./fsutil');

function isConsoleDir(dir) {
  if (!isDir(dir) || !exists(path.join(dir, 'server', 'server.js'))) return false;
  const pkg = readJson(path.join(dir, 'package.json'), null);
  return !!(pkg && pkg.name === 'claude-console');
}

function readMarker(home) {
  const L = layout(home);
  const m = readJson(L.marker, null);
  if (!m || typeof m.version !== 'string') return null;
  return m;
}

function legacyCandidates(env) {
  env = env || process.env;
  const out = [];
  const drive = (env.SystemDrive || 'C:') + '\\';
  out.push(path.join(drive, 'Main', 'console'));
  return out;
}

function probeServer(port, token, timeoutMs) {
  return new Promise((resolve) => {
    const headers = { Host: '127.0.0.1:' + port };
    if (token) headers['X-Console-Token'] = token;
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/info', timeout: timeoutMs || 1500, headers }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (b.length < 65536) b += d; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(b); } catch (e) { j = null; }
        resolve({ running: true, status: res.statusCode, version: j && typeof j.version === 'string' ? j.version : null });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function readToken(dir) {
  try { return fs.readFileSync(path.join(dir, 'token'), 'utf8').trim(); } catch (e) { return null; }
}

// opts: home, legacy (array of dirs, default legacyCandidates()), port (7800),
// probe(port, token) (default probeServer), skipProbe.
async function detect(opts) {
  opts = opts || {};
  const L = layout(opts.home);
  const marker = readMarker(L.home);
  const port = opts.port || 7800;
  const probe = opts.probe || probeServer;
  const found = { home: L.home, marker: null, legacy: [], running: null, kind: 'none' };
  if (marker) {
    found.marker = marker;
    found.kind = 'marker';
  }
  for (const d of opts.legacy || legacyCandidates(opts.env)) {
    if (isConsoleDir(d)) {
      const pkg = readJson(path.join(d, 'package.json'), {});
      found.legacy.push({ path: d, version: pkg.version || null });
    }
  }
  if (found.kind === 'none' && found.legacy.length) found.kind = 'legacy';
  if (!opts.skipProbe) {
    const token = readToken(L.run) || (found.legacy[0] ? readToken(path.join(found.legacy[0].path, 'run')) : null);
    found.running = await probe(port, token);
    if (found.kind === 'none' && found.running) found.kind = 'running';
  }
  return found;
}

module.exports = { detect, readMarker, isConsoleDir, legacyCandidates, probeServer, readToken };
