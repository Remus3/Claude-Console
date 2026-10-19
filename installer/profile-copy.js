'use strict';
// CON-013 L3x: copy-first adoption (addendum b.1, invariant I1). The engine opens the
// original repo ONLY through readOnlyFs(); every write method on that view throws, so a
// stray write is a crash, never a change. The copy is a full byte copy (untracked and
// gitignored files and .git included) made once into the adoption dir:
//   <adoptDir>/base   the pristine snapshot (source for the "original" side of the
//                     function check and for bisect probes; never modified)
//   <adoptDir>/copy   the working copy the chosen changes are applied to
// Decision (recorded in the lane commit): a byte copy always, never `git worktree add`
// (it writes worktree metadata and a branch into the original's .git, so the original's
// tree hash changes) and never a local clone (it loses untracked / ignored files and
// rewrites the remotes). Reverses if: the operator accepts .git metadata writes for
// worktree speed on large repos.
// Symbolic links and junctions are never followed: they are listed and not copied.
// Excluded folders (the user's choice, e.g. node_modules) are not copied; promote moves
// them across from the original so no byte is lost (profile-promote.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WRITE_METHODS = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'mkdtempSync', 'rmSync', 'rmdirSync', 'unlinkSync', 'renameSync', 'copyFileSync',
  'cpSync', 'symlinkSync', 'linkSync', 'truncateSync', 'ftruncateSync', 'chmodSync', 'chownSync', 'lchownSync', 'utimesSync', 'lutimesSync', 'futimesSync', 'openSync',
  'writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'symlink', 'truncate', 'chmod', 'utimes', 'open', 'createWriteStream'];

function inside(root, p) {
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('outside the original: ' + p);
  return abs;
}

// A read-only view of `root`. Reads resolve inside root only; every write throws EROFS.
function readOnlyFs(root) {
  root = path.resolve(root);
  const ro = {
    root,
    readFileSync: (p, o) => fs.readFileSync(inside(root, p), o),
    readdirSync: (p, o) => fs.readdirSync(inside(root, p), o),
    lstatSync: (p) => fs.lstatSync(inside(root, p)),
    statSync: (p) => fs.statSync(inside(root, p)),
    existsSync: (p) => { try { return fs.existsSync(inside(root, p)); } catch (e) { return false; } },
  };
  for (const m of WRITE_METHODS) {
    ro[m] = () => { const e = new Error('EROFS: the original is read-only to adopt (' + m + ')'); e.code = 'EROFS'; throw e; };
  }
  return Object.freeze(ro);
}

const toRel = (p) => p.split(path.sep).join('/');
const isExcluded = (rel, exclude) => (exclude || []).some((x) => { const e = String(x).replace(/\\/g, '/').replace(/\/+$/, ''); return rel === e || rel.startsWith(e + '/'); });

// Every entry under root, sorted by rel path: {rel, type: file|dir|link, size}.
// fsx is fs or a readOnlyFs view. skip(rel) prunes.
function walk(fsx, root, o) {
  o = o || {};
  const out = [];
  const rec = (rel) => {
    const abs = rel ? path.join(root, ...rel.split('/')) : root;
    let ents;
    try { ents = fsx.readdirSync(abs, { withFileTypes: true }); } catch (e) { if (!rel) throw e; return; }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of ents) {
      const r = rel ? rel + '/' + d.name : d.name;
      if (o.skip && o.skip(r)) continue;
      if (isExcluded(r, o.exclude)) { out.push({ rel: r, type: 'excluded' }); continue; }
      if (d.isSymbolicLink()) { out.push({ rel: r, type: 'link' }); continue; }
      if (d.isDirectory()) {
        // A junction reads as a directory on some Node builds: lstat tells.
        let st = null;
        try { st = fsx.lstatSync(path.join(root, ...r.split('/'))); } catch (e) { st = null; }
        if (st && st.isSymbolicLink()) { out.push({ rel: r, type: 'link' }); continue; }
        out.push({ rel: r, type: 'dir' });
        rec(r);
      } else if (d.isFile()) {
        const st = fsx.statSync(path.join(root, ...r.split('/')));
        out.push({ rel: r, type: 'file', size: st.size });
      } else out.push({ rel: r, type: 'link' });
    }
  };
  rec('');
  return out;
}

