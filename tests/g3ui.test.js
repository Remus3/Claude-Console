'use strict';
// MERGE-CON part 1: the UI screens G3 still owed - the scheduler viewport (CON-SCHEDULER),
// the health schedule (CON-HEALTH-SCHED) and the observe-only watchdog (CON-WATCHDOG).
// Pure text/shape helpers live in public/app.js (Sched, HSched, Watch); the markup is
// checked statically and the wiring through the real server with the fake Task Scheduler.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const A = require('../public/app.js');
const { FakeOS } = require('./fakeos');
const { createConsoleServer } = require('../server/server');
const { makeFixture } = require('./helpers');

const PUB = path.join(__dirname, '..', 'public');
const html = () => fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const css = () => fs.readFileSync(path.join(PUB, 'app.css'), 'utf8');
const js = () => fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
const Sc = A.Sched;
const Hs = A.HSched;
const W = A.Watch;

const task = (o) => Object.assign({
  name: 'T', path: '\\', full: '\\T', state: 'Ready', enabled: true, lastRun: null, nextRun: null, lastResult: 0,
  result: { text: 'ok', ok: true }, owner: null, notes: [], triggers: [], actions: [{ exe: 'C:\\x.exe', args: '', workdir: '' }], description: '', author: 'DOMAIN\\someone',
}, o);

// ---------- scheduler ----------
test('Sched.dur: ISO 8601 durations to short text', () => {
  assert.strictEqual(Sc.dur('PT5S'), '5s');
  assert.strictEqual(Sc.dur('PT4H'), '4h');
  assert.strictEqual(Sc.dur('PT1H30M'), '1h30m');
  assert.strictEqual(Sc.dur('P1D'), '1d');
  assert.strictEqual(Sc.dur(''), '');
  assert.strictEqual(Sc.dur(null), '');
  assert.strictEqual(Sc.dur('garbage'), '');
});

test('Sched.triggerText: kind, time, delay, repeat, off', () => {
  assert.strictEqual(Sc.triggerText({ kind: 'daily', start: '2026-10-18T07:30:00', interval: null, delay: null, enabled: true }), 'daily 07:30');
  assert.strictEqual(Sc.triggerText({ kind: 'weekly', start: '2026-10-18T04:30:00', enabled: true }), 'weekly 04:30');
  assert.strictEqual(Sc.triggerText({ kind: 'once', start: '2026-10-20T09:00:00', enabled: true }), 'once 2026-10-20 09:00');
  assert.strictEqual(Sc.triggerText({ kind: 'logon', delay: 'PT5S', enabled: true }), 'logon +5s');
  assert.strictEqual(Sc.triggerText({ kind: 'boot', delay: 'PT3M', enabled: true }), 'boot +3m');
  assert.strictEqual(Sc.triggerText({ kind: 'daily', start: '2026-10-18T00:00:00', interval: 'PT4H', enabled: true }), 'daily 00:00, every 4h');
  assert.strictEqual(Sc.triggerText({ kind: 'idle', enabled: false }), 'idle (off)');
  assert.strictEqual(Sc.triggerText(null), '--');
  assert.strictEqual(Sc.triggersText(task({ triggers: [] })), 'no trigger');
  assert.strictEqual(Sc.triggersText(task({ triggers: [{ kind: 'boot', enabled: true }, { kind: 'logon', enabled: true }] })), 'boot; logon');
});

test('Sched.when: compact local time; never-run sentinel and null are --', () => {
  assert.strictEqual(Sc.when('2026-10-18T07:30:00'), '2026-10-18 07:30');
  assert.strictEqual(Sc.when('1999-11-30T00:00:00'), '--');
  assert.strictEqual(Sc.when(null), '--');
});

