'use strict';
// CON-AUTOUPDATE: when an update's 3-way merge leaves conflicts, a headless Claude run
// re-applies the local customizations from the backup and the diff, then the update's
// self-test decides. Contract for the run (written into its prompt):
//   - for each conflicted <file>: the installed file is the user's version (still
//     working), <file>.new is the new release's version (with conflict markers when
//     git merge-file produced them); write the integrated result into <file>, keep the
//     user's intent and the release's fixes, then DELETE <file>.new;
//   - touch nothing outside the new app dir; no git, no network, no installs.
// A file counts as resolved when <file>.new is gone and <file> has no conflict markers.
//
// The run is opt-in: settings `updates.reintegrate = {"enabled": true, "command":
// [argv...]}`; `{prompt}` and `{dir}` in the argv are replaced, nothing goes through a
// shell. Point it at a wrapper that runs `claude -p` with the prompt file {prompt} in
// {dir}; a machine with its own headless spawn helper uses that helper instead.
// Disabled = the update stops at "needs review" (auto mode) or keeps the local files
// with .new sides (manual).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { layout, stamp } = require('./paths');
const { exists } = require('./fsutil');

const MARKERS = /^(<{7}|>{7})( |$)/m;

function conflictsOf(report) {
  return (report.files || []).filter((f) => f.result === 'conflict').map((f) => f.rel);
}

function buildPrompt(ctx) {
  const rels = conflictsOf(ctx.report);
  const p = (d, rel) => (d ? path.join(d, ...rel.split('/')) : '(none)');
  const lines = [
    '# Claude Console update: re-integrate local customizations',
    '',
    'An update from v' + ctx.report.from + ' to v' + ctx.report.to + ' kept ' + rels.length + ' file(s) aside because the',
    'local edits and the new release changed the same lines. The new version lives in:',
    '  ' + ctx.target,
    'A full backup of the old install is at: ' + (ctx.report.backup || '(none)'),
    '',
    'For EACH file below:',
    '1. <file> in the new app dir is the user\'s version (it still works). <file>.new is the',
    '   new release\'s version (with <<<<<<< / >>>>>>> conflict markers when a 3-way merge',
    '   was possible). The base (the old release, unmodified) and the old local file are',
    '   listed for reference.',
    '2. Write the integrated result into <file>: keep what the user changed and why, and',
    '   keep every fix and feature of the new release. No conflict markers may remain.',
    '3. Delete <file>.new.',
    '',
    'Rules: change files only inside the new app dir; no git, no network, no installs, no',
    'other files. If a file cannot be integrated safely, leave both files as they are and',
    'say why in one line. The updater runs a self-test afterwards and rolls back on failure.',
    '',
    '## Files',
  ];
  for (const rel of rels) {
    lines.push('- ' + rel);
    lines.push('  installed (user version): ' + p(ctx.target, rel));
    lines.push('  new release side:         ' + p(ctx.target, rel) + '.new');
    lines.push('  base (old release):       ' + p(ctx.baseDir, rel));
    lines.push('  old local file:           ' + p(ctx.localDir, rel));
  }
  return lines.join('\n') + '\n';
}

function check(target, rels) {
  const resolved = [];
  const unresolved = [];
  for (const rel of rels) {
    const f = path.join(target, ...rel.split('/'));
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { unresolved.push(rel); continue; }
    if (!exists(f + '.new') && !MARKERS.test(text)) resolved.push(rel);
    else unresolved.push(rel);
  }
  return { resolved, unresolved };
}

function runCommand(argv, timeoutSec, cwd) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { if (out.length < 100000) out += d; });
    child.stderr.on('data', (d) => { if (out.length < 100000) out += d; });
    const t = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } }, timeoutSec * 1000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out: out.slice(-2000) }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: e.message }); });
  });
}

// Returns the function applyUpdate calls as o.reintegrate(ctx).
// o: settings (normalized updates), run (injectable: (argv, timeoutSec, cwd) -> {code,out}), now
function makeReintegrator(o) {
  return async (ctx) => {
    const L = layout(ctx.home);
    const rels = conflictsOf(ctx.report);
    fs.mkdirSync(L.reports, { recursive: true });
    const promptFile = path.join(L.reports, 'reintegrate-' + stamp(o.now) + '.md');
    fs.writeFileSync(promptFile, buildPrompt(ctx));
    const r = o.settings && o.settings.reintegrate;
    if (!r || !r.enabled || !Array.isArray(r.command) || !r.command.length) {
      return { ran: false, prompt: promptFile, resolved: [], unresolved: rels };
    }
    const argv = r.command.map((a) => a.split('{prompt}').join(promptFile).split('{dir}').join(ctx.target));
    const res = await (o.run || runCommand)(argv, r.timeoutSec || 1800, ctx.target);
    const c = check(ctx.target, rels);
    return { ran: true, code: res.code, prompt: promptFile, resolved: c.resolved, unresolved: c.unresolved };
  };
}

module.exports = { makeReintegrator, buildPrompt, check, conflictsOf, MARKERS };
