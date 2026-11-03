'use strict';
// R1-1: Claude Code installed while the console runs is picked up with no restart. The
// real claude.exe is kept out of the search (PATH, APPDATA and the user folder are
// swapped for this process); the "claude" here is a copy of cmd.exe.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createConsoleServer } = require('../server/server');
const { makeFixture, gitInit, tmpdir } = require('./helpers');

function hideRealClaude(t) {
  const saved = { PATH: process.env.PATH, APPDATA: process.env.APPDATA, USERPROFILE: process.env.USERPROFILE };
  const empty = tmpdir('cc-noclaude-');
  process.env.PATH = String(saved.PATH || '').split(';').filter((d) => d && !fs.existsSync(path.join(d.replace(/^"|"$/g, ''), 'claude.exe'))).join(';');
  process.env.APPDATA = empty;
  process.env.USERPROFILE = empty;
  t.after(() => { Object.assign(process.env, saved); });
}

test('a pane opens after claude.exe appears, with no restart, and the footer clears', { timeout: 60000 }, async (t) => {
  hideRealClaude(t);
  const fx = makeFixture();
  const fakeClaude = path.join(tmpdir('cc-fakeclaude-'), 'claude.exe');
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: Object.assign({}, fx.overrides, { claudePath: fakeClaude, useHooks: false, defaultShell: 'cmd' }) });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const H = { 'X-Console-Token': srv.token, 'Content-Type': 'application/json' };
  const j = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const alpha = srv.projects.find((p) => p.name === 'Alpha');

  const before = (await j('GET', '/api/info')).body;
  assert.strictEqual(before.claudeFound, false);
  const refused = await j('POST', '/api/panes', { kind: 'claude', projectId: alpha.id });
  assert.strictEqual(refused.status, 400);
  assert.match(refused.body.error, /install\.ps1/);

  // a refused pane lists nothing (R1-11: only a pane that opens)
  const repo = path.join(path.dirname(fx.scan), 'Elsewhere');
  gitInit(repo);
  assert.strictEqual((await j('POST', '/api/panes', { kind: 'claude', cwd: repo })).status, 400);
  assert.ok(!(await j('GET', '/api/projects')).body.projects.some((p) => p.name === 'Elsewhere'));

  fs.copyFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), fakeClaude);

  const after = (await j('GET', '/api/info')).body;
  assert.strictEqual(after.claudeFound, true, 'the footer clears by itself');
  assert.strictEqual(after.claudePath, fakeClaude);
  const pane = await j('POST', '/api/panes', { kind: 'claude', projectId: alpha.id });
  assert.strictEqual(pane.status, 201, JSON.stringify(pane.body));
  assert.strictEqual(pane.body.kind, 'claude');
  assert.strictEqual(srv.panes.claudePath, fakeClaude, 'kept for the next pane');
  assert.strictEqual((await j('DELETE', '/api/panes/' + pane.body.id)).status, 200);
});
