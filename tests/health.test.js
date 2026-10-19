'use strict';
// v19.1 A + B: Health & cleanup (server/health.js), the optional plugin
// (server/plugins/main.js, driven by stub node scripts standing in for python - never the
// real plugin script or the kit), the /api/health + /api/route endpoints and the
// pure dialog text (public/app.js Health).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const H = require('../server/health');
const HV = require('../public/app.js').Health;
const { createConsoleServer } = require('../server/server');
const { makeFixture, tmpdir, writeFile } = require('./helpers');

const nap = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const end = Date.now() + (ms || 5000);
  while (Date.now() < end) { if (await fn()) return true; await nap(25); }
  return false;
}

function runner(extra) {
  const core = {};
  for (const s of H.CORE_STEPS) core[s.id] = async () => H.result(s.id, true, 'ok ' + s.id, {}, []);
  return new H.HealthRunner(Object.assign({ core, suiteHolders: () => 0 }, extra || {}));
}

// ---------------------------------------------------------------- allowlist

test('allowlist: core ids only without a plugin; unknown, empty and non-string lists refused', async () => {
  const r = runner();
  assert.deepStrictEqual(r.allowlist(), H.CORE_STEPS.map((s) => s.id));
  for (const bad of [undefined, null, 'console.drops', [], [1], ['pc.temp'], ['console.drops', 'rm -rf'], Array(51).fill('console.drops')]) {
    const x = await r.start(bad);
    assert.strictEqual(x.status, 400, JSON.stringify(bad));
  }
  assert.strictEqual(r.current, null);
});

test('allowlist: a plugin adds its FIXED ids; plan never widens it', async () => {
  const plugin = { name: 't', ids: ['pc.disk'], plan: async () => [{ id: 'pc.disk', group: 'PC', label: 'disk', eta_s: 2 }, { id: 'evil.step', group: 'X', label: 'x', eta_s: 1 }], run: async (id) => H.result(id, true, 'disk ok', {}, []) };
  const r = runner({ plugins: [plugin] });
  assert.ok(r.allowlist().includes('pc.disk'));
  assert.ok(!r.allowlist().includes('evil.step'));
  const plan = await r.plan();
  assert.ok(plan.some((s) => s.id === 'pc.disk') && !plan.some((s) => s.id === 'evil.step'));
  assert.strictEqual((await r.start(['evil.step'])).status, 400);
});

test('run: deduped, allowlist order, one at a time, busy and suite refusals with a reason', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const core = {};
  for (const s of H.CORE_STEPS) core[s.id] = async () => H.result(s.id, true, 'ok', {}, []);
  core['console.drops'] = async () => { await gate; return H.result('console.drops', true, 'ok', {}, []); };
  let busy = null;
  let holders = 0;
  const r = new H.HealthRunner({ core, busy: () => busy, suiteHolders: () => holders });
  holders = 2;
  let x = await r.start(['console.memory']);
  assert.strictEqual(x.status, 409);
  assert.match(x.error, /test suite is running \(2 suite slots held\)/);
  holders = 0;
  busy = 'local model on is running';
  x = await r.start(['console.memory']);
  assert.deepStrictEqual([x.status, x.error], [409, 'local model on is running']);
  busy = null;
  x = await r.start(['console.memory', 'console.drops', 'console.memory']);
  assert.strictEqual(x.status, 202);
  assert.deepStrictEqual(x.run.steps.map((s) => s.id), ['console.drops', 'console.memory']);
  const y = await r.start(['console.panes']);
  assert.strictEqual(y.status, 409);
  assert.match(y.error, /already running/);
  release();
  assert.ok(await until(() => !r.current));
  assert.strictEqual(r.last.status, 'done');
});

