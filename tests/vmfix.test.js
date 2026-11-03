'use strict';
// VMFIX (clean-box sandbox findings, 2026-10-18): a stranger's first install on a box
// with no Node, no git and no claude. Everything here runs in scratch dirs with fakes:
// no registry write, no shortcut, no network, no installer ever runs on this host.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const EventEmitter = require('events');
const { tmpdir } = require('./helpers');

const manifest = require('../installer/manifest');
const release = require('../installer/release');
const install = require('../installer/install');
const prereq = require('../installer/prereq');
const launcher = require('../installer/launcher');
const paths = require('../installer/paths');
const cli = require('../installer/cli');
const upd = require('../installer/update');
const uninstall = require('../installer/uninstall');
const claudeenv = require('../server/claudeenv');
const discovery = require('../server/discovery');
const { PaneManager } = require('../server/panes');

const ROOT = path.join(__dirname, '..');
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const r = (p) => fs.readFileSync(p, 'utf8');

function makeRelease(root, version, files) {
  const dir = path.join(root, 'rel-' + version);
  w(path.join(dir, 'package.json'), JSON.stringify({ name: 'claude-console', version }) + '\n');
  w(path.join(dir, 'server', 'server.js'), '// server ' + version + '\n');
  for (const [rel, text] of Object.entries(files || {})) w(path.join(dir, ...rel.split('/')), text);
  manifest.writeManifest(dir, manifest.buildManifest(dir, { version }));
  return dir;
}
const fakes = () => {
  const calls = { npm: [], shell: [], unshell: [], recycle: [] };
  return {
    calls,
    npmCi: async (dir) => { calls.npm.push(dir); fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true }); },
    selftest: async () => ({ ok: true, detail: 'fake' }),
    makeShortcuts: async (home, vbs, info) => { calls.shell.push([home, vbs, info]); return ['fake']; },
    removeShell: async (home) => { calls.unshell.push(home); return ['fake']; },
    recycle: async (p) => { calls.recycle.push(p); fs.rmSync(p, { recursive: true, force: true }); },
  };
};
const noDetect = { legacy: [], skipProbe: true };
const okPre = { ok: true, problems: [], warnings: [], claude: 'C:\\fake\\claude.exe', edge: null, git: true };

// ------------------------------------------------------------- prerequisites

test('prereq: no claude and no git still installs; each says exactly what happens', () => {
  const p = prereq.checkPrereqs({ env: { PATH: '', APPDATA: 'C:\\nope' }, nodeVersion: '24.1.0', gitCheck: () => false, edge: () => null });
  assert.strictEqual(p.ok, true, 'a missing claude CLI never refuses the install');
  assert.ok(p.warnings.includes(prereq.CLAUDE_MISSING), p.warnings.join(' | '));
  assert.strictEqual(prereq.CLAUDE_MISSING, 'Claude Code CLI not found - install it with: irm https://claude.ai/install.ps1 | iex');
  assert.ok(p.warnings.some((x) => x === prereq.GIT_MISSING && /^Git not found: /.test(x) && /git status/.test(x) && /winget install Git\.Git/.test(x)), p.warnings.join(' | '));
  assert.ok(!p.warnings.concat(p.problems).some((x) => /npm install -g/.test(x)), 'no npm -g suggestion');
  const old = prereq.checkPrereqs({ env: { PATH: '' }, nodeVersion: '20.0.0', gitCheck: () => true, edge: () => null });
  assert.strictEqual(old.ok, false);
  assert.match(old.problems[0], /Node 24 or newer/);
});

test('claude pane without claude: the plain message, the command, no config file', () => {
  const dataDir = path.join(tmpdir('cc-vm-'), 'data');
  const msg = claudeenv.claudeMissingMessage({ dataDir });
  assert.strictEqual(msg, 'Claude Code is not installed. In PowerShell run: irm https://claude.ai/install.ps1 | iex   Then click the project again.');
  assert.ok(!/claudePath|console\.local\.json/.test(msg), msg);
  const m = new PaneManager({ runDir: tmpdir('cc-vm-'), dataDir, accounts: { acct1: {} }, defaultAccount: 'acct1', shells: {}, idleSeconds: 1 }, {});
  // R1-1 re-resolves at open, so the real claude.exe of this box stays out of the search
  const saved = { PATH: process.env.PATH, APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { PATH: '', APPDATA: dataDir, USERPROFILE: dataDir });
  try {
    assert.throws(() => m.buildSpec({ kind: 'claude', cwd: dataDir }), (e) => e.message === msg);
  } finally { Object.assign(process.env, saved); }
});

// ------------------------------------------------------------- no git

