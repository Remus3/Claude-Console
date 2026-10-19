'use strict';
// CON-PUBLIC B/D/E/F: installer, update engine, releases, repair, contribute, CLI.
// Everything runs in scratch dirs with fakes: no npm, no shortcuts, no Recycle Bin, no
// network, never the real install home or the live server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { tmpdir } = require('./helpers');

const manifest = require('../installer/manifest');
const semver = require('../installer/semver');
const merge = require('../installer/merge');
const backup = require('../installer/backup');
const release = require('../installer/release');
const settings = require('../installer/settings');
const detect = require('../installer/detect');
const install = require('../installer/install');
const upd = require('../installer/update');
const repair = require('../installer/repair');
const contribute = require('../installer/contribute');
const prereq = require('../installer/prereq');
const launcher = require('../installer/launcher');
const paths = require('../installer/paths');
const cli = require('../installer/cli');
const { loadConfig } = require('../server/config');

const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const r = (p) => fs.readFileSync(p, 'utf8');

// A fake console release tree: package.json + a few code files + MANIFEST.json.
function makeRelease(root, version, files) {
  const dir = path.join(root, 'rel-' + version);
  w(path.join(dir, 'package.json'), JSON.stringify({ name: 'claude-console', version }) + '\n');
  w(path.join(dir, 'server', 'server.js'), '// server ' + version + '\n');
  for (const [rel, text] of Object.entries(files || {})) w(path.join(dir, ...rel.split('/')), text);
  manifest.writeManifest(dir, manifest.buildManifest(dir, { version }));
  return dir;
}

const LINES = (n, tag) => Array.from({ length: n }, (_, i) => 'line ' + i + (tag && tag[i] ? ' ' + tag[i] : '')).join('\n') + '\n';
const fakes = () => {
  const calls = { npm: [], selftest: [], shortcuts: [], recycle: [] };
  return {
    calls,
    npmCi: async (dir) => { calls.npm.push(dir); },
    selftest: async (dir, v) => { calls.selftest.push([dir, v]); return { ok: true, detail: 'fake' }; },
    makeShortcuts: async (home, vbs) => { calls.shortcuts.push(vbs); return ['fake']; },
    recycle: async (p) => { calls.recycle.push(p); fs.rmSync(p, { recursive: true, force: true }); },
  };
};
const noDetect = { legacy: [], skipProbe: true };
const okPre = { ok: true, problems: [], warnings: [], claude: 'C:\\fake\\claude.exe', edge: null };

test('paths: layout under one home, versions are never paths', () => {
  const L = paths.layout('C:\\x\\CC');
  assert.strictEqual(L.marker, path.join('C:\\x\\CC', 'install.json'));
  assert.strictEqual(L.app('1.2.3'), path.join('C:\\x\\CC', 'app', '1.2.3'));
  assert.throws(() => L.app('..\\..\\evil'));
  assert.throws(() => L.app('1.2'));
  assert.strictEqual(paths.defaultHome({ LOCALAPPDATA: 'C:\\L' }), path.join('C:\\L', 'Programs', 'claude-console'));
  assert.strictEqual(paths.defaultHome({ CLAUDE_CONSOLE_HOME: 'C:\\h' }), path.resolve('C:\\h'));
});

test('semver: order with prereleases', () => {
  assert.strictEqual(semver.cmp('1.2.3', '1.2.3'), 0);
  assert.strictEqual(semver.cmp('1.10.0', '1.9.9'), 1);
  assert.strictEqual(semver.cmp('2.0.0-beta.1', '2.0.0'), -1);
  assert.strictEqual(semver.cmp('2.0.0-beta.2', '2.0.0-beta.10'), -1);
  assert.strictEqual(semver.cmp('v0.1.0', '0.0.9'), 1);
  assert.throws(() => semver.cmp('x', '1.0.0'));
});

test('manifest: release files only, verify catches missing and changed files, unsafe paths', () => {
  const root = tmpdir('cc-inst-');
  const dir = path.join(root, 'src');
  w(path.join(dir, 'package.json'), '{}');
  w(path.join(dir, 'public', 'app.js'), 'x');
  for (const skip of ['node_modules/a/b.js', 'data/settings.json', 'run/token', 'drops/x.png', '.base/1.0.0/x', 'server.log', 'public/app.js.new', 'public/sub/node_modules/z.js']) w(path.join(dir, ...skip.split('/')), 's');
  const m = manifest.buildManifest(dir, { version: '1.0.0' });
  assert.deepStrictEqual(Object.keys(m.files).sort(), ['package.json', 'public/app.js']);
  assert.ok(manifest.verifyTree(dir, m).ok);
  w(path.join(dir, 'public', 'app.js'), 'changed');
  fs.unlinkSync(path.join(dir, 'package.json'));
  const v = manifest.verifyTree(dir, m);
  assert.deepStrictEqual(v.missing, ['package.json']);
  assert.deepStrictEqual(v.mismatch, ['public/app.js']);
  for (const bad of ['../x', '/x', 'C:/x', 'a\\b', 'a//b', './a', '']) assert.strictEqual(manifest.safeRel(bad), false, bad);
  assert.ok(manifest.safeRel('server/server.js'));
  assert.strictEqual(manifest.verifyTree(dir, { files: { '../evil': 'x' } }).ok, false);
});

