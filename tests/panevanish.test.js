'use strict';
// CON-PANE-VANISH (S30): panes another client opened were tiled into the operator's
// grid, re-tiling it under the pointer, and three of them got a DELETE within 5 s.
// Guards: a pane records which page asked for it (openedBy), a page tiles only its
// own new panes (any other arrives minimized), and every pane open / exit / close
// is logged with who asked, so a vanished pane is traceable in run/server.log.
const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { createConsoleServer } = require('../server/server');
const { makeFixture } = require('./helpers');
const P = require('../public/app.js').Place;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('placement: only panes this page opened are tiled', () => {
  const me = P.newClientId();
  assert.match(me, /^[a-z0-9]{13}$/);
  assert.notStrictEqual(P.newClientId(), me);
  assert.strictEqual(P.placement({ id: 'aaaaaaaa', openedBy: me }, me), 'tile');
  assert.strictEqual(P.placement({ id: 'aaaaaaaa', openedBy: null }, me), 'minimized');
  assert.strictEqual(P.placement({ id: 'aaaaaaaa' }, me), 'minimized');
  assert.strictEqual(P.placement({ id: 'aaaaaaaa', openedBy: 'cother0000000' }, me), 'minimized');
  assert.strictEqual(P.placement({ id: 'aaaaaaaa', openedBy: null }, null), 'minimized');
  assert.strictEqual(P.placement(null, me), 'minimized');
});

test('server: openedBy round trip, added event and the pane log', { timeout: 60000 }, async (t) => {
  const fx = makeFixture();
  const lines = [];
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, hom: false, log: (s) => lines.push(s), overrides: Object.assign({}, fx.overrides, { defaultShell: 'cmd' }) });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const H = { 'X-Console-Token': srv.token, 'Content-Type': 'application/json' };
  const j = async (method, p, body, extra) => {
    const r = await fetch(base + p, { method, headers: Object.assign({}, H, extra || {}), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const ev = new WebSocket('ws://127.0.0.1:' + srv.port + '/ws/events?t=' + srv.token, { headers: { Origin: base } });
  const added = [];
  ev.on('message', (m) => { const x = JSON.parse(String(m)); if (x.t === 'added') added.push(x.pane); });
  await new Promise((r) => ev.on('open', r));

  const mine = await j('POST', '/api/panes', { kind: 'shell', shell: 'cmd', client: 'cpage0000001' }, { Origin: base });
  assert.strictEqual(mine.status, 201);
  assert.strictEqual(mine.body.openedBy, 'cpage0000001');
  const api = await j('POST', '/api/panes', { kind: 'shell', shell: 'cmd' });
  assert.strictEqual(api.status, 201);
  assert.strictEqual(api.body.openedBy, null);
  const bad = await j('POST', '/api/panes', { kind: 'shell', shell: 'cmd', client: '<script>' });
  assert.strictEqual(bad.body.openedBy, null, 'a client id outside [A-Za-z0-9_-]{1,40} is dropped');
  assert.strictEqual((await j('GET', '/api/panes/' + mine.body.id)).body.openedBy, 'cpage0000001');

  for (let i = 0; i < 40 && added.length < 3; i++) await sleep(50);
  const byId = new Map(added.map((p) => [p.id, p]));
  assert.strictEqual(P.placement(byId.get(mine.body.id), 'cpage0000001'), 'tile', 'the opening page tiles its own pane');
  assert.strictEqual(P.placement(byId.get(api.body.id), 'cpage0000001'), 'minimized', 'an API-opened pane is not tiled into a page grid');
  assert.strictEqual(P.placement(byId.get(mine.body.id), 'cother0000000'), 'minimized', 'nor is another page\'s pane');

  assert.ok(lines.some((l) => l.startsWith('pane ' + mine.body.id + ' open shell') && l.endsWith('by page cpage0000001')), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('pane ' + api.body.id + ' open shell') && / by api no-origin ua=node$/.test(l)), lines.join('\n'));

  // A close through a page (Origin set) and one through the API are told apart.
  assert.strictEqual((await j('DELETE', '/api/panes/' + mine.body.id, null, { Origin: base })).status, 200);
  assert.strictEqual((await j('DELETE', '/api/panes/' + api.body.id)).status, 200);
  assert.ok(lines.some((l) => new RegExp('^pane ' + mine.body.id + ' closed ".*" state=\\w+ after \\d+s by page ua=').test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => new RegExp('^pane ' + api.body.id + ' closed ".*" state=\\w+ after \\d+s by no-origin ua=node$').test(l)), lines.join('\n'));

  // A pane process that ends logs its exit code. The pane's own 'exit' event is
  // driven here: a conpty whose process ended by itself keeps node alive at test end.
  srv.panes.get(bad.body.id).emit('exit', 3);
  const ex = lines.find((l) => l.startsWith('pane ' + bad.body.id + ' exited'));
  assert.ok(ex, lines.join('\n'));
  assert.match(ex, / code=3 after \d+s$/);
  await j('DELETE', '/api/panes/' + bad.body.id);
  ev.terminate();
});
