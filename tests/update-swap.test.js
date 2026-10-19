'use strict';
// CON-0.1.3 BUGFIX (L6 sandbox findings): update / rollback refresh the Apps & features
// version (read back), and stop the console that holds a folder before swapping it.
// The "console" here is a plain child node process whose working dir is the app folder
// (Windows then refuses the rename with EBUSY, as the real server did); the registry is
// a fake writer. Nothing touches the real install home, the registry or a real server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { tmpdir } = require('./helpers');

const manifest = require('../installer/manifest');
const upd = require('../installer/update');
const swap = require('../installer/swap');
const launcher = require('../installer/launcher');
const paths = require('../installer/paths');
const cli = require('../installer/cli');

const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const r = (p) => fs.readFileSync(p, 'utf8');

function makeRelease(root, version) {
  const dir = path.join(root, 'rel-' + version);
  w(path.join(dir, 'package.json'), JSON.stringify({ name: 'claude-console', version }) + '\n');
  w(path.join(dir, 'server', 'server.js'), '// server ' + version + '\n');
  manifest.writeManifest(dir, manifest.buildManifest(dir, { version }));
  return dir;
}

const okPre = { ok: true, problems: [], warnings: [], claude: 'C:\\fake\\claude.exe', edge: null };
const noDetect = { legacy: [], skipProbe: true };

// A fake registry: the Apps & features key as install left it.
function fakeArp(initial) {
  const reg = { present: true, DisplayVersion: initial };
  const calls = [];
  const writeArp = async (home, v) => { calls.push(v); if (reg.present) reg.DisplayVersion = v; return { present: reg.present, version: reg.present ? reg.DisplayVersion : null, ok: true }; };
  return { reg, calls, writeArp };
}

// A fake console process running from dir (its cwd), killed at the end.
const kids = [];
function fakeConsole(dir) {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, stdio: 'ignore', windowsHide: true });
  kids.push(c);
  return { pid: c.pid, dir, commandLine: '"' + process.execPath + '" "' + path.join(dir, 'server', 'server.js') + '"' };
}
test.after(() => { for (const c of kids) { try { c.kill(); } catch (e) { /* gone */ } } });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const fast = { delays: [10, 20, 40] };

// The world the CLI sees: consoles = the fake processes; serverInfo answers while one lives.
function world(root) {
  const home = path.join(root, 'home');
  const L = paths.layout(home);
  const arp = fakeArp(null);
  const lines = [];
  const consoles = [];
  const started = [];
  const state = { panes: [] };
  const deps = {
    out: (s) => lines.push(s), prereqs: okPre, detectOpts: noDetect, nodePath: process.execPath,
    npmCi: async () => {}, selftest: async () => ({ ok: true, detail: 'fake' }), makeShortcuts: async () => ['fake'],
    writeArp: arp.writeArp, retry: fast, stopTimeoutMs: 1000,
    listServers: async () => consoles.filter((c) => alive(c.pid)),
    serverInfo: async () => (consoles.some((c) => alive(c.pid)) ? { version: 'x', panes: state.panes } : null),
    postShutdown: async () => false,
    startServer: (L2, m) => { const app = m.path; started.push(m.version); consoles.push(fakeConsole(app)); return app; },
  };
  return { home, L, arp, lines, consoles, started, state, deps };
}

const win = { skip: process.platform !== 'win32' };

// ------------------------------------------------------------------ bug 1: Apps & features

test('ARP: the refresh script sets DisplayVersion + VersionMajor/Minor only on an existing key and reads it back', () => {
  const s = launcher.arpVersionScript('0.1.3');
  assert.match(s, /if \(-not \(Test-Path \$k\)\) \{ Write-Output 'ARP=absent'; exit 0 \}/, 'never creates the key');
  assert.match(s, /-Name DisplayVersion -Value '0\.1\.3'/);
  assert.match(s, /-Name VersionMajor -Value 0 -Type DWord/);
  assert.match(s, /-Name VersionMinor -Value 1 -Type DWord/);
  assert.match(s.trim().split('\n').pop(), /^Write-Output \('ARP=' \+ \(Get-ItemProperty -Path \$k -Name DisplayVersion\)\.DisplayVersion\)$/);
  assert.ok(!/[^\x09\x0a\x20-\x7e]/.test(s) && !s.includes('\r'), 'ASCII + LF');
  assert.deepStrictEqual(launcher.parseArpReadBack(['x', 'ARP=0.1.3']), { present: true, version: '0.1.3' });
  assert.deepStrictEqual(launcher.parseArpReadBack(['ARP=absent']), { present: false, version: null });
  assert.deepStrictEqual(launcher.parseArpReadBack([]), { present: null, version: null });
  const inst = launcher.shortcutScript('C:\\h\\launch.vbs', null, { home: 'C:\\h', version: '2.10.0' });
  assert.match(inst, /VersionMajor -Value 2 -Type DWord/);
  assert.match(inst, /VersionMinor -Value 10 -Type DWord/);
});

