'use strict';
// Install (CON-PUBLIC B, update-aware per D). `claude-console install` (from a release
// version) runs this from the package dir:
//   - detect a marker / legacy console / running server first (detect.js);
//   - marker with an older version, or a legacy layout: hand over to the update engine,
//     so nothing local is lost; same version: nothing to do;
//   - clean install: app/<v> + .base/<v> from the verified release, npm ci, user data
//     dirs and a first-run config OUTSIDE the code dir, the launchers, the Desktop /
//     Start-menu shortcuts, then the marker.
// Prerequisites are checked first and reported in words (prereq.js).
const fs = require('fs');
const path = require('path');
const { layout } = require('./paths');
const { writeJsonAtomic, exists, isDir, readJson, copyFile } = require('./fsutil');
const { detect, readMarker } = require('./detect');
const { checkPrereqs } = require('./prereq');
const { writeLaunchers } = require('./launcher');
const { DEFAULTS, REPO_RE } = require('./settings');
const upd = require('./update');
const semver = require('./semver');

function firstRunConfig(pre) {
  return {
    _comment: 'Claude Console local config, written once by the installer. Same shape as config/console.json, merged over it. Edit freely; updates never touch this file.',
    claudePath: pre && pre.claude ? pre.claude : null,
    edgePath: pre && pre.edge ? pre.edge : null,
    // No `repo` here (CON-PUBLIC A): a null in this file would mask the release's own
    // config/console.json updates.repo, and the install could never see a release.
    updates: { auto: DEFAULTS.auto, channel: DEFAULTS.channel, checkHours: DEFAULTS.checkHours, window: DEFAULTS.window, check: DEFAULTS.check },
    plugins: { main: { enabled: false } },
  };
}

// o: home, sourceDir, npmCi, selftest, makeShortcuts(home, vbsPath) (async), nodePath,
//    prereqs (precomputed checkPrereqs result), detectOpts, migrate (default true), now.
async function install(o) {
  o = o || {};
  const L = layout(o.home);
  const pre = o.prereqs || checkPrereqs();
  const report = { kind: 'install', home: L.home, prereqs: { ok: pre.ok, problems: pre.problems, warnings: pre.warnings }, status: 'running', steps: [] };
  if (!pre.ok && !o.ignorePrereqs) {
    report.status = 'missing-prereqs';
    return report;
  }
  const rel = upd.prepareRelease(o.sourceDir, L.home);
  const v = rel.manifest.version;
  report.version = v;
  const found = await detect(Object.assign({ home: L.home }, o.detectOpts || {}));
  report.detected = { kind: found.kind, marker: found.marker ? found.marker.version : null, legacy: found.legacy.map((x) => x.version), running: found.running ? (found.running.version || 'unknown') : null };
  if (o.repo) setRepo(L, o.repo, pre);
  if (found.marker) {
    const c = semver.cmp(v, found.marker.version);
    if (c === 0 && !o.force) return repairSame(o, L, rel, v, report); // VMFIX: a re-run repairs
    if (c < 0 && !o.force) {
      report.status = 'newer-installed';
      return report;
    }
    const r = await upd.applyUpdate(Object.assign({}, o, { home: L.home, releaseDir: rel.dir }));
    return Object.assign(report, { status: r.status, update: r });
  }
  if (found.legacy.length && o.migrate !== false) {
    const r = await upd.applyUpdate(Object.assign({}, o, { home: L.home, releaseDir: rel.dir, legacyDir: found.legacy[0].path }));
    if (r.status === 'updated' || r.status === 'updated-with-conflicts') {
      for (const d of [L.data, L.run, L.drops]) fs.mkdirSync(d, { recursive: true });
      const local = path.join(L.data, 'console.local.json');
      if (!exists(local)) writeJsonAtomic(local, firstRunConfig(pre));
      await finishShell(o, L, v, report);
    }
    return Object.assign(report, { status: r.status, update: r });
  }
  // Clean install.
  const app = L.app(v);
  if (exists(app)) upd.moveAside(app, L.backups, 'stale-' + v);
  upd.copyRelease(rel.dir, app);
  upd.ensureBase(L, rel.dir, v);
  report.steps.push('files');
  for (const d of [L.data, L.run, L.drops, L.backups, L.reports, L.cache]) fs.mkdirSync(d, { recursive: true });
  const local = path.join(L.data, 'console.local.json');
  if (!exists(local)) writeJsonAtomic(local, firstRunConfig(pre));
  report.steps.push('data');
  await (o.npmCi || upd.defaultNpmCi)(app);
  report.steps.push('npm');
  if (o.selftest !== false) {
    const st = await (o.selftest || upd.defaultSelftest)(app, v);
    report.selftest = st;
    if (!st.ok) {
      report.failedBuild = upd.moveAside(app, L.backups, v);
      report.status = 'selftest-failed';
      report.reportFile = upd.writeReport(L, 'install', report, o.now);
      return report;
    }
  }
  writeJsonAtomic(L.marker, { version: v, path: app, channel: rel.manifest.channel || 'stable', installedAt: (o.now || new Date()).toISOString(), previous: null });
  await finishShell(o, L, v, report);
  report.status = 'installed';
  report.reportFile = upd.writeReport(L, 'install', report, o.now);
  return report;
}

async function finishShell(o, L, v, report) {
  const f = writeLaunchers(L.home, v, o.nodePath || process.execPath);
  report.launcher = f.vbsPath;
  report.command = f.cmdPath;
  if (typeof o.makeShortcuts === 'function') {
    try {
      report.shortcuts = await o.makeShortcuts(L.home, f.vbsPath, { version: v, repo: o.repo || null });
    } catch (e) {
      report.shortcutError = e.message;
    }
  }
  report.steps.push('launchers');
}

// updates.repo into data/console.local.json (merged, everything else kept).
function setRepo(L, repo, pre) {
  if (!REPO_RE.test(String(repo))) throw new Error('bad --repo (want owner/name): ' + String(repo).slice(0, 80));
  const file = path.join(L.data, 'console.local.json');
  const cur = readJson(file, null) || firstRunConfig(pre);
  cur.updates = Object.assign({}, cur.updates || {}, { repo });
  writeJsonAtomic(file, cur);
}

// Same version installed: restore missing shipped files from the release, npm ci when
// node_modules is gone, rewrite the launchers and the shell integration. A file that
// differs from the release is a local tweak and stays (reinstall --mode fresh resets it).
async function repairSame(o, L, rel, v, report) {
  const m = readMarker(L.home);
  const app = m.path && isDir(m.path) ? m.path : L.app(v);
  const restored = [];
  for (const relPath of Object.keys(rel.manifest.files)) {
    const dest = path.join(app, ...relPath.split('/'));
    if (!exists(dest)) {
      copyFile(path.join(rel.dir, ...relPath.split('/')), dest);
      restored.push(relPath);
    }
  }
  if (exists(path.join(app, 'package-lock.json')) && !exists(path.join(app, 'node_modules'))) {
    await (o.npmCi || upd.defaultNpmCi)(app);
    restored.push('node_modules');
  }
  for (const d of [L.data, L.run, L.drops]) fs.mkdirSync(d, { recursive: true });
  await finishShell(o, L, v, report);
  report.restored = restored;
  report.status = restored.length ? 'repaired' : 'already-installed';
  return report;
}

module.exports = { install, firstRunConfig };
