'use strict';
// CON-HEALTH-SCHED: server/healthsched.js registers the scheduled health check
// (the plugin's health script, `scheduled` subcommand) THROUGH the CON-SCHEDULER service, and shows its
// state plus the one status line. FakeOS task store only: no real task is touched.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const S = require('../server/scheduler');
const HS = require('../server/healthsched');
const R = require('../server/backendroutes');
const { FakeOS } = require('./fakeos');
const { tmpdir, writeFile } = require('./helpers');

// The plugin config names the script (relative to its root); a neutral name here.
const SCRIPT = path.join('tools', 'check.py');

function setup(opts) {
  opts = opts || {};
  const dir = tmpdir('cc-hsched-');
  const root = path.join(dir, 'Main');
  const py = path.join(dir, 'Python', 'python.exe');
  writeFile(py, 'x');
  if (opts.pythonw !== false) writeFile(path.join(dir, 'Python', 'pythonw.exe'), 'x');
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  const fake = new FakeOS(opts.rows || []);
  const sched = new S.Scheduler({ runner: fake.runner(), dataDir: path.join(dir, 'data'), runDir: path.join(dir, 'run'), projects: () => [{ id: 'main', dir: root }], now: () => Date.UTC(2026, 9, 18, 12) });
  const mc = opts.mc === null ? null : Object.assign({ root, python: py, script: SCRIPT, reportDir: path.join(root, 'ops', 'insights', 'health') }, opts.mc || {});
  const hs = new HS.HealthSchedule({ scheduler: sched, mc });
  return { dir, root, py, fake, sched, hs, mc };
}

test('spec: pythonw beside python.exe, fixed argv, Main root as start-in, daily by default', () => {
  const { hs, root, dir } = setup();
  const sp = hs.spec({ at: '07:30' });
  assert.strictEqual(sp.path, HS.TASK.path);
  assert.strictEqual(sp.name, HS.TASK.name);
  assert.strictEqual(sp.exe, path.join(dir, 'Python', 'pythonw.exe'));
  assert.strictEqual(sp.args, '"' + path.join(root, SCRIPT) + '" scheduled');
  assert.ok(sp.description.includes('tools/check.py scheduled'), sp.description);
  assert.strictEqual(sp.workdir, root);
  assert.deepStrictEqual(sp.trigger, { kind: 'daily', at: '07:30' });
  assert.ok(S.validateSpec(sp).ok, S.validateSpec(sp).error);
  assert.deepStrictEqual(hs.spec({ at: '06:00', days: ['Mon', 'Thu'] }).trigger, { kind: 'weekly', at: '06:00', days: ['Mon', 'Thu'] });
});

test('spec: python.exe itself when no pythonw sits beside it', () => {
  const { hs, py } = setup({ pythonw: false });
  assert.strictEqual(hs.spec({ at: '07:30' }).exe, py);
});

test('state: unavailable without a plugin or with a bare python name', async () => {
  let r = await setup({ mc: null }).hs.state();
  assert.strictEqual(r.available, false);
  assert.match(r.reason, /plugin/);
  r = await setup({ mc: { python: 'python' } }).hs.state();
  assert.strictEqual(r.available, false);
  assert.match(r.reason, /full path/);
  const x = setup({ mc: { python: 'python' } });
  assert.strictEqual((await x.hs.set({ enabled: true })).status, 503);
  assert.strictEqual(x.fake.writes().length, 0);
});

test('set on: registers the task through the scheduler, state reads it back', async () => {
  const { hs, fake } = setup();
  const r = await hs.set({ enabled: true, at: '07:45' });
  assert.strictEqual(r.status, 200, r.error);
  assert.strictEqual(r.enabled, true);
  assert.deepStrictEqual(r.schedule, { kind: 'daily', at: '07:45' });
  assert.strictEqual(fake.writes().length, 1);
  assert.strictEqual(fake.writes()[0][1][0], '/Create');
  const st = await hs.state();
  assert.strictEqual(st.task.full, '\\' + HS.TASK.name);
});

test('set on again: alters the existing task (new time) instead of adding', async () => {
  const { hs, fake } = setup();
  await hs.set({ enabled: true, at: '07:45' });
  const r = await hs.set({ enabled: true, at: '09:00' });
  assert.strictEqual(r.status, 200, r.error);
  assert.deepStrictEqual(r.schedule, { kind: 'daily', at: '09:00' });
  const creates = fake.writes().filter((w) => w[1][0] === '/Create');
  assert.strictEqual(creates.length, 2);
  assert.ok(creates[1][1].includes('/F'), 'second write is an alter (/F after a backup)');
});

test('set off: disables (keeps the task), and off with no task is a no-op', async () => {
  const a = setup();
  assert.strictEqual((await a.hs.set({ enabled: false })).status, 200);
  assert.strictEqual(a.fake.writes().length, 0);
  await a.hs.set({ enabled: true });
  const r = await a.hs.set({ enabled: false });
  assert.strictEqual(r.status, 200, r.error);
  assert.strictEqual(r.enabled, false);
  assert.ok(r.task, 'the task stays registered, disabled');
});

test('set: bad input refused without a write', async () => {
  const { hs, fake } = setup();
  for (const b of [null, {}, { enabled: 'yes' }, { enabled: true, at: '7:30' }, { enabled: true, at: '24:00' }, { enabled: true, days: ['Xyz'] }, { enabled: true, days: 'Mon' }]) {
    assert.strictEqual((await hs.set(b)).status, 400, JSON.stringify(b));
  }
  assert.strictEqual(fake.writes().length, 0);
});

test('state: status line and the newest scheduled run come from the report dir', async () => {
  const { hs, mc } = setup();
  writeFile(path.join(mc.reportDir, 'status.txt'), 'health 2026-10-18 07:30 scheduled: 5/5 ok, 0 findings\n');
  writeFile(path.join(mc.reportDir, '2026-10-17.json'), JSON.stringify({ runs: [{ source: 'scheduled', status: 'failed', startedAtIso: '2026-10-17T07:30:00', findings: 2 }] }));
  writeFile(path.join(mc.reportDir, '2026-10-18.json'), JSON.stringify({ runs: [{ source: 'scheduled', status: 'done', startedAtIso: '2026-10-18T07:30:00', findings: 0 }, { status: 'done', startedAtIso: '2026-10-18T10:00:00' }] }));
  const st = await hs.state();
  assert.strictEqual(st.statusLine, 'health 2026-10-18 07:30 scheduled: 5/5 ok, 0 findings');
  assert.deepStrictEqual(st.lastRun, { status: 'done', startedAtIso: '2026-10-18T07:30:00', findings: 0 });
  assert.strictEqual(st.enabled, false);
  assert.strictEqual(st.task, null);
});

test('routes: GET / PUT /api/health/schedule', async () => {
  const { hs } = setup();
  const handler = R.createBackendRoutes({ healthSchedule: hs });
  const srv = await new Promise((resolve) => {
    const s = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!(await handler(req, res, url.pathname, req.method, url))) { res.writeHead(404); res.end('{}'); }
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const call = (method, body) => new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, method, path: '/api/health/schedule', headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString('utf8')) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  try {
    let r = await call('GET');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.available, true);
    r = await call('PUT', { enabled: true, at: '08:15' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.enabled, true);
    r = await call('PUT', { enabled: true, at: 'x' });
    assert.strictEqual(r.status, 400);
  } finally { srv.close(); }
});

test('healthsched.js is ASCII and LF', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'healthsched.js'), 'utf8');
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(src));
});