test('ARP: the refresh script parses with Windows PowerShell 5.1 (never run)', win, () => {
  const f = path.join(tmpdir('cc-arp-'), 'arp.ps1');
  fs.writeFileSync(f, launcher.arpVersionScript('0.1.3'));
  const ps = "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('" + f.replace(/'/g, "''") + "', [ref]$null, [ref]$e); $e.Count";
  assert.strictEqual(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, encoding: 'utf8' }).trim(), '0');
});

test('ARP: update and rollback write the version and the CLI prints the read-back', async () => {
  const root = tmpdir('cc-swap-');
  const W = world(root);
  W.deps.listServers = undefined; W.deps.serverInfo = undefined; // no console in this test
  const v1 = makeRelease(root, '1.0.0');
  assert.strictEqual(await cli.run(['install', '--home', W.home, '--source', v1], W.deps), 0);
  W.arp.reg.DisplayVersion = '1.0.0'; // what install's shortcut script wrote
  const v2 = makeRelease(root, '1.0.1');
  assert.strictEqual(await cli.run(['update', '--home', W.home, '--from', v2, '--yes'], W.deps), 0, W.lines.join('\n'));
  assert.strictEqual(W.arp.reg.DisplayVersion, '1.0.1');
  assert.ok(W.lines.includes('Apps & features: v1.0.1'), W.lines.join('\n'));
  assert.strictEqual(JSON.parse(r(path.join(W.L.reports, 'last-update.json'))).arp.version, '1.0.1', 'read-back kept in the report');
  assert.strictEqual(await cli.run(['rollback', '--home', W.home], W.deps), 0, W.lines.join('\n'));
  assert.strictEqual(W.arp.reg.DisplayVersion, '1.0.0');
  assert.deepStrictEqual(W.lines.slice(-2), ['rolled back v1.0.1 -> v1.0.0', 'Apps & features: v1.0.0']);
  assert.deepStrictEqual(W.arp.calls, ['1.0.1', '1.0.0']);
  // A read-back that disagrees is reported, not hidden.
  W.deps.writeArp = async () => ({ present: true, version: '1.0.0', ok: false });
  assert.strictEqual(await cli.run(['update', '--home', W.home, '--from', v2, '--yes', '--force'], W.deps), 0, W.lines.join('\n'));
  assert.ok(W.lines.includes('note: Apps & features still shows v1.0.0, not v1.0.1'), W.lines.join('\n'));
  // No entry (installed with --no-shortcuts): nothing printed, nothing created.
  W.deps.writeArp = async () => ({ present: false, version: null, ok: true });
  assert.strictEqual(await cli.run(['rollback', '--home', W.home], W.deps), 0);
  assert.ok(!W.lines[W.lines.length - 1].startsWith('Apps & features'));
});

test('ARP: a fake npmCi with no writeArp never reaches the real registry writer', async () => {
  const root = tmpdir('cc-swap-');
  const W = world(root);
  const real = launcher.writeArpWindows;
  let hit = 0;
  launcher.writeArpWindows = async () => { hit++; return { ok: true }; };
  try {
    delete W.deps.writeArp; W.deps.listServers = undefined; W.deps.serverInfo = undefined;
    assert.strictEqual(await cli.run(['install', '--home', W.home, '--source', makeRelease(root, '1.0.0')], W.deps), 0);
    assert.strictEqual(await cli.run(['update', '--home', W.home, '--from', makeRelease(root, '1.0.1'), '--yes'], W.deps), 0);
    assert.strictEqual(await cli.run(['rollback', '--home', W.home], W.deps), 0);
  } finally { launcher.writeArpWindows = real; }
  assert.strictEqual(hit, 0);
});

// ------------------------------------------------------------------ bug 2: EBUSY

