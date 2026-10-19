'use strict';
// CON-UX-CLEAR (S49 intake, screenshot 1 mark 1 + "?" arrow): after /clear in a pane its
// workflow rows and the project's status card kept the rows from before the clear.
// claude's SessionStart hook carries source "clear"; the pane records clearedAt and the
// client restarts both strips from that moment, strict: a file joins only when it is
// written after the clear (a pre-clear running or stale file does not come back).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { Pane, PaneManager } = require('../server/panes');
const F = require('../public/app.js').Flow;

function pane() {
  const p = new Pane({ id: 'abcd1234', kind: 'claude', cwd: '.' }, { cfg: {} });
  p.state = 'waiting';
  return p;
}
const SID = '0f0e0d0c-0b0a-4908-8706-050403020100';

test('SessionStart source=clear sets clearedAt; startup / resume / compact do not', () => {
  const p = pane();
  assert.strictEqual(p.info().clearedAt, 0);
  p.hook('ready', null, SID, null, 'startup');
  p.hook('ready', null, SID, null, 'resume');
  p.hook('ready', null, SID, null, 'compact');
  assert.strictEqual(p.info().clearedAt, 0);
  const before = Date.now();
  const seen = [];
  p.on('state', (i) => seen.push(i.clearedAt));
  p.hook('ready', null, SID, null, 'clear');
  assert.ok(p.info().clearedAt >= before);
  assert.ok(seen.length >= 1 && seen[seen.length - 1] === p.clearedAt, 'an idle pane still emits the clear');
  assert.strictEqual(p.sessionId, SID);
});

test('the manager passes the hook source through (pane secret still required)', () => {
  const m = new PaneManager({ cfg: {} });
  const p = pane();
  p.secret = 's3cret';
  m.panes.set(p.id, p);
  m.refreshDone = () => {};
  assert.strictEqual(m.hook(p.id, 'nope', 'ready', null, SID, null, 'clear'), false);
  assert.strictEqual(p.clearedAt, 0);
  assert.strictEqual(m.hook(p.id, 's3cret', 'ready', null, SID, null, 'clear'), true);
  assert.ok(p.clearedAt > 0);
});

test('server.js hands b.source to the pane manager', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  assert.match(src, /panes\.hook\([^\n]*typeof b\.source === 'string' \? b\.source/);
});

test('hook.js forwards the SessionStart source (sanitized)', async () => {
  let got = null;
  const srv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => { got = JSON.parse(b); res.end('{}'); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const env = Object.assign({}, process.env, { CONSOLE_HOOK_URL: 'http://127.0.0.1:' + srv.address().port, CONSOLE_PANE: 'abcd1234', CONSOLE_HOOK_SECRET: 'x' });
  const ch = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'hook.js'), 'ready'], { env, windowsHide: true });
  ch.stdin.end(JSON.stringify({ session_id: SID, source: 'clear<script>' + 'x'.repeat(50) }));
  await new Promise((r) => ch.on('exit', r));
  srv.close();
  assert.ok(got, 'hook posted');
  assert.strictEqual(got.event, 'ready');
  assert.strictEqual(got.source, 'clearscriptxxxxx', 'letters only, 16 chars max');
});

test('a strict strip (after /clear) drops pre-clear files, running ones included', () => {
  const T = 5000;
  const f = F.create(T, { strict: true });
  const it = (file, status, updated, stale) => ({ file, task: file, status, pct: 10, eta_s: 60, step: '', updated, stale: !!stale, checklist: [] });
  F.update(f, [it('old-run.json', 'running', T - 100), it('old-stale.json', 'running', T - 9000, true), it('old-done.json', 'done', T - 5), it('new.json', 'running', T + 10)]);
  assert.deepStrictEqual(f.rows.map((r) => r.file), ['new.json']);
  // the pre-clear running file rejoins once it writes again after the clear
  F.update(f, [it('old-run.json', 'running', T + 20)]);
  assert.deepStrictEqual(f.rows.map((r) => r.file), ['new.json', 'old-run.json']);
  // non-strict (page load) keeps the old rule: a live running file joins
  const g = F.create(T);
  F.update(g, [it('old-run.json', 'running', T - 100)]);
  assert.strictEqual(g.rows.length, 1);
});

test('app.js restarts the pane strip and the project card rows on a new clearedAt', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(src, /p\.clearedAt && p\.clearedAt !== this\.clearSeen/);
  assert.match(src, /FL\.create\(p\.clearedAt, \{ strict: true \}\)/);
  assert.match(src, /cardFlows\.set\(p\.projectId, FL\.create\(p\.clearedAt, \{ strict: true \}\)\)/);
});