test('merge: every row of the D table', () => {
  const root = tmpdir('cc-inst-');
  const base = path.join(root, 'base');
  const local = path.join(root, 'local');
  const neu = path.join(root, 'new');
  const put = (d, rel, s) => w(path.join(d, ...rel.split('/')), s);
  // unchanged locally, changed upstream -> replace
  for (const d of [base, local]) put(d, 'a.js', 'A1\n'); put(neu, 'a.js', 'A2\n');
  // changed locally, unchanged upstream -> keep local
  put(base, 'b.js', 'B1\n'); put(local, 'b.js', 'B-local\n'); put(neu, 'b.js', 'B1\n');
  // both changed, different lines -> clean merge
  put(base, 'c.js', LINES(20)); put(local, 'c.js', LINES(20, { 2: 'LOCAL' })); put(neu, 'c.js', LINES(20, { 17: 'UPSTREAM' }));
  // both changed, same line -> conflict
  put(base, 'd.js', 'D1\n'); put(local, 'd.js', 'D-local\n'); put(neu, 'd.js', 'D-new\n');
  // new upstream file -> add
  put(neu, 'e.js', 'E\n');
  // changed locally, deleted upstream -> keep + flag
  put(base, 'f.js', 'F1\n'); put(local, 'f.js', 'F-local\n');
  // user-only file -> kept
  put(local, 'mine.js', 'M\n');
  // unchanged locally, deleted upstream -> dropped
  put(base, 'g.js', 'G\n'); put(local, 'g.js', 'G\n');
  // deleted locally, still upstream -> restored + flagged
  put(base, 'h.js', 'H\n'); put(neu, 'h.js', 'H\n');
  const plan = merge.planMerge(local, base, neu);
  const act = Object.fromEntries(plan.map((p) => [p.rel, p.action]));
  assert.deepStrictEqual(act, { 'a.js': 'replace', 'b.js': 'keep-local', 'c.js': 'merge', 'd.js': 'merge', 'e.js': 'add', 'f.js': 'keep-flag', 'g.js': 'drop', 'h.js': 'restore', 'mine.js': 'keep-added' });
  const target = path.join(root, 'target');
  fs.cpSync(neu, target, { recursive: true });
  const rows = merge.applyMerge(plan, local, base, neu, target);
  const res = Object.fromEntries(rows.map((x) => [x.rel, x.result]));
  assert.deepStrictEqual(res, { 'a.js': 'new', 'b.js': 'kept', 'c.js': 'merged', 'd.js': 'conflict', 'e.js': 'new', 'f.js': 'flagged', 'g.js': 'dropped', 'h.js': 'flagged', 'mine.js': 'kept' });
  assert.strictEqual(r(path.join(target, 'a.js')), 'A2\n');
  assert.strictEqual(r(path.join(target, 'b.js')), 'B-local\n');
  const c = r(path.join(target, 'c.js'));
  assert.ok(c.includes('line 2 LOCAL') && c.includes('line 17 UPSTREAM'), c);
  assert.strictEqual(r(path.join(target, 'd.js')), 'D-local\n', 'conflict keeps the local file working');
  assert.match(r(path.join(target, 'd.js.new')), /<<<<<<< local[\s\S]*D-local[\s\S]*D-new[\s\S]*>>>>>>> new/);
  assert.strictEqual(r(path.join(target, 'f.js')), 'F-local\n');
  assert.strictEqual(r(path.join(target, 'mine.js')), 'M\n');
  assert.ok(!fs.existsSync(path.join(target, 'g.js')));
  assert.deepStrictEqual(merge.summarize(rows), { new: 2, kept: 2, merged: 1, conflict: 1, flagged: 2, dropped: 1 });
});

test('merge: no base (legacy) never overwrites a differing local file; binary goes aside', () => {
  const root = tmpdir('cc-inst-');
  const local = path.join(root, 'local');
  const neu = path.join(root, 'new');
  w(path.join(local, 'same.js'), 'S\n'); w(path.join(neu, 'same.js'), 'S\n');
  w(path.join(local, 'diff.js'), 'mine\n'); w(path.join(neu, 'diff.js'), 'theirs\n');
  const plan = merge.planMerge(local, null, neu);
  assert.deepStrictEqual(plan.map((p) => p.action), ['conflict-nobase', 'same']);
  const target = path.join(root, 't');
  fs.cpSync(neu, target, { recursive: true });
  merge.applyMerge(plan, local, null, neu, target);
  assert.strictEqual(r(path.join(target, 'diff.js')), 'mine\n');
  assert.strictEqual(r(path.join(target, 'diff.js.new')), 'theirs\n');
  // binary: both changed -> conflict with the new file aside
  const b = path.join(root, 'b'); const l2 = path.join(root, 'l2'); const n2 = path.join(root, 'n2'); const t2 = path.join(root, 't2');
  w(path.join(b, 'i.png'), Buffer.from([0, 1, 2])); w(path.join(l2, 'i.png'), Buffer.from([0, 1, 3])); w(path.join(n2, 'i.png'), Buffer.from([0, 1, 4]));
  fs.cpSync(n2, t2, { recursive: true });
  const rows = merge.applyMerge(merge.planMerge(l2, b, n2), l2, b, n2, t2);
  assert.strictEqual(rows[0].result, 'conflict');
  assert.deepStrictEqual([...fs.readFileSync(path.join(t2, 'i.png'))], [0, 1, 3]);
  assert.deepStrictEqual([...fs.readFileSync(path.join(t2, 'i.png.new'))], [0, 1, 4]);
});

