'use strict';
// CON-SHIP-SETUP: the console ships its Claude commands + settings; setup shows a plan
// and writes only on an explicit confirmation. Never the real ~/.claude*: every test
// passes a scratch config dir.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./helpers');
const setup = require('../installer/setup');
const cli = require('../installer/cli');

const ROOT = path.resolve(__dirname, '..');
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
const r = (p) => fs.readFileSync(p, 'utf8');
const NODE = 'C:\\Program Files\\nodejs\\node.exe';

test('shipped files: setup.json items point at real ASCII files', () => {
  const spec = setup.loadSpec(ROOT);
  assert.deepStrictEqual(spec.items.map((i) => i.id), ['cmd-done', 'statusline', 'pane-hooks']);
  for (const it of spec.items.filter((i) => i.src)) {
    const t = r(path.join(ROOT, ...it.src.split('/')));
    assert.ok(/^[\x0a\x20-\x7e]*$/.test(t), it.src + ' ASCII + LF');
  }
  assert.ok(/^[\x0a\x20-\x7e]*$/.test(r(path.join(ROOT, 'claude', 'first-run.md'))));
});

test('config dir: CLAUDE_CONFIG_DIR first, else ~/.claude', () => {
  assert.strictEqual(setup.configDirFor({ CLAUDE_CONFIG_DIR: 'C:\\acct2' }, 'C:\\Users\\u'), 'C:\\acct2');
  assert.strictEqual(setup.configDirFor({}, 'C:\\Users\\u'), path.join('C:\\Users\\u', '.claude'));
});

test('plan on an empty config dir: defaults selected, nothing written', () => {
  const cd = path.join(tmpdir('cc-setup-'), '.claude');
  const p = setup.planSetup({ consoleRoot: ROOT, configDir: cd, nodePath: NODE });
  const by = Object.fromEntries(p.actions.map((a) => [a.id, a]));
  assert.deepStrictEqual([by['cmd-done'].status, by['cmd-done'].selected], ['new', true]);
  assert.strictEqual(by['cmd-done'].target, path.join(cd, 'commands', 'done.md'));
  assert.deepStrictEqual([by.statusline.status, by.statusline.selected], ['new', false], 'statusline is opt-in');
  assert.deepStrictEqual(by.statusline.add, { statusLine: { type: 'command', command: '"C:/Program Files/nodejs/node.exe" "' + ROOT.replace(/\\/g, '/') + '/statusline/statusline.js"' } });
  assert.strictEqual(by['pane-hooks'].status, 'runtime');
  assert.ok(!fs.existsSync(cd), 'planning writes nothing');
});

test('apply: refused without confirm; writes the selection; second plan is all same', () => {
  const cd = path.join(tmpdir('cc-setup-'), '.claude');
  w(path.join(cd, 'settings.json'), JSON.stringify({ model: 'opus', hooks: { Stop: [] } }, null, 2));
  const p = setup.planSetup({ consoleRoot: ROOT, configDir: cd, nodePath: NODE, only: ['cmd-done', 'statusline'] });
  assert.throws(() => setup.applySetup(p, {}), /confirm/);
  assert.ok(!fs.existsSync(path.join(cd, 'commands')));
  const res = setup.applySetup(p, { confirm: true });
  assert.deepStrictEqual(res.written.map((x) => x.id), ['cmd-done', 'statusline']);
  assert.strictEqual(r(path.join(cd, 'commands', 'done.md')), r(path.join(ROOT, 'claude', 'commands', 'done.md')));
  const s = JSON.parse(r(path.join(cd, 'settings.json')));
  assert.strictEqual(s.model, 'opus', 'other keys kept');
  assert.deepStrictEqual(s.hooks, { Stop: [] });
  assert.ok(s.statusLine.command.includes('statusline.js'));
  assert.ok(res.backups.length === 1 && fs.existsSync(res.backups[0]), 'settings.json backed up before the change');
  const again = setup.planSetup({ consoleRoot: ROOT, configDir: cd, nodePath: NODE, only: ['cmd-done', 'statusline'] });
  assert.deepStrictEqual(again.actions.filter((a) => a.kind !== 'runtime').map((a) => a.status), ['same', 'same']);
  assert.deepStrictEqual(setup.applySetup(again, { confirm: true }).written, []);
});

