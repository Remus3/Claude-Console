'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createConsoleServer } = require('../server/server');
const { makeFixture, gitInit } = require('./helpers');

test('DELETE /api/projects/<id> removes the listing only', { timeout: 60000 }, async (t) => {
  const fx = makeFixture();
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: Object.assign({}, fx.overrides, { defaultShell: 'cmd' }) });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const H = { 'X-Console-Token': srv.token, 'Content-Type': 'application/json' };
  const j = async (method, p, body, extra) => {
    const r = await fetch(base + p, { method, headers: Object.assign({}, H, extra || {}), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const alpha = srv.projects.find((p) => p.name === 'Alpha');
  const alphaDir = alpha.dir;
  await j('PUT', '/api/settings', { projectOrder: ['beta-repo', alpha.id], cardOrder: [alpha.id], sidebarGroups: [{ id: 'g-one', name: 'G', items: ['p:' + alpha.id, 'p:beta-repo'] }] });

  assert.strictEqual((await fetch(base + '/api/projects/' + alpha.id, { method: 'DELETE' })).status, 401);
  assert.strictEqual((await j('DELETE', '/api/projects/' + alpha.id, null, { Origin: 'http://evil.example' })).status, 403);
  assert.strictEqual((await j('DELETE', '/api/projects/nope')).status, 404);

  // a live pane of the project blocks removal
  const pane = await j('POST', '/api/panes', { kind: 'shell', projectId: alpha.id });
  assert.strictEqual(pane.status, 201);
  const blocked = await j('DELETE', '/api/projects/' + alpha.id);
  assert.strictEqual(blocked.status, 409);
  assert.match(blocked.body.error, /Close the 1 open pane of Alpha first/);
  assert.ok((await j('GET', '/api/projects')).body.projects.some((p) => p.id === alpha.id));
  assert.strictEqual((await j('DELETE', '/api/panes/' + pane.body.id)).status, 200);

  const ok = await j('DELETE', '/api/projects/' + alpha.id);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.removed, alpha.id);
  assert.ok(!ok.body.projects.some((p) => p.id === alpha.id));
  assert.ok(!(await j('GET', '/api/projects')).body.projects.some((p) => p.id === alpha.id));
  // files on disk untouched
  assert.ok(fs.statSync(alphaDir).isDirectory());
  assert.ok(fs.existsSync(path.join(alphaDir, 'AL-NEXT-SESSION.txt')));
  assert.ok(fs.existsSync(path.join(alphaDir, '.git')));
  // recorded as a local override; a rescan keeps it out; base config untouched
  const local = JSON.parse(fs.readFileSync(path.join(fx.dataDir, 'console.local.json'), 'utf8'));
  assert.strictEqual(local.projects.Alpha.hidden, true);
  assert.ok(!(await j('POST', '/api/projects/rescan')).body.projects.some((p) => p.id === alpha.id));
  // the operator's orders and groups no longer name it
  const s = (await j('GET', '/api/settings')).body;
  assert.deepStrictEqual(s.projectOrder, ['beta-repo']);
  assert.deepStrictEqual(s.cardOrder, []);
  assert.deepStrictEqual(s.sidebarGroups[0].items, ['p:beta-repo']);
  // the status panel follows
  const st = (await j('GET', '/api/status')).body;
  assert.ok(!st.projects.some((p) => p.id === alpha.id));

  // R2-13: the way back, no JSON edit
  assert.deepStrictEqual((await j('GET', '/api/projects')).body.hidden, [{ id: alpha.id, name: 'Alpha' }]);
  assert.strictEqual((await fetch(base + '/api/projects/' + alpha.id + '/show', { method: 'POST' })).status, 401);
  assert.strictEqual((await j('POST', '/api/projects/' + alpha.id + '/show', null, { Origin: 'http://evil.example' })).status, 403);
  assert.strictEqual((await j('POST', '/api/projects/beta-repo/show')).status, 404, 'a listed project is not hidden');
  assert.strictEqual((await j('POST', '/api/projects/nope/show')).status, 404);
  const shown = await j('POST', '/api/projects/' + alpha.id + '/show');
  assert.strictEqual(shown.status, 200);
  assert.strictEqual(shown.body.shown, alpha.id);
  assert.ok(shown.body.projects.some((p) => p.id === alpha.id));
  assert.deepStrictEqual(shown.body.hidden, []);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(fx.dataDir, 'console.local.json'), 'utf8')).projects.Alpha.hidden, false);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(fx.dataDir, 'console.local.json'), 'utf8')).projects.Alpha.code, undefined, 'the local entry gains nothing else');
  assert.ok((await j('POST', '/api/projects/rescan')).body.projects.some((p) => p.id === alpha.id), 'a rescan keeps it');
  assert.ok((await j('GET', '/api/status')).body.projects.some((p) => p.id === alpha.id));
});

