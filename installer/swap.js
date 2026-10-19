'use strict';
// Folder swaps while a console may be running (CON-0.1.3 BUGFIX). Windows refuses to
// rename or replace a folder a running process has open (EBUSY / EPERM): an `update`
// right after `rollback` hit it, because the console still ran from the folder the
// update had to move aside. Update and rollback therefore stop the console that runs
// from this home first (installer/stop.js, which waits for the PROCESS to exit), retry
// the swap with a bounded backoff, and start the console again when it was running.
// A pane that is busy is never killed for a swap: the swap is refused with one line.
const path = require('path');
const stopper = require('./stop');

const SWAP_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
const DELAYS = [250, 500, 1000, 2000, 4000]; // 6 tries, about 8 s in all

// Runs fn; on a "folder in use" error retries after each delay. The last error is
// thrown with swapFailed = true and the number of tries.
async function retrySwap(fn, o) {
  o = o || {};
  const delays = o.delays || DELAYS;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!SWAP_CODES.has(e && e.code)) throw e;
      if (i >= delays.length) {
        e.swapFailed = true;
        e.tries = i + 1;
        throw e;
      }
      await sleep(delays[i]);
    }
  }
}

const norm = (s) => String(s || '').replace(/\//g, '\\').replace(/"/g, '').replace(/\\+$/, '').toLowerCase();
const busyCount = (panes) => (panes || []).filter((p) => p && (p.state === 'busy' || p.state === 'starting')).length;

// listed: [{pid, commandLine}] from stop.listServers. dirs: folders the swap touches.
// No dirs = any console of this home counts.
function serversIn(listed, dirs) {
  if (!dirs || !dirs.length) return listed.slice();
  const ds = dirs.map((d) => norm(d) + '\\');
  return listed.filter((x) => ds.some((d) => norm(x.commandLine).includes(d)));
}

// o: L, port, dirs, token, force, procs {listServers, postShutdown, isAlive, kill, sleep},
//    serverInfo(L, port) -> {version, panes} | null.
// Returns {running, stopped, ok, busy, pids, line}: ok = the swap may go ahead.
async function stopForSwap(o) {
  const procs = o.procs || {};
  const listServers = procs.listServers || stopper.listServersWindows;
  const listed = await listServers(o.L.home);
  let hit;
  if (listed) hit = serversIn(listed, o.dirs);
  else hit = (await (o.serverInfo || (async () => null))(o.L, o.port)) ? [{ pid: null }] : [];
  if (!hit.length) return { running: false, stopped: false, ok: true, busy: 0, pids: [] };
  const info = o.serverInfo ? await o.serverInfo(o.L, o.port) : null;
  const busy = info ? busyCount(info.panes) : 0;
  if (busy && !o.force) {
    return { running: true, stopped: false, ok: false, busy, pids: hit.map((x) => x.pid),
      line: 'the console is running from ' + (o.dirs && o.dirs.length ? 'v' + path.basename(o.dirs[0]) : (o.what || 'this install')) + ' with ' + busy + ' busy pane(s); finish them, run claude-console stop, then run this again' };
  }
  const r = await stopper.stopServer({
    run: o.L.run, home: o.L.home, port: o.port, token: o.token, force: true, timeoutMs: o.timeoutMs || 10000,
    postShutdown: procs.postShutdown, isAlive: procs.isAlive, kill: procs.kill, sleep: procs.sleep, listServers: async () => listed,
  });
  if (r.alive.length) return { running: true, stopped: false, ok: false, busy, pids: r.pids, line: stopper.stopLine(r, o.port) };
  return { running: true, stopped: true, ok: true, busy, pids: r.pids, version: info && info.version };
}

// The real hook for the CLI and the auto-update tick (never the in-server update: it
// would stop itself).
function realBeforeSwap(L, port, deps, what) {
  const { readToken } = require('./detect');
  deps = deps || {};
  return (dirs) => stopForSwap({ L, port, dirs, what, token: readToken(L.run), procs: deps, timeoutMs: deps.stopTimeoutMs, serverInfo: deps.serverInfo || require('./autoupdate').defaultServerInfo });
}

// Start the console again after a swap stopped it: wait for the port to free, then
// start the installed version hidden (the launcher's path).
async function startAgain(L, port, nodePath, o) {
  o = o || {};
  const { readMarker, probeServer } = require('./detect');
  const marker = readMarker(L.home);
  if (!marker) return null;
  if (o.startServer) return o.startServer(L, marker, false, nodePath);
  for (let i = 0; i < 40; i++) {
    if (!(await probeServer(port, null, 500))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return require('./cli').startServer(L, marker, false, nodePath);
}

function blockedLine(kind, dir, e) {
  return kind + ' blocked: ' + path.basename(dir) + ' is still in use (' + (e.code || e.message) + ' after ' + (e.tries || 1) +
    ' tries); close what holds it (claude-console stop --force), then run claude-console ' + kind + ' again';
}

module.exports = { retrySwap, stopForSwap, realBeforeSwap, startAgain, serversIn, blockedLine, SWAP_CODES, DELAYS };
