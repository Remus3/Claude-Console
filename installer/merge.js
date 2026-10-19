'use strict';
// 3-way update merge (CON-PUBLIC D). Per file: local = the installed file, base = the
// pristine copy of the installed release (.base/<old>), new = the new release.
//
// | local vs base | new vs base | action                                              |
// | unchanged     | any         | replace with new (or drop it when new removed it)   |
// | changed       | unchanged   | keep local                                          |
// | changed       | changed     | git merge-file; clean = merged; conflict = keep the |
// |               |             | local file working, write <file>.new, report it     |
// | absent (base) | new file    | add it                                              |
// | changed       | deleted     | keep it, flag it                                    |
// Extra rows: a file only the user added is kept; a code file the user deleted comes
// back and is flagged; with no base at all (a legacy install) every differing file is a
// conflict, so nothing local is ever overwritten silently.
//
// Version skips (n -> n+k) need nothing special: the base is always the INSTALLED
// release and the new side the target release, whatever lies between.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { walk, sha256File, copyFile, exists } = require('./fsutil');
const { skipRelease } = require('./manifest');

const KEEP = new Set(['keep-local', 'keep-added', 'keep-flag']);

function hashes(dir) {
  const out = new Map();
  if (!dir || !exists(dir)) return out;
  for (const rel of walk(dir, skipRelease)) out.set(rel, sha256File(path.join(dir, ...rel.split('/'))));
  return out;
}

function planMerge(localDir, baseDir, newDir) {
  const L = hashes(localDir);
  const B = hashes(baseDir);
  const N = hashes(newDir);
  const haveBase = !!baseDir && exists(baseDir);
  const all = new Set([...L.keys(), ...B.keys(), ...N.keys()]);
  const rows = [];
  for (const rel of [...all].sort()) {
    const l = L.get(rel) || null;
    const b = B.get(rel) || null;
    const n = N.get(rel) || null;
    let action;
    if (!b) {
      if (n && !l) action = 'add';
      else if (n && l) action = l === n ? 'same' : (haveBase ? 'conflict' : 'conflict-nobase');
      else if (l) action = 'keep-added';
      else continue;
    } else if (!l) {
      action = n ? 'restore' : 'gone';
    } else if (l === b) {
      action = n ? (n === b ? 'same' : 'replace') : 'drop';
    } else if (n === b) {
      action = 'keep-local';
    } else if (!n) {
      action = 'keep-flag';
    } else if (n === l) {
      action = 'same';
    } else {
      action = 'merge';
    }
    rows.push({ rel, action });
  }
  return rows;
}

// Runs `git merge-file -p local base new`. Returns {status: 'clean'|'conflict'|'error', text}.
function mergeFile(localFile, baseFile, newFile, opts) {
  opts = opts || {};
  const git = opts.git || 'git';
  const r = spawnSync(git, ['merge-file', '-p', '-L', 'local', '-L', 'base', '-L', 'new', localFile, baseFile, newFile], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { status: 'error', text: null, error: r.error.message };
  if (r.status === 0) return { status: 'clean', text: r.stdout };
  if (r.status > 0 && r.status < 128) return { status: 'conflict', text: r.stdout };
  return { status: 'error', text: null, error: String(r.stderr || '').slice(0, 200) };
}

function isBinary(file) {
  try {
    const b = fs.readFileSync(file);
    return b.subarray(0, 8000).includes(0);
  } catch (e) {
    return true;
  }
}

// targetDir must already hold a full copy of newDir. Applies the plan into it and
// returns the report rows: {rel, action, result} with result one of
// 'new' | 'kept' | 'merged' | 'conflict' | 'flagged' | 'dropped'.
function applyMerge(plan, localDir, baseDir, newDir, targetDir, opts) {
  const p = (d, rel) => path.join(d, ...rel.split('/'));
  const out = [];
  for (const row of plan) {
    const { rel, action } = row;
    const t = p(targetDir, rel);
    if (action === 'add' || action === 'replace' || action === 'same') { out.push({ rel, action, result: 'new' }); continue; }
    if (action === 'drop' || action === 'gone') { out.push({ rel, action, result: 'dropped' }); continue; }
    if (action === 'restore') { out.push({ rel, action, result: 'flagged', note: 'deleted locally, restored from the release' }); continue; }
    if (KEEP.has(action)) {
      copyFile(p(localDir, rel), t);
      out.push({ rel, action, result: action === 'keep-flag' ? 'flagged' : 'kept', note: action === 'keep-flag' ? 'changed locally, removed upstream' : undefined });
      continue;
    }
    if (action === 'conflict' || action === 'conflict-nobase') {
      copyFile(p(localDir, rel), t);
      copyFile(p(newDir, rel), t + '.new');
      out.push({ rel, action, result: 'conflict', side: rel + '.new' });
      continue;
    }
    if (action === 'merge') {
      const lf = p(localDir, rel);
      const bf = p(baseDir, rel);
      const nf = p(newDir, rel);
      const bin = isBinary(lf) || isBinary(nf) || isBinary(bf);
      const m = bin ? { status: 'error', text: null } : mergeFile(lf, bf, nf, opts);
      if (m.status === 'clean') {
        fs.writeFileSync(t, m.text);
        out.push({ rel, action, result: 'merged' });
      } else {
        copyFile(lf, t);
        if (m.text) fs.writeFileSync(t + '.new', m.text);
        else copyFile(nf, t + '.new');
        out.push({ rel, action, result: 'conflict', side: rel + '.new' });
      }
      continue;
    }
    out.push({ rel, action, result: 'new' });
  }
  return out;
}

function summarize(rows) {
  const s = { new: 0, kept: 0, merged: 0, conflict: 0, flagged: 0, dropped: 0 };
  for (const r of rows) s[r.result] = (s[r.result] || 0) + 1;
  return s;
}

// Local modifications against the base: [{rel, kind: 'changed'|'added'|'deleted'}].
function localMods(localDir, baseDir) {
  const L = hashes(localDir);
  const B = hashes(baseDir);
  const out = [];
  for (const [rel, h] of L) {
    if (!B.has(rel)) out.push({ rel, kind: 'added' });
    else if (B.get(rel) !== h) out.push({ rel, kind: 'changed' });
  }
  for (const rel of B.keys()) if (!L.has(rel)) out.push({ rel, kind: 'deleted' });
  return out.sort((a, b) => (a.rel < b.rel ? -1 : 1));
}

module.exports = { planMerge, applyMerge, mergeFile, summarize, localMods, hashes };
