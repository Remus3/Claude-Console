'use strict';
// /done band (UI/UX standard sections 2 and 4): status.js readDoneMarker (rules 1, 3)
// and panes.js Pane.doneFor (rules 2, 4 + the DONE tab title).
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const S = require('../server/status');
const { Pane } = require('../server/panes');
const { tmpdir, gitInit } = require('./helpers');

const git = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { windowsHide: true, encoding: 'utf8' }).trim();

function tree() {
  const dir = tmpdir('cc-done-');
  gitInit(dir);
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'XX-NEXT-SESSION.txt'), 'SESSION: 6\nnext\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'one');
  return dir;
}

function mark(dir, over) {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'XX-NEXT-SESSION.txt'))).digest('hex');
  const doc = Object.assign({
    schema: 1, tree: 'XX', session: 6, session_id: '11111111-2222-3333-4444-555555555555', pane: 'abcd1234',
    status: 'done', safe_to_clear: true, reason: null, commit: git(dir, 'rev-parse', 'HEAD'),
    handoff: 'XX-NEXT-SESSION.txt', handoff_sha256: sha, background_tasks: 0,
    at: new Date(Date.now() - 5000).toISOString().replace(/\.\d+Z$/, 'Z'), next_session: 7,
  }, over || {});
  const f = path.join(dir, 'ops', 'loop', 'control', 'session_done.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(doc));
  return doc;
}

test('readHead: loose ref and packed ref match git rev-parse', () => {
  const dir = tree();
  assert.strictEqual(S.readHead(dir), git(dir, 'rev-parse', 'HEAD'));
  git(dir, 'pack-refs', '--all');
  assert.strictEqual(S.readHead(dir), git(dir, 'rev-parse', 'HEAD'));
  assert.strictEqual(S.readHead(path.join(dir, 'nope')), null);
});

test('readDoneMarker: a valid done marker reads back; no marker reads null', () => {
  const dir = tree();
  assert.strictEqual(S.readDoneMarker({ dir }), null);
  mark(dir);
  const m = S.readDoneMarker({ dir });
  assert.strictEqual(m.verdict, 'DONE');
  assert.strictEqual(m.session, 6);
  assert.strictEqual(m.pane, 'abcd1234');
});

test('readDoneMarker rule 1: done but not safe to clear shows nothing; failed reads FAIL', () => {
  const dir = tree();
  mark(dir, { safe_to_clear: false, background_tasks: 2 });
  assert.strictEqual(S.readDoneMarker({ dir }), null);
  mark(dir, { status: 'failed', safe_to_clear: false, reason: 'suite red' });
  const m = S.readDoneMarker({ dir });
  assert.strictEqual(m.verdict, 'FAIL');
  assert.strictEqual(m.reason, 'suite red');
});

test('readDoneMarker rule 3: HEAD moved after /done', () => {
  const dir = tree();
  mark(dir);
  fs.writeFileSync(path.join(dir, 'later.txt'), 'x');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'two');
  assert.strictEqual(S.readDoneMarker({ dir }), null);
});

test('readDoneMarker rule 3: hand-off edited after /done (stale hash)', () => {
  const dir = tree();
  mark(dir);
  assert.ok(S.readDoneMarker({ dir }));
  fs.writeFileSync(path.join(dir, 'XX-NEXT-SESSION.txt'), 'SESSION: 6\nedited\n');
  assert.strictEqual(S.readDoneMarker({ dir }), null);
});

test('readDoneMarker: bad schema, bad hand-off name and broken JSON show nothing', () => {
  const dir = tree();
  mark(dir, { schema: 2 });
  assert.strictEqual(S.readDoneMarker({ dir }), null);
  mark(dir, { handoff: '../XX-NEXT-SESSION.txt' });
  assert.strictEqual(S.readDoneMarker({ dir }), null);
  fs.writeFileSync(path.join(dir, 'ops', 'loop', 'control', 'session_done.json'), '{');
  assert.strictEqual(S.readDoneMarker({ dir }), null);
});

