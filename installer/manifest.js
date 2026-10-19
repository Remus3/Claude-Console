'use strict';
// Release manifest (CON-PUBLIC D/E): every release ships MANIFEST.json with the SHA-256
// of each file. The manifest decides what is "the code" of a release; user data and
// machine state are never part of it.
const fs = require('fs');
const path = require('path');
const { walk, sha256File, readJson } = require('./fsutil');

const MANIFEST = 'MANIFEST.json';

// Never part of a release: deps (installed with npm ci), user data, run state, drops,
// logs, the merge base, and conflict side files an update leaves behind.
const SKIP_DIRS = new Set(['node_modules', 'data', 'run', 'drops', '.base', '.git', 'backups', 'reports', 'cache']);
function skipRelease(rel, isDir) {
  const parts = rel.split('/');
  if (isDir) return parts.some((p) => p === 'node_modules' || p === '.git') || (parts.length === 1 && SKIP_DIRS.has(rel));
  if (rel === MANIFEST) return true;
  if (/\.(log|tmp)$/i.test(rel)) return true;
  if (/\.(new|local|orig|rej)$/i.test(rel)) return true;
  return false;
}

function buildManifest(dir, meta) {
  meta = meta || {};
  const files = {};
  for (const rel of walk(dir, skipRelease)) files[rel] = sha256File(path.join(dir, ...rel.split('/')));
  return {
    name: meta.name || 'claude-console',
    version: meta.version,
    channel: meta.channel || 'stable',
    created: meta.created || new Date().toISOString(),
    files,
  };
}

function readManifest(dir) {
  const m = readJson(path.join(dir, MANIFEST), null);
  if (!m || typeof m !== 'object' || !m.files || typeof m.files !== 'object') return null;
  return m;
}

// Every file of the manifest present with its hash. Returns {ok, missing[], mismatch[]}.
function verifyTree(dir, manifest) {
  const missing = [];
  const mismatch = [];
  for (const [rel, sum] of Object.entries(manifest.files)) {
    if (!safeRel(rel)) { mismatch.push(rel); continue; }
    const f = path.join(dir, ...rel.split('/'));
    let h = null;
    try { h = sha256File(f); } catch (e) { missing.push(rel); continue; }
    if (h !== sum) mismatch.push(rel);
  }
  return { ok: !missing.length && !mismatch.length, missing, mismatch };
}

// A manifest path is relative, forward-slash, no '..', no drive, no leading slash.
function safeRel(rel) {
  return typeof rel === 'string' && rel.length > 0 && rel.length < 400 && !/^[\\/]/.test(rel) && !/^[A-Za-z]:/.test(rel) &&
    !rel.includes('\\') && !rel.split('/').some((p) => p === '..' || p === '.' || p === '');
}

function writeManifest(dir, manifest) {
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');
}

module.exports = { MANIFEST, buildManifest, readManifest, verifyTree, skipRelease, safeRel, writeManifest };