test('existing user files are never replaced unless asked, and then backed up', () => {
  const cd = path.join(tmpdir('cc-setup-'), '.claude');
  w(path.join(cd, 'commands', 'done.md'), 'my own done\n');
  w(path.join(cd, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }));
  const p = setup.planSetup({ consoleRoot: ROOT, configDir: cd, nodePath: NODE, only: ['cmd-done', 'statusline'] });
  assert.deepStrictEqual(p.actions.filter((a) => a.kind !== 'runtime').map((a) => [a.status, a.selected]), [['differs', false], ['conflict', false]]);
  assert.deepStrictEqual(setup.applySetup(p, { confirm: true }).written, []);
  assert.strictEqual(r(path.join(cd, 'commands', 'done.md')), 'my own done\n');
  const forced = setup.planSetup({ consoleRoot: ROOT, configDir: cd, nodePath: NODE, only: ['cmd-done', 'statusline'], force: true, replace: true });
  const res = setup.applySetup(forced, { confirm: true });
  assert.strictEqual(res.written.length, 2);
  assert.strictEqual(res.backups.length, 2);
  assert.ok(res.backups.some((b) => r(b) === 'my own done\n'));
  assert.ok(JSON.parse(r(path.join(cd, 'settings.json'))).statusLine.command.includes('statusline.js'));
});

test('an unreadable settings.json is never written, even with replace', () => {
  const cd = path.join(tmpdir('cc-setup-'), '.claude');
  w(path.join(cd, 'settings.json'), '{ broken');
  const p = setup.planSetup({ consoleRoot: ROOT, configDir: cd, nodePath: NODE, only: ['statusline'], replace: true });
  const a = p.actions.find((x) => x.id === 'statusline');
  assert.deepStrictEqual([a.status, a.selected], ['unreadable', false]);
  setup.applySetup(p, { confirm: true });
  assert.strictEqual(r(path.join(cd, 'settings.json')), '{ broken');
});

test('installed console: status line goes through the home shim that every update rewrites', async () => {
  const manifest = require('../installer/manifest');
  const paths = require('../installer/paths');
  const root = tmpdir('cc-setup-');
  const src = path.join(root, 'rel');
  w(path.join(src, 'package.json'), JSON.stringify({ name: 'claude-console', version: '1.0.0' }));
  w(path.join(src, 'server', 'server.js'), '//');
  w(path.join(src, 'statusline', 'statusline.js'), '//');
  fs.cpSync(path.join(ROOT, 'claude'), path.join(src, 'claude'), { recursive: true });
  manifest.writeManifest(src, manifest.buildManifest(src, { version: '1.0.0' }));
  const home = path.join(root, 'home');
  const cd = path.join(root, '.claude');
  const lines = [];
  const deps = { out: (s) => lines.push(s), prereqs: { ok: true, problems: [], warnings: [] }, npmCi: async () => {}, selftest: async () => ({ ok: true }), nodePath: NODE, detectOpts: { legacy: [], skipProbe: true } };
  assert.strictEqual(await cli.run(['install', '--home', home, '--source', src, '--no-shortcuts', '--setup', '--config-dir', cd], deps), 0);
  assert.ok(lines.some((l) => /^new +cmd-done \[will apply\]/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => l.includes(path.join(home, 'statusline.js').replace(/\\/g, '/'))), 'plan names the shim');
  assert.ok(!fs.existsSync(cd), 'install never writes the Claude config');
  const L = paths.layout(home);
  assert.strictEqual(setup.statuslineFor(L, L.app('1.0.0')), path.join(home, 'statusline.js'));
  assert.strictEqual(setup.statuslineFor(L, ROOT), null);
  assert.ok(r(path.join(home, 'statusline.js')).includes(JSON.stringify(path.join(L.app('1.0.0'), 'statusline', 'statusline.js'))));
});

test('CLI setup: plan by default, --apply needs --yes; install --setup shows the plan', async () => {
  const root = tmpdir('cc-setup-');
  const cd = path.join(root, '.claude');
  const lines = [];
  const deps = { out: (s) => lines.push(s), nodePath: NODE, consoleRoot: ROOT };
  assert.strictEqual(await cli.run(['setup', '--home', path.join(root, 'h'), '--config-dir', cd], deps), 0);
  assert.ok(lines.some((l) => /^new +cmd-done/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => /claude-console setup --apply --yes/.test(l)));
  assert.ok(!fs.existsSync(cd));
  assert.strictEqual(await cli.run(['setup', '--home', path.join(root, 'h'), '--config-dir', cd, '--apply'], deps), 1);
  assert.ok(!fs.existsSync(cd));
  assert.strictEqual(await cli.run(['setup', '--home', path.join(root, 'h'), '--config-dir', cd, '--apply', '--yes', '--only', 'cmd-done', '--json'], deps), 0);
  const j = JSON.parse(lines[lines.length - 1]);
  assert.deepStrictEqual(j.written.map((x) => x.id), ['cmd-done']);
  assert.ok(fs.existsSync(path.join(cd, 'commands', 'done.md')));
});
