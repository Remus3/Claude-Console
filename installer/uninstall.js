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

const CODE = ['app', '.base', 'cache', 'reports', 'run'];
const FILES = ['install.json', 'launch.vbs', 'claude-console.cmd', 'statusline.js', 'autoupdate.vbs', 'register-autoupdate.ps1'];
const USER = ['data', 'drops', 'backups'];

// o: home, purge, port, removeShell(home), recycle(path), postShutdown(port, token)
async function uninstall(o) {
  const L = layout(o.home);
  const lines = [];
  const rep = { kind: 'uninstall', home: L.home, removed: [], kept: [], ok: true, lines };
  if (!exists(L.home)) {
    lines.push('nothing to uninstall: ' + L.home + ' does not exist');
    return rep;
  }
  const stop = o.postShutdown || require('./cli').postShutdown;
  if (await stop(o.port || 7800, readToken(L.run))) {
    lines.push('stopped the running console');
    await new Promise((r) => setTimeout(r, 1500)); // let it release node-pty and its files
  }
  try {
    const out = await (o.removeShell || require('./launcher').removeShellWindows)(L.home);
    for (const l of out || []) if (l) lines.push(l);
  } catch (e) {
    rep.ok = false;
    lines.push('could not remove shortcuts / Apps & features / PATH: ' + e.message);
  }
  for (const d of CODE) {
    const p = path.join(L.home, d);
    if (exists(p)) { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); rep.removed.push(d); }
  }
  // claude-console.cmd is the batch file running this very command: cmd.exe reads it
  // again after node exits, so it goes a few seconds later from a detached process
  // (deleting it now prints "The batch file cannot be found" and exit 1).
  const later = [];
  for (const f of FILES) {
    const p = path.join(L.home, f);
    if (!exists(p)) continue;
    if (f === 'claude-console.cmd') { later.push(p); rep.removed.push(f); continue; }
    try { fs.unlinkSync(p); rep.removed.push(f); } catch (e) { rep.ok = false; lines.push('could not remove ' + p + ': ' + e.message); }
  }
  if (later.length) (o.deleteLater || deleteLaterWindows)(later, o.purge ? L.home : null);
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
