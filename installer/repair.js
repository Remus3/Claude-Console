'use strict';
// Fresh reinstall (CON-PUBLIC F): `claude-console reinstall --mode repair|fresh|factory`
// and Settings > "Repair / fresh reinstall". A read-only pre-flight report comes first;
// nothing changes without the typed confirmation it names.
//   repair : restore files that are absent from the install, and a corrupt .base,
//            from the release; local tweaks are kept (decision 2026-10-18, G5 lane: a
//            tweak and a corrupted file are both a hash mismatch against .base, so
//            repair never overwrites a differing file - fresh is the tool for that);
//   fresh  : a clean copy of the release, user data kept; tweaks optionally re-applied
//            with the D 3-way merge (best effort, conflicts listed);
//   factory: fresh plus user data reset, behind a second confirmation.
// Every mode zips the old install into backups first; a replaced dir goes to the
// Recycle Bin (recycle is injected; tests never touch a real bin).
const fs = require('fs');
const path = require('path');
const { layout, stamp } = require('./paths');
const { exists, isDir, copyFile, walk, writeJsonAtomic, recycleWindows } = require('./fsutil');
const { readManifest, verifyTree, MANIFEST } = require('./manifest');
const { localMods, planMerge, applyMerge, summarize } = require('./merge');
const { readMarker } = require('./detect');
const { zipDir } = require('./backup');
const contribute = require('./contribute');
const upd = require('./update');
const { firstRunConfig } = require('./install');

const MODES = ['repair', 'fresh', 'factory'];
const FACTORY_PHRASE = 'factory reset';

function userData(L) {
  const kept = [];
  for (const rel of walk(L.data)) kept.push('data/' + rel);
  let drops = 0;
  try { drops = walk(L.drops).length; } catch (e) { drops = 0; }
  if (drops) kept.push('drops/ (' + drops + ' files)');
  return kept;
}

function preflight(o) {
  o = o || {};
  const L = layout(o.home);
  const m = readMarker(L.home);
  if (!m) throw new Error('no install marker; nothing to reinstall');
  const app = m.path && isDir(m.path) ? m.path : L.app(m.version);
  const base = L.base(m.version);
  const baseMan = readManifest(base);
  const baseCheck = baseMan ? verifyTree(base, baseMan) : { ok: false, missing: [], mismatch: [] };
  const mods = baseMan ? localMods(app, base) : [];
  const absent = baseMan ? Object.keys(baseMan.files).filter((rel) => !exists(path.join(app, ...rel.split('/')))) : [];
  const tweaks = mods.filter((x) => x.kind !== 'deleted');
  const kept = userData(L);
  const n = tweaks.length;
  return {
    version: m.version, app, baseOk: !!baseMan && baseCheck.ok, absent, tweaks,
    keep: kept.length ? kept : ['(no user data yet)'],
    lose: { repair: [], fresh: tweaks.map((t) => t.rel + ' (code edit)'), factory: tweaks.map((t) => t.rel + ' (code edit)').concat(kept.map((k) => k + ' (user data)')) },
    can: [
      'save the tweaks as a patch first (default on)',
      're-apply the tweaks after a fresh reinstall with a 3-way merge (best effort, conflicts listed)',
      'keep a full backup zip of the old install (always)',
    ],
    cannot: [
      'guarantee a re-apply of edits that conflict with the new release',
      'restore running pane sessions (panes end on restart)',
      'undo changes made outside the install dir',
    ],
    confirmPhrase: 'reinstall ' + n,
    factoryPhrase: FACTORY_PHRASE,
    modes: MODES,
  };
}

