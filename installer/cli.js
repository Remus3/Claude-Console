'use strict';
// `claude-console` CLI (CON-PUBLIC B/D/E/F). bin/claude-console.js calls run(argv).
// Every effect goes through `deps`, so tests drive the whole CLI against scratch dirs
// with fakes (no npm, no shortcuts, no Recycle Bin, no network, no server start).
//
//   install    [--source DIR] [--no-shortcuts] [--ignore-prereqs]
//   start      [--open]                start the installed version hidden
//   stop       [--force] [--timeout S] POST /api/shutdown, then wait for the server pid to exit
//   status                             marker, legacy layouts, running server
//   update     [--check] [--from DIR | --zip FILE] [--yes]
//   rollback                           switch the marker back to the previous version
//   reinstall  --mode repair|fresh|factory [--confirm "reinstall N"]
//              [--factory-confirm "factory reset"] [--reapply] [--no-save-tweaks] [--from DIR]
//   contribute [--send --yes]
//   release    --out DIR               build a release zip locally (never uploads)
//   setup      [--config-dir DIR] [--apply --yes] [--json]   (CON-SHIP-SETUP)
//   autoupdate [--once]                (CON-AUTOUPDATE)
//   uninstall  [--purge]               (VMFIX; user data kept unless --purge)
//   profile    list|view|diff|apply|enable|disable|edit|revert|uninstall|verify|status|
//              preset|adopt ...       (CON-013 setup profile; dry run unless --apply --yes)
//   crash-report [--step ID] [--action issue|claude|save --yes]   (CON-013 e.2)
//   stop-all [--yes] | resume [--yes] | recover-prompt [--yes]     (CON-013 e.3)
// Common: --home DIR (default %LOCALAPPDATA%\Programs\claude-console), --json, --port N.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { layout } = require('./paths');
const { readJson, exists, isDir } = require('./fsutil');
const { detect, readMarker, readToken } = require('./detect');
const { CLAUDE_MISSING } = require('./prereq');