test('backup: zip and restore round trip without node_modules', () => {
  const root = tmpdir('cc-inst-');
  const src = path.join(root, 'src');
  w(path.join(src, 'a', 'b.txt'), 'hello');
  w(path.join(src, 'node_modules', 'x.js'), 'big');
  const z = backup.zipDir(src, path.join(root, 'backups'), 'app-1.0.0');
  assert.match(path.basename(z), /^\d{8}-\d{6}-app-1\.0\.0\.zip$/);
  const out = backup.unzipTo(z, path.join(root, 'restore'));
  assert.strictEqual(r(path.join(out, 'a', 'b.txt')), 'hello');
  assert.ok(!fs.existsSync(path.join(out, 'node_modules')));
});

test('release: build, verify, tamper detection, pick by channel', () => {
  const root = tmpdir('cc-inst-');
  const src = path.join(root, 'src');
  w(path.join(src, 'package.json'), JSON.stringify({ name: 'claude-console', version: '1.4.0' }));
  w(path.join(src, 'server', 'server.js'), '//s');
  w(path.join(src, 'data', 'settings.json'), '{"secret":1}');
  w(path.join(src, 'node_modules', 'x.js'), 'x');
  const out = path.join(root, 'out');
  const b = release.buildRelease(src, out, {});
  assert.strictEqual(b.info.version, '1.4.0');
  assert.strictEqual(b.info.files, 2, 'data/ and node_modules/ are never in a release');
  assert.match(r(path.join(out, 'SHA256SUMS.txt')), /^[0-9a-f]{64} {2}claude-console-1\.4\.0\.zip\n$/);
  const ex = release.extractRelease(b.zip, path.join(root, 'x'), '1.4.0');
  assert.strictEqual(ex.manifest.version, '1.4.0');
  w(path.join(ex.dir, 'server', 'server.js'), '//tampered');
  assert.throws(() => release.verifyReleaseDir(ex.dir, '1.4.0'), /fail the manifest/);
  assert.throws(() => release.verifyReleaseDir(ex.dir, '9.9.9'), /manifest version/);
  const asset = (v) => [{ name: 'claude-console-' + v + '.zip', browser_download_url: 'https://github.com/o/r/releases/download/v' + v + '/z' }, { name: 'claude-console-' + v + '.zip.sha256', browser_download_url: 'https://github.com/o/r/releases/download/v' + v + '/s' }];
  const list = [
    { tag_name: 'v1.2.0', assets: asset('1.2.0') },
    { tag_name: 'v1.5.0', assets: asset('1.5.0') },
    { tag_name: 'v1.6.0-beta.1', prerelease: true, assets: asset('1.6.0-beta.1') },
    { tag_name: 'v1.7.0', draft: true, assets: asset('1.7.0') },
    { tag_name: 'v1.8.0', assets: [] },
  ];
  assert.strictEqual(release.pickRelease(list, 'stable', '1.2.0').latest.version, '1.5.0');
  assert.strictEqual(release.pickRelease(list, 'beta', '1.2.0').latest.version, '1.6.0-beta.1');
  assert.strictEqual(release.pickRelease(list, 'stable', '1.5.0').available, false);
});

