'use strict';
// Read-only folder browser for the new-pane dialog (CON-4): which drive letters exist,
// and the subdirectories of one absolute folder. Never file names, never contents,
// never a write. Only plain drive-letter paths (no UNC, no \\?\ or \\.\ device paths).
const fs = require('fs');
const path = require('path');

const MAX_DIRS = 2000;

function listDrives(opts) {
  const stat = (opts && opts.stat) || fs.statSync;
  const out = [];
  for (let c = 65; c <= 90; c++) {
    const root = String.fromCharCode(c) + ':\\';
    try {
      if (stat(root).isDirectory()) out.push(root);
    } catch (e) { /* no such drive, or not ready */ }
  }
  return out;
}

class FsError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Normalize an operator-typed path to an absolute drive-letter path, or throw 400.
// path.win32.resolve folds "..", "." and repeated separators, so the result is the
// real folder named; anything that is not "X:\..." after that is refused.
function normalizeDir(p) {
  if (typeof p !== 'string' || !p.trim()) throw new FsError(400, 'path required');
  p = p.trim().replace(/^"(.*)"$/, '$1');
  if (p.length > 1024 || /[\0<>|?*"]/.test(p)) throw new FsError(400, 'bad path');
  if (/^[A-Za-z]:$/.test(p)) p += '\\';
  if (!/^[A-Za-z]:[\\/]/.test(p)) throw new FsError(400, 'absolute drive path required (e.g. C:\\Work)');
  let n = path.win32.resolve(p);
  if (!/^[A-Za-z]:\\/.test(n)) throw new FsError(400, 'bad path');
  n = n[0].toUpperCase() + n.slice(1);
  if (n.length > 3) n = n.replace(/\\+$/, '');
  return n;
}

function parentOf(n) {
  if (/^[A-Z]:\\$/.test(n)) return null;
  const d = path.win32.dirname(n);
  return d === n ? null : d;
}

// { path, parent, dirs: [{ name, link }], truncated, error? }. A reparse point
// (junction / symlink) is listed with link: true; it is never stat'ed through here.
function listDir(p, opts) {
  opts = opts || {};
  const readdir = opts.readdir || ((d) => fs.readdirSync(d, { withFileTypes: true }));
  const max = opts.max || MAX_DIRS;
  const n = normalizeDir(p);
  const res = { path: n, parent: parentOf(n), dirs: [], truncated: false };
  let entries;
  try {
    entries = readdir(n);
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      res.error = 'access denied';
      return res;
    }
    if (e.code === 'ENOENT') throw new FsError(404, 'no such folder');
    if (e.code === 'ENOTDIR') throw new FsError(400, 'not a folder');
    res.error = 'unreadable (' + (e.code || 'error') + ')';
    return res;
  }
  for (const e of entries) {
    const link = e.isSymbolicLink();
    if (!link && !e.isDirectory()) continue;
    res.dirs.push({ name: e.name, link });
  }
  res.dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  if (res.dirs.length > max) {
    res.dirs = res.dirs.slice(0, max);
    res.truncated = true;
  }
  return res;
}

module.exports = { listDrives, listDir, normalizeDir, parentOf, FsError, MAX_DIRS };
