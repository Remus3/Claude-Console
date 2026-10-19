'use strict';
// CON-0.1.1: `claude-console stop` / `uninstall` left the server alive (VMTEST2, run5).
// The http server's close() waited on connections nobody closed: a connected app
// window's pane WebSocket and an open keep-alive request. Here a fake peer holds a
// half-sent request and a raw WebSocket that never answers the close frame.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createConsoleServer } = require('../server/server');
const { makeFixture, tmpdir } = require('./helpers');
const stopper = require('../installer/stop');
const uninstall = require('../installer/uninstall');
const launcher = require('../installer/launcher');
const paths = require('../installer/paths');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

// A keep-alive request whose headers never finish: an ACTIVE connection, so
// server.close() alone waits for it (headersTimeout, 60 s).
function stuckRequest(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET /api/info HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nConnection: keep-alive\r\n');
      resolve(s);
    });
    s.on('error', reject);
  });
}

// A raw WebSocket peer that upgrades and then never reads or answers a close frame.
function deafWebSocket(port, pathname) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write('GET ' + pathname + ' HTTP/1.1\r\nHost: 127.0.0.1:' + port + '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + 'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    let head = '';
    const onData = (d) => {
      head += d.toString('latin1');
      if (head.includes('\r\n\r\n')) {
        s.off('data', onData);
        if (!/^HTTP\/1\.1 101 /.test(head)) return reject(new Error('no upgrade: ' + head.split('\r\n')[0]));
        s.pause(); // deaf from here on: never reads, never answers the close frame
        resolve(s);
      }
    };
    s.on('data', onData);
    s.on('error', () => {});
  });
}

const closed = (s) => new Promise((r) => { if (s.destroyed) r(); else s.once('close', r); s.resume(); });

test('server close(): open keep-alive request and a deaf pane WebSocket do not hold it open', { timeout: 60000 }, async () => {
  const fx = makeFixture();
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, resources: false, overrides: Object.assign({}, fx.overrides, { defaultShell: 'cmd' }) });
  const r = await fetch('http://127.0.0.1:' + srv.port + '/api/panes', { method: 'POST', headers: { 'X-Console-Token': srv.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'shell', projectId: 'alpha', cols: 80, rows: 24 }) });
  assert.strictEqual(r.status, 201);
  const id = (await r.json()).id;
  const req = await stuckRequest(srv.port);
  const ws = await deafWebSocket(srv.port, '/ws/pane/' + id + '?t=' + srv.token);
  const ev = await deafWebSocket(srv.port, '/ws/events?t=' + srv.token);
  const t0 = Date.now();
  await Promise.race([srv.close(), sleep(15000).then(() => { throw new Error('close() still waiting after 15 s'); })]);
  const took = Date.now() - t0;
  assert.ok(took < 8000, 'close() took ' + took + ' ms');
  await Promise.all([closed(req), closed(ws), closed(ev)]);
});

test('POST /api/shutdown: the process exits even while a peer holds connections open', { timeout: 60000 }, async () => {
  const fx = makeFixture();
  const script = [
    "const { createConsoleServer } = require(" + JSON.stringify(path.join(__dirname, '..', 'server', 'server.js')) + ');',
    'const o = JSON.parse(process.env.CC_SHUTDOWN_TEST);',
    // A leaked handle keeps the event loop alive: only the forced exit ends the process.
    'setInterval(() => {}, 1000);',
    'createConsoleServer({ port: 0, dataDir: o.dataDir, runDir: o.runDir, resources: false, exitOnShutdown: true, shutdownGraceMs: 1500, overrides: o.overrides })',
    '  .then((s) => process.stdout.write(JSON.stringify({ port: s.port, token: s.token }) + "\\n"));',
  ].join('\n');
  const env = Object.assign({}, process.env, { CC_SHUTDOWN_TEST: JSON.stringify({ dataDir: fx.dataDir, runDir: fx.runDir, overrides: fx.overrides }) });
  const child = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const info = await new Promise((resolve, reject) => {
    let b = '';
    child.stdout.on('data', (d) => { b += d; const i = b.indexOf('\n'); if (i >= 0) resolve(JSON.parse(b.slice(0, i))); });
    child.on('exit', () => reject(new Error('child exited before listening')));
  });
  const req = await stuckRequest(info.port);
  const ev = await deafWebSocket(info.port, '/ws/events?t=' + info.token);
  const t0 = Date.now();
  const res = await fetch('http://127.0.0.1:' + info.port + '/api/shutdown', { method: 'POST', headers: { 'X-Console-Token': info.token } });
  assert.strictEqual(res.status, 200);
  const code = await Promise.race([exited, sleep(20000).then(() => 'alive')]);
  if (code === 'alive') child.kill();
  assert.notStrictEqual(code, 'alive', 'the server process is still running 20 s after /api/shutdown');
  assert.ok(Date.now() - t0 < 10000, 'exit took ' + (Date.now() - t0) + ' ms');
  req.destroy();
  ev.destroy();
});