const PKG_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      const flag = ['open', 'yes', 'check', 'json', 'reapply', 'no-save-tweaks', 'no-shortcuts', 'ignore-prereqs', 'send', 'apply', 'once', 'force', 'replace', 'setup', 'register', 'unregister', 'purge'].includes(k);
      if (flag || next === undefined || next.startsWith('--')) out[k] = true;
      else { out[k] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

function cfgOf(L) {
  const local = readJson(path.join(L.data, 'console.local.json'), {}) || {};
  return local;
}

function postShutdown(port, token) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/shutdown', method: 'POST', timeout: 3000, headers: { 'X-Console-Token': token || '', Host: '127.0.0.1:' + port, 'Content-Length': 0 } }, (res) => { res.resume(); resolve(res.statusCode === 200); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

function startServer(L, marker, open, nodePath) {
  const app = marker.path && isDir(marker.path) ? marker.path : L.app(marker.version);
  const env = Object.assign({}, process.env, { CLAUDE_CONSOLE_DATA: L.data, CLAUDE_CONSOLE_RUN: L.run, CLAUDE_CONSOLE_DROPS: L.drops });
  for (const d of [L.data, L.run, L.drops]) fs.mkdirSync(d, { recursive: true });
  const args = [path.join(app, 'server', 'server.js')];
  if (open) args.push('--open');
  const child = spawn(nodePath || process.execPath, args, { cwd: app, env, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
  return app;
}

async function run(argv, deps) {
  deps = deps || {};
  const out = deps.out || ((s) => process.stdout.write(s + '\n'));
  const a = parseArgs(argv);
  const cmd = a._[0] || 'help';
  const L = layout(a.home || deps.home);
  const port = +(a.port || cfgOf(L).port || 7800);
  const emit = (obj, lines) => { if (a.json) out(JSON.stringify(obj)); else for (const l of lines) out(l); };
  const detectOpts = deps.detectOpts || {};

  if (cmd === 'help' || cmd === '--help') {
    for (const l of HELP) out(l);
    return 0;
  }

  if (cmd === 'uninstall') {
    const r = await require('./uninstall').uninstall(Object.assign(procDeps(deps), { home: L.home, purge: !!a.purge, port, removeShell: deps.removeShell, recycle: deps.recycle, deleteLater: deps.deleteLater, rm: deps.rm, retryMs: deps.retryMs }));
    emit(r, r.lines);
    return r.ok ? 0 : 1;
  }

  if (cmd === 'install') {
    const { install } = require('./install');
    const { checkPrereqs } = require('./prereq');
    const { makeShortcutsWindows } = require('./launcher');
    const pre = deps.prereqs || checkPrereqs();
    const r = await install({
      home: L.home, sourceDir: a.source ? path.resolve(a.source) : PKG_ROOT, prereqs: pre, ignorePrereqs: !!a['ignore-prereqs'],
      npmCi: deps.npmCi, selftest: deps.selftest, nodePath: deps.nodePath, detectOpts, force: !!a.force,
      repo: a.repo && a.repo !== true ? a.repo : null,
      makeShortcuts: a['no-shortcuts'] ? null : (deps.makeShortcuts || makeShortcutsWindows),
    });
    const lines = ['install: ' + r.status + (r.version ? ' v' + r.version : '')];
    for (const p of pre.problems) lines.push('missing: ' + p);
    for (const w of pre.warnings) lines.push(w === CLAUDE_MISSING ? w : 'note: ' + w);
    if (r.selftest && r.selftest.note) lines.push('note: ' + r.selftest.note);
    if (r.status === 'selftest-failed' && r.selftest) {
      for (const t of r.selftest.failed || []) lines.push('failing test: ' + t);
      lines.push('error: ' + (r.selftest.error || r.selftest.detail || 'unknown'));
      if (r.selftest.log) lines.push('full test output: ' + r.selftest.log);
    }
    if (r.reportFile) lines.push('report: ' + r.reportFile);
    if (r.restored && r.restored.length) lines.push('restored: ' + r.restored.slice(0, 10).join(', ') + (r.restored.length > 10 ? ' (+' + (r.restored.length - 10) + ' more)' : ''));
    if (r.launcher) lines.push('launcher: ' + r.launcher);
    if (r.command) lines.push('command: ' + r.command);
    if (r.shortcutError) lines.push('note: shortcuts / Apps & features / PATH not written: ' + r.shortcutError);
    if (r.update && r.update.summary) lines.push('merge: ' + JSON.stringify(r.update.summary));
    // CON-SHIP-SETUP: the installer offers the Claude setup as a reviewed plan; it never
    // writes into ~/.claude* here (apply is `claude-console setup --apply --yes`).
    const setup = require('./setup');
    const m = readMarker(L.home);
    const root = deps.consoleRoot || (m && m.path) || (a.source ? path.resolve(a.source) : PKG_ROOT);
    if (exists(path.join(root, 'claude', 'setup.json'))) {
      const plan = setup.planSetup({ consoleRoot: root, configDir: a['config-dir'] && a['config-dir'] !== true ? path.resolve(a['config-dir']) : setup.configDirFor(process.env), nodePath: deps.nodePath, statuslinePath: setup.statuslineFor(L, root) });
      r.setupPlan = plan.actions.map((x) => ({ id: x.id, status: x.status, selected: x.selected }));
      if (a.setup) lines.push(...setup.planLines(plan), 'apply with: claude-console setup --apply --yes');
      else lines.push('Claude commands/settings the console ships: review with `claude-console setup` (nothing is written without --apply --yes)');
    }
    emit(r, lines);
    return /^(installed|updated|updated-with-conflicts|already-installed|repaired)$/.test(r.status) ? 0 : 1;
  }

  if (cmd === 'status') {
    const d = await detect(Object.assign({ home: L.home, port }, detectOpts));
    const lines = ['home: ' + L.home, 'installed: ' + (d.marker ? 'v' + d.marker.version : 'no')];
    for (const g of d.legacy) lines.push('legacy: ' + g.path + ' v' + (g.version || '?'));
    lines.push('server: ' + (d.running ? 'running' + (d.running.version ? ' v' + d.running.version : '') : 'not running'));
    emit(d, lines);
    return 0;
  }

  if (cmd === 'start') {
    const m = readMarker(L.home);
    if (!m) { out('not installed; run: claude-console install'); return 1; }
    const run = deps.startServer || startServer;
    const app = run(L, m, !!a.open, deps.nodePath);
    emit({ started: true, version: m.version, app }, ['starting v' + m.version]);
    return 0;
  }

  if (cmd === 'stop') {
    // CON-0.1.1: "stopped" only once the server PROCESS is gone (not just the port).
    const stopper = require('./stop');
    const timeoutMs = a.timeout && a.timeout !== true ? Math.max(1, +a.timeout) * 1000 : 10000;
    const r = await stopper.stopServer(Object.assign(procDeps(deps), { run: L.run, home: L.home, port, token: readToken(L.run), force: !!a.force, timeoutMs }));
    emit(Object.assign({ stopped: r.ok }, r), [stopper.stopLine(r, port)]);
    return r.ok ? 0 : 1;
  }

  if (cmd === 'rollback') {
    // CON-0.1.3: stop the console first (it runs from the version rolled away from, so
    // the next update could not move that folder: EBUSY), switch with retries, set the
    // Apps & features version, start the console again on the previous version.
    const upd = require('./update');
    const m = readMarker(L.home);
    const r = await upd.rollbackSwap({ home: L.home, nodePath: deps.nodePath, npmCi: deps.npmCi, writeArp: deps.writeArp, retry: deps.retry,
      beforeSwap: swapHook(L, port, deps, m ? 'v' + m.version : 'this install'), restart: () => restartAfterSwap(L, port, deps) });
    if (r.status === 'blocked') { emit(r, [r.line]); return 1; }
    const lines = ['rolled back v' + r.from + ' -> v' + r.to];
    const al = upd.arpLine(r.arp);
    if (al) lines.push(al);
    if (r.restarted) lines.push('restarted the console on v' + r.restarted);
    emit(r, lines);
    return 0;
  }

  if (cmd === 'update') return cmdUpdate(a, L, deps, emit, out, port);

  if (cmd === 'reinstall') {
    const rep = require('./repair');
    const pf = rep.preflight({ home: L.home });
    if (!a.confirm) {
      const lines = ['Reinstall pre-flight (read-only), installed v' + pf.version,
        'local tweaks: ' + pf.tweaks.length + (pf.tweaks.length ? ' (' + pf.tweaks.map((t) => t.rel).join(', ') + ')' : ''),
        'kept: ' + pf.keep.join(', '),
        'lost by fresh: ' + (pf.lose.fresh.join(', ') || 'nothing'),
        'lost by factory: ' + (pf.lose.factory.join(', ') || 'nothing'),
        'can: ' + pf.can.join('; '), 'cannot: ' + pf.cannot.join('; '),
        'to go ahead: claude-console reinstall --mode <repair|fresh|factory> --confirm "' + pf.confirmPhrase + '"' + ' (factory also --factory-confirm "' + pf.factoryPhrase + '")'];
      emit(pf, lines);
      return 0;
    }
    if (!deps.skipRunningCheck) {
      const d = await detect({ home: L.home, port, legacy: [] });
      if (d.running && (a.mode === 'fresh' || a.mode === 'factory')) { out('stop the console first (claude-console stop)'); return 1; }
    }
    const r = await rep.reinstall({ home: L.home, mode: a.mode, confirm: a.confirm, factoryConfirm: a['factory-confirm'], reapply: !!a.reapply, saveTweaks: !a['no-save-tweaks'], releaseDir: a.from ? path.resolve(a.from) : undefined, npmCi: deps.npmCi, selftest: deps.selftest, recycle: deps.recycle, nodePath: deps.nodePath });
    emit(r, ['reinstall: ' + r.status + (r.reason ? ' - ' + r.reason : '')]);
    return r.status === 'refused' || /failed|rolled-back/.test(r.status) ? 1 : 0;
  }

  if (cmd === 'contribute') {
    const c = require('./contribute');
    const settings = require('./settings').normalizeUpdates(cfgOf(L).updates);
    const r = c.makePatch({ home: L.home, repo: settings.repo });
    const lines = ['patch: ' + r.file + ' (' + r.count + ' files, scrubbed)'];
    if (r.issueUrl) lines.push('issue: ' + r.issueUrl.slice(0, 200) + (r.issueUrl.length > 200 ? '...' : ''));
    else lines.push('no public repo configured (updates.repo); share the patch file by hand');
    if (a.send) {
      const s = c.send(r, { confirm: a.yes === true, repo: settings.repo, run: deps.run });
      lines.push(s.sent ? 'sent: ' + s.url : 'not sent: ' + s.reason);
      r.send = s;
    }
    emit(r, lines);
    return 0;
  }

  if (cmd === 'release') {
    if (!a.out || a.out === true) { out('release needs --out DIR'); return 1; }
    const r = require('./release').buildRelease(a.source ? path.resolve(a.source) : PKG_ROOT, path.resolve(a.out), {});
    emit(r.info, ['release v' + r.info.version + ': ' + r.zip, 'sha256 ' + r.sha256 + ' (' + r.info.files + ' files)', 'not uploaded: publishing waits for the operator']);
    return 0;
  }

  if (cmd === 'setup') return require('./setup').cliSetup(a, L, deps, emit, out);
  if (cmd === 'profile') return require('./profile-cli').cliProfile(argv.filter((x, i) => i !== argv.indexOf(cmd)), L, deps, out);
  if (cmd === 'crash-report' || cmd === 'stop-all' || cmd === 'resume' || cmd === 'recover-prompt') return require('./profile-cli').cliRecover(cmd, argv.filter((x, i) => i !== argv.indexOf(cmd)), L, deps, out);
  if (cmd === 'autoupdate') return require('./autoupdate').cliAutoupdate(a, L, deps, emit, out, port);

  out('unknown command: ' + cmd);
  return 2;
}

async function cmdUpdate(a, L, deps, emit, out, port) {
  const upd = require('./update');
  const rel = require('./release');
  const settings = require('./settings').normalizeUpdates(cfgOf(L).updates);
  const m = readMarker(L.home);
  let releaseDir = null;
  if (a.from) releaseDir = upd.requireRelease(path.resolve(a.from)) && path.resolve(a.from);
  else if (a.zip) releaseDir = rel.extractRelease(path.resolve(a.zip), path.join(L.downloads, 'zip-' + Date.now())).dir;
  else {
    const c = await rel.checkReleases({ settings, cacheFile: path.join(L.cache, 'releases.json'), current: m && m.version, fetch: deps.fetch });
    const lines = [c.checked ? (c.available ? 'update available: v' + c.latest.version : 'up to date' + (m ? ' (v' + m.version + ')' : '')) : 'no check: ' + c.reason];
    if (a.check || !c.available) { emit(c, lines); return 0; }
    if (!a.yes) { emit(c, lines.concat(['apply with: claude-console update --yes'])); return 0; }
    releaseDir = (await rel.downloadRelease(c.latest, L.downloads, { fetch: deps.fetch })).dir;
  }
  if (!a.yes) { out('release ready: ' + releaseDir + '; apply with --yes'); return 0; }
  const d = m ? null : await detect(Object.assign({ home: L.home, port, skipProbe: true }, deps.detectOpts || {}));
  const r = await upd.applyUpdate({ home: L.home, releaseDir, legacyDir: d && d.legacy[0] ? d.legacy[0].path : undefined, npmCi: deps.npmCi, selftest: deps.selftest, nodePath: deps.nodePath, reintegrate: deps.reintegrate, force: !!a.force,
    writeArp: deps.writeArp, retry: deps.retry, beforeSwap: m ? swapHook(L, port, deps, null) : null });
  if (r.status === 'blocked') {
    const bl = [r.line];
    if (r.stoppedConsole) { await restartAfterSwap(L, port, deps); bl.push('restarted the console on v' + readMarker(L.home).version); }
    emit(r, bl);
    return 1;
  }
  const lines = ['update: ' + r.status + ' v' + r.from + ' -> v' + r.to];
  const al = upd.arpLine(r.arp);
  if (al) lines.push(al);
  if (r.summary) lines.push('files: ' + JSON.stringify(r.summary));
  for (const f of (r.files || []).filter((x) => x.result === 'conflict')) lines.push('conflict: ' + f.rel + ' (see ' + f.side + ')');
  if (r.localMods && r.localMods.length) lines.push('local mods kept: ' + r.localMods.length + ' - contribute? claude-console contribute');
  if (r.status === 'rolled-back' && r.selftest) {
    for (const t of r.selftest.failed || []) lines.push('failing test: ' + t);
    lines.push('error: ' + (r.selftest.error || r.selftest.detail || 'unknown'));
    if (r.selftest.log) lines.push('full test output: ' + r.selftest.log);
  }
  if (r.reportFile) lines.push('report: ' + r.reportFile);
  // VMFIX: a running console keeps the old version until it restarts. Restart it when
  // no pane is busy; otherwise say how. CON-0.1.3: a console the swap stopped is always
  // started again (on the new version, or on the old one after a failed self-test).
  if (r.stoppedConsole) {
    await restartAfterSwap(L, port, deps);
    lines.push('restarted the console on v' + readMarker(L.home).version);
  } else if (/^updated/.test(r.status)) {
    const au = require('./autoupdate');
    // Tests (fake npm) never probe or restart a real server unless they inject one.
    const probe = deps.serverInfo || (deps.npmCi ? null : au.defaultServerInfo);
    const info = probe ? await probe(L, port) : null;
    if (info && info.version && info.version !== r.from) {
      lines.push('note: the console on port ' + port + ' runs v' + info.version + ', not this install; not restarted');
    } else if (info) {
      const busy = (info.panes || []).filter((p) => p && (p.state === 'busy' || p.state === 'starting')).length;
      if (!busy) {
        await (deps.restart || au.defaultRestart)(L, readMarker(L.home), port);
        lines.push('restarted the console on v' + r.to);
      } else {
        lines.push('restart to use v' + r.to + ': claude-console stop, then claude-console start (' + busy + ' pane(s) busy, so no automatic restart)');
      }
    }
  }
  emit(r, lines);
  return r.status === 'rolled-back' ? 1 : 0;
}

// CON-0.1.3: the stop-before-swap hook for update / rollback. Tests (a fake npmCi) get
// none unless they inject deps.beforeSwap or deps.listServers, so they never probe or
// stop a real server.
function swapHook(L, port, deps, what) {
  if (deps.beforeSwap !== undefined) return deps.beforeSwap;
  if (deps.npmCi && !deps.listServers) return null;
  return require('./swap').realBeforeSwap(L, port, Object.assign(procDeps(deps), { serverInfo: deps.serverInfo, stopTimeoutMs: deps.stopTimeoutMs }), what);
}

function restartAfterSwap(L, port, deps) {
  return require('./swap').startAgain(L, port, deps.nodePath, { startServer: deps.startServer });
}

// Process probes for stop / uninstall (tests inject fakes; none = the real ones).
function procDeps(deps) {
  return { postShutdown: deps.postShutdown, isAlive: deps.isAlive, kill: deps.kill, sleep: deps.sleep, listServers: deps.listServers };
}

const HELP = [
  'claude-console <command> [--home DIR] [--json]',
  '  install    [--source DIR] [--repo OWNER/NAME] [--no-shortcuts]   install or repair (a re-run repairs)',
  '  start [--open] | stop [--force] [--timeout S] | status   stop waits for the server process to exit',
  '  update     [--check] [--from DIR | --zip FILE] [--yes]           restarts the console when no pane is busy',
  '  rollback',
  '  reinstall  shows the pre-flight report and the exact confirm phrase; then:',
  '             reinstall --mode repair|fresh|factory --confirm "reinstall <N>"  (N = local modifications;',
  '             factory also needs --factory-confirm "factory reset")',
  '  uninstall  [--purge]   removes shortcuts, Apps & features entry, PATH entry and code; --purge also user data',
  '  contribute [--send --yes] | release --out DIR | setup [--apply --yes] | autoupdate [--register|--unregister]',
  '  profile    list | view <id> | diff | apply [--preset P] [--only ids] [--apply --yes --ack id] | enable | disable',
  '             | edit <item> | revert [--last|--tx T] | uninstall [<module>|--all] | verify | status | adopt <dir>',
  '             (optional setup profile; dry run unless --apply --yes; --target user|repo:<dir>)',
  '  crash-report [--action issue|claude|save --yes] | stop-all [--yes] | resume [--yes] | recover-prompt [--yes]',
];

module.exports = { run, parseArgs, startServer, postShutdown, PKG_ROOT };
