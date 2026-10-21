'use strict';
// CON-CLEAR-MODE + CON-CLEAR-NORESUME (ACCEPT lines in the branch roadmap
// doc). Settings "After /clear": refresh (default, rows restart) or reopen
// (the server restarts the claude process fresh in the same pane). A pane whose newest
// event is a /clear has nothing to continue: no reopen chip, no Resume button, and a
// saved layout entry in that state makes no chip after a server restart.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Pane, PaneManager } = require('../server/panes');
const { sanitizeClearMode, sanitizeUiPrefs, UI_DEFAULTS, CLEAR_MODES } = require('../server/uiprefs');
const PL = require('../public/app.js').Place;

const SID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const SID2 = '1' + SID.slice(1); // a second session id (built, not a literal)

function rig(mode) {
  const m = new PaneManager({ cfg: {} });
  clearInterval(m.timer);
  const p = new Pane({ id: 'abcd1234', kind: 'claude', cwd: '.' }, m);
  p.state = 'waiting';
  p.secret = 's3cret';
  m.panes.set(p.id, p);
  m.refreshDone = () => {};
  m.clearMode = () => mode;
  m.clearReopenDelayMs = 5;
  const calls = [];
  m.restart = (id, opts) => { calls.push({ id, opts }); return p; };
  return { m, p, calls };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('clearMode: default refresh, only refresh / reopen survive sanitizing', () => {
  assert.deepStrictEqual(CLEAR_MODES, ['refresh', 'reopen']);
  assert.strictEqual(UI_DEFAULTS.clearMode, 'refresh');
  assert.strictEqual(sanitizeClearMode('reopen'), 'reopen');
  for (const v of [undefined, null, '', 'REOPEN', 'close', 1, {}]) assert.strictEqual(sanitizeClearMode(v), 'refresh');
  assert.strictEqual(sanitizeUiPrefs({ clearMode: 'bogus' }).clearMode, 'refresh');
});

test('clearedLast: true after a /clear, false after a later prompt or a process start', () => {
  const p = new Pane({ id: 'abcd1234', kind: 'claude', cwd: '.' }, { cfg: {} });
  p.state = 'waiting';
  assert.strictEqual(p.info().clearedLast, false, 'never cleared');
  p.hook('ready', null, SID, null, 'clear');
  assert.strictEqual(p.info().clearedLast, true);
  p.hookAt = Date.now() + 5;
  p.hook('busy', null, SID, null, null);
  // the busy hook stamps its own hookAt; force a strictly later prompt time for the check
  p.clearAt = p.clearedAt + 1;
  assert.strictEqual(p.info().clearedLast, false, 'a prompt after the clear');
  p.hook('ready', null, SID, null, 'clear');
  assert.strictEqual(p.info().clearedLast, true);
  p.clearAt = p.clearedAt + 1; // what start() does (clearAt = now)
  assert.strictEqual(p.info().clearedLast, false, 'a restarted process');
});

test('refresh mode: a /clear hook never restarts the pane', async () => {
  const { m, calls } = rig('refresh');
  assert.strictEqual(m.hook('abcd1234', 's3cret', 'ready', null, SID, null, 'clear'), true);
  await wait(30);
  assert.strictEqual(calls.length, 0);
});

test('reopen mode: a /clear hook restarts the pane once, fresh and wiped', async () => {
  const { m, p, calls } = rig('reopen');
  m.hook('abcd1234', 's3cret', 'ready', null, SID, null, 'startup');
  m.hook('abcd1234', 's3cret', 'ready', null, SID, null, 'resume');
  m.hook('abcd1234', 's3cret', 'ready', null, SID, null, 'compact');
  await wait(30);
  assert.strictEqual(calls.length, 0, 'startup / resume / compact never reopen');
  m.hook('abcd1234', 's3cret', 'ready', null, SID2, null, 'clear');
  await wait(30);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], { id: 'abcd1234', opts: { fresh: true, wipe: true } });
  assert.strictEqual(p.info().clearReopens, 1);
});