test('progress file (item 12 shape, remaining checklist) and the dated report', async () => {
  const dir = tmpdir('cc-hc-');
  const progressFile = path.join(dir, 'progress', 'health-check.json');
  const reportDir = path.join(dir, 'health');
  const seen = [];
  const core = {
    'console.memory': async () => { seen.push(JSON.parse(fs.readFileSync(progressFile, 'utf8'))); return H.result('console.memory', true, 'm', { rss_mb: 1 }, ['f1']); },
    'console.scrollback': async () => { seen.push(JSON.parse(fs.readFileSync(progressFile, 'utf8'))); return H.result('console.scrollback', false, 's', {}, ['f2', 'f3'], 0); },
  };
  const r = new H.HealthRunner({ core, progressFile, reportDir, suiteHolders: () => 0 });
  assert.strictEqual((await r.start(['console.memory', 'console.scrollback'])).status, 202);
  assert.ok(await until(() => !r.current));
  const p0 = seen[0];
  assert.deepStrictEqual(Object.keys(p0).sort(), ['checklist', 'eta_s', 'pct', 'status', 'step', 'task', 'updated']);
  assert.strictEqual(p0.status, 'running');
  assert.deepStrictEqual(p0.checklist.map((c) => c.state), ['running', 'pending']);
  assert.strictEqual(seen[1].checklist.length, 1);
  const fin = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
  assert.deepStrictEqual([fin.status, fin.pct, fin.checklist.length], ['failed', 100, 0]);
  const files = fs.readdirSync(reportDir);
  assert.deepStrictEqual(files, [H.day(Date.now()) + '.json']);
  const doc = JSON.parse(fs.readFileSync(path.join(reportDir, files[0]), 'utf8'));
  assert.strictEqual(doc.runs.length, 1);
  assert.strictEqual(doc.runs[0].findings, 3);
  assert.strictEqual(doc.runs[0].steps[1].status, 'failed');
  // A second run appends; the newest report feeds the next plan's measured ETA.
  await r.start(['console.memory']);
  assert.ok(await until(() => !r.current));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(reportDir, files[0]), 'utf8')).runs.length, 2);
  const fresh = new H.HealthRunner({ core, reportDir, suiteHolders: () => 0 });
  assert.strictEqual(fresh.state().last.steps[0].id, 'console.memory');
});

test('a step floor (timeout_s) beats 3x a short measured ETA', async () => {
  const seen = [];
  const plugin = { name: 't', ids: ['llm.insights'], plan: async () => [{ id: 'llm.insights', group: 'LLM', label: 'x', eta_s: 5, timeout_s: 2520 }], run: async (id, ms) => { seen.push(ms); return H.result(id, true, 'ok', {}, []); } };
  const r = runner({ plugins: [plugin] });
  await r.start(['llm.insights']);
  assert.ok(await until(() => !r.current));
  assert.deepStrictEqual(seen, [2520000]);
});

test('abort on server close: the run ends failed in report and progress, never left running', async () => {
  const dir = tmpdir('cc-hca-');
  const progressFile = path.join(dir, 'p.json');
  const core = { 'console.memory': () => new Promise(() => {}), 'console.scrollback': async () => H.result('console.scrollback', true, 'x', {}, []) };
  const r = new H.HealthRunner({ core, progressFile, reportDir: path.join(dir, 'h'), suiteHolders: () => 0 });
  await r.start(['console.memory', 'console.scrollback']);
  await nap(20);
  r.abort('server closed during the run');
  assert.strictEqual(r.current, null);
  assert.deepStrictEqual(r.last.steps.map((s) => s.status), ['failed', 'failed']);
  assert.strictEqual(JSON.parse(fs.readFileSync(progressFile, 'utf8')).status, 'failed');
  r.abort('again'); // no run: no-op
});

test('busy / suite re-checked after the (slow) plan', async () => {
  let holders = 0;
  const plugin = { name: 't', ids: ['pc.disk'], plan: async () => { holders = 1; return [{ id: 'pc.disk', group: 'PC', label: 'd', eta_s: 1 }]; }, run: async (id) => H.result(id, true, 'ok', {}, []) };
  const r = runner({ plugins: [plugin], suiteHolders: () => holders });
  const x = await r.start(['pc.disk']);
  assert.strictEqual(x.status, 409);
  assert.strictEqual(r.current, null);
});

test('a step over 3x its ETA is cut off as failed (kill at 3x)', async () => {
  const r = new H.HealthRunner({ core: { 'console.memory': () => new Promise(() => {}) }, suiteHolders: () => 0 });
  const s = { id: 'console.memory', eta_s: 0.001 };
  const orig = global.setTimeout;
  global.setTimeout = (fn, ms) => orig(fn, Math.min(ms, 20));
  try {
    const res = await r.runOne(s);
    assert.strictEqual(res.ok, false);
    assert.match(res.summary, /timed out/);
  } finally { global.setTimeout = orig; }
});

