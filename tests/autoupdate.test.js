'use strict';
// CON-AUTOUPDATE: auto-update to the latest release with version skips, local
// customizations kept (3-way merge), Claude re-integration on conflict, never a restart
// over busy panes. Scratch dirs and fakes only: no network, no server, no scheduled task.
// The real test on the operator's other machine is pending (operator act).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tmpdir } = require('./helpers');
const manifest = require('../installer/manifest');
const release = require('../installer/release');
const install = require('../installer/install');
const paths = require('../installer/paths');
const auto = require('../installer/autoupdate');
const reint = require('../installer/reintegrate');
const cli = require('../installer/cli');

const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const r = (p) => fs.readFileSync(p, 'utf8');
const LINES = (n, tag) => Array.from({ length: n }, (_, i) => 'line ' + i + (tag && tag[i] ? ' ' + tag[i] : '')).join('\n') + '\n';
const okPre = { ok: true, problems: [], warnings: [], claude: null, edge: null };
const fk = { npmCi: async () => {}, selftest: async () => ({ ok: true, detail: 'fake' }) };
const REPO = 'someone/claude-console';
const at = (h, m) => new Date(2026, 9, 19, h, m);

function srcTree(root, v, files) {
  const d = path.join(root, 'src-' + v);
  w(path.join(d, 'package.json'), JSON.stringify({ name: 'claude-console', version: v }) + '\n');
  w(path.join(d, 'server', 'server.js'), '// server\n');
  for (const [k, s] of Object.entries(files || {})) w(path.join(d, ...k.split('/')), s);
  return d;
}

// A fake GitHub: releases built with the real builder, served by a fake fetch.
function fakeGithub(root, versions) {
  const out = path.join(root, 'gh');
  const rels = [];
  const blobs = {};
  for (const [v, files] of versions) {
    const b = release.buildRelease(srcTree(root, v, files), out, {});
    const zu = 'https://github.com/' + REPO + '/releases/download/v' + v + '/claude-console-' + v + '.zip';
    blobs[zu] = fs.readFileSync(b.zip);
    blobs[zu + '.sha256'] = Buffer.from(b.sha256 + '\n');
    rels.push({ tag_name: 'v' + v, assets: [{ name: 'claude-console-' + v + '.zip', browser_download_url: zu }, { name: 'claude-console-' + v + '.zip.sha256', browser_download_url: zu + '.sha256' }] });
  }
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    if (url.startsWith('https://api.github.com/repos/' + REPO + '/releases')) return { status: 200, headers: { get: () => null }, json: async () => rels };
    if (blobs[url]) return { status: 200, arrayBuffer: async () => blobs[url] };
    return { status: 404 };
  };
  return { fetch, calls };
}

async function installedHome(root, v, files, updates) {
  const home = path.join(root, 'home');
  const src = srcTree(root, v, files);
  manifest.writeManifest(src, manifest.buildManifest(src, { version: v }));
  await install.install({ home, sourceDir: src, prereqs: okPre, npmCi: fk.npmCi, selftest: fk.selftest, detectOpts: { legacy: [], skipProbe: true } });
  const L = paths.layout(home);
  const local = JSON.parse(r(path.join(L.data, 'console.local.json')));
  local.updates = Object.assign({}, local.updates, { repo: REPO }, updates || {});
  w(path.join(L.data, 'console.local.json'), JSON.stringify(local));
  return { home, L };
}

const noServer = async () => null;

test('accept (stranger): 2-version skip with a local edit updates cleanly in the window', async () => {
  const root = tmpdir('cc-auto-');
  const { home, L } = await installedHome(root, '1.0.0', { 'public/app.js': LINES(40) }, { auto: true });
  w(path.join(L.app('1.0.0'), 'public', 'app.js'), LINES(40, { 5: 'MY EDIT' }));
  const gh = fakeGithub(root, [['1.1.0', { 'public/app.js': LINES(40, { 20: 'v1.1' }) }], ['1.2.0', { 'public/app.js': LINES(40, { 20: 'v1.1', 35: 'v1.2' }) }]]);
  const res = await auto.tick({ home, now: at(4, 10), fetch: gh.fetch, serverInfo: noServer, npmCi: fk.npmCi, selftest: fk.selftest });
  assert.strictEqual(res.status, 'updated');
  assert.deepStrictEqual([res.from, res.to], ['1.0.0', '1.2.0']);
  const app = r(path.join(L.app('1.2.0'), 'public', 'app.js'));
  assert.ok(app.includes('line 5 MY EDIT') && app.includes('line 20 v1.1') && app.includes('line 35 v1.2'));
  assert.strictEqual(JSON.parse(r(L.marker)).version, '1.2.0');
  assert.strictEqual(auto.readState(home).lastResult.status, 'updated');
});