test('reopen mode: skipped when the pane was prompted, closed or exited before the delay', async () => {
  let r = rig('reopen');
  r.m.clearReopenDelayMs = 20;
  r.m.hook('abcd1234', 's3cret', 'ready', null, SID, null, 'clear');
  r.p.clearAt = r.p.clearedAt + 1; // operator typed right after the clear
  await wait(50);
  assert.strictEqual(r.calls.length, 0, 'prompted');
  r = rig('reopen');
  r.m.clearReopenDelayMs = 20;
  r.m.hook('abcd1234', 's3cret', 'ready', null, SID, null, 'clear');
  r.m.panes.delete('abcd1234');
  await wait(50);
  assert.strictEqual(r.calls.length, 0, 'closed');
  r = rig('reopen');
  r.m.clearReopenDelayMs = 20;
  r.m.hook('abcd1234', 's3cret', 'ready', null, SID, null, 'clear');
  r.p.state = 'exited';
  await wait(50);
  assert.strictEqual(r.calls.length, 0, 'exited');
});

test('reopen mode: a shell pane and a bad secret never restart; a throwing getter reads refresh', async () => {
  const r = rig('reopen');
  r.p.kind = 'shell';
  r.m.hook('abcd1234', 's3cret', 'ready', null, SID, null, 'clear');
  r.p.kind = 'claude';
  r.m.hook('abcd1234', 'wrong!', 'ready', null, SID, null, 'clear');
  r.m.clearMode = () => { throw new Error('settings unreadable'); };
  r.m.hook('abcd1234', 's3cret', 'ready', null, SID, null, 'clear');
  await wait(30);
  assert.strictEqual(r.calls.length, 0);
});

test('restart({fresh, wipe}): no --resume, buffer dropped, screen + scrollback cleared', () => {
  const m = new PaneManager({ cfg: {} });
  clearInterval(m.timer);
  const p = new Pane({ id: 'abcd1234', kind: 'claude', cwd: '.' }, m);
  p.sessionId = SID;
  p.req = { kind: 'claude' };
  p.push('old screen');
  m.panes.set(p.id, p);
  let built = null;
  m.buildSpec = (req) => { built = req; return { file: 'x', args: [], sessionId: SID2 }; };
  p.start = () => {};
  p.kill = () => {};
  const data = [];
  p.on('data', (d) => data.push(d));
  m.restart(p.id, { resume: true, fresh: true, wipe: true });
  assert.strictEqual(built.resume, null, 'fresh wins over resume');
  assert.strictEqual(p.sessionId, SID2);
  assert.strictEqual(p.replay(), '\x1b[2J\x1b[3J\x1b[H');
  assert.deepStrictEqual(data, ['\x1b[2J\x1b[3J\x1b[H']);
});

test('client: a cleared-last claude pane is not resumable and leaves no chip', () => {
  const live = { kind: 'claude', sessionId: SID, clearedLast: false };
  const cleared = { kind: 'claude', sessionId: SID, clearedLast: true };
  assert.strictEqual(PL.resumable(live), true);
  assert.strictEqual(PL.resumable(cleared), false);
  assert.strictEqual(PL.resumable({ kind: 'shell' }), false);
  assert.strictEqual(PL.keepDormant(live), true);
  assert.strictEqual(PL.keepDormant(cleared), false);
  assert.strictEqual(PL.keepDormant({ kind: 'shell', clearedLast: true }), true, 'shells are unaffected');
  const entries = [{ id: 'a', kind: 'claude' }, { id: 'b', kind: 'claude', clearedLast: true }, { id: 'c', kind: 'shell' }, { id: 'd' }, { id: 'e', kind: 'claude' }];
  assert.deepStrictEqual(PL.dormantFrom(entries, new Set(['e']), 12).map((e) => e.id), ['a', 'c']);
});

test('app.js wires the helpers and the Settings choice; the server hands Settings to the panes', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /if \(PL\.keepDormant\(v\.info\)\)/);
  assert.match(app, /dormant = PL\.dormantFrom\(layout\.panes, liveIds, 12\)/);
  assert.match(app, /this\.resumeBtn\.style\.display = PL\.resumable\(p\)/);
  assert.match(app, /clearMode: f\.clearMode\.value === 'reopen'/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<select name="clearMode" id="set-clear-mode"><option value="refresh">/);
  const srv = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  assert.match(srv, /panes\.clearMode = \(\) => settings\(\)\.clearMode/);
});
