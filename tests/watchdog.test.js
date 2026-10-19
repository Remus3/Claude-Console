'use strict';
// CON-WATCHDOG: server/watchdog.js, OBSERVE-ONLY collector + analysis. Every OS read goes
// through an injected runner; this file drives fakes only. Thresholds are config, null by
// default (CLAUDE.md: measure before choosing a threshold), so nothing is flagged until
// the operator / HOME sets them from measured data, and nothing is ever reported out.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const W = require('../server/watchdog');
const R = require('../server/backendroutes');
const { tmpdir } = require('./helpers');

const H = 3600000;
const T0 = Date.UTC(2026, 9, 18, 0, 0, 0);
const MB = 1048576;
const PROJECTS = [{ id: 'main', dir: 'C:\\Work' }, { id: 'alpha', dir: 'D:\\Repos\\Alpha' }];

function proc(pid, name, priv, handles, extra) {
  return Object.assign({ pid, name, path: 'C:\\Windows\\System32\\' + name, cmd: name, priv, handles, created: T0 - H }, extra || {});
}

function raw(t, procs, mem, events) {
  return JSON.stringify({ procs, mem: mem || { 'pages/sec': 10, 'page reads/sec': 1, 'available mbytes': 8000, '% committed bytes in use': 40 }, events: events || [] });
}

const CTX = { projects: PROJECTS, consoleRoot: 'C:\\Work\\console', seeds: W.DEFAULT_SEEDS, topN: 3 };

// ---------------------------------------------------------------- config

test('wdConfig: observe-only, thresholds null by default, interval clamped, seeds default', () => {
  const c = W.wdConfig({});
  assert.strictEqual(c.mode, 'observe');
  assert.strictEqual(c.enabled, true);
  assert.strictEqual(c.intervalSec, 600);
  for (const k of Object.keys(c.thresholds)) assert.strictEqual(c.thresholds[k], null, k);
  assert.deepStrictEqual(c.seeds.map((s) => s.id), ['DIALVOL-LEAK', 'BT-LEAK']);
  assert.strictEqual(W.wdConfig({ watchdog: { intervalSec: 5 } }).intervalSec, 60);
  assert.strictEqual(W.wdConfig({ watchdog: { enabled: false } }).enabled, false);
  const t = W.wdConfig({ watchdog: { thresholds: { privMBh: 5, handlesH: 'x', pagesPerSec: -1 } } }).thresholds;
  assert.strictEqual(t.privMBh, 5);
  assert.strictEqual(t.handlesH, null, 'non-numbers stay unset');
  assert.strictEqual(t.pagesPerSec, null, 'negatives stay unset');
  assert.strictEqual(W.wdConfig({ watchdog: { mode: 'report' } }).mode, 'observe', 'no other mode exists yet');
});

// ---------------------------------------------------------------- parse

test('parseSample: top-N by private bytes and by handles, plus seed / owner rows; command line dropped', () => {
  const procs = [
    proc(1, 'big1.exe', 900 * MB, 10), proc(2, 'big2.exe', 800 * MB, 10), proc(3, 'big3.exe', 700 * MB, 10), proc(4, 'big4.exe', 600 * MB, 10),
    proc(5, 'MTKBTSVC.exe', 5 * MB, 7000000), proc(6, 'h2.exe', 1 * MB, 50000), proc(7, 'h3.exe', 1 * MB, 40000), proc(8, 'h4.exe', 1 * MB, 30000),
    proc(9, 'powershell.exe', 64 * MB, 900, { cmd: 'powershell.exe -File "C:\\Work\\ops\\runtime\\DialVolume.ps1" -Secret abc', path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }),
    proc(10, 'python.exe', 1 * MB, 10, { cmd: 'python D:\\Repos\\Alpha\\x.py', path: 'C:\\Python\\python.exe' }),
    proc(11, 'tiny.exe', 1, 1),
  ];
  const s = W.parseSample(raw(T0, procs), T0, CTX);
  const names = s.procs.map((p) => p.n).sort();
  assert.ok(names.includes('big1.exe') && names.includes('big3.exe') && !names.includes('big4.exe'));
  assert.ok(names.includes('MTKBTSVC.exe') && names.includes('h3.exe') && !names.includes('h4.exe'));
  assert.ok(!names.includes('tiny.exe'));
  const dv = s.procs.find((p) => p.pid === 9);
  assert.strictEqual(dv.s, 'DIALVOL-LEAK');
  assert.strictEqual(dv.o, 'main');
  assert.strictEqual(s.procs.find((p) => p.pid === 5).s, 'BT-LEAK');
  assert.strictEqual(s.procs.find((p) => p.pid === 10).o, 'alpha');
  const text = JSON.stringify(s);
  assert.ok(!text.includes('Secret') && !text.includes('-File') && !/"cmd"/.test(text), 'no command line is kept');
  assert.deepStrictEqual(s.mem, { pagesPerSec: 10, pageReadsPerSec: 1, availMB: 8000, commitPct: 40 });
  assert.strictEqual(s.t, T0);
});