test('accept (this machine): legacy console migrates once, then a 2-version skip keeps the local edit', async () => {
  const root = tmpdir('cc-auto-');
  const legacy = path.join(root, 'Main', 'console');
  const v1files = { 'public/app.js': LINES(40) };
  const s1 = srcTree(root, '0.1.0', v1files);
  fs.cpSync(s1, legacy, { recursive: true });
  w(path.join(legacy, 'public', 'app.js'), LINES(40, { 7: 'OPERATOR EDIT' }));
  w(path.join(legacy, 'data', 'settings.json'), '{"fontSize":14}');
  const home = path.join(root, 'home');
  const lines = [];
  const deps = { out: (s) => lines.push(s), prereqs: okPre, npmCi: fk.npmCi, selftest: fk.selftest, nodePath: 'C:\\node.exe', detectOpts: { legacy: [legacy], skipProbe: true } };
  assert.strictEqual(await cli.run(['install', '--home', home, '--source', s1, '--no-shortcuts'], deps), 0);
  const L = paths.layout(home);
  assert.ok(r(path.join(L.app('0.1.0'), 'public', 'app.js')).includes('OPERATOR EDIT'), 'migration keeps the edit');
  assert.strictEqual(r(path.join(L.data, 'settings.json')), '{"fontSize":14}');
  const local = JSON.parse(r(path.join(L.data, 'console.local.json')));
  local.updates = { auto: true, repo: REPO, window: null };
  w(path.join(L.data, 'console.local.json'), JSON.stringify(local));
  const gh = fakeGithub(root, [['0.2.0', { 'public/app.js': LINES(40, { 30: 'v0.2' }) }], ['0.3.0', { 'public/app.js': LINES(40, { 30: 'v0.2', 38: 'v0.3' }) }]]);
  const res = await auto.tick({ home, now: at(13, 0), fetch: gh.fetch, serverInfo: noServer, npmCi: fk.npmCi, selftest: fk.selftest });
  assert.strictEqual(res.status, 'updated');
  const app = r(path.join(L.app('0.3.0'), 'public', 'app.js'));
  assert.ok(app.includes('OPERATOR EDIT') && app.includes('v0.2') && app.includes('v0.3'));
  assert.ok(fs.existsSync(path.join(legacy, 'public', 'app.js')), 'legacy dir untouched');
});

test('manual mode only checks and shows a badge; outside the window nothing applies; checks are throttled', async () => {
  const root = tmpdir('cc-auto-');
  const { home, L } = await installedHome(root, '1.0.0', {}, { auto: false });
  const gh = fakeGithub(root, [['1.1.0', {}]]);
  const a = await auto.tick({ home, now: at(4, 10), fetch: gh.fetch, serverInfo: noServer, npmCi: fk.npmCi, selftest: fk.selftest });
  assert.deepStrictEqual([a.status, a.reason, a.badge], ['available', 'manual', '1.1.0']);
  assert.strictEqual(JSON.parse(r(L.marker)).version, '1.0.0');
  const n = gh.calls.length;
  const b = await auto.tick({ home, now: at(5, 10), fetch: gh.fetch, serverInfo: noServer });
  assert.strictEqual(gh.calls.length, n, 'within checkHours: no new request');
  assert.strictEqual(b.badge, '1.1.0');
  const local = JSON.parse(r(path.join(L.data, 'console.local.json')));
  local.updates.auto = true;
  w(path.join(L.data, 'console.local.json'), JSON.stringify(local));
  const c = await auto.tick({ home, now: at(12, 0), fetch: gh.fetch, serverInfo: noServer, npmCi: fk.npmCi, selftest: fk.selftest });
  assert.strictEqual(c.reason, 'outside-window');
  assert.strictEqual(JSON.parse(r(L.marker)).version, '1.0.0');
});

