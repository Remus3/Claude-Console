'use strict';
// CON-UX-PANEROWS (S49 intake, screenshot 3): the workflow rows above each pane (and the
// status card's rows) follow two per-machine Settings: a row count (default 6, 0 hides
// the strip) and one checkbox per state (default: running / stale / failed / pending /
// idle shown, done hidden). A hidden state leaves the VIEW only: flow.rows keeps its
// order, so rows never reorder; the height grows to min(count, visible rows) and never
// shrinks mid-task, except when the count itself is lowered.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const F = require('../public/app.js').Flow;
const { sanitizeFlowRows, sanitizeFlowStates, UI_DEFAULTS } = require('../server/uiprefs');

const PUB = path.join(__dirname, '..', 'public');
const T0 = 1000;
const item = (o) => Object.assign({ file: 'a.json', task: 'a', status: 'running', pct: 10, eta_s: 60, step: 's', updated: T0 + 1, stale: false, checklist: [] }, o);
const DEF = { cap: UI_DEFAULTS.flowRows, show: UI_DEFAULTS.flowStates };

test('defaults: 6 rows; done hidden, every other state shown; client and server agree', () => {
  assert.strictEqual(UI_DEFAULTS.flowRows, 6);
  assert.deepStrictEqual(UI_DEFAULTS.flowStates, { running: true, stale: true, failed: true, pending: true, idle: true, done: false });
  assert.deepStrictEqual(F.DEFAULT_OPTS, DEF);
});

test('screenshot 3: five done rows and one failed show as the one failed row', () => {
  const f = F.create(T0);
  const files = ['kit-rollout', 'C1', 'C2', 's49-intake', 'M', 'done-s49'].map((t, i) => item({ file: t + '.json', task: t, status: i === 0 ? 'failed' : 'done', updated: T0 + 5 }));
  F.update(f, files, DEF);
  assert.strictEqual(f.rows.length, 6);
  const v = F.view(f, DEF);
  assert.deepStrictEqual(v.map((r) => F.cells(r)[0] + ' ' + r.label), ['[x] kit-rollout']);
  assert.strictEqual(f.height, 1);
  // all states shown (no opts): the six rows, as before
  assert.strictEqual(F.view(f).length, 6);
});

test('a hidden state leaves the view only; rows never reorder', () => {
  const f = F.create(T0);
  const cl = (ids, run) => ids.map((id) => ({ id, task: 't' + id, state: id === run ? 'running' : 'pending' }));
  F.update(f, [item({ checklist: cl(['A1', 'A2', 'A3'], 'A1') })], DEF);
  assert.strictEqual(f.height, 3);
  F.update(f, [item({ checklist: cl(['A2', 'A3'], 'A2') })], DEF);
  assert.deepStrictEqual(f.rows.map((r) => r.label), ['A1 tA1', 'A2 tA2', 'A3 tA3']);
  assert.deepStrictEqual(F.view(f, DEF).map((r) => r.label), ['A2 tA2', 'A3 tA3']);
  assert.strictEqual(f.height, 3, 'never shrinks mid-task');
  const showDone = { cap: 6, show: Object.assign({}, DEF.show, { done: true }) };
  assert.deepStrictEqual(F.view(f, showDone).map((r) => r.label), ['A1 tA1', 'A2 tA2', 'A3 tA3']);
});

test('row count: 0 hides the strip; a lower count shrinks it; the window keeps the running row', () => {
  const f = F.create(T0);
  const ids = ['1', '2', '3', '4', '5', '6', '7', '8'];
  F.update(f, [item({ checklist: ids.map((id) => ({ id, task: 'x', state: id === '6' ? 'running' : 'pending' })) })], DEF);
  assert.strictEqual(f.height, 6);
  const three = { cap: 3, show: DEF.show };
  F.update(f, [], three);
  assert.strictEqual(f.height, 3);
  const v = F.view(f, three);
  assert.strictEqual(v.length, 3);
  assert.ok(v.some((r) => r.label === '6 x' && r.state === 'running'));
  const none = { cap: 0, show: DEF.show };
  F.update(f, [], none);
  assert.strictEqual(f.height, 0);
  assert.deepStrictEqual(F.view(f, none), []);
});

test('server sanitizers: count 0..12 integer, states booleans with defaults', () => {
  assert.strictEqual(sanitizeFlowRows(undefined), 6);
  assert.strictEqual(sanitizeFlowRows('x'), 6);
  assert.strictEqual(sanitizeFlowRows(-3), 0);
  assert.strictEqual(sanitizeFlowRows(99), 12);
  assert.strictEqual(sanitizeFlowRows(3.6), 4);
  assert.deepStrictEqual(sanitizeFlowStates(null), UI_DEFAULTS.flowStates);
  assert.deepStrictEqual(sanitizeFlowStates({ done: true, running: 'no', bogus: true }), Object.assign({}, UI_DEFAULTS.flowStates, { done: true }));
  assert.deepStrictEqual(F.normalizeOpts({ flowRows: 99, flowStates: { done: true, running: 'no' } }), { cap: 12, show: Object.assign({}, UI_DEFAULTS.flowStates, { done: true }) });
});

test('Settings: row count input and one checkbox per state', () => {
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  assert.match(html, /<fieldset[^>]*id="set-flow"/);
  assert.match(html, /name="flowRows" type="number" min="0" max="12"/);
  for (const st of ['running', 'stale', 'failed', 'pending', 'idle', 'done']) assert.match(html, new RegExp('<input type="checkbox" name="fs-' + st + '"'), st);
});
