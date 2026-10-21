'use strict';
// Workflow rows (UI/UX standard section 4, console-audit 7.2): the pure tracker that
// turns item-12 progress files into fixed rows that never reorder or vanish.
const test = require('node:test');
const assert = require('node:assert');
const F = require('../public/app.js').Flow;

const T0 = 1000;
const item = (o) => Object.assign({ file: 'a.json', task: 'a', status: 'running', pct: 10, eta_s: 60, step: 's', updated: T0 + 1, stale: false, checklist: [] }, o);

test('a file without a checklist is one row with the file state', () => {
  const f = F.create(T0);
  F.update(f, [item({})]);
  assert.strictEqual(f.rows.length, 1);
  // CON-ETA-REMAIN: a running row without "started" reads '<pct>% ~<rem> Remain' in one cell
  assert.deepStrictEqual(F.cells(f.rows[0], T0 + 1), ['[>]', 'a', '10% ~1m Remain', '', 's']);
  F.update(f, [item({ status: 'done', pct: 100 })]);
  assert.strictEqual(F.cells(f.rows[0])[0], '[+]');
  F.update(f, [item({ status: 'failed' })]);
  assert.strictEqual(F.cells(f.rows[0])[0], '[x]');
  F.update(f, [item({ stale: true })]);
  assert.deepStrictEqual(F.cells(f.rows[0]).slice(0, 4), ['[!]', 'a', '', 'STALE']);
});

test('checklist ids that leave the remaining-only list turn done in place', () => {
  const f = F.create(T0);
  const cl = (ids, run) => ids.map((id) => ({ id, task: 't' + id, state: id === run ? 'builder running' : 'pending', eta_s: 30 }));
  F.update(f, [item({ checklist: cl(['A1', 'A2', 'A3'], 'A1') })]);
  assert.deepStrictEqual(f.rows.map((r) => r.state), ['running', 'pending', 'pending']);
  F.update(f, [item({ checklist: cl(['A2', 'A3'], 'A2') })]);
  assert.deepStrictEqual(f.rows.map((r) => r.label), ['A1 tA1', 'A2 tA2', 'A3 tA3']);
  assert.deepStrictEqual(f.rows.map((r) => r.state), ['done', 'running', 'pending']);
  F.update(f, [item({ status: 'failed', checklist: cl(['A3'], 'A3') })]);
  assert.deepStrictEqual(f.rows.map((r) => r.state), ['done', 'failed', 'failed']);
});

test('rows keep first-seen order when the server re-sorts the files', () => {
  const f = F.create(T0);
  F.update(f, [item({ file: 'a.json', task: 'a' }), item({ file: 'b.json', task: 'b' })]);
  F.update(f, [item({ file: 'b.json', task: 'b' }), item({ file: 'a.json', task: 'a', status: 'done' })]);
  assert.deepStrictEqual(f.rows.map((r) => r.label), ['a', 'b']);
  // a file that drops out of the server's list keeps its row
  F.update(f, [item({ file: 'b.json', task: 'b' })]);
  assert.strictEqual(f.rows.length, 2);
});

test('old finished files do not join; running or newer ones do', () => {
  const f = F.create(T0);
  F.update(f, [item({ file: 'old.json', status: 'done', updated: T0 - 5 }), item({ file: 'new.json', status: 'done', updated: T0 + 5 }), item({ file: 'run.json', updated: T0 - 5 })]);
  assert.deepStrictEqual(f.rows.map((r) => r.file), ['new.json', 'run.json']);
});

test('a stale running file older than the strip does not join', () => {
  const f = F.create(T0);
  F.update(f, [item({ file: 'stale.json', stale: true, updated: T0 - 5 }), item({ file: 'live.json', updated: T0 - 5 })]);
  assert.deepStrictEqual(f.rows.map((r) => r.file), ['live.json']);
});

test('height is the max seen, capped at 6; the window slides to the running row', () => {
  const f = F.create(T0);
  const ids = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  F.update(f, [item({ checklist: ids.map((id) => ({ id, task: 'x', state: id === '1' ? 'running' : 'pending' })) })]);
  assert.strictEqual(f.height, F.CAP);
  assert.strictEqual(F.view(f)[0].label, '1 x');
  F.update(f, [item({ checklist: ['8', '9'].map((id) => ({ id, task: 'x', state: id === '8' ? 'running' : 'pending' })) })]);
  const v = F.view(f);
  assert.strictEqual(v.length, F.CAP);
  assert.ok(v.some((r) => r.state === 'running' && r.label === '8 x'));
  assert.strictEqual(f.height, F.CAP);
  assert.strictEqual(f.rows.length, 9);
});

test('cells are ASCII', () => {
  const f = F.create(T0);
  F.update(f, [item({})]);
  for (const c of F.cells(f.rows[0])) assert.ok(/^[\x20-\x7e]*$/.test(c));
});
