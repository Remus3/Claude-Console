'use strict';
// VMFIX (clean-box sandbox findings, 2026-10-18): a stranger's first install on a box
// with no Node, no git and no claude. Everything here runs in scratch dirs with fakes:
// no registry write, no shortcut, no network, no installer ever runs on this host.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
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
  assert.ok(p.warnings.some((x) => /^Git not found: /.test(x) && /skipped/.test(x) && /git status/.test(x)), p.warnings.join(' | '));
  assert.ok(!p.warnings.concat(p.problems).some((x) => /npm install -g/.test(x)), 'no npm -g suggestion');
  const old = prereq.checkPrereqs({ env: { PATH: '' }, nodeVersion: '20.0.0', gitCheck: () => true, edge: () => null });
  assert.strictEqual(old.ok, false);
  assert.match(old.problems[0], /Node 24 or newer/);
});

test('claude pane without claude: the install command plus the full config file path', () => {
  const dataDir = path.join(tmpdir('cc-vm-'), 'data');
  const msg = claudeenv.claudeMissingMessage({ dataDir });
  assert.ok(msg.startsWith(prereq.CLAUDE_MISSING), msg);
  assert.ok(msg.includes(path.join(dataDir, 'console.local.json')), msg);
  const m = new PaneManager({ runDir: tmpdir('cc-vm-'), dataDir, accounts: { acct1: {} }, defaultAccount: 'acct1', shells: {}, idleSeconds: 1 }, {});
  assert.throws(() => m.buildSpec({ kind: 'claude', cwd: dataDir }), (e) => e.message === msg);
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
  assert.ok(lines.some((l) => l === 'command: ' + path.join(home, 'claude-console.cmd')), 'full path of the CLI');
  const local = JSON.parse(r(path.join(home, 'data', 'console.local.json')));
  assert.strictEqual(local.updates.repo, 'Remus3/claude-console');
  assert.deepStrictEqual(fk.calls.shell[0][2], { version: '1.0.0', repo: 'Remus3/claude-console' });
  assert.ok(/& if errorlevel 1 \(exit \/b 1\) else exit \/b 0\s*$/m.test(r(path.join(home, 'claude-console.cmd'))), 'the CLI .cmd exits on its own line, exit code kept');
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

// ------------------------------------------------------------- CLI text

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
    'releases/latest/download/SHA256SUMS.txt', 'Get-FileHash', "'Remus3/claude-console'",
    "Programs\\claude-console", 'claude-console.js', "'install'", '--repo', '--ignore-prereqs',
    'launch.vbs', 'irm https://claude.ai/install.ps1 | iex', 'RefreshPath', '-Zip',
  ]) assert.ok(s.includes(k), k);
  assert.ok(!/^\s*exit\b/im.test(s), 'never `exit`: it would close the window that ran irm | iex');
  assert.ok(!/npm install -g/.test(s));
});

// PREPUB-FIX (pre-publish scrub 2026-10-18): every download is checked against a SHA-256
// its publisher posts, and no installer runs unverified (fail closed: one line with the
// manual link, then stop); the UAC prompt of the fallback installers is said up front.
const UAC = 'If Node.js or Git is missing and winget is unavailable, Windows will ask for permission once to install it.';

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

test('install.ps1 header and the README quickstart say the fallback installers ask for UAC once', () => {
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