test('Sched.row: state word and class follow the benign-result facts', () => {
  assert.deepStrictEqual([Sc.row(task({})).word, Sc.row(task({})).cls], ['ready', 'v-done']);
  const off = Sc.row(task({ state: 'Disabled', enabled: false }));
  assert.deepStrictEqual([off.word, off.cls], ['disabled', 'v-idle']);
  const run = Sc.row(task({ state: 'Running', lastResult: 267009, result: { text: 'running', ok: true } }));
  assert.deepStrictEqual([run.word, run.cls], ['running', 'v-running']);
  const never = Sc.row(task({ lastResult: 267011, result: { text: 'never run', ok: true } }));
  assert.deepStrictEqual([never.word, never.cls], ['never run', 'v-pending']);
  const refused = Sc.row(task({ lastResult: 2147946720, result: { text: 'repeat refused (IgnoreNew)', ok: true } }));
  assert.strictEqual(refused.cls, 'v-done', 'IgnoreNew refusal is not a failure');
  const bad = Sc.row(task({ lastResult: 1, result: { text: 'failed (0x1)', ok: false }, notes: ['last run failed (0x1)'] }));
  assert.deepStrictEqual([bad.word, bad.cls], ['failed (0x1)', 'v-failed']);
});

test('Sched.row: one line plus hover detail; boot flag; never the task author', () => {
  const r = Sc.row(task({ name: 'Sample-DialVolume', path: '\\', full: '\\Sample-DialVolume', triggers: [{ kind: 'logon', delay: 'PT5S', enabled: true }], notes: ['runs at boot/logon: adds work to every boot (delay it or keep it short)'], nextRun: '2026-10-19T07:00:00', lastRun: '2026-10-18T07:00:00' }));
  assert.strictEqual(r.key, '\\Sample-DialVolume');
  assert.strictEqual(r.name, 'Sample-DialVolume');
  assert.strictEqual(r.trigger, 'logon +5s');
  assert.strictEqual(r.boot, true);
  assert.match(r.title, /last 2026-10-18 07:00/);
  assert.match(r.title, /next 2026-10-19 07:00/);
  assert.match(r.title, /adds work to every boot/);
  assert.match(r.title, /C:\\x\.exe/);
  assert.ok(!/DOMAIN|someone/.test(JSON.stringify(r)), 'no author / account name');
  assert.strictEqual(Sc.row(task({ triggers: [{ kind: 'daily', start: '2026-01-01T03:00:00', enabled: true }] })).boot, false);
});

test('Sched.groups: console first, then repos by label, then unmapped; filter by owner', () => {
  const list = { available: true, tasks: [task({ name: 'A', full: '\\A', owner: 'zeta' }), task({ name: 'B', full: '\\B', owner: 'console' }), task({ name: 'C', full: '\\C', owner: null }), task({ name: 'D', full: '\\D', owner: 'alpha' }), task({ name: 'E', full: '\\E', owner: 'alpha' })] };
  const projects = [{ id: 'zeta', name: 'Zeta' }, { id: 'alpha', name: 'Alpha' }, { id: 'none', name: 'Unused' }];
  const g = Sc.groups(list, projects);
  assert.deepStrictEqual(g.map((x) => x.id), ['console', 'alpha', 'zeta', '']);
  assert.deepStrictEqual(g.map((x) => x.label), ['Console', 'Alpha', 'Zeta', 'Not in a repo']);
  assert.deepStrictEqual(g[1].rows.map((r) => r.name), ['D', 'E']);
  assert.deepStrictEqual(Sc.groups(list, projects, 'alpha').map((x) => x.id), ['alpha']);
  assert.deepStrictEqual(Sc.groups(list, projects, '').length, 4, 'empty filter = all');
  assert.deepStrictEqual(Sc.groups({ available: false, tasks: [] }, projects), []);
});

