'use strict';
// Update engine (CON-PUBLIC D, reused by B's install, E's auto-update and F's reinstall).
// One update = back up the installed code (zip), build app/<new> from the verified
// release, 3-way merge the local changes into it (merge.js), keep a pristine
// .base/<new>, npm ci, self-test, and only then switch the marker. A failed self-test
// leaves the marker on the old version (the old app dir is never modified, so that IS
// the rollback) and moves the failed build aside. User data (data/, run/, drops/)
// lives outside every app dir and is never touched.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { layout, stamp } = require('./paths');
const { copyTree, copyFile, exists, isDir, readJson, writeJsonAtomic } = require('./fsutil');
const { readManifest, verifyTree, skipRelease, MANIFEST, buildManifest, writeManifest } = require('./manifest');
const { planMerge, applyMerge, summarize } = require('./merge');
const { zipDir } = require('./backup');
const { readMarker } = require('./detect');
const { writeLaunchers } = require('./launcher');
const semver = require('./semver');
const swap = require('./swap');

// CON-0.1.3: the Apps & features version follows every switch. o.writeArp(home, v) ->
// {present, version, ok}; the default is the real registry write, except where the
// caller is a test (a fake npmCi and no writeArp), which never touches the registry.
function arpWriter(o) {
  if (o.writeArp !== undefined) return o.writeArp;
  return o.npmCi ? null : require('./launcher').writeArpWindows;
}

async function refreshArp(o, home, version) {
  const w = arpWriter(o);
  if (typeof w !== 'function') return null;
  try {
    const r = await w(home, version);
    return Object.assign({ wanted: version }, r);
  } catch (e) {
    return { wanted: version, ok: false, error: e.message };
  }
}

// One line for the CLI: what Apps & features shows now (read back).
function arpLine(arp) {
  if (!arp) return null;
  if (arp.error) return 'note: Apps & features version not updated: ' + arp.error;
  if (arp.present === false || arp.skipped) return null;
  if (!arp.ok) return 'note: Apps & features still shows v' + (arp.version || '?') + ', not v' + arp.wanted;
  return 'Apps & features: v' + arp.version;
}

function runNode(args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { if (out.length < 200000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 200000) err += d; });
    const t = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } }, timeoutMs || 120000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
  });
}

// npm ci in the app dir, by npm-cli.js next to this node (a .cmd cannot be spawned bare).
async function defaultNpmCi(dir) {
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  const r = await runNode([cli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], dir, 15 * 60000);
  if (r.code !== 0) throw new Error('npm ci failed: ' + (r.err || r.out).trim().split('\n').slice(-3).join(' | '));
  return true;
}

// The self-test: the new version's server answers /api/info with its version, then a
// small test subset of that version passes.
const SELFTEST_SUBSET = ['tests/claudeenv.test.js', 'tests/commands.test.js'];

// VMFIX: the subset builds git fixtures (tests/helpers.js), so without git it is
// skipped with a note instead of failing the install.
function selftestPlan(dir, hasGit) {
  const subset = SELFTEST_SUBSET.filter((f) => exists(path.join(dir, f)));
  if (hasGit) return { files: subset, note: null };
  return { files: [], note: 'git not found: skipped the git-dependent self-tests (' + subset.map((f) => path.basename(f)).join(', ') + ')' };
}