// sha256 over (type, path, bytes) of every entry, in path order. Links and excluded
// folders count by name only (they are not followed).
function treeHash(root, o) {
  o = o || {};
  const fsx = o.fs || fs;
  const h = crypto.createHash('sha256');
  for (const e of walk(fsx, root, o)) {
    h.update(e.type[0].toUpperCase() + ' ' + e.rel + '\n');
    if (e.type === 'file') h.update(fsx.readFileSync(path.join(root, ...e.rel.split('/'))));
  }
  return h.digest('hex');
}

// Per file sha256 + size, the dirs, links and excluded entries, and the tree hash.
function manifest(root, o) {
  o = o || {};
  const fsx = o.fs || fs;
  const files = {};
  const dirs = [];
  const links = [];
  const excluded = [];
  let bytes = 0;
  const h = crypto.createHash('sha256');
  for (const e of walk(fsx, root, o)) {
    h.update(e.type[0].toUpperCase() + ' ' + e.rel + '\n');
    if (e.type === 'file') {
      const b = fsx.readFileSync(path.join(root, ...e.rel.split('/')));
      h.update(b);
      files[e.rel] = { sha: crypto.createHash('sha256').update(b).digest('hex'), size: b.length };
      bytes += b.length;
    } else if (e.type === 'dir') dirs.push(e.rel);
    else if (e.type === 'link') links.push(e.rel);
    else excluded.push(e.rel);
  }
  return { schema: 1, files, dirs, links, excluded, bytes, hash: h.digest('hex') };
}

// Copies every file and dir (empty ones too) from src (read through fsx) to dst.
function copyTree(fsx, src, dst, o) {
  o = o || {};
  fs.mkdirSync(dst, { recursive: true });
  let n = 0;
  for (const e of walk(fsx, src, o)) {
    const to = path.join(dst, ...e.rel.split('/'));
    if (e.type === 'dir') fs.mkdirSync(to, { recursive: true });
    else if (e.type === 'file') {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, fsx.readFileSync(path.join(src, ...e.rel.split('/'))));
      n++;
    }
  }
  return n;
}

// Size preview before the copy (the user can exclude folders): total bytes and the
// largest top-level folders.
function sizePreview(original) {
  const ro = readOnlyFs(original);
  const top = new Map();
  let bytes = 0;
  let files = 0;
  for (const e of walk(ro, ro.root)) {
    if (e.type !== 'file') continue;
    bytes += e.size;
    files++;
    const t = e.rel.split('/')[0];
    top.set(t, (top.get(t) || 0) + e.size);
  }
  return { bytes, files, largest: [...top.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, b]) => ({ name, bytes: b })) };
}

// Makes base/ and copy/ under adoptDir from the original; verifies both against the
// manifest taken from the original at copy time. Returns {baseDir, copyDir, manifest}.
function makeCopy(original, adoptDir, o) {
  o = o || {};
  const ro = readOnlyFs(original);
  const exclude = o.exclude || [];
  const skip = (r) => isExcluded(r, exclude);
  const origHash = treeHash(ro.root, { fs: ro });
  const man = manifest(ro.root, { fs: ro, skip });
  man.excluded = walk(ro, ro.root, { exclude }).filter((e) => e.type === 'excluded').map((e) => e.rel);
  man.origHash = origHash;
  const baseDir = path.join(adoptDir, 'base');
  const copyDir = path.join(adoptDir, 'copy');
  for (const d of [baseDir, copyDir]) if (fs.existsSync(d)) throw new Error('adoption dir already holds ' + path.basename(d));
  copyTree(ro, ro.root, baseDir, { exclude });
  copyTree(fs, baseDir, copyDir);
  if (manifest(baseDir).hash !== man.hash || manifest(copyDir).hash !== man.hash) throw new Error('copy verification failed: the copy does not match the original byte for byte');
  return { baseDir, copyDir, manifest: man, copyHash: man.hash, origHash };
}

module.exports = { readOnlyFs, walk, treeHash, manifest, copyTree, makeCopy, sizePreview, isExcluded, toRel, WRITE_METHODS };