test('parseSample: garbage in -> null; missing counters -> null fields', () => {
  assert.strictEqual(W.parseSample('not json', T0, CTX), null);
  assert.strictEqual(W.parseSample('[]', T0, CTX), null);
  const s = W.parseSample(JSON.stringify({ procs: [proc(1, 'a.exe', MB, 1)] }), T0, CTX);
  assert.deepStrictEqual(s.mem, { pagesPerSec: null, pageReadsPerSec: null, availMB: null, commitPct: null });
  assert.deepStrictEqual(s.events, []);
});

// ---------------------------------------------------------------- analysis

function series(hours, fn) {
  const out = [];
  for (let i = 0; i <= hours * 6; i++) {
    const t = T0 + (i * H) / 6;
    out.push(W.parseSample(raw(t, fn(i / 6)), t, Object.assign({}, CTX, { topN: 10 })));
  }
  return out;
}

const LEAKY = (h) => [
  proc(9, 'powershell.exe', (64 + 6 * h) * MB, 900, { cmd: 'powershell -File C:\\Work\\ops\\runtime\\DialVolume.ps1' }),
  proc(5, 'MTKBTSVC.exe', 5 * MB, 500 + 40000 * h),
  proc(3, 'steady.exe', 300 * MB + (h % 1 < 0.5 ? MB : 0), 1000),
];

test('analyze: trends ranked, seeds measured, nothing flagged while thresholds are unset', () => {
  const a = W.analyze(series(6, LEAKY), W.wdConfig({}).thresholds, { seeds: W.DEFAULT_SEEDS });
  assert.strictEqual(a.samples, 37);
  assert.strictEqual(a.spanH, 6);
  assert.strictEqual(a.privGrowth[0].name, 'powershell.exe');
  assert.ok(Math.abs(a.privGrowth[0].mbPerH - 6) < 0.2, String(a.privGrowth[0].mbPerH));
  assert.strictEqual(a.privGrowth[0].owner, 'main');
  assert.strictEqual(a.handleGrowth[0].name, 'MTKBTSVC.exe');
  assert.ok(Math.abs(a.handleGrowth[0].perH - 40000) < 100);
  const bt = a.seeds.find((s) => s.id === 'BT-LEAK');
  assert.ok(bt.seen && Math.abs(bt.handlesPerH - 40000) < 100 && bt.handles > 200000);
  assert.ok(a.seeds.find((s) => s.id === 'DIALVOL-LEAK').seen);
  assert.deepStrictEqual(a.wouldReport, []);
  assert.ok(a.measuring.length >= 3, 'says what still needs measuring');
  assert.ok(a.measuring.some((m) => /baseline/i.test(m)));
});

test('analyze: configured thresholds produce wouldReport candidates (observe-only: never sent)', () => {
  const th = W.wdConfig({ watchdog: { thresholds: { privMBh: 5, handlesH: 10000, r2: 0.9, minSpanH: 2 } } }).thresholds;
  const a = W.analyze(series(6, LEAKY), th, { seeds: W.DEFAULT_SEEDS });
  const kinds = a.wouldReport.map((r) => r.kind + ':' + r.name).sort();
  assert.deepStrictEqual(kinds, ['handles:MTKBTSVC.exe', 'private-bytes:powershell.exe']);
  const ps = a.wouldReport.find((r) => r.kind === 'private-bytes');
  assert.strictEqual(ps.owner, 'main');
  assert.strictEqual(ps.to, 'HOME', 'the owning tree is main; an unowned process also goes to HOME');
  // too short a window: nothing, whatever the slope
  const short = W.analyze(series(1, LEAKY), th, { seeds: W.DEFAULT_SEEDS });
  assert.deepStrictEqual(short.wouldReport, []);
});

