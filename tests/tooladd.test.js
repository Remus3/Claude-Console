'use strict';
// CON-TOOL-ADD: +Tool and files dropped on the Projects list. .lnk resolution (a real
// shortcut made in a temp dir), launch building for every file kind, and the add /
// drop routes (token, Origin, validation, data/tools.local.json only).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('../server/tools');
const { createConsoleServer } = require('../server/server');
const { makeFixture, writeFile } = require('./helpers');

// Make a real .lnk with the shell's own writer (paths go over in env vars).
function makeLnk(lnk, target, args, cwd) {
  const ps = '$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:L);$s.TargetPath=$env:T;$s.Arguments=$env:A;$s.WorkingDirectory=$env:W;$s.Save()';
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: Object.assign({}, process.env, { L: lnk, T: target, A: args, W: cwd }), windowsHide: true });
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('splitArgs follows the Windows command-line rules', () => {
  assert.deepStrictEqual(T.splitArgs('-ExecutionPolicy Bypass -NoExit -File "X:\\a b\\start.ps1"'), ['-ExecutionPolicy', 'Bypass', '-NoExit', '-File', 'X:\\a b\\start.ps1']);
  assert.deepStrictEqual(T.splitArgs('  a\\\\"b c" "" d\\e "x""y" '), ['a\\b c', '', 'd\\e', 'x"y']);
  assert.deepStrictEqual(T.splitArgs('a\\"b'), ['a"b']);
  assert.deepStrictEqual(T.splitArgs(''), []);
});

test('hostFor: scripts start through their host, programs as they are', () => {
  const c = T.hostFor('X:/a b/run.cmd', ['q r', 's']);
  assert.match(c.file, /cmd\.exe$/i);
  assert.deepStrictEqual(c.args, ['/d', '/s', '/c', '""X:\\a b\\run.cmd" "q r" s"']);
  assert.strictEqual(c.verbatim, true);
  const p = T.hostFor('X:/s.ps1', ['-x']);
  assert.match(p.file, /powershell\.exe$/i);
  assert.deepStrictEqual(p.args, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'X:\\s.ps1', '-x']);
  assert.match(T.hostFor('X:/v.vbs', []).file, /wscript\.exe$/i);
  assert.deepStrictEqual(T.hostFor('X:/a.exe', ['1']), { file: 'X:/a.exe', args: ['1'] });
});

