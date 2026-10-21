'use strict';
// CON-TASKKILL (found in the 0.1.3 release run): `taskkill /PID <p>
// /T /F` selects the tree by ParentProcessId, which Windows never clears when a parent
// exits, and a reused pid then makes an UNRELATED process look like a child: the suite's
// silent whole-file exits (3 of 19 console-less runs) and a possible hit on a user process.
// This kills only VERIFIED descendants: a process joins the tree when its parent is in
// the tree AND it was created at or after that parent's creation (a process that predates
// the pid's current holder cannot be its child). The root itself must have been created
// at or after `sinceMs` (the moment we spawned it, minus a small clock slack), else its pid
// was reused and nothing is killed. Each pid is ended alone (`taskkill /PID x /F`, no /T),
// deepest first and the root last; "not found" (exit 128: it already ended with its
// parent, e.g. a node child in its parent's job object) counts as ended. Without a
// process list only the root is ended, never a /T walk.
const { spawnSync, execFile } = require('child_process');

const SLACK_MS = 2000;
// pid|ppid|creation ms since epoch (UTC), one line per process.
const PS_LIST = "Get-CimInstance Win32_Process | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { [long]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds } else { 0 }) }";

function parseList(out) {
  const rows = [];
  for (const ln of String(out || '').split(/\r?\n/)) {
    const m = /^(\d+)\|(\d+)\|(\d+)$/.exec(ln.trim());
    if (m) rows.push({ pid: +m[1], ppid: +m[2], created: +m[3] });
  }
  return rows.length ? rows : null;
}

// rows: [{pid, ppid, created}]. Returns the verified tree, root first (parents before
// children), or [] when the
// root is gone or its pid now belongs to a process created before sinceMs.
function verifiedTree(rows, rootPid, sinceMs) {
  const by = new Map((rows || []).map((r) => [r.pid, r]));
  const root = by.get(rootPid);
  if (!root) return [];
  if (typeof sinceMs === 'number' && sinceMs > 0 && root.created && root.created < sinceMs - SLACK_MS) return [];
  const tree = [root.pid];
  const inTree = new Map([[root.pid, root.created]]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (inTree.has(r.pid) || !inTree.has(r.ppid) || r.pid === r.ppid) continue;
      if (r.created && r.created < inTree.get(r.ppid)) continue; // predates the parent: pid reuse
      inTree.set(r.pid, r.created);
      tree.push(r.pid);
      grew = true;
    }
  }
  return tree;
}

function listSync(run) {
  const r = (run || spawnSync)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1048576, encoding: 'utf8' });
  return r && r.status === 0 ? parseList(r.stdout) : null;
}
function listAsync() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1048576 }, (err, out) => resolve(err ? null : parseList(out)));
  });
}

function endOne(pid, run) {
  const r = (run || spawnSync)('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 15000 });
  return !!r && (r.status === 0 || r.status === 128);
}

// Synchronous: list, verify, end each. opts {list, kill} for tests. Returns the pids ended.
function killTreeSync(pid, sinceMs, opts) {
  opts = opts || {};
  if (!pid) return [];
  if (process.platform !== 'win32' && !opts.list) {
    try { process.kill(-pid, 'SIGKILL'); } catch (e) { try { process.kill(pid, 'SIGKILL'); } catch (x) { /* gone */ } }
    return [pid];
  }
  const rows = (opts.list || listSync)();
  const kill = opts.kill || endOne;
  // CON-AUDIT SEC-6: with a spawn time but no list, the root's pid cannot be verified: end nothing
  const tree = rows ? verifiedTree(rows, pid, sinceMs) : sinceMs > 0 ? [] : [pid];
  return tree.reverse().filter((p) => kill(p));
}

async function killTree(pid, sinceMs, opts) {
  opts = opts || {};
  if (!pid) return [];
  if (process.platform !== 'win32' && !opts.list) return killTreeSync(pid, sinceMs, opts);
  const rows = await (opts.list || listAsync)();
  const kill = opts.kill || ((p) => new Promise((resolve) => execFile('taskkill.exe', ['/PID', String(p), '/F'], { windowsHide: true, timeout: 15000 }, (err) => resolve(!err || err.code === 128))));
  const tree = rows ? verifiedTree(rows, pid, sinceMs) : sinceMs > 0 ? [] : [pid];
  const ended = [];
  for (const p of tree.reverse()) if (await kill(p)) ended.push(p);
  return ended;
}

module.exports = { SLACK_MS, PS_LIST, parseList, verifiedTree, killTreeSync, killTree };