// ---------------------------------------------------------------- console steps

test('leak verdict: flat no, steady growth yes, too short not judged', () => {
  const t0 = 0;
  const mk = (n, stepMin, heapMBh, rssMBh, noise) => Array.from({ length: n }, (_, i) => {
    const h = (i * stepMin) / 60;
    const j = noise ? ((i % 3) - 1) * noise : 0;
    return { t: t0 + i * stepMin * 60000, heapUsed: (50 + heapMBh * h + j) * 1048576, rss: (120 + rssMBh * h + j) * 1048576 };
  });
  const flat = H.leakVerdict(mk(120, 1, 0, 0, 2));
  assert.strictEqual(flat.leak, false);
  assert.ok(flat.enough);
  const grow = H.leakVerdict(mk(120, 1, 25, 0, 1));
  assert.strictEqual(grow.leak, true);
  assert.strictEqual(grow.heapLeak, true);
  assert.ok(grow.heapMBh > 20 && grow.heapMBh < 30);
  const rss = H.leakVerdict(mk(120, 1, 0, 60, 1));
  assert.deepStrictEqual([rss.leak, rss.rssLeak, rss.heapLeak], [true, true, false]);
  const short = H.leakVerdict(mk(20, 1, 100, 100, 0));
  assert.deepStrictEqual([short.leak, short.enough], [false, false]);
  assert.strictEqual(H.leakVerdict([]).leak, false);
});

test('MemSampler keeps a bounded ring', () => {
  let t = 0;
  const m = new H.MemSampler({ max: 3, now: () => (t += 1000), mem: () => ({ rss: 1, heapUsed: 2, heapTotal: 3 }) });
  for (let i = 0; i < 5; i++) m.sample();
  assert.strictEqual(m.samples.length, 3);
  assert.strictEqual(m.samples[0].t, 3000);
});

test('orphans: children of ENDED pane pids inside the pane lifetime, plus descendants; reused pids never match', () => {
  const pidLog = [
    { pid: 100, startedAt: 1000, endedAt: 5000 },
    { pid: 200, startedAt: 1000, endedAt: null }, // live pane
    { pid: 300, startedAt: 1000, endedAt: 5000 }, // pid 300 reused by a live process
  ];
  const procs = [
    { pid: 101, ppid: 100, name: 'node.exe', created: 2000 },
    { pid: 102, ppid: 101, name: 'conhost.exe', created: 2100 },
    { pid: 103, ppid: 100, name: 'late.exe', created: 99999 }, // created after the pane ended: pid reuse of 100 as parent
    { pid: 201, ppid: 200, name: 'live.exe', created: 2000 },
    { pid: 300, ppid: 4, name: 'reused.exe', created: 9000 },
    { pid: 301, ppid: 300, name: 'child.exe', created: 2000 },
  ];
  const o = H.findOrphans(procs, pidLog).map((p) => p.pid).sort();
  assert.deepStrictEqual(o, [101, 102]);
  assert.deepStrictEqual(H.findOrphans(null, pidLog), []);
});

