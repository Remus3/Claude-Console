'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const WebSocket = require('ws');
const { createConsoleServer } = require('../server/server');
const { makeFixture } = require('./helpers');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function raw(port, opts) {
  return new Promise((resolve, reject) => {
    const req = http.request(Object.assign({ hostname: '127.0.0.1', port }, opts), (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}

test('console server API, security and a live shell pane', { timeout: 90000 }, async (t) => {
  const fx = makeFixture();
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: Object.assign({}, fx.overrides, { defaultShell: 'cmd' }) });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const H = { 'X-Console-Token': srv.token, 'Content-Type': 'application/json' };
  const j = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };

  await t.test('binds 127.0.0.1 only', () => {
    assert.strictEqual(srv.server.address().address, '127.0.0.1');
  });

  await t.test('token required on the API', async () => {
    assert.strictEqual((await fetch(base + '/api/info')).status, 401);
    assert.strictEqual((await fetch(base + '/api/info', { headers: { 'X-Console-Token': 'nope' } })).status, 401);
    assert.strictEqual((await j('GET', '/api/info')).status, 200);
  });

  await t.test('foreign Host header (DNS rebinding) is refused', async () => {
    const r = await raw(srv.port, { path: '/api/info', headers: { Host: 'evil.example:' + srv.port, 'X-Console-Token': srv.token } });
    assert.strictEqual(r.status, 403);
  });

  await t.test('cross-origin POST is refused even with the token', async () => {
    const r = await fetch(base + '/api/panes', { method: 'POST', headers: Object.assign({ Origin: 'http://evil.example' }, H), body: '{}' });
    assert.strictEqual(r.status, 403);
  });

  await t.test('static page with CSP and vendored xterm', async () => {
    const r = await fetch(base + '/');
    assert.strictEqual(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    const x = await fetch(base + '/vendor/xterm.js');
    assert.strictEqual(x.status, 200);
    // UX-1 R4: the vendored fleet tokens.css is served as-is.
    const tk = await fetch(base + '/tokens.css');
    assert.strictEqual(tk.status, 200);
    assert.match(tk.headers.get('content-type'), /^text.css/);
    assert.ok(Buffer.from(await tk.arrayBuffer()).equals(require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'tokens.css'))));
    assert.strictEqual((await fetch(base + '/vendor/../package.json')).status, 404);
  });

  await t.test('info, projects and status', async () => {
    const info = (await j('GET', '/api/info')).body;
    assert.strictEqual(info.defaultAccount, 'acct2');
    assert.deepStrictEqual(info.accounts.map((a) => a.id), ['acct1', 'acct2']);
    const ps = (await j('GET', '/api/projects')).body.projects;
    assert.deepStrictEqual(ps.map((p) => p.name), ['Alpha', 'Beta Repo', 'Oldie']);
    let st = (await j('GET', '/api/status')).body;
    for (let i = 0; i < 20 && !(st.projects[0] && st.projects[0].git); i++) {
      await sleep(250);
      st = (await j('GET', '/api/status')).body;
    }
    const a = st.projects.find((p) => p.name === 'Alpha');
    assert.strictEqual(a.handoff.session, 7);
    assert.strictEqual(a.progress.items[0].task, 'build');
    assert.strictEqual(a.inbox.total, 3);
    assert.strictEqual(a.git.branch, 'main');
    assert.ok(!JSON.stringify(st.quota).includes('example.com'));
  });

  await t.test('settings and layout persist', async () => {
    const s = (await j('PUT', '/api/settings', { fontSize: 21, theme: 'light', bogus: 1 })).body;
    assert.strictEqual(s.fontSize, 21);
    assert.strictEqual(s.bogus, undefined);
    assert.strictEqual((await j('GET', '/api/settings')).body.theme, 'light');
    // CON-UX-TYPESCALE: the scale is stored per machine, sanitized on PUT
    assert.strictEqual(s.typeScale.base, 15);
    const ts = (await j('PUT', '/api/settings', { typeScale: { base: 17, header: 2, mono: 'x' } })).body.typeScale;
    assert.deepStrictEqual([ts.base, ts.header, ts.mono], [17, 2, -3]);
    assert.strictEqual((await j('GET', '/api/settings')).body.typeScale.base, 17);
    // CON-UX-PANEROWS: row count + shown states survive (data/settings.json)
    assert.deepStrictEqual([s.flowRows, s.flowStates.done], [6, false]);
    await j('PUT', '/api/settings', { flowRows: 2, flowStates: { done: true, idle: false } });
    const fr = (await j('GET', '/api/settings')).body;
    assert.deepStrictEqual([fr.flowRows, fr.flowStates.done, fr.flowStates.idle, fr.flowStates.running], [2, true, false, true]);
    await j('PUT', '/api/layout', { panes: [{ id: 'x', kind: 'shell' }], maximized: null });
    assert.strictEqual((await j('GET', '/api/layout')).body.panes[0].id, 'x');
  });

  await t.test('sidebar groups persist on the server, sanitized', async () => {
    const groups = [
      { id: 'g-abc', name: '  Games  ', open: false, items: ['p:alpha', 't:alpha-gui', 'p:alpha', 'x:bad', 7] },
      { id: 'g-two', name: '', items: ['p:alpha', 'p:beta-repo'] },
      { id: 'bad id', name: 'x', items: [] },
      { id: 'g-abc', name: 'dup', items: [] },
    ];
    const s = (await j('PUT', '/api/settings', { sidebarGroups: groups })).body;
    assert.deepStrictEqual(s.sidebarGroups, [
      { id: 'g-abc', name: 'Games', open: false, items: ['p:alpha', 't:alpha-gui'] },
      { id: 'g-two', name: 'Group', open: true, items: ['p:beta-repo'] },
    ]);
    assert.deepStrictEqual((await j('GET', '/api/settings')).body.sidebarGroups, s.sidebarGroups);
    assert.deepStrictEqual((await j('PUT', '/api/settings', { sidebarGroups: 'nope' })).body.sidebarGroups, []);
  });

  await t.test('pane create validation', async () => {
    assert.strictEqual((await j('POST', '/api/panes', { kind: 'shell', projectId: 'nope' })).status, 404);
    assert.strictEqual((await j('POST', '/api/panes', { kind: 'shell', cwd: 'Z:\\no\\such\\dir' })).status, 400);
  });

  await t.test('websocket refuses a missing/wrong token', async () => {
    const code = await new Promise((resolve) => {
      const ws = new WebSocket('ws://127.0.0.1:' + srv.port + '/ws/events?t=wrong');
      ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
      ws.on('open', () => resolve(101));
      ws.on('error', () => {});
    });
    assert.strictEqual(code, 401);
  });

  await t.test('shell pane: spawn, echo, resize, hook auth, close', async () => {
    const created = await j('POST', '/api/panes', { kind: 'shell', projectId: 'alpha', cols: 90, rows: 25 });
    assert.strictEqual(created.status, 201);
    const id = created.body.id;
    assert.strictEqual(created.body.cwd.toLowerCase(), require('fs').realpathSync.native(fx.scan).toLowerCase() + '\\alpha');
    const ws = new WebSocket('ws://127.0.0.1:' + srv.port + '/ws/pane/' + id + '?t=' + srv.token);
    let out = '';
    let gotReplay = false;
    ws.on('message', (m) => {
      const msg = JSON.parse(m);
      if (msg.t === 'replay') gotReplay = true;
      if (msg.d) out += msg.d;
    });
    await new Promise((r) => ws.on('open', r));
    const until = async (fn, ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (fn()) return true;
        await sleep(100);
      }
      return false;
    };
    const plain = () => out.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
    assert.ok(await until(() => />\s*$/.test(plain()), 10000), 'cmd prompt appears');
    assert.ok(gotReplay);
    ws.send(JSON.stringify({ t: 'in', d: 'echo PANE_%COMPUTERNAME:~0,0%OK_42\r' }));
    assert.ok(await until(() => out.includes('PANE_OK_42'), 8000), 'echo comes back');
    ws.send(JSON.stringify({ t: 'resize', cols: 111, rows: 33 }));
    await sleep(300);
    const info = (await j('GET', '/api/panes/' + id)).body;
    assert.strictEqual(info.cols, 111);
    assert.strictEqual(info.rows, 33);
    out = '';
    ws.send(JSON.stringify({ t: 'in', d: 'mode con\r' }));
    assert.ok(await until(() => /Columns:\s+111/.test(out), 8000), 'pty really resized');
    // replay for a second client
    const ws2 = new WebSocket('ws://127.0.0.1:' + srv.port + '/ws/pane/' + id + '?t=' + srv.token);
    const replay = await new Promise((r) => ws2.on('message', (m) => r(JSON.parse(m))));
    assert.strictEqual(replay.t, 'replay');
    assert.ok(replay.d.includes('PANE_OK_42'));
    ws2.close();
    // hook endpoint: wrong secret refused, right secret sets state
    const pane = srv.panes.get(id);
    const bad = await fetch(base + '/api/hook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pane: id, secret: 'x', event: 'attention' }) });
    assert.strictEqual(bad.status, 403);
    const good = await fetch(base + '/api/hook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pane: id, secret: pane.secret, event: 'attention', note: 'needs permission' }) });
    assert.strictEqual(good.status, 200);
    const after = (await j('GET', '/api/panes/' + id)).body;
    assert.strictEqual(after.state, 'attention');
    assert.strictEqual(after.unseen, true);
    assert.strictEqual(after.note, 'needs permission');
    await j('POST', '/api/panes/' + id + '/seen');
    assert.strictEqual((await j('GET', '/api/panes/' + id)).body.unseen, false);
    // idle detection: a submitted command that runs > 1.5s, then quiet -> waiting + unseen
    ws.send(JSON.stringify({ t: 'in', d: 'ping -n 3 127.0.0.1 >nul & echo SLEPT_%COMPUTERNAME:~0,0%DONE\r' }));
    await sleep(300);
    assert.strictEqual((await j('GET', '/api/panes/' + id)).body.state, 'busy');
    assert.ok(await until(() => out.includes('SLEPT_DONE'), 10000));
    let st = null;
    for (let i = 0; i < 40; i++) {
      st = (await j('GET', '/api/panes/' + id)).body;
      if (st.state === 'waiting') break;
      await sleep(150);
    }
    assert.strictEqual(st.state, 'waiting');
    assert.strictEqual(st.unseen, true);
    // close
    const closed = new Promise((r) => ws.on('close', (c) => r(c)));
    assert.strictEqual((await j('DELETE', '/api/panes/' + id)).status, 200);
    assert.strictEqual(await closed, 4000);
    assert.strictEqual((await j('GET', '/api/panes')).body.panes.length, 0);
  });
});