function fakeFetch(routes, log) {
  return async (url, init) => {
    log.push({ url, headers: (init && init.headers) || {} });
    const h = routes[url];
    if (!h) return { status: 404, headers: { get: () => null }, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    return h(init || {});
  };
}

test('release: check is ETag-cached, opt-out and repo-gated; download verifies SHA-256 and host', async () => {
  const root = tmpdir('cc-inst-');
  const src = path.join(root, 'src');
  w(path.join(src, 'package.json'), JSON.stringify({ name: 'claude-console', version: '2.0.0' }));
  w(path.join(src, 'server', 'server.js'), '//s2');
  const b = release.buildRelease(src, path.join(root, 'out'), {});
  const zipBuf = fs.readFileSync(b.zip);
  const api = 'https://api.github.com/repos/someone/claude-console/releases?per_page=30';
  const zipUrl = 'https://github.com/someone/claude-console/releases/download/v2.0.0/claude-console-2.0.0.zip';
  const shaUrl = zipUrl + '.sha256';
  const listBody = [{ tag_name: 'v2.0.0', assets: [{ name: 'claude-console-2.0.0.zip', browser_download_url: zipUrl }, { name: 'claude-console-2.0.0.zip.sha256', browser_download_url: shaUrl }] }];
  const log = [];
  const routes = {
    [api]: (init) => (init.headers['If-None-Match'] === '"e1"' ? { status: 304, headers: { get: () => null } } : { status: 200, headers: { get: (k) => (k === 'etag' ? '"e1"' : null) }, json: async () => listBody }),
    [zipUrl]: () => ({ status: 200, arrayBuffer: async () => zipBuf.buffer.slice(zipBuf.byteOffset, zipBuf.byteOffset + zipBuf.length) }),
    [shaUrl]: () => ({ status: 200, arrayBuffer: async () => Buffer.from(b.sha256 + '  x\n') }),
  };
  const f = fakeFetch(routes, log);
  const cacheFile = path.join(root, 'cache', 'releases.json');
  const s = settings.normalizeUpdates({ repo: 'someone/claude-console' });
  assert.deepStrictEqual(await release.checkReleases({ settings: settings.normalizeUpdates({}), cacheFile, fetch: f }), { checked: false, reason: 'no-repo' });
  assert.deepStrictEqual(await release.checkReleases({ settings: Object.assign({}, s, { check: false }), cacheFile, fetch: f }), { checked: false, reason: 'check-off' });
  assert.strictEqual(log.length, 0, 'no request without a repo or with the check off');
  const c1 = await release.checkReleases({ settings: s, cacheFile, current: '1.0.0', fetch: f });
  assert.strictEqual(c1.available, true);
  assert.strictEqual(c1.cached, false);
  const c2 = await release.checkReleases({ settings: s, cacheFile, current: '1.0.0', fetch: f });
  assert.strictEqual(c2.cached, true);
  assert.strictEqual(log[1].headers['If-None-Match'], '"e1"');
  assert.ok(!('Authorization' in log[1].headers), 'unauthenticated');
  const got = await release.downloadRelease(c2.latest, path.join(root, 'dl'), { fetch: f });
  assert.strictEqual(got.manifest.version, '2.0.0');
  const bad = fakeFetch(Object.assign({}, routes, { [shaUrl]: () => ({ status: 200, arrayBuffer: async () => Buffer.from('0'.repeat(64)) }) }), []);
  await assert.rejects(release.downloadRelease(c2.latest, path.join(root, 'dl2'), { fetch: bad }), /SHA-256 mismatch/);
  await assert.rejects(release.downloadRelease({ version: '2.0.0', zipUrl: 'https://evil.example/z', shaUrl: 'https://evil.example/s' }, path.join(root, 'dl3'), { fetch: f }), /refused download host/);
});

test('settings: updates defaults, window incl. midnight wrap, auto decision', () => {
  const d = settings.normalizeUpdates(undefined);
  assert.deepStrictEqual([d.auto, d.channel, d.checkHours, d.window, d.check, d.repo], [false, 'stable', 24, '04:00-05:00', true, null]);
  assert.strictEqual(settings.normalizeUpdates({ repo: 'bad repo/../x' }).repo, null);
  assert.strictEqual(settings.normalizeUpdates({ window: '25:00-26:00' }).window, '04:00-05:00');
  assert.strictEqual(settings.normalizeUpdates({ reintegrate: { enabled: true, command: 'rm -rf' } }).reintegrate.enabled, false, 'command must be an argv array');
  const at = (h, m) => new Date(2026, 9, 18, h, m);
  assert.ok(settings.inWindow('04:00-05:00', at(4, 30)));
  assert.ok(!settings.inWindow('04:00-05:00', at(5, 0)));
  assert.ok(settings.inWindow('23:00-01:00', at(0, 30)));
  assert.ok(!settings.inWindow('23:00-01:00', at(12, 0)));
  const auto = { auto: true, window: '04:00-05:00' };
  assert.strictEqual(settings.decideAuto({ settings: {}, available: true, now: at(4, 10) }).reason, 'manual');
  assert.strictEqual(settings.decideAuto({ settings: auto, available: true, now: at(9, 0) }).reason, 'outside-window');
  assert.strictEqual(settings.decideAuto({ settings: auto, available: true, now: at(4, 10), needsReview: true }).reason, 'needs-review');
  const busy = settings.decideAuto({ settings: auto, available: true, now: at(4, 10), panes: [{ state: 'busy' }], serverRunning: true });
  assert.deepStrictEqual([busy.apply, busy.restart, busy.reason], [true, false, 'panes-busy']);
  const ok = settings.decideAuto({ settings: auto, available: true, now: at(4, 10), panes: [{ state: 'waiting' }], serverRunning: true });
  assert.deepStrictEqual([ok.apply, ok.restart], [true, true]);
  assert.strictEqual(settings.decideAuto({ settings: auto, available: false }).reason, 'up-to-date');
});

test('config: install env dirs move data/run/drops outside the code dir; opts still win', () => {
  const env = { CLAUDE_CONSOLE_DATA: 'C:\\cc\\data', CLAUDE_CONSOLE_RUN: 'C:\\cc\\run', CLAUDE_CONSOLE_DROPS: 'C:\\cc\\drops' };
  const c = loadConfig({ env, configFile: path.join(tmpdir('cc-inst-'), 'none.json') });
  assert.deepStrictEqual([c.dataDir, c.runDir, c.dropsDir], [env.CLAUDE_CONSOLE_DATA, env.CLAUDE_CONSOLE_RUN, env.CLAUDE_CONSOLE_DROPS]);
  const t = loadConfig({ env, dataDir: 'C:\\t\\data', runDir: 'C:\\t\\run' });
  assert.deepStrictEqual([t.dataDir, t.runDir], ['C:\\t\\data', 'C:\\t\\run']);
  assert.strictEqual(loadConfig({ env: { CLAUDE_CONSOLE_DATA: 'relative\\x' } }).dataDir, path.join(path.resolve(__dirname, '..'), 'data'));
});

test('detect: marker, legacy layout and a running server', async () => {
  const root = tmpdir('cc-inst-');
  const home = path.join(root, 'home');
  const legacy = path.join(root, 'Main', 'console');
  w(path.join(legacy, 'package.json'), JSON.stringify({ name: 'claude-console', version: '0.1.0' }));
  w(path.join(legacy, 'server', 'server.js'), '//');
  const notConsole = path.join(root, 'other');
  w(path.join(notConsole, 'package.json'), JSON.stringify({ name: 'x' }));
  let d = await detect.detect({ home, legacy: [legacy, notConsole], skipProbe: true });
  assert.strictEqual(d.kind, 'legacy');
  assert.deepStrictEqual(d.legacy, [{ path: legacy, version: '0.1.0' }]);
  const srv = http.createServer((req, res) => { res.writeHead(req.url === '/api/info' ? 200 : 404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ version: '0.1.0' })); });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  try {
    d = await detect.detect({ home, legacy: [], port: srv.address().port });
    assert.strictEqual(d.kind, 'running');
    assert.strictEqual(d.running.version, '0.1.0');
  } finally { srv.close(); }
  w(path.join(home, 'install.json'), JSON.stringify({ version: '1.0.0', path: 'x' }));
  d = await detect.detect({ home, legacy: [legacy], skipProbe: true });
  assert.strictEqual(d.kind, 'marker');
  assert.strictEqual(d.legacy.length, 1, 'legacy still listed beside a marker');
});