// ---- pane side ----
function pane(id) {
  const p = new Pane({ id: id || 'abcd1234', kind: 'claude', cwd: '.', sessionId: '99999999-2222-3333-4444-555555555555' }, { cfg: {} });
  p.state = 'waiting';
  return p;
}
const AT = Date.now() - 10000;
const marker = (over) => Object.assign({ verdict: 'DONE', session: 6, reason: null, at: AT, pane: 'abcd1234', sessionId: null }, over || {});
const osc = (t) => '\x1b]0;' + t + '\x07';

function donePane() {
  const p = pane();
  p.clearAt = AT - 60000; // the /done prompt itself
  p.stopAt = AT + 2000;
  p.scanTitle(osc('XX DONE S6 - safe to clear') + '\x1b]9;XX DONE S6 - safe to clear\x07');
  return p;
}

test('pane: bound, Stop after the marker and the DONE title -> band', () => {
  const p = donePane();
  assert.deepStrictEqual(p.doneFor(marker()), { kind: 'done', session: 6, reason: null });
});

test('pane rule 2: wrong pane shows nothing; the hook-reported session id binds too', () => {
  const p = donePane();
  assert.strictEqual(p.doneFor(marker({ pane: 'ffff0000' })), null);
  assert.ok(p.doneFor(marker({ pane: 'ffff0000', sessionId: p.sessionId })));
});

test('pane rule 4: a prompt (or session start) after the marker clears the band', () => {
  const p = donePane();
  p.hook('busy', null, null);
  assert.strictEqual(p.doneFor(marker()), null);
  const q = donePane();
  q.hook('ready', null, null);
  assert.strictEqual(q.doneFor(marker()), null);
});

test('pane rule 4: no Stop after the marker shows nothing', () => {
  const p = donePane();
  p.stopAt = AT - 1;
  assert.strictEqual(p.doneFor(marker()), null);
  p.hook('waiting', null, null);
  assert.ok(p.doneFor(marker()));
});

test('pane: title mismatch (other session number, waiting bg, none) shows no DONE band', () => {
  const p = pane();
  p.clearAt = AT - 60000;
  p.stopAt = AT + 2000;
  assert.strictEqual(p.doneFor(marker()), null);
  p.scanTitle(osc('XX S6 done, waiting 2 bg'));
  assert.strictEqual(p.doneFor(marker()), null);
  p.scanTitle(osc('XX DONE S5 - safe to clear'));
  assert.strictEqual(p.doneFor(marker()), null);
});

test('pane: a title split across chunks is still seen, and a later retitle keeps it', () => {
  const p = pane();
  p.clearAt = AT - 60000;
  p.stopAt = AT + 2000;
  p.scanTitle('xx\x1b]2;XX DONE S');
  p.scanTitle('6 - safe to clear\x07yy');
  p.scanTitle(osc('claude topic'));
  assert.ok(p.doneFor(marker()));
});

test('pane: failed status -> FAIL band without a title; exited or shell panes never', () => {
  const p = pane();
  p.clearAt = AT - 60000;
  p.stopAt = AT + 2000;
  assert.deepStrictEqual(p.doneFor(marker({ verdict: 'FAIL', reason: 'suite red' })), { kind: 'failed', session: 6, reason: 'suite red' });
  p.state = 'exited';
  assert.strictEqual(p.doneFor(marker({ verdict: 'FAIL' })), null);
  const sh = new Pane({ id: 'abcd1234', kind: 'shell', cwd: '.' }, { cfg: {} });
  sh.stopAt = AT + 2000;
  assert.strictEqual(sh.doneFor(marker({ verdict: 'FAIL' })), null);
});

test('pane: refreshDone emits state only on change and info() carries done', () => {
  const p = donePane();
  let n = 0;
  p.on('state', () => n++);
  p.refreshDone(marker());
  p.refreshDone(marker());
  assert.strictEqual(n, 1);
  assert.strictEqual(p.info().done.kind, 'done');
  p.refreshDone(null);
  assert.strictEqual(n, 2);
  assert.strictEqual(p.info().done, null);
});