// o: home, mode, confirm, factoryConfirm, saveTweaks (default true), reapply, releaseDir
//    (default .base/<v>), npmCi, selftest, recycle, nodePath, now.
async function reinstall(o) {
  const L = layout(o.home);
  if (!MODES.includes(o.mode)) throw new Error('mode must be repair, fresh or factory');
  const pf = preflight(o);
  if (o.confirm !== pf.confirmPhrase) return { status: 'refused', reason: 'type "' + pf.confirmPhrase + '" to confirm', preflight: pf };
  if (o.mode === 'factory' && o.factoryConfirm !== FACTORY_PHRASE) return { status: 'refused', reason: 'factory needs the second confirmation "' + FACTORY_PHRASE + '"', preflight: pf };
  const recycle = o.recycle || recycleWindows;
  const report = { kind: 'reinstall', mode: o.mode, version: pf.version, at: (o.now || new Date()).toISOString(), status: 'running' };
  report.backup = zipDir(pf.app, L.backups, 'reinstall-' + pf.version, { exclude: ['node_modules'], now: o.now });
  if (pf.tweaks.length && o.saveTweaks !== false && pf.baseOk) report.patch = contribute.makePatch({ home: L.home, now: o.now }).file;
  const src = o.releaseDir || L.base(pf.version);
  const srcMan = upd.requireRelease(src);

  if (o.mode === 'repair') {
    const restored = [];
    for (const rel of Object.keys(srcMan.files)) {
      const t = path.join(pf.app, ...rel.split('/'));
      if (!exists(t)) { copyFile(path.join(src, ...rel.split('/')), t); restored.push(rel); }
    }
    if (!exists(path.join(pf.app, MANIFEST))) copyFile(path.join(src, MANIFEST), path.join(pf.app, MANIFEST));
    if (!pf.baseOk && src !== L.base(pf.version)) {
      const b = L.base(pf.version);
      if (exists(b)) await recycle(b);
      upd.copyRelease(src, b);
      report.baseRestored = true;
    }
    if (!isDir(path.join(pf.app, 'node_modules'))) await (o.npmCi || upd.defaultNpmCi)(pf.app);
    report.restored = restored;
    report.keptTweaks = pf.tweaks.map((t) => t.rel);
    const st = await (o.selftest || upd.defaultSelftest)(pf.app, pf.version);
    report.selftest = st;
    report.status = st.ok ? 'repaired' : 'repaired-selftest-failed';
    report.reportFile = upd.writeReport(L, 'reinstall', report, o.now);
    return report;
  }

  // fresh / factory: build beside the old dir, switch only after the self-test.
  const v = srcMan.version;
  const stage = path.join(L.appRoot, v + '.fresh-' + stamp(o.now));
  upd.copyRelease(src, stage);
  if (o.reapply && pf.tweaks.length && pf.baseOk) {
    const plan = planMerge(pf.app, L.base(pf.version), src);
    report.reapplied = applyMerge(plan, pf.app, L.base(pf.version), src, stage, o).filter((r) => r.result !== 'new' && r.result !== 'dropped');
    report.reapplySummary = summarize(report.reapplied);
  }
  upd.ensureBase(L, src, v);
  await (o.npmCi || upd.defaultNpmCi)(stage);
  const st = await (o.selftest || upd.defaultSelftest)(stage, v);
  report.selftest = st;
  if (!st.ok) {
    report.failedBuild = upd.moveAside(stage, L.backups, v);
    report.status = 'rolled-back';
    report.reportFile = upd.writeReport(L, 'reinstall', report, o.now);
    return report;
  }
  if (o.mode === 'factory') {
    if (isDir(L.data)) {
      report.dataBackup = zipDir(L.data, L.backups, 'data-' + pf.version, { exclude: [], now: o.now });
      await recycle(L.data);
    }
    fs.mkdirSync(L.data, { recursive: true });
    writeJsonAtomic(path.join(L.data, 'console.local.json'), firstRunConfig(o.prereqs || null));
  }
  const final = L.app(v);
  await recycle(pf.app);
  if (exists(final)) await recycle(final);
  fs.renameSync(stage, final);
  const m = readMarker(L.home);
  writeJsonAtomic(L.marker, { version: v, path: final, channel: m.channel || 'stable', installedAt: report.at, previous: m.previous || null });
  require('./launcher').writeLaunchers(L.home, v, o.nodePath || process.execPath);
  report.status = o.mode === 'factory' ? 'factory-reset' : 'reinstalled';
  report.reportFile = upd.writeReport(L, 'reinstall', report, o.now);
  return report;
}

module.exports = { preflight, reinstall, MODES, FACTORY_PHRASE };