test('busy panes: the update is staged, the restart waits for an idle tick', async () => {
  const root = tmpdir('cc-auto-');
  const { home, L } = await installedHome(root, '1.0.0', {}, { auto: true });
  const gh = fakeGithub(root, [['1.1.0', {}]]);
  const restarts = [];
  let panes = [{ state: 'busy' }];
  const serverInfo = async () => ({ version: '1.0.0', panes });
  const restart = async (L2, m) => { restarts.push(m.version); };
  const a = await auto.tick({ home, now: at(4, 5), fetch: gh.fetch, serverInfo, restart, npmCi: fk.npmCi, selftest: fk.selftest });
  assert.deepStrictEqual([a.status, a.restarted], ['updated', false]);
  assert.strictEqual(JSON.parse(r(L.marker)).version, '1.1.0');
  assert.strictEqual(auto.readState(home).pendingRestart, '1.1.0');
  assert.deepStrictEqual(restarts, []);
  const b = await auto.tick({ home, now: at(4, 20), fetch: gh.fetch, serverInfo, restart });
  assert.strictEqual(b.status, 'restart-waiting');
  panes = [{ state: 'waiting' }];
  const c = await auto.tick({ home, now: at(4, 35), fetch: gh.fetch, serverInfo, restart });
  assert.strictEqual(c.status, 'restarted');
  assert.deepStrictEqual(restarts, ['1.1.0']);
  assert.strictEqual(auto.readState(home).pendingRestart, null);
});

test('conflict without re-integration: needs review, marker unchanged, prompt written, no retry loop', async () => {
  const root = tmpdir('cc-auto-');
  const { home, L } = await installedHome(root, '1.0.0', { 'x.js': 'orig\n' }, { auto: true });
  w(path.join(L.app('1.0.0'), 'x.js'), 'mine\n');
  const gh = fakeGithub(root, [['2.0.0', { 'x.js': 'theirs\n' }]]);
  const a = await auto.tick({ home, now: at(4, 5), fetch: gh.fetch, serverInfo: noServer, npmCi: fk.npmCi, selftest: fk.selftest });
  assert.strictEqual(a.status, 'needs-review');
  assert.deepStrictEqual(a.conflicts, ['x.js']);
  assert.strictEqual(JSON.parse(r(L.marker)).version, '1.0.0');
  assert.ok(fs.existsSync(a.prompt) && r(a.prompt).includes('x.js'));
  const n = gh.calls.length;
  const b = await auto.tick({ home, now: at(4, 30), fetch: gh.fetch, serverInfo: noServer, force: true });
  assert.strictEqual(b.reason, 'needs-review');
  assert.strictEqual(gh.calls.filter((u) => u.endsWith('.zip')).length, gh.calls.slice(0, n).filter((u) => u.endsWith('.zip')).length, 'no re-download for the same version');
});

test('conflict with Claude re-integration: resolved -> updated; markers left -> needs review', async () => {
  const root = tmpdir('cc-auto-');
  const cmd = ['claude-fake', '--prompt-file', '{prompt}', '--cwd', '{dir}'];
  const { home, L } = await installedHome(root, '1.0.0', { 'x.js': 'orig\n' }, { auto: true, reintegrate: { enabled: true, command: cmd } });
  w(path.join(L.app('1.0.0'), 'x.js'), 'mine\n');
  const gh = fakeGithub(root, [['2.0.0', { 'x.js': 'theirs\n' }]]);
  const seen = [];
  const run = async (argv, timeoutSec, cwd) => {
    seen.push(argv);
    w(path.join(cwd, 'x.js'), 'mine + theirs\n');
    fs.unlinkSync(path.join(cwd, 'x.js.new'));
    return { code: 0, out: 'ok' };
  };
  const a = await auto.tick({ home, now: at(4, 5), fetch: gh.fetch, serverInfo: noServer, npmCi: fk.npmCi, selftest: fk.selftest, run });
  assert.strictEqual(a.status, 'updated');
  assert.strictEqual(r(path.join(L.app('2.0.0'), 'x.js')), 'mine + theirs\n');
  assert.strictEqual(seen[0][0], 'claude-fake');
  assert.ok(seen[0][2].endsWith('.md') && seen[0][4] === L.app('2.0.0'), 'placeholders filled, no shell');
  // a second install where the run leaves markers behind
  const root2 = tmpdir('cc-auto-');
  const h2 = await installedHome(root2, '1.0.0', { 'x.js': LINES(3) }, { auto: true, reintegrate: { enabled: true, command: cmd } });
  w(path.join(h2.L.app('1.0.0'), 'x.js'), LINES(3, { 1: 'mine' }));
  const gh2 = fakeGithub(root2, [['2.0.0', { 'x.js': LINES(3, { 1: 'theirs' }) }]]);
  const bad = async (argv, t, cwd) => { fs.copyFileSync(path.join(cwd, 'x.js.new'), path.join(cwd, 'x.js')); fs.unlinkSync(path.join(cwd, 'x.js.new')); return { code: 0 }; };
  const b = await auto.tick({ home: h2.home, now: at(4, 5), fetch: gh2.fetch, serverInfo: noServer, npmCi: fk.npmCi, selftest: fk.selftest, run: bad });
  assert.strictEqual(b.status, 'needs-review', 'conflict markers left = unresolved');
  assert.strictEqual(JSON.parse(r(h2.L.marker)).version, '1.0.0');
});

