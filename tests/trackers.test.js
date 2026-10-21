'use strict';
// CON-GATE-PANEL generic part: the 12 tracker ids and their Settings toggles, the
// TrackerService (machine + scheduled tasks in every build; the fleet module only when
// present), GET /api/trackers, the client's pure helpers (summary line, shown ids,
// sparkline) and the panel wiring (collapse remembered per viewer, default expanded).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const T = require('../server/trackers');
const { sanitizeUiPrefs, UI_DEFAULTS } = require('../server/uiprefs');
const TK = require('../public/app.js').Trk;
const { createConsoleServer } = require('../server/server');
const { makeFixture } = require('./helpers');

test('12 trackers, one Settings toggle each, default shown; junk sanitized', () => {
  assert.strictEqual(T.TRACKER_IDS.length, 12);
  assert.deepStrictEqual(T.TRACKER_IDS, ['gate', 'tasks', 'headless', 'notes', 'kit', 'locks', 'worktrees', 'machine', 'route', 'usage', 'lanes', 'stalls']);
  assert.deepStrictEqual(UI_DEFAULTS.trackers, Object.fromEntries(T.TRACKER_IDS.map((k) => [k, true])));
  const s = sanitizeUiPrefs({ trackers: { gate: false, tasks: 'no', bogus: false } });
  assert.strictEqual(s.trackers.gate, false);
  assert.strictEqual(s.trackers.tasks, true);
  assert.ok(!('bogus' in s.trackers));
});

test('scheduled tasks tracker: benign results are not failures; quiet pauses and disabled listed', () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const list = { available: true, tasks: [
    { name: 'Sample-A', owner: 'main', enabled: true, lastResult: 267011, result: { text: 'never run' }, nextRun: iso(now + 60000) },
    { name: 'Sample-B', owner: 'main', enabled: true, lastResult: 2147946720, result: { text: 'repeat refused' }, nextRun: iso(now + 120000) },
    { name: 'Sample-C', owner: 'main', enabled: true, lastResult: 1, result: { text: 'failed (0x1)' }, nextRun: null },
    { name: 'HOME-SSQuietRestore', owner: null, enabled: true, lastResult: 0, result: { text: 'ok' }, nextRun: iso(now + 3600000) },
    { name: 'Other', owner: 'rc', enabled: false, lastResult: 0, result: { text: 'ok' }, nextRun: null },
    { name: 'Unrelated', owner: null, enabled: true, lastResult: 5, result: { text: 'failed' }, nextRun: null },
  ] };
  const r = T.tasksTracker(list, now);
  assert.strictEqual(r.summary, '5 tasks, 1 failing, 1 disabled, quiet window armed');
  assert.strictEqual(r.state, 'failed');
  assert.deepStrictEqual(r.rows.slice(0, 3).map((x) => x.text.replace(/next .*$/, 'next T')), ['Sample-C: last run failed (0x1)', 'HOME-SSQuietRestore: quiet-window pause, next T', 'Other: disabled']);
  assert.strictEqual(T.tasksTracker({ available: false }, now).summary, 'task list not available');
});

test('commit parse (KB -> MB) and machine tracker rows with sparkline history', async () => {
  assert.deepStrictEqual(T.parseCommit('2048 1024'), { limitMb: 2, usedMb: 1 });
  assert.strictEqual(T.parseCommit('garbage'), null);
  let idle = 0;
  const fakeOs = { cpus: () => [{ times: { user: 100 + idle, nice: 0, sys: 0, idle: (idle += 100), irq: 0 } }] };
  const svc = new T.TrackerService({ fleet: null, os: fakeOs, runner: async () => ({ code: 0, stdout: '8388608 4194304' }), statfs: (p) => (p === 'C:\\' ? { blocks: 100, bsize: 1048576, bavail: 5 } : null) });
  await svc.refresh({});
  const s = await svc.refresh({});
  assert.deepStrictEqual(s.order, ['tasks', 'machine'], 'no fleet module: the generic subset only');
  const m = s.trackers.machine;
  assert.match(m.rows[0].text, /^CPU \d+%$/);
  assert.strictEqual(m.rows[1].text, 'commit 4.0 GB of 8.0 GB');
  assert.strictEqual(m.rows[2].text, 'C: 0.0 GB free of 0.1 GB');
  assert.strictEqual(m.rows[2].cls, 'warn');
  assert.ok(Array.isArray(m.rows[1].spark) && m.rows[1].spark.length === 2);
  assert.strictEqual(s.trackers.tasks.summary, 'scheduler not available');
});


test('client: shown ids follow the toggles; summary line; sparkline points', () => {
  const snap = { order: ['gate', 'tasks', 'machine'], titles: { gate: 'Suite gate', tasks: 'Scheduled tasks', machine: 'Machine' }, trackers: {
    gate: { summary: '1 of 2 slots held', state: 'running' },
    tasks: { summary: '3 tasks, 1 failing', state: 'failed' },
    machine: { summary: 'CPU 5%', state: 'ok' },
  } };
  assert.deepStrictEqual(TK.shown(snap, { tasks: false }), ['gate', 'machine']);
  assert.strictEqual(TK.summaryLine(snap, {}), 'Suite gate: 1 of 2 slots held | Scheduled tasks: 3 tasks, 1 failing');
  assert.strictEqual(TK.summaryLine(snap, { gate: false, tasks: false }), '1 tracker, all calm');
  assert.strictEqual(TK.summaryLine(snap, { gate: false, tasks: false, machine: false }), 'All trackers hidden: tick them in Settings > Status panel trackers.');
  assert.strictEqual(TK.sparkPoints([0, 100], 60, 14), '0.0,14.0 60.0,0.0');
  assert.strictEqual(TK.sparkPoints([5], 60, 14), '');
});

test('panel wiring: collapse in browser storage (default expanded), toggles in Settings, polling only while useful', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.match(app, /let trkOpen = prefGet\('cc-trk-collapsed', '0'\) !== '1';/);
  assert.match(app, /prefSet\('cc-trk-collapsed', trkOpen \? '0' : '1'\)/);
  assert.match(app, /if \(trkBusy \|\| document\.hidden \|\| document\.body\.classList\.contains\('no-status'\)\) return;/);
  assert.match(app, /trackers: readTrackerToggles\(\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /<button type="button" id="trk-toggle" class="trk-head" aria-expanded="true" aria-controls="trk-body"/);
  assert.match(html, /<fieldset class="proj-admin keys-admin" id="set-trackers">/);
  // The export tool lives beside console/ only in the full checkout; a staged copy of
  // console/ alone (the release stage's src) has no tools/ there, so the check is skipped.
  const exPath = path.join(__dirname, '..', '..', 'tools', 'console_export.py');
  if (fs.existsSync(exPath)) {
    const ex = fs.readFileSync(exPath, 'utf8');
    assert.match(ex, /"server\/trackers-fleet\.js"/, 'the fleet trackers leave the public build');
    assert.match(ex, /"tests\/trackers-fleet\.test\.js"/);
  }
});

test('GET /api/trackers: token required, generic trackers in a test server, numbers and words only', async (t) => {
  const fx = makeFixture();
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: fx.overrides, resources: false });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  assert.strictEqual((await fetch(base + '/api/trackers')).status, 401);
  const r = await fetch(base + '/api/trackers', { headers: { 'X-Console-Token': srv.token } });
  assert.strictEqual(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.order) && j.order.includes('machine') && j.order.includes('tasks'));
  assert.ok(j.trackers.machine && typeof j.trackers.machine.summary === 'string');
  assert.ok(!/@|token|secret/i.test(JSON.stringify(j)));
});