test('Sched.summary: counts, boot/logon and failing; unavailable says why', () => {
  const list = { available: true, tasks: [task({ triggers: [{ kind: 'boot', enabled: true }] }), task({ result: { text: 'failed (0x1)', ok: false } }), task({})] };
  assert.strictEqual(Sc.summary(list), '3 tasks, 1 at boot/logon, 1 failing');
  assert.strictEqual(Sc.summary({ available: true, tasks: [task({})] }), '1 task, 0 at boot/logon, 0 failing');
  assert.strictEqual(Sc.summary({ available: false, error: 'scheduler not available', tasks: [] }), 'Task scheduler unavailable: scheduler not available.');
  assert.strictEqual(Sc.summary(null), 'Task scheduler unavailable.');
});

test('Sched.addBody: form values to the POST body; client-side checks', () => {
  const ok = Sc.addBody({ name: 'My task', folder: '\\', exe: 'C:\\t\\a.exe', args: '-x', workdir: '', kind: 'weekly', at: '04:30', date: '', days: ['Sun', 'Wed'], everyMinutes: '', delaySeconds: '', description: 'd', enabled: true });
  assert.deepStrictEqual(ok, { ok: true, body: { path: '\\', name: 'My task', exe: 'C:\\t\\a.exe', args: '-x', workdir: '', description: 'd', enabled: true, trigger: { kind: 'weekly', at: '04:30', days: ['Sun', 'Wed'] } } });
  const lg = Sc.addBody({ name: 'L', folder: '', exe: 'C:\\a.exe', kind: 'logon', delaySeconds: '30', everyMinutes: '60', enabled: false });
  assert.deepStrictEqual(lg.body.trigger, { kind: 'logon', delaySeconds: 30, everyMinutes: 60 });
  assert.strictEqual(lg.body.path, '\\');
  assert.strictEqual(lg.body.enabled, false);
  assert.deepStrictEqual(Sc.addBody({ name: 'O', exe: 'C:\\a.exe', kind: 'once', at: '09:00', date: '2026-10-20' }).body.trigger, { kind: 'once', at: '09:00', date: '2026-10-20' });
  assert.match(Sc.addBody({ name: '', exe: 'C:\\a.exe', kind: 'boot' }).error, /name/);
  assert.match(Sc.addBody({ name: 'x', exe: '', kind: 'boot' }).error, /program/);
  assert.match(Sc.addBody({ name: 'x', exe: 'C:\\a.exe', kind: 'daily', at: '' }).error, /HH:MM/);
  assert.match(Sc.addBody({ name: 'x', exe: 'C:\\a.exe', kind: 'weekly', at: '04:00', days: [] }).error, /day/);
  assert.match(Sc.addBody({ name: 'x', exe: 'C:\\a.exe', kind: 'event' }).error, /kind/);
  assert.match(Sc.addBody({ name: 'x', exe: 'C:\\a.exe', kind: 'boot', everyMinutes: 'abc' }).error, /repeat/);
});

test('Sched.triggerOf: an existing trigger back into form values (edit)', () => {
  assert.deepStrictEqual(Sc.triggerOf({ kind: 'daily', start: '2026-10-18T07:30:00', interval: 'PT4H', delay: null }), { kind: 'daily', at: '07:30', date: '2026-10-18', days: [], everyMinutes: '240', delaySeconds: '' });
  assert.deepStrictEqual(Sc.triggerOf({ kind: 'logon', delay: 'PT5S' }), { kind: 'logon', at: '', date: '', days: [], everyMinutes: '', delaySeconds: '5' });
  assert.strictEqual(Sc.triggerOf(null).kind, 'daily');
});

// ---------- health schedule ----------
test('HSched.line: off / on / unavailable', () => {
  assert.strictEqual(Hs.line(null), 'Scheduled health check unavailable.');
  assert.strictEqual(Hs.line({ available: false, reason: 'the scheduled health check needs a plugin' }), 'Scheduled health check unavailable: the scheduled health check needs a plugin.');
  assert.strictEqual(Hs.line({ available: true, enabled: false, task: null }), 'Scheduled health check off.');
  assert.strictEqual(Hs.line({ available: true, enabled: false, task: { name: 'ClaudeConsole-HealthCheck' } }), 'Scheduled health check off (task disabled).');
  assert.strictEqual(Hs.line({ available: true, enabled: true, task: {}, schedule: { kind: 'daily', at: '07:30' } }), 'Scheduled health check on: daily 07:30.');
  assert.strictEqual(Hs.line({ available: true, enabled: true, task: {}, schedule: null }), 'Scheduled health check on: custom trigger.');
});