test('prereq: missing Node / claude.exe are reported in words', () => {
  const p = prereq.checkPrereqs({ env: { PATH: '', APPDATA: 'C:\\nope' }, nodeVersion: '20.1.0', gitCheck: () => false, edge: () => null });
  assert.strictEqual(p.ok, false);
  assert.ok(p.problems.some((x) => /Node 24/.test(x)));
  assert.ok(p.warnings.some((x) => /Claude Code CLI not found/.test(x)), 'a missing claude CLI is a warning (VMFIX)');
  assert.ok(p.warnings.some((x) => /Edge/.test(x)) && p.warnings.some((x) => /git/.test(x)));
  const root = tmpdir('cc-inst-');
  const exe = path.join(root, 'bin', 'claude.exe');
  w(exe, 'x');
  const ok = prereq.checkPrereqs({ env: { PATH: path.dirname(exe), APPDATA: 'C:\\nope' }, nodeVersion: '24.3.0', gitCheck: () => true, edge: () => 'C:\\e.exe' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.claude, exe, 'claude.exe by full path');
});

test('launcher: ASCII LF launchers name the version; shortcut script targets wscript', () => {
  const f = launcher.launcherFiles('C:\\cc', '1.2.3', 'C:\\Program Files\\nodejs\\node.exe');
  for (const s of [f.vbs, f.cmd]) {
    assert.ok(/^[\x0a\x20-\x7e]*$/.test(s), 'ASCII + LF only');
    assert.ok(s.includes(path.join('C:\\cc', 'app', '1.2.3', 'bin', 'claude-console.js')));
  }
  assert.ok(f.vbs.includes('start --open --home'));
  assert.ok(f.vbs.includes(', 0, False'), 'hidden window');
  const ps = launcher.shortcutScript('C:\\cc\\launch.vbs');
  assert.ok(ps.includes("'C:\\cc\\launch.vbs'") && ps.includes('wscript.exe') && ps.includes("GetFolderPath('Programs')"));
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(ps));
});

test('install: clean install lays out app, base, data, launchers, marker', async () => {
  const root = tmpdir('cc-inst-');
  const home = path.join(root, 'home');
  const src = makeRelease(root, '1.0.0', { 'public/app.js': 'app v1\n' });
  const fk = fakes();
  const rep = await install.install({ home, sourceDir: src, prereqs: okPre, npmCi: fk.npmCi, selftest: fk.selftest, makeShortcuts: fk.makeShortcuts, nodePath: 'C:\\node.exe', detectOpts: noDetect });
  assert.strictEqual(rep.status, 'installed');
  const L = paths.layout(home);
  const m = JSON.parse(r(L.marker));
  assert.deepStrictEqual([m.version, m.path, m.channel], ['1.0.0', L.app('1.0.0'), 'stable']);
  assert.strictEqual(r(path.join(L.app('1.0.0'), 'public', 'app.js')), 'app v1\n');
  assert.ok(fs.existsSync(path.join(L.base('1.0.0'), 'MANIFEST.json')));
  const local = JSON.parse(r(path.join(L.data, 'console.local.json')));
  assert.strictEqual(local.claudePath, 'C:\\fake\\claude.exe');
  assert.strictEqual(local.updates.auto, false, 'auto-update off for strangers');
  assert.ok(!('repo' in local.updates), 'first-run config leaves updates.repo to the release config');
  assert.strictEqual(local.plugins.main.enabled, false);
  assert.ok(fs.existsSync(L.launcherVbs));
  assert.deepStrictEqual(fk.calls.npm, [L.app('1.0.0')]);
  assert.deepStrictEqual(fk.calls.shortcuts, [L.launcherVbs]);
  // same version again: nothing to do; missing prereqs: nothing done
  assert.strictEqual((await install.install({ home, sourceDir: src, prereqs: okPre, npmCi: fk.npmCi, selftest: fk.selftest, detectOpts: noDetect })).status, 'already-installed');
  const home2 = path.join(root, 'home2');
  const miss = await install.install({ home: home2, sourceDir: src, prereqs: { ok: false, problems: ['no node'], warnings: [] }, detectOpts: noDetect });
  assert.strictEqual(miss.status, 'missing-prereqs');
  assert.ok(!fs.existsSync(path.join(home2, 'install.json')));
});

test('install: a source tree without a manifest is staged with one; a failed self-test leaves no marker', async () => {
  const root = tmpdir('cc-inst-');
  const src = path.join(root, 'checkout');
  w(path.join(src, 'package.json'), JSON.stringify({ name: 'claude-console', version: '1.1.0' }));
  w(path.join(src, 'server', 'server.js'), '//');
  w(path.join(src, 'data', 'settings.json'), '{"mine":1}');
  const home = path.join(root, 'home');
  const fk = fakes();
  const rep = await install.install({ home, sourceDir: src, prereqs: okPre, npmCi: fk.npmCi, selftest: async () => ({ ok: false, detail: 'boom' }), detectOpts: noDetect });
  assert.strictEqual(rep.status, 'selftest-failed');
  assert.ok(!fs.existsSync(path.join(home, 'install.json')));
  assert.ok(!fs.existsSync(paths.layout(home).app('1.1.0')), 'failed build moved aside');
  const ok = await install.install({ home, sourceDir: src, prereqs: okPre, npmCi: fk.npmCi, selftest: fk.selftest, detectOpts: noDetect });
  assert.strictEqual(ok.status, 'installed');
  assert.ok(!fs.existsSync(path.join(paths.layout(home).app('1.1.0'), 'data')), 'source data/ never copied into the app');
});