test('analyze: a reused pid is a different process (key includes the creation time)', () => {
  const s1 = W.parseSample(raw(T0, [proc(7, 'a.exe', 100 * MB, 1, { created: T0 - H })]), T0, CTX);
  const s2 = W.parseSample(raw(T0 + H, [proc(7, 'a.exe', 900 * MB, 1, { created: T0 + H / 2 })]), T0 + H, CTX);
  const a = W.analyze([s1, s2], W.wdConfig({}).thresholds, {});
  assert.strictEqual(a.processes, 2);
  assert.ok(a.privGrowth.every((g) => g.n === 1 || g.mbPerH === 0) || a.privGrowth.length === 0);
});

test('analyze: paging stats (median / p95 / max) and a thrash candidate only with a threshold', () => {
  const samples = [];
  for (let i = 0; i < 20; i++) {
    const t = T0 + i * 600000;
    // a sustained high tail (last 5 of 20), not a single spike
    samples.push(W.parseSample(raw(t, [proc(1, 'a.exe', MB, 1)], { 'pages/sec': i >= 15 ? 5000 : 100, 'page reads/sec': 5, 'available mbytes': 500, '% committed bytes in use': 90 }), t, CTX));
  }
  const a = W.analyze(samples, W.wdConfig({}).thresholds, {});
  assert.strictEqual(a.paging.pagesPerSec.median, 100);
  assert.strictEqual(a.paging.pagesPerSec.max, 5000);
  assert.strictEqual(a.paging.n, 20);
  assert.deepStrictEqual(a.wouldReport, []);
  const b = W.analyze(samples, W.wdConfig({ watchdog: { thresholds: { pagesPerSec: 1000 } } }).thresholds, {});
  assert.deepStrictEqual(b.wouldReport.map((r) => r.kind), ['thrash']);
});

test('analyze: crash / hang events deduplicated across samples and counted per app', () => {
  const ev = [{ t: T0 + 1000, id: 1000, provider: 'Application Error', app: 'foo.exe' }, { t: T0 + 2000, id: 1002, provider: 'Application Hang', app: 'bar.exe' }];
  const s1 = W.parseSample(raw(T0, [], null, ev), T0 + 5000, CTX);
  const s2 = W.parseSample(raw(T0, [], null, ev.concat([{ t: T0 + 9000, id: 1000, provider: 'Application Error', app: 'foo.exe' }, { t: T0 + 9500, id: 1001, provider: 'Windows Error Reporting', app: '' }])), T0 + 10000, CTX);
  const a = W.analyze([s1, s2], W.wdConfig({}).thresholds, {});
  assert.strictEqual(a.crashes.total, 3);
  assert.strictEqual(a.crashes.wer, 1);
  assert.deepStrictEqual(a.crashes.byApp, [{ app: 'foo.exe', crashes: 2, hangs: 0 }, { app: 'bar.exe', crashes: 0, hangs: 1 }]);
  const b = W.analyze([s1, s2], W.wdConfig({ watchdog: { thresholds: { crashesPerApp: 2 } } }).thresholds, {});
  assert.deepStrictEqual(b.wouldReport.map((r) => r.kind + ':' + r.name), ['crash:foo.exe']);
});

// ---------------------------------------------------------------- the service

function fakeRunner(state) {
  return async (file, args, opts) => {
    state.calls.push({ file, args, env: opts && opts.env });
    if (state.fail) return { code: 1, stdout: '', stderr: 'denied' };
    return { code: 0, stdout: raw(0, state.procs || [proc(1, 'a.exe', 10 * MB, 5)]), stderr: '' };
  };
}

