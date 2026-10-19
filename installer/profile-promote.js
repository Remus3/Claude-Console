'use strict';
// CON-013 L3x: promote the conformed copy, undo a promote, and the separate, later,
// opt-in removal of the original (addendum b.6-b.8, invariants I3, I4, I6).
//
// - promote() refuses without the user's "works" confirmation for THIS copy state (the
//   copy's tree hash, .git excluded), refuses when the last function check on that state
//   was not clean, and refuses when the original changed since the copy (listing what).
//   Methods: "swap" (default): the original is renamed beside itself to
//   <name>.pre-profile-<stamp> and the copy takes its path; "git": the copy's commits
//   are fetched into the original and fast-forwarded (the user committed them in the
//   copy; the engine never commits and never pushes).
// - unpromote() puts the original back byte for byte (swap) or resets the branch to the
//   recorded pre-promote ref with --keep (git), then compares the tree hash.
// - removeOriginal() exists only after a promote, never in the same run, at the earliest
//   24 h after it by default, with the typed phrase "remove original <name>", to the
//   Recycle Bin or into a zip archive (sha256 recorded, unzip verified, then the folder
//   to the Recycle Bin). There is no direct unlink anywhere in this file.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const CP = require('./profile-copy');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = f + '.' + process.pid + '.tmp'; fs.writeFileSync(t, JSON.stringify(o, null, 2) + '\n'); fs.renameSync(t, f); };
const stampOf = (d) => { const p = (n) => String(n).padStart(2, '0'); return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); };

const MIN_AGE_HOURS = 24;

// The hash a "works" confirmation is pinned to: the copy's working tree (.git excluded,
// so committing the confirmed state in the copy does not make it stale).
function confirmHash(copyDir) { return CP.treeHash(copyDir, { skip: (r) => r === '.git' || r.startsWith('.git/') }); }

