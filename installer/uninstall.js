'use strict';
// `claude-console uninstall [--purge]` (VMFIX). Stops a running console, removes the
// shell integration (Desktop + Start-menu shortcuts, the Apps & features entry, the
// user PATH entry, the auto-update task) and the code (app/, .base/, cache/, reports/,
// run/, the launchers, the install marker). User data (data/, drops/, backups/) stays
// unless --purge; purged user data goes to the Recycle Bin, never a direct delete.
const fs = require('fs');
const path = require('path');
const { layout } = require('./paths');
const { exists, recycleWindows } = require('./fsutil');
const { readToken } = require('./detect');
const stopper = require('./stop');

const CODE = ['app', '.base', 'cache', 'reports', 'run'];
const FILES = ['install.json', 'launch.vbs', 'claude-console.cmd', 'statusline.js', 'autoupdate.vbs', 'register-autoupdate.ps1'];
const USER = ['data', 'drops', 'backups'];

// o: home, purge, port, removeShell(home), recycle(path), postShutdown(port, token),
// and the stop.js probes (isAlive, kill, sleep, listServers, timeoutMs), rm, retryMs.
// Anything left behind = ok false and ONE "uninstall incomplete: ..." line.
async function uninstall(o) {
  const L = layout(o.home);
  const lines = [];
  const rep = { kind: 'uninstall', home: L.home, removed: [], kept: [], ok: true, lines };
  if (!exists(L.home)) {
    lines.push('nothing to uninstall: ' + L.home + ' does not exist');
    return rep;
  }
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retryMs = o.retryMs || 1000;
  const problems = [];
  // CON-0.1.1: stop = the server PROCESS is gone (it holds app\<v> open), not just the
  // port; one that will not quit is killed (uninstall means it), and a leftover server
  // of an older version, found by its command line, goes the same way.
  const stopOpts = { run: L.run, home: L.home, port: o.port || 7800, token: readToken(L.run), force: true, timeoutMs: o.timeoutMs || 10000, postShutdown: o.postShutdown, isAlive: o.isAlive, kill: o.kill, sleep, listServers: o.listServers };
  const st = await stopper.stopServer(stopOpts);
  if (st.alive.length) problems.push('the console server (pid ' + st.alive.join(', ') + ') would not stop');
  else if (st.running) {
    lines.push('stopped the running console' + (st.killed.length ? ' (killed pid ' + st.killed.join(', ') + ')' : ''));
    await sleep(500); // let it release node-pty and its files
  }
  try {
    const out = await (o.removeShell || require('./launcher').removeShellWindows)(L.home);
    for (const l of out || []) if (l) lines.push(l);
  } catch (e) {
    problems.push('shortcuts / Apps & features / PATH (' + e.message + ')');
  }
  const rm = o.rm || fs.rmSync;
  const errs = {};
  for (const d of CODE) {
    const p = path.join(L.home, d);
    for (let i = 0; i < 5 && exists(p); i++) {
      try {
        rm(p, { recursive: true, force: true, maxRetries: 3 });
        delete errs[d];
      } catch (e) {
        errs[d] = e;
        if (i === 1) await stopper.stopServer(Object.assign({}, stopOpts, { postShutdown: async () => false, timeoutMs: 2000 }));
        await sleep(retryMs);
      }
    }
    if (!exists(p)) rep.removed.push(d);
  }
  for (const f of FILES) {
    const p = path.join(L.home, f);
    if (!exists(p) || f === 'claude-console.cmd') continue;
    try { fs.unlinkSync(p); rep.removed.push(f); } catch (e) { errs[f] = e; }
  }
  // Never report success while files remain: what is still there, and why.
  const left = CODE.concat(FILES).filter((x) => x !== 'claude-console.cmd' && exists(path.join(L.home, x)));
  if (left.length) {
    const why = left.map((x) => errs[x]).find((e) => e);
    problems.push('could not remove ' + left.map((x) => path.join(L.home, x)).join(', ') + (why ? ' (' + (why.code || '') + (why.code ? ': ' : '') + why.message + ')' : ''));
  }
  if (problems.length) {
    rep.ok = false;
    lines.push('uninstall incomplete: ' + problems.join('; ') + ' - close any program using ' + L.home + ' and run claude-console uninstall again');
    return rep;
  }
  // claude-console.cmd is the batch file running this very command: cmd.exe reads it
  // again after node exits, so it goes a few seconds later from a detached process
  // (deleting it now prints "The batch file cannot be found" and exit 1).
  const cmdFile = path.join(L.home, 'claude-console.cmd');
  if (exists(cmdFile)) {
    rep.removed.push('claude-console.cmd');
    (o.deleteLater || deleteLaterWindows)([cmdFile], o.purge ? L.home : null);
  }
  const user = USER.filter((d) => exists(path.join(L.home, d)));
  if (o.purge) {
    const recycle = o.recycle || recycleWindows;
    for (const d of user) { await recycle(path.join(L.home, d)); rep.removed.push(d); }
    let left = [];
    try { left = fs.readdirSync(L.home); } catch (e) { left = []; }
    if (!left.length) { try { fs.rmdirSync(L.home); } catch (e) { /* in use */ } }
    lines.push('uninstalled; user data moved to the Recycle Bin' + (left.length ? ' (left in ' + L.home + ': ' + left.join(', ') + ')' : ''));
  } else {
    rep.kept = user;
    lines.push('uninstalled the code from ' + L.home);
    if (user.length) lines.push('kept your data: ' + user.map((d) => path.join(L.home, d)).join(', ') + ' (remove it too with: claude-console uninstall --purge, or delete the folder)');
  }
  lines.push('Claude Code settings (~/.claude) are not touched; a statusLine entry that points at ' + path.join(L.home, 'statusline.js') + ' can be removed by hand.');
  return rep;
}

// A hidden, detached cmd waits ~3 s, deletes the files, then removes the home when
// it is empty (purge only).
function deleteLaterWindows(files, emptyDir) {
  const q = (s) => '"' + String(s).replace(/"/g, '') + '"';
  let line = 'ping -n 4 127.0.0.1 >nul';
  for (const f of files) line += ' & del /f /q ' + q(f);
  if (emptyDir) line += ' & rmdir ' + q(emptyDir);
  const { spawn } = require('child_process');
  const c = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/c', line], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  c.unref();
}

module.exports = { uninstall, CODE, FILES, USER, deleteLaterWindows };
