'use strict';
// CON-ATTENTION-PANEL (UI/UX round 2, 2026-10-31): one list of the panes that need you
// (permission prompt, hook state attention) or wait unread after a turn (waiting +
// unseen), needs-you first then oldest first, read from the existing hook states only;
// Ctrl+Alt+U jumps to the newest unread pane. CON-OSC-PROGRESS: @xterm/addon-progress
// per pane plus terminalProgressBarEnabled in the additive pane settings; the hook state
// stays the authority (the bar shows only while the pane is busy).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const C = require('../public/app.js');
const { Pane } = require('../server/panes');
const { hookSettings } = require('../server/claudeenv');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const A = C.Attn;
const P = C.Prog;

const pn = (id, state, unseen, stateAt, extra) => Object.assign({ id, title: 't' + id, kind: 'claude', state, unseen, stateAt }, extra || {});

test('attention list: needs-you and unread waiting only, needs-you first, oldest first', () => {
  const panes = [
    pn('a', 'waiting', true, 300),
    pn('b', 'attention', false, 500),
    pn('c', 'busy', true, 100),
    pn('d', 'waiting', false, 50),
    pn('e', 'attention', true, 200),
    pn('f', 'exited', true, 10),
    pn('g', 'waiting', true, 100),
  ];
  const l = A.list(panes);
  assert.deepStrictEqual(l.map((x) => x.id), ['e', 'b', 'g', 'a']);
  assert.deepStrictEqual(l.map((x) => x.kind), ['needs', 'needs', 'waiting', 'waiting']);
  assert.strictEqual(l[0].unseen, true);
  assert.strictEqual(l[1].unseen, false);
});

test('attention list: a pane without stateAt falls back to startedAt, then 0; a log pane is never listed', () => {
  const l = A.list([pn('x', 'waiting', true, undefined, { startedAt: 40 }), pn('y', 'waiting', true, undefined), pn('z', 'attention', true, 1, { kind: 'log' })]);
  assert.deepStrictEqual(l.map((x) => [x.id, x.since]), [['y', 0], ['x', 40]]);
});

test('newest unread: the unseen listed pane with the latest stateAt; null when none', () => {
  const panes = [pn('a', 'waiting', true, 300), pn('b', 'attention', true, 900), pn('c', 'attention', false, 950), pn('d', 'busy', true, 999)];
  assert.strictEqual(A.newestUnread(panes), 'b');
  assert.strictEqual(A.newestUnread([pn('c', 'attention', false, 950)]), null);
  assert.strictEqual(A.newestUnread([]), null);
});

test('attention row text: glyph, title, word, whole-minute age; ASCII only', () => {
  const now = 10 * 60000;
  assert.strictEqual(A.rowText({ title: 'HOME', kind: 'needs', since: now - 3 * 60000 }, now), '? HOME - needs you - 3m');
  assert.strictEqual(A.rowText({ title: 'SA', kind: 'waiting', since: now - 20000 }, now), '- SA - waiting - <1m');
  assert.strictEqual(A.rowText({ title: 'X', kind: 'waiting', since: 1000 }, 1000 + 125 * 60000), '- X - waiting - 2h5m');
  assert.strictEqual(A.rowText({ title: 'Y', kind: 'waiting', since: 0 }, now), '- Y - waiting');
  assert.strictEqual(A.buttonText(0), '? 0');
  assert.strictEqual(A.buttonText(3), '? 3');
});

test('hotkey: Ctrl+Alt+U, no Shift', () => {
  assert.strictEqual(A.isJumpKey({ ctrlKey: true, altKey: true, shiftKey: false, key: 'u' }), true);
  assert.strictEqual(A.isJumpKey({ ctrlKey: true, altKey: true, shiftKey: false, key: 'U' }), true);
  assert.strictEqual(A.isJumpKey({ ctrlKey: true, altKey: false, shiftKey: false, key: 'u' }), false);
  assert.strictEqual(A.isJumpKey({ ctrlKey: true, altKey: true, shiftKey: true, key: 'U' }), false);
});

test('server: stateAt moves on a state change only and is in info()', () => {
  const p = new Pane({ id: 'abcd1234', kind: 'claude', cwd: '.' }, { cfg: {} });
  assert.strictEqual(p.info().stateAt, p.startedAt);
  p.setState('waiting', false);
  const t1 = p.info().stateAt;
  assert.ok(t1 >= p.startedAt);
  p.stateAt = 5;
  p.setState('waiting', true); // same state, newly unseen: still the same stretch
  assert.strictEqual(p.info().stateAt, 5);
  p.hook('attention', 'Claude needs your permission to use Bash');
  assert.ok(p.info().stateAt > 5);
  assert.strictEqual(p.info().state, 'attention');
});