function gitRun(dir, args) {
  const r = spawnSync('git', ['-C', dir].concat(args), { encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').split('\n')[0] };
}

// Files of the original that differ from the copy-time manifest (I1 guard before promote).
function originalChanges(ad) {
  const now = CP.manifest(ad.original, { fs: CP.readOnlyFs(ad.original), skip: (r) => CP.isExcluded(r, ad.exclude || []) });
  const was = readJson(path.join(ad.dir, 'copy-manifest.json')) || { files: {} };
  const out = [];
  for (const [rel, f] of Object.entries(now.files)) if (!was.files[rel]) out.push('added ' + rel); else if (was.files[rel].sha !== f.sha) out.push('changed ' + rel);
  for (const rel of Object.keys(was.files)) if (!now.files[rel]) out.push('removed ' + rel);
  return out;
}

function refuse(line, extra) { return Object.assign({ ok: false, code: 1, line: 'refused: ' + line }, extra || {}); }

// Places src at dst: a rename when both are on one volume, else a verified byte copy (the
// source then stays where it was - nothing is deleted).
function place(src, dst) {
  try { fs.renameSync(src, dst); return 'rename'; } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    CP.copyTree(fs, src, dst);
    if (CP.treeHash(src) !== CP.treeHash(dst)) throw new Error('the copy into ' + path.basename(dst) + ' did not verify');
    return 'copy';
  }
}

// o: {method: 'swap'|'git', confirm, runId, now}
function promote(ad, o) {
  o = o || {};
  const method = o.method || 'swap';
  if (!['swap', 'git'].includes(method)) return refuse('promote method is swap or git');
  if (ad.promote) return refuse('this adoption is already promoted (' + ad.promote.method + ')');
  if (!ad.applied) return refuse('nothing applied to the copy yet');
  const cf = readJson(path.join(ad.dir, 'confirm.json'));
  if (!cf || !cf.hash) return refuse('promote needs your "works" confirmation first (profile adopt works ' + ad.id + ' --type works)');
  const h = confirmHash(ad.copyDir);
  if (cf.hash !== h) return refuse('the copy changed after you confirmed it works (confirmed ' + cf.hash.slice(0, 12) + ', now ' + h.slice(0, 12) + '); run the check and confirm again');
  if (!ad.lastCheck || ad.lastCheck.hash !== h || ad.lastCheck.verdict !== 'passed') return refuse('the function check of this copy state did not pass; promotion is blocked');
  if (!fs.existsSync(ad.original)) return refuse('the original is not at its path any more');
  const changed = originalChanges(ad);
  if (changed.length) return refuse('the original changed since the copy (' + changed.length + '): ' + changed.slice(0, 6).join(', ') + (changed.length > 6 ? ', ...' : ''), { changed });
  if (o.confirm !== true) return { ok: true, code: 0, dryRun: true, line: 'dry run: promote ' + ad.id + ' by ' + method + ' (add --apply --yes)' };
  const at = (o.now || new Date());
  if (method === 'git') return promoteGit(ad, o, at);
  const aside = path.join(path.dirname(ad.original), path.basename(ad.original) + '.pre-profile-' + stampOf(at));
  if (fs.existsSync(aside)) return refuse('the aside name ' + path.basename(aside) + ' is taken');
  try { fs.renameSync(ad.original, aside); } catch (e) { return refuse('cannot move the original aside (' + (e.code || e.message) + '); close programs that use it'); }
  const moved = [];
  let how = null;
  try {
    how = place(ad.copyDir, ad.original);
    for (const rel of ad.excludedPresent || []) {
      const from = path.join(aside, ...rel.split('/'));
      if (!fs.existsSync(from)) continue;
      const to = path.join(ad.original, ...rel.split('/'));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      moved.push(rel);
    }
  } catch (e) {
    // Roll back: excluded folders back, the placed copy back into the adoption, the original home.
    for (const rel of moved.reverse()) { try { fs.renameSync(path.join(ad.original, ...rel.split('/')), path.join(aside, ...rel.split('/'))); } catch (x) { /* reported below */ } }
    if (how === 'rename' && fs.existsSync(ad.original)) { try { fs.renameSync(ad.original, ad.copyDir); } catch (x) { /* reported below */ } }
    if (how === 'copy' && fs.existsSync(ad.original)) { try { fs.renameSync(ad.original, path.join(ad.dir, 'failed-promote-' + stampOf(at))); } catch (x) { /* reported below */ } }
    try { fs.renameSync(aside, ad.original); } catch (x) { return refuse('promote failed (' + e.message + ') and the original is at ' + aside); }
    return refuse('promote failed and was rolled back: ' + e.message);
  }
  const rec = { method: 'swap', at: at.toISOString(), runId: o.runId || null, aside, placed: how, excludedMoved: moved, promotedHash: CP.treeHash(ad.original) };
  writeJson(path.join(ad.dir, 'promote.json'), rec);
  return { ok: true, code: 0, promote: rec, line: 'promoted: the conformed copy is now ' + path.basename(ad.original) + '; the original is kept as ' + path.basename(aside) + ' (remove it later, separately, if you want)' };
}

function promoteGit(ad, o, at) {
  if (!fs.existsSync(path.join(ad.original, '.git'))) return refuse('git promote needs the original to be a git repo');
  const st = gitRun(ad.copyDir, ['status', '--porcelain']);
  if (!st.ok) return refuse('the copy is not a git repo: ' + st.err);
  if (st.out) return refuse('git promote needs the confirmed changes committed in the copy (git -C <copy> status is not clean); the engine never commits');
  const ost = gitRun(ad.original, ['status', '--porcelain']);
  if (!ost.ok || ost.out) return refuse('the original has uncommitted changes: ' + (ost.out ? ost.out.split('\n').slice(0, 4).join('; ') : ost.err));
  const head = gitRun(ad.original, ['rev-parse', 'HEAD']);
  if (!head.ok || head.out !== ad.origHead) return refuse('the original HEAD moved since the copy');
  const ch = gitRun(ad.copyDir, ['rev-parse', 'HEAD']);
  if (ch.out === head.out) return refuse('the copy has no commits beyond the original; commit the conformed state in the copy first');
  const br = gitRun(ad.original, ['symbolic-ref', '--short', 'HEAD']);
  if (!br.ok) return refuse('the original is on a detached HEAD');
  const f = gitRun(ad.original, ['fetch', '--no-tags', '--quiet', ad.copyDir, 'HEAD']);
  if (!f.ok) return refuse('fetch from the copy failed: ' + f.err);
  const m = gitRun(ad.original, ['merge', '--ff-only', '--quiet', 'FETCH_HEAD']);
  if (!m.ok) return refuse('fast-forward failed (' + m.err + '); nothing merged');
  const rec = { method: 'git', at: at.toISOString(), runId: o.runId || null, branch: br.out, preRef: head.out, postRef: gitRun(ad.original, ['rev-parse', 'HEAD']).out };
  writeJson(path.join(ad.dir, 'promote.json'), rec);
  return { ok: true, code: 0, promote: rec, line: 'promoted: ' + br.out + ' fast-forwarded to the conformed copy (' + rec.postRef.slice(0, 10) + '); never pushed' };
}

// Undo a promote (also the automatic un-promote after a WORSE re-check).
function unpromote(ad, o) {
  o = o || {};
  const rec = ad.promote;
  if (!rec) return refuse('not promoted');
  if (ad.removed) return refuse('the original was removed (' + ad.removed.method + '); restore it from ' + (ad.removed.method === 'zip' ? 'the archive ' + path.basename(ad.removed.zip) : 'the Recycle Bin') + ' first');
  if (o.confirm !== true) return { ok: true, code: 0, dryRun: true, line: 'dry run: un-promote ' + ad.id + ' (add --apply --yes)' };
  const at = o.now || new Date();
  if (rec.method === 'git') {
    const r = gitRun(ad.original, ['reset', '--keep', rec.preRef]);
    if (!r.ok) return refuse('reset to the pre-promote ref failed: ' + r.err);
    const h = gitRun(ad.original, ['rev-parse', 'HEAD']).out;
    if (h !== rec.preRef) return refuse('HEAD did not read back as the pre-promote ref');
    fs.renameSync(path.join(ad.dir, 'promote.json'), path.join(ad.dir, 'promote-undone-' + stampOf(at) + '.json'));
    return { ok: true, code: 0, line: 'un-promoted: ' + rec.branch + ' is back at ' + rec.preRef.slice(0, 10) };
  }
  if (!fs.existsSync(rec.aside)) return refuse('the kept original ' + path.basename(rec.aside) + ' is missing');
  for (const rel of (rec.excludedMoved || []).slice().reverse()) {
    const from = path.join(ad.original, ...rel.split('/'));
    if (fs.existsSync(from)) fs.renameSync(from, path.join(rec.aside, ...rel.split('/')));
  }
  const keep = path.join(ad.dir, 'promoted-undone-' + stampOf(at));
  place(ad.original, keep);
  if (fs.existsSync(ad.original)) return refuse('the promoted folder could not be moved away (it was copied to ' + keep + '); move it yourself, then run again');
  fs.renameSync(rec.aside, ad.original);
  const ok = CP.treeHash(ad.original) === ad.origHash;
  fs.renameSync(path.join(ad.dir, 'promote.json'), path.join(ad.dir, 'promote-undone-' + stampOf(at) + '.json'));
  return { ok, code: ok ? 0 : 1, kept: keep, line: ok ? 'un-promoted: the original is back byte for byte; the promoted state is kept in the adoption folder' : 'un-promoted, but the original tree hash does not match the copy-time hash' };
}

function sysTar() {
  if (process.platform === 'win32') {
    const t = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(t)) return t;
  }
  return 'tar';
}
const defaultZip = async (src, zip) => { const r = spawnSync(sysTar(), ['-a', '-c', '-f', zip, '-C', src, '.'], { windowsHide: true, encoding: 'utf8' }); if (r.status !== 0) throw new Error('zip failed: ' + String(r.stderr || '').split('\n')[0]); };
const defaultUnzip = async (zip, dst) => { fs.mkdirSync(dst, { recursive: true }); const r = spawnSync(sysTar(), ['-x', '-f', zip, '-C', dst], { windowsHide: true, encoding: 'utf8' }); if (r.status !== 0) throw new Error('unzip failed: ' + String(r.stderr || '').split('\n')[0]); };