async function installed(root, version, files) {
  const home = path.join(root, 'home');
  const src = makeRelease(root, version, files);
  const fk = fakes();
  await install.install({ home, sourceDir: src, prereqs: okPre, npmCi: fk.npmCi, selftest: fk.selftest, detectOpts: noDetect });
  return { home, L: paths.layout(home), fk };
}

test('update: a version skip with a local edit merges cleanly; data untouched; launcher moves', async () => {
  const root = tmpdir('cc-inst-');
  const { home, L, fk } = await installed(root, '1.0.0', { 'public/app.js': LINES(30) });
  w(path.join(L.data, 'settings.json'), '{"fontSize":15}');
  w(path.join(L.app('1.0.0'), 'public', 'app.js'), LINES(30, { 3: 'MY TWEAK' }));
  makeRelease(root, '1.1.0', { 'public/app.js': LINES(30, { 10: 'v1.1' }) });
  const v3 = makeRelease(root, '1.2.0', { 'public/app.js': LINES(30, { 10: 'v1.1', 25: 'v1.2' }), 'public/new.js': 'n\n' });
  const rep = await upd.applyUpdate({ home, releaseDir: v3, npmCi: fk.npmCi, selftest: fk.selftest, nodePath: 'C:\\node.exe' });
  assert.strictEqual(rep.status, 'updated');
  assert.deepStrictEqual([rep.from, rep.to], ['1.0.0', '1.2.0'], 'skips 1.1.0');
  const app = r(path.join(L.app('1.2.0'), 'public', 'app.js'));
  assert.ok(app.includes('line 3 MY TWEAK') && app.includes('line 10 v1.1') && app.includes('line 25 v1.2'));
  assert.ok(fs.existsSync(path.join(L.app('1.2.0'), 'public', 'new.js')));
  assert.strictEqual(r(path.join(L.data, 'settings.json')), '{"fontSize":15}');
  assert.ok(fs.existsSync(rep.backup) && /app-1\.0\.0\.zip$/.test(rep.backup));
  assert.ok(fs.existsSync(path.join(L.base('1.2.0'), 'MANIFEST.json')));
  assert.strictEqual(r(path.join(L.app('1.0.0'), 'public', 'app.js')), LINES(30, { 3: 'MY TWEAK' }), 'old dir untouched');
  const m = JSON.parse(r(L.marker));
  assert.deepStrictEqual([m.version, m.previous.version], ['1.2.0', '1.0.0']);
  assert.ok(r(L.launcherVbs).includes(path.join('app', '1.2.0')));
  assert.deepStrictEqual(rep.localMods, ['public/app.js']);
  assert.ok(fs.existsSync(path.join(L.reports, 'last-update.json')));
  // older or same release: up to date
  assert.strictEqual((await upd.applyUpdate({ home, releaseDir: v3, npmCi: fk.npmCi, selftest: fk.selftest })).status, 'up-to-date');
  // manual rollback switches back
  assert.deepStrictEqual(upd.rollback(home, 'C:\\node.exe'), { from: '1.2.0', to: '1.0.0' });
  assert.strictEqual(JSON.parse(r(L.marker)).version, '1.0.0');
});

test('update: conflict keeps local working; failed self-test rolls back with the marker unchanged', async () => {
  const root = tmpdir('cc-inst-');
  const { home, L, fk } = await installed(root, '1.0.0', { 'x.js': 'orig\n' });
  w(path.join(L.app('1.0.0'), 'x.js'), 'mine\n');
  const v2 = makeRelease(root, '2.0.0', { 'x.js': 'theirs\n' });
  const fail = await upd.applyUpdate({ home, releaseDir: v2, npmCi: fk.npmCi, selftest: async () => ({ ok: false, detail: 'api/info: down' }) });
  assert.strictEqual(fail.status, 'rolled-back');
  assert.strictEqual(JSON.parse(r(L.marker)).version, '1.0.0');
  assert.ok(!fs.existsSync(L.app('2.0.0')));
  assert.ok(fs.existsSync(fail.failedBuild));
  const ok = await upd.applyUpdate({ home, releaseDir: v2, npmCi: fk.npmCi, selftest: fk.selftest });
  assert.strictEqual(ok.status, 'updated-with-conflicts');
  assert.strictEqual(r(path.join(L.app('2.0.0'), 'x.js')), 'mine\n');
  assert.ok(fs.existsSync(path.join(L.app('2.0.0'), 'x.js.new')));
});

test('update: a tampered release is refused before anything changes', async () => {
  const root = tmpdir('cc-inst-');
  const { home, L, fk } = await installed(root, '1.0.0');
  const v2 = makeRelease(root, '2.0.0', { 'a.js': 'a\n' });
  w(path.join(v2, 'a.js'), 'evil\n');
  await assert.rejects(upd.applyUpdate({ home, releaseDir: v2, npmCi: fk.npmCi, selftest: fk.selftest }), /fails its manifest/);
  assert.strictEqual(JSON.parse(r(L.marker)).version, '1.0.0');
  assert.ok(!fs.existsSync(L.backups) || fs.readdirSync(L.backups).length === 0);
});