// The failing test names and the first error out of node --test TAP output.
function summarizeTestFailure(out) {
  const failed = [];
  let error = null;
  for (const line of String(out || '').split(/\r?\n/)) {
    const m = /^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/.exec(line);
    if (m && !failed.includes(m[1])) failed.push(m[1]);
    const e = /^\s*error: (.+)$/.exec(line);
    if (e && !error) error = e[1].replace(/^['"]|['"]$/g, '').trim();
  }
  return { failed, error };
}

function writeSelftestLog(reportDir, version, text) {
  fs.mkdirSync(reportDir, { recursive: true });
  const f = path.join(reportDir, 'selftest-' + version + '-' + stamp() + '.log');
  fs.writeFileSync(f, String(text || ''));
  return f;
}

function selftestDetail(sum, logFile) {
  return 'tests failed: ' + (sum.failed.length ? sum.failed.join(', ') : '(no test name in the output)') +
    ' | error: ' + (sum.error || 'see the log') + ' | full output: ' + logFile;
}

function hasGitDefault() {
  try { return require('child_process').spawnSync('git', ['--version'], { windowsHide: true }).status === 0; } catch (e) { return false; }
}

async function defaultSelftest(dir, version, opts) {
  opts = opts || {};
  const reportDir = opts.reportDir || path.resolve(dir, '..', '..', 'reports');
  const info = await runNode([path.join('installer', 'selftest-run.js'), version], dir, 90000);
  if (info.code !== 0) {
    const log = writeSelftestLog(reportDir, version, info.out + '\n' + info.err);
    return { ok: false, detail: 'api/info: ' + (info.out || info.err).trim().slice(0, 300) + ' | full output: ' + log, log };
  }
  const plan = selftestPlan(dir, opts.hasGit !== undefined ? opts.hasGit : hasGitDefault());
  if (plan.files.length) {
    const t = await runNode(['--test', '--test-reporter=tap', ...plan.files], dir, 180000);
    if (t.code !== 0) {
      const log = writeSelftestLog(reportDir, version, t.out + '\n' + t.err);
      const sum = summarizeTestFailure(t.out + '\n' + t.err);
      return { ok: false, detail: selftestDetail(sum, log), failed: sum.failed, error: sum.error, log };
    }
  }
  return { ok: true, detail: 'api/info ' + version + ', ' + plan.files.length + ' test files' + (plan.note ? '; ' + plan.note : ''), note: plan.note };
}

// A release dir must carry a MANIFEST.json that every file matches.
function requireRelease(dir) {
  const m = readManifest(dir);
  if (!m || !semver.valid(m.version)) throw new Error('not a release dir (no valid MANIFEST.json): ' + dir);
  const v = verifyTree(dir, m);
  if (!v.ok) throw new Error('release fails its manifest: ' + v.missing.concat(v.mismatch).slice(0, 5).join(', '));
  return m;
}

// A source tree (e.g. an unpacked release or a git checkout) as a release: used as-is
// when it carries a valid manifest, else staged into cache/stage-<v> with a new one.
function prepareRelease(sourceDir, home) {
  const m = readManifest(sourceDir);
  if (m && semver.valid(m.version) && verifyTree(sourceDir, m).ok) return { dir: sourceDir, manifest: m };
  const pkg = readJson(path.join(sourceDir, 'package.json'), {});
  if (!semver.valid(pkg.version)) throw new Error('source has no valid package.json version');
  const stage = path.join(layout(home).cache, 'stage-' + pkg.version + '-' + stamp());
  copyTree(sourceDir, stage, skipRelease);
  const man = buildManifest(stage, { version: pkg.version });
  writeManifest(stage, man);
  return { dir: stage, manifest: man };
}

function moveAside(dir, backups, label) {
  if (!exists(dir)) return null;
  fs.mkdirSync(backups, { recursive: true });
  const to = path.join(backups, 'failed-' + label + '-' + stamp());
  fs.renameSync(dir, to);
  return to;
}

function copyRelease(releaseDir, dest) {
  copyTree(releaseDir, dest, skipRelease);
  copyFile(path.join(releaseDir, MANIFEST), path.join(dest, MANIFEST));
}

function ensureBase(L, releaseDir, version) {
  const b = L.base(version);
  if (!exists(path.join(b, MANIFEST))) {
    if (exists(b)) moveAside(b, L.backups, 'base-' + version);
    copyRelease(releaseDir, b);
  }
  return b;
}

// Legacy migration: the first update copies the legacy console's data/ (settings,
// layouts, console.local.json) into the install home when the home has none yet.
function migrateData(legacyDir, L) {
  const from = path.join(legacyDir, 'data');
  if (!isDir(from)) return 0;
  let have = [];
  try { have = fs.readdirSync(L.data); } catch (e) { have = []; }
  if (have.length) return 0;
  return copyTree(from, L.data).length;
}

// o: home, releaseDir, legacyDir (migrate when there is no marker), npmCi, selftest,
//    reintegrate(ctx) (CON-AUTOUPDATE; optional), nodePath, now, force, channel.
async function applyUpdate(o) {
  const L = layout(o.home);
  const man = requireRelease(o.releaseDir);
  const marker = readMarker(L.home);
  if (!marker && !o.legacyDir) throw new Error('no install found; run install first');
  const newV = man.version;
  const oldV = marker ? marker.version : (readJson(path.join(o.legacyDir, 'package.json'), {}).version || '0.0.0');
  const localDir = marker ? (marker.path && isDir(marker.path) ? marker.path : L.app(oldV)) : o.legacyDir;
  const baseDir = marker && exists(path.join(L.base(oldV), MANIFEST)) ? L.base(oldV) : null;
  const report = {
    kind: marker ? 'update' : 'migrate', from: oldV, to: newV, at: (o.now || new Date()).toISOString(),
    local: localDir, base: baseDir ? 'base-' + oldV : null, status: 'running', steps: [],
  };
  const step = (s) => { report.steps.push(s); if (o.onStep) o.onStep(s); };
  if (marker && semver.cmp(newV, oldV) <= 0 && !o.force) {
    report.status = 'up-to-date';
    return report;
  }
  const target = L.app(newV);
  if (path.resolve(target) === path.resolve(localDir)) throw new Error('target is the installed dir; use reinstall');
  report.backup = zipDir(localDir, L.backups, 'app-' + oldV, { exclude: ['node_modules', 'drops', 'run'] , now: o.now });
  step('backup');
  // CON-0.1.3: app/<new> may be the folder a running console uses (an update right
  // after a rollback): stop that console first (o.beforeSwap), retry the move with a
  // bounded backoff, and refuse with one line when it still cannot move.
  if (exists(target)) {
    if (typeof o.beforeSwap === 'function') {
      const s = await o.beforeSwap([target]);
      report.stoppedConsole = !!(s && s.stopped);
      if (s && !s.ok) return blocked(L, report, 'update blocked: ' + s.line, o.now);
    }
    try {
      await swap.retrySwap(() => moveAside(target, L.backups, 'stale-' + newV), o.retry);
    } catch (e) {
      if (!e.swapFailed) throw e;
      return blocked(L, report, swap.blockedLine('update', target, e), o.now);
    }
  }
  copyRelease(o.releaseDir, target);
  const plan = planMerge(localDir, baseDir, o.releaseDir);
  report.files = applyMerge(plan, localDir, baseDir, o.releaseDir, target, o);
  report.summary = summarize(report.files);
  report.localMods = report.files.filter((r) => r.result === 'kept' || r.result === 'merged' || r.result === 'conflict' || r.result === 'flagged').map((r) => r.rel);
  step('merge');
  ensureBase(L, o.releaseDir, newV);
  if (!marker) report.migratedDataFiles = migrateData(localDir, L);
  step('base');
  await (o.npmCi || defaultNpmCi)(target);
  step('npm');
  if (report.summary.conflict && typeof o.reintegrate === 'function') {
    report.reintegration = await o.reintegrate({ home: L.home, target, localDir, baseDir, releaseDir: o.releaseDir, report });
    step('reintegrate');
  }
  // CON-AUTOUPDATE: auto mode never switches to a build with unresolved conflicts; the
  // build stays aside for review and the installed version keeps running.
  const unresolved = report.summary.conflict ? (report.reintegration ? report.reintegration.unresolved.length : report.summary.conflict) : 0;
  report.unresolved = unresolved;
  if (o.requireClean && unresolved) {
    report.reviewBuild = moveAside(target, L.backups, 'review-' + newV);
    report.status = 'needs-review';
    report.reportFile = writeReport(L, 'update', report, o.now);
    return report;
  }
  const st = await (o.selftest || defaultSelftest)(target, newV);
  report.selftest = st;
  step('selftest');
  if (!st.ok) {
    report.failedBuild = moveAside(target, L.backups, newV);
    report.status = 'rolled-back';
    report.rolledBackTo = oldV;
  } else {
    writeJsonAtomic(L.marker, {
      version: newV, path: target, channel: o.channel || (marker && marker.channel) || man.channel || 'stable',
      installedAt: report.at, previous: { version: oldV, path: localDir },
    });
    await swap.retrySwap(() => writeLaunchers(L.home, newV, o.nodePath || process.execPath), o.retry);
    report.status = unresolved ? 'updated-with-conflicts' : 'updated';
    report.arp = await refreshArp(o, L.home, newV);
  }
  report.reportFile = writeReport(L, 'update', report, o.now);
  return report;
}

function blocked(L, report, line, now) {
  report.status = 'blocked';
  report.line = line;
  report.reportFile = writeReport(L, 'update', report, now);
  return report;
}

function writeReport(L, kind, report, now) {
  const f = path.join(L.reports, kind + '-' + stamp(now) + '.json');
  writeJsonAtomic(f, report);
  writeJsonAtomic(path.join(L.reports, 'last-' + kind + '.json'), report);
  return f;
}

// Manual rollback: switch the marker back to the previous version when its dir exists.
function rollback(home, nodePath) {
  const L = layout(home);
  const m = readMarker(L.home);
  if (!m || !m.previous || !isDir(m.previous.path)) throw new Error('no previous version to roll back to');
  writeJsonAtomic(L.marker, { version: m.previous.version, path: m.previous.path, channel: m.channel, installedAt: new Date().toISOString(), previous: { version: m.version, path: m.path } });
  if (path.resolve(m.previous.path) === path.resolve(L.app(m.previous.version))) writeLaunchers(L.home, m.previous.version, nodePath || process.execPath);
  return { from: m.version, to: m.previous.version };
}

// CON-0.1.3: rollback as the CLI runs it. The console running from this home is
// stopped first (o.beforeSwap, which waits for its process to exit), the switch is
// retried with a bounded backoff, Apps & features is set to the version rolled back to
// and read back, and the console is started again on that version when it was running.
// o: home, nodePath, beforeSwap(dirs), restart(), writeArp, retry, npmCi (test marker).
async function rollbackSwap(o) {
  const L = layout(o.home);
  const m = readMarker(L.home);
  if (!m || !m.previous || !isDir(m.previous.path)) throw new Error('no previous version to roll back to');
  let stop = null;
  if (typeof o.beforeSwap === 'function') {
    stop = await o.beforeSwap([]);
    if (stop && !stop.ok) return { status: 'blocked', from: m.version, to: m.previous.version, line: 'rollback blocked: ' + stop.line };
  }
  let r;
  try {
    r = await swap.retrySwap(() => rollback(L.home, o.nodePath), o.retry);
  } catch (e) {
    if (!e.swapFailed) throw e;
    const res = { status: 'blocked', from: m.version, to: m.previous.version, line: swap.blockedLine('rollback', L.marker, e) };
    if (stop && stop.stopped && typeof o.restart === 'function') { await o.restart(); res.restarted = m.version; }
    return res;
  }
  const out = { status: 'rolled-back', from: r.from, to: r.to, stoppedConsole: !!(stop && stop.stopped) };
  out.arp = await refreshArp(o, L.home, r.to);
  if (out.stoppedConsole && typeof o.restart === 'function') { await o.restart(); out.restarted = r.to; }
  return out;
}

module.exports = { applyUpdate, rollback, rollbackSwap, arpLine, refreshArp, prepareRelease, requireRelease, copyRelease, ensureBase, defaultNpmCi, defaultSelftest, moveAside, writeReport, runNode, SELFTEST_SUBSET, selftestPlan, summarizeTestFailure, writeSelftestLog, selftestDetail };
