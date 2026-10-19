'use strict';
// CON-0.1.2: `uninstall --purge` removed everything but exited 1 with "The system cannot
// find the path specified." (twice). The delayed self-delete was a fixed ~3 s ping: when
// node was still running past it, the launcher and the install folder were gone before
// cmd.exe ran the rest of claude-console.cmd, and cmd.exe re-checks its batch file after
// every command. Now a cleanup script in %TEMP% waits for the CLI's pid (and the
// claude-console.cmd that ran it) to exit before it removes anything.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpdir } = require('./helpers');
const uninstall = require('../installer/uninstall');
const launcher = require('../installer/launcher');
const paths = require('../installer/paths');

const WIN = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

async function until(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (fn()) return true; await sleep(200); }
  return fn();
}

// ------------------------------------------------------------- the cleanup script

test('cleanup script: ASCII, LF, waits on the pids (by creation time) before any delete', () => {
  const s = uninstall.cleanupScript();
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(s), 'ASCII only');
  assert.ok(!s.includes('\r'), 'LF only');
  assert.ok(/^Option Explicit$/m.test(s));
  const loop = s.indexOf('Do While Now < deadline');
  assert.ok(loop > 0, 'waits for the processes');
  assert.ok(loop < s.indexOf('DeleteFile') && loop < s.indexOf('DeleteFolder'), 'nothing is removed before the wait');
  assert.ok(s.includes('CreationDate'), 'a reused pid is not waited on');
  assert.ok(/"claude-console\.cmd"/.test(s), 'the parent is waited on only when it is the cmd running the launcher');
});

test('deleteLater: the script goes to %TEMP% (not the install folder) and gets the CLI pid and its parent', () => {
  const dir = tmpdir('cc-purge-');
  const home = path.join(dir, 'home');
  const calls = [];
  const fake = (exe, args, opts) => { calls.push({ exe, args, opts }); return { unref() {} }; };
  const file = uninstall.deleteLaterWindows([path.join(home, 'claude-console.cmd')], home, { spawn: fake, tmpdir: dir, pid: 111, ppid: 222 });
  assert.strictEqual(path.dirname(file), dir);
  assert.ok(!file.startsWith(home));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), uninstall.cleanupScript());
  assert.strictEqual(calls.length, 1);
  const { exe, args, opts } = calls[0];
  assert.ok(/System32\\wscript\.exe$/i.test(exe), exe);
  assert.deepStrictEqual(args, ['//B', '//Nologo', file, '111', '222', path.join(home, 'claude-console.cmd'), home]);
  assert.strictEqual(opts.detached, true);
  assert.strictEqual(opts.stdio, 'ignore', 'no stray output in the terminal');
  assert.strictEqual(opts.windowsHide, true);
  uninstall.deleteLaterWindows([path.join(home, 'claude-console.cmd')], null, { spawn: fake, tmpdir: dir, pid: 1, ppid: 2 });
  assert.strictEqual(calls[1].args.length, 6, 'plain uninstall keeps the folder (user data)');
});

test('uninstall --purge: the detached cleanup is started last, after every removal and the Recycle Bin', async () => {
  const home = tmpdir('cc-purge-');
  const L = paths.layout(home);
  w(path.join(L.app('0.1.1'), 'server', 'server.js'), '//\n');
  w(L.marker, JSON.stringify({ version: '0.1.1', path: L.app('0.1.1') }));
  w(path.join(home, 'claude-console.cmd'), '@echo off\n');
  w(path.join(L.data, 'layout.json'), '{}');
  w(path.join(L.drops, 'x.txt'), 'x');
  const order = [];
  const r = await uninstall.uninstall({
    home, purge: true, port: 7800, postShutdown: async () => false, isAlive: () => false, kill: () => true, sleep: async () => {},
    listServers: async () => [], removeShell: async () => { order.push('shell'); return []; },
    recycle: async (p) => { order.push('recycle ' + path.basename(p)); fs.rmSync(p, { recursive: true, force: true }); },
    deleteLater: (files, dir) => { order.push('later'); assert.strictEqual(dir, L.home); assert.deepStrictEqual(files, [path.join(L.home, 'claude-console.cmd')]); },
    retryMs: 1,
  });
  assert.strictEqual(r.ok, true, r.lines.join('\n'));
  assert.deepStrictEqual(order, ['shell', 'recycle data', 'recycle drops', 'later']);
  assert.ok(r.lines.some((l) => /^uninstalled; user data moved to the Recycle Bin$/.test(l)), r.lines.join('\n'));
});