// o: {method: 'recycle'|'zip', phrase, runId, now, minAgeHours, confirm, deps: {recycle, zip, unzip}}
async function removeOriginal(ad, o) {
  o = o || {};
  const deps = o.deps || {};
  const rec = ad.promote;
  if (!rec) return refuse('remove-original exists only after a promote');
  if (rec.method !== 'swap') return refuse('a git promote keeps one folder: there is no separate original to remove');
  if (ad.removed) return refuse('the original was already removed (' + ad.removed.method + ')');
  if (rec.runId && o.runId && rec.runId === o.runId) return refuse('remove-original is never offered in the same run as promote; run it later');
  const minAge = o.minAgeHours === undefined || o.minAgeHours === null ? MIN_AGE_HOURS : Number(o.minAgeHours);
  const now = o.now || new Date();
  const ready = new Date(Date.parse(rec.at) + minAge * 3600e3);
  if (now < ready) return refuse('the earliest time to remove the original is ' + ready.toISOString().slice(0, 16).replace('T', ' ') + ' (' + minAge + ' h after promote; --min-age-hours changes it)');
  const method = o.method || 'recycle';
  if (!['recycle', 'zip'].includes(method)) return refuse('method is recycle (Recycle Bin) or zip (archive, then the Recycle Bin)');
  const name = path.basename(ad.original);
  const want = 'remove original ' + name;
  if (o.phrase !== want) return refuse('type the phrase exactly: --confirm "' + want + '"');
  if (!fs.existsSync(rec.aside)) return refuse('the kept original ' + path.basename(rec.aside) + ' is not there');
  if (typeof deps.recycle !== 'function') return refuse('no Recycle Bin adapter');
  if (o.confirm !== true) return { ok: true, code: 0, dryRun: true, line: 'dry run: ' + (method === 'zip' ? 'archive ' + path.basename(rec.aside) + ' into a zip, then send it' : 'send ' + path.basename(rec.aside)) + ' to the Recycle Bin (add --apply --yes)' };
  const out = { method, at: now.toISOString(), aside: rec.aside };
  if (method === 'zip') {
    const before = CP.treeHash(rec.aside);
    const zdir = path.join(ad.dir, 'archive');
    fs.mkdirSync(zdir, { recursive: true });
    const zip = path.join(zdir, name + '-' + stampOf(now) + '.zip');
    await (deps.zip || defaultZip)(rec.aside, zip);
    const vdir = path.join(zdir, 'verify-' + stampOf(now));
    await (deps.unzip || defaultUnzip)(zip, vdir);
    const got = CP.treeHash(vdir);
    await deps.recycle(vdir);
    if (got !== before) return refuse('the zip archive does not unpack to the original byte for byte; nothing removed (archive kept at ' + zip + ')');
    out.zip = zip;
    out.sha256 = sha(fs.readFileSync(zip));
    out.hash = before;
  }
  await deps.recycle(rec.aside);
  if (fs.existsSync(rec.aside)) return refuse('the Recycle Bin move did not take the folder; nothing else changed');
  writeJson(path.join(ad.dir, 'removed.json'), out);
  return { ok: true, code: 0, removed: out, line: method === 'zip' ? 'original archived (' + path.basename(out.zip) + ', sha256 ' + out.sha256.slice(0, 12) + ') and sent to the Recycle Bin' : 'original sent to the Recycle Bin' };
}

module.exports = { promote, unpromote, removeOriginal, confirmHash, originalChanges, MIN_AGE_HOURS, defaultZip, defaultUnzip, stampOf };
