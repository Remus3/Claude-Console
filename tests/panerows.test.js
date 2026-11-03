'use strict';
// CON-UX-PANEROWS (S49 intake, screenshot 3): the progress rows above each pane (and the
// status card's rows) follow two per-machine Settings: a row count (default 6, 0 hides
// the strip) and one checkbox per state (default: running / stale / failed / pending /
// idle shown, done hidden). A hidden state leaves the VIEW only: flow.rows keeps its
// order, so rows never reorder; the height is min(count, visible rows) (CON-PANEL-COMPACT,
// 2026-10-25: no blank slot is kept for a row that left the view).
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
  assert.strictEqual(f.height, 2, 'CON-PANEL-COMPACT: follows the shown rows, no blank slot');
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

// CON-PANEL-COMPACT (operator 2026-10-25, six-pane screenshot): the bottom three panes
// held blank rows for files that had finished (done is hidden by default).
test('CON-PANEL-COMPACT: only finished files -> no rows and zero height; a new run opens it', () => {
  const f = F.create(T0);
  F.update(f, [item({ file: 'w.json', task: 'w', status: 'running' })], DEF);
  assert.strictEqual(f.height, 1);
  F.update(f, [item({ file: 'w.json', task: 'w', status: 'done', updated: T0 + 9 })], DEF);
  assert.strictEqual(f.height, 0);
  assert.deepStrictEqual(F.view(f, DEF), []);
  F.update(f, [item({ file: 'w.json', task: 'w', status: 'done', updated: T0 + 9 }), item({ file: 'n.json', task: 'n', updated: T0 + 10 })], DEF);
  assert.strictEqual(f.height, 1);
  assert.deepStrictEqual(F.view(f, DEF).map((r) => r.label), ['n']);
});

test('CON-PANEL-COMPACT: short clock drops the start and the total, keeps pct, rem, Remain and finish', () => {
  assert.strictEqual(F.shortClock('started 7:23AM - 99% ~6m of 719.5m Remain [7:23PM]'), '99% ~6m Remain [7:23PM]');
  assert.strictEqual(F.shortClock('25% ~30m Remain'), '25% ~30m Remain');
  assert.strictEqual(F.shortClock(''), '');
  const now = Date.UTC(2026, 9, 25, 19, 0, 0);
  const r = { state: 'running', label: 'a', pct: 50, eta_s: 60, started: now - 120000, updated: now, step: 's' };
  const full = F.cells(r, now)[2];
  const short = F.cells(r, now, true)[2];
  assert.match(full, /^started \d{1,2}:\d{2}(AM|PM) - 50% ~2m of 4m Remain \[\d{1,2}:\d{2}(AM|PM)\]$/);
  assert.strictEqual(short, F.shortClock(full));
  assert.match(short, /^50% ~2m Remain \[\d{1,2}:\d{2}(AM|PM)\]$/);
  const t = F.top([{ file: 'a.json', task: 'a', status: 'running', pct: 50, eta_s: 60, started: now - 120000, updated: now, stale: false, checklist: [] }], now);
  assert.strictEqual(t.text, full);
  assert.strictEqual(t.short, short);
});

test('CON-PANEL-COMPACT CSS: rows are inline text with a hanging indent; empty cells and a blank strip take no room', () => {
  const css = fs.readFileSync(path.join(PUB, 'app.css'), 'utf8');
  const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = (sel) => { const m = new RegExp('(?:^|\\n)' + esc(sel) + ' \\{([^}]*)\\}').exec(css); assert.ok(m, sel); return m[1]; };
  assert.match(rule('.frow'), /display: block/);
  assert.doesNotMatch(rule('.frow'), /grid-template-columns/);
  assert.match(rule('.frow'), /text-indent: -4ch/);
  assert.match(rule('.frow > span:empty'), /display: none/);
  assert.match(rule('.pane-strip.blank'), /height: 0/);
  assert.doesNotMatch(css, /\.frow\.clk \{[^}]*grid-template-columns/);
});
