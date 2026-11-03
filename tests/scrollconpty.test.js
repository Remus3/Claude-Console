'use strict';
// CON-SCROLL-CONPTY / CON-SCROLL-REPLAY (2026-10-25): scrolling up in a pane showed
// repeated, overwritten and missing lines. Windows 10's inbox ConPTY re-renders its own
// viewport after each resize while xterm.js reflows the same lines; node-pty's bundled
// conpty.dll does not (measured: 8 repeated / 3 missing lines vs 0 / 0). Panes use the
// bundled dll, claude keeps its classic (normal buffer) renderer, a same-size resize is
// not passed on, and the replay ring remembers each pty size.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Pane, PaneManager, useConptyDll, conptyDllPath, windowsPtyFor } = require('../server/panes');
const { buildPaneEnv } = require('../server/claudeenv');

test('bundled conpty.dll: on for win32 when present, off by cfg or elsewhere', () => {
  assert.strictEqual(useConptyDll({}, { platform: 'linux', dllPath: 'x' }), false);
  assert.strictEqual(useConptyDll({}, { platform: 'win32', dllPath: 'x' }), true);
  assert.strictEqual(useConptyDll({ conptyDll: false }, { platform: 'win32', dllPath: 'x' }), false);
  assert.strictEqual(useConptyDll({}, { platform: 'win32', dllPath: null }), false);
  if (os.platform() === 'win32') {
    const d = conptyDllPath();
    assert.ok(d && fs.existsSync(path.join(d, 'conpty.dll')) && fs.existsSync(path.join(d, 'OpenConsole.exe')), 'node-pty ships the dll: ' + d);
  }
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'panes.js'), 'utf8');
  assert.match(src, /const dll = useConptyDll\(this\.mgr\.cfg\);[\s\S]{0,300}useConptyDll: dll,/, 'every pty spawn asks');
});

test('xterm windowsPty hint: dll = 22621 (reflow on), inbox = the real build, none off Windows', () => {
  assert.deepStrictEqual(windowsPtyFor(true, { platform: 'win32', release: '10.0.19045' }), { backend: 'conpty', buildNumber: 22621 });
  assert.deepStrictEqual(windowsPtyFor(false, { platform: 'win32', release: '10.0.19045' }), { backend: 'conpty', buildNumber: 19045 });
  assert.strictEqual(windowsPtyFor(true, { platform: 'linux' }), null);
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /windowsPty: this\.info\.windowsPty \|\| undefined/, 'the page passes it to xterm');
});

test('claude panes keep the classic renderer; shells are left alone', () => {
  const c = buildPaneEnv({}, { kind: 'claude', account: {} });
  assert.strictEqual(c.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, '1');
  const s = buildPaneEnv({}, { kind: 'shell' });
  assert.strictEqual(s.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN, undefined);
});

function pane(maxBytes) {
  const m = new PaneManager({ scrollbackBytes: maxBytes || 100000 }, {});
  clearInterval(m.timer);
  const p = new Pane({ kind: 'shell', cwd: '.', cols: 100, rows: 30 }, m);
  p.maxBytes = maxBytes || 100000;
  const calls = [];
  p.proc = { resize: (c, r) => calls.push([c, r]) };
  p.state = 'busy';
  return { p, calls };
}

test('replay segments follow the pty sizes; same-size resizes are dropped', () => {
  const { p, calls } = pane();
  p.push('a1');
  p.resize(100, 30); // same size: not passed on, no segment
  assert.deepStrictEqual(calls, []);
  p.resize(80, 30);
  p.resize(70, 28); // no output between: one segment at the last size
  p.push('b1');
  p.push('b2');
  p.resize(120, 40);
  assert.deepStrictEqual(calls, [[80, 30], [70, 28], [120, 40]]);
  assert.deepStrictEqual(p.replaySegments(), [
    { cols: 100, rows: 30, d: 'a1' },
    { cols: 70, rows: 28, d: 'b1b2' },
    { cols: 120, rows: 40, d: '' },
  ]);
  assert.strictEqual(p.replay(), 'a1b1b2', 'plain replay still joins the output');
  assert.strictEqual(p.bufBytes, 6, 'markers take no ring bytes');
});