test('console steps: panes closes only panes exited over 1 h; orphans ends root trees; drops recycles', async () => {
  const now = 100 * 3600 * 1000;
  const closed = [];
  const mk = (id, state, extra) => Object.assign({ id, title: id, state, startedAt: 0, lastActivity: 0, lastInput: 0, exitedAt: 0, bufBytes: 1000 }, extra);
  const panes = {
    cfg: { scrollbackBytes: 4096 },
    panes: new Map([
      ['a', mk('a', 'exited', { exitedAt: now - 2 * 3600 * 1000 })],
      ['b', mk('b', 'exited', { exitedAt: now - 60 * 1000 })],
      ['c', mk('c', 'waiting', { lastActivity: now - 13 * 3600 * 1000 })],
      ['d', mk('d', 'busy', { lastActivity: now - 13 * 3600 * 1000 })],
    ]),
    close: (id) => { closed.push(id); },
    pidLog: [{ pid: 100, startedAt: 0, endedAt: 1000 }],
  };
  const killed = [];
  const dropsDir = tmpdir('cc-hcd-');
  const R = H.coreRunners({ panes, dropsDir, now: () => now, pruneDrops: async () => ['x', 'y'], listProcesses: async () => [{ pid: 101, ppid: 100, name: 'node.exe', created: 500 }, { pid: 102, ppid: 101, name: 'node.exe', created: 600 }], killTree: async (pid) => { killed.push(pid); return true; } });
  const p = await R['console.panes']();
  assert.deepStrictEqual(closed, ['a']);
  assert.deepStrictEqual([p.numbers.closed, p.numbers.exitedRecent, p.numbers.idle], [1, 1, 1]);
  assert.match(p.findings[0], /idle 13 h \(left open\)/);
  const o = await R['console.orphans']();
  assert.deepStrictEqual(killed, [101]);
  assert.deepStrictEqual([o.numbers.orphans, o.numbers.ended, o.deleted], [2, 1, 2]);
  const d = await R['console.drops']();
  assert.strictEqual(d.deleted, 2);
  const s = await R['console.scrollback']();
  assert.deepStrictEqual([s.numbers.panes, s.numbers.cap_kb], [4, 4]);
  const m = await H.coreRunners({ panes })['console.memory']();
  assert.ok(m.ok && m.numbers.rss_mb > 0);
  const none = await H.coreRunners({ panes, listProcesses: async () => null })['console.orphans']();
  assert.strictEqual(none.ok, false);
  const stuck = await H.coreRunners({ panes, listProcesses: async () => [{ pid: 101, ppid: 100, name: 'node.exe', created: 500 }], killTree: async () => false })['console.orphans']();
  assert.deepStrictEqual([stuck.ok, stuck.deleted, stuck.numbers.failed], [false, 0, 1]);
});

test('suiteHolders: live slot lock counts, dead pid does not, unreadable lock counts (fail safe)', () => {
  const dir = tmpdir('cc-suite-');
  assert.strictEqual(H.suiteHolders(dir), 0);
  fs.writeFileSync(path.join(dir, 'slot-0.lock'), JSON.stringify({ pid: process.pid }));
  fs.writeFileSync(path.join(dir, 'slot-1.lock'), JSON.stringify({ pid: 999999 }));
  fs.writeFileSync(path.join(dir, 'slot-2.lock'), '{bad');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'x');
  assert.strictEqual(H.suiteHolders(dir), 2);
  assert.strictEqual(H.suiteHolders(path.join(dir, 'missing')), 0);
});

// ---------------------------------------------------------------- server endpoints

function req(srv, method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ hostname: '127.0.0.1', port: srv.port, path: p, method, headers: Object.assign({ 'X-Console-Token': srv.token, Host: '127.0.0.1:' + srv.port }, data ? { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:' + srv.port } : method !== 'GET' ? { Origin: 'http://127.0.0.1:' + srv.port } : {}) }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('server: /api/health core-only without the plugin, run + report under data/health, route stored only', async () => {
  const fx = makeFixture();
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: fx.overrides, hom: false, memSample: false, healthSuiteHolders: () => 0, healthListProcesses: async () => [] });
  try {
    const noTok = await new Promise((resolve) => http.get({ hostname: '127.0.0.1', port: srv.port, path: '/api/health', headers: { Host: '127.0.0.1:' + srv.port } }, (res) => { res.resume(); resolve(res.statusCode); }));
    assert.strictEqual(noTok, 401);
    const g = await req(srv, 'GET', '/api/health');
    assert.strictEqual(g.status, 200);
    assert.deepStrictEqual(g.body.plugins, []);
    // CON-013 L5: the machine steps (report-only, off by default) mount after the core ones
    assert.deepStrictEqual(g.body.steps.map((s) => s.id), H.CORE_STEPS.concat(H.MACHINE_STEPS).map((s) => s.id));
    assert.ok(g.body.steps.every((s) => s.cost.usd === 0 && s.cost.tokens === 0));
    assert.strictEqual((await req(srv, 'POST', '/api/health/run', { steps: ['repo.drift'] })).status, 400);
    const r = await req(srv, 'POST', '/api/health/run', { steps: ['console.memory', 'console.scrollback', 'console.panes'] });
    assert.strictEqual(r.status, 202);
    assert.ok(await until(async () => (await req(srv, 'GET', '/api/health')).body.last !== null && !(await req(srv, 'GET', '/api/health')).body.running));
    const after = await req(srv, 'GET', '/api/health');
    assert.strictEqual(after.body.last.status, 'done');
    assert.ok(fs.existsSync(path.join(fx.dataDir, 'health', H.day(Date.now()) + '.json')));
    assert.ok(fs.existsSync(path.join(fx.runDir, 'health-progress.json')));
    const rt = await req(srv, 'GET', '/api/route');
    assert.deepStrictEqual([rt.body.plugin, rt.body.desired], [false, null]);
    assert.match(rt.body.error, /choose the headless lane account/);
    assert.strictEqual((await req(srv, 'POST', '/api/route', {})).body.plugin, false);
  } finally { await srv.close(); }
});


