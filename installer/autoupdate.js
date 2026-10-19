'use strict';
// CON-AUTOUPDATE: one auto-update tick, run by a per-user scheduled task
// (`claude-console autoupdate`, via <home>\autoupdate.vbs) or by hand. Per tick:
//   1. read the `updates` setting (data/console.local.json) and the tick state
//      (cache/autoupdate.json);
//   2. a staged update whose restart was waiting restarts once no pane is busy;
//   3. check the releases (at most every checkHours; ETag-cached; no repo = no check);
//   4. decideAuto(): manual mode only records the badge; auto applies inside the
//      window; a version already marked "needs review" is not retried;
//   5. apply = download + verify + applyUpdate with requireClean and the Claude
//      re-integration (reintegrate.js) for conflicts; any version skip works because
//      the merge base is always the INSTALLED release;
//   6. restart only when the server runs with no busy pane; else the restart waits.
// No install marker = nothing to do: migrating a legacy console is a manual
// `claude-console install` (never silent).
const fs = require('fs');
const path = require('path');
const { layout } = require('./paths');
const { readJson, writeJsonAtomic } = require('./fsutil');
const { readMarker, readToken, probeServer } = require('./detect');
const { normalizeUpdates, decideAuto, inWindow } = require('./settings');
const release = require('./release');
const upd = require('./update');
const { makeReintegrator, conflictsOf } = require('./reintegrate');

const TASK = 'ClaudeConsole-AutoUpdate';

function statePath(L) { return path.join(L.cache, 'autoupdate.json'); }
function readState(home) { return readJson(statePath(layout(home)), {}) || {}; }

function localCfg(L) { return readJson(path.join(L.data, 'console.local.json'), {}) || {}; }

// Default: /api/info + /api/panes of the running server with the home's token.
async function defaultServerInfo(L, port) {
  const token = readToken(L.run);
  const info = await probeServer(port, token);
  if (!info || info.status !== 200) return info ? { version: null, panes: [] } : null;
  let panes = [];
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/panes', { headers: { 'X-Console-Token': token } });
    const j = await r.json();
    panes = Array.isArray(j.panes) ? j.panes.map((p) => ({ state: p.state })) : [];
  } catch (e) { panes = [{ state: 'busy' }]; } // unknown = assume busy, never restart blind
  return { version: info.version, panes };
}