test('index.html: attention button + list in the top bar, progress addon loaded after xterm', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.match(html, /id="btn-attn"[^>]*aria-controls="attn-list"/);
  assert.match(html, /id="attn-list"[^>]*role="menu"/);
  assert.match(html, /Ctrl\+Alt\+U/);
  const ix = html.indexOf('/vendor/xterm.js');
  const ip = html.indexOf('/vendor/addon-progress.js');
  assert.ok(ix > 0 && ip > ix && ip < html.indexOf('/app.js'));
});

test('app.js: the terminal key handler lets Ctrl+Alt+U through to the window handler', () => {
  const src = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  assert.match(src, /if \(AT\.isJumpKey\(e\)\) return false;/);
  assert.match(src, /new window\.ProgressAddon\.ProgressAddon\(\)/);
});

test('OSC progress: terminalProgressBarEnabled in the additive pane settings, hooks unchanged', () => {
  const h = hookSettings('C:\\node.exe', 'C:\\hook.js');
  assert.strictEqual(h.terminalProgressBarEnabled, true);
  assert.deepStrictEqual(Object.keys(h).sort(), ['hooks', 'terminalProgressBarEnabled']);
});

test('OSC progress view: hook state is the authority; shown only while busy', () => {
  assert.deepStrictEqual(P.view({ state: 3, value: 0 }, 'busy'), { show: true, cls: 'pbar ind', pct: null, title: 'generating' });
  assert.deepStrictEqual(P.view({ state: 1, value: 42 }, 'busy'), { show: true, cls: 'pbar pct', pct: 42, title: 'generating 42%' });
  assert.deepStrictEqual(P.view({ state: 2, value: 10 }, 'busy'), { show: true, cls: 'pbar err', pct: 10, title: 'error 10%' });
  assert.deepStrictEqual(P.view({ state: 4, value: 0 }, 'busy'), { show: true, cls: 'pbar warn', pct: 0, title: 'paused 0%' });
  assert.strictEqual(P.view({ state: 3, value: 0 }, 'waiting').show, false);
  assert.strictEqual(P.view({ state: 3, value: 0 }, 'attention').show, false);
  assert.strictEqual(P.view({ state: 0, value: 0 }, 'busy').show, false);
  assert.strictEqual(P.view(null, 'busy').show, false);
  assert.strictEqual(P.view({ state: 1, value: 250 }, 'busy').pct, 100);
});

test('OSC progress: addon pinned exact, MIT, served from /vendor', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.dependencies['@xterm/addon-progress'], /^\d+\.\d+\.\d+$/);
  const lic = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@xterm', 'addon-progress', 'package.json'), 'utf8')).license;
  assert.strictEqual(lic, 'MIT');
  const srv = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
  assert.match(srv, /'addon-progress\.js': path\.join\(NM, '@xterm', 'addon-progress', 'lib', 'addon-progress\.js'\)/);
});

// CON-WEBGL-MEASURE (2026-10-31, docs/research/2026-10-31-con-webgl-measure.json): 8 busy
// panes, 3 alternating rounds: frame time equal (4.2 ms mean both), page main-thread task
// time 129 -> 60 ms/s, Edge CPU 20.1 -> 13.8 percent of one core. Adopted on visible panes
// only, at most 16 WebGL contexts, DOM fallback when a context is lost or cannot start.
const G = C.Gl;

test('WebGL plan: visible panes in grid order up to the cap; hidden and failed panes stay DOM', () => {
  const panes = [
    { id: 'a', visible: true }, { id: 'b', visible: false }, { id: 'c', visible: true, failed: true },
    { id: 'd', visible: true }, { id: 'e', visible: true },
  ];
  assert.deepStrictEqual([...G.plan(panes, 2)], ['a', 'd']);
  assert.deepStrictEqual([...G.plan(panes)], ['a', 'd', 'e']);
  assert.strictEqual(G.CAP, 16);
  const many = Array.from({ length: 20 }, (_, i) => ({ id: 'p' + i, visible: true }));
  assert.strictEqual(G.plan(many).size, 16);
});

test('WebGL: addon pinned exact, MIT, served from /vendor and loaded after xterm', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.dependencies['@xterm/addon-webgl'], /^\d+\.\d+\.\d+$/);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@xterm', 'addon-webgl', 'package.json'), 'utf8')).license, 'MIT');
  const srv = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
  assert.match(srv, /'addon-webgl\.js': path\.join\(NM, '@xterm', 'addon-webgl', 'lib', 'addon-webgl\.js'\)/);
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const ix = html.indexOf('/vendor/xterm.js');
  const ig = html.indexOf('/vendor/addon-webgl.js');
  assert.ok(ix > 0 && ig > ix && ig < html.indexOf('/app.js'));
  const src = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  assert.match(src, /onContextLoss\(/);
  assert.match(src, /syncGl\(vis\)/);
});
