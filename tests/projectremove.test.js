'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createConsoleServer } = require('../server/server');
const { makeFixture } = require('./helpers');

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
});
