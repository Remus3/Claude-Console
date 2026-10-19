'use strict';
// Settings > "Updates & repair" backend (CON-PUBLIC D/E/F). One object the server routes
// call; the route wiring and the Settings section live in docs/g5-wiring.patch (the UI
// lane owns server.js and public/*). Routes:
//   GET  /api/updates              state: installed / checkout, versions, settings, last report
//   POST /api/updates/check        {} -> release check (ETag-cached, opt-out, repo-gated)
//   POST /api/updates/apply        {} -> download + apply the available release (single flight)
//   GET  /api/updates/preflight    reinstall pre-flight report (read-only)
//   POST /api/updates/reinstall    {mode, confirm, factoryConfirm, reapply, saveTweaks}
//   POST /api/updates/contribute   {} -> scrubbed patch + issue URL (never sends)
// Busy panes: apply only stages the new version; the restart is the operator's (or the
// auto-updater's when no pane is busy). A checkout run (<drive>:\Main\console) reports
// "checkout" and offers nothing destructive.
const path = require('path');
const { layout, defaultHome } = require('../installer/paths');
const { readJson, writeJsonAtomic } = require('../installer/fsutil');
const { readMarker } = require('../installer/detect');
const { normalizeUpdates } = require('../installer/settings');
const release = require('../installer/release');
const upd = require('../installer/update');
const repair = require('../installer/repair');
const contribute = require('../installer/contribute');

function createUpdates(o) {
  const cfg = o.cfg || {};
  const L = layout(o.home || defaultHome(o.env));
  const deps = o.deps || {};
  let busy = null;
  let lastCheck = null;

  const installed = () => {
    const m = readMarker(L.home);
    if (!m) return null;
    const root = path.resolve(cfg.root || '');
    return root.toLowerCase().startsWith(path.resolve(L.appRoot).toLowerCase() + path.sep) ? m : null;
  };
  const settings = () => normalizeUpdates(cfg.updates);

  function state() {
    const m = installed();
    return {
      mode: m ? 'installed' : 'checkout',
      version: o.version || null,
      installed: m ? { version: m.version, channel: m.channel || 'stable', previous: m.previous ? m.previous.version : null } : null,
      settings: settings(),
      busy,
      lastCheck,
      lastUpdate: readJson(path.join(L.reports, 'last-update.json'), null),
      lastReinstall: readJson(path.join(L.reports, 'last-reinstall.json'), null),
      // CON-AUTOUPDATE tick state: badge (available version), review (conflicts left for
      // the user), pendingRestart (staged, waiting for idle panes).
      auto: (() => {
        const a = readJson(path.join(L.cache, 'autoupdate.json'), null);
        if (!a) return null;
        return { lastTick: a.lastTick || null, available: a.check && a.check.available ? a.check.latest.version : null, review: a.review ? { version: a.review.version, conflicts: a.review.conflicts } : null, pendingRestart: a.pendingRestart || null, lastResult: a.lastResult ? { status: a.lastResult.status, from: a.lastResult.from, to: a.lastResult.to } : null };
      })(),
    };
  }

  async function single(name, fn) {
    if (busy) return { error: 'busy', busy };
    busy = name;
    try { return await fn(); } finally { busy = null; }
  }

  async function check() {
    const m = installed();
    lastCheck = await release.checkReleases({ settings: settings(), cacheFile: path.join(L.cache, 'releases.json'), current: m ? m.version : o.version, fetch: deps.fetch });
    lastCheck.at = new Date().toISOString();
    return lastCheck;
  }

  async function apply() {
    if (!installed()) return { error: 'checkout: run `claude-console install` to switch to the managed layout first' };
    return single('update', async () => {
      const c = await check();
      if (!c.available) return { status: 'up-to-date', check: c };
      const rel = await release.downloadRelease(c.latest, L.downloads, { fetch: deps.fetch });
      const r = await upd.applyUpdate({ home: L.home, releaseDir: rel.dir, npmCi: deps.npmCi, selftest: deps.selftest, reintegrate: deps.reintegrate });
      const panes = typeof o.panes === 'function' ? o.panes() : [];
      r.restartNeeded = r.status === 'updated' || r.status === 'updated-with-conflicts';
      r.panesBusy = panes.filter((p) => p && p.state === 'busy').length;
      return r;
    });
  }

  function preflight() {
    if (!installed()) return { error: 'checkout: nothing to reinstall' };
    return repair.preflight({ home: L.home });
  }

  async function reinstall(b) {
    if (!installed()) return { error: 'checkout: nothing to reinstall' };
    b = b || {};
    if (b.mode !== 'repair') return { error: 'fresh and factory replace the running code: quit the console and run `claude-console reinstall --mode ' + String(b.mode === 'factory' ? 'factory' : 'fresh') + '`' };
    return single('reinstall', () => repair.reinstall({ home: L.home, mode: 'repair', confirm: String(b.confirm || ''), saveTweaks: b.saveTweaks !== false, npmCi: deps.npmCi, selftest: deps.selftest, recycle: deps.recycle }));
  }

  function makePatch() {
    if (!installed()) return { error: 'checkout: use git for local changes' };
    const r = contribute.makePatch({ home: L.home, repo: settings().repo });
    return { file: path.basename(r.file), count: r.count, files: r.files, issueUrl: r.issueUrl };
  }

  // The E setting, written to data/console.local.json `updates` (merged, normalized);
  // only the known keys pass. repo and reintegrate stay file-only (operator edits).
  function saveSettings(b) {
    b = b || {};
    if (!cfg.dataDir) return { error: 'no data dir' };
    const file = path.join(cfg.dataDir, 'console.local.json');
    const local = readJson(file, {}) || {};
    const cur = Object.assign({}, local.updates || {});
    if (typeof b.auto === 'boolean') cur.auto = b.auto;
    if (b.channel === 'stable' || b.channel === 'beta') cur.channel = b.channel;
    if (Number.isFinite(b.checkHours)) cur.checkHours = b.checkHours;
    if (b.window === null || typeof b.window === 'string') cur.window = b.window;
    if (typeof b.check === 'boolean') cur.check = b.check;
    const n = normalizeUpdates(cur);
    local.updates = Object.assign({}, local.updates || {}, { auto: n.auto, channel: n.channel, checkHours: n.checkHours, window: n.window, check: n.check });
    writeJsonAtomic(file, local);
    cfg.updates = Object.assign({}, cfg.updates || {}, local.updates);
    return settings();
  }

  return { state, check, apply, preflight, reinstall, makePatch, saveSettings, layout: L };
}

module.exports = { createUpdates };
