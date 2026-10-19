'use strict';
// Stop the console server and WAIT FOR ITS PROCESS to exit (CON-0.1.1). A closed port
// is not proof: v0.1.0's server stopped listening but stayed alive (connections held
// its close open), and kept the app dir in use, so `uninstall` failed with EPERM.
//
// Which processes: the pid in <run>\server.json, plus every node process whose
// command line runs <home>\app\...\server\server.js (an older version's leftover
// server, which no longer owns the port). A pid is killed only when it is in that
// command-line list, so a stale server.json pid reused by another program is never hit;
// when the list cannot be read (no PowerShell), the server.json pid is trusted.
const path = require('path');
const { execFile } = require('child_process');
const { readJson } = require('./fsutil');

function readServerPid(runDir) {
  const j = readJson(path.join(runDir, 'server.json'), null);
  return j && Number.isInteger(j.pid) && j.pid > 0 ? j.pid : null;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function killPid(pid) {
  try {
    process.kill(pid); // TerminateProcess on Windows
    return true;
  } catch (e) {
    return false;
  }
}

const norm = (s) => String(s || '').replace(/\//g, '\\').replace(/"/g, '').toLowerCase();

// rows: [{ProcessId, Name, CommandLine}] (Win32_Process). Pure, for tests.
function matchServers(rows, home, selfPid) {
  const app = norm(path.join(home, 'app')) + '\\';
  const out = [];
  for (const r of rows || []) {
    const pid = +r.ProcessId;
    if (!pid || pid === selfPid) continue;
    if (!/^node(\.exe)?$/i.test(String(r.Name || 'node.exe'))) continue;
    const cl = norm(r.CommandLine);
    const at = cl.indexOf(app);
    if (at < 0) continue;
    if (!/\\server\\server\.js(\s|$)/.test(cl.slice(at))) continue;
    out.push({ pid, commandLine: String(r.CommandLine || '') });
  }
  return out;
}

// Real lister: one hidden PowerShell CIM query. null = could not list.
function listServersWindows(home) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 30000 }, (err, out) => {
      if (err) return resolve(null);
      let rows = [];
      try {
        const j = JSON.parse(String(out).trim() || '[]');
        rows = Array.isArray(j) ? j : [j];
      } catch (e) {
        return resolve(null);
      }
      resolve(matchServers(rows, home, process.pid));
    });
  });
}

// o: run, home, port, token, force, timeoutMs (10000), postShutdown(port, token),
// isAlive(pid), kill(pid), sleep(ms), listServers(home) -> [{pid}] | null.
// Returns {answered, running, pids, alive, killed, ok}:
//   running = there was something to stop; ok = it is all gone.
async function stopServer(o) {
  const alive = o.isAlive || isAlive;
  const kill = o.kill || killPid;
  const sleep = o.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = o.timeoutMs || 10000;
  const step = 250;
  const listed = await (o.listServers || listServersWindows)(o.home);
  const filePid = readServerPid(o.run);
  const pids = [];
  const add = (p) => { if (p && p !== process.pid && !pids.includes(p) && alive(p)) pids.push(p); };
  if (filePid && (!listed || listed.some((x) => x.pid === filePid))) add(filePid);
  for (const x of listed || []) add(x.pid);
  const post = o.postShutdown || require('./cli').postShutdown;
  const answered = await post(o.port || 7800, o.token);
  const waitGone = async (ms) => {
    for (let t = 0; t < ms; t += step) {
      if (!pids.some((p) => alive(p))) return;
      await sleep(step);
    }
  };
  if (pids.length) await waitGone(timeoutMs);
  const killed = [];
  if (o.force) {
    for (const p of pids.filter((x) => alive(x))) if (kill(p)) killed.push(p);
    if (killed.length) await waitGone(5000);
  }
  const left = pids.filter((p) => alive(p));
  const running = answered || pids.length > 0;
  return { answered, running, pids, alive: left, killed, ok: running && !left.length, timeoutMs };
}

function stopLine(r, port) {
  if (!r.running) return 'no console answered on port ' + port;
  if (r.alive.length) {
    return 'stop failed: the console server (pid ' + r.alive.join(', ') + ') is still running after '
      + Math.round(r.timeoutMs / 1000) + ' s' + (r.killed.length ? ' and a kill' : '; run: claude-console stop --force');
  }
  return 'stopped' + (r.killed.length ? ' (killed pid ' + r.killed.join(', ') + ')' : '');
}

module.exports = { stopServer, stopLine, matchServers, listServersWindows, readServerPid, isAlive, killPid };