test('HSched.lastText: the one status line, else the last scheduled run', () => {
  assert.strictEqual(Hs.lastText({ statusLine: '2026-10-18 07:30 health ok: 0 findings' }), '2026-10-18 07:30 health ok: 0 findings');
  assert.strictEqual(Hs.lastText({ statusLine: null, lastRun: { status: 'done', startedAtIso: '2026-10-18T07:30:00', findings: 2 } }), 'Last scheduled run 2026-10-18 07:30: done, 2 findings.');
  assert.strictEqual(Hs.lastText({ statusLine: null, lastRun: { status: 'done', startedAtIso: '2026-10-18T07:30:00', findings: 1 } }), 'Last scheduled run 2026-10-18 07:30: done, 1 finding.');
  assert.strictEqual(Hs.lastText({}), 'No scheduled run yet.');
  assert.strictEqual(Hs.lastText(null), 'No scheduled run yet.');
});

test('HSched.body: enabled + time, days only for weekly', () => {
  assert.deepStrictEqual(Hs.body({ enabled: true, at: '07:30', days: [] }), { ok: true, body: { enabled: true, at: '07:30' } });
  assert.deepStrictEqual(Hs.body({ enabled: true, at: '06:00', days: ['Mon', 'Fri'] }), { ok: true, body: { enabled: true, at: '06:00', days: ['Mon', 'Fri'] } });
  assert.deepStrictEqual(Hs.body({ enabled: false, at: '', days: [] }), { ok: true, body: { enabled: false } });
  assert.match(Hs.body({ enabled: true, at: '7:3', days: [] }).error, /HH:MM/);
});

// ---------- watchdog (observe only: readings, never alerts) ----------
const snap = () => ({
  mode: 'observe', enabled: true, collecting: true, intervalSec: 600, retainDays: 14, windowH: 72, lastSampleAt: Date.parse('2026-10-18T10:00:00Z'), lastError: null,
  thresholds: { privMBh: 5, handlesH: null, r2: null, minSpanH: null, pagesPerSec: null, crashesPerApp: null },
  analysis: {
    samples: 12, spanH: 2, processes: 140,
    privGrowth: [{ name: 'powershell.exe', pid: 4242, owner: 'main', seed: 'DIALVOL-LEAK', n: 12, spanH: 2, privMB: 795, mbPerH: 5.7, r2: 0.98, handles: 900, perH: 3, r2h: 0.2 }],
    handleGrowth: [{ name: 'MTKBTSVC.exe', pid: 77, owner: null, seed: 'BT-LEAK', n: 12, spanH: 2, privMB: 20, mbPerH: 0, r2: 0, handles: 7000000, perH: 40000, r2h: 0.99 }],
    seeds: [{ id: 'DIALVOL-LEAK', seen: true, name: 'powershell.exe', n: 12, spanH: 2, privMB: 795, mbPerH: 5.7, handles: 900, handlesPerH: 3, known: 'about 5.7 MB/h' }, { id: 'BT-LEAK', seen: false, known: 'about 40k handles/h' }],
    paging: { n: 12, pagesPerSec: { median: 10, p95: 300, max: 900 }, pageReadsPerSec: { median: 1, p95: 5, max: 9 }, availMB: { median: 9000, p95: 12000, max: 13000 }, commitPct: { median: 40, p95: 55, max: 60 } },
    crashes: { total: 3, wer: 2, byApp: [{ app: 'foo.exe', crashes: 2, hangs: 1 }] },
    wouldReport: [{ kind: 'private-bytes', name: 'powershell.exe', pid: 4242, owner: 'main', to: 'HOME', value: 5.7, unit: 'MB/h', threshold: 5, spanH: 2 }],
    measuring: ['private-bytes slope baseline of normal processes: needs >= 72 h of samples (have 2 h)'],
  },
});