test('discovery without git: a folder with .git is listed (no git status), not dropped', async () => {
  const root = tmpdir('cc-vm-');
  fs.mkdirSync(path.join(root, 'repo', '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'plain'), { recursive: true });
  const enoent = (f, a, o, cb) => { const e = new Error('spawn git ENOENT'); e.code = 'ENOENT'; cb(e, '', ''); };
  const saved = discovery._exec.fn;
  discovery._exec.fn = enoent;
  try {
    assert.strictEqual(await discovery.isRepoRoot(path.join(root, 'repo')), true);
    assert.strictEqual(await discovery.isRepoRoot(path.join(root, 'plain')), false);
    const list = await discovery.discoverProjects({ scanRoots: [root] });
    assert.deepStrictEqual(list.map((p) => p.name), ['repo']);
  } finally { discovery._exec.fn = saved; }
});

test('self-test without git: git-dependent tests are skipped with a clear note', () => {
  const plan = upd.selftestPlan(ROOT, false);
  assert.deepStrictEqual(plan.files, []);
  assert.match(plan.note, /^git not found: skipped the git-dependent self-tests \(/);
  const withGit = upd.selftestPlan(ROOT, true);
  assert.ok(withGit.files.length >= 1 && !withGit.note);
});

test('self-test failure: names the failing tests and the error, full output in a report file', () => {
  const out = [
    'TAP version 13',
    '# Subtest: resolves claude',
    'ok 1 - resolves claude',
    '# Subtest: builds the pane env',
    'not ok 2 - builds the pane env',
    '  ---',
    '  error: \'spawnSync git ENOENT\'',
    '  code: \'ENOENT\'',
    '  ...',
    '# tests 2',
    '# fail 1',
  ].concat(Array.from({ length: 30 }, (_, i) => '# filler ' + i)).join('\n');
  const f = upd.summarizeTestFailure(out);
  assert.deepStrictEqual(f.failed, ['builds the pane env']);
  assert.match(f.error, /spawnSync git ENOENT/);
  const dir = tmpdir('cc-vm-');
  const file = upd.writeSelftestLog(dir, '1.0.0', out);
  assert.strictEqual(r(file), out, 'the full output, not 6 lines');
  const d = upd.selftestDetail(f, file);
  assert.ok(d.includes('builds the pane env') && d.includes('ENOENT') && d.includes(file), d);
});

// ------------------------------------------------------------- releases

test('release: zip has one top-level claude-console-<v>/ folder; SHA256SUMS, install.ps1, notes', () => {
  const root = tmpdir('cc-vm-');
  const src = makeRelease(root, '1.4.0', { 'release/install.ps1': '# installer\n', 'release/notes/1.4.0.md': '# 1.4.0\n' });
  fs.rmSync(path.join(src, 'MANIFEST.json'));
  const out = path.join(root, 'out');
  const b = release.buildRelease(src, out, {});
  assert.deepStrictEqual(fs.readdirSync(out).sort(), ['RELEASE-NOTES-1.4.0.md', 'SHA256SUMS.txt', 'claude-console-1.4.0.zip', 'install.ps1']);
  const sums = r(path.join(out, 'SHA256SUMS.txt'));
  assert.match(sums, new RegExp('^' + b.sha256 + '  claude-console-1\\.4\\.0\\.zip\\n', 'm'));
  assert.match(sums, /^[0-9a-f]{64} {2}install\.ps1\n/m);
  const x = path.join(root, 'x');
  const tar = require('../installer/backup').tarExe();
  fs.mkdirSync(x);
  assert.strictEqual(spawnSync(tar, ['-x', '-f', b.zip, '-C', x]).status, 0);
  assert.deepStrictEqual(fs.readdirSync(x), ['claude-console-1.4.0']);
  assert.ok(fs.existsSync(path.join(x, 'claude-console-1.4.0', 'MANIFEST.json')));
  const ex = release.extractRelease(b.zip, path.join(root, 'y'), '1.4.0');
  assert.strictEqual(ex.manifest.version, '1.4.0', 'extract finds the top-level folder');
  assert.strictEqual(release.parseShaFile(sums, 'claude-console-1.4.0.zip'), b.sha256);
  assert.strictEqual(release.parseShaFile(sums, 'nope.zip'), null);
  const sumsAsset = [{ name: 'claude-console-1.4.0.zip', browser_download_url: 'https://github.com/o/r/z' }, { name: 'SHA256SUMS.txt', browser_download_url: 'https://github.com/o/r/s' }];
  const pick = release.pickRelease([{ tag_name: 'v1.4.0', assets: sumsAsset }], 'stable', '1.0.0');
  assert.strictEqual(pick.latest.shaUrl, 'https://github.com/o/r/s');
});

// ------------------------------------------------------------- install / uninstall

test('install: default home is %LOCALAPPDATA%\\Programs\\claude-console', () => {
  assert.strictEqual(paths.defaultHome({ LOCALAPPDATA: 'C:\\L' }), path.join('C:\\L', 'Programs', 'claude-console'));
});

test('install: --repo sets updates.repo; shell integration gets the version; a re-run repairs', async () => {
  const root = tmpdir('cc-vm-');
  const home = path.join(root, 'home');
  const src = makeRelease(root, '1.0.0', { 'public/index.html': '<html></html>\n', 'package-lock.json': '{}\n' });
  const fk = fakes();
  const lines = [];
  const deps = { out: (s) => lines.push(s), prereqs: Object.assign({}, okPre, { claude: null, warnings: [prereq.CLAUDE_MISSING] }), npmCi: fk.npmCi, selftest: fk.selftest, makeShortcuts: fk.makeShortcuts, nodePath: 'C:\\node.exe', detectOpts: noDetect };
  assert.strictEqual(await cli.run(['install', '--home', home, '--source', src, '--repo', 'Remus3/claude-console'], deps), 0);
  assert.ok(lines.includes('install: installed v1.0.0'), lines.join('\n'));
  assert.ok(lines.includes(prereq.CLAUDE_MISSING), 'the one claude line');
  assert.ok(!lines.some((l) => /^(report|launcher|command): /.test(l)), 'R1-16: no paths on a good install');
  assert.ok(!lines.some((l) => /claude-console setup/.test(l)), 'R1-16: no setup report');
  const local = JSON.parse(r(path.join(home, 'data', 'console.local.json')));
  assert.strictEqual(local.updates.repo, 'Remus3/claude-console');
  assert.deepStrictEqual(fk.calls.shell[0][2], { version: '1.0.0', repo: 'Remus3/claude-console' });
  assert.ok(/& call exit \/b %%errorlevel%%\s*$/m.test(r(path.join(home, 'claude-console.cmd'))), 'the CLI .cmd exits on its own line, exit code kept');
  // Re-run, same version: repair - a deleted shipped file and node_modules come back.
  const app = paths.layout(home).app('1.0.0');
  fs.rmSync(path.join(app, 'public', 'index.html'));
  fs.rmSync(path.join(app, 'node_modules'), { recursive: true });
  lines.length = 0;
  assert.strictEqual(await cli.run(['install', '--home', home, '--source', src, '--repo', 'Remus3/claude-console'], deps), 0);
  assert.ok(lines.includes('install: repaired v1.0.0'), lines.join('\n'));
  assert.ok(fs.existsSync(path.join(app, 'public', 'index.html')) && fs.existsSync(path.join(app, 'node_modules')));
  assert.strictEqual(fk.calls.shell.length, 2, 'shortcuts / Apps & features / PATH rewritten');
});

test('install: a failed self-test prints the failing tests, the error and the report path', async () => {
  const root = tmpdir('cc-vm-');
  const home = path.join(root, 'home');
  const src = makeRelease(root, '1.0.0', {});
  const fk = fakes();
  const lines = [];
  const selftest = async () => ({ ok: false, detail: 'tests failed: builds the pane env | error: spawnSync git ENOENT', failed: ['builds the pane env'], error: 'spawnSync git ENOENT', log: path.join(root, 'selftest.log') });
  const deps = { out: (s) => lines.push(s), prereqs: okPre, npmCi: fk.npmCi, selftest, makeShortcuts: fk.makeShortcuts, nodePath: 'C:\\node.exe', detectOpts: noDetect };
  assert.strictEqual(await cli.run(['install', '--home', home, '--source', src], deps), 1);
  const t = lines.join('\n');
  assert.ok(/failing test: builds the pane env/.test(t) && /error: spawnSync git ENOENT/.test(t) && t.includes(path.join(root, 'selftest.log')), t);
  assert.ok(/report: .*install-.*\.json/.test(t), t);
});

test('uninstall: shortcuts, Apps & features, PATH and code go; user data stays unless --purge', async () => {
  const root = tmpdir('cc-vm-');
  const home = path.join(root, 'home');
  const src = makeRelease(root, '1.0.0', {});
  const fk = fakes();
  const lines = [];
  const later = [];
  const deleteLater = (files) => { later.push(...files); for (const f of files) fs.rmSync(f, { force: true }); };
  const deps = { out: (s) => lines.push(s), prereqs: okPre, npmCi: fk.npmCi, selftest: fk.selftest, makeShortcuts: fk.makeShortcuts, removeShell: fk.removeShell, recycle: fk.recycle, postShutdown: async () => false, deleteLater, nodePath: 'C:\\node.exe', detectOpts: noDetect };
  assert.strictEqual(await cli.run(['install', '--home', home, '--source', src], deps), 0);
  w(path.join(home, 'data', 'layout.json'), '{}');
  assert.strictEqual(await cli.run(['uninstall', '--home', home], deps), 0);
  assert.deepStrictEqual(later, [path.join(path.resolve(home), 'claude-console.cmd')], 'the running .cmd goes later, never under cmd.exe');
  assert.deepStrictEqual(fk.calls.unshell, [path.resolve(home)]);
  assert.ok(!fs.existsSync(path.join(home, 'app')) && !fs.existsSync(path.join(home, '.base')) && !fs.existsSync(path.join(home, 'install.json')));
  assert.ok(!fs.existsSync(path.join(home, 'claude-console.cmd')) && !fs.existsSync(path.join(home, 'launch.vbs')));
  assert.ok(fs.existsSync(path.join(home, 'data', 'layout.json')), 'user data kept');
  assert.ok(lines.some((l) => /kept your data: /.test(l) && /--purge/.test(l)), lines.join('\n'));
  assert.strictEqual(await cli.run(['uninstall', '--home', home, '--purge'], deps), 0);
  assert.ok(!fs.existsSync(home), 'purge removes the whole home');
  assert.ok(fk.calls.recycle.length >= 1, 'user data goes to the Recycle Bin');
});

test('uninstall: the shell-integration scripts (shortcuts, Apps & features, user PATH)', () => {
  const home = 'C:\\Users\\x\\AppData\\Local\\Programs\\claude-console';
  const s = launcher.shortcutScript(home + '\\launch.vbs', null, { home, version: '0.1.0', repo: 'Remus3/claude-console' });
  for (const k of ['DisplayName', 'DisplayVersion', 'UninstallString', 'InstallLocation', 'Publisher', 'NoModify', 'NoRepair', "'0.1.0'", 'claude-console.cmd', 'Uninstall\\ClaudeConsole']) assert.ok(s.includes(k), k);
  assert.ok(s.includes("OpenSubKey('Environment', $true)") && s.includes('ExpandString'), 'user PATH, kind kept');
  const u = launcher.unshellScript(home);
  for (const k of ['Claude Console.lnk', 'Uninstall\\ClaudeConsole', "OpenSubKey('Environment', $true)", 'ClaudeConsole-AutoUpdate']) assert.ok(u.includes(k), k);
  assert.strictEqual(launcher.pathWith('C:\\a;C:\\b', 'C:\\h'), 'C:\\a;C:\\b;C:\\h');
  assert.strictEqual(launcher.pathWith('C:\\a;C:\\h\\', 'C:\\h'), 'C:\\a;C:\\h\\');
  assert.strictEqual(launcher.pathWith('', 'C:\\h'), 'C:\\h');
  assert.strictEqual(launcher.pathWithout('C:\\a;c:\\H;C:\\b', 'C:\\h'), 'C:\\a;C:\\b');
});

// ------------------------------------------------------------- R1-14: uninstall guard

function installedHome(lock, targets) {
  const home = tmpdir('cc-guard-');
  const L = paths.layout(home);
  w(path.join(L.app('1.0.0'), 'server', 'server.js'), '//\n');
  w(L.marker, JSON.stringify({ version: '1.0.0', path: L.app('1.0.0') }));
  w(path.join(home, 'claude-console.cmd'), '@echo off\n');
  if (lock) w(path.join(L.data, 'profile', 'locks', lock.name), lock.text);
  if (targets) w(path.join(L.data, 'profile', 'targets.json'), JSON.stringify({ schema: 1, repos: targets }));
  return { home, L };
}
function guardDeps(extra) {
  const lines = [];
  const shell = [];
  return Object.assign({ lines, shell, out: (s) => lines.push(s), postShutdown: async () => false, isAlive: () => false, kill: () => true, sleep: async () => {}, listServers: async () => [],
    removeShell: async (h) => { shell.push(h); return []; }, deleteLater: () => {}, retryMs: 1 }, extra || {});
}
const USER_LOCK = { name: 'user.json', text: JSON.stringify({ schema: 1, items: ['hl-env-base-url'] }) };

test('uninstall: a profile in the user lock refuses, exit 1, the exact line, nothing touched', async () => {
  const { home, L } = installedHome(USER_LOCK);
  const d = guardDeps({ postShutdown: async () => { throw new Error('must not stop the console'); } });
  assert.strictEqual(await cli.run(['uninstall', '--home', home], d), 1);
  assert.deepStrictEqual(d.lines, ['Your setup profile is still applied. See what it would remove: claude-console profile uninstall --all. Add --apply --yes to remove it, then uninstall again. To leave it in place: claude-console uninstall --keep-profile']);
  assert.deepStrictEqual(d.shell, [], 'shell integration untouched');
  assert.ok(fs.existsSync(L.app('1.0.0')) && fs.existsSync(L.marker));
  assert.strictEqual(await cli.run(['uninstall', '--home', home, '--purge'], guardDeps()), 1, '--purge is refused too');
  assert.ok(fs.existsSync(L.data));
});

test('uninstall --keep-profile: gets past the refusal, removes the code, keeps the lock and says so', async () => {
  const { home, L } = installedHome(USER_LOCK);
  const d = guardDeps();
  assert.strictEqual(await cli.run(['uninstall', '--home', home, '--keep-profile'], d), 0, d.lines.join('\n'));
  assert.ok(!fs.existsSync(L.appRoot));
  assert.ok(fs.existsSync(path.join(L.data, 'profile', 'locks', 'user.json')));
  assert.ok(d.lines.some((l) => /^Your setup profile stays applied/.test(l)), d.lines.join('\n'));
});

test('uninstall: no profile, or one fully removed, goes ahead; the last line names what stays', async () => {
  for (const lock of [null, { name: 'user.json', text: JSON.stringify({ schema: 1, items: [] }) }]) {
    const { home, L } = installedHome(lock);
    const d = guardDeps();
    assert.strictEqual(await cli.run(['uninstall', '--home', home], d), 0, d.lines.join('\n'));
    assert.ok(!fs.existsSync(L.appRoot));
    assert.strictEqual(d.lines[d.lines.length - 1], 'Claude Code, Node.js and Git stay installed.');
    assert.match(d.lines[d.lines.length - 2], /statusLine entry/);
    assert.ok(!d.lines.some((l) => /stays applied/.test(l)));
  }
});

test('uninstall guard: repo locks from targets.json and other accounts name their way out; a vanished repo does not hold it', async () => {
  const repo = tmpdir('cc-guard-repo-');
  w(path.join(repo, '.claude', 'profile.lock.json'), JSON.stringify({ items: ['x'] }));
  const gone = path.join(repo, 'gone');
  const { home } = installedHome({ name: 'user-abc123.json', text: JSON.stringify({ items: ['y'], configDir: 'C:\\acct2' }) }, [repo, gone]);
  const d = guardDeps();
  assert.strictEqual(await cli.run(['uninstall', '--home', home], d), 1);
  assert.ok(d.lines.includes('Also applied to a project: claude-console profile uninstall --all --target repo:"' + repo + '"'), d.lines.join('\n'));
  assert.ok(d.lines.includes('Also applied for another account: C:\\acct2'), d.lines.join('\n'));
  assert.ok(!d.lines.some((l) => l.includes(gone)));
  const only = installedHome(null, [gone]);
  assert.strictEqual(uninstall.profileApplied(only.L.data).applied, false);
});

test('uninstall guard: the repo lock path is the engine\'s, and an unreadable lock fails closed', () => {
  assert.strictEqual(path.join('R', '.claude', 'profile.lock.json'), require('../installer/profile-plan').repoLockFile('R'));
  const { L } = installedHome({ name: 'user.json', text: '{broken' });
  const p = uninstall.profileApplied(L.data);
  assert.strictEqual(p.applied, true);
  assert.strictEqual(p.unreadable.length, 1);
});

test('uninstall: the Edge profile is removed when it can be, named in one line when it stays, never fatal', async () => {
  const root = tmpdir('cc-edge-');
  const dir = path.join(root, 'ClaudeConsole', 'edge-profile');
  w(path.join(dir, 'Default', 'x'), 'x');
  assert.strictEqual(uninstall.edgeProfileDir({ LOCALAPPDATA: root }), dir);
  assert.strictEqual(uninstall.edgeProfileDir({}), null);
  assert.strictEqual(uninstall.removeEdgeProfileDir(dir, () => { throw new Error('EBUSY'); }), dir, 'stays, no throw');
  assert.ok(fs.existsSync(dir));
  assert.strictEqual(uninstall.removeEdgeProfileDir(dir), null);
  assert.ok(!fs.existsSync(path.join(root, 'ClaudeConsole')), 'the emptied parent goes too');
  assert.strictEqual(uninstall.removeEdgeProfileDir(dir), null, 'absent: nothing to say');
  const kept = installedHome(null);
  const d = guardDeps({ removeEdgeProfile: () => 'C:\\held\\edge-profile' });
  assert.strictEqual(await cli.run(['uninstall', '--home', kept.home], d), 0, d.lines.join('\n'));
  assert.ok(d.lines.some((l) => l.includes('C:\\held\\edge-profile')), d.lines.join('\n'));
  assert.strictEqual(d.lines[d.lines.length - 1], 'Claude Code, Node.js and Git stay installed.');
});

test('Apps & features: a visible window that stays open, a quiet string with --keep-profile, both refreshed on update', () => {
  const home = 'C:\\Users\\x y\\claude-console';
  const cmd = home + '\\claude-console.cmd';
  const u = launcher.arpUninstallStrings(home);
  assert.strictEqual(u.uninstall, 'cmd.exe /c ""' + cmd + '" uninstall & pause"');
  assert.strictEqual(u.quiet, '"' + cmd + '" uninstall --keep-profile');
  for (const s of [launcher.shortcutScript(home + '\\launch.vbs', null, { home, version: '0.1.5' }), launcher.arpVersionScript('0.1.5', home)]) {
    assert.ok(s.includes("-Name UninstallString -Value '" + u.uninstall + "'"), s);
    assert.ok(s.includes("-Name QuietUninstallString -Value '" + u.quiet + "'"), s);
  }
  assert.ok(!launcher.arpVersionScript('0.1.5').includes('UninstallString'), 'no home: version values only');
});

// ------------------------------------------------------------- R1-12: start

function startHome() {
  const home = tmpdir('cc-start-');
  const L = paths.layout(home);
  w(path.join(L.app('1.0.0'), 'server', 'server.js'), '//\n');
  w(L.marker, JSON.stringify({ version: '1.0.0', path: L.app('1.0.0') }));
  return { home, L };
}
// A server child that "exits" as told, after writing its log line like server.js main().
function fakeChild(code, logFile, line) {
  return () => {
    const c = new EventEmitter();
    c.unref = () => {};
    setImmediate(() => {
      if (line) w(logFile, (fs.existsSync(logFile) ? r(logFile) : '') + '2026-11-02T00:00:00.000Z ' + line + '\n');
      if (code !== null) c.emit('exit', code, null);
    });
    return c;
  };
}

test('start: port taken: exit 1, the exact line, naming the port and the file; launch.vbs gets it', async () => {
  const { home, L } = startHome();
  const log = path.join(L.run, 'server.log');
  w(log, '2026-01-01T00:00:00.000Z start failed: an old failure, not this start\n');
  const lines = [];
  const code = await cli.run(['start', '--home', home], { out: (s) => lines.push(s), spawn: fakeChild(1, log, 'start failed: listen EADDRINUSE: address already in use 127.0.0.1:7811'), startWatchMs: 5000 });
  assert.strictEqual(code, 1);
  const want = 'Claude Console could not start: port 7811 is used by another program. Set a free "port" in ' + path.join(L.data, 'console.local.json') + ', then start again. Details: ' + log;
  assert.deepStrictEqual(lines, ['starting v1.0.0', want]);
  const b = fs.readFileSync(path.join(L.run, launcher.START_FAILED));
  assert.deepStrictEqual([b[0], b[1]], [0xff, 0xfe], 'a BOM for the vbs reader');
  assert.strictEqual(b.subarray(2).toString('utf16le'), want);
});

test('start: another failure gives its own reason; only this start\'s log lines count; no log gives the exit code', async () => {
  const a = startHome();
  const log = path.join(a.L.run, 'server.log');
  w(log, 'x start failed: old\n');
  const lines = [];
  assert.strictEqual(await cli.run(['start', '--home', a.home], { out: (s) => lines.push(s), spawn: fakeChild(1, log, 'start failed: bad config.'), startWatchMs: 5000 }), 1);
  assert.strictEqual(lines[1], 'Claude Console could not start: bad config. Details: ' + log);
  const c = startHome();
  const clog = path.join(c.L.run, 'server.log');
  w(clog, 'x start failed: old\n');
  lines.length = 0;
  assert.strictEqual(await cli.run(['start', '--home', c.home], { out: (s) => lines.push(s), spawn: fakeChild(3), startWatchMs: 5000 }), 1);
  assert.strictEqual(lines[1], 'Claude Console could not start: the server stopped with exit code 3. Details: ' + clog);
});

test('start: exit 0 (already running) and no exit within the watch are success; a stale failure file goes', async () => {
  const { home, L } = startHome();
  const fail = path.join(L.run, launcher.START_FAILED);
  w(fail, 'old');
  const lines = [];
  assert.strictEqual(await cli.run(['start', '--home', home], { out: (s) => lines.push(s), spawn: fakeChild(0), startWatchMs: 5000 }), 0);
  assert.deepStrictEqual(lines, ['starting v1.0.0']);
  assert.ok(!fs.existsSync(fail));
  const t0 = Date.now();
  assert.strictEqual(await cli.run(['start', '--home', home], { out: () => {}, spawn: fakeChild(null), startWatchMs: 50 }), 0);
  assert.ok(Date.now() - t0 < 4000, 'bounded by the watch');
  assert.ok(!fs.existsSync(fail));
});

test('start --json: one object either way', async () => {
  const { home, L } = startHome();
  const lines = [];
  assert.strictEqual(await cli.run(['start', '--home', home, '--json'], { out: (s) => lines.push(s), spawn: fakeChild(1), startWatchMs: 5000 }), 1);
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(JSON.parse(lines[0]).started, false);
  lines.length = 0;
  assert.strictEqual(await cli.run(['start', '--home', home, '--json'], { out: (s) => lines.push(s), spawn: fakeChild(null), startWatchMs: 20 }), 0);
  assert.deepStrictEqual(JSON.parse(lines[0]), { started: true, version: '1.0.0', app: L.app('1.0.0') });
});

test('start: a real detached, unref\'d child\'s nonzero exit is seen (a throwaway node -e, no server)', async () => {
  const { home } = startHome();
  const real = (exe, args, opts) => require('child_process').spawn(process.execPath, ['-e', 'process.exit(5)'], opts);
  const lines = [];
  assert.strictEqual(await cli.run(['start', '--home', home], { out: (s) => lines.push(s), spawn: real, startWatchMs: 10000 }), 1);
  assert.match(lines[1], /exit code 5/);
});

// ------------------------------------------------------------- R1-28, R1-16, R1-18

test('npm ci failure: the headline says the cause; npm\'s last 3 lines are in the report only', async () => {
  const root = tmpdir('cc-npm-');
  const reportDir = path.join(root, 'reports');
  const err = ['a', 'b', 'npm error code ECONNRESET', 'npm error network', 'npm error last'].join('\n');
  await assert.rejects(upd.defaultNpmCi(path.join(root, 'app', '1.0.0'), { run: async () => ({ code: 1, out: '', err }), reportDir }), (e) => {
    const m = /^Could not download the program's libraries\. Check your internet connection and run the command again\. Details: (.+)$/.exec(e.message);
    assert.ok(m, e.message);
    assert.ok(!/ECONNRESET/.test(e.message));
    assert.strictEqual(path.dirname(m[1]), reportDir);
    assert.strictEqual(r(m[1]), 'npm error code ECONNRESET\nnpm error network\nnpm error last\n');
    return true;
  });
  assert.strictEqual(await upd.defaultNpmCi(root, { run: async () => ({ code: 0, out: '', err: '' }) }), true);
});

test('install: --verbose shows the paths; --ignore-prereqs leaves the Claude line to install.ps1', async () => {
  const root = tmpdir('cc-vm-');
  const home = path.join(root, 'home');
  const fk = fakes();
  const lines = [];
  const deps = { out: (s) => lines.push(s), prereqs: Object.assign({}, okPre, { claude: null, warnings: [prereq.CLAUDE_MISSING] }), npmCi: fk.npmCi, selftest: fk.selftest, makeShortcuts: fk.makeShortcuts, nodePath: 'C:\\node.exe', detectOpts: noDetect };
  assert.strictEqual(await cli.run(['install', '--home', home, '--source', makeRelease(root, '1.0.0', {}), '--verbose', '--ignore-prereqs'], deps), 0);
  assert.ok(lines.includes('command: ' + path.join(home, 'claude-console.cmd')), lines.join('\n'));
  assert.ok(lines.some((l) => /^report: /.test(l)) && lines.some((l) => /^launcher: /.test(l)), lines.join('\n'));
  assert.ok(!lines.includes(prereq.CLAUDE_MISSING), lines.join('\n'));
});

test('install.ps1: plain words, the literals phase A reads, the done line last, a refused prompt named', () => {
  const s = r(PS1);
  for (const k of ["'Downloading Claude Console.'", "'Installing Git. Windows may ask for permission.'", 'Installing Node.js (the console needs it).', 'SHA-256 ok: ',
    "Say 'Claude Code CLI not found - install it with: irm https://claude.ai/install.ps1 | iex'", 'You said no to the Windows permission prompt, so ', "'Node.js'", "'Git'",
    'Run the same command again when that is fixed; it picks up where it stopped.']) assert.ok(s.includes(k), k);
  for (const k of ["Say 'winget install", "Say ('nodejs.org MSI", "Say ('download", "Say ('command:", 'started: the console', "Say ('install to"]) assert.ok(!s.includes(k), k);
  const hint = s.indexOf("Say 'Claude Code CLI not found");
  const done = s.indexOf("Say 'Done. Claude Console is opening in its own window. Next time, start it from the Start menu or the Desktop. You can close this window.'");
  assert.ok(hint > 0 && done > hint, 'the hint, then the done line');
});

// ------------------------------------------------------------- CLI text

test('CLI text: help leads with the everyday commands; unknown command points at help; prereq Git line', async () => {
  const lines = [];
  await cli.run(['help'], { out: (s) => lines.push(s) });
  assert.strictEqual(lines[0], 'Claude Console. Everyday: start --open, stop, status, update --yes. Everything below is for troubleshooting.');
  lines.length = 0;
  assert.strictEqual(await cli.run(['nope'], { out: (s) => lines.push(s) }), 2);
  assert.deepStrictEqual(lines, ['unknown command: nope. See: claude-console help']);
  assert.ok(!r(path.join(ROOT, 'installer', 'cli.js')).includes('waits for the operator'));
  assert.strictEqual(prereq.GIT_MISSING, 'Git not found: installing anyway. Projects show without git status, and an update keeps a file changed on both sides aside instead of merging it. To fix: winget install Git.Git, then run the install command again.');
});


test('CLI: help shows the reinstall confirm phrase and uninstall; update --yes restarts or hints', async () => {
  const lines = [];
  await cli.run(['help'], { out: (s) => lines.push(s) });
  const t = lines.join('\n');
  assert.ok(/reinstall --mode repair\|fresh\|factory --confirm "reinstall <N>"/.test(t), t);
  assert.ok(/uninstall +\[--purge\]/.test(t), t);
  const root = tmpdir('cc-vm-');
  const home = path.join(root, 'home');
  const fk = fakes();
  const restarted = [];
  const base = { out: (s) => lines.push(s), prereqs: okPre, npmCi: fk.npmCi, selftest: fk.selftest, makeShortcuts: fk.makeShortcuts, nodePath: 'C:\\node.exe', detectOpts: noDetect };
  await cli.run(['install', '--home', home, '--source', makeRelease(root, '1.0.0', {})], base);
  lines.length = 0;
  const idle = Object.assign({}, base, { serverInfo: async () => ({ version: '1.0.0', panes: [{ state: 'idle' }] }), restart: async (L, m) => { restarted.push(m.version); } });
  assert.strictEqual(await cli.run(['update', '--home', home, '--from', makeRelease(root, '1.0.1', {}), '--yes'], idle), 0);
  assert.deepStrictEqual(restarted, ['1.0.1']);
  assert.ok(lines.includes('restarted the console on v1.0.1'), lines.join('\n'));
  lines.length = 0;
  const busy = Object.assign({}, idle, { serverInfo: async () => ({ version: '1.0.1', panes: [{ state: 'busy' }] }) });
  assert.strictEqual(await cli.run(['update', '--home', home, '--from', makeRelease(root, '1.0.2', {}), '--yes'], busy), 0);
  assert.deepStrictEqual(restarted, ['1.0.1'], 'never restarts over a busy pane');
  assert.ok(lines.some((l) => /^restart to use v1\.0\.2: claude-console stop, then claude-console start/.test(l)), lines.join('\n'));
});

// ------------------------------------------------------------- launchers and install.ps1

test('launch.cmd / launch.vbs resolve node from PATH, fall back to the install location, no hard-coded path', () => {
  const cmd = r(path.join(ROOT, 'launch.cmd'));
  const vbs = r(path.join(ROOT, 'launch.vbs'));
  for (const t of [cmd, vbs]) assert.ok(!/C:\\Program Files\\nodejs/i.test(t), 'no hard-coded node path');
  assert.match(cmd, /where node\.exe/);
  assert.match(cmd, /%ProgramFiles%\\nodejs\\node\.exe/);
  assert.match(vbs, /ExpandEnvironmentStrings\("%PATH%"\)/);
  assert.match(vbs, /%ProgramFiles%\\nodejs\\node\.exe/);
  for (const t of [cmd, vbs]) assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(t) && !t.includes('\r'), 'ASCII, LF');
});

const PS1 = path.join(ROOT, 'release', 'install.ps1');

test('install.ps1: the one-command install, read statically (never run on this host)', () => {
  const s = r(PS1);
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(s) && !s.includes('\r'), 'ASCII, LF');
  for (const k of [
    "OpenJS.NodeJS.LTS", 'https://nodejs.org/dist/index.json', 'SHASUMS256.txt', 'msiexec.exe',
    "Git.Git", 'git-for-windows/git/releases/latest', '/VERYSILENT',
    'releases/latest/download/SHA256SUMS.txt', 'Get-FileHash', "'Remus3/Claude-Console'",
    "Programs\\claude-console", 'claude-console.js', "'install'", '--repo', '--ignore-prereqs',
    'launch.vbs', 'irm https://claude.ai/install.ps1 | iex', 'RefreshPath', '-Zip',
  ]) assert.ok(s.includes(k), k);
  assert.ok(!/^\s*exit\b/im.test(s), 'never `exit`: it would close the window that ran irm | iex');
  assert.ok(!/npm install -g/.test(s));
});

// PREPUB-FIX (pre-publish scrub 2026-10-18): every download is checked against a SHA-256
// its publisher posts, and no installer runs unverified (fail closed: one line with the
// manual link, then stop); the UAC prompt of the fallback installers is said up front.
const UAC = 'If Node.js or Git is missing, Windows may ask for permission to install each one.';

test('install.ps1: fail closed - no download runs or installs without a published SHA-256', () => {
  const s = r(PS1);
  const git = s.slice(s.indexOf('# ---- 2. Git'), s.indexOf('# ---- 3.'));
  assert.ok(git.length > 100, 'Git section found');
  assert.match(git, /\$rel\.body/, 'hash from the release body');
  assert.match(git, /\.sha256'/, 'or from a .sha256 release asset');
  assert.match(git, /https:\/\/git-scm\.com\/download\/win/, 'the manual Git install link');
  // The installer runs only after a hash was got and matched: no "if hash then check" bypass.
  const run = git.indexOf('Run-Elevated $exe');
  const stop = git.search(/if \(-not \$gitSha\) \{ Say [^\n]*git-scm\.com[^\n]*; return \}/);
  const check = git.search(/if \(\(Sha \$exe\) -ne \$gitSha\) \{ throw/);
  assert.ok(stop > 0 && check > stop && run > check, 'stop when no hash, verify, then run: ' + [stop, check, run]);
  const node = s.slice(s.indexOf('# ---- 1. Node.js'), s.indexOf('# ---- 2. Git'));
  assert.match(node, /if \(-not \$want\) \{ Say [^\n]*https:\/\/nodejs\.org[^\n]*; return \}/);
  const zip = s.slice(s.indexOf('# ---- 3.'), s.indexOf('# ---- 4.'));
  assert.ok(!/not verified/.test(zip), 'no unverified zip install');
  assert.match(zip, /if \(-not \$Sums\) \{ Say [^\n]*releases[^\n]*; return \}/);
});

test('install.ps1 header and the README quickstart say Windows may ask for each install', () => {
  const s = r(PS1);
  const header = s.slice(0, s.indexOf('param('));
  assert.ok(header.replace(/\n#\s*/g, ' ').includes(UAC), 'header sentence');
  // The public build ships release/README.md as README.md.
  const rel = path.join(ROOT, 'release', 'README.md');
  const readme = r(fs.existsSync(rel) ? rel : path.join(ROOT, 'README.md'));
  const install = readme.slice(readme.indexOf('## Install'), readme.indexOf('\n## ', readme.indexOf('## Install') + 3));
  assert.ok(install.replace(/\n/g, ' ').includes(UAC), 'README install sentence');
});

test('tests and release files are ASCII only (escapes for any other character)', () => {
  for (const d of ['tests', 'release']) {
    for (const f of fs.readdirSync(path.join(ROOT, d))) {
      const p = path.join(ROOT, d, f);
      if (!fs.statSync(p).isFile()) continue;
      assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(fs.readFileSync(p, 'latin1')), p);
    }
  }
});

test('install.ps1 parses under Windows PowerShell 5.1 (ParseFile only, nothing runs)', { skip: process.platform !== 'win32' }, () => {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmd = "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('" + PS1.replace(/'/g, "''") + "', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message }; exit 1 }; 'parsed'";
  const res = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true });
  assert.strictEqual(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /parsed/);
});