// ---------------------------------------------------------------- pure dialog text

test('dialog text: $0 for deterministic steps, a range from history for the LLM step', () => {
  assert.strictEqual(HV.costText({ id: 'pc.disk', cost: { usd: 0, tokens: 0 } }), '$0 / 0 tokens');
  const llm = { id: 'llm.insights', llm: true, eta_s: 600, cost: { n: 4, basis: 'machine-insights runs', usd: { median: 1.5, lo: 1.17, hi: 12.69 }, tokens: { median: 98000, lo: 96000, hi: 166000 } } };
  assert.strictEqual(HV.costText(llm), '$1.17-$12.69 / 96k-166k tokens (median $1.50 of 4 past machine-insights runs)');
  assert.strictEqual(HV.costText({ id: 'llm.insights', llm: true, cost: { n: 0, basis: 'no history', usd: null } }), 'cost unknown (no past runs)');
  const steps = [{ id: 'a', eta_s: 10, cost: { usd: 0 }, deletes: 'x' }, llm, { id: 'b', eta_s: 5, cost: { usd: 0 } }];
  assert.deepStrictEqual(HV.totals(steps, new Set(['a', 'b'])), { count: 2, eta: 15, cost: '$0 / 0 tokens', deletes: 1 });
  assert.strictEqual(HV.totals(steps, new Set(['a', 'llm.insights'])).cost, '$1.17-$12.69');
});

test('dialog progress: per-step percent from status and ETA, overall weighted', () => {
  assert.strictEqual(HV.stepPct({ status: 'pending' }, 0), 0);
  assert.strictEqual(HV.stepPct({ status: 'done' }, 0), 100);
  assert.strictEqual(HV.stepPct({ status: 'running', startedAt: 0, eta_s: 10 }, 5000), 50);
  assert.strictEqual(HV.stepPct({ status: 'running', startedAt: 0, eta_s: 10 }, 60000), 95);
  assert.strictEqual(HV.runPct({ steps: [{ status: 'done', eta_s: 10 }, { status: 'pending', eta_s: 10 }] }, 0), 50);
  assert.match(HV.lastLine({ endedAt: 1, steps: [{ status: 'done' }, { status: 'failed' }], findings: 3, deleted: 2 }), /2 steps, 1 failed, 3 findings, 2 removed\./);
});

test('route line: split onto a non-proxy account is not allowed', () => {
  assert.match(HV.routeText(null, 'Account 1', 'Account 3', 'Account 2'), /^Not allowed: split sends headless runs through the proxy, which bills Account 2/);
  assert.match(HV.routeText(null, 'Account 1', 'Account 2', 'Account 2'), /split \(Account 1 interactive, Account 2 headless/);
});

test('route line: single / split wording, not-set refuses, mismatch says Save applies', () => {
  assert.match(HV.routeText(null, 'Account 2', 'Account 2'), /single \(both on Account 2\)/);
  assert.match(HV.routeText({ plugin: false, desired: 'split' }, 'Account 2', 'Account 1', 'Account 1'), /Stored only/);
  assert.match(HV.routeText({ plugin: true, desired: 'split', kit: { supported: true, mode: null, valid: false } }, 'A', 'B', 'B'), /NOT SET: every headless run refuses/);
  assert.match(HV.routeText({ plugin: true, desired: 'single', kit: { supported: true, mode: 'split', valid: true } }, 'A', 'A'), /Save applies/);
  assert.match(HV.routeText({ plugin: true, desired: 'single', kit: { supported: true, mode: 'single', valid: true } }, 'A', 'A'), /^Kit route: single \(headless runs bill the main account\)\.$/);
  assert.match(HV.routeText({ plugin: true, desired: 'split', kit: { supported: false, reason: 'the kit has no route command yet' } }, 'A', 'B', 'B'), /not applied: the kit has no route command yet/);
});