test('a failed self-test after the update rolls back and is reported', async () => {
  const root = tmpdir('cc-auto-');
  const { home, L } = await installedHome(root, '1.0.0', {}, { auto: true });
  const gh = fakeGithub(root, [['1.1.0', {}]]);
  const a = await auto.tick({ home, now: at(4, 5), fetch: gh.fetch, serverInfo: noServer, npmCi: fk.npmCi, selftest: async () => ({ ok: false, detail: 'boom' }) });
  assert.strictEqual(a.status, 'rolled-back');
  assert.strictEqual(JSON.parse(r(L.marker)).version, '1.0.0');
});

test('not installed: auto-update never migrates on its own', async () => {
  const root = tmpdir('cc-auto-');
  const a = await auto.tick({ home: path.join(root, 'none'), now: at(4, 5), fetch: async () => { throw new Error('no'); }, serverInfo: noServer });
  assert.strictEqual(a.status, 'not-installed');
});

test('reintegrate prompt names every conflict and the contract', () => {
  const ctx = { target: 'C:\\h\\app\\2.0.0', baseDir: 'C:\\h\\.base\\1.0.0', localDir: 'C:\\h\\app\\1.0.0', report: { from: '1.0.0', to: '2.0.0', backup: 'C:\\h\\b.zip', files: [{ rel: 'a/x.js', result: 'conflict' }, { rel: 'y.js', result: 'kept' }] } };
  const p = reint.buildPrompt(ctx);
  assert.ok(p.includes('- a/x.js') && !p.includes('- y.js'));
  assert.ok(p.includes('Delete <file>.new') && p.includes('no git, no network'));
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(p));
});

test('scheduled task script: ASCII, version-free action, parses under Windows PowerShell 5.1 (never run)', () => {
  const root = tmpdir('cc-auto-');
  const L = paths.layout(path.join(root, 'home'));
  const s = auto.registerScript(L, { window: '04:00-05:00' });
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(s));
  assert.ok(s.includes("'ClaudeConsole-AutoUpdate'") && s.includes('autoupdate.vbs') && s.includes("'04:00'") && s.includes('IgnoreNew'));
  assert.ok(!/app\\\d/.test(s), 'no version in the task action');
  const u = auto.unregisterScript();
  const file = path.join(root, 'reg.ps1');
  fs.writeFileSync(file, s);
  fs.writeFileSync(path.join(root, 'unreg.ps1'), u);
  const ps = 'foreach ($f in @(\'' + file + '\', \'' + path.join(root, 'unreg.ps1') + '\')) { $e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile($f,[ref]$null,[ref]$e); $e.Count }';
  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  assert.deepStrictEqual(res.stdout.trim().split(/\r?\n/), ['0', '0'], res.stderr);
});

test('CLI autoupdate: --register writes the script and prints how to run it; tick runs with deps', async () => {
  const root = tmpdir('cc-auto-');
  const { home } = await installedHome(root, '1.0.0', {}, { auto: false });
  const lines = [];
  const gh = fakeGithub(root, [['1.0.1', {}]]);
  const deps = { out: (s) => lines.push(s), fetch: gh.fetch, serverInfo: noServer, npmCi: fk.npmCi, selftest: fk.selftest };
  assert.strictEqual(await cli.run(['autoupdate', '--home', home, '--register'], deps), 0);
  assert.ok(fs.existsSync(path.join(home, 'register-autoupdate.ps1')));
  assert.ok(lines.some((l) => l.includes('powershell.exe -NoProfile -ExecutionPolicy Bypass -File')));
  assert.strictEqual(await cli.run(['autoupdate', '--home', home, '--json'], deps), 0);
  assert.strictEqual(JSON.parse(lines[lines.length - 1]).badge, '1.0.1');
});