test('launchTool runs a .cmd through cmd.exe (verbatim command line)', async () => {
  const dir = tmp('cc-test-cmd-');
  try {
    const f = path.join(dir, 'go.cmd');
    fs.writeFileSync(f, '@echo off');
    const calls = [];
    const r = await T.launchTool({ launch: { file: f, args: ['a b'], cwd: null } }, { spawn: (file, args, o) => { calls.push({ file, args, o }); return { unref() {}, on() {} }; } });
    assert.strictEqual(r.ok, true);
    assert.match(calls[0].file, /cmd\.exe$/i);
    assert.strictEqual(calls[0].o.windowsVerbatimArguments, true);
    // cmd.exe is a console program: the batch gets its own window via start.
    assert.strictEqual(calls[0].args[3], '"start "" "' + f + '" "a b""');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('isConsoleExe reads the PE subsystem: powershell/cmd console, explorer GUI, text not', () => {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  assert.strictEqual(T.isConsoleExe(path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')), true);
  assert.strictEqual(T.isConsoleExe(path.join(sys, 'System32', 'cmd.exe')), true);
  assert.strictEqual(T.isConsoleExe(path.join(sys, 'explorer.exe')), false);
  assert.strictEqual(T.isConsoleExe(__filename), false);
  assert.strictEqual(T.isConsoleExe(path.join(sys, 'no-such-file.exe')), false);
});

test('launchTool: a console program (a Start script: powershell -NoExit -File) gets its own window via cmd start', async () => {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const ps = path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const calls = [];
  const fake = (file, args, o) => { calls.push({ file, args, o }); return { pid: 7, unref() {}, on() {} }; };
  const r = await T.launchTool({ launch: { file: ps, args: ['-ExecutionPolicy', 'Bypass', '-NoExit', '-File', 'X:\\a b\\start.ps1'], cwd: sys } }, { spawn: fake });
  assert.strictEqual(r.ok, true);
  assert.match(calls[0].file, /cmd\.exe$/i);
  assert.strictEqual(calls[0].o.windowsVerbatimArguments, true);
  assert.strictEqual(calls[0].o.cwd, sys);
  assert.deepStrictEqual(calls[0].args, ['/d', '/s', '/c', '"start "" "' + ps + '" -ExecutionPolicy Bypass -NoExit -File "X:\\a b\\start.ps1""']);
  // A GUI program still starts as it is.
  calls.length = 0;
  const ex = path.join(sys, 'explorer.exe');
  await T.launchTool({ launch: { file: ex, args: ['x'], cwd: null } }, { spawn: fake });
  assert.strictEqual(calls[0].file, ex);
  assert.deepStrictEqual(calls[0].args, ['x']);
});

test('resolveShortcut + buildLaunch: a .lnk becomes its target, arguments and folder; any other file opens', { timeout: 60000 }, async () => {
  const dir = tmp('cc-test-lnk-');
  try {
    const work = path.join(dir, 'work dir');
    fs.mkdirSync(work);
    const lnk = path.join(dir, 'My Start.lnk');
    makeLnk(lnk, process.execPath, '-e "1" --flag', work);
    const r = await T.resolveShortcut(lnk);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.target.toLowerCase(), process.execPath.toLowerCase());
    assert.strictEqual(r.args, '-e "1" --flag');
    assert.strictEqual(r.cwd, work);
    const b = await T.buildLaunch({ path: lnk });
    assert.strictEqual(b.ok, true);
    assert.strictEqual(b.kind, 'run');
    assert.deepStrictEqual(b.launch.args, ['-e', '1', '--flag']);
    assert.strictEqual(b.launch.cwd, work);
    assert.strictEqual(b.source, 'My Start.lnk');
    assert.strictEqual(T.labelFromPath(lnk), 'My Start');
    assert.strictEqual(T.labelFromPath(work, true), 'work dir');
    // a .lnk whose target is gone is refused with the reason
    const gone = path.join(dir, 'Gone.lnk');
    makeLnk(gone, path.join(dir, 'missing.exe'), '', '');
    assert.match((await T.buildLaunch({ path: gone })).error, /missing/);
    // non-executable files of any type, folders and URLs open with the default handler
    for (const n of ['notes.txt', 'pic.png', 'site.url', 'noext']) {
      fs.writeFileSync(path.join(dir, n), 'x');
      const o = await T.buildLaunch({ path: path.join(dir, n) });
      assert.deepStrictEqual(o.launch, { open: path.join(dir, n) }, n);
      assert.strictEqual(o.kind, 'open');
    }
    assert.deepStrictEqual((await T.buildLaunch({ path: work })).launch, { open: work });
    assert.strictEqual((await T.buildLaunch({ path: work })).isDir, true);
    assert.deepStrictEqual((await T.buildLaunch({ path: 'https://example.com/x' })).launch, { open: 'https://example.com/x' });
    // a script runs (launch.file); args / folder only for programs
    fs.writeFileSync(path.join(dir, 'go.cmd'), '@echo off');
    const s = await T.buildLaunch({ path: path.join(dir, 'go.cmd'), args: 'a "b c"', cwd: work });
    assert.deepStrictEqual(s.launch, { file: path.join(dir, 'go.cmd'), args: ['a', 'b c'], cwd: work });
    assert.match((await T.buildLaunch({ path: path.join(dir, 'notes.txt'), args: '-x' })).error, /only to a program/);
    assert.match((await T.buildLaunch({ path: 'rel\\x.exe' })).error, /absolute/);
    assert.match((await T.buildLaunch({ path: path.join(dir, 'nope.exe') })).error, /Not found/);
    assert.match((await T.buildLaunch({ path: path.join(dir, 'go.cmd'), cwd: path.join(dir, 'notes.txt') })).error, /folder/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateToolPath: "must be a file" applies to a program only; an open tool takes any file type or a folder', () => {
  const dir = tmp('cc-test-vp-');
  try {
    const png = path.join(dir, 'a.png');
    fs.writeFileSync(png, 'x');
    const open = { launch: { open: 'X:/y.html' } };
    const run = { launch: { file: 'X:/y.exe' } };
    assert.strictEqual(T.validateToolPath(open, png).ok, true);
    assert.strictEqual(T.validateToolPath(open, dir).ok, true);
    assert.strictEqual(T.validateToolPath(run, png).ok, true);
    assert.strictEqual(T.validateToolPath(run, dir).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('findOnDesktop: exact name, case-insensitive; refuses path-like names', () => {
  const d = tmp('cc-test-desk-');
  try {
    fs.writeFileSync(path.join(d, 'App Start.lnk'), 'x');
    assert.strictEqual(T.findOnDesktop('app start.LNK', [d]), path.join(d, 'App Start.lnk'));
    assert.strictEqual(T.findOnDesktop('other.lnk', [d]), null);
    assert.strictEqual(T.findOnDesktop('..\\App Start.lnk', [d]), null);
  } finally {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('tools API: POST /api/tools and /api/tools/drop add entries to data/tools.local.json only', { timeout: 90000 }, async (t) => {
  const fx = makeFixture();
  const file = path.join(fx.root, 'tools.json');
  writeFile(file, JSON.stringify({ tools: [{ id: 'alpha-gui', project: 'AL', label: 'Alpha gui', launch: { file: process.execPath } }] }));
  const before = fs.readFileSync(file, 'utf8');
  const desk = path.join(fx.root, 'Desktop');
  const elsewhere = path.join(fx.root, 'elsewhere');
  fs.mkdirSync(desk, { recursive: true });
  fs.mkdirSync(elsewhere, { recursive: true });
  writeFile(path.join(desk, 'Shot.png'), 'png');
  fs.mkdirSync(path.join(desk, 'Reports'));
  const lnk = path.join(elsewhere, 'Proj - Start.lnk');
  makeLnk(lnk, process.execPath, '--version', elsewhere);
  writeFile(path.join(fx.dataDir, 'settings.json'), JSON.stringify({ sidebarGroups: [{ id: 'g-1', name: 'G', open: false, items: [] }] }));
  const calls = [];
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: fx.overrides, toolsFile: file, desktopDirs: [desk], toolSpawn: (f, a) => { calls.push(a); return { unref() {}, on() {} }; } });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const H = { 'X-Console-Token': srv.token, 'Content-Type': 'application/json' };
  const post = (p, body, h) => fetch(base + p, { method: 'POST', headers: h || H, body: JSON.stringify(body) });
  const localFile = path.join(fx.dataDir, 'tools.local.json');
  const local = () => JSON.parse(fs.readFileSync(localFile, 'utf8'));
  // guards: token, Origin, target, validation (nothing written)
  assert.strictEqual((await post('/api/tools', { label: 'X', path: process.execPath, project: 'alpha' }, { 'Content-Type': 'application/json' })).status, 401);
  assert.strictEqual((await post('/api/tools/drop', { project: 'alpha', items: [{ name: 'Shot.png' }] }, { 'Content-Type': 'application/json' })).status, 401);
  assert.strictEqual((await post('/api/tools', { label: 'X', path: process.execPath, project: 'alpha' }, Object.assign({ Origin: 'http://evil.example' }, H))).status, 403);
  assert.strictEqual((await post('/api/tools', { label: 'X', path: process.execPath, project: 'nope' })).status, 404);
  assert.strictEqual((await post('/api/tools', { label: 'X', path: process.execPath })).status, 400);
  assert.strictEqual((await post('/api/tools', { label: '', path: process.execPath, project: 'alpha' })).status, 400);
  let r = await post('/api/tools', { label: 'X', path: 'rel\\x.exe', project: 'alpha' });
  assert.strictEqual(r.status, 400);
  assert.match((await r.json()).error, /absolute/);
  r = await post('/api/tools', { label: 'X', path: path.join(fx.root, 'missing.exe'), project: 'alpha' });
  assert.match((await r.json()).error, /Not found/);
  assert.ok(!fs.existsSync(localFile), 'refused calls write nothing');
  // +Tool: a program with args and folder
  r = await post('/api/tools', { label: 'Node ver', path: process.execPath, args: '--version', cwd: elsewhere, project: 'alpha' });
  assert.strictEqual(r.status, 200);
  let j = await r.json();
  assert.deepStrictEqual(j.added, ['node-ver']);
  assert.deepStrictEqual(j.tools.find((x) => x.id === 'node-ver'), { id: 'node-ver', label: 'Node ver', title: '', projectId: 'alpha', available: true, kind: 'run', path: process.execPath });
  assert.deepStrictEqual(local().tools[0], { id: 'node-ver', project: 'alpha', label: 'Node ver', title: '', launch: { file: process.execPath, args: ['--version'], cwd: elsewhere } });
  // +Tool with a .lnk path resolves it
  r = await post('/api/tools', { label: 'Via lnk', path: lnk, project: 'alpha' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(local().tools.find((x) => x.id === 'via-lnk').launch.args, ['--version']);
  // drop: .lnk bytes (not on a Desktop), a .png and a folder found on the Desktop,
  // an unknown name (unresolved, the dialog asks), a URL
  r = await post('/api/tools/drop', { project: 'alpha', items: [
    { name: 'Proj - Start.lnk', lnk: fs.readFileSync(lnk).toString('base64') },
    { name: 'Shot.png' },
    { name: 'Reports', dir: true },
    { name: 'Missing Thing.lnk' },
    { name: 'https://example.com/a', url: 'https://example.com/a' },
  ] });
  assert.strictEqual(r.status, 200);
  j = await r.json();
  assert.deepStrictEqual(j.added, ['proj-start', 'shot', 'reports', 'example-com']);
  assert.deepStrictEqual(j.unresolved, [{ name: 'Missing Thing.lnk', label: 'Missing Thing', error: 'Could not find "Missing Thing.lnk" on the Desktop. Type its full path.' }]);
  const L = local().tools;
  const ps = L.find((x) => x.id === 'proj-start');
  assert.strictEqual(ps.label, 'Proj - Start');
  assert.strictEqual(ps.title, 'Shortcut Proj - Start.lnk');
  assert.strictEqual(ps.launch.file.toLowerCase(), process.execPath.toLowerCase());
  assert.deepStrictEqual(ps.launch.args, ['--version']);
  assert.strictEqual(ps.launch.cwd, elsewhere);
  assert.deepStrictEqual(L.find((x) => x.id === 'shot').launch, { open: path.join(desk, 'Shot.png') });
  assert.deepStrictEqual(L.find((x) => x.id === 'reports').launch, { open: path.join(desk, 'Reports') });
  assert.deepStrictEqual(L.find((x) => x.id === 'example-com').launch, { open: 'https://example.com/a' });
  // drop on a group: no project, listed in the group (opened), marked loose
  r = await post('/api/tools/drop', { group: 'g-1', items: [{ name: 'Shot.png' }] });
  j = await r.json();
  assert.deepStrictEqual(j.added, ['shot-2']);
  assert.deepStrictEqual(j.settings.sidebarGroups[0].items, ['t:shot-2']);
  assert.strictEqual(j.settings.sidebarGroups[0].open, true);
  assert.strictEqual(j.tools.find((x) => x.id === 'shot-2').loose, true);
  assert.strictEqual((await post('/api/tools/drop', { group: 'g-nope', items: [{ name: 'Shot.png' }] })).status, 404);
  // launch an added tool; remove takes it out of tools.local.json
  assert.strictEqual((await fetch(base + '/api/tools/proj-start/launch', { method: 'POST', headers: H })).status, 200);
  // node.exe is a console program: its own window through cmd start (CON-TOOL-CONSOLE).
  assert.deepStrictEqual(calls, [['/d', '/s', '/c', '"start "" "' + process.execPath + '" --version"']]);
  assert.strictEqual((await fetch(base + '/api/tools/shot', { method: 'DELETE', headers: H })).status, 200);
  assert.ok(!local().tools.some((x) => x.id === 'shot'));
  assert.ok(!(local().overrides || {}).shot, 'an added tool is deleted, not hidden');
  assert.ok(fs.existsSync(path.join(desk, 'Shot.png')), 'files on disk are never touched');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before, 'the tools file is never written');
});