// ------------------------------------------------------------- stop

function fakeProcs(alive) {
  const calls = { post: 0, kill: [] };
  return {
    calls,
    alive,
    isAlive: (pid) => alive.has(pid),
    kill: (pid) => { calls.kill.push(pid); alive.delete(pid); return true; },
    sleep: async () => {},
  };
}

test('stop: waits for the server pid to exit, not just for the port', async () => {
  const run = tmpdir('cc-stop-');
  w(path.join(run, 'server.json'), JSON.stringify({ pid: 4242, port: 7800 }));
  const f = fakeProcs(new Set([4242]));
  let polls = 0;
  const isAlive = (pid) => { polls++; if (polls > 3) f.alive.delete(pid); return f.alive.has(pid); };
  const r = await stopper.stopServer({ run, port: 7800, postShutdown: async () => true, isAlive, kill: f.kill, sleep: f.sleep, listServers: async () => null });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.pids, [4242]);
  assert.ok(polls > 3, 'polled until the pid was gone');
  assert.deepStrictEqual(f.calls.kill, []);
});

test('stop: a server that stays alive is a failure; --force kills it', async () => {
  const run = tmpdir('cc-stop-');
  w(path.join(run, 'server.json'), JSON.stringify({ pid: 4242, port: 7800 }));
  const f = fakeProcs(new Set([4242]));
  const o = { run, port: 7800, timeoutMs: 1000, postShutdown: async () => true, isAlive: f.isAlive, kill: f.kill, sleep: f.sleep, listServers: async () => [{ pid: 4242 }] };
  const r = await stopper.stopServer(o);
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.alive, [4242]);
  assert.ok(/still running/.test(stopper.stopLine(r, 7800)) && /--force/.test(stopper.stopLine(r, 7800)), stopper.stopLine(r, 7800));
  const k = await stopper.stopServer(Object.assign({}, o, { force: true }));
  assert.strictEqual(k.ok, true);
  assert.deepStrictEqual(k.killed, [4242]);
  assert.ok(/stopped/.test(stopper.stopLine(k, 7800)));
});

test('stop: a stale server.json pid that is not a console server is never killed', async () => {
  const run = tmpdir('cc-stop-');
  w(path.join(run, 'server.json'), JSON.stringify({ pid: 999, port: 7800 }));
  const f = fakeProcs(new Set([999]));
  const r = await stopper.stopServer({ run, port: 7800, force: true, timeoutMs: 500, postShutdown: async () => false, isAlive: f.isAlive, kill: f.kill, sleep: f.sleep, listServers: async () => [] });
  assert.deepStrictEqual(f.calls.kill, [], 'pid 999 is not in the console server list');
  assert.strictEqual(r.running, false);
  assert.ok(/no console answered/.test(stopper.stopLine(r, 7800)));
});

test('stop: a leftover server of an older version (listed by its command line) is waited for too', async () => {
  const run = tmpdir('cc-stop-');
  const f = fakeProcs(new Set([77]));
  const r = await stopper.stopServer({ run, port: 7800, force: true, timeoutMs: 500, postShutdown: async () => false, isAlive: f.isAlive, kill: f.kill, sleep: f.sleep, listServers: async () => [{ pid: 77 }] });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.killed, [77]);
});