// Default restart: ask the server to quit, wait until its PROCESS has exited (killed
// after 10 s: no pane is busy by now; CON-0.1.1, an old server that only stopped
// listening kept the old app dir in use), wait until the port is free, start the
// installed version hidden (same path as the launcher).
async function defaultRestart(L, marker, port) {
  const { startServer } = require('./cli');
  await require('./stop').stopServer({ run: L.run, home: L.home, port, token: readToken(L.run), force: true });
  for (let i = 0; i < 40; i++) {
    if (!(await probeServer(port, null, 500))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  startServer(L, marker, false);
}

const busyCount = (panes) => (panes || []).filter((p) => p && (p.state === 'busy' || p.state === 'starting')).length;

// o: home, now, force (ignore checkHours), fetch, serverInfo(L, port), restart(L, marker, port),
//    npmCi, selftest, run (re-integration command runner)
async function tick(o) {
  const L = layout(o.home);
  const now = o.now || new Date();
  const marker = readMarker(L.home);
  if (!marker) return { status: 'not-installed' };
  const cfg = localCfg(L);
  const settings = normalizeUpdates(cfg.updates);
  const port = +(cfg.port || 7800);
  const st = readState(L.home);
  const save = (res) => {
    writeJsonAtomic(statePath(L), Object.assign(st, { lastTick: now.toISOString() }));
    return res;
  };
  const server = await (o.serverInfo || defaultServerInfo)(L, port);
  const restart = o.restart || defaultRestart;

  // 2. a waiting restart
  if (st.pendingRestart && server && server.version && server.version !== marker.version) {
    if (busyCount(server.panes) || !inWindow(settings.window, now)) return save({ status: 'restart-waiting', version: marker.version, busy: busyCount(server.panes) });
    await restart(L, marker, port);
    st.pendingRestart = null;
    return save({ status: 'restarted', version: marker.version });
  }
  if (st.pendingRestart && (!server || server.version === marker.version)) st.pendingRestart = null;

  // 3. check, throttled
  const due = o.force || !st.lastCheckAt || now - new Date(st.lastCheckAt) >= settings.checkHours * 3600000;
  if (due) {
    const c = await release.checkReleases({ settings, cacheFile: path.join(L.cache, 'releases.json'), current: marker.version, fetch: o.fetch });
    st.lastCheckAt = now.toISOString();
    st.check = c.checked ? { available: !!c.available, latest: c.latest || null } : { available: false, reason: c.reason };
  }
  const chk = st.check || { available: false };
  const latest = chk.available && chk.latest && chk.latest.version !== marker.version ? chk.latest : null;
  if (!latest) return save({ status: chk.reason ? 'no-check' : 'up-to-date', reason: chk.reason, version: marker.version });

  // 4. decide
  const needsReview = !!(st.review && st.review.version === latest.version);
  const d = decideAuto({ settings, available: true, now, panes: server ? server.panes : [], serverRunning: !!server, needsReview });
  if (!d.apply) return save({ status: 'available', reason: d.reason, badge: latest.version, version: marker.version });

  // 5. apply
  let rel;
  try {
    rel = await release.downloadRelease(latest, L.downloads, { fetch: o.fetch });
  } catch (e) {
    st.lastResult = { status: 'download-failed', error: e.message, at: now.toISOString() };
    return save({ status: 'download-failed', error: e.message, badge: latest.version });
  }
  const rep = await upd.applyUpdate({
    home: L.home, releaseDir: rel.dir, requireClean: true, npmCi: o.npmCi, selftest: o.selftest, nodePath: o.nodePath, now,
    reintegrate: makeReintegrator({ settings, run: o.run, now }),
  });
  st.lastResult = { status: rep.status, from: rep.from, to: rep.to, at: now.toISOString(), report: rep.reportFile };
  if (rep.status === 'needs-review') {
    st.review = { version: latest.version, conflicts: conflictsOf(rep), prompt: rep.reintegration ? rep.reintegration.prompt : null };
    return save({ status: 'needs-review', badge: latest.version, conflicts: st.review.conflicts, prompt: st.review.prompt, from: rep.from, to: rep.to });
  }
  if (rep.status !== 'updated' && rep.status !== 'updated-with-conflicts') return save({ status: rep.status, from: rep.from, to: rep.to, badge: latest.version });
  st.review = null;
  // 6. restart
  let restarted = false;
  if (d.restart) {
    await restart(L, readMarker(L.home), port);
    restarted = true;
  } else if (server) {
    st.pendingRestart = rep.to;
  }
  return save({ status: 'updated', from: rep.from, to: rep.to, restarted, localMods: rep.localMods });
}

const psQ = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// Per-user scheduled task: daily at the window start, repeated every 15 min through the
// window (a busy-pane restart gets more chances), plus at logon. Version-free action.
// Written to disk by the CLI; the user (or the operator on the other machine) runs it.
function registerScript(L, settings) {
  const s = normalizeUpdates(settings);
  const start = s.window ? s.window.split('-')[0] : '04:00';
  const vbs = path.join(L.home, 'autoupdate.vbs');
  return [
    '# Claude Console auto-update task (CON-AUTOUPDATE). Registers a per-user task; run it yourself.',
    "$ErrorActionPreference = 'Stop'",
    '$name = ' + psQ(TASK),
    "$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\\wscript.exe') -Argument ('\"' + " + psQ(vbs) + " + '\"')",
    '$daily = New-ScheduledTaskTrigger -Daily -At ' + psQ(start),
    '$rep = New-ScheduledTaskTrigger -Once -At ' + psQ(start) + ' -RepetitionInterval (New-TimeSpan -Minutes 15) -RepetitionDuration (New-TimeSpan -Hours 1)',
    '$daily.Repetition = $rep.Repetition',
    '$logon = New-ScheduledTaskTrigger -AtLogOn -User ($env:USERDOMAIN + \'\\\' + $env:USERNAME)',
    '$set = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 55)',
    "Register-ScheduledTask -TaskName $name -Action $action -Trigger @($daily, $logon) -Settings $set -Description 'Claude Console auto-update tick (claude-console autoupdate)' -Force | Out-Null",
    'Get-ScheduledTask -TaskName $name | Select-Object TaskName, State | Format-Table -AutoSize',
    '',
  ].join('\n');
}

function unregisterScript() {
  return [
    '# Removes the Claude Console auto-update task.',
    "$ErrorActionPreference = 'Stop'",
    'Unregister-ScheduledTask -TaskName ' + psQ(TASK) + ' -Confirm:$false',
    '',
  ].join('\n');
}

async function cliAutoupdate(a, L, deps, emit, out) {
  if (a.register || a.unregister) {
    const reg = !!a.register;
    const file = path.join(L.home, reg ? 'register-autoupdate.ps1' : 'unregister-autoupdate.ps1');
    fs.mkdirSync(L.home, { recursive: true });
    fs.writeFileSync(file, reg ? registerScript(L, localCfg(L).updates) : unregisterScript());
    emit({ script: file }, ['wrote ' + file, 'run it yourself: powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + file + '"']);
    return 0;
  }
  const r = await tick({ home: L.home, force: !!a.force, fetch: deps.fetch, serverInfo: deps.serverInfo, restart: deps.restart, npmCi: deps.npmCi, selftest: deps.selftest, run: deps.run, nodePath: deps.nodePath });
  emit(r, ['autoupdate: ' + r.status + (r.reason ? ' (' + r.reason + ')' : '') + (r.badge ? ' - v' + r.badge + ' available' : '') + (r.to ? ' v' + r.from + ' -> v' + r.to : '')]);
  return /failed|rolled-back/.test(r.status) ? 1 : 0;
}

module.exports = { tick, readState, registerScript, unregisterScript, cliAutoupdate, TASK, defaultServerInfo, defaultRestart };