test('trimming the ring keeps the size of what is left', () => {
  const { p } = pane(10);
  p.push('xxxxx');
  p.resize(60, 20);
  p.push('yyyyy');
  p.push('zzzzz'); // trims 'xxxxx' and the marker behind it
  const segs = p.replaySegments();
  assert.deepStrictEqual(segs, [{ cols: 60, rows: 20, d: 'yyyyyzzzzz' }]);
});

test('a resize before any output only moves the head size', () => {
  const { p } = pane();
  p.resize(90, 20);
  p.push('q');
  assert.deepStrictEqual(p.replaySegments(), [{ cols: 90, rows: 20, d: 'q' }]);
});

test('page: replay steps through the segments without resizing the pty, holds live output, finds land in the visible rows', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /this\.term\.onResize\(\(\{ cols, rows \}\) => \{ if \(this\.replaying\) return;/);
  assert.match(src, /if \(this\.replaying\) \{ this\.heldOut\.push\(m\.d\); return; \}/);
  assert.match(src, /doFit\(\) \{\n\s+if \(this\.replaying\) return;/);
  assert.match(src, /revealMatch\(\) \{/);
  assert.match(src, /this\.term\.onData\(\(d\) => \{ if \(this\.replaying\) return;/, 'replayed queries are not answered into the CLI');
  assert.match(src, /'no match'/);
});

test('real bundled conpty: an ended pane (killed or exited by itself) lets node exit', { skip: os.platform() !== 'win32' || !conptyDllPath(), timeout: 60000 }, async () => {
  const { spawnSync } = require('child_process');
  const panes = JSON.stringify(path.join(__dirname, '..', 'server', 'panes.js'));
  const run = (body) => spawnSync(process.execPath, ['-e', `
    const pty = require('node-pty'); const { killPty, releaseDllPty, EXITED } = require(${panes});
    ${body}`], { cwd: path.join(__dirname, '..'), timeout: 20000, windowsHide: true });
  const self = run(`const p = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/q', '/c', 'echo hi'], { cols: 80, rows: 24, useConptyDll: true, env: process.env });
    p.onData(() => {}); p.onExit(() => { EXITED.add(p); releaseDllPty(p, true); });`);
  assert.strictEqual(self.error, undefined, 'self-exited pane: node still held after 20 s');
  const killed = run(`const p = pty.spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/q'], { cols: 80, rows: 24, useConptyDll: true, env: process.env });
    p.onData(() => {}); p.onExit(() => { EXITED.add(p); releaseDllPty(p, true); }); setTimeout(() => killPty(p), 1000);`);
  assert.strictEqual(killed.error, undefined, 'killed pane: node still held after 20 s');
});

test('a tall input box whose upper rule scrolled off the screen is still the live box', () => {
  const C = require('../public/app.js');
  const R = '\u2500'.repeat(50);
  const all = ['old text', R, '\u276f Reply with exactly the word', '  pads the prompt to the length', '  of a real operator message.', R, '  A2 HOME ctx --', '  bypass permissions on'];
  const above = 2; // rule + first box row are in the scrollback
  const ch = C.findChromeLive(all, above);
  assert.ok(ch, 'found');
  assert.deepStrictEqual([ch.start, ch.close, ch.end, ch.rows], [-1, 3, 5, 6]);
  assert.strictEqual(C.inputText(all, ch, above), 'Reply with exactly the word pads the prompt to the length of a real operator message.');
  assert.strictEqual(C.planCrop(ch, 0, 4), 4, 'push it down as far as allowed');
  // a box wholly in the scrollback (a dialog on screen now) is not live
  assert.strictEqual(C.findChromeLive([R, '\u276f x', R, 'status', 'Do you want to proceed?', '1. Yes'], 4), null);
  // on-screen box: same answer as findChrome
  const scr = ['t', R, '\u276f hi', R, '  status'];
  assert.deepStrictEqual(C.findChromeLive(scr, 0), C.findChrome(scr));
});