test('install over a legacy console migrates it: code kept as conflicts, data copied, legacy untouched', async () => {
  const root = tmpdir('cc-inst-');
  const legacy = path.join(root, 'Main', 'console');
  w(path.join(legacy, 'package.json'), JSON.stringify({ name: 'claude-console', version: '0.1.0' }) + '\n');
  w(path.join(legacy, 'server', 'server.js'), '// legacy edit\n');
  w(path.join(legacy, 'data', 'layout.json'), '{"tabs":1}');
  w(path.join(legacy, 'node_modules', 'x', 'i.js'), 'dep');
  const src = makeRelease(root, '1.0.0', {});
  const home = path.join(root, 'home');
  const fk = fakes();
  const rep = await install.install({ home, sourceDir: src, prereqs: okPre, npmCi: fk.npmCi, selftest: fk.selftest, makeShortcuts: fk.makeShortcuts, detectOpts: { legacy: [legacy], skipProbe: true } });
  assert.strictEqual(rep.update.kind, 'migrate');
  assert.strictEqual(rep.status, 'updated-with-conflicts');
  const L = paths.layout(home);
  assert.strictEqual(r(path.join(L.app('1.0.0'), 'server', 'server.js')), '// legacy edit\n');
  assert.strictEqual(r(path.join(L.app('1.0.0'), 'server', 'server.js.new')), '// server 1.0.0\n');
  assert.strictEqual(r(path.join(L.data, 'layout.json')), '{"tabs":1}');
  assert.strictEqual(r(path.join(legacy, 'server', 'server.js')), '// legacy edit\n', 'legacy dir untouched');
  assert.strictEqual(JSON.parse(r(L.marker)).previous.path, legacy);
  assert.deepStrictEqual(fk.calls.shortcuts, [L.launcherVbs]);
});

test('repair / fresh / factory: pre-flight, typed confirmations, tweaks kept or re-applied', async () => {
  const root = tmpdir('cc-inst-');
  const { home, L, fk } = await installed(root, '1.0.0', { 'a.js': LINES(20), 'b.js': 'b\n' });
  w(path.join(L.data, 'settings.json'), '{"x":1}');
  w(path.join(L.app('1.0.0'), 'a.js'), LINES(20, { 4: 'TWEAK' }));
  fs.unlinkSync(path.join(L.app('1.0.0'), 'b.js'));
  const pf = repair.preflight({ home });
  assert.deepStrictEqual(pf.tweaks.map((t) => t.rel), ['a.js']);
  assert.deepStrictEqual(pf.absent, ['b.js']);
  assert.strictEqual(pf.confirmPhrase, 'reinstall 1');
  assert.ok(pf.keep.includes('data/settings.json'));
  assert.ok(pf.lose.fresh.includes('a.js (code edit)'));
  assert.ok(pf.lose.factory.includes('data/settings.json (user data)'));
  assert.strictEqual((await repair.reinstall({ home, mode: 'repair', confirm: 'yes' })).status, 'refused');
  const rp = await repair.reinstall({ home, mode: 'repair', confirm: 'reinstall 1', npmCi: fk.npmCi, selftest: fk.selftest, recycle: fk.recycle });
  assert.strictEqual(rp.status, 'repaired');
  assert.deepStrictEqual(rp.restored, ['b.js']);
  assert.ok(r(path.join(L.app('1.0.0'), 'a.js')).includes('TWEAK'), 'repair keeps tweaks');
  assert.ok(fs.existsSync(rp.patch) && r(rp.patch).includes('+line 4 TWEAK'), 'tweaks saved as a patch first');
  // fresh with re-apply onto a newer release
  const v2 = makeRelease(root, '1.1.0', { 'a.js': LINES(20, { 15: 'NEW' }), 'b.js': 'b\n' });
  const fr = await repair.reinstall({ home, mode: 'fresh', confirm: 'reinstall 1', reapply: true, releaseDir: v2, npmCi: fk.npmCi, selftest: fk.selftest, recycle: fk.recycle, nodePath: 'C:\\node.exe' });
  assert.strictEqual(fr.status, 'reinstalled');
  const a = r(path.join(L.app('1.1.0'), 'a.js'));
  assert.ok(a.includes('TWEAK') && a.includes('NEW'), 're-applied with the 3-way merge');
  assert.ok(fk.calls.recycle.includes(L.app('1.0.0')), 'old dir to the Recycle Bin');
  assert.strictEqual(r(path.join(L.data, 'settings.json')), '{"x":1}', 'fresh keeps user data');
  // factory: second confirmation, data reset (backup zip first)
  const pf2 = repair.preflight({ home });
  assert.strictEqual((await repair.reinstall({ home, mode: 'factory', confirm: pf2.confirmPhrase, recycle: fk.recycle })).status, 'refused');
  const fa = await repair.reinstall({ home, mode: 'factory', confirm: pf2.confirmPhrase, factoryConfirm: 'factory reset', npmCi: fk.npmCi, selftest: fk.selftest, recycle: fk.recycle });
  assert.strictEqual(fa.status, 'factory-reset');
  assert.ok(fs.existsSync(fa.dataBackup));
  assert.ok(!fs.existsSync(path.join(L.data, 'settings.json')));
  assert.ok(fs.existsSync(path.join(L.data, 'console.local.json')));
});