test('listServers: matches node server.js processes under the home app dir only', () => {
  const home = 'C:\\Users\\x\\AppData\\Local\\Programs\\claude-console';
  const rows = [
    { ProcessId: 10, Name: 'node.exe', CommandLine: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\x\\AppData\\Local\\Programs\\claude-console\\app\\0.1.0\\server\\server.js --open' },
    { ProcessId: 11, Name: 'node.exe', CommandLine: '"C:\\Program Files\\nodejs\\node.exe" "c:\\users\\x\\appdata\\local\\programs\\claude-console\\app\\0.1.1\\bin\\claude-console.js" uninstall' },
    { ProcessId: 12, Name: 'node.exe', CommandLine: 'node C:\\Other\\app\\0.1.0\\server\\server.js' },
    { ProcessId: 13, Name: 'msedge.exe', CommandLine: 'msedge --app=http://127.0.0.1:7800/' },
    { ProcessId: 14, Name: 'node.exe', CommandLine: 'node "C:\\Users\\x\\AppData\\Local\\Programs\\claude-console\\app\\0.1.1\\server\\server.js"' },
  ];
  assert.deepStrictEqual(stopper.matchServers(rows, home, 999).map((x) => x.pid), [10, 14]);
  assert.deepStrictEqual(stopper.matchServers(rows, home, 10).map((x) => x.pid), [14], 'never itself');
});

// ------------------------------------------------------------- uninstall

function installedHome() {
  const root = tmpdir('cc-un-');
  const home = path.join(root, 'home');
  const L = paths.layout(home);
  w(path.join(L.app('0.1.0'), 'server', 'server.js'), '//\n');
  w(path.join(L.base('0.1.0'), 'server', 'server.js'), '//\n');
  w(L.marker, JSON.stringify({ version: '0.1.0', path: L.app('0.1.0') }));
  w(path.join(home, 'claude-console.cmd'), '@echo off\n');
  w(path.join(home, 'launch.vbs'), "'\n");
  w(path.join(L.run, 'server.json'), JSON.stringify({ pid: 4242, port: 7800 }));
  w(path.join(L.data, 'layout.json'), '{}');
  return { home, L };
}

test('uninstall: stops and verifies the server is gone, retries a busy removal', async () => {
  const { home, L } = installedHome();
  const f = fakeProcs(new Set([4242]));
  let fails = 2;
  const rm = (p, o) => { if (p === L.appRoot && fails-- > 0) { const e = new Error('EPERM, Permission denied: ' + p); e.code = 'EPERM'; throw e; } fs.rmSync(p, o); };
  const later = [];
  const r = await uninstall.uninstall({ home, port: 7800, postShutdown: async () => true, isAlive: f.isAlive, kill: f.kill, sleep: f.sleep, listServers: async () => [...f.alive].map((pid) => ({ pid })), rm, removeShell: async () => [], deleteLater: (files) => later.push(...files), retryMs: 1 });
  assert.strictEqual(r.ok, true, r.lines.join('\n'));
  assert.deepStrictEqual(f.calls.kill, [4242], 'uninstall stops with --force semantics');
  assert.ok(!fs.existsSync(L.appRoot) && !fs.existsSync(L.baseRoot) && !fs.existsSync(L.marker));
  assert.deepStrictEqual(later, [path.join(L.home, 'claude-console.cmd')]);
  assert.ok(r.lines.some((l) => /^uninstalled the code from /.test(l)), r.lines.join('\n'));
});

test('uninstall: anything left behind = non-zero, one clear line, never "uninstalled"', async () => {
  const { home, L } = installedHome();
  const f = fakeProcs(new Set());
  const rm = (p, o) => { if (p === L.appRoot) { const e = new Error("EPERM, Permission denied: '" + p + "'"); e.code = 'EPERM'; throw e; } fs.rmSync(p, o); };
  const later = [];
  const lines = [];
  const cli = require('../installer/cli');
  const code = await cli.run(['uninstall', '--home', home], { out: (s) => lines.push(s), postShutdown: async () => false, isAlive: f.isAlive, kill: f.kill, sleep: f.sleep, listServers: async () => [], rm, removeShell: async () => [], deleteLater: (files) => later.push(...files), retryMs: 1 });
  assert.strictEqual(code, 1);
  const bad = lines.filter((l) => /^uninstall incomplete: /.test(l));
  assert.strictEqual(bad.length, 1, lines.join('\n'));
  assert.ok(bad[0].includes(L.appRoot) && /EPERM/.test(bad[0]), bad[0]);
  assert.ok(!lines.some((l) => /^uninstalled/.test(l)), lines.join('\n'));
  assert.deepStrictEqual(later, [], 'the CLI stays so the uninstall can be run again');
  assert.ok(fs.existsSync(path.join(home, 'claude-console.cmd')));
});

test('uninstall: a server that will not die is reported, not ignored', async () => {
  const { home } = installedHome();
  const f = fakeProcs(new Set([4242]));
  const r = await uninstall.uninstall({ home, port: 7800, postShutdown: async () => true, isAlive: f.isAlive, kill: () => false, sleep: f.sleep, listServers: async () => [{ pid: 4242 }], rm: fs.rmSync, removeShell: async () => [], deleteLater: () => {}, retryMs: 1, timeoutMs: 100 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.lines.some((l) => /pid 4242/.test(l)), r.lines.join('\n'));
});

// ------------------------------------------------------------- launcher exit code

test('claude-console.cmd passes the CLI exit code on (exit /b alone returned 0 from PowerShell)', () => {
  const f = launcher.launcherFiles('C:\\h', '0.1.1', 'C:\\node.exe');
  const line = f.cmd.split('\n').find((l) => l.includes('claude-console.js'));
  // CON-0.1.2: the exact code (call expands %errorlevel% at run time); purge.test.js runs it.
  assert.ok(/ & call exit \/b %%errorlevel%%$/.test(line), line);
});