test('swap: retrySwap retries only "in use" errors, bounded, then marks the error', async () => {
  let n = 0;
  const slept = [];
  const sleep = async (ms) => { slept.push(ms); };
  assert.strictEqual(await swap.retrySwap(() => { if (++n < 3) { const e = new Error('busy'); e.code = 'EBUSY'; throw e; } return 'ok'; }, { sleep }), 'ok');
  assert.deepStrictEqual(slept, [250, 500]);
  slept.length = 0;
  await assert.rejects(swap.retrySwap(() => { const e = new Error('perm'); e.code = 'EPERM'; throw e; }, { sleep }), (e) => e.swapFailed === true && e.tries === 6);
  assert.deepStrictEqual(slept, swap.DELAYS);
  await assert.rejects(swap.retrySwap(() => { throw new Error('other'); }, { sleep }), (e) => !e.swapFailed && e.message === 'other');
});

test('swap: serversIn matches only a console running from the folder to swap', () => {
  const listed = [{ pid: 1, commandLine: '"C:\\n\\node.exe" "C:\\H\\app\\1.0.1\\server\\server.js"' }, { pid: 2, commandLine: 'node C:/H/app/1.0.0/server/server.js' }];
  assert.deepStrictEqual(swap.serversIn(listed, ['C:\\H\\app\\1.0.1']).map((x) => x.pid), [1]);
  assert.deepStrictEqual(swap.serversIn(listed, ['c:\\h\\app\\1.0.0\\']).map((x) => x.pid), [2]);
  assert.deepStrictEqual(swap.serversIn(listed, ['C:\\H\\app\\1.0']).map((x) => x.pid), [], 'no prefix match on a sibling version');
  assert.deepStrictEqual(swap.serversIn(listed, []).map((x) => x.pid), [1, 2]);
});

test('EBUSY repro: a console running from app/<new> blocks the update with one line when nothing stops it', win, async () => {
  const root = tmpdir('cc-swap-');
  const W = world(root);
  assert.strictEqual(await cli.run(['install', '--home', W.home, '--source', makeRelease(root, '1.0.0')], W.deps), 0);
  const v2 = makeRelease(root, '1.0.1');
  assert.strictEqual(await cli.run(['update', '--home', W.home, '--from', v2, '--yes'], W.deps), 0);
  assert.strictEqual(upd.rollback(W.home, process.execPath).to, '1.0.0', 'the pre-fix rollback: marker only');
  W.consoles.push(fakeConsole(W.L.app('1.0.1'))); // still running the version rolled away from
  const rep = await upd.applyUpdate({ home: W.home, releaseDir: v2, npmCi: W.deps.npmCi, selftest: W.deps.selftest, writeArp: W.arp.writeArp, retry: fast });
  assert.strictEqual(rep.status, 'blocked');
  assert.match(rep.line, /^update blocked: 1\.0\.1 is still in use \((EBUSY|EPERM) after 4 tries\); close what holds it \(claude-console stop --force\), then run claude-console update again$/);
  assert.strictEqual(JSON.parse(r(W.L.marker)).version, '1.0.0', 'marker unchanged');
  assert.ok(fs.existsSync(path.join(W.L.app('1.0.1'), 'server', 'server.js')), 'the in-use folder is untouched');
});

test('rollback then update: rollback stops and restarts the console, the update after it goes through', win, async () => {
  const root = tmpdir('cc-swap-');
  const W = world(root);
  assert.strictEqual(await cli.run(['install', '--home', W.home, '--source', makeRelease(root, '1.0.0')], W.deps), 0);
  const v2 = makeRelease(root, '1.0.1');
  assert.strictEqual(await cli.run(['update', '--home', W.home, '--from', v2, '--yes'], W.deps), 0, W.lines.join('\n'));
  const running = fakeConsole(W.L.app('1.0.1'));
  W.consoles.push(running);
  assert.strictEqual(await cli.run(['rollback', '--home', W.home], W.deps), 0, W.lines.join('\n'));
  assert.ok(!alive(running.pid), 'the console was stopped and its process waited for');
  assert.deepStrictEqual(W.started, ['1.0.0'], 'started again on the previous version');
  assert.deepStrictEqual(W.lines.slice(-3), ['rolled back v1.0.1 -> v1.0.0', 'Apps & features: v1.0.0', 'restarted the console on v1.0.0']);
  // The update right after: app/1.0.1 is free now.
  assert.strictEqual(await cli.run(['update', '--home', W.home, '--from', v2, '--yes'], W.deps), 0, W.lines.join('\n'));
  assert.ok(W.lines.includes('update: updated v1.0.0 -> v1.0.1'), W.lines.join('\n'));
  assert.strictEqual(W.arp.reg.DisplayVersion, '1.0.1');
});

