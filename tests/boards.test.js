'use strict';
// CON-BOARD-LOCAL (kit v23: the status board is local only): the Status board row
// opens the tree's own <repo>/ops/loop/control/board/board.html. Resolution from the
// project dir only, no claude.ai link anywhere, the status snapshot field and the
// token-guarded open endpoint. PANE-CHECKLIST: readChecklist of status.json.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const B = require('../server/boards');
const S = require('../server/status');
const { createConsoleServer } = require('../server/server');
const { makeFixture, writeFile, tmpdir } = require('./helpers');

const HTML = '<!doctype html><title>x</title>\n';
const boardDir = (dir) => path.join(dir, 'ops', 'loop', 'control', 'board');
// The pre-v23 claude.ai link shape, joined at run time (no literal link in this file).
const OLD_LINK = ['https:', '', 'claude' + '.ai', 'artifact', 'ZZtreeLocal99'].join('/');

test('resolveBoard: the tree board.html only; missing, empty or old link = none', () => {
  const dir = tmpdir('cc-board-');
  const proj = { name: 'Repo', code: 'RP', dir };
  assert.strictEqual(B.resolveBoard(proj), null, 'no file before kit v23');
  assert.strictEqual(B.openBoard(proj).error, 'no local status board (board.html not rendered yet)');
  writeFile(path.join(dir, 'ops', 'loop', 'control', 'board.json'), JSON.stringify({ url: OLD_LINK }));
  assert.strictEqual(B.resolveBoard(proj), null, 'the old board.json link is ignored');
  writeFile(path.join(boardDir(dir), 'board.html'), '');
  assert.strictEqual(B.resolveBoard(proj), null, 'empty page ignored');
  writeFile(path.join(boardDir(dir), 'board.html'), HTML);
  assert.strictEqual(B.resolveBoard(proj), path.join(boardDir(dir), 'board.html'));
  assert.strictEqual(B.resolveBoard(null), null);
  assert.strictEqual(B.resolveBoard({ name: 'x' }), null);
  assert.strictEqual(B.BOARD_HTML_REL, path.join('ops', 'loop', 'control', 'board', 'board.html'));
});

test('openBoard re-resolves from the project and hands the file to explorer.exe only', () => {
  const dir = tmpdir('cc-board-');
  const proj = { name: 'Repo', dir };
  const calls = [];
  const fake = (file, args, o) => { calls.push({ exe: path.basename(file).toLowerCase(), args, shell: o.shell }); return { unref() {}, on() {} }; };
  assert.strictEqual(B.openBoard(proj, fake).ok, false, 'no page: refused');
  assert.strictEqual(calls.length, 0);
  writeFile(path.join(boardDir(dir), 'board.html'), HTML);
  assert.deepStrictEqual(B.openBoard(proj, fake), { ok: true });
  assert.deepStrictEqual(calls, [{ exe: 'explorer.exe', args: [path.join(boardDir(dir), 'board.html')], shell: false }]);
});

test('no claude.ai board link left: shipped config and boards.js', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'console.json'), 'utf8'));
  for (const [name, p] of Object.entries(cfg.projects || {})) assert.strictEqual(p && p.board, undefined, name + ' board');
  assert.strictEqual(cfg.boardsFile, undefined);
  assert.ok(!/claude\.ai/.test(fs.readFileSync(path.join(__dirname, '..', 'server', 'boards.js'), 'utf8')));
});

test('readChecklist: remaining rows of status.json, done rows and junk dropped, missing file = null', () => {
  const dir = tmpdir('cc-cl-');
  const proj = { dir };
  assert.strictEqual(S.readChecklist(proj), null);
  const f = path.join(boardDir(dir), 'status.json');
  writeFile(f, '[\n' + [
    { id: 'T1', group: 'running', seq: 1, task: 'build it', state: 'running', detail: 'builder running' },
    { id: 'T2', group: 'operator', seq: 1, task: 'plug in the cable', state: 'waiting', detail: 'operator' },
    { id: 'T3', group: 'next', seq: 1, task: 'test it', state: 'queued', detail: '' },
    { id: 'T0', group: 'done', seq: 1, task: 'read hand-off', state: 'done', detail: '' },
    { group: 'next', task: 'no id' }, 'junk', null,
  ].map((r) => JSON.stringify(r)).join(',\n') + '\n]\n', Date.now() - 5000);
  const r = S.readChecklist(proj);
  assert.deepStrictEqual(r.rows.map((x) => [x.id, x.group]), [['T1', 'running'], ['T2', 'operator'], ['T3', 'next']]);
  assert.strictEqual(typeof r.updated, 'number');
  writeFile(f, '[]\n', Date.now() - 3000);
  assert.deepStrictEqual(S.readChecklist(proj).rows, []);
  writeFile(f, '{not json', Date.now() - 1000);
  assert.strictEqual(S.readChecklist(proj), null);
});

test('status snapshot carries board + checklist; POST /api/projects/<id>/board needs the token and opens the local page', { timeout: 60000 }, async (t) => {
  const fx = makeFixture();
  const beta = boardDir(path.join(fx.scan, 'Beta Repo'));
  writeFile(path.join(beta, 'board.html'), HTML);
  writeFile(path.join(beta, 'status.json'), '[\n{"detail": "", "group": "next", "id": "B1", "seq": 1, "state": "queued", "task": "do b"}\n]\n');
  writeFile(path.join(fx.scan, 'Oldie', 'ops', 'loop', 'control', 'board.json'), JSON.stringify({ url: OLD_LINK }));
  const overrides = Object.assign({}, fx.overrides, { boardsFile: path.join(fx.root, 'none.json') });
  overrides.projects = Object.assign({}, fx.overrides.projects, { Alpha: { board: OLD_LINK } });
  const calls = [];
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides, hom: false, toolSpawn: (f, a) => { calls.push({ exe: path.basename(f).toLowerCase(), args: a }); return { unref() {}, on() {} }; } });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const H = { 'X-Console-Token': srv.token };
  const snap = await (await fetch(base + '/api/status', { headers: H })).json();
  const by = Object.fromEntries(snap.projects.map((p) => [p.id, p.board]));
  assert.deepStrictEqual(by, { alpha: null, 'beta-repo': 'ops/loop/control/board/board.html', oldie: null });
  const cl = Object.fromEntries(snap.projects.map((p) => [p.id, p.checklist ? p.checklist.rows.map((r) => r.id) : null]));
  assert.deepStrictEqual(cl, { alpha: null, 'beta-repo': ['B1'], oldie: null });
  assert.strictEqual((await fetch(base + '/api/projects/beta-repo/board', { method: 'POST' })).status, 401);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual((await fetch(base + '/api/projects/beta-repo/board', { method: 'POST', headers: H })).status, 200);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].exe, 'explorer.exe');
  assert.ok(calls[0].args.length === 1 && calls[0].args[0].endsWith(path.join('Beta Repo', B.BOARD_HTML_REL)), calls[0].args[0]);
  assert.strictEqual((await fetch(base + '/api/projects/nope/board', { method: 'POST', headers: H })).status, 404);
  assert.strictEqual((await fetch(base + '/api/projects/alpha/board', { method: 'POST', headers: H })).status, 404, 'old config link ignored');
  assert.strictEqual((await fetch(base + '/api/projects/oldie/board', { method: 'POST', headers: H })).status, 404, 'old board.json ignored');
  assert.strictEqual(calls.length, 1);
});
