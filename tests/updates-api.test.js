'use strict';
// CON-PUBLIC D/E/F: server/updates.js, the backend of Settings > "Updates & repair".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./helpers');
const { createUpdates } = require('../server/updates');
const manifest = require('../installer/manifest');
const install = require('../installer/install');
const release = require('../installer/release');
const paths = require('../installer/paths');

const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const okPre = { ok: true, problems: [], warnings: [], claude: null, edge: null };
const fk = { npmCi: async () => {}, selftest: async () => ({ ok: true }), recycle: async (p) => fs.rmSync(p, { recursive: true, force: true }) };

function rel(root, v, extra) {
  const d = path.join(root, 'src-' + v);
  w(path.join(d, 'package.json'), JSON.stringify({ name: 'claude-console', version: v }));
  w(path.join(d, 'server', 'server.js'), '// ' + v + '\n');
  for (const [k, s] of Object.entries(extra || {})) w(path.join(d, k), s);
  manifest.writeManifest(d, manifest.buildManifest(d, { version: v }));
  return d;
}

test('updates api: checkout mode offers nothing destructive', async () => {
  const root = tmpdir('cc-upd-');
  const u = createUpdates({ cfg: { root: path.join(root, 'Main', 'console') }, home: path.join(root, 'home'), version: '0.1.0' });
  const s = u.state();
  assert.strictEqual(s.mode, 'checkout');
  assert.strictEqual(s.settings.auto, false);
  assert.match((await u.apply()).error, /^checkout/);
  assert.match(u.preflight().error, /^checkout/);
  assert.match((await u.reinstall({ mode: 'repair' })).error, /^checkout/);
  assert.deepStrictEqual(await u.check(), Object.assign({ checked: false, reason: 'no-repo' }, { at: u.state().lastCheck.at }));
});

test('updates api: installed mode checks, applies, pre-flights, repairs only in-process', async () => {
  const root = tmpdir('cc-upd-');
  const home = path.join(root, 'home');
  await install.install({ home, sourceDir: rel(root, '1.0.0', { 'a.js': 'a\n' }), prereqs: okPre, npmCi: fk.npmCi, selftest: fk.selftest, detectOpts: { legacy: [], skipProbe: true } });
  const L = paths.layout(home);
  const b = release.buildRelease(rel(root, '1.1.0', { 'a.js': 'a2\n' }), path.join(root, 'out'), {});
  const zip = fs.readFileSync(b.zip);
  const api = 'https://api.github.com/repos/o/claude-console/releases?per_page=30';
  const zu = 'https://github.com/o/claude-console/releases/download/v1.1.0/claude-console-1.1.0.zip';
  const fetch = async (url) => {
    if (url === api) return { status: 200, headers: { get: () => '"t"' }, json: async () => [{ tag_name: 'v1.1.0', assets: [{ name: 'claude-console-1.1.0.zip', browser_download_url: zu }, { name: 'claude-console-1.1.0.zip.sha256', browser_download_url: zu + '.sha256' }] }] };
    if (url === zu) return { status: 200, arrayBuffer: async () => zip };
    if (url === zu + '.sha256') return { status: 200, arrayBuffer: async () => Buffer.from(b.sha256) };
    return { status: 404 };
  };
  const cfg = { root: L.app('1.0.0'), updates: { repo: 'o/claude-console' } };
  const u = createUpdates({ cfg, home, version: '1.0.0', deps: Object.assign({ fetch }, fk), panes: () => [{ state: 'busy' }] });
  assert.strictEqual(u.state().mode, 'installed');
  assert.strictEqual(u.state().installed.version, '1.0.0');
  const c = await u.check();
  assert.strictEqual(c.available, true);
  assert.strictEqual(c.latest.version, '1.1.0');
  const pf = u.preflight();
  assert.strictEqual(pf.confirmPhrase, 'reinstall 0');
  assert.match((await u.reinstall({ mode: 'fresh' })).error, /quit the console/);
  assert.strictEqual((await u.reinstall({ mode: 'repair', confirm: 'nope' })).status, 'refused');
  assert.strictEqual((await u.reinstall({ mode: 'repair', confirm: 'reinstall 0' })).status, 'repaired');
  const r = await u.apply();
  assert.strictEqual(r.status, 'updated');
  assert.strictEqual(r.restartNeeded, true);
  assert.strictEqual(r.panesBusy, 1, 'never restarts itself; reports busy panes');
  assert.strictEqual(JSON.parse(fs.readFileSync(L.marker, 'utf8')).version, '1.1.0');
  assert.strictEqual(u.state().lastUpdate.to, '1.1.0');
  assert.strictEqual(u.state().auto, null, 'no auto-update tick yet');
  w(path.join(L.cache, 'autoupdate.json'), JSON.stringify({ lastTick: 't', check: { available: true, latest: { version: '1.2.0', zipUrl: 'https://x' } }, review: { version: '1.2.0', conflicts: ['a.js'], prompt: 'C:\\secret\\p.md' }, pendingRestart: null }));
  const au = u.state().auto;
  assert.deepStrictEqual([au.available, au.review.conflicts], ['1.2.0', ['a.js']]);
  assert.ok(!JSON.stringify(au).includes('secret'), 'no local paths in the state answer');
  const p = u.makePatch();
  assert.strictEqual(p.count, 0);
  assert.ok(!path.isAbsolute(p.file), 'no local path in the API answer');
});

test('updates api: settings save merges known keys into data/console.local.json', () => {
  const root = tmpdir('cc-upd-');
  const dataDir = path.join(root, 'data');
  w(path.join(dataDir, 'console.local.json'), JSON.stringify({ port: 7801, updates: { repo: 'o/r' } }));
  const cfg = { root, dataDir, updates: { repo: 'o/r' } };
  const u = createUpdates({ cfg, home: path.join(root, 'home') });
  const s = u.saveSettings({ auto: true, channel: 'beta', window: '01:00-02:00', repo: 'evil/x', reintegrate: { enabled: true, command: ['x'] } });
  assert.deepStrictEqual([s.auto, s.channel, s.window, s.repo, s.reintegrate.enabled], [true, 'beta', '01:00-02:00', 'o/r', false]);
  const f = JSON.parse(fs.readFileSync(path.join(dataDir, 'console.local.json'), 'utf8'));
  assert.strictEqual(f.port, 7801, 'other keys kept');
  assert.strictEqual(f.updates.repo, 'o/r');
  assert.strictEqual(f.updates.auto, true);
  assert.strictEqual(u.saveSettings({ window: 'garbage' }).window, '04:00-05:00');
});