test('contribute: scrubbed patch of local mods, issue URL only with a repo, never sent unconfirmed', async () => {
  const root = tmpdir('cc-inst-');
  const { home, L } = await installed(root, '1.0.0', { 'a.js': 'one\n' });
  w(path.join(L.app('1.0.0'), 'a.js'), 'one\n// by someone@example.com at C:\\Users\\Someone\\x and ' + home + ' sk-ant-abcdefghijklmnop\n');
  w(path.join(L.app('1.0.0'), 'added.js'), 'new file\n');
  const p = contribute.makePatch({ home, repo: 'someone/claude-console' });
  const t = r(p.file);
  assert.ok(t.includes('diff --git a/a.js b/a.js') && t.includes('+++ /dev/null') === false);
  assert.ok(t.includes('<EMAIL>') && t.includes('<TOKEN>') && t.includes('<PATH>'));
  assert.ok(!t.includes('someone@example.com') && !t.includes('Someone') && !t.includes(home));
  assert.deepStrictEqual(p.files.map((f) => [f.rel, f.kind]), [['a.js', 'changed'], ['added.js', 'added']]);
  assert.match(p.issueUrl, /^https:\/\/github\.com\/someone\/claude-console\/issues\/new\?title=/);
  assert.strictEqual(contribute.makePatch({ home }).issueUrl, null);
  const calls = [];
  const runFake = (cmd, args) => { calls.push([cmd, ...args]); return { status: 0, stdout: 'https://github.com/x/1\n' }; };
  assert.strictEqual(contribute.send(p, { repo: 'someone/claude-console', run: runFake }).sent, false);
  assert.strictEqual(calls.length, 0);
  const s = contribute.send(p, { confirm: true, repo: 'someone/claude-console', run: runFake });
  assert.strictEqual(s.sent, true);
  assert.deepStrictEqual(calls[1].slice(0, 3), ['gh', 'issue', 'create']);
  assert.strictEqual(contribute.scrub('id 123e4567-e89b-12d3-a456-426614174000 ghp_' + 'a'.repeat(30)), 'id <ID> <TOKEN>');
});

test('CLI: install, status, start, update --from, reinstall pre-flight, release, unknown', async () => {
  const root = tmpdir('cc-inst-');
  const home = path.join(root, 'home');
  const src = makeRelease(root, '1.0.0', {});
  const fk = fakes();
  const lines = [];
  const started = [];
  const deps = { out: (s) => lines.push(s), prereqs: okPre, npmCi: fk.npmCi, selftest: fk.selftest, makeShortcuts: fk.makeShortcuts, nodePath: 'C:\\node.exe', detectOpts: noDetect, startServer: (L, m, open) => { started.push([m.version, open]); return 'x'; } };
  assert.strictEqual(await cli.run(['install', '--home', home, '--source', src], deps), 0);
  assert.ok(lines.some((l) => l === 'install: installed v1.0.0'));
  assert.strictEqual(await cli.run(['status', '--home', home, '--json'], deps), 0);
  assert.strictEqual(JSON.parse(lines[lines.length - 1]).marker.version, '1.0.0');
  assert.strictEqual(await cli.run(['start', '--home', home, '--open'], deps), 0);
  assert.deepStrictEqual(started, [['1.0.0', true]]);
  const v2 = makeRelease(root, '1.0.1', {});
  assert.strictEqual(await cli.run(['update', '--home', home, '--from', v2], deps), 0);
  assert.ok(lines[lines.length - 1].startsWith('release ready'), 'manual update waits for --yes');
  assert.strictEqual(await cli.run(['update', '--home', home, '--from', v2, '--yes'], deps), 0);
  assert.ok(lines.some((l) => l === 'update: updated v1.0.0 -> v1.0.1'));
  assert.strictEqual(await cli.run(['update', '--home', home, '--check'], deps), 0);
  assert.strictEqual(lines[lines.length - 1], 'no check: no-repo');
  assert.strictEqual(await cli.run(['reinstall', '--home', home], deps), 0);
  assert.ok(lines.some((l) => l.startsWith('to go ahead: claude-console reinstall --mode')));
  const out = path.join(root, 'out');
  assert.strictEqual(await cli.run(['release', '--home', home, '--source', v2, '--out', out], deps), 0);
  assert.ok(fs.existsSync(path.join(out, 'claude-console-1.0.1.zip')));
  assert.ok(lines.some((l) => /not uploaded/.test(l)));
  assert.strictEqual(await cli.run(['frobnicate', '--home', home], deps), 2);
  assert.deepStrictEqual(cli.parseArgs(['update', '--yes', '--from', 'd', '--json']), { _: ['update'], yes: true, from: 'd', json: true });
});

test('self-test runner: this checkout answers /api/info with its own version', { timeout: 120000 }, async () => {
  const dir = path.resolve(__dirname, '..');
  const v = require('../package.json').version;
  const res = await upd.runNode([path.join('installer', 'selftest-run.js'), v], dir, 90000);
  assert.strictEqual(res.code, 0, res.out + res.err);
  assert.deepStrictEqual(JSON.parse(res.out.trim().split('\n').pop()), { ok: true, version: v, want: v });
  const bad = await upd.runNode([path.join('installer', 'selftest-run.js'), '9.9.9'], dir, 90000);
  assert.strictEqual(bad.code, 1);
});

test('package: bin entry, exact dependency pins, still private (no publishing yet)', () => {
  const pkg = require('../package.json');
  assert.strictEqual(pkg.bin['claude-console'], 'bin/claude-console.js');
  assert.strictEqual(pkg.private, true);
  for (const [k, v] of Object.entries(pkg.dependencies)) assert.match(v, /^\d+\.\d+\.\d+$/, k + ' pinned exact');
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'bin', 'claude-console.js'), 'utf8').startsWith('#!/usr/bin/env node\n'));
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'installer'))) {
    if (!fs.statSync(path.join(__dirname, '..', 'installer', f)).isFile()) continue; // installer/ps/: profile-adapters.test.js
    const t = fs.readFileSync(path.join(__dirname, '..', 'installer', f), 'utf8');
    assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(t), f + ' ASCII + LF');
  }
});
