'use strict';
// CON-013 L9 (inventory mach-adv-cleanliness, mach-findings-rules): scratch and files
// outside the repo, and Temp hygiene. candidates() only LISTS; applyCleanup() acts only
// with consent, only on ids the user picked from that list, and only through the
// Recycle Bin (an injected recycle in tests; fsutil.recycleWindows otherwise). There is
// no direct delete anywhere in this file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const H = 3600 * 1000;
// Test runs create their scratch hours ago, not days: a cutoff in days never fires
// (the measured "pytest cutoff can never fire" finding). Younger dirs may belong to a
// live suite and are never offered.
const TEMP_SCRATCH_HOURS = 3;
const TEMP_SCRATCH_RE = /^(pytest-|pytest_|cc-test-|cc-[a-z]+-)/i;
const REPO_SCRATCH_HOURS = 24;
const REPO_SCRATCH_RE = /^(scratch[^\\/]*|tmp|temp|[^\\/]*\.log|[^\\/]*\(copy\)[^\\/]*|[^\\/]*\.tmp|[^\\/]*~)$/i;
const OUTSIDE_DAYS = 7;
// The Temp hygiene alarm line (machine_insights.TEMP_ALARM): Temp file COUNT is logon
// time (~0.2 ms per file), measured on the author's machine; a variable for others.
const TEMP_ALARM = 300000;
const WALK_CAP = 2000000;

function idOf(where, p) {
  return where + ':' + crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 12);
}

// {files, bytes, newest} of a file or a tree (capped).
function measure(p, cap) {
  cap = cap || WALK_CAP;
  let files = 0; let bytes = 0; let newest = 0;
  const stack = [p];
  while (stack.length && files < cap) {
    const cur = stack.pop();
    let st;
    try { st = fs.lstatSync(cur); } catch (e) { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      let names = [];
      try { names = fs.readdirSync(cur); } catch (e) { names = []; }
      if (!names.length) newest = Math.max(newest, st.mtimeMs);
      for (const n of names) stack.push(path.join(cur, n));
    } else {
      files++; bytes += st.size; newest = Math.max(newest, st.mtimeMs);
    }
  }
  return { files, bytes, newest };
}

function tempCensus(dir, o) {
  o = o || {};
  const alarm = o.alarm || TEMP_ALARM;
  if (!dir || !fs.existsSync(dir)) return { files: 0, bytes: 0, alarm: false, alarm_line: alarm };
  const m = measure(dir, o.cap);
  return { files: m.files, bytes: m.bytes, alarm: m.files > alarm, alarm_line: alarm };
}

// git status --porcelain --ignored for one repo: untracked and ignored top entries.
function gitUntracked(repo) {
  return new Promise((resolve) => {
    execFile('git', ['-C', repo, 'status', '--porcelain=v1', '--ignored', '-z'], { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve([]);
      resolve(String(out).split('\0').filter((l) => /^(\?\?|!!) /.test(l)).map((l) => l.slice(3)));
    });
  });
}

// opts: {repos: [dir], temp: dir, outside: [dir], untracked(repo) -> [rel], now()}
async function candidates(opts) {
  opts = opts || {};
  const now = opts.now ? opts.now() : Date.now();
  const untracked = opts.untracked || gitUntracked;
  const out = [];
  const add = (where, p, why) => {
    const m = measure(p);
    out.push({ id: idOf(where, p), where, path: p, why, files: m.files, bytes: m.bytes, age_h: m.newest ? Math.round((now - m.newest) / H) : null, newest: m.newest });
    return m;
  };
  for (const repo of opts.repos || []) {
    let rels = [];
    try { rels = await untracked(repo); } catch (e) { rels = []; }
    for (const rel0 of rels) {
      const rel = String(rel0).replace(/[\\/]+$/, '');
      if (!rel || /[\\/]/.test(rel)) continue; // top-level entries only
      if (!REPO_SCRATCH_RE.test(rel)) continue;
      const p = path.join(repo, rel);
      const m = measure(p);
      if (!m.newest || now - m.newest < REPO_SCRATCH_HOURS * H) continue;
      add('repo', p, 'untracked scratch in the repo, untouched for ' + Math.round((now - m.newest) / H) + ' h');
    }
  }
  if (opts.temp) {
    let names = [];
    try { names = fs.readdirSync(opts.temp); } catch (e) { names = []; }
    for (const n of names.sort()) {
      if (!TEMP_SCRATCH_RE.test(n)) continue;
      const p = path.join(opts.temp, n);
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      const m = measure(p);
      const newest = m.newest || st.mtimeMs;
      if (now - newest < TEMP_SCRATCH_HOURS * H) continue;
      add('temp', p, 'test-run scratch in Temp, untouched for ' + Math.round((now - newest) / H) + ' h (Temp file count is logon time)');
    }
  }
  for (const dir of opts.outside || []) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (e) { names = []; }
    for (const n of names.sort()) {
      const p = path.join(dir, n);
      const m = measure(p);
      if (!m.newest || now - m.newest < OUTSIDE_DAYS * 24 * H) continue;
      add('outside', p, 'scratch outside the repo, untouched for ' + Math.round((now - m.newest) / (24 * H)) + ' days');
    }
  }
  return out;
}

// opts: {consent: true, recycle(path)}. Only ids from `list`; every one to the Recycle Bin.
async function applyCleanup(list, accept, opts) {
  opts = opts || {};
  if (opts.consent !== true) return { ok: false, error: 'cleanup needs consent: nothing is deleted automatically' };
  const ids = Array.isArray(accept) ? accept : [];
  if (!ids.length) return { ok: false, error: 'nothing chosen' };
  const byId = new Map((list || []).map((c) => [c.id, c]));
  const unknown = ids.find((x) => !byId.has(x));
  if (unknown) return { ok: false, error: 'unknown suggestion ' + String(unknown).slice(0, 40) };
  const recycle = opts.recycle || require('./fsutil').recycleWindows;
  const recycled = []; const failed = [];
  for (const id of ids) {
    try { await recycle(byId.get(id).path); recycled.push(id); } catch (e) { failed.push(id); }
  }
  return { ok: !failed.length, recycled, failed, method: 'recycle-bin' };
}

module.exports = { candidates, applyCleanup, tempCensus, measure, gitUntracked, TEMP_ALARM, TEMP_SCRATCH_HOURS, REPO_SCRATCH_HOURS, OUTSIDE_DAYS };