test('Watch.head: observe-only head line with sampling state', () => {
  const h = W.head(snap());
  assert.match(h, /^Observe only\./);
  assert.match(h, /every 10m/);
  assert.match(h, /12 samples over 2 h/);
  assert.match(W.head(Object.assign(snap(), { collecting: false })), /not sampling/);
  assert.match(W.head(Object.assign(snap(), { lastError: 'collector exit 1' })), /last sample failed: collector exit 1/);
  assert.strictEqual(W.head(null), 'Watchdog unavailable.');
});

test('Watch.sections: readings for growth, seeds, paging, crashes, measuring', () => {
  const s = W.sections(snap());
  assert.deepStrictEqual(s.map((x) => x.id), ['priv', 'handles', 'seeds', 'paging', 'crashes', 'measuring']);
  const priv = s[0].rows[0];
  assert.strictEqual(priv.label, 'powershell.exe');
  assert.match(priv.value, /\+5\.7 MB\/h/);
  assert.match(priv.title, /795 MB now/);
  assert.match(priv.title, /seed DIALVOL-LEAK/);
  assert.match(priv.title, /tree main/);
  assert.match(s[1].rows[0].value, /\+40000 handles\/h/);
  assert.match(s[2].rows[1].value, /not seen/);
  assert.match(s[3].rows.map((r) => r.label + ' ' + r.value).join('|'), /pages\/s median 10, p95 300, max 900/);
  assert.strictEqual(s[4].rows[0].label, 'foo.exe');
  assert.strictEqual(s[4].rows[0].value, '2 crashes, 1 hang');
  assert.match(s[4].note, /2 WER reports/);
  assert.strictEqual(s[5].rows.length, 1);
  const empty = W.sections({ analysis: { samples: 0, spanH: 0, privGrowth: [], handleGrowth: [], seeds: [], paging: { n: 0 }, crashes: { total: 0, wer: 0, byApp: [] }, measuring: [] } });
  assert.ok(empty.every((x) => typeof x.empty === 'string'));
});

test('Watch: observe only - candidates and thresholds are never shown as alerts', () => {
  const text = JSON.stringify(W.sections(snap())) + W.head(snap());
  assert.ok(!/alert|would report|wouldReport|report to|threshold/i.test(text), text);
  assert.ok(!/HOME/.test(text), 'no destination tree');
});

// ---------- markup and style ----------
test('index.html: the three screens and their openers', () => {
  const h = html();
  assert.match(h, /<button id="btn-sched"[^>]*>Tasks<\/button>/);
  assert.match(h, /<dialog id="dlg-sched"/);
  for (const id of ['sc-filter', 'sc-sum', 'sc-facts', 'sc-list', 'sc-form', 'sc-note', 'sc-refresh']) assert.match(h, new RegExp('id="' + id + '"'), id);
  for (const k of ['once', 'daily', 'weekly', 'logon', 'boot']) assert.match(h, new RegExp('<option value="' + k + '"'), k);
  assert.match(h, /<fieldset[^>]*id="hs-box"/);
  for (const id of ['hs-line', 'hs-last', 'hs-on', 'hs-at', 'hs-save', 'health-sched']) assert.match(h, new RegExp('id="' + id + '"'), id);
  // the top bar is full (CON-UX-TOPBAR / resource readout widths): the opener sits in Settings > Health & cleanup
  assert.match(h, /<fieldset class="proj-admin health-admin">[\s\S]*?<button type="button" id="btn-watch"[^>]*>Watchdog readings\.\.\.<\/button>[\s\S]*?<\/fieldset>/);
  assert.ok(!h.split('</header>')[0].includes('btn-watch'), 'not in the top bar');
  assert.match(h, /<dialog id="dlg-watch"/);
  for (const id of ['wd-head', 'wd-body', 'wd-sample']) assert.match(h, new RegExp('id="' + id + '"'), id);
  const wd = /<dialog id="dlg-watch"[\s\S]*?<\/dialog>/.exec(h)[0];
  assert.ok(!/alert|threshold/i.test(wd.replace(/role="status"/g, '')), 'watchdog screen: readings, not alerts');
});

