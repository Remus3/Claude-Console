'use strict';
// `claude-console contribute` (CON-PUBLIC D): bundle the local modifications against
// .base/<version> as one patch, scrub it (no paths, emails, tokens, ids), save it under
// reports/, and offer a prefilled GitHub issue URL. Nothing is sent unless the user
// confirms; sending uses `gh issue create --body-file` when gh is present (decision
// 2026-10-18, G5 lane: a draft PR needs a fork and a push, which the console must not do
// on its own; an issue carrying the patch is the same review path without it).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { layout, stamp } = require('./paths');
const { localMods } = require('./merge');
const { readMarker } = require('./detect');
const { exists } = require('./fsutil');

const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Scrubber shared by the patch, the crash report and the recovery prompt (CON-013 L3
// extends it, addendum e.2). o: home, localDir, baseDir, username, hostname, token (the
// console token), machineDir (<dataDir>/machine: anything under it goes), extra (literals).
function scrub(text, o) {
  o = o || {};
  let s = String(text);
  if (o.machineDir) {
    for (const form of [o.machineDir, o.machineDir.replace(/\\/g, '/'), o.machineDir.replace(/\\/g, '\\\\')]) {
      s = s.replace(new RegExp(reEsc(form) + '[^\\s"\'<>]*', 'gi'), '<MACHINE-DATA>');
    }
  }
  const lits = [o.home, o.localDir, o.baseDir, os.homedir()].concat(o.extra || []).filter(Boolean).sort((a, b) => b.length - a.length);
  for (const l of lits) {
    for (const form of [l, l.replace(/\\/g, '/'), l.replace(/\\/g, '\\\\')]) s = s.split(form).join('<PATH>');
  }
  if (o.token && String(o.token).length >= 8) s = s.split(String(o.token)).join('<TOKEN>');
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<EMAIL>');
  s = s.replace(/https?:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9_-]+/g, '<URL>');
  s = s.replace(/\b(X-Console-Token\s*[:=]\s*)\S+/gi, '$1<TOKEN>');
  s = s.replace(/([?&](?:token|access_token|auth|key)=)[^\s&"'<>]+/gi, '$1<TOKEN>');
  s = s.replace(/\bsk-ant-[A-Za-z0-9_-]{8,}/g, '<TOKEN>');
  s = s.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, '<TOKEN>');
  s = s.replace(/\b(sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})/g, '<TOKEN>');
  s = s.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '<TOKEN>');
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<ID>');
  s = s.replace(/\b[0-9a-f]{32,}\b/gi, '<HEX>');
  s = s.replace(/[A-Za-z]:\\Users\\[^\\\s"'<>]+/gi, '<PATH>');
  s = s.replace(/[A-Za-z]:\/Users\/[^/\s"'<>]+/gi, '<PATH>');
  s = s.replace(/\/(home|Users)\/[^/\s"'<>]+/g, '<PATH>');
  // The user and host names anywhere (not only inside a home path); short names (< 3
  // chars) would eat ordinary words, so the needles pass below catches those instead.
  for (const [name, tag] of [[o.username, '<USER>'], [o.hostname, '<HOST>']]) {
    if (name && String(name).length >= 3) s = s.replace(new RegExp('(?<![A-Za-z0-9])' + reEsc(name) + '(?![A-Za-z0-9])', 'gi'), tag);
  }
  return s;
}

// Second pass after scrub(): needles that must not remain (case-insensitive). Returns the
// needles found (empty = clean). Needles: the given list plus <dataDir>/privacy-needles.txt
// (one per line) when needlesFile is given.
function needleHits(text, needles, needlesFile) {
  const list = (needles || []).slice();
  if (needlesFile) {
    try { for (const l of fs.readFileSync(needlesFile, 'utf8').split(/\r?\n/)) if (l.trim()) list.push(l.trim()); } catch (e) { /* none */ }
  }
  const t = String(text).toLowerCase();
  return [...new Set(list.filter((n) => n && String(n).length >= 2 && t.includes(String(n).toLowerCase())))];
}

// Unified diff of one file pair via git (no git: a whole-file replacement block).
function diffOne(rel, baseFile, localFile, git) {
  const empty = path.join(os.tmpdir(), 'cc-empty-' + process.pid);
  if (!exists(empty)) fs.writeFileSync(empty, '');
  const a = baseFile && exists(baseFile) ? baseFile : empty;
  const b = localFile && exists(localFile) ? localFile : empty;
  const r = spawnSync(git || 'git', ['diff', '--no-index', '--no-color', '--text', '-U3', '--', a, b], { windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    const at = a === empty ? '' : fs.readFileSync(a, 'utf8');
    const bt = b === empty ? '' : fs.readFileSync(b, 'utf8');
    return '--- a/' + rel + '\n+++ b/' + rel + '\n' + at.split('\n').map((l) => '-' + l).join('\n') + '\n' + bt.split('\n').map((l) => '+' + l).join('\n') + '\n';
  }
  const lines = String(r.stdout).split('\n');
  const out = [];
  for (const l of lines) {
    if (l.startsWith('diff --git ')) out.push('diff --git a/' + rel + ' b/' + rel);
    else if (l.startsWith('--- ')) out.push(a === empty ? '--- /dev/null' : '--- a/' + rel);
    else if (l.startsWith('+++ ')) out.push(b === empty ? '+++ /dev/null' : '+++ b/' + rel);
    else if (/^index [0-9a-f]+\.\.[0-9a-f]+/.test(l)) continue;
    else out.push(l);
  }
  return out.join('\n');
}

function diffStat(patch) {
  let add = 0;
  let del = 0;
  for (const l of patch.split('\n')) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l.startsWith('+')) add++;
    else if (l.startsWith('-')) del++;
  }
  return { add, del };
}

// o: home, localDir/baseDir (default from the marker), repo, now, git.
function makePatch(o) {
  o = o || {};
  const L = layout(o.home);
  const m = readMarker(L.home);
  const localDir = o.localDir || (m && m.path);
  const baseDir = o.baseDir || (m && L.base(m.version));
  if (!localDir || !baseDir || !exists(baseDir)) throw new Error('no install with a .base to diff against');
  const mods = localMods(localDir, baseDir);
  const parts = [];
  const files = [];
  for (const mod of mods) {
    const p = (d) => path.join(d, ...mod.rel.split('/'));
    const d = diffOne(mod.rel, mod.kind === 'added' ? null : p(baseDir), mod.kind === 'deleted' ? null : p(localDir), o.git);
    parts.push(d);
    files.push(Object.assign({ rel: mod.rel, kind: mod.kind }, diffStat(d)));
  }
  const raw = parts.join('\n');
  const patch = scrub(raw, { home: L.home, localDir, baseDir });
  fs.mkdirSync(L.reports, { recursive: true });
  const file = path.join(L.reports, 'contribute-' + stamp(o.now) + '.patch');
  fs.writeFileSync(file, patch);
  const version = m ? m.version : null;
  const title = 'Local changes against v' + (version || '?') + ' (' + files.length + ' file' + (files.length === 1 ? '' : 's') + ')';
  const body = 'Changes made on a local install, offered back.\n\n' + files.map((f) => '- ' + f.rel + ' (' + f.kind + ', +' + f.add + ' -' + f.del + ')').join('\n') +
    '\n\n```diff\n' + (patch.length > 5000 ? patch.slice(0, 5000) + '\n... (truncated; full patch attached by the reporter)' : patch) + '\n```\n';
  const issueUrl = o.repo ? 'https://github.com/' + o.repo + '/issues/new?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(body) : null;
  return { file, files, title, body, issueUrl, count: files.length };
}

// Sends only with confirm === true and a repo; run is injectable (tests never send).
function send(result, o) {
  if (!o || o.confirm !== true) return { sent: false, reason: 'not confirmed' };
  if (!o.repo) return { sent: false, reason: 'no repo configured' };
  const run = o.run || ((cmd, args) => spawnSync(cmd, args, { windowsHide: true, encoding: 'utf8' }));
  const has = run('gh', ['--version']);
  if (!has || has.status !== 0) return { sent: false, reason: 'gh not found', issueUrl: result.issueUrl };
  const bodyFile = result.file + '.body.md';
  fs.writeFileSync(bodyFile, result.body);
  const r = run('gh', ['issue', 'create', '--repo', o.repo, '--title', result.title, '--body-file', bodyFile]);
  return r && r.status === 0 ? { sent: true, url: String(r.stdout || '').trim() } : { sent: false, reason: 'gh failed', issueUrl: result.issueUrl };
}

module.exports = { scrub, needleHits, makePatch, send, diffStat };