test('update with the console in app/<new>: stopped first, swap done, restarted on the new version', win, async () => {
  const root = tmpdir('cc-swap-');
  const W = world(root);
  assert.strictEqual(await cli.run(['install', '--home', W.home, '--source', makeRelease(root, '1.0.0')], W.deps), 0);
  const v2 = makeRelease(root, '1.0.1');
  assert.strictEqual(await cli.run(['update', '--home', W.home, '--from', v2, '--yes'], W.deps), 0);
  upd.rollback(W.home, process.execPath); // the pre-fix rollback left it running from 1.0.1
  const running = fakeConsole(W.L.app('1.0.1'));
  W.consoles.push(running);
  assert.strictEqual(await cli.run(['update', '--home', W.home, '--from', v2, '--yes'], W.deps), 0, W.lines.join('\n'));
  assert.ok(!alive(running.pid));
  assert.ok(W.lines.includes('update: updated v1.0.0 -> v1.0.1'), W.lines.join('\n'));
  assert.strictEqual(W.lines[W.lines.length - 1], 'restarted the console on v1.0.1');
  assert.deepStrictEqual(W.started, ['1.0.1']);
  assert.ok(fs.readdirSync(W.L.backups).some((n) => /^failed-stale-1\.0\.1-/.test(n)), 'the old folder moved aside');
});

test('busy panes: the console is never killed for a swap; one clear line, exit 1', win, async () => {
  const root = tmpdir('cc-swap-');
  const W = world(root);
  assert.strictEqual(await cli.run(['install', '--home', W.home, '--source', makeRelease(root, '1.0.0')], W.deps), 0);
  const v2 = makeRelease(root, '1.0.1');
  assert.strictEqual(await cli.run(['update', '--home', W.home, '--from', v2, '--yes'], W.deps), 0);
  const running = fakeConsole(W.L.app('1.0.1'));
  W.consoles.push(running);
  W.state.panes = [{ state: 'busy' }, { state: 'idle' }];
  assert.strictEqual(await cli.run(['rollback', '--home', W.home], W.deps), 1);
  assert.strictEqual(W.lines[W.lines.length - 1], 'rollback blocked: the console is running from v1.0.1 with 1 busy pane(s); finish them, run claude-console stop, then run this again');
  assert.ok(alive(running.pid));
  assert.strictEqual(JSON.parse(r(W.L.marker)).version, '1.0.1', 'nothing switched');
  upd.rollback(W.home, process.execPath);
  assert.strictEqual(await cli.run(['update', '--home', W.home, '--from', v2, '--yes'], W.deps), 1);
  assert.match(W.lines[W.lines.length - 1], /^update blocked: the console is running from v1\.0\.1 with 1 busy pane\(s\)/);
  assert.ok(alive(running.pid));
  assert.deepStrictEqual(W.started, []);
});

test('refreshArpForInstall: only an installed app whose marker names this version rewrites the entry (0.1.2 -> 0.1.3 via an old CLI)', async () => {
  const home = tmpdir('cc-arpfix-');
  const app = path.join(home, 'app', '0.1.3');
  fs.mkdirSync(app, { recursive: true });
  const calls = [];
  const write = async (h, v) => { calls.push([h, v]); return { present: true, version: v, ok: true }; };
  assert.deepStrictEqual(await launcher.refreshArpForInstall(app, '0.1.3', write), { skipped: 'no install marker' });
  fs.writeFileSync(path.join(home, 'install.json'), JSON.stringify({ version: '0.1.2', path: path.join(home, 'app', '0.1.2') }));
  assert.deepStrictEqual(await launcher.refreshArpForInstall(app, '0.1.3', write), { skipped: 'the marker names another version' });
  fs.writeFileSync(path.join(home, 'install.json'), JSON.stringify({ version: '0.1.3', path: app }));
  const r = await launcher.refreshArpForInstall(app, '0.1.3', write);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls, [[home, '0.1.3']]);
  assert.deepStrictEqual(await launcher.refreshArpForInstall(path.join(__dirname, '..'), '0.1.3', write), { skipped: 'not an install' }, 'a checkout never touches the registry');
  assert.strictEqual(calls.length, 1);
});