// ------------------------------------------------------------- claude-console.cmd

test('claude-console.cmd: passes node\'s own exit code on, on the node line, and names no install path after node', () => {
  const f = launcher.launcherFiles('C:\\h', '0.1.2', 'C:\\node.exe');
  const lines = f.cmd.split('\n').filter((l) => l.trim());
  const at = lines.findIndex((l) => l.includes('claude-console.js'));
  assert.strictEqual(at, lines.length - 1, 'node is the last command: cmd reads nothing more from the file');
  const tail = lines[at].slice(lines[at].lastIndexOf('--home "C:\\h"') + '--home "C:\\h"'.length);
  assert.strictEqual(tail, ' & call exit /b %%errorlevel%%');
  assert.ok(!/C:\\h|%~/.test(tail), 'nothing after node touches the install folder');
});

// ------------------------------------------------------------- real processes (Windows)

// A scratch install whose claude-console.cmd is the real launcher and whose CLI is a stub
// that does what uninstall does at the end - start the real cleanup - then keeps running
// longer than the old fixed 3 s delay, prints its result and exits with `code`.
function stubInstall(code, lingerMs, purge) {
  const home = path.join(tmpdir('cc-purge-real-'), 'claude-console');
  const L = paths.layout(home);
  const f = launcher.writeLaunchers(home, '0.1.2', process.execPath);
  const side = path.join(path.dirname(home), 'side.json');
  const stub = [
    "'use strict';",
    'const fs = require("fs");',
    'const { deleteLaterWindows } = require(' + JSON.stringify(path.join(__dirname, '..', 'installer', 'uninstall.js')) + ');',
    'const home = ' + JSON.stringify(L.home) + ';',
    'for (const n of fs.readdirSync(home)) if (n !== "claude-console.cmd") fs.rmSync(require("path").join(home, n), { recursive: true, force: true });',
    'const script = deleteLaterWindows([' + JSON.stringify(f.cmdPath) + '], ' + (purge ? 'home' : 'null') + ');',
    'fs.writeFileSync(' + JSON.stringify(side) + ', JSON.stringify({ script, pid: process.pid }));',
    'setTimeout(() => { process.stdout.write("uninstalled\\n"); process.exit(' + code + '); }, ' + lingerMs + ');',
    '',
  ].join('\n');
  w(path.join(L.app('0.1.2'), 'bin', 'claude-console.js'), stub);
  return { home, cmdPath: f.cmdPath, side };
}

function runCmd(cmdPath, args) {
  // What PowerShell does for `claude-console uninstall --purge` found on PATH.
  return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', '""' + cmdPath + '" ' + args + '"'], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, cwd: os.tmpdir() });
}

test('real cmd.exe: uninstall --purge exits 0, prints only its result, then the folder and the script are gone', { skip: !WIN && 'Windows only', timeout: 60000 }, async () => {
  const s = stubInstall(0, 4500, true);
  const r = runCmd(s.cmdPath, 'uninstall --purge');
  assert.strictEqual(r.stderr, '', 'no "The system cannot find the path specified."');
  assert.strictEqual(r.stdout, 'uninstalled\n');
  assert.strictEqual(r.status, 0);
  const { script } = JSON.parse(fs.readFileSync(s.side, 'utf8'));
  assert.ok(await until(() => !fs.existsSync(s.home) && !fs.existsSync(script), 20000), 'install folder and cleanup script removed after the CLI exited');
});

test('real cmd.exe: plain uninstall exits 0 and removes only the launcher', { skip: !WIN && 'Windows only', timeout: 60000 }, async () => {
  const s = stubInstall(0, 4500, false);
  w(path.join(s.home, 'data', 'keep.json'), '{}');
  const r = runCmd(s.cmdPath, 'uninstall');
  assert.strictEqual(r.stderr, '');
  assert.strictEqual(r.stdout, 'uninstalled\n');
  assert.strictEqual(r.status, 0);
  assert.ok(await until(() => !fs.existsSync(s.cmdPath), 20000), 'launcher removed');
  assert.ok(fs.existsSync(s.home), 'plain uninstall leaves the folder');
});

test('real cmd.exe: a non-zero CLI exit code reaches the caller unchanged', { skip: !WIN && 'Windows only', timeout: 60000 }, async () => {
  const s = stubInstall(3, 200, true);
  const r = runCmd(s.cmdPath, 'uninstall --purge');
  assert.strictEqual(r.status, 3, r.stdout + r.stderr);
  assert.strictEqual(r.stderr, '');
  assert.ok(await until(() => !fs.existsSync(s.home), 20000));
});
