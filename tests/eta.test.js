'use strict';
// CONETA (CHECKLIST-ETA-CLOCK, 2026-10-18): the console's progress display
// (pane workflow rows, status-card rows, pane header tooltip) shows a running item whose
// progress file carries the optional "started" field in the clock form
// `<pct>% ~<rem>m of <total>m [h:mmAM/PM]`; a file without "started" keeps `45% ~3m`.
// The vectors below match the checklist helper's own eta_clock vectors, times in ms here.
const test = require('node:test');
const assert = require('node:assert');
const F = require('../public/app.js').Flow;
const S = require('../server/status');

const t = (h, m, s) => new Date(2026, 9, 18, h, m, s || 0).getTime();
const T0 = t(13, 55);
const S1 = 1000;

test('half-minute round-up (kit vectors)', () => {
  const v = [[0, '0m'], [1, '0.5m'], [30, '0.5m'], [31, '1m'], [60, '1m'], [1350, '22.5m'], [1351, '23m'], [1800.3, '30m'], [0.2, '0m'], [1800, '30m'], [1894.7, '32m'], [1174.7, '20m'], [9000, '150m'], [-5, '0m']];
  for (const [sec, want] of v) assert.strictEqual(F.fmtHalfMin(sec), want, String(sec));
});

test('local h:mmAM/PM rounded up to the minute (kit vectors)', () => {
  const v = [[[14, 25, 0], '2:25PM'], [[14, 26, 35], '2:27PM'], [[0, 5, 0], '12:05AM'], [[12, 0, 0], '12:00PM'], [[9, 59, 1], '10:00AM'], [[23, 59, 30], '12:00AM']];
  for (const [hms, want] of v) assert.strictEqual(F.fmtClock(t(...hms)), want, hms.join(':'));
});

test('eta clock: the operator examples across re-estimates (kit vectors)', () => {
  assert.strictEqual(F.etaClock(0, 1800, T0, T0), '0% ~30m of 30m [2:25PM]');
  assert.strictEqual(F.etaClock(25, 1800, T0, T0 + 450 * S1), '25% ~22.5m of 30m [2:25PM]');
  assert.strictEqual(F.etaClock(38, 1800, T0, T0 + 720 * S1), '38% ~20m of 32m [2:27PM]');
  assert.strictEqual(F.etaClock(90, 5, T0, T0 + 0.9 * 1894.7 * S1), '90% ~3.5m of 32m [2:27PM]');
  assert.strictEqual(F.etaClock(0, 1800, T0, T0 + 300 * S1), '0% ~30m of 35m [2:30PM]');
  assert.strictEqual(F.etaClock(100, null, T0, T0 + 600 * S1), '100% ~0m of 10m [2:05PM]');
  assert.strictEqual(F.etaClock(0, null, T0, T0), '');
  assert.strictEqual(F.etaClock(null, null, null, T0), '');
});

test('eta clock: the bracket is fixed at the last update, rem counts down to it', () => {
  // updated at +720 s, read 4 min later: same finish, 4 min less remaining
  assert.strictEqual(F.etaClock(38, 1800, T0, T0 + 960 * S1, T0 + 720 * S1), '38% ~16m of 32m [2:27PM]');
});

test('server: "started" (ISO or epoch seconds) is normalized to ms, file and checklist rows', () => {
  const now = T0 + 600 * S1;
  const it = S.normalizeProgress({ task: 'b', status: 'running', pct: 25, eta_s: 60, updated: new Date(T0 + 450 * S1).toISOString(), started: new Date(T0).toISOString(), checklist: [{ id: 'C1', task: 'x', state: 'builder running', eta_s: 60, pct: 38, started: T0 / 1000 }, { id: 'C2', task: 'y', state: 'pending', started: 'garbage' }] }, 'b.json', T0, now);
  assert.strictEqual(it.started, T0);
  assert.strictEqual(it.checklist[0].started, T0);
  assert.strictEqual(it.checklist[0].pct, 38);
  assert.strictEqual(it.checklist[1].started, null);
  assert.strictEqual(S.normalizeProgress({ task: 'n', status: 'running' }, 'n.json', T0, now).started, null);
});

test('workflow row: clock form with "started", old form without', () => {
  const f = F.create(0);
  const base = { task: 'b', status: 'running', pct: 25, eta_s: 1800, step: 'compiling', updated: T0 + 450 * S1, stale: false };
  F.update(f, [Object.assign({ file: 'a.json', started: T0 }, base), Object.assign({ file: 'b.json', started: null }, base)]);
  const now = T0 + 450 * S1;
  assert.deepStrictEqual(F.cells(f.rows[0], now), ['[>]', 'b', '25% ~22.5m of 30m [2:25PM]', '', 'compiling']);
  assert.strictEqual(F.clockOf(f.rows[0], now), '25% ~22.5m of 30m [2:25PM]');
  assert.deepStrictEqual(F.cells(f.rows[1], now), ['[>]', 'b', '25%', '~30m', 'compiling']);
  assert.strictEqual(F.clockOf(f.rows[1], now), '');
});

test('checklist rows: the running row uses its own pct / started, else the file\'s', () => {
  const f = F.create(0);
  const now = T0 + 720 * S1;
  F.update(f, [{ file: 'c.json', task: 'c', status: 'running', pct: 10, eta_s: 99, step: 's', updated: now, stale: false, started: T0 - 600 * S1, checklist: [{ id: 'C1', task: 'Build', state: 'builder running', eta_s: 1800, pct: 38, started: T0 }, { id: 'C2', task: 'Commit', state: 'pending' }] }]);
  assert.strictEqual(F.cells(f.rows[0], now)[2], '38% ~20m of 32m [2:27PM]');
  assert.deepStrictEqual(F.cells(f.rows[1], now).slice(2, 4), ['', '']);
});

test('pane header: the short text stays, the tooltip carries the clock form', () => {
  const now = T0 + 720 * S1;
  const top = F.top([{ task: 'c', status: 'running', pct: 38, eta_s: 1800, step: 's', updated: now, started: T0, checklist: [] }], now);
  assert.strictEqual(top.text, '38% ~30m');
  assert.match(top.title, /38% ~20m of 32m \[2:27PM\]/);
});