test('app.css: new screens take every size from the type scale', () => {
  const src = css().replace(/\/\*[\s\S]*?\*\//g, '');
  for (const sel of ['#dlg-sched', '#dlg-watch', '#hs-box']) assert.ok(src.includes(sel), sel);
  const mine = src.split('\n').filter((l) => /#dlg-sched|#dlg-watch|#hs-box/.test(l));
  assert.ok(mine.length > 3);
  for (const l of mine) assert.ok(!/font-size:\s*[\d.]+px/.test(l), l);
  assert.match(src, /#dlg-sched \.sc-row \{[^}]*font-size: var\(--fs-mono\)/);
  assert.match(src, /#dlg-sched \.sc-row \.sc-name \{[^}]*text-overflow: ellipsis/);
  assert.match(src, /#dlg-watch \.wd-row \{[^}]*font-size: var\(--fs-mono\)/);
});

test('app.js: screens wired to the G3 routes; the watchdog only reads and samples', () => {
  const src = js();
  assert.match(src, /'\/api\/scheduler'/);
  assert.match(src, /'\/api\/scheduler\/tasks'/);
  assert.match(src, /'\/api\/health\/schedule'/);
  assert.match(src, /'\/api\/watchdog'/);
  assert.match(src, /'\/api\/watchdog\/sample'/);
  assert.ok(!/wouldReport/.test(src.replace(/\/\/.*$/gm, '')), 'the client never reads wouldReport');
});

// ---------- wiring through the real server (fake Task Scheduler) ----------
test('server: G3 routes answer through server.js with the fake scheduler', { timeout: 30000 }, async (t) => {
  const fx = makeFixture();
  const fake = new FakeOS([{ name: 'Sample-X', path: '\\', triggers: [{ kind: 'MSFT_TaskBootTrigger', enabled: true }], actions: [{ exe: 'C:\\Windows\\System32\\cmd.exe', args: '/c exit', workdir: '' }] }]);
  const srv = await createConsoleServer({ port: 0, dataDir: fx.dataDir, runDir: fx.runDir, overrides: fx.overrides, schedRunner: fake.runner() });
  t.after(() => srv.close());
  const base = 'http://127.0.0.1:' + srv.port;
  const H = { 'X-Console-Token': srv.token, 'Content-Type': 'application/json' };
  assert.strictEqual((await fetch(base + '/api/scheduler')).status, 401, 'token checked first');
  const l = await (await fetch(base + '/api/scheduler', { headers: H })).json();
  assert.strictEqual(l.available, true);
  assert.deepStrictEqual(l.tasks.map((x) => x.name), ['Sample-X']);
  assert.strictEqual(Sc.summary(l), '1 task, 1 at boot/logon, 0 failing');
  const hs = await (await fetch(base + '/api/health/schedule', { headers: H })).json();
  assert.strictEqual(hs.available, false, 'no plugin on a test data dir');
  assert.match(Hs.line(hs), /^Scheduled health check unavailable: /);
  const w = await (await fetch(base + '/api/watchdog', { headers: H })).json();
  assert.strictEqual(w.mode, 'observe');
  assert.strictEqual(w.collecting, false, 'no real collector on a test data dir');
  assert.match(W.head(w), /^Observe only\./);
  assert.strictEqual(srv.scheduler.available, true);
  assert.strictEqual(fake.writes().length, 0, 'reads only');
});
