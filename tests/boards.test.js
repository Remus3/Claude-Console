'use strict';
// CON-BOARD-LINK: per-project status-board link. URL validation, the resolution
// order (config board, then boardsFile by code, then the tree-local board.json),
// the status snapshot field and the token-guarded open endpoint.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const B = require('../server/boards');
const { createConsoleServer } = require('../server/server');
const { makeFixture, writeFile, tmpdir } = require('./helpers');

const A1 = 'https://claude.ai/artifact/Ex4mpleBoardId0000000A';
const A2 = 'https://claude.ai/code/artifact/0b5c2a3e-1f2d-4c3b-9a8e-7d6c5b4a3f21';
const A3 = 'https://claude.ai/artifact/ZZtreeLocal99';

test('validBoard accepts only claude.ai artifact links', () => {
  assert.strictEqual(B.validBoard(A1), A1);
  assert.strictEqual(B.validBoard(A2), A2);
  for (const bad of [
    null, undefined, 42, '', 'http://claude.ai/artifact/Ex4mpleBoardId0000000A',
    'https://claude.ai.evil.com/artifact/Ex4mpleBoardId0000000A', 'https://evil.com/?https://claude.ai/artifact/abcdef',
    'https://claude.ai/artifact/Ex4mpleBoardId0000000A?x=1', 'https://claude.ai/artifact/Ex4mpleBoardId0000000A/',
    'https://claude.ai/artifact/abc', 'https://claude.ai/artifact/has space', 'https://claude.ai/artifact/a"b&calc',
    'https://claude.ai/code/artifact/not-a-uuid', 'https://claude.ai/chat/0b5c2a3e-1f2d-4c3b-9a8e-7d6c5b4a3f21',
    'javascript:alert(1)', ' ' + A1, A1 + '\n',
  ]) assert.strictEqual(B.validBoard(bad), null, String(bad));
});

test('resolveBoard order: config board, then boardsFile by code, then tree board.json; invalid entries skipped', () => {
  const root = tmpdir('cc-board-');
  const dir = path.join(root, 'Repo');
  const map = path.join(root, 'status_boards.json');
  const proj = { name: 'Repo', code: 'RP', dir };
  const cfg = (board, extra) => Object.assign({ projects: { Repo: board === undefined ? {} : { board } }, boardsFile: map }, extra);
  assert.strictEqual(B.resolveBoard(proj, cfg()), null, 'nothing anywhere');
  writeFile(path.join(dir, 'ops', 'loop', 'control', 'board.json'), JSON.stringify({ url: A3 }));
  assert.strictEqual(B.resolveBoard(proj, cfg()), A3, 'tree-local file');
  writeFile(map, JSON.stringify({ boards: { RP: A2, OTHER: A1 } }));
  assert.strictEqual(B.resolveBoard(proj, cfg()), A2, 'boardsFile beats the tree file');
  assert.strictEqual(B.resolveBoard(proj, cfg(A1)), A1, 'config board beats both');
  assert.strictEqual(B.resolveBoard(proj, cfg('https://evil.com/x')), A2, 'invalid config board falls through');
  writeFile(map, JSON.stringify({ boards: { RP: 'https://evil.com/x' } }));
  assert.strictEqual(B.resolveBoard(proj, cfg()), A3, 'invalid mapping falls through');
  writeFile(map, '{not json');
  assert.strictEqual(B.resolveBoard(proj, cfg()), A3, 'broken mapping file ignored');
  assert.strictEqual(B.resolveBoard(proj, { projects: {} }), A3, 'boardsFile unset');
  assert.strictEqual(B.resolveBoard({ name: 'Repo', code: null, dir }, cfg()), A3, 'no code: mapping not used');
  writeFile(path.join(dir, 'ops', 'loop', 'control', 'board.json'), JSON.stringify({ url: 'file:///C:/x' }));
  assert.strictEqual(B.resolveBoard(proj, cfg()), null, 'invalid tree url ignored');
  assert.strictEqual(B.resolveBoard(proj, cfg(), { mapping: { RP: A1 } }), A1, 'a passed mapping is reused');
});

test('openBoard re-validates and hands the URL to explorer.exe only', () => {
  const calls = [];
  const fake = (file, args, o) => { calls.push({ exe: path.basename(file).toLowerCase(), args, shell: o.shell }); return { unref() {}, on() {} }; };
  assert.deepStrictEqual(B.openBoard(A1, fake), { ok: true });
  assert.deepStrictEqual(calls, [{ exe: 'explorer.exe', args: [A1], shell: false }]);
  assert.strictEqual(B.openBoard('https://evil.com/x', fake).ok, false);
  assert.strictEqual(B.openBoard(null, fake).ok, false);
  assert.strictEqual(calls.length, 1);
});

test('the shipped config: every project board is a valid board link, boardsFile optional', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'console.json'), 'utf8'));
  for (const [name, p] of Object.entries(cfg.projects || {})) {
    if (p && p.board !== undefined) assert.ok(B.validBoard(p.board), name + ' board');
  }
  assert.ok(cfg.boardsFile === undefined || cfg.boardsFile === null || typeof cfg.boardsFile === 'string');
});

test('status snapshot carries board; POST /api/projects/<id>/board needs the token and opens it', { timeout: 60000 }, async (t) => {
  const fx = makeFixture();
  const map = path.join(fx.root, 'status_boards.json');
  writeFile(map, JSON.stringify({ boards: { AL: A2 } }));
  writeFile(path.join(fx.scan, 'Oldie', 'ops', 'loop', 'control', 'board.json'), JSON.stringify({ url: A3 }));
  const overrides = Object.assign({}, fx.overrides, { boardsFile: map });
  overrides.projects = Object.assign({}, fx.overrides.projects, { 'Beta Repo': { board: A1 } });
  const calls = [];
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides, hom: false, toolSpawn: (f, a) => { calls.push({ exe: path.basename(f).toLowerCase(), args: a }); return { unref() {}, on() {} }; } });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const H = { 'X-Console-Token': srv.token };
  const snap = await (await fetch(base + '/api/status', { headers: H })).json();
  const by = Object.fromEntries(snap.projects.map((p) => [p.id, p.board]));
  assert.deepStrictEqual(by, { alpha: A2, 'beta-repo': A1, oldie: A3 });
  assert.strictEqual((await fetch(base + '/api/projects/alpha/board', { method: 'POST' })).status, 401);
  assert.strictEqual(calls.length, 0);
  assert.strictEqual((await fetch(base + '/api/projects/beta-repo/board', { method: 'POST', headers: H })).status, 200);
  assert.deepStrictEqual(calls, [{ exe: 'explorer.exe', args: [A1] }]);
  assert.strictEqual((await fetch(base + '/api/projects/nope/board', { method: 'POST', headers: H })).status, 404);
  fs.unlinkSync(path.join(fx.scan, 'Oldie', 'ops', 'loop', 'control', 'board.json'));
  assert.strictEqual((await fetch(base + '/api/projects/oldie/board', { method: 'POST', headers: H })).status, 404, 'no board: refused');
  assert.strictEqual(calls.length, 1);
});