test('Watchdog.sample: one read-only collector call, env carries the event start, jsonl in a day dir', async () => {
  const dir = tmpdir('cc-wd-');
  const st = { calls: [] };
  let now = T0 + 12 * H;
  const w = new W.Watchdog({ runner: fakeRunner(st), dataDir: dir, cfg: {}, projects: () => PROJECTS, now: () => now });
  const s = await w.sample();
  assert.ok(s && s.procs.length === 1);
  assert.strictEqual(st.calls.length, 1);
  assert.ok(st.calls[0].args.includes(W.PS_COLLECT));
  assert.match(st.calls[0].env.CC_WD_SINCE, /^\d{4}-\d{2}-\d{2}T/);
  now += 600000;
  await w.sample();
  assert.strictEqual(st.calls[1].env.CC_WD_SINCE, new Date(T0 + 12 * H).toISOString(), 'events since the previous sample');
  const day = W.dayName(T0 + 12 * H);
  const lines = fs.readFileSync(path.join(dir, 'watchdog', day, 'samples.jsonl'), 'utf8').trim().split('\n');
  assert.strictEqual(lines.length, 2);
  // a fresh instance reads the history back from disk
  const w2 = new W.Watchdog({ runner: null, dataDir: dir, cfg: {}, now: () => now });
  const snap = w2.snapshot();
  assert.strictEqual(snap.mode, 'observe');
  assert.strictEqual(snap.analysis.samples, 2);
  assert.strictEqual(snap.collecting, false);
});

test('Watchdog.sample: a failed collector is recorded, nothing written; no runner = no sampling', async () => {
  const dir = tmpdir('cc-wd-');
  const st = { calls: [], fail: true };
  const w = new W.Watchdog({ runner: fakeRunner(st), dataDir: dir, cfg: {}, now: () => T0 });
  assert.strictEqual(await w.sample(), null);
  assert.match(w.snapshot().lastError, /denied/);
  assert.ok(!fs.existsSync(path.join(dir, 'watchdog', W.dayName(T0))));
  const none = new W.Watchdog({ runner: null, dataDir: dir, cfg: {} });
  none.start();
  assert.strictEqual(none.timer, null);
  assert.strictEqual(await none.sample(), null);
});

test('Watchdog.start honours enabled:false and the interval; stop clears timers', () => {
  const dir = tmpdir('cc-wd-');
  const off = new W.Watchdog({ runner: fakeRunner({ calls: [] }), dataDir: dir, cfg: { watchdog: { enabled: false } } });
  off.start();
  assert.strictEqual(off.timer, null);
  const on = new W.Watchdog({ runner: fakeRunner({ calls: [] }), dataDir: dir, cfg: { watchdog: { intervalSec: 120 } } });
  on.start();
  assert.ok(on.timer);
  on.stop();
  assert.strictEqual(on.timer, null);
});

test('Watchdog.prune sends day dirs past retainDays to the (injected) Recycle Bin only', async () => {
  const dir = tmpdir('cc-wd-');
  for (const d of ['2026-09-01', '2026-10-17', '2026-10-18', 'notes']) fs.mkdirSync(path.join(dir, 'watchdog', d), { recursive: true });
  const recycled = [];
  const w = new W.Watchdog({ runner: null, dataDir: dir, cfg: { watchdog: { retainDays: 14 } }, now: () => T0 + 12 * H, recycle: async (p) => { recycled.push(path.basename(p)); return true; } });
  await w.prune();
  assert.deepStrictEqual(recycled, ['2026-09-01']);
});

test('routes: GET /api/watchdog and POST /api/watchdog/sample', async () => {
  const dir = tmpdir('cc-wd-');
  const w = new W.Watchdog({ runner: fakeRunner({ calls: [] }), dataDir: dir, cfg: {}, now: () => T0 });
  const handler = R.createBackendRoutes({ watchdog: w });
  const srv = await new Promise((resolve) => {
    const s = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!(await handler(req, res, url.pathname, req.method, url))) { res.writeHead(404); res.end('{}'); }
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const call = (method, p) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.address().port, method, path: p }, (res) => {
      const c = [];
      res.on('data', (x) => c.push(x));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end();
  });
  try {
    let r = await call('GET', '/api/watchdog');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.analysis.samples, 0);
    r = await call('POST', '/api/watchdog/sample');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.analysis.samples, 1);
    assert.strictEqual((await call('GET', '/api/watchdog/x')).status, 404);
  } finally { srv.close(); }
});

test('the collector script is read-only and the module is ASCII + LF', () => {
  assert.ok(!/\b(Set|Stop|Remove|New|Start|Restart|Register|Unregister|Disable|Enable|Clear|Invoke)-/i.test(W.PS_COLLECT), 'no changing verbs');
  assert.ok(W.PS_COLLECT.includes('$env:CC_WD_SINCE'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'watchdog.js'), 'utf8');
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(src));
});