// R1-11: a pane opened in an unlisted repo keeps the folder listed, with no hand edit.
test('POST /api/panes in an unlisted git folder lists it in console.local.json', { timeout: 60000 }, async (t) => {
  const fx = makeFixture();
  const parent = path.dirname(fx.scan);
  const keep = path.join(parent, 'Keep');
  gitInit(keep);
  const repo = path.join(parent, 'Elsewhere');
  gitInit(repo);
  const plain = path.join(parent, 'Plain');
  fs.mkdirSync(plain);
  const inner = path.join(repo, 'sub');
  fs.mkdirSync(inner);
  const localFile = path.join(fx.dataDir, 'console.local.json');
  fs.mkdirSync(fx.dataDir, { recursive: true });
  fs.writeFileSync(localFile, JSON.stringify({ port: 1234 }));
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: Object.assign({}, fx.overrides, { defaultShell: 'cmd', extraProjects: [keep] }) });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const H = { 'X-Console-Token': srv.token, 'Content-Type': 'application/json' };
  const j = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const names = async () => (await j('GET', '/api/projects')).body.projects.map((p) => p.name);
  const open = async (cwd) => {
    const r = await j('POST', '/api/panes', { kind: 'shell', cwd });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    await j('DELETE', '/api/panes/' + r.body.id);
    return r.body;
  };

  // not a repo root: nothing changes
  assert.ok(!(await open(plain)).listed);
  assert.ok(!(await open(inner)).listed);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(localFile, 'utf8')), { port: 1234 });

  const first = await open(repo);
  assert.strictEqual(first.listed, true);
  assert.strictEqual(first.projectId, 'elsewhere');
  assert.strictEqual(first.title, 'Elsewhere');
  const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
  assert.strictEqual(local.port, 1234, 'other local keys stay');
  assert.deepStrictEqual(local.extraProjects, [keep, repo], 'the base list survives: a local list replaces it on merge');
  assert.ok((await names()).includes('Elsewhere') && (await names()).includes('Keep'));
  assert.ok((await j('POST', '/api/projects/rescan')).body.projects.some((p) => p.name === 'Elsewhere'));
  assert.ok((await j('GET', '/api/status')).body.projects.some((p) => p.name === 'Elsewhere'));

  // already listed: no second entry
  assert.ok(!(await open(repo)).listed);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(localFile, 'utf8')).extraProjects, [keep, repo]);

  // hidden on purpose stays hidden when a pane opens there; Show brings it back
  assert.strictEqual((await j('DELETE', '/api/projects/elsewhere')).status, 200);
  assert.ok(!(await open(repo)).listed);
  assert.ok(!(await names()).includes('Elsewhere'));
  assert.strictEqual((await j('POST', '/api/projects/elsewhere/show')).status, 200);
  assert.ok((await names()).includes('Elsewhere'));

  // a local file that does not parse is never overwritten; the pane still opens
  const other = path.join(parent, 'Another');
  gitInit(other);
  fs.writeFileSync(localFile, '{broken');
  assert.ok(!(await open(other)).listed);
  assert.strictEqual(fs.readFileSync(localFile, 'utf8'), '{broken');
});
